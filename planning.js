'use strict';

/* planning.js — planning.data.gov.uk API integration
   Fetches official designations (listed buildings, brownfield land,
   conservation areas, Article 4 directions) by bounding box.
   England coverage only — Scotland/Wales have separate registers. */

const PlanningData = (() => {

  const BASE      = 'https://www.planning.data.gov.uk';
  const LIMIT     = 500;
  const CACHE_TTL = 15 * 60 * 1000;
  const _cache    = new Map();

  const LAYER_DEFS = {
    'listed-building': {
      label:      'Listed Buildings',
      type:       'point',
      color:      '#c8960c',
      markerBase: '#c8960c',
    },
    'brownfield-land': {
      label:    'Brownfield Land',
      type:     'polygon',
      color:    '#8B2500',
      fill:     'rgba(180,60,20,0.12)',
    },
    'conservation-area': {
      label:    'Conservation Areas',
      type:     'polygon',
      color:    '#1a6b3c',
      fill:     'rgba(40,160,90,0.07)',
    },
    'article-4-direction-area': {
      label:    'Article 4 Directions',
      type:     'polygon',
      color:    '#5b2d8e',
      fill:     'rgba(100,0,180,0.07)',
    },
    'tree-preservation-order': {
      label:    'Tree Preservation Orders',
      type:     'polygon',
      color:    '#2d6e2d',
      fill:     'rgba(20,120,20,0.08)',
    },
    'scheduled-monument': {
      label:    'Scheduled Monuments',
      type:     'point',
      color:    '#7a3010',
      markerBase: '#7a3010',
    },
    'flood-risk-zone': {
      label:    'Flood Risk Zones',
      type:     'polygon',
      color:    '#1a6096',
      fill:     'rgba(20,100,180,0.12)',
      /* level-aware styling applied in map.js */
      levelColors: { '2': '#4a90c8', '3': '#1a3a8c' },
    },
  };

  /* ---- WKT parsing ----------------------------------------- */

  function _parsePoint(str) {
    if (!str) return null;
    const m = str.match(/POINT\s*\(\s*([-\d.]+)\s+([-\d.]+)\s*\)/i);
    return m ? { lat: parseFloat(m[2]), lng: parseFloat(m[1]) } : null;
  }

  /* Returns array of rings [[lat,lng],...] from any WKT polygon/multipolygon */
  function _extractRings(wkt) {
    if (!wkt) return [];
    const rings = [];
    const re = /\(([^()]+)\)/g;
    let m;
    while ((m = re.exec(wkt)) !== null) {
      const coords = m[1].trim().split(',').map(pair => {
        const parts = pair.trim().split(/\s+/);
        const lng = parseFloat(parts[0]);
        const lat = parseFloat(parts[1]);
        return (!isNaN(lat) && !isNaN(lng)) ? [lat, lng] : null;
      }).filter(Boolean);
      if (coords.length >= 3) rings.push(coords);
    }
    return rings;
  }

  function _parseGeom(entity) {
    const g = (entity.geometry || '').trim();
    const p = (entity.point    || '').trim();
    if (g) {
      const upper = g.toUpperCase();
      if (upper.startsWith('POLYGON') || upper.startsWith('MULTIPOLYGON')) {
        const rings = _extractRings(g);
        return rings.length ? { type: 'polygon', rings } : null;
      }
      if (upper.startsWith('POINT')) {
        const pt = _parsePoint(g);
        return pt ? { type: 'point', ...pt } : null;
      }
    }
    if (p) {
      const pt = _parsePoint(p);
      return pt ? { type: 'point', ...pt } : null;
    }
    return null;
  }

  /* ---- Point-in-polygon (ray casting) ----------------------- */

  function _pip(lat, lng, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [yi, xi] = ring[i], [yj, xj] = ring[j];
      if (((yi > lat) !== (yj > lat)) &&
          (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi)) {
        inside = !inside;
      }
    }
    return inside;
  }

  /* ---- Cache helpers ---------------------------------------- */

  function _key(datasets, bbox) {
    return datasets.slice().sort().join(',') + '|' + bbox;
  }

  function _evict() {
    const now = Date.now();
    for (const [k, v] of _cache) {
      if (now - v.ts > CACHE_TTL) _cache.delete(k);
    }
  }

  /* ---- Public: query ---------------------------------------- */

  async function query(activeDatasets, leafletBounds) {
    if (!activeDatasets || !activeDatasets.length) return null;

    _evict();

    const bbox = [
      leafletBounds.getWest().toFixed(5),
      leafletBounds.getSouth().toFixed(5),
      leafletBounds.getEast().toFixed(5),
      leafletBounds.getNorth().toFixed(5),
    ].join(',');

    const key = _key(activeDatasets, bbox);
    const hit = _cache.get(key);
    if (hit) return { ...hit.data, fromCache: true };

    const dsQ  = activeDatasets.map(d => `dataset=${encodeURIComponent(d)}`).join('&');
    const url  = `${BASE}/entity.json?${dsQ}&bbox=${bbox}&limit=${LIMIT}&geometry_relation=intersects`;

    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Planning API HTTP ${resp.status}`);

    const json     = await resp.json();
    const entities = json.entities || [];

    /* Group parsed features by dataset */
    const byDataset = {};
    for (const ds of activeDatasets) byDataset[ds] = [];

    for (const e of entities) {
      const ds = e.dataset;
      if (!byDataset[ds]) continue;
      const geom = _parseGeom(e);
      if (!geom) continue;

      byDataset[ds].push({
        id:         e.entity,
        name:       e.name || '',
        grade:      e['listed-building-grade'] || null,
        floodLevel: e['flood-risk-level'] || null,
        floodType:  e['flood-risk-type'] || null,
        reference:  e.reference || null,
        docUrl:     e['documentation-url'] || null,
        startDate:  e['start-date'] || null,
        dataset:    ds,
        geom,
      });
    }

    const data = {
      byDataset,
      totalCount: entities.length,
      truncated:  entities.length >= LIMIT,
    };

    _cache.set(key, { data, ts: Date.now() });
    if (_cache.size > 40) {
      const oldest = [..._cache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
      _cache.delete(oldest[0]);
    }

    return data;
  }

  /* ---- Public: find designations near a point --------------- */
  /* Used by scoring to enrich feature detail view.             */

  function nearbyDesignations(lat, lng, planningResult) {
    if (!planningResult || !planningResult.byDataset) return [];
    const found = [];

    for (const [ds, features] of Object.entries(planningResult.byDataset)) {
      for (const f of features) {
        const g = f.geom;
        if (g.type === 'point') {
          /* Within ~80 m */
          const dlat = (g.lat - lat) * 111320;
          const dlng = (g.lng - lng) * 111320 * Math.cos(lat * Math.PI / 180);
          if (Math.sqrt(dlat * dlat + dlng * dlng) < 80) {
            found.push({ dataset: ds, feature: f });
          }
        } else if (g.type === 'polygon') {
          /* Check against all rings — sufficient for outer-ring containment */
          if (g.rings.some(ring => _pip(lat, lng, ring))) {
            found.push({ dataset: ds, feature: f });
          }
        }
      }
    }

    return found;
  }

  return { query, nearbyDesignations, LAYER_DEFS };
})();
