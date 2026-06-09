# Industrial Atlas UK — Project Notes

## What this is

A browser-based map tool for discovering workshops, manufacturing sites, industrial buildings, and productive urban spaces across the UK. Data sourced from OpenStreetMap via the Overpass API, rendered with Leaflet.

## Current stack

- Pure frontend: HTML + CSS + JS (no build step, no framework)
- Leaflet 1.9.4 + MarkerCluster + Leaflet.Draw
- Overpass API for OSM queries
- Nominatim for address geocoding (search bar)
- No backend, no database, no auth

## What works now

- Filter/query system with 13 filter types across building, land use, craft, and lifecycle categories
- Opportunity scoring system (`scoring.js`) with spatial context signals
- Area draw-and-analyse tool
- Shareable URL state via hash
- Postcard export (PNG via html2canvas)
- Mobile layout with FAB toggles
- Quick Areas presets for key UK industrial districts

## Key design decisions

- Serve from a local HTTP server — `file://` protocol blocks tile requests and Overpass CORS
- Overpass queries are bounding-box scoped; minimum zoom 10 enforced to prevent huge queries
- Results capped at 1,000 elements per query, list display capped at 300 with a prompt to zoom in
- Session cache (15 min TTL, max 60 entries) to avoid redundant Overpass calls
- Scoring is purely OSM-tag-based — no external API calls in scoring

## Known limitations / to explore

- OSM coverage of industrial features is patchy outside London, Birmingham, Sheffield, Manchester
- No ownership or tenancy data — OSM rarely captures this
- No change-of-use history visible in the UI
- Satellite layer (Esri World Imagery) may 403 in some environments
- No Scotland-specific data sources integrated yet

## Next directions (see datasets.md for source details)

1. Overlay Historic England listed buildings — adds heritage signal, no auth needed
2. VOA business rates description enrichment — confirms/classifies property type
3. Companies House address matching — shows registered businesses at or near features
4. Planning data change-of-use detection — flags threatened industrial land
5. BRES employment choropleth — area-level manufacturing context
