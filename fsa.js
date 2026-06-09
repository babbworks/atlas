'use strict';

/* fsa.js — FSA Food Industry establishments overlay
   Lazy-loads data/fsa_food_industry.json.
   10,597 manufacturers, distributors and importers with coordinates. */

const FSALayer = (() => {

  const TYPE_COLORS = {
    'Manufacturer/Packer':     '#b85000',
    'Distributor/Transporter': '#4a7c00',
    'Importer/Exporter':       '#005a9c',
  };

  let _data    = null;
  let _loading = null;
  let _group   = null;

  async function _load() {
    if (_data)    return _data;
    if (_loading) return _loading;
    _loading = fetch('data/fsa_food_industry.json')
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(d => { _data = d; _loading = null; return d; })
      .catch(err => { console.warn('[FSA]', err.message); _loading = null; return []; });
    return _loading;
  }

  function _icon(type) {
    const color = TYPE_COLORS[type] || '#666';
    return L.divIcon({
      className: '',
      html: `<div style="width:9px;height:9px;border-radius:50%;background:${color};border:1.5px solid rgba(255,255,255,0.9);box-shadow:0 1px 3px rgba(0,0,0,.45)"></div>`,
      iconSize:   [9, 9],
      iconAnchor: [4, 4],
    });
  }

  function _clusterIcon(n, color) {
    const sz = n > 99 ? 36 : 30;
    return L.divIcon({
      className: '',
      html: `<div style="background:${color};color:#fff;border-radius:50%;width:${sz}px;height:${sz}px;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:600;border:2px solid rgba(255,255,255,0.9);box-shadow:0 1px 3px rgba(0,0,0,.4)">${n}</div>`,
      iconSize:   [sz, sz],
      iconAnchor: [sz / 2, sz / 2],
    });
  }

  function _popup(item) {
    const color  = TYPE_COLORS[item.type] || '#666';
    const rating = item.rating ? `<br><span style="font-size:11px">Hygiene rating: <strong>${item.rating}</strong></span>` : '';
    return (
      `<strong>${item.name || '(unnamed)'}</strong>` +
      `<br><span style="color:${color};font-size:11px;font-weight:600">${item.type}</span>` +
      (item.postcode  ? `<br><span style="font-size:11px">${item.postcode}</span>` : '') +
      (item.authority ? `<br><span style="font-size:11px;color:#888">${item.authority}</span>` : '') +
      rating +
      `<br><span style="font-size:10px;color:#aaa">FSA Food Business Register</span>`
    );
  }

  async function show(map) {
    const data = await _load();
    if (!data.length) return 0;

    if (_group) { map.removeLayer(_group); _group = null; }

    _group = L.markerClusterGroup({
      maxClusterRadius: 45,
      iconCreateFunction: cluster => _clusterIcon(cluster.getChildCount(), '#b85000'),
      chunkedLoading: true,
    });

    for (const item of data) {
      const m = L.marker([item.lat, item.lng], { icon: _icon(item.type) });
      m.bindPopup(_popup(item), { maxWidth: 280 });
      m.bindTooltip(item.name || item.type, { sticky: true, direction: 'top' });
      _group.addLayer(m);
    }

    _group.addTo(map);
    return data.length;
  }

  function hide(map) {
    if (_group) { map.removeLayer(_group); _group = null; }
  }

  return { show, hide, TYPE_COLORS };
})();
