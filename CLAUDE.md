# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository overview

This repo contains a self-contained pace-planning tool for "Les Géants 300", an ultra-distance cycling event. There is no build system, package manager, or test suite — it is plain static files served as-is.

- `index.html` — the page shell (~170 lines): meta tags, Leaflet CSS/JS from unpkg, then `style.css`, `route.js`, `app.js`. Must stay named `index.html` — GitHub Pages serves it at the site root.
- `style.css` — all styling (~500 lines).
- `route.js` — a single line: `const ROUTE = {meta: {...}, track: [{km, lat, lon, ele}, ...]}`, sampled every 0.1 km. ~200 KB on one line — never `Read` it whole, it exceeds tool token limits. Use `head -c` / `grep -o` to inspect fragments.
- `app.js` — the application logic (~1070 lines), wrapped in `(function(){ ... })();`.
- `geants-2026.gpx` — the raw GPX source (COROS export) that `ROUTE.track` was derived from. There is no script in this repo that performs the GPX → `ROUTE` conversion; if regenerating, resample the GPX trkpts to a `{km, lat, lon, ele}` array (~0.1 km spacing) and rewrite `route.js`.

## Deployment (GitHub Pages)

The app is live at **https://mleprince.github.io/geants-300/**, served by GitHub Pages from the `main` branch, root path, of `mleprince/geants-300` (public).

Deploying a change is just a push — Pages rebuilds automatically in ~1 minute:

```bash
git add -A && git commit -m "..." && git push
```

Notes:
- The remote uses **HTTPS**, not SSH (the SSH key was not available when the repo was set up). If a push asks for credentials, `gh auth git-credential` supplies them: `git -c credential.helper='!gh auth git-credential' push`.
- Check the build status / verify a deploy:
  ```bash
  gh api repos/mleprince/geants-300/pages --jq .status   # "built" when done
  curl -sS -o /dev/null -w "%{http_code}\n" https://mleprince.github.io/geants-300/
  ```
- All asset paths in `index.html` are **relative**, which is what makes the `/geants-300/` sub-path work. Do not switch them to absolute `/...` paths — that breaks Pages (it would resolve to the domain root).
- Leaflet is loaded from unpkg with SRI hashes, so the map needs network on first load. If offline use in the mountains matters, vendor Leaflet into the repo instead.
- `.gitignore` covers `.idea/`, `*.bak`, `.DS_Store`.

## Application logic (`app.js`)

The app derives everything from `ROUTE.track` at load time — there is no persistence beyond in-memory state and whatever the pause UI stores.

1. **Pace model** (`speedForGradient(g)`): converts a gradient percentage to a speed in km/h using a piecewise function — 35 km/h descents (≤ -2%), 25 km/h flat (< 2%), linear interpolation 25→12 km/h between 2–5%, 12→8 km/h between 5–9.5%, and an extrapolated floor of 3 km/h beyond 9.5%.
2. **Per-segment derivation**: walks consecutive track points to compute distance, elevation delta, gradient, speed, and time for each segment, then builds cumulative arrays (`cumDplusArr`, `cumDminusArr`, `cumTimeArr`) plus totals (`totalDplus`, `totalDminus`, `totalMovingSec`, `totalKm`).
3. **Lookup helpers**: `kmToIndex` (binary search), `movingSecAtKm`, `dplusAtKm`, `eleAtKm` — used to answer "at km X, what's the elapsed time / elevation gain / elevation?" for any point on the route.
4. **Pauses**: user-added and suggested stops (`buildSuggestions()` flags major cols above `MAJOR_ELE` and other POIs) are folded into the moving-time model to produce estimated elapsed/arrival times.
5. **Rendering**: an SVG elevation profile (with gradient-colored segments matching the legend: flat/moderate climb/steep climb/descent), a schematic route/map panel, a splits table, and header stat tiles (distance, D+, start/finish/total time) — all built via DOM/SVG element construction in JS, no templating library.

Any change to the pace model, gradient thresholds, or POI/col detection logic should be made directly in `app.js`; there are no separate modules to update.
