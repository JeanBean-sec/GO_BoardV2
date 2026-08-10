/**
 * board-live-feed.js
 *
 * Polls the GO Tracker proxy and writes live departure data into your
 * Webstudio-exported departure board.
 *
 * WHY data-slot ATTRIBUTES INSTEAD OF THE EXISTING CLASSES:
 * Webstudio's exported class names (w-time-slot-4, w-destination-6, etc.)
 * are auto-generated IDs, not row numbers — they don't reflect the actual
 * top-to-bottom order you see on screen. Guessing the mapping risks putting
 * one trip's time next to a different trip's platform.
 *
 * SETUP (one-time, ~2 min):
 *   1. Open your board in the Webstudio editor.
 *   2. Click each row's time element (top to bottom), and in the
 *      Settings/Attributes panel add a custom attribute:
 *          data-slot = 1   (then 2, 3, 4... for each row down the board —
 *          type the bare value, no quote marks, in Webstudio's value field)
 *   3. Do the same for the matching destination, stops, and platform
 *      elements in that row — same data-slot number across all four.
 *   4. Add data-field = time / destination / stops / platform to each
 *      respectively.
 *   5. Add data-role = clock to the current-time element and
 *      data-role = alert to the existing GoTracker alert element.
 *   6. For the separate GO Transit announcement block, add:
 *          data-role = announcement-title
 *      to the title element, and:
 *          data-role = announcement-body
 *      to the body element. These are the only two elements needed; the
 *      script cycles through announcements merged from two sources: the
 *      GO Transit website's service-updates page and the Metrolinx public
 *      service-update API (broader real-time coverage — track conditions,
 *      elevator outages — that the website alone doesn't surface).
 *   7. Union page only: add an image element to the left of each row's
 *      destination text, with the same data-slot as that row and
 *      data-field = destination-icon. It'll be shown/hidden and pointed at
 *      the right corridor logo automatically — leave its src blank. *   8. Optional, any page: add data-field = delay to an element at each
 *      row's data-slot to show that specific trip's live delay (e.g. "8 min
 *      delay — VIA traffic"), matched by trip number and sourced from two
 *      merged feeds: the Metrolinx service-update API's per-trip
 *      SaagNotifications, and gotracker.ca's live TripLocation feed
 *      (GPS-tracked, ~10s freshness) layered on top where both cover the
 *      same trip. Left blank when a trip has no reported delay.
 *   9. Optional, any page: add data-field = platform-time to an element at
 *      each row's data-slot to show a live "Info in X min / Infos en X min"
 *      countdown while a tail-filled trip's platform is still unconfirmed —
 *      takes over from the platform field (left blank) in that case, and
 *      goes blank itself once a real platform is known.
 *  10. Union page only, no Webstudio element needed: platforms 3-13 are
 *      accessible at Union specifically, so the accessibility icon is
 *      injected directly into the platform field's own text next to
 *      whichever platform number(s) qualify — image-as-emoji, inline.
 *  11. Re-export/publish, then include this script before </body>.
 *
 * UNION STATION IS A HUB, NOT A CORRIDOR:
 * Every corridor terminates at Union, so the Union page always polls all 7
 * corridors and merges them by time — the "Service code" field in the
 * control bar is ignored when Union is selected. Every other station is
 * still single-corridor, same as before. On Union, each row's destination
 * text is replaced with its corridor name (e.g. an Aldershot-bound trip
 * shows "Lakeshore West" instead of "Aldershot") with that corridor's logo
 * to the left of it.
 *
 * CHANGING STATION/LINE:
 * A control bar is pinned to the bottom of the page — pick a station, edit
 * the service code if needed, hit Save & Reload. Your choice is saved in
 * the browser's localStorage, so it persists across reloads without
 * touching this file again.
 */

