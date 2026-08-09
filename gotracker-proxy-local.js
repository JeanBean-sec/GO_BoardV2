/**
 * gotracker-proxy-local.js
 *
 * Same job as the Cloudflare Worker, but runs locally with plain Node.js
 * (v18+, no npm installs needed — uses the built-in http and fetch).
 *
 * RUN:
 *   node gotracker-proxy-local.js
 *
 * Then it's listening on http://localhost:8787
 *
 * TEST IN A BROWSER TAB:
 *   http://localhost:8787/?station=OA&service=01&feed=status
 *   -> should return raw JSON with a TripStatus array
 *
 * In board-live-feed.js, set:
 *   const PROXY_URL = "http://localhost:8787/";
 */

import http from "node:http";

// Render (and most hosts) assign a port dynamically via process.env.PORT —
// falls back to 8787 for local development, where nothing sets that env var.
const PORT = process.env.PORT || 8787;
const GOTRACKER_BASE =
  "https://www.gotracker.ca/GoTracker/web/GODataAPIProxy.svc";
const GOTRANSIT_SERVICE_UPDATES =
  "https://www.gotransit.com/en/service-updates";
// Second, richer announcement source — real-time corridor/station notices
// and per-trip delay data the site's own CMS scrape doesn't carry (e.g.
// track-condition delays). Public endpoint, no access key required, but
// blocked by robots.txt for automated tools — fetching it server-side here
// sidesteps that the same way the GoTracker XML-wrapped endpoint required.
const MX_SERVICE_UPDATES =
  "https://api.metrolinx.com/external/go/serviceupdate/en/all";
// Secondary departure source — confirmed real and key-free (tested directly
// by the project owner). GoTracker only returns "active"/currently-tracked
// trips, so once those run out the board has nothing left to show even
// though more trips exist later in the schedule. This endpoint returns the
// full scheduled departure list regardless of tracking status, used as a
// tail-filler once GoTracker's real trips are exhausted for a given
// direction — never as a replacement for GoTracker while it still has rows.
const MX_DEPARTURES_BASE =
  "https://api.metrolinx.com/external/go/departures/stops";
// Live per-train GPS/status feed, discovered inside gotracker.ca's own
// domain (not a Metrolinx endpoint like the two above) — a sibling of the
// StationStatusJSON endpoint already in use. Returns real-time
// lat/long + delay + moving/stopped status for every currently in-service
// train on a given corridor. Response shape is different from every other
// XML endpoint here: it's plain XML with one self-closing element per
// train (attributes only), not JSON wrapped in XML — see
// parseTripLocationXml() below.
const GOTRACKER_TRIP_LOCATION_BASE =
  "https://www.gotracker.ca/GoTracker/web/GODataAPIProxy.svc/TripLocation/Service/Lang";

/**
 * Decodes the handful of XML entities that actually show up in this feed
 * (named + numeric character references, e.g. &#xD; &#xA; inside
 * ToolTipText for line breaks). Not a full XML entity decoder — just enough
 * for what this endpoint sends.
 */
function decodeXmlEntities(str) {
  return str
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/**
 * This endpoint's <Data> element holds raw XML child elements
 * (<InServiceTripPublic attr="val" .../>), not a JSON string like every
 * other GoTracker endpoint here — so it needs actual attribute parsing
 * instead of extractJsonFromXmlWrapper's simple string extraction.
 */
function parseTripLocationXml(xmlText) {
  const trips = [];
  const elementRe = /<InServiceTripPublic\s+([^/>]*)\/>/g;
  const attrRe = /(\w+)="((?:[^"\\]|\\.)*)"/g;

  let elMatch;
  while ((elMatch = elementRe.exec(xmlText))) {
    const attrsText = elMatch[1];
    const trip = {};
    let attrMatch;
    attrRe.lastIndex = 0;
    while ((attrMatch = attrRe.exec(attrsText))) {
      trip[attrMatch[1]] = decodeXmlEntities(attrMatch[2]);
    }
    trips.push(trip);
  }
  return trips;
}

/**
 * The upstream endpoint doesn't return raw JSON — it returns XML with the
 * actual JSON payload sitting inside a <Data> element, e.g.:
 *   <ReturnStringValue ErrCode="0" ...><Data>{"TripStatus":[...]}</Data></ReturnStringValue>
 * This pulls the JSON string out so the client gets clean, parseable JSON.
 */
function extractJsonFromXmlWrapper(xmlText) {
  const match = xmlText.match(/<Data>([\s\S]*?)<\/Data>/);
  if (!match) {
    throw new Error("Could not find <Data> element in upstream response");
  }
  return match[1];
}

