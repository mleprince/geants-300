# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository overview

This repo contains a single self-contained pace-planning tool for "Les Géants 300", an ultra-distance cycling event. There is no build system, package manager, or test suite — the entire app is one static HTML file.

- `geants-300-app.html` — the app: inline `<style>`, embedded fonts (base64 `data:font/ttf` URIs), an embedded `ROUTE` track (array of `{km, lat, lon, ele}` points, currently sampled every 0.1 km) inside a `<script>` tag, and the application logic in a second `<script>` (an IIFE).
- `geants-2026.gpx` — the raw GPX source (COROS export) that the `ROUTE.track` data in the HTML was derived from. There is no script in this repo that performs the GPX → `ROUTE` conversion; if regenerating the embedded track, resample the GPX trkpts to a `{km, lat, lon, ele}` array (~0.1 km spacing) and paste it into the `ROUTE.track` literal in the HTML.

## Working with the HTML file

The file is large (~1600 lines but with several very long lines — embedded font base64 blobs and the `ROUTE` JSON are each single lines with hundreds of KB). Do not try to `Read` the whole file at once; it exceeds tool token limits. Instead:
- Use `grep -n` to locate line numbers for the section you need (CSS block, `ROUTE` literal, or the logic IIFE), then `Read` with `offset`/`limit` around those lines.
- The CSS lives at the top inside `<style>...</style>` (includes the `@font-face` base64 blobs — skip over these when reading).
- The `ROUTE` data is a single `<script>` tag containing one JS statement (`const ROUTE = {...}`).
- The application logic is the following `<script>` tag, wrapped in `(function(){ "use strict"; ... })();`.

## Application logic (in the second `<script>`)

The app derives everything from `ROUTE.track` at load time — there is no persistence beyond in-memory state and whatever the pause UI stores.

1. **Pace model** (`speedForGradient(g)`): converts a gradient percentage to a speed in km/h using a piecewise function — 35 km/h descents (≤ -2%), 25 km/h flat (< 2%), linear interpolation 25→12 km/h between 2–5%, 12→8 km/h between 5–9.5%, and an extrapolated floor of 3 km/h beyond 9.5%.
2. **Per-segment derivation**: walks consecutive track points to compute distance, elevation delta, gradient, speed, and time for each segment, then builds cumulative arrays (`cumDplusArr`, `cumDminusArr`, `cumTimeArr`) plus totals (`totalDplus`, `totalDminus`, `totalMovingSec`, `totalKm`).
3. **Lookup helpers**: `kmToIndex` (binary search), `movingSecAtKm`, `dplusAtKm`, `eleAtKm` — used to answer "at km X, what's the elapsed time / elevation gain / elevation?" for any point on the route.
4. **Pauses**: user-added and suggested stops (`buildSuggestions()` flags major cols above `MAJOR_ELE` and other POIs) are folded into the moving-time model to produce estimated elapsed/arrival times.
5. **Rendering**: an SVG elevation profile (with gradient-colored segments matching the legend: flat/moderate climb/steep climb/descent), a schematic route/map panel, a splits table, and header stat tiles (distance, D+, start/finish/total time) — all built via DOM/SVG element construction in JS, no templating library.

Any change to the pace model, gradient thresholds, or POI/col detection logic should be made directly in this IIFE; there are no separate modules to update.
