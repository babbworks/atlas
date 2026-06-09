# Industrial Atlas UK

A focused web-based discovery tool for workshops, manufacturing, industrial buildings, and productive urban spaces across the United Kingdom. Built on OpenStreetMap data via the Overpass API.

---

## Overview

Most mapping tools are designed for navigation, retail, and tourism. Industrial Atlas UK is designed for:

- Finding workshop clusters
- Identifying active manufacturing districts
- Locating industrial buildings embedded in residential areas
- Discovering railway arch businesses and maker spaces
- Researching productive land use

Primary audiences: manufacturing entrepreneurs, urban researchers, economic development organisations, property developers, makers, local authority planners.

---

## Running Locally

No build step required. Open `index.html` directly in a browser, or serve from any static file server:

```bash
# Python
python3 -m http.server 8000

# Node
npx serve .

# Or open index.html directly in Firefox/Chrome
```

---

## Deployment

Deployable to any static host. No backend, no database, no authentication required.

**GitHub Pages**
```bash
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/yourname/industrial-atlas-uk.git
git push -u origin main
# Enable Pages in repo Settings → Pages → Deploy from branch: main
```

**Netlify / Cloudflare Pages**  
Connect your repository and set build command to blank (static site). Publish directory: `/` (root).

---

## File Structure

```
index.html    — Layout, HTML structure, CDN script/style links
styles.css    — All styling (IBM Plex Sans, three-column layout, panels)
overpass.js   — Overpass API query builder, executor, session cache
map.js        — Leaflet map, inset navigator, region overlay, feature rendering
app.js        — Application state, UI events, URL sharing, geocoding
README.md     — This file
```

---

## Architecture

```
app.js (orchestrator)
  │
  ├── map.js (MapModule)
  │     ├── Leaflet main map
  │     ├── Leaflet inset navigator (second map instance)
  │     ├── UK region overlay (clickable rectangles, visible at zoom < 9)
  │     ├── MarkerClusterGroup (all point features)
  │     ├── Polygon layer (landuse, building footprints)
  │     └── Leaflet.draw (area analysis rectangles)
  │
  └── overpass.js (Overpass module)
        ├── Filter map (UI filter → OSM tag queries)
        ├── Query builder (generates Overpass QL)
        ├── Fetch executor (POST to overpass-api.de)
        └── Session cache (15 min TTL, key = filters + bbox)
```

**Navigation flow**
1. Map opens at UK level (zoom 6) with named region overlay
2. User clicks a region (main map or inset navigator) → zooms in
3. At zoom ≥ 10, Run Query becomes active
4. Overpass query executes for current map bounds
5. Results render as clustered markers + polygon fills
6. Click any feature → right panel shows OSM tags, coordinates, external links

**URL sharing**  
All state (position, zoom, active filters, mode) encodes into the URL hash:
```
#v=52.4865,-1.9082,15&f=workshops,craft_any&m=workshop-explorer
```

---

## Overpass API Usage

Queries are sent to `https://overpass-api.de/api/interpreter` with a 30-second timeout and a 1,000-element result cap. Results are cached in memory for 15 minutes per bbox+filter combination.

To reduce load on the public instance, consider self-hosting Overpass API and updating `ENDPOINT` in `overpass.js`.

---

## Extending

**Add a new filter type**  
In `overpass.js`, add an entry to `FILTER_MAP` with one or more `{t, k, v}` matchers. Add a corresponding checkbox to `index.html`.

**Add a new geographic preset**  
In `map.js`, add an entry to `GEO_PRESETS` with `{ll: [lat, lng], z: zoom}`. Add a button to `index.html` with `data-preset="your-id"`.

**Add a data layer (future)**  
Add a new Leaflet layer group in `map.js` and populate it from a GeoJSON file or API response in `app.js`.

---

## Planned / Future

- Historic map overlays (National Library of Scotland tiles)
- Industrial density heatmap
- Companies House SIC code layer (manufacturing companies)
- VOA industrial premises data
- Employment land / planning allocation polygons
- Self-hosted Overpass API support
- Export results as GeoJSON / CSV

---

## Attribution

Map data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright), Open Database Licence (ODbL).  
Overpass API by Roland Olbricht.  
Satellite imagery © Esri.  
Base tiles © CartoDB (inset navigator).
