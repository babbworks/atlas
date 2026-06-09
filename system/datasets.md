# UK Public Datasets — Integration Reference

Datasets confirmed available for overlay with OSM map data.
Goal: cross-reference business presence, property ownership, heritage status, and employment density against workshop/industrial/manufacturing features.

---

## 1. Companies House — Business Register

**What it gives us:** Company name, registered address, SIC industry code, incorporation date, active/dissolved status. Every registered UK company.

**How it helps:** Geocode registered addresses → find businesses co-located with industrial OSM features. SIC codes (Division C = Manufacturing, 41–43 = Construction) can filter to relevant trades. Can flag which OSM features have a registered company at that address.

**Access:**
- REST API (free, requires registration): https://developer.company-information.service.gov.uk/
- Bulk CSV snapshot (free, no auth): https://download.companieshouse.gov.uk/en_output.html
- Licence: OGL / free to reuse

**Caveats:** Registered address ≠ trading address. ~30% of companies register at accountant offices. Best used as a confirming signal, not a definitive location source. No phone/email in open data.

---

## 2. Historic England — National Heritage List for England (NHLE)

**What it gives us:** Coordinates and grades for every Listed Building (Grade I, II*, II), Scheduled Monument, Registered Park & Garden, and Protected Wreck in England. Includes industrial heritage — mills, warehouses, engine houses, viaducts, etc.

**How it helps:** Overlay listed status directly on OSM features. A listed industrial building has stronger protection and often higher interest to preservationists and creative reuse developers. Adds a `heritage` signal to the scoring system.

**Access:**
- Open Data Hub (GeoJSON, WFS, WMS): https://opendata-historicengland.hub.arcgis.com/
- API Catalogue entry: https://www.api.gov.uk/he/national-heritage-list-for-england-nhle/
- GIS Shapefiles: https://historicengland.org.uk/listing/the-list/data-downloads/
- Licence: OGL, updated daily

**Scotland equivalent:** Historic Environment Scotland — Canmore database + INSPIRE polygons via HES.

---

## 3. HM Land Registry — INSPIRE Index Polygons

**What it gives us:** Freehold property title boundaries for England & Wales as polygon geometries. Each polygon has a Land Registry–INSPIRE ID linking to the title register.

**How it helps:** Show exact title extents overlaid on the map — useful for understanding plot sizes and boundaries of industrial land. The INSPIRE ID can be used to cross-reference with other Land Registry products (some paid).

**Access:**
- Download service (GML by local authority): https://use-land-property-data.service.gov.uk/datasets/inspire
- data.gov.uk: https://www.data.gov.uk/dataset/811bcf4c-fbbf-4597-aa9c-3d5bd3bfd455
- Licence: OGL, updated monthly

**Caveats:** Shows title boundaries only — not ownership names (those are in the paid UK Companies in Scope / HMLR Commercial product). Leasehold titles not included. Scotland uses Registers of Scotland (separate dataset).

---

## 4. Planning Data — MHCLG (planning.data.gov.uk)

**What it gives us:** Planning application history, decisions, and designations by address/geometry across England. Includes change-of-use applications (e.g. industrial → residential) and new industrial/commercial permissions.

**How it helps:** Detect threatened industrial sites (permitted development / change of use away from industry) and newly approved sites. Change-of-use history is a strong signal for the opportunity score.

**Access:**
- REST API + dataset browser: https://www.planning.data.gov.uk/
- Dataset-specific: https://www.planning.data.gov.uk/dataset/planning-application
- Licence: OGL

**Caveats:** LPA coverage is still incomplete — not all local planning authorities submit data. Best for London and larger urban authorities. Third-party aggregators (Searchland, PlanWire, LandHawk) have fuller coverage but are paid.

---

## 5. VOA — Non-Domestic Rating (Business Rates)

**What it gives us:** Rateable value, primary description (SHOP, FACTORY, WAREHOUSE, WORKSHOP, etc.), floor area in m², address, and billing authority for every non-domestic property in England & Wales assessed for business rates (~2 million entries).

**How it helps:** The VOA `Primary Description` field is a clean, government-confirmed classification of every commercial premises. Cross-referencing with OSM lets us validate or enrich feature type. Floor area data improves the size signal in scoring.

**Access:**
- Statistics and bulk data: https://www.gov.uk/government/organisations/valuation-office-agency/about/statistics
- London Datastore extract: https://data.london.gov.uk/publisher/voa/
- data.gov.uk: https://www.data.gov.uk/dataset/2712bc66-855b-478d-bada-a9cf71ed395c
- Licence: OGL

**Caveats:** Addresses need geocoding. Properties that are empty and have had rates relief removed may not appear. Scotland is rated separately via Scottish Assessors Association.

---

## 6. ONS BRES — Business Register and Employment Survey

**What it gives us:** Employee counts by SIC industry code at local authority / ward / LSOA geography. Annual survey, ~87,000 business sample weighted to represent the full economy.

**How it helps:** Area-level manufacturing employment density. Can drive choropleth overlays or region scoring — areas with high manufacturing employment (SIC Division C) but few OSM-mapped features suggest under-mapping. Also useful for contextualising results panels.

**Access:**
- Nomis (ONS official query tool): https://www.nomisweb.co.uk/ — open access, no login required for rounded estimates
- ONS dataset page: https://www.ons.gov.uk/employmentandlabourmarket/peopleinwork/employmentandemployeetypes/methodologies/businessregisterandemploymentsurveybresqmi
- Licence: OGL

**Caveats:** Ward/LSOA-level data is rounded for disclosure control. Not site-specific — useful for area context only.

---

## Summary Table

| Dataset | Granularity | Spatial? | Auth needed | Format | Scotland? |
|---------|-------------|----------|-------------|--------|-----------|
| Companies House | Address / company | Geocode required | Free API key | CSV / JSON | Yes |
| Historic England NHLE | Point / polygon | Yes (GeoJSON) | None | GeoJSON / WFS | No (HES) |
| HMLR INSPIRE Polygons | Title boundary | Yes (GML) | None | GML | No (RoS) |
| Planning Data | Address / polygon | Yes | None | JSON REST | No |
| VOA Business Rates | Address | Geocode required | None | CSV | No (SAA) |
| ONS BRES | LA / ward / LSOA | Aggregated | None | CSV | Yes |

---

## Integration Priority

**Phase 1 — Low effort, high value:**
- Historic England NHLE overlay (GeoJSON direct to Leaflet, no auth)
- VOA description field enrichment (bulk CSV → lookup table by address)

**Phase 2 — Medium effort:**
- Companies House address matching (geocode registered addresses, join to map features)
- Planning Data change-of-use alerts (REST API call per bounding box)

**Phase 3 — Heavier lift:**
- HMLR INSPIRE polygons as a property boundary layer
- BRES employment choropleth for region context panel
