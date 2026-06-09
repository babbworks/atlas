'use strict';

/* strategy_zones.js — UK Industrial Strategy Zones, Freeports, and Investment Zones
   Loads data/strategy_zones.geojson (hand-curated, UK government sources).
   Renders as a Leaflet overlay; features are labelled by type. */

const StrategyZones = (() => {

  let _data    = null;
  let _loading = null;
  let _failed  = false;

  const TYPE_STYLES = {
    'industrial-strategy-zone': { color: '#c07000', fill: 'rgba(220,140,0,0.08)',  label: 'Industrial Strategy Zone' },
    'freeport':                  { color: '#8b2d8b', fill: 'rgba(160,0,160,0.08)', label: 'Freeport'                  },
    'investment-zone':           { color: '#005a9c', fill: 'rgba(0,80,180,0.08)',  label: 'Investment Zone'           },
  };

  async function _load() {
    if (_data)    return _data;
    if (_failed)  return null;
    if (_loading) return _loading;

    _loading = fetch('data/strategy_zones.geojson')
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(d => { _data = d; _loading = null; return d; })
      .catch(err => {
        console.warn('[StrategyZones]', err.message);
        _failed = true; _loading = null; return null;
      });

    return _loading;
  }

  /* Add strategy zone polygons to a Leaflet map.
     Returns the Leaflet featureGroup added, or null. */
  async function addToMap(map) {
    const data = await _load();
    if (!data) return null;

    const group = L.featureGroup();

    for (const feature of data.features) {
      const props = feature.properties || {};
      const type  = props.type || 'industrial-strategy-zone';
      const style = TYPE_STYLES[type] || TYPE_STYLES['industrial-strategy-zone'];
      const name  = props.name || style.label;

      try {
        const layer = L.geoJSON(feature, {
          style: {
            color:       style.color,
            weight:      2,
            fillColor:   style.color,
            fillOpacity: 0.07,
            dashArray:   '8,5',
          },
        });

        layer.bindTooltip(`${style.label}: ${name}`, { sticky: true, direction: 'top' });
        layer.bindPopup(
          `<strong>${name}</strong><br>` +
          `<span style="color:${style.color};font-weight:600">${style.label}</span><br>` +
          (props.focus ? `<span style="font-size:11px;color:#666">${props.focus}</span>` : ''),
          { maxWidth: 260 }
        );

        group.addLayer(layer);
      } catch (_) { /* skip malformed features */ }
    }

    group.addTo(map);
    return group;
  }

  function getTypeStyles() { return TYPE_STYLES; }

  return { addToMap, getTypeStyles };
})();