function extractNextData(htmlText) {
  const match = htmlText.match(
    /<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i
  );
  if (!match) {
    throw new Error("Could not find __NEXT_DATA__ in GO Transit service-updates page");
  }

  const nextData = JSON.parse(match[1]);
  return nextData?.props?.pageProps?.content || {};
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // CORS headers so your static page (served from a different local port,
  // e.g. a Webstudio preview or a simple `npx serve`) can call this.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // GO Transit announcements are served from the public service-updates
  // page. Fetch the page server-side so the browser does not need CORS access
  // to gotransit.com. The client maps the returned CMS structure to title/body.
  if (url.searchParams.get("feed") === "announcements") {
    try {
      const upstream = await fetch(GOTRANSIT_SERVICE_UPDATES, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36",
          Accept: "text/html,application/xhtml+xml",
        },
      });

      if (!upstream.ok) {
        throw new Error(`GO Transit page returned ${upstream.status}`);
      }

      const html = await upstream.text();
      const content = extractNextData(html);

      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "public, max-age=15",
      });
      res.end(JSON.stringify({ content }));
    } catch (err) {
      console.error("GO Transit announcement fetch failed:", err);
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: "gotransit_announcements_fetch_failed",
          detail: String(err),
        })
      );
    }
    return;
  }

  // Second announcement source — the Metrolinx public service-update API.
  // Straight JSON, no XML unwrapping or NEXT_DATA extraction needed, but
  // it's robots.txt-disallowed for automated fetchers, so this has to be a
  // real server-side request with a browser User-Agent, same as the
  // GoTracker feed already requires.
  if (url.searchParams.get("feed") === "mx-updates") {
    try {
      const upstream = await fetch(MX_SERVICE_UPDATES, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36",
          Accept: "application/json",
        },
      });

      if (!upstream.ok) {
        throw new Error(`Metrolinx service update API returned ${upstream.status}`);
      }

      const json = await upstream.text();

      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "public, max-age=15",
      });
      res.end(json);
    } catch (err) {
      console.error("Metrolinx service update fetch failed:", err);
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: "mx_serviceupdate_fetch_failed",
          detail: String(err),
        })
      );
    }
    return;
  }

  // Tail-fill departures — clean JSON already, no XML/NEXT_DATA unwrapping
  // needed, so this is close to a straight pass-through.
  if (url.searchParams.get("feed") === "departures") {
    const stationCode = (url.searchParams.get("station") || "OA").toUpperCase();
    const pageLimit = url.searchParams.get("pageLimit") || "20";
    // "status" -> /status/departures (allDepartures shape, real status
    // field). "plain" -> /departures (trainDepartures/busDepartures shape,
    // no status field, only free-text info). Which one the client asks for
    // is decided client-side per station — see departuresVariantForStation()
    // in board-live-feed.js.
    const variant = url.searchParams.get("variant") === "plain" ? "plain" : "status";
    const path = variant === "plain" ? "departures" : "status/departures";
    const target = `${MX_DEPARTURES_BASE}/${stationCode}/${path}?page=1&transitTypeName=All&pageLimit=${pageLimit}`;

    try {
      const upstream = await fetch(target, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36",
          Accept: "application/json",
        },
      });

      if (!upstream.ok) {
        throw new Error(`Metrolinx departures API returned ${upstream.status}`);
      }

      const json = await upstream.text();

      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "public, max-age=15",
      });
      res.end(json);
    } catch (err) {
      console.error("Metrolinx departures fetch failed:", err);
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: "mx_departures_fetch_failed",
          detail: String(err),
        })
      );
    }
    return;
  }

  // Live per-train position/status feed (GPS + delay + moving/stopped) —
  // real XML with attributes, not JSON-wrapped, so it's parsed server-side
  // into plain JSON via parseTripLocationXml() rather than passed through.
  if (url.searchParams.get("feed") === "trip-location") {
    const service = url.searchParams.get("service") || "01";
    const target = `${GOTRACKER_TRIP_LOCATION_BASE}/${service}/en?_=${Date.now()}`;

    try {
      const upstream = await fetch(target, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
          Referer: "https://www.gotracker.ca/gotracker/web/GoMap.aspx",
          Accept: "application/xml, text/xml, */*",
        },
      });

      if (!upstream.ok) {
        throw new Error(`TripLocation endpoint returned ${upstream.status}`);
      }

      const xml = await upstream.text();
      const trips = parseTripLocationXml(xml);

      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "public, max-age=10", // this is live GPS data — short TTL, unlike the other feeds
      });
      res.end(JSON.stringify({ trips }));
    } catch (err) {
      console.error("TripLocation fetch failed:", err);
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ error: "trip_location_fetch_failed", detail: String(err) })
      );
    }
    return;
  }

  const station = (url.searchParams.get("station") || "OA").toUpperCase();
  const service = url.searchParams.get("service") || "01";
  const lang = url.searchParams.get("lang") || "en-us";
  const feed =
    url.searchParams.get("feed") === "message"
      ? "StationMessage"
      : "StationStatusJSON";

  const target = `${GOTRACKER_BASE}/${feed}/Service/StationCd/Lang/${service}/${station}/${lang}`;

  try {
    const upstream = await fetch(target, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        Referer: "https://www.gotracker.ca/gotracker/web/GoMap.aspx",
        Accept: "application/json, text/plain, */*",
      },
    });

    const rawXml = await upstream.text();
    const jsonBody = extractJsonFromXmlWrapper(rawXml);

    res.writeHead(upstream.status, {
      "Content-Type": "application/json; charset=utf-8",
    });
    res.end(jsonBody);
  } catch (err) {
    console.error("Proxy fetch failed:", err);
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "upstream_fetch_failed", detail: String(err) }));
  }
});

server.listen(PORT, () => {
  console.log(`GO Tracker proxy running at http://localhost:${PORT}`);
  console.log(
    `Try: http://localhost:${PORT}/?station=OA&service=01&feed=status`
  );
});
