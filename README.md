# GO Board

A live departure board for GO Transit stations — real-time train times, platforms, delays, cancellations, and service alerts, built on a Webstudio-exported static site with a small proxy server bridging several data sources GO Transit doesn't officially expose for this kind of use.

<img width="1846" height="1115" alt="initialization_placeholderformat" src="https://github.com/user-attachments/assets/ed4cd316-c6f9-41f2-8fa0-d2209af23529" />
<img width="1846" height="1077" alt="corridor_union" src="https://github.com/user-attachments/assets/61d7cee6-252f-4d14-9006-59a8b8e5ae32" />
https://github.com/user-attachments/assets/e45e6fd1-06d6-4aed-a83c-fc9e65fe4777

## What this is

A departure board for a single non-Union station shows two directions (toward Union / away from Union) with live times, platform, delay status, and a cycling stop list. A separate Union hub board pools every corridor into one merged, soonest-first board, since Union is a terminus for all seven GO train lines.

## Features

- **Live departures**, primary-sourced from GoTracker's `StationStatusJSON`, with a secondary Metrolinx feed filling in future/unconfirmed trips once the primary source runs out for a direction (shown muted/italic until confirmed)
- **Cascading delay estimation** — an unconfirmed trip whose platform info goes overdue is treated as "in the way," nudging the display time of trips queued behind it
- **Cancellation handling** — per-stop and whole-trip cancellation, with distinct styling (flashing red, strikethrough stops, `"-"` platform), and a cancellation *reason* pulled from GoTracker's `ExtraRemark`/`Remarks` fields, falling back to matching service alerts if that's empty
- **Live delay/status enrichment** via GoTracker's `TripLocation` endpoint (real per-train GPS + moving/stopped status), merged on top of a secondary Metrolinx service-update delay index
- **Service announcements**, scraped from gotransit.com's embedded page data (construction notices, schedule changes, service alerts), cycling with a cross-fade transition
- **Union hub board**, sourced entirely from Metrolinx's departures feed (GoTracker has no working data for `station=UN` — confirmed directly, not assumed)
- **A bottom control bar** for switching station/line without touching code, persisted via `localStorage`
- Corridor logos, audio announcement chimes, stop-list cycling, and a handful of other small niceties along the way

## Architecture

```
Webstudio static export (index.html + copy-1/index.html)
        │
        ├─ board-live-feed.js   (all client logic — polling, rendering, cascading delay, etc.)
        │
        └─ fetch()  ───────────►  proxy server (gotracker-proxy-local.js)
                                          │
                                          ├─ GoTracker StationStatusJSON  (primary train data)
                                          ├─ GoTracker TripLocation       (live GPS/delay per train)
                                          ├─ Metrolinx departures feed    (secondary source + Union primary)
                                          └─ gotransit.com service-updates (scraped, __NEXT_DATA__ JSON)
```

The proxy exists because GoTracker sits behind bot-detection that blocks plain `fetch()` calls without realistic browser headers, and because several of these responses need reshaping (XML-wrapped JSON, raw XML attributes, embedded page JSON) before the client can use them cleanly.

## Deployment: from Webstudio to GitHub + Render

**Phase 0 — Webstudio.** The board itself (layout, station rows, fonts, corridor logos, the whole visual design) was built in [Webstudio](https://webstudio.is), a no-code visual site builder, and exported as static HTML/CSS/JS. At export time it was pure static markup with placeholder data — no live fetching, no proxy, nothing dynamic at all. Everything from here down (`board-live-feed.js`, the proxy, all the data-source work) was layered on top of that export afterward.

**Phase 1 — local dev.** This started as purely local: `node gotracker-proxy-local.js` on one terminal, `npx serve` on another, both talking over `localhost`.

**Phase 2 — GitHub + Render.** Getting it properly hosted meant a few real changes, not just "upload it":

1. **Dynamic port binding.** The proxy hardcoded `const PORT = 8787`. Render (and most hosts) assign a port dynamically via `process.env.PORT` — the fix falls back to `8787` for local dev, where nothing sets that variable.
2. **`package.json` + `render.yaml`.** The project had never needed a manifest before (`node file.js` was enough locally). Render needs to know how to install and start it.
3. **Static frontend on GitHub Pages, proxy on Render — two separate hosts.** GitHub Pages serves `GO_Board/` as a static site; Render runs the Node proxy as a separate web service. `board-live-feed.js`'s `PROXY_URL` points at the Render URL in production.
4. **Base-path detection.** GitHub Pages project sites serve from a subpath (e.g. `/GO_BoardV2/`), not domain root — Webstudio bakes a `<base href="...">` tag in for this. Early on, several asset paths (a couple of font preloads, one image `src`) were hardcoded to that subpath directly instead of relying on the `<base>` tag, which would've silently broken again the next time this repo got renamed (it already had once). Consolidated into one `computeBasePath()` function reading the actual `<base>` tag at runtime, used everywhere — no more hardcoded assumptions about the deployment path.
5. **A path-fixing pass for the exported HTML** (`fix-ghpages-paths.cjs`), since Webstudio's own export doesn't know it's headed for a GitHub Pages subpath.

## Data sources

| Source | What it provides | Status |
|---|---|---|
| GoTracker `StationStatusJSON` | Primary train departure data (non-Union stations) | Live, working |
| GoTracker `TripLocation` | Live per-train GPS + moving/stopped status | Live, working |
| Metrolinx departures (undocumented) | Secondary/tail-fill source, Union's primary source | Live, working |
| gotransit.com service updates | Announcements (scraped page JSON) | Live, working |
| **Official Metrolinx Open API** | Everything above, officially, plus schedules/GTFS | **Key obtained — not yet integrated** |

## Roadmap / planned features

- [ ] **Migrate to the official Metrolinx Open API** now that a key's been issued — `UnionDepartureAll`, `ServiceAtGlance`, `ScheduleTrip`/`ScheduleJourney`, `ServiceAlertAll`, and the GTFS-realtime feeds could replace most of the scraped/undocumented endpoints above with something actually documented and stable
- [ ] **Printed schedule ingestion** — parsing official line schedule PDFs (Lakeshore West in progress) as a further-future fallback source beyond live tracking, for trips neither GoTracker nor the live Metrolinx feed have picked up yet
- [ ] **Live map** — `TripLocation` and the official API both already provide lat/long per train; nothing currently renders it
- [ ] Extend service-code verification for Milton/Kitchener/Barrie/Richmond Hill/Stouffville (currently best-guess, only Lakeshore West/East confirmed against live data)
- [ ] PLACEHOLDER — anything else on your list

## Known limitations

- Several corridor service codes are unverified guesses (flagged directly in the control bar UI when selected)
- The `gotransit.com` announcement scrape depends on that page's internal data structure, which could change without notice
- Cancellation reasons fall back through a couple of fields (`ExtraRemark` → `Remarks` → matching service alert) since GoTracker's own reason field isn't always populated

## Setup

```bash
# Terminal 1 — proxy
node gotracker-proxy-local.js

# Terminal 2 — static site
cd GO_Board && npx serve .
```

Or just run `start.bat` (Windows) to do both plus open the browser.

For production: deploy `gotracker-proxy-local.js` to Render (see `render.yaml`), and the `GO_Board/` folder to GitHub Pages or any static host. Update `PROXY_URL` in `board-live-feed.js` to point at the deployed proxy.

---
