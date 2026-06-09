'use strict';

/* overpass.js — Overpass API query builder and executor */

const Overpass = (() => {
  const ENDPOINT     = 'https://overpass-api.de/api/interpreter';
  const TIMEOUT_SEC  = 30;
  const MAX_ELEMENTS = 1000;

  /* Session cache: key → { elements, truncated, ts } */
  const _cache = new Map();
  const CACHE_TTL = 15 * 60 * 1000;

  /* Maps UI filter value → array of Overpass element matchers.
     Each matcher: { t: element type, k: key, v: value (omit for any-value) } */
  const FILTER_MAP = {
    workshops: [
      { t: 'node', k: 'craft' },
      { t: 'way',  k: 'craft' },
      { t: 'node', k: 'shop',     v: 'workshop' },
      { t: 'way',  k: 'building', v: 'workshop' },
    ],
    manufacturing: [
      { t: 'node', k: 'industrial' },
      { t: 'way',  k: 'industrial' },
      { t: 'node', k: 'man_made', v: 'works' },
      { t: 'way',  k: 'man_made', v: 'works' },
    ],
    industrial_buildings: [
      { t: 'way',      k: 'building', v: 'industrial' },
      { t: 'relation', k: 'building', v: 'industrial' },
    ],
    warehouses: [
      { t: 'way',      k: 'building', v: 'warehouse' },
      { t: 'relation', k: 'building', v: 'warehouse' },
    ],
    maker_spaces: [
      { t: 'node', k: 'amenity', v: 'makerspace' },
      { t: 'way',  k: 'amenity', v: 'makerspace' },
      { t: 'node', k: 'leisure', v: 'hackerspace' },
      { t: 'way',  k: 'leisure', v: 'hackerspace' },
    ],
    railway_arches: [
      { t: 'way',  k: 'building',     v: 'arch' },
      { t: 'node', k: 'railway_arch', v: 'yes' },
    ],
    bldg_industrial: [
      { t: 'way', k: 'building', v: 'industrial' },
    ],
    bldg_warehouse: [
      { t: 'way', k: 'building', v: 'warehouse' },
    ],
    bldg_workshop: [
      { t: 'way', k: 'building', v: 'workshop' },
    ],
    craft_any: [
      { t: 'node', k: 'craft' },
      { t: 'way',  k: 'craft' },
    ],
    industrial_any: [
      { t: 'node', k: 'industrial' },
      { t: 'way',  k: 'industrial' },
    ],
    landuse_industrial: [
      { t: 'way',      k: 'landuse', v: 'industrial' },
      { t: 'relation', k: 'landuse', v: 'industrial' },
    ],
    landuse_commercial: [
      { t: 'way',      k: 'landuse', v: 'commercial' },
      { t: 'relation', k: 'landuse', v: 'commercial' },
    ],
    abandoned_any: [
      { t: 'node', k: 'abandoned', v: 'yes' },
      { t: 'way',  k: 'abandoned', v: 'yes' },
      { t: 'node', kregex: '^abandoned:' },
      { t: 'way',  kregex: '^abandoned:' },
    ],
    disused_any: [
      { t: 'node', k: 'disused', v: 'yes' },
      { t: 'way',  k: 'disused', v: 'yes' },
      { t: 'node', kregex: '^disused:' },
      { t: 'way',  kregex: '^disused:' },
    ],
    vacant: [
      { t: 'node', k: 'vacant', v: 'yes' },
      { t: 'way',  k: 'vacant', v: 'yes' },
    ],
  };

  function buildQuery(filters, bboxStr) {
    const lines = [];
    const seen  = new Set();

    for (const f of filters) {
      const matchers = FILTER_MAP[f];
      if (!matchers) continue;
      for (const m of matchers) {
        const tagExpr = m.kregex
        ? `[~"${m.kregex}"~".*"]`
        : m.v ? `["${m.k}"="${m.v}"]` : `["${m.k}"]`;
        const line = `  ${m.t}${tagExpr}(${bboxStr});`;
        if (!seen.has(line)) { seen.add(line); lines.push(line); }
      }
    }

    if (!lines.length) return null;

    return (
      `[out:json][timeout:${TIMEOUT_SEC}];\n` +
      `(\n${lines.join('\n')}\n);\n` +
      `out meta geom;`
    );
  }

  function _cacheKey(filters, bboxStr) {
    return filters.slice().sort().join(',') + '|' + bboxStr;
  }

  function _evictStale() {
    const now = Date.now();
    for (const [k, v] of _cache) {
      if (now - v.ts > CACHE_TTL) _cache.delete(k);
    }
  }

  async function query(filters, leafletBounds) {
    const bboxStr = [
      leafletBounds.getSouth().toFixed(5),
      leafletBounds.getWest().toFixed(5),
      leafletBounds.getNorth().toFixed(5),
      leafletBounds.getEast().toFixed(5),
    ].join(',');

    _evictStale();
    const key = _cacheKey(filters, bboxStr);
    const hit = _cache.get(key);
    if (hit) return { elements: hit.elements, truncated: hit.truncated, fromCache: true };

    const ql = buildQuery(filters, bboxStr);
    if (!ql) throw new Error('No filters active');

    const body = new URLSearchParams({ data: ql });
    const resp = await fetch(ENDPOINT, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });

    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      const detail = txt.match(/error[^<\n]*/i)?.[0] || `HTTP ${resp.status}`;
      throw new Error(detail.slice(0, 160));
    }

    const json = await resp.json();
    const all      = json.elements || [];
    const elements = all.slice(0, MAX_ELEMENTS);
    const truncated = all.length > MAX_ELEMENTS;

    _cache.set(key, { elements, truncated, ts: Date.now() });
    if (_cache.size > 60) {
      const oldest = [..._cache.entries()].sort((a,b) => a[1].ts - b[1].ts)[0];
      _cache.delete(oldest[0]);
    }

    return { elements, truncated, fromCache: false };
  }

  /* Classify an OSM element by its tags into a display type */
  function classify(tags) {
    if (!tags) return 'other';
    if (tags.amenity === 'makerspace' || tags.leisure === 'hackerspace') return 'maker_space';
    if (tags.landuse === 'industrial')   return 'industrial_land';
    if (tags.landuse === 'commercial')   return 'commercial_land';
    if (tags.building === 'industrial')  return 'industrial_building';
    if (tags.building === 'warehouse')   return 'warehouse';
    if (tags.building === 'arch')        return 'railway_arch';
    if (tags.building === 'workshop')    return 'workshop_building';
    if (tags.craft)                      return 'craft';
    if (tags.industrial || tags.man_made === 'works') return 'manufacturing';
    return 'other';
  }

  /* Best human-readable name for an element */
  function displayName(el) {
    const t = el.tags || {};
    return t.name || t['name:en'] || t.operator || t.brand || null;
  }

  /* Lifecycle status for a set of tags — returns 'abandoned'|'disused'|'vacant'|null */
  function lifecycleStatus(tags) {
    if (!tags) return null;
    const keys = Object.keys(tags);
    if (tags.abandoned === 'yes' || keys.some(k => k.startsWith('abandoned:'))) return 'abandoned';
    if (tags.disused   === 'yes' || keys.some(k => k.startsWith('disused:')))   return 'disused';
    if (tags.vacant    === 'yes')                                                return 'vacant';
    return null;
  }

  /* Centroid of a geometry array [{lat, lon}, ...] */
  function centroid(geometry) {
    if (!geometry || !geometry.length) return null;
    let lat = 0, lon = 0;
    for (const p of geometry) { lat += p.lat; lon += p.lon; }
    return { lat: lat / geometry.length, lon: lon / geometry.length };
  }

  return { query, buildQuery, classify, displayName, centroid, lifecycleStatus, FILTER_MAP };
})();