(function () {
  // Derived from THIS script's own <script src> location rather than
  // hardcoded as "assets/" — a hardcoded root-absolute path only resolves
  // correctly when the page is served from the domain root (e.g. local dev
  // via `npx serve .`). On a GitHub Pages PROJECT page (anything other than
  // a <username>.github.io repo), the site actually lives under a
  // /RepoName/ subpath, and "assets/..." would incorrectly resolve to the
  // domain root instead — exactly the bug that prompted this. Since
  // board-live-feed.js is always included via a relative
  // <script src="./board-live-feed.js">, deriving from its own resolved
  // location means every hosting target (local dev, GitHub Pages project
  // page, custom domain, anywhere else) works automatically with zero
  // manual path configuration, forever — this never needs touching again
  // regardless of where the page ends up being served from.
  // const ASSET_BASE_URL = (() => {
  //   try {
  //     const scriptSrc = document.currentScript && document.currentScript.src;
  //     if (scriptSrc) return new URL(".", scriptSrc).href;
  //   } catch (e) {
  //     /* fall through to the relative fallback below */
  //   }
  //   return "./";
  // })();

  const ASSET_BASE_URL = "";

  const PROXY_URL = "https://go-boardv2.onrender.com/"; // swap for your deployed Worker URL when going live
  const POLL_MS = 20000; // 20s — matches the proxy's edge cache TTL
  const STOP_CYCLE_MS = 10000; // how often the stops field swaps to the next segment
  const ANNOUNCEMENT_CYCLE_MS = 12000; // how often the GO Transit announcement changes
  // Some announcements (e.g. a full list of every adjusted event-service
  // trip time) run on for far longer than the announcement box can ever
  // reasonably show — 1025 chars is the length of a real example of one of
  // those that overflows the page. Longer than this gets omitted entirely
  // rather than truncated, since a cut-off announcement mid-sentence reads
  // worse than simply not showing it.
  const MAX_ANNOUNCEMENT_BODY_LENGTH = 1025;
  const MAX_ROWS = 8; // matches the 8 time-slot rows on the Union (single-direction) board

  // In a "stop1 - stop2" cycle segment, if stop2's text — counted starting
  // right after the "-", so its leading space counts too — is longer than
  // this, the pair splits into two separate cycle segments instead of
  // sharing one line. Raise this to keep more pairs together on one line;
  // lower it to split more aggressively.
  const PAIR_SECOND_STOP_MAX_LENGTH = 20;

  const ANNOUNCEMENT_AUDIO_INTERVAL_MS = 100000;

  const ANNOUNCEMENT_AUDIO_FILES = [
    `${ASSET_BASE_URL}audio/announcement1.wav`,
    `${ASSET_BASE_URL}audio/announcement2.wav`,
    `${ASSET_BASE_URL}audio/announcement3.wav`,
  ];

  let announcementAudio = null;

  // --- Page layout ---------------------------------------------------------
  // Two Webstudio pages share this one script:
  //   "/"        — Union board: 8 rows, all trips toward Union, sorted by time.
  //   "/copy-1"  — non-Union board: slots 1 and 5 are static section-header
  //                labels ("Eastbound" / "Westbound"), not trip rows. Real
  //                trip data goes in slots 2-4 (toward Union) and 6-8 (away
  //                from Union). This page is meant to be reused for every
  //                non-Union corridor, so don't assume Lakeshore-only data.
  // Works out this deployment's real root-relative base path. On GitHub
  // Pages project sites (served under e.g. /GO_BoardV2/), Webstudio bakes
  // in a <base> tag; everywhere else (local `npx serve`, the Render-hosted
  // flow, a custom domain) there's no <base> tag and the site genuinely
  // lives at domain root. Deriving this once means every "/" vs "/copy-1"
  // comparison and every redirect below works identically regardless of
  // which of those this page is actually running under — previously these
  // were hardcoded absolute paths, which (a) never matched on GitHub
  // Pages since location.pathname there always carries the /GO_BoardV2
  // prefix, causing normalizedPath() to never equal "/" and PAGE_MODE to
  // always misdetect as "split", and (b) even when a redirect did fire,
  // location.href = "/copy-1" is itself a root-absolute target that
  // ignores <base> entirely and 404s outside the true domain root.
  function computeBasePath() {
    const baseEl = document.querySelector("base[href]");
    if (!baseEl) return "/";
    try {
      const path = new URL(baseEl.getAttribute("href"), location.href).pathname;
      return path.replace(/\/+$/, "") + "/";
    } catch {
      return "/";
    }
  }
  const BASE_PATH = computeBasePath(); // e.g. "/" locally, "/GO_BoardV2/" on GitHub Pages

  function normalizedPath() {
    let path = location.pathname;
    if (BASE_PATH !== "/" && path.startsWith(BASE_PATH)) {
      path = "/" + path.slice(BASE_PATH.length);
    }
    return path.replace(/\/+$/, "") || "/";
  }

  // Builds a real, correctly-prefixed absolute target for location.href —
  // "/" or "/copy-1" in the app's own path terms, translated into whatever
  // the actual deployment's base path is.
  function resolvePath(appPath) {
    const suffix = appPath === "/" ? "" : appPath.replace(/^\//, "");
    return BASE_PATH + suffix;
  }

  const PAGE_MODE = normalizedPath() === "/" ? "union" : "split";
  const INBOUND_SLOTS = [2, 3, 4]; // toward Union — "Eastbound" header at slot 1
  const OUTBOUND_SLOTS = [6, 7, 8]; // away from Union — "Westbound" header at slot 5

  // slot -> { segments: [{label, cancelled}], index: number }
  // Populated on every refresh(); read by the separate cycle timer below so
  // that swapping segments doesn't require a network round-trip.
  const rowStops = {};

  // GO Transit website announcements are deliberately kept separate from the
  // GoTracker S4Messages alert system. The left-side alert block continues
  // using [data-role="alert"]; the right-side announcement block uses these
  // two Webstudio elements.
  let announcements = [];
  let announcementIndex = 0;

  // Per-trip delay text, keyed by TripNumber (from the Metrolinx feed's
  // SaagNotifications), consumed by updateRow() for the optional
  // data-field="delay" element. Repopulated whenever announcements refresh
  // since both come from the same Metrolinx payload.
  let tripDelayIndex = {};

  function getSetting(key, fallback) {
    try {
      return localStorage.getItem(key) || fallback;
    } catch (e) {
      return fallback;
    }
  }

  function setSetting(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch (e) {
      /* ignore storage errors (e.g. private browsing) */
    }
  }

  let STATION = getSetting("goboard_station", "OA");
  let SERVICE = getSetting("goboard_service", "01");

  // --- Station list for the control bar dropdown --------------------------
  const STATIONS = [
    { code: "UN", name: "Union Station", corridor: "Lakeshore West / East" },
    { code: "EX", name: "Exhibition", corridor: "Lakeshore West" },
    { code: "MI", name: "Mimico", corridor: "Lakeshore West" },
    { code: "LO", name: "Long Branch", corridor: "Lakeshore West" },
    { code: "PO", name: "Port Credit", corridor: "Lakeshore West" },
    { code: "CL", name: "Clarkson", corridor: "Lakeshore West" },
    { code: "OA", name: "Oakville", corridor: "Lakeshore West" },
    { code: "BO", name: "Bronte", corridor: "Lakeshore West" },
    { code: "AP", name: "Appleby", corridor: "Lakeshore West" },
    { code: "BU", name: "Burlington", corridor: "Lakeshore West" },
    { code: "AL", name: "Aldershot", corridor: "Lakeshore West" },
    { code: "HA", name: "Hamilton", corridor: "Lakeshore West" },
    { code: "WR", name: "West Harbour", corridor: "Lakeshore West" },
    { code: "CF", name: "Confederation", corridor: "Lakeshore West" },
    { code: "SCTH", name: "St. Catharines", corridor: "Lakeshore West" },
    { code: "NI", name: "Niagara Falls", corridor: "Lakeshore West" },
    { code: "DA", name: "Danforth", corridor: "Lakeshore East" },
    { code: "SC", name: "Scarborough", corridor: "Lakeshore East" },
    { code: "EG", name: "Eglinton", corridor: "Lakeshore East" },
    { code: "GU", name: "Guildwood", corridor: "Lakeshore East" },
    { code: "RO", name: "Rouge Hill", corridor: "Lakeshore East" },
    { code: "PIN", name: "Pickering", corridor: "Lakeshore East" },
    { code: "AJ", name: "Ajax", corridor: "Lakeshore East" },
    { code: "WH", name: "Whitby", corridor: "Lakeshore East" },
    { code: "OS", name: "Oshawa", corridor: "Lakeshore East" },
    { code: "KP", name: "Kipling", corridor: "Milton" },
    { code: "DI", name: "Dixie", corridor: "Milton" },
    { code: "CO", name: "Cooksville", corridor: "Milton" },
    { code: "ER", name: "Erindale", corridor: "Milton" },
    { code: "SR", name: "Streetsville", corridor: "Milton" },
    { code: "ME", name: "Meadowvale", corridor: "Milton" },
    { code: "LS", name: "Lisgar", corridor: "Milton" },
    { code: "ML", name: "Milton", corridor: "Milton" },
    { code: "BL", name: "Bloor", corridor: "Kitchener" },
    { code: "MD", name: "Mount Dennis", corridor: "Kitchener" },
    { code: "WE", name: "Weston", corridor: "Kitchener" },
    { code: "ET", name: "Etobicoke North", corridor: "Kitchener" },
    { code: "MA", name: "Malton", corridor: "Kitchener" },
    { code: "BE", name: "Bramalea", corridor: "Kitchener" },
    { code: "BR", name: "Brampton", corridor: "Kitchener" },
    { code: "MO", name: "Mount Pleasant", corridor: "Kitchener" },
    { code: "GE", name: "Georgetown", corridor: "Kitchener" },
    { code: "AC", name: "Acton", corridor: "Kitchener" },
    { code: "GL", name: "Guelph", corridor: "Kitchener" },
    { code: "KI", name: "Kitchener", corridor: "Kitchener" },
    { code: "DW", name: "Downsview Park", corridor: "Barrie" },
    { code: "RU", name: "Rutherford", corridor: "Barrie" },
    { code: "MP", name: "Maple", corridor: "Barrie" },
    { code: "KC", name: "King City", corridor: "Barrie" },
    { code: "AU", name: "Aurora", corridor: "Barrie" },
    { code: "NE", name: "Newmarket", corridor: "Barrie" },
    { code: "EA", name: "East Gwillimbury", corridor: "Barrie" },
    { code: "BD", name: "Bradford", corridor: "Barrie" },
    { code: "BA", name: "Barrie South", corridor: "Barrie" },
    { code: "AD", name: "Allandale Waterfront", corridor: "Barrie" },
    { code: "OR", name: "Oriole", corridor: "Richmond Hill" },
    { code: "OL", name: "Old Cummer", corridor: "Richmond Hill" },
    { code: "LA", name: "Langstaff", corridor: "Richmond Hill" },
    { code: "RI", name: "Richmond Hill", corridor: "Richmond Hill" },
    { code: "GO", name: "Gormley", corridor: "Richmond Hill" },
    { code: "BM", name: "Bloomington", corridor: "Richmond Hill" },
    { code: "KE", name: "Kennedy", corridor: "Stouffville" },
    { code: "AG", name: "Agincourt", corridor: "Stouffville" },
    { code: "MK", name: "Milliken", corridor: "Stouffville" },
    { code: "UI", name: "Unionville", corridor: "Stouffville" },
    { code: "CE", name: "Centennial", corridor: "Stouffville" },
    { code: "MR", name: "Markham", corridor: "Stouffville" },
    { code: "MJ", name: "Mount Joy", corridor: "Stouffville" },
    { code: "ST", name: "Stouffville", corridor: "Stouffville" },
    { code: "LI", name: "Old Elm", corridor: "Stouffville" },
  ];

  // Only these two are confirmed against real API responses (Lakeshore West
  // via Oakville, Lakeshore East via Pickering). The rest are best-guess
  // route-numbering conventions — the bar flags them and lets you override.
  const SERVICE_CODE_BY_CORRIDOR = {
    "Lakeshore West": "01",
    "Lakeshore East": "09",
    "Lakeshore West / East": "01",
    Milton: "21",
    Kitchener: "30",
    Barrie: "65",
    "Richmond Hill": "61",
    Stouffville: "70",
  };
  const CONFIRMED_CORRIDORS = new Set([
    "Lakeshore West",
    "Lakeshore East",
    "Lakeshore West / East",
  ]);

  // --- Section-header labels for the split (/copy-1) page -----------------
  // Slots 1 and 5 on that page are static direction headers, not trip rows.
  // Which pair of labels applies depends on the corridor's actual geography
  // relative to Union, not just "east/west vs north/south": inbound always
  // means "toward Union", so the label flips between corridors on opposite
  // sides of Union even within the same east/west or north/south grouping.
  //   - Lakeshore West / Milton / Kitchener: Union is to the east, so
  //     inbound = Eastbound, outbound = Westbound.
  //   - Lakeshore East: Union is to the WEST, so inbound = Westbound,
  //     outbound = Eastbound — the reverse of the other three.
  //   - Barrie / Richmond Hill / Stouffville: Union is to the south, so
  //     inbound = Southbound, outbound = Northbound.
  const CORRIDOR_DIRECTION_LABELS = {
    "Lakeshore West": {
      inbound: "Eastbound | En direction est",
      outbound: "Westbound | En direction ouest",
    },
    "Lakeshore East": {
      inbound: "Westbound | En direction ouest",
      outbound: "Eastbound | En direction est",
    },
    Milton: {
      inbound: "Eastbound | En direction est",
      outbound: "Westbound | En direction ouest",
    },
    Kitchener: {
      inbound: "Eastbound | En direction est",
      outbound: "Westbound | En direction ouest",
    },
    Barrie: {
      inbound: "Southbound | En direction sud",
      outbound: "Northbound | En direction nord",
    },
    "Richmond Hill": {
      inbound: "Southbound | En direction sud",
      outbound: "Northbound | En direction nord",
    },
    Stouffville: {
      inbound: "Southbound | En direction sud",
      outbound: "Northbound | En direction nord",
    },
  };

  function currentCorridor() {
    const st = STATIONS.find((s) => s.code === STATION);
    return st ? st.corridor : "";
  }

  // --- Union pooling --------------------------------------------------------
  // Union is a hub, not a single corridor — every line stops there, so its
  // board polls all 7 corridors at once instead of one SERVICE code. This
  // is a distinct list from SERVICE_CODE_BY_CORRIDOR above (which is keyed
  // for the *other* stations' single-corridor picker and also carries the
  // combined "Lakeshore West / East" entry Union used to use before pooling
  // existed) — Union needs each corridor split out individually so every
  // trip can be tagged with which one it came from.
  const UNION_CORRIDOR_SERVICE_CODES = {
    "Lakeshore West": "01",
    "Lakeshore East": "09",
    Milton: "21",
    Kitchener: "30",
    Barrie: "65",
    "Richmond Hill": "61",
    Stouffville: "70",
  };

  // Logo asset per corridor, shown to the left of the destination text on
  // the Union page only. Paths match the SVGs already sitting in /assets.
  const CORRIDOR_LOGO_SRC = {
    "Lakeshore West": `${ASSET_BASE_URL}assets/GO_Lakeshore_West_logo.svg`,
    "Lakeshore East": `${ASSET_BASE_URL}assets/GO_Lakeshore_East_logo.svg`,
    Milton: `${ASSET_BASE_URL}assets/GO_Milton_logo.svg`,
    Kitchener: `${ASSET_BASE_URL}assets/GO_Kitchener_logo.svg`,
    Barrie: `${ASSET_BASE_URL}assets/GO_Barrie_logo.svg`,
    "Richmond Hill": `${ASSET_BASE_URL}assets/GO_Richmond_Hill_logo.svg`,
    Stouffville: `${ASSET_BASE_URL}assets/GO_Stouffville_logo.svg`,
  };

  // One fetch per corridor, tagging every trip with the corridor it came
  // from (used for both the destination-name swap and the logo lookup).
  // Promise.allSettled rather than Promise.all — one flaky corridor
  // shouldn't take down the whole pooled board.
  async function fetchCorridorTrips(corridor, serviceCode) {
    const res = await fetch(
      `${PROXY_URL}?station=UN&service=${serviceCode}&feed=status`,
    );
    if (!res.ok) throw new Error(`Feed error (${corridor}): ${res.status}`);
    const data = await res.json();
    const trips = ((data && data.TripStatus) || [])
      .filter(isRealTrip)
      .map((t) => Object.assign({}, t, { _corridor: corridor }));
    const messages = (data && data.S4Messages) || [];
    return { corridor, trips, messages };
  }

  // Alerts repeat across corridors (the same construction notice comes back
  // on every feed that touches it) — dedupe by message text so the ticker
  // doesn't loop through the same line 7 times.
  function dedupeMessages(messages) {
    const seen = new Set();
    const out = [];
    for (const m of messages) {
      const text = m && m.MsgText;
      if (!text || seen.has(text)) continue;
      seen.add(text);
      out.push(m);
    }
    return out;
  }

  async function fetchUnionPooledData() {
    const results = await Promise.allSettled(
      Object.entries(UNION_CORRIDOR_SERVICE_CODES).map(([corridor, code]) =>
        fetchCorridorTrips(corridor, code),
      ),
    );

    const trips = [];
    const messages = [];
    for (const r of results) {
      if (r.status === "fulfilled") {
        trips.push(...r.value.trips);
        messages.push(...r.value.messages);
      } else {
        console.error("GO board: corridor fetch failed", r.reason);
      }
    }
    return { trips, messages: dedupeMessages(messages) };
  }

  // Sets the slot-1/slot-5 header text to match the selected station's
  // corridor. Only the "time" field is touched at these slots — they're
  // never passed to updateRow(), so destination/stops/platform for slots 1
  // and 5 are left alone (they're empty placeholders in the Webstudio page).
  function updateSectionHeaders() {
    const labels = CORRIDOR_DIRECTION_LABELS[currentCorridor()];
    if (!labels) return; // unmapped corridor — leave whatever's already there

    const inboundHeaderEl = document.querySelector(
      '[data-slot="1"][data-field="time"]',
    );
    const outboundHeaderEl = document.querySelector(
      '[data-slot="5"][data-field="time"]',
    );
    if (inboundHeaderEl) inboundHeaderEl.textContent = labels.inbound;
    if (outboundHeaderEl) outboundHeaderEl.textContent = labels.outbound;
  }

  // --- Stop-cycle styling -------------------------------------------------
  // Injected once. Only styles the cancelled state now — the field just
  // holds one plain string at a time (no chain/wrap markup needed).
  function injectStopChainStyles() {
    if (document.getElementById("gotracker-stop-styles")) return;
    const style = document.createElement("style");
    style.id = "gotracker-stop-styles";
    style.textContent = `
      [data-field="stops"].gts-stop-cancelled {
        text-decoration: line-through;
        color: #d33;
        opacity: 0.75;
      }
      [data-field="delay"].gts-trip-stopped {
        color: #d33;
        font-weight: bold;
      }
      [data-field="platform"].gts-unconfirmed {
        color: #999;
        font-style: italic;
      }
      [data-field="time"].gts-cascade-delayed {
        color: #999;
        font-style: italic;
      }
      [data-field="time"].gts-time-stopped {
        color: #d33;
      }
      .gts-access-icon {
        height: 0.9em;
        width: auto;
        vertical-align: middle;
        margin-left: 0.15em;
        display: inline-block;
      }
      /* Hard on/off blink for cancelled rows — step-start snaps between
         opacity 1 and 0 instead of interpolating, so it reads as a genuine
         blink rather than a fade. ~1s per full cycle (once/second) sits in
         a comfortable, attention-getting range without being frantic —
         well under the 3-flashes-per-second threshold where flashing
         becomes a photosensitivity concern. */
      .gts-row-cancelled {
        animation: gts-row-blink 5s step-start infinite;
      }
      @keyframes gts-row-blink {
        50% {
          opacity: 0;
        }
      .gts-row-hidden {
        visibility: hidden;
        }
      }
    `;
    document.head.appendChild(style);
  }

  // --- Bottom marquee / control bar stacking --------------------------------
  // The scrolling marquee (a raw Webstudio HTML embed, position:fixed,
  // bottom:0) and the control bar below both anchor to the exact same
  // bottom-left corner of the screen — the control bar's much higher
  // z-index (9999 vs the marquee's 10) means it paints directly over the
  // marquee, hiding it completely from the moment buildControlBar() runs.
  // Rather than hardcode a guessed pixel offset, this measures the control
  // bar's ACTUAL rendered height (it can vary — e.g. wrapping to two lines
  // on a narrow screen) and pushes the marquee up by exactly that amount,
  // so the two stack cleanly instead of overlapping. Re-checked on resize
  // since the bar's height isn't fixed.
  function positionMarqueeAboveControlBar() {
    const bar = document.getElementById("gotracker-control-bar");
    const marquee = document.querySelector(".w-html-embed > div");
    if (!bar || !marquee) return;
    marquee.style.bottom = `${bar.offsetHeight}px`;
  }

  // --- Always-visible bottom control bar ----------------------------------
  function buildControlBar() {
    if (document.getElementById("gotracker-control-bar")) return;

    const bar = document.createElement("div");
    bar.id = "gotracker-control-bar";
    bar.style.cssText =
      "position:fixed;left:0;right:0;bottom:0;z-index:9999;background:#111;color:#fff;" +
      "font-family:Arial,sans-serif;font-size:13px;padding:8px 16px;" +
      "display:flex;align-items:center;gap:10px;flex-wrap:wrap;" +
      "border-top:1px solid #333;";

    const stationOptions = STATIONS.map(
      (s) =>
        `<option value="${s.code}" data-corridor="${s.corridor}">${s.name} (${s.code})</option>`,
    ).join("");

    bar.innerHTML = `
      <span style="opacity:.7;">Board:</span>
      <select id="gts-station" style="padding:4px;">${stationOptions}</select>
      <span style="opacity:.7;">Service code:</span>
      <input id="gts-service" style="width:60px;padding:4px;" />
      <button id="gts-save" style="padding:4px 12px;cursor:pointer;">Save &amp; Reload</button>
      <span id="gts-warning" style="color:#f4b400;"></span>
    `;

    document.body.appendChild(bar);

    const stationSelect = bar.querySelector("#gts-station");
    const serviceInput = bar.querySelector("#gts-service");
    const warning = bar.querySelector("#gts-warning");

    stationSelect.value = STATION;
    serviceInput.value = SERVICE;

    function refreshWarning() {
      const opt = stationSelect.selectedOptions[0];
      const corridor = opt ? opt.dataset.corridor : "";
      const isUnion = stationSelect.value === "UN";

      serviceInput.disabled = isUnion;
      serviceInput.title = isUnion
        ? "Ignored for Union — it pools every corridor automatically."
        : "";

      warning.textContent = isUnion
        ? "Union pools every corridor automatically — service code is ignored."
        : CONFIRMED_CORRIDORS.has(corridor)
          ? ""
          : `Unverified service code for ${corridor} — check it works.`;
    }

    stationSelect.addEventListener("change", () => {
      const opt = stationSelect.selectedOptions[0];
      const corridor = opt ? opt.dataset.corridor : "";
      serviceInput.value =
        SERVICE_CODE_BY_CORRIDOR[corridor] || serviceInput.value;
      refreshWarning();
    });

    bar.querySelector("#gts-save").addEventListener("click", () => {
      const newStation = stationSelect.value;
      setSetting("goboard_station", newStation);
      setSetting("goboard_service", serviceInput.value.trim());

      const appPath = newStation === "UN" ? "/" : "/copy-1";
      if (normalizedPath() !== appPath) {
        location.href = resolvePath(appPath); // navigate to the page that matches the new station
      } else {
        location.reload();
      }
    });

    refreshWarning();
  }

  // --- GO Transit website announcements ----------------------------------
  // The proxy fetches /en/service-updates and extracts its __NEXT_DATA__
  // payload. We then map the CMS structures into the two fields the board
  // actually needs: title + body.
  //
  // Relevance rules:
  //   - selected station's construction notices
  //   - selected station's service notices, if present
  //   - selected station's connected corridor schedule changes
  //   - Union gets every corridor's schedule changes
  //
  // This is intentionally independent of GoTracker S4Messages.
  async function fetchGoTransitAnnouncements() {
    const res = await fetch(`${PROXY_URL}?feed=announcements`);
    if (!res.ok)
      throw new Error(`GO Transit announcements error: ${res.status}`);
    return res.json();
  }

  function normalizeText(text) {
    return String(text || "")
      .replace(/\\u00a0/g, " ")
      .replace(/\\s+/g, " ")
      .trim();
  }

  // The GO site stores descriptions as Contentstack rich-text documents.
  // Recursively collect only visible text and ignore links' URLs/metadata.
  function richTextToPlainText(value) {
    const parts = [];

    function walk(node) {
      if (!node) return;
      if (typeof node === "string") {
        const text = normalizeText(node);
        if (text) parts.push(text);
        return;
      }
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      if (typeof node !== "object") return;

      if (typeof node.text === "string") {
        const text = normalizeText(node.text);
        if (text) parts.push(text);
      }
      if (Array.isArray(node.children)) node.children.forEach(walk);
    }

    walk(value);

    // Paragraph/list boundaries are not represented consistently by the
    // Contentstack payload, so de-duplicate whitespace after flattening.
    return normalizeText(parts.join(" "));
  }

  function announcementBody(alert) {
    if (!alert) return "";
    const description = alert.description;
    if (typeof description === "string") return normalizeText(description);

    const complex = description && description.rich_text_component_complex;
    if (complex) return richTextToPlainText(complex);

    const basic = description && description.rich_text_basic;
    if (basic) return richTextToPlainText(basic);

    return "";
  }

  function announcementId(item) {
    return [item.scope, item.code, item.title, item.body]
      .map(normalizeText)
      .join("|");
  }

  function addAnnouncement(out, seen, item) {
    const title = normalizeText(item.title);
    const body = normalizeText(item.body);
    if (!title && !body) return;
    if (body.length > MAX_ANNOUNCEMENT_BODY_LENGTH) return; // too long — omit rather than truncate

    const normalized = {
      title: title || "GO Transit Service Update",
      body: body || "",
      scope: item.scope || "",
      code: item.code || "",
      corridor: item.corridor || "",
      station: item.station || "",
      published: item.published || "",
    };

    const id = announcementId(normalized);
    if (seen.has(id)) return;
    seen.add(id);
    out.push(normalized);
  }

  function corridorsForAnnouncements() {
    if (STATION === "UN") return Object.keys(UNION_CORRIDOR_SERVICE_CODES);
    const corridor = currentCorridor();
    return corridor ? [corridor] : [];
  }

  function mapGoTransitAnnouncements(payload) {
    const content = payload && payload.content ? payload.content : {};
    const staticUpdates = content.staticUpdates || {};
    const construction = staticUpdates.constructionNotices || [];
    const schedule = staticUpdates.scheduleChanges || [];
    const serviceAlerts = content.serviceAlerts || {};
    const targetCorridors = new Set(corridorsForAnnouncements());
    const station = STATION;
    const out = [];
    const seen = new Set();

    // Station-specific notices. These are the strongest match because the
    // source itself gives us the station code.
    for (const notice of construction) {
      if (notice.code !== station) continue;
      for (const alert of notice.alerts || []) {
        addAnnouncement(out, seen, {
          scope: "station",
          code: notice.code,
          station: notice.title,
          title: alert.title,
          body: announcementBody(alert),
          published: notice.publishDate,
        });
      }
    }

    // Schedule changes are line/corridor-level. The source uses the corridor
    // name as the parent title (e.g. "Lakeshore West").
    for (const change of schedule) {
      const corridor = normalizeText(change.title);
      if (!targetCorridors.has(corridor)) continue;
      for (const alert of change.alerts || []) {
        addAnnouncement(out, seen, {
          scope: "corridor",
          code: change.code,
          corridor,
          title: alert.title,
          body: announcementBody(alert),
          published: change.publishDate,
        });
      }
    }

    // Keep support for the site's top-level serviceAlerts if/when they are
    // populated. They are global/current rather than station-specific.
    for (const group of [
      serviceAlerts.maintenance || [],
      serviceAlerts.secondary || [],
    ]) {
      for (const item of group) {
        const alerts =
          item.alerts || (item.title || item.description ? [item] : []);
        for (const alert of alerts) {
          addAnnouncement(out, seen, {
            scope: "global",
            code: item.code || alert.code,
            title: alert.title || item.title,
            body: announcementBody(alert),
            published: item.publishDate || alert.publishDate,
          });
        }
      }
    }

    // Newest first, matching the site's publish-date semantics.
    out.sort((a, b) => String(b.published).localeCompare(String(a.published)));
    return out;
  }

  // --- Metrolinx service-update API (second announcement source) ----------
  // https://api.metrolinx.com/external/go/serviceupdate/en/all — a single
  // call returns corridor-level operational notices (track conditions,
  // delays), station-level notices (elevators, pathway closures), and
  // network-wide announcements, plus per-trip live delay data
  // (SaagNotifications) that's used separately for the row-level delay
  // field, not the announcement box. This is genuinely broader real-time
  // coverage than the GO Transit site's CMS content covers on its own —
  // e.g. track-condition delays don't appear there at all — so both
  // sources are merged rather than one replacing the other. Bus notices
  // (Buses[] / BusAnnouncements) are deliberately skipped — this is a
  // train board.
  async function fetchMxServiceUpdates() {
    const res = await fetch(`${PROXY_URL}?feed=mx-updates`);
    if (!res.ok)
      throw new Error(`Metrolinx service update error: ${res.status}`);
    return res.json();
  }

  // The Metrolinx feed's MessageBody is raw Outlook/Word-generated HTML
  // (inline styles, <o:p> tags, safelink-wrapped hrefs) — a different beast
  // from the CMS's structured rich-text JSON, so it needs its own
  // extraction. DOMParser never executes embedded <script> content and the
  // parsed document is never attached to the live page, so this is safe to
  // run on untrusted HTML.
  function mxHtmlToText(html) {
    if (!html) return "";
    try {
      const doc = new DOMParser().parseFromString(String(html), "text/html");
      return normalizeText(doc.body ? doc.body.textContent : "");
    } catch (e) {
      // Fallback if DOMParser is unavailable for some reason — strip tags
      // with a blunt regex rather than showing raw markup.
      return normalizeText(String(html).replace(/<[^>]+>/g, " "));
    }
  }

  // The CMS source's publishDate is assumed ISO-ish (Date.parse handles it
  // directly); Metrolinx's PostedDateTime is "MM/DD/YYYY HH:mm:ss", which
  // does NOT sort correctly as a plain string (e.g. "08/04/2026" would
  // lexicographically sort before "12/23/2025" despite being later) — parse
  // both into a real timestamp for sorting.
  function announcementSortKey(published) {
    if (!published) return 0;
    const mx = /^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})$/.exec(
      published,
    );
    if (mx) {
      const [, mm, dd, yyyy, hh, min, ss] = mx;
      return Date.UTC(+yyyy, +mm - 1, +dd, +hh, +min, +ss);
    }
    const parsed = Date.parse(published);
    return Number.isNaN(parsed) ? 0 : parsed;
  }

  function mapMxAnnouncements(payload) {
    const out = [];
    const seen = new Set();
    const targetCorridors = new Set(corridorsForAnnouncements());
    const station = STATION;

    const trains = (payload && payload.Trains && payload.Trains.Train) || [];
    for (const corridor of trains) {
      if (!targetCorridors.has(corridor.CorridorName)) continue;
      const notices =
        (corridor.Notifications && corridor.Notifications.Notification) || [];
      for (const n of notices) {
        addAnnouncement(out, seen, {
          scope: "corridor",
          code: corridor.CorridorCode,
          corridor: corridor.CorridorName,
          title: n.MessageSubject,
          body: mxHtmlToText(n.MessageBody),
          published: n.PostedDateTime,
        });
      }
    }

    const stations =
      (payload && payload.Stations && payload.Stations.Station) || [];
    for (const st of stations) {
      if (st.StationCode !== station) continue;
      const notices = (st.Notifications && st.Notifications.Notification) || [];
      for (const n of notices) {
        addAnnouncement(out, seen, {
          scope: "station",
          code: st.StationCode,
          station: st.StationName,
          title: n.MessageSubject,
          body: mxHtmlToText(n.MessageBody),
          published: n.PostedDateTime,
        });
      }
    }

    // Network-wide notices tagged with one or more affected corridors
    // rather than nested per corridor — include if any affected corridor
    // is relevant to the current station.
    const networkNotices =
      (payload &&
        payload.TrainAnnouncements &&
        payload.TrainAnnouncements.Notification) ||
      [];
    for (const n of networkNotices) {
      const affected = (n.AffectedLineDetails || []).map((d) => d.Name);
      if (!affected.some((name) => targetCorridors.has(name))) continue;
      addAnnouncement(out, seen, {
        scope: "network",
        code: (n.AffectedLineCodes || []).join(","),
        corridor: affected.join(" / "),
        title: n.MessageSubject,
        body: mxHtmlToText(n.MessageBody),
        published: n.PostedDateTime,
      });
    }

    return out;
  }

  // Cross-source dedupe (CMS + Metrolinx may occasionally carry the same
  // notice) — same exact-match id as within a single source. Near-duplicate
  // notices phrased slightly differently across sources will both show;
  // that's an accepted limitation rather than attempting fuzzy matching.
  function dedupeAnnouncementsAcrossSources(items) {
    const seen = new Set();
    const out = [];
    for (const item of items) {
      const id = announcementId(item);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(item);
    }
    return out;
  }

  // --- Per-trip delay index (Metrolinx SaagNotifications) ------------------
  // Separate from the announcement box entirely — this feeds the optional
  // data-field="delay" element at each row's data-slot. "00:07:58" -> "8 min
  // delay" (rounded to the nearest minute); trips with no reported delay
  // are simply absent from the index, and updateRow() blanks the field.
  function formatDelayDuration(hms) {
    const m = /^(\d{2}):(\d{2}):(\d{2})$/.exec(hms || "");
    if (!m) return "";
    const hours = Number(m[1]);
    const minutes = Number(m[2]);
    const seconds = Number(m[3]);
    const totalMinutes = hours * 60 + minutes + (seconds >= 30 ? 1 : 0);
    if (totalMinutes <= 0) return "";
    if (totalMinutes >= 60) {
      const h = Math.floor(totalMinutes / 60);
      const mm = totalMinutes % 60;
      return mm ? `${h}h ${mm}m delay` : `${h}h delay`;
    }
    return `${totalMinutes} min delay`;
  }

  function buildTripDelayIndex(payload) {
    const index = {};
    const trains = (payload && payload.Trains && payload.Trains.Train) || [];
    for (const corridor of trains) {
      const saags =
        (corridor.SaagNotifications &&
          corridor.SaagNotifications.SaagNotification) ||
        [];
      for (const s of saags) {
        const label = formatDelayDuration(s.DelayDuration);
        if (!label) continue; // on-time trips don't need a row note
        const reason = normalizeText(s.DelayReason);
        const text = reason ? `${label} — ${reason}` : label;
        for (const tripNumber of s.TripNumbers || []) {
          index[tripNumber] = { text, status: s.Status || "" };
        }
      }
    }
    return index;
  }

  // --- Live per-trip status (gotracker.ca TripLocation) --------------------
  // Same data-field="delay" slot as buildTripDelayIndex() above, but this
  // source is actual live GPS-tracked position data (~10s freshness) rather
  // than a periodic notification feed, so where both cover the same trip,
  // this one is treated as more current and wins the merge below.
  // Same "X min delay"/"Xh Ym delay" formatting as formatDelayDuration()
  // above for a consistent look between sources — input shape differs
  // though (raw seconds here vs "HH:MM:SS" there), so it needs its own
  // formatter rather than reusing that one directly.
  function formatDelaySecondsLabel(seconds) {
    const s = Number(seconds);
    if (!Number.isFinite(s) || s <= 0) return "";
    const totalMinutes = Math.round(s / 60);
    if (totalMinutes <= 0) return "";
    if (totalMinutes >= 60) {
      const h = Math.floor(totalMinutes / 60);
      const mm = totalMinutes % 60;
      return mm ? `${h}h ${mm}m delay` : `${h}h delay`;
    }
    return `${totalMinutes} min delay`;
  }

  async function fetchTripLocations(serviceCode) {
    const res = await fetch(
      `${PROXY_URL}?feed=trip-location&service=${serviceCode}`,
    );
    if (!res.ok) throw new Error(`TripLocation error: ${res.status}`);
    const data = await res.json();
    return (data && data.trips) || [];
  }

  // Union needs every corridor's live trains, not just one — same
  // Promise.allSettled pattern as fetchUnionPooledData() above, so one
  // flaky corridor doesn't block the rest.
  async function fetchAllTripLocations() {
    const codes =
      STATION === "UN"
        ? Object.values(UNION_CORRIDOR_SERVICE_CODES)
        : [SERVICE];
    const results = await Promise.allSettled(codes.map(fetchTripLocations));
    const trips = [];
    for (const r of results) {
      if (r.status === "fulfilled") trips.push(...r.value);
      else console.error("GO board: TripLocation fetch failed", r.reason);
    }
    return trips;
  }

  function buildTripLocationDelayIndex(trips) {
    const index = {};
    for (const t of trips) {
      const label = formatDelaySecondsLabel(t.DelaySeconds);
      if (!label) continue; // on-time trips don't need a row note, same as the SaagNotifications path
      const detail = normalizeText(t.Detail || "");
      const text = detail ? `${label} — ${detail}` : label;
      // "Stopped" only when actually sitting at a station (InStation is
      // blank/" " while moving between stops) — matches the
      // gts-trip-stopped styling hook the SaagNotifications path already
      // sets via s.Status.
      const atStation = (t.InStation || "").trim().length > 0;
      const status =
        t.IsMoving === "false" && atStation
          ? "Stopped"
          : t.IsMoving === "true"
            ? "Moving"
            : "";
      if (t.TripNumber) index[t.TripNumber] = { text, status };
    }
    return index;
  }

  // Keep the announcement typography fixed. If a body does not fit inside
  // Webstudio's announcement body container, omit that announcement entirely.
  function filterFittingAnnouncements(items) {
    const bodyEl = document.querySelector('[data-role="announcement-body"]');
    if (!bodyEl || !Array.isArray(items)) return items;

    const originalText = bodyEl.textContent;
    const originalOverflow = bodyEl.style.overflow;
    const originalWhiteSpace = bodyEl.style.whiteSpace;

    bodyEl.style.overflow = "hidden";
    bodyEl.style.whiteSpace = "normal";

    const fitting = items.filter((item) => {
      bodyEl.textContent = item.body || "";
      return (
        bodyEl.scrollHeight <= bodyEl.clientHeight + 1 &&
        bodyEl.scrollWidth <= bodyEl.clientWidth + 1
      );
    });

    bodyEl.textContent = originalText;
    bodyEl.style.overflow = originalOverflow;
    bodyEl.style.whiteSpace = originalWhiteSpace;

    return fitting;
  }

  function renderAnnouncement({ animate = false } = {}) {
    const titleEl = document.querySelector('[data-role="announcement-title"]');
    const bodyEl = document.querySelector('[data-role="announcement-body"]');
    if (!titleEl && !bodyEl) return;

    const apply = () => {
      if (!announcements.length) {
        if (titleEl) titleEl.textContent = "";
        if (bodyEl) bodyEl.textContent = "";
        return;
      }
      const item = announcements[announcementIndex % announcements.length];
      if (titleEl) titleEl.textContent = item.title;
      if (bodyEl) bodyEl.textContent = item.body;
      // NOTE: fitting is already enforced up-front by filterFittingAnnouncements()
      // before an item ever reaches `announcements`, so there's nothing further
      // to measure/adjust here post-render.
    };

    if (animate) {
      // Title and body fade together as one unit so they never visually
      // desync mid-transition.
      fadeSwap([titleEl, bodyEl], apply);
    } else {
      apply();
    }
  }

  function setAnnouncements(next) {
    const previousId = announcements.length
      ? announcementId(announcements[announcementIndex % announcements.length])
      : null;

    announcements = filterFittingAnnouncements(Array.isArray(next) ? next : []);

    if (!announcements.length) {
      announcementIndex = 0;
      renderAnnouncement();
      return;
    }

    const preservedIndex = previousId
      ? announcements.findIndex((item) => announcementId(item) === previousId)
      : -1;

    announcementIndex =
      preservedIndex >= 0
        ? preservedIndex
        : announcementIndex % announcements.length;
    renderAnnouncement();
  }

  function tickAnnouncementCycle() {
    if (announcements.length <= 1) return;
    announcementIndex = (announcementIndex + 1) % announcements.length;
    renderAnnouncement({ animate: true });
  }

  async function refreshAnnouncements() {
    const [cmsResult, mxResult, tripLocationResult] = await Promise.allSettled([
      fetchGoTransitAnnouncements(),
      fetchMxServiceUpdates(),
      fetchAllTripLocations(),
    ]);

    if (cmsResult.status === "rejected") {
      console.error(
        "GO board: GO Transit announcements failed",
        cmsResult.reason,
      );
    }
    if (mxResult.status === "rejected") {
      console.error(
        "GO board: Metrolinx service updates failed",
        mxResult.reason,
      );
    }
    if (tripLocationResult.status === "rejected") {
      console.error(
        "GO board: TripLocation fetch failed",
        tripLocationResult.reason,
      );
    }

    const cmsItems =
      cmsResult.status === "fulfilled"
        ? mapGoTransitAnnouncements(cmsResult.value)
        : [];
    const mxItems =
      mxResult.status === "fulfilled" ? mapMxAnnouncements(mxResult.value) : [];

    const combined = dedupeAnnouncementsAcrossSources([
      ...cmsItems,
      ...mxItems,
    ]).sort(
      (a, b) =>
        announcementSortKey(b.published) - announcementSortKey(a.published),
    );

    setAnnouncements(combined);

    // SaagNotifications first (periodic notifications), then TripLocation
    // on top (live GPS-tracked, ~10s freshness) — where both cover the same
    // trip, the more current source wins.
    const saagIndex =
      mxResult.status === "fulfilled"
        ? buildTripDelayIndex(mxResult.value)
        : {};
    const liveIndex =
      tripLocationResult.status === "fulfilled"
        ? buildTripLocationDelayIndex(tripLocationResult.value)
        : {};
    tripDelayIndex = Object.assign({}, saagIndex, liveIndex);
  }

  // A single call to StationStatusJSON returns both TripStatus and
  // S4Messages (the alert-ticker text) — no need for a second request to
  // the StationMessage endpoint.
  async function fetchStationData() {
    const res = await fetch(
      `${PROXY_URL}?station=${STATION}&service=${SERVICE}&feed=status`,
    );
    if (!res.ok) throw new Error(`Feed error: ${res.status}`);
    return res.json();
  }

  // When there's no scheduled service, the feed returns placeholder rows
  // like TripNumber "NoTrip_Inbound"/"NoTrip_Outbound" with null times —
  // filter those out rather than rendering them as real trips.
  function isRealTrip(trip) {
    return (
      trip &&
      typeof trip.TripNumber === "string" &&
      !trip.TripNumber.startsWith("NoTrip") &&
      trip.ScheduledTime
    );
  }

  // FIX: the feed already gives us the real final destination in
  // trip.Destination (e.g. "Union", "West Harbour", "Aldershot",
  // "Confederation") — no need to guess it from direction/stop-list
  // keywords. The earlier heuristic defaulted almost every outbound trip to
  // "West Harbour" because it only special-cased a "Hamilton" substring that
  // never actually appears in StopListString, which is why destinations
  // looked repetitive.
  // On Union, the destination text is replaced with the corridor name
  // (e.g. an Aldershot-bound trip shows "Lakeshore West") since the logo to
  // its left already communicates the line — the raw station name would be
  // redundant. Every other station keeps showing the real destination.
  function destinationFor(trip) {
    if (PAGE_MODE === "union" && trip._corridor) return trip._corridor;
    return trip.Destination || (trip.DirectionCd === "Inbound" ? "Union" : "");
  }

  // FIX: UnionArrivePlatform/UnionDepartPlatform are ONLY populated for
  // Union Station itself — for every other station (Oakville included)
  // they're always null, which is why every row showed "—". The actual
  // per-station platform/track number the feed provides is trip.Track.
  function platformFor(trip) {
    const raw =
      trip.Track || trip.UnionArrivePlatform || trip.UnionDepartPlatform || "—";
    // Multi-platform trips come back "&"-joined from the source data (e.g.
    // "5 & 6", "11 & 12") — comma-separated reads better here.
    return raw.replace(/\s*&\s*/g, ", ");
  }

  // --- Accessibility icon (Union platform field only) -----------------------
  // Union platforms 3-13 specifically have accessible (elevator) access —
  // this is a physical fact about Union's own layout, not something any
  // feed reports, so it's a fixed lookup rather than derived from data.
  const ACCESS_ICON_SRC = `${ASSET_BASE_URL}assets/FINALACCESSICON.jpg`;
  const ACCESSIBLE_UNION_PLATFORMS = new Set(
    Array.from({ length: 13 - 3 + 1 }, (_, i) => String(i + 3)),
  );

  function accessibilityIconHtml() {
    return `<img src="${ACCESS_ICON_SRC}" alt="Accessible platform" class="gts-access-icon">`;
  }

  // Injects the icon directly next to each accessible platform number —
  // images-as-emoji, inline with the text — rather than needing a separate
  // Webstudio element per row. Union only, since the 3-13 rule is specific
  // to Union's physical layout. Each platform in a multi-platform trip
  // (already comma-joined by platformFor above) is checked independently,
  // so a "4, 5" trip can come out as "4♿, 5", "4, 5♿", or "4♿, 5♿"
  // depending on which of the two platforms actually has access.
  function platformDisplayHtml(platformText) {
    const parts = platformText
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    return parts
      .map((p) =>
        ACCESSIBLE_UNION_PLATFORMS.has(p)
          ? `${p}${accessibilityIconHtml()}`
          : p,
      )
      .join(", ");
  }

  function minutesUntilScheduledTime(scheduledTime) {
    const m = /^(\d{2}):(\d{2})$/.exec(scheduledTime || "");
    if (!m) return null;
    const now = new Date();
    const target = new Date(now);
    target.setHours(Number(m[1]), Number(m[2]), 0, 0);
    let diffMs = target - now;
    // A target that's more than 6 hours in the "past" actually means the
    // scheduled time has wrapped past midnight (e.g. it's 23:50 now and the
    // trip is scheduled for 00:15) — treat it as tomorrow instead.
    if (diffMs < -6 * 60 * 60 * 1000) diffMs += 24 * 60 * 60 * 1000;
    return Math.round(diffMs / 60000);
  }

  // --- Cascading delay for still-unconfirmed trips --------------------------
  // Once an unconfirmed trip's platform info is overdue, that's treated as
  // a sign something's backed up — every real minute it stays unconfirmed
  // pushes every OTHER unconfirmed trip scheduled after it in the same
  // queue later by CASCADE_MINUTES_PER_STUCK_MINUTE. The overdue trip's own
  // row shows "-" rather than a shifted time — only trips behind it move.
  //
  // Purely derived from the live clock vs. each trip's own effective time,
  // no separate timer or stored state needed, so a page refresh or a missed
  // poll can't desync it.
  //
  // Scoped to unconfirmed (tail-filled) trips only, never GoTracker's real
  // tracked trips, which already carry their own accurate delay data via
  // tripDelayIndex. By construction tail-filled trips only ever appear after
  // GoTracker's own trips in a queue, so this never reaches back to touch a
  // real trip's display.
  const CASCADE_MINUTES_PER_STUCK_MINUTE = 4;

  // "21:49" + 12 -> "22:01", wrapping past midnight the same way the
  // source feed's own times do (e.g. "23:50" + 30 -> "00:20", not "24:20").
  function addMinutesToTimeString(hhmm, minutesToAdd) {
    const m = /^(\d{2}):(\d{2})$/.exec(hhmm || "");
    if (!m || !minutesToAdd) return hhmm;
    const DAY = 24 * 60;
    let total = (Number(m[1]) * 60 + Number(m[2]) + minutesToAdd) % DAY;
    if (total < 0) total += DAY;
    const hh = String(Math.floor(total / 60)).padStart(2, "0");
    const mm = String(total % 60).padStart(2, "0");
    return `${hh}:${mm}`;
  }

  // Single source of truth for what a row's time field actually shows —
  // real ScheduledTime, or that same time pushed later by the cascade below
  // for a trip queued behind one or more overdue-unconfirmed trips.
  function displayTimeFor(trip) {
    const delay = trip._cascadeDelayMinutes || 0;
    return delay
      ? addMinutesToTimeString(trip.ScheduledTime, delay)
      : trip.ScheduledTime || "";
  }

  // REFINEMENT: measures against the trip's EFFECTIVE (cascaded) time, not
  // its original ScheduledTime — otherwise a row already pushed later by an
  // earlier stuck trip would have its own countdown/overdue state computed
  // against a departure time it's no longer actually using, disagreeing
  // with what the time field on that same row shows.
  function minutesUntilEffectiveDeparture(trip) {
    return minutesUntilScheduledTime(displayTimeFor(trip));
  }

  // --- "Info in X min" countdown (data-field="platform-time") --------------
  // GO appears to assign real platform info almost exactly 15 minutes
  // before a trip's scheduled departure — observed pattern, not something
  // any feed states outright.
  const PLATFORM_INFO_LEAD_MINUTES = 14;

  // `group` is one direction's (or Union's whole) already-ordered trip
  // array — mutated in place. For each unconfirmed trip this computes,
  // ONCE, everything the platform/platform-time fields and the cascade
  // itself need:
  //   trip._cascadeDelayMinutes      — minutes to push this row's displayed
  //                                    time later, from earlier stuck trips
  //   trip._minutesUntilPlatformInfo — signed countdown to when this trip's
  //                                    OWN platform info should appear
  //                                    (positive = still counting down,
  //                                    <= 0 = overdue, by that many minutes)
  // REFINEMENT: previously this same overdue/countdown math was computed up
  // to three separate times per trip per refresh (here, plus twice more in
  // updateRow for the platform and platform-time fields), each an
  // independent `new Date()` call. Never drifted enough to show a visibly
  // wrong number in practice, but there was no real reason for three
  // separate sources of truth — updateRow now just reads what's cached here.
  function applyCascadingDelay(group) {
    let cumulativeDelay = 0;
    for (const trip of group) {
      if (!isUnconfirmedFutureTrip(trip)) continue;
      trip._cascadeDelayMinutes = cumulativeDelay;

      const untilDeparture = minutesUntilEffectiveDeparture(trip);
      trip._minutesUntilPlatformInfo =
        untilDeparture === null
          ? null
          : untilDeparture - PLATFORM_INFO_LEAD_MINUTES;

      const overdue =
        trip._minutesUntilPlatformInfo !== null &&
        trip._minutesUntilPlatformInfo <= 0
          ? Math.abs(trip._minutesUntilPlatformInfo)
          : 0;
      cumulativeDelay += overdue * CASCADE_MINUTES_PER_STUCK_MINUTE;
    }
  }

  // FIX: trip.StoppingAt is only the FIRST entry of StoppingAtList — on a
  // real board that's fine because the physical sign scrolls/cycles through
  // the rest, so we mirror that instead of trying to cram the whole route
  // into one line: walk the full array and hand back each segment's label
  // (trailing " -"/"." trimmed) plus its cancelled flag, for the cycle
  // timer below to rotate through.
  // For a "stop1 - stop2" pair, if the second stop's text — measured
  // starting right after the "-", so its leading space counts too — would
  // exceed 10 characters, the pair splits into two separate cycle segments
  // instead of forcing them to share one line: stop1 cycles alone, then the
  // full (untruncated) stop2 name cycles alone right after it. Applies to
  // both GoTracker's own pre-chunked segments and this project's own
  // tail-fill chunking (chunkStopsIntoPairs), since both funnel through
  // stopSegmentsFor below.
  function splitPairIfSecondTooLong(label) {
    const dashIndex = label.indexOf(" - ");
    if (dashIndex === -1) return [label]; // not a pair, nothing to split
    const first = label.slice(0, dashIndex);
    const afterDash = label.slice(dashIndex + 2); // " stop2" — space + name, right after "-"
    if (afterDash.length <= PAIR_SECOND_STOP_MAX_LENGTH) return [label]; // fits fine as one pair, leave as-is
    const second = afterDash.trim();
    return [first, second].filter(Boolean);
  }

  function stopSegmentsFor(trip) {
    const raw = trip.StoppingAtList || [];
    const segments = [];

    raw.forEach((seg, i) => {
      const trimmed = (seg.StopDisplay || "").replace(/\s*[-.]\s*$/, "");
      if (!trimmed) return;
      const isLastEntry = i === raw.length - 1;
      // A whole-trip cancellation always wins, regardless of what this
      // specific segment's own IsCancelled says — needed because tail-filled
      // (Metrolinx) trips build their stop list via chunkStopsIntoPairs(),
      // which has no per-stop cancellation data and always reports false.
      // Without this, a cancelled tail-filled trip's stops would never show
      // red/strikethrough even though the row itself flashes as cancelled.
      const cancelled = !!trip.TripCancelled || !!seg.IsCancelled;
      const parts = splitPairIfSecondTooLong(trimmed);

      // Only the very last part of the very last raw entry marks the true
      // end of the route — if a pair got split, that's the second
      // (untruncated) stop, not the first.
      parts.forEach((part, partIndex) => {
        const isFinalPart = isLastEntry && partIndex === parts.length - 1;
        segments.push({
          label: isFinalPart ? `${part}.` : part,
          cancelled,
        });
      });
    });

    return segments;
  }

  // --- Shared cross-fade for cycling fields --------------------------------
  const CYCLE_FADE_MS = 220;

  // Fades one or more elements out, applies the content swap while
  // invisible, then fades back in. Used for both the stops cycle and the
  // announcement cycle so a segment/item change reads as a soft transition
  // rather than an abrupt text snap.
  function fadeSwap(elements, applyChange) {
    const valid = (Array.isArray(elements) ? elements : [elements]).filter(
      Boolean,
    );
    if (!valid.length) {
      applyChange();
      return;
    }
    valid.forEach((el) => {
      el.style.transition = `opacity ${CYCLE_FADE_MS}ms ease`;
      el.style.opacity = "0";
    });
    setTimeout(() => {
      applyChange();
      valid.forEach((el) => {
        el.style.opacity = "1";
      });
    }, CYCLE_FADE_MS);
  }

  // Paints one segment into a stops cell — plain text, no markup, since
  // there's nothing to chain together anymore.
  // `animate` is only ever true when called from the tick timer, not from
  // updateRow's initial per-poll population — a freshly (re)populated row
  // should just show its current segment immediately, not fade in from
  // nothing every refresh.
  function renderStopSegment(slot, { animate = false } = {}) {
    const stopsEl = document.querySelector(
      `[data-slot="${slot}"][data-field="stops"]`,
    );
    if (!stopsEl) return;

    const row = rowStops[slot];
    if (!row || !row.segments.length) {
      stopsEl.textContent = "";
      stopsEl.classList.remove("gts-stop-cancelled");
      return;
    }

    const seg = row.segments[row.index % row.segments.length];
    const apply = () => {
      stopsEl.textContent = seg.label;
      stopsEl.classList.toggle("gts-stop-cancelled", seg.cancelled);
    };

    // Cancelled rows are excluded on purpose: they already run the
    // gts-row-cancelled blink (a CSS `animation` toggling this same
    // element's opacity) — layering a `transition`-driven fade on top of a
    // running keyframe animation on the same property makes them visually
    // fight each other rather than looking like two intentional effects.
    if (animate && !row.cancelled) {
      fadeSwap(stopsEl, apply);
    } else {
      apply();
    }
  }

  // Ticks every row forward one segment in lockstep, so all rows swap at
  // the same moment rather than drifting against each other over time.
  function tickStopCycles() {
    for (const slot in rowStops) {
      const row = rowStops[slot];
      if (!row.segments.length) continue;
      row.index = (row.index + 1) % row.segments.length;
      renderStopSegment(slot, { animate: true });
    }
  }

  // Fallback reason source #2: reuses the announcements array that's
  // already being fetched/merged every poll cycle for the ticker — no
  // separate fetch needed. Only consulted when GoTracker's own per-trip
  // reason (ExtraRemark/Remarks) comes back empty. Station-scoped alerts
  // are checked first since they're the more specific match; corridor-wide
  // ones (e.g. "Lakeshore West service adjustments") are the fallback of
  // the fallback.
  function gotransitReasonFallback(trip) {
    const stationMatch = announcements.find(
      (a) => a.scope === "station" && a.code === STATION,
    );
    if (stationMatch)
      return normalizeText(stationMatch.title || stationMatch.body || "");

    const corridor = PAGE_MODE === "union" ? trip._corridor : currentCorridor();
    const corridorMatch = announcements.find(
      (a) => a.scope === "corridor" && a.corridor === corridor,
    );
    if (corridorMatch)
      return normalizeText(corridorMatch.title || corridorMatch.body || "");

    return "";
  }

  function updateRow(slot, trip) {
    const timeEl = document.querySelector(
      `[data-slot="${slot}"][data-field="time"]`,
    );
    const destEl = document.querySelector(
      `[data-slot="${slot}"][data-field="destination"]`,
    );
    const stopsEl = document.querySelector(
      `[data-slot="${slot}"][data-field="stops"]`,
    );
    const platformEl = document.querySelector(
      `[data-slot="${slot}"][data-field="platform"]`,
    );
    const platformTimeEl = document.querySelector(
      `[data-slot="${slot}"][data-field="platform-time"]`,
    );
    // Optional — no-op on rows that don't have this element.
    const iconEl = document.querySelector(
      `[data-slot="${slot}"][data-field="destination-icon"]`,
    );
    const delayEl = document.querySelector(
      `[data-slot="${slot}"][data-field="delay"]`,
    );

    if (!trip) {
      if (timeEl) {
        timeEl.textContent = "";
        timeEl.classList.remove("gts-cascade-delayed");
      }
      if (destEl) {
        destEl.textContent = "";
        destEl.classList.remove("gts-row-cancelled");
      }
      delete rowStops[slot];
      if (stopsEl) {
        stopsEl.textContent = "";
        stopsEl.classList.remove("gts-stop-cancelled");
        stopsEl.classList.remove("gts-row-cancelled");
      }
      if (platformEl) {
        platformEl.textContent = "";
        platformEl.classList.remove("gts-unconfirmed");
        platformEl.classList.remove("gts-row-cancelled");
      }
      if (platformTimeEl) {
        platformTimeEl.innerHTML = "";
        platformTimeEl.classList.remove("gts-row-cancelled");
      }
      if (iconEl) {
        iconEl.removeAttribute("src");
        iconEl.style.display = "none";
        iconEl.classList.remove("gts-row-cancelled");
      }
      if (delayEl) {
        delayEl.textContent = "";
        delayEl.classList.remove("gts-trip-stopped");
        delayEl.classList.remove("gts-row-cancelled");
      }
      return;
    }

    if (timeEl) {
      timeEl.classList.toggle("gts-time-stopped", trip.TripCancelled);
      timeEl.textContent = trip.TripCancelled
        ? displayTimeFor(trip)
        : displayTimeFor(trip);
      // A cancelled trip can still carry a cascade-delay estimate, but
      // cancellation should read as a clean red, not red-and-italic —
      // the cascade's italic styling only makes sense while the trip is
      // still actually running.
      timeEl.classList.toggle(
        "gts-cascade-delayed",
        !!trip._cascadeDelayMinutes && !trip.TripCancelled,
      );
    }
    if (destEl) {
      destEl.textContent = destinationFor(trip);
      //destEl.classList.toggle("gts-row-cancelled", !!trip.TripCancelled);
    }

    if (iconEl) {
      const logoSrc =
        PAGE_MODE === "union" ? CORRIDOR_LOGO_SRC[trip._corridor] : null;
      if (logoSrc) {
        iconEl.src = logoSrc;
        iconEl.style.display = "";
      } else {
        iconEl.removeAttribute("src");
        iconEl.style.display = "none";
      }
      if (!!trip.TripCancelled) {
        iconEl.src = logoSrc;
      }
    }

    // Keep whichever segment was already showing (rather than snapping back
    // to segment 0) so a mid-cycle poll refresh doesn't visibly jump.
    const prevIndex = rowStops[slot] ? rowStops[slot].index : 0;
    rowStops[slot] = {
      segments: stopSegmentsFor(trip),
      index: prevIndex,
      cancelled: !!trip.TripCancelled,
    };
    renderStopSegment(slot);
    if (stopsEl)
      stopsEl.classList.toggle("gts-row-cancelled", !!trip.TripCancelled);

    if (platformEl || platformTimeEl) {
      const unconfirmed = isUnconfirmedFutureTrip(trip);

      if (platformEl) {
        if (trip.TripCancelled) {
          // Unconditional on platformTimeEl existing — this used to only
          // fire when a page's row also had a platform-time element wired
          // up, so any row without one silently kept showing a real/blank
          // platform instead of "-" when cancelled.
          platformEl.textContent = "-";
        } else if (unconfirmed) {
          // Blank while the countdown is still running; "-" takes over once
          // it's overdue (platform-time has nothing left to count down at
          // that point, so this field carries the placeholder instead).
          const remaining = trip._minutesUntilPlatformInfo;
          platformEl.textContent =
            remaining !== null && remaining <= 0 ? "-" : "";
        } else {
          const text = platformFor(trip);
          if (PAGE_MODE === "union") {
            platformEl.innerHTML = platformDisplayHtml(text);
          } else {
            platformEl.textContent = text;
          }
        }
        // Gray/italic applies whenever the platform is a placeholder rather
        // than a real value — unconfirmed OR cancelled — with the flash
        // layered on top for cancelled specifically.
        platformEl.classList.toggle(
          "gts-unconfirmed",
          unconfirmed || !!trip.TripCancelled,
        );
        platformEl.classList.toggle("gts-row-cancelled", !!trip.TripCancelled);
      }

      if (platformTimeEl) {
        if (trip.TripCancelled) {
          platformTimeEl.innerHTML = "";
        } else if (unconfirmed) {
          const remaining = trip._minutesUntilPlatformInfo;
          platformTimeEl.innerHTML =
            remaining !== null && remaining > 0
              ? `Info in ${remaining} min<br>Infos en ${remaining} min`
              : "";
        } else {
          platformTimeEl.innerHTML = "";
        }
      }
    }

    if (delayEl) {
      if (trip.TripCancelled) {
        // Confirmed against a real cancelled-trip response: ExtraRemark is
        // the actual reason field ("Crew constraints."). Remarks[] carries
        // the same text per-language as a fallback. DetailTxt does NOT
        // contain a reason — it was wrongly prioritized before this fix,
        // since a real sample showed it's always just "Cancelled" again.
        const remarksEnglish = Array.isArray(trip.Remarks)
          ? (trip.Remarks.find((r) => r.Language === "English") || {}).Text
          : "";
        const reason =
          normalizeText(trip.ExtraRemark || remarksEnglish || "") ||
          gotransitReasonFallback(trip);
        delayEl.textContent = reason ? `Cancelled — ${reason}` : "Cancelled";
      } else {
        const delay = tripDelayIndex[trip.TripNumber];
        delayEl.textContent = delay ? delay.text : "";
      }
      delayEl.classList.toggle(
        "gts-trip-stopped",
        !!(tripDelayIndex[trip.TripNumber]?.status === "Stopped") &&
          !trip.TripCancelled,
      );
      //delayEl.classList.toggle("gts-row-cancelled", !!trip.TripCancelled);
    }
  }

  // A tail-filled (Metrolinx) trip whose platform is still "-" hasn't been
  // assigned real track info yet — GoTracker-sourced trips never hit this
  // (trip._future is only ever set by mapMetrolinxTrip).
  function isUnconfirmedFutureTrip(trip) {
    return !!(trip && trip._future && trip.Track === "-");
  }

  function updateClock() {
    const clockEl = document.querySelector('[data-role="clock"]');
    if (!clockEl) return;
    const now = new Date();
    clockEl.textContent = now.toLocaleTimeString("en-CA", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
  }

  function byScheduledTime(a, b) {
    return (a.ScheduledTime || "").localeCompare(b.ScheduledTime || "");
  }

  // --- Tail-fill: future/unconfirmed departures (Metrolinx, secondary) ----
  // GoTracker only returns "active"/currently-tracked trips — once those run
  // out for a direction, the board would otherwise sit on empty rows even
  // though more trips exist later in the schedule. This fills ONLY the
  // remaining empty slots after GoTracker's real trips are exhausted; it
  // never displaces a GoTracker-sourced row. "-" is used for any field this
  // source doesn't confirm, per instruction — not the "—" em-dash the
  // GoTracker path already uses for its own missing-platform case above.
  function cleanStopName(name) {
    const trimmed = (name || "").trim();
    if (/^Union Station$/i.test(trimmed)) return "Union";
    // A few stations are shared with VIA Rail and carry a "(Via Station)"
    // suffix (e.g. "Niagara Falls GO (Via Station)", "St. Catharines GO
    // (Via Station)") — strip that first so the plain " GO" strip below
    // still catches the "GO" that's now left at the end.
    return trimmed.replace(/\s*\(Via Station\)$/i, "").replace(/\s+GO$/i, "");
  }

  // Metrolinx exposes this same departures data in two different response
  // shapes depending on the exact endpoint path:
  //   "status" — /status/departures — allDepartures.items, cancellation as
  //              a real item.status field ("ontime"/"delayed"/presumably
  //              "cancelled", though that value itself is still unconfirmed
  //              from real data).
  //   "plain"  — /departures — trainDepartures.items + busDepartures.items
  //              (already split by mode), no status field at all — only a
  //              free-text item.info field (e.g. "Wait / Attendez",
  //              "Proceed / Avancez").
  // Every confirmed sample so far splits cleanly by station: Union always
  // came back on "plain", every other station tested (Oakville, Mimico)
  // came back well-populated on "status". Whether that's a genuine
  // Union-specific quirk in Metrolinx's own system or just a coincidence of
  // what's been tested isn't fully certain — but it's a clean, easy
  // one-line fix here if a future sample contradicts it.
  function departuresVariantForStation(stationCode) {
    return stationCode === "UN" ? "plain" : "status";
  }

  // Groups a flat list of downstream stops two at a time into
  // "stop1 - stop2" labels, matching the paired chunk format real GoTracker
  // StoppingAtList entries already come in. An odd stop out at the end
  // (e.g. the final single stop before a terminus) is left as its own
  // one-stop chunk rather than dropped.
  function chunkStopsIntoPairs(stops) {
    const chunks = [];
    for (let i = 0; i < stops.length; i += 2) {
      const pair = stops.slice(i, i + 2).map((s) => cleanStopName(s.stopName));
      chunks.push({ StopDisplay: pair.join(" - "), IsCancelled: false });
    }
    return chunks;
  }

  // Shape-independent core — direction/destination/stop-list parsing reads
  // identical fields (allDepartureStops.departureDetailsList) in both
  // shapes, so this is shared. Duck-types the result into the exact same
  // shape isRealTrip/destinationFor/platformFor/stopSegmentsFor/updateRow
  // already expect from a GoTracker trip, so none of the render code needs
  // to know which source or shape a given row came from.
  function mapMetrolinxDeparture(item, cancelled) {
    const stops =
      (item.allDepartureStops && item.allDepartureStops.departureDetailsList) ||
      [];
    // GoTracker's StoppingAtList only lists stops AHEAD of the train, not
    // the origin itself — match that by dropping the current station.
    const downstream = stops.filter((s) => s.stopCode !== STATION);
    const lastStop =
      downstream[downstream.length - 1] || stops[stops.length - 1];
    // Inbound = toward Union, matching the convention used everywhere else
    // in this file. Checking only the LAST stop misclassified through-
    // running trips (stayInTrain combos, e.g. a Lakeshore West trip that
    // continues past Union all the way to Oshawa) as Outbound, since Union
    // wasn't their final stop. A train can't pass through Union twice, so
    // "Union is still ahead somewhere downstream" is unambiguous regardless
    // of where the trip ultimately terminates.
    const directionCd = downstream.some((s) => s.stopCode === "UN")
      ? "Inbound"
      : "Outbound";

    return {
      TripNumber: item.tripNumber,
      ScheduledTime: item.scheduledTime || "-",
      TripCancelled: cancelled,
      DirectionCd: directionCd,
      Destination: lastStop ? cleanStopName(lastStop.stopName) : "-",
      Track: item.platform || "-",
      // Real GoTracker StoppingAtList entries come pre-chunked in pairs
      // (e.g. "Exhibition - Mimico -"), which is why stopSegmentsFor() trims
      // a trailing " -"/"." off each entry. Tail-fill trips previously built
      // one raw stop name per entry instead, so they cycled single station
      // names rather than the same "stop1 - stop2" pairs real rows show —
      // group downstream stops two at a time here to match that format.
      StoppingAtList: chunkStopsIntoPairs(downstream),
      _future: true,
    };
  }

  // "status" shape mapper — used for every station except Union.
  function mapMetrolinxTrip(item) {
    return mapMetrolinxDeparture(item, item.status === "cancelled");
  }

  // "plain" shape mapper — used for Union. No boolean status field exists
  // on this shape, so cancellation has to be inferred from the free-text
  // info field instead — not yet confirmed against a real cancelled trip's
  // exact wording, so this is a best-effort match, not a certainty.
  function mapMetrolinxPlainTrip(item) {
    return mapMetrolinxDeparture(item, /cancel/i.test(String(item.info || "")));
  }

  async function fetchFutureTrips() {
    const variant = departuresVariantForStation(STATION);
    const res = await fetch(
      `${PROXY_URL}?feed=departures&variant=${variant}&station=${STATION}&pageLimit=20`,
    );
    if (!res.ok) throw new Error(`Future departures error: ${res.status}`);
    const data = await res.json();
    const items =
      (data && data.allDepartures && data.allDepartures.items) || [];
    // Train only — this is a train board, matching the same bus-exclusion
    // already applied to the announcement sources.
    return items
      .filter((item) => item.transitTypeName === "T")
      .map(mapMetrolinxTrip);
  }

  // --- Union tail-fill ------------------------------------------------------
  // Union's own flavour of the same idea, but simpler in one way (no
  // inbound/outbound split needed — every departure FROM Union is
  // inherently "outbound" from Union's own perspective, matching how
  // GoTracker's pooled Union trips already render as one flat sorted list)
  // and trickier in another: each tail-filled trip needs a _corridor tag so
  // the logo + corridor-name-swap already used for every Union row keeps
  // working. Metrolinx's departures response conveniently includes its own
  // lineCode per trip for exactly this.
  //
  // LW/LE/KI/BR are now confirmed against real departures-endpoint
  // responses (KI corrected from an earlier wrong guess of "GT", carried
  // over from a different Metrolinx endpoint that turned out not to share
  // the same code for Kitchener). MI/RH/ST are still the original
  // carried-over guess, not yet independently confirmed from this specific
  // endpoint. If a future sample shows a mismatch, this map is the first
  // place to fix.
  const CORRIDOR_BY_LINECODE = {
    LW: "Lakeshore West",
    LE: "Lakeshore East",
    MI: "Milton",
    KI: "Kitchener",
    BR: "Barrie",
    RH: "Richmond Hill",
    ST: "Stouffville",
  };

  function mapMetrolinxUnionTrip(item) {
    const corridor = CORRIDOR_BY_LINECODE[item.lineCode];
    if (!corridor) return null; // unmapped line code — drop rather than guess
    const trip = mapMetrolinxPlainTrip(item);
    trip._corridor = corridor;
    return trip;
  }

  async function fetchFutureUnionTrips() {
    // Always "plain" — see departuresVariantForStation() above.
    const res = await fetch(
      `${PROXY_URL}?feed=departures&variant=plain&station=UN&pageLimit=20`,
    );
    if (!res.ok) throw new Error(`Future departures error: ${res.status}`);
    const data = await res.json();
    // "plain" shape is already split by mode — no transitTypeName filter
    // needed, trainDepartures.items is trains-only by construction.
    const items =
      (data && data.trainDepartures && data.trainDepartures.items) || [];
    return items.map(mapMetrolinxUnionTrip).filter(Boolean); // drop unmapped-corridor trips
  }

  // `upcoming` is Union's already-sorted, already-sliced-to-MAX_ROWS list —
  // mutated in place, same pattern as the split-page filler below.
  async function fillFutureUnionTrips(upcoming, existingTrips) {
    const needed = MAX_ROWS - upcoming.length;
    if (needed <= 0) return; // GoTracker already full — no Metrolinx call needed

    try {
      const existingNumbers = new Set(existingTrips.map((t) => t.TripNumber));
      const future = (await fetchFutureUnionTrips())
        .filter((t) => !existingNumbers.has(t.TripNumber))
        .sort(byScheduledTime);

      while (upcoming.length < MAX_ROWS && future.length) {
        upcoming.push(future.shift());
      }
    } catch (err) {
      console.error("GO board: Union future-trip tail fill failed", err);
    }
  }

  // --- Split-page tail-fill ---------------------------------------------
  async function fillFutureTrips(inbound, outbound, existingTrips) {
    const inboundNeeded = INBOUND_SLOTS.length - inbound.length;
    const outboundNeeded = OUTBOUND_SLOTS.length - outbound.length;
    if (inboundNeeded <= 0 && outboundNeeded <= 0) return; // GoTracker already full — no Metrolinx call needed

    try {
      const existingNumbers = new Set(existingTrips.map((t) => t.TripNumber));
      const future = (await fetchFutureTrips()).filter(
        (t) => !existingNumbers.has(t.TripNumber),
      );

      const futureInbound = future
        .filter((t) => t.DirectionCd === "Inbound")
        .sort(byScheduledTime);
      const futureOutbound = future
        .filter((t) => t.DirectionCd === "Outbound")
        .sort(byScheduledTime);

      while (inbound.length < INBOUND_SLOTS.length && futureInbound.length) {
        inbound.push(futureInbound.shift());
      }
      while (outbound.length < OUTBOUND_SLOTS.length && futureOutbound.length) {
        outbound.push(futureOutbound.shift());
      }
    } catch (err) {
      console.error("GO board: future-trip tail fill failed", err);
    }
  }

  async function refresh() {
    updateClock();

    try {
      let trips, messages;

      if (PAGE_MODE === "union") {
        // Union is a hub — pull all 7 corridors and merge, rather than one
        // station+service pair like every other page.
        const pooled = await fetchUnionPooledData();
        trips = pooled.trips;
        messages = pooled.messages;
      } else {
        const data = await fetchStationData();
        trips = ((data && data.TripStatus) || []).filter(isRealTrip);
        messages = (data && data.S4Messages) || [];
      }

      if (PAGE_MODE === "split") {
        // Slots 1 and 5 are static "Eastbound"/"Westbound" header labels on
        // this page, not trip rows — deliberately not touched here.
        const inbound = trips
          .filter((t) => t.DirectionCd === "Inbound")
          .sort(byScheduledTime)
          .slice(0, INBOUND_SLOTS.length);
        const outbound = trips
          .filter((t) => t.DirectionCd === "Outbound")
          .sort(byScheduledTime)
          .slice(0, OUTBOUND_SLOTS.length);

        // Only reaches out to the secondary (Metrolinx) source if GoTracker
        // didn't fill every row on its own.
        await fillFutureTrips(inbound, outbound, trips);

        // Each direction is its own queue for cascading-delay purposes —
        // an overdue trip on the inbound side has no bearing on outbound.
        applyCascadingDelay(inbound);
        applyCascadingDelay(outbound);

        INBOUND_SLOTS.forEach((slot, i) => updateRow(slot, inbound[i]));
        OUTBOUND_SLOTS.forEach((slot, i) => updateRow(slot, outbound[i]));
      } else {
        // Union page: every slot is a real trip row, merged across every
        // corridor, soonest first.
        const upcoming = trips.sort(byScheduledTime).slice(0, MAX_ROWS);

        // Only reaches out to the secondary (Metrolinx) source if GoTracker
        // didn't fill every row on its own.
        await fillFutureUnionTrips(upcoming, trips);

        // Union's whole pooled list is one queue — an overdue Barrie trip
        // can just as easily be "in the way" of a Stouffville trip queued
        // right behind it in the merged, soonest-first list.
        applyCascadingDelay(upcoming);

        for (let i = 0; i < MAX_ROWS; i++) {
          updateRow(i + 1, upcoming[i]);
        }
      }

      const alertEl = document.querySelector('[data-role="alert"]');
      if (alertEl && messages.length) {
        alertEl.textContent = messages.map((m) => m.MsgText).join("  ");
      }
    } catch (err) {
      console.error("GO board: failed to update board", err);
    }
  }

  function init() {
    // If the saved station doesn't match the page we're on (e.g. a
    // bookmark to "/" while Oakville is saved from a previous visit),
    // send the browser to the right page instead of rendering the wrong
    // layout for that station's data.
    const expectedPath = STATION === "UN" ? "/" : "/copy-1";
    if (normalizedPath() !== expectedPath) {
      location.href = resolvePath(expectedPath);
      return;
    }

    injectStopChainStyles();
    buildControlBar();
    positionMarqueeAboveControlBar();
    window.addEventListener("resize", positionMarqueeAboveControlBar);
    if (PAGE_MODE === "split") updateSectionHeaders();
    refresh();
    refreshAnnouncements();
    setInterval(refresh, POLL_MS);
    setInterval(refreshAnnouncements, POLL_MS);
    setInterval(updateClock, 1000);
    setInterval(tickStopCycles, STOP_CYCLE_MS);
    setInterval(tickAnnouncementCycle, ANNOUNCEMENT_CYCLE_MS);

    // Re-check which announcements fit if the Webstudio layout changes size.
    window.addEventListener("resize", () => {
      if (!announcements.length) return;
      const current = announcements;
      announcements = filterFittingAnnouncements(current);
      if (!announcements.length) {
        announcementIndex = 0;
        renderAnnouncement();
        return;
      }
      announcementIndex = announcementIndex % announcements.length;
      renderAnnouncement();
    });

    // --- Random announcement audio ---------------------------------------
    announcementAudio = new Audio();

    function playRandomAnnouncementAudio() {
      if (!ANNOUNCEMENT_AUDIO_FILES.length) return;

      const randomFile =
        ANNOUNCEMENT_AUDIO_FILES[
          Math.floor(Math.random() * ANNOUNCEMENT_AUDIO_FILES.length)
        ];

      announcementAudio.src = randomFile;
      announcementAudio.currentTime = 0;

      announcementAudio.play().catch((err) => {
        console.warn("GO board: announcement audio failed:", err);
      });
    }

    // Start the timer after the board has initialized.
    setInterval(playRandomAnnouncementAudio, ANNOUNCEMENT_AUDIO_INTERVAL_MS);
  }

  // If the script loads after the page has already finished loading (common
  // with embedded/async script tags), "DOMContentLoaded" has already fired
  // and a listener for it would never run — so check readyState first.
  const firstBody = document.body;

  const waitForBodyReplacement = setInterval(() => {
    if (document.body !== firstBody) {
      clearInterval(waitForBodyReplacement);

      requestAnimationFrame(() => {
        init();
      });
    }
  }, 50);
});
