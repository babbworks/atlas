'use strict';

/* epr.js — EA Environmental Permitting Regulations Industrial Sites overlay
   Lazy-loads data/epr_permits.json once available.
   Each record: {id, name, operator, lat, lng, activity, sector, status} */

const EPRLayer = (() => {

  const SECTOR_COLORS = {
    'Food & Drink Processing':  '#c07000',
    'Metal Production':         '#4a5a6a',
    'Minerals & Ceramics':      '#8a6a30',
    'Chemical / Pharmaceutical':'#8b2d8b',
    'Waste Management':         '#5a5a00',
    'Energy Production':        '#c04000',
    'Textiles':                 '#2d6a6a',
    'Paper & Pulp':             '#5a7a40',
    'Rubber & Plastics':        '#006a60',
    'Surface Treatment':        '#6a3060',
    'Intensive Livestock':      '#7a5020',
    'Slaughterhouse':           '#8a2020',
    'Rendering':                '#6a4020',
    'Tannery':                  '#6a4820',
    'Cement / Lime':            '#808060',
    'Glass':                    '#406080',
    'Printing':                 '#203060',
    'Industrial':               '#505060',
  };

  let _data    = null;
  let _loading = null;
  let _group   = null;
  let _missing = false;

  async function _load() {
    if (_missing) return [];
    if (_data)    return _data;
    if (_loading) return _loading;
    _loading = fetch('data/epr_permits.json')
      .then(r => {
        if (r.status === 404) { _missing = true; throw new Error('EPR data not yet generated — run scripts/process_epr.py'); }
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(d => { _data = d; _loading = null; return d; })
      .catch(err => { console.warn('[EPR]', err.message); _loading = null; return []; });
    return _loading;
  }

  function _icon(sector, status) {
    const color  = SECTOR_COLORS[sector] || '#505060';
    const active = status !== 'surrendered' && status !== 'revoked' && status !== 'refused';
    const opacity = active ? '1' : '0.45';
    return L.divIcon({
      className: '',
      html: `<div style="width:9px;height:9px;border-radius:2px;background:${color};border:1.5px solid rgba(255,255,255,0.9);box-shadow:0 1px 3px rgba(0,0,0,.45);opacity:${opacity}"></div>`,
      iconSize:   [9, 9],
      iconAnchor: [4, 4],
    });
  }

  function _clusterIcon(n) {
    const sz = n > 99 ? 36 : 30;
    return L.divIcon({
      className: '',
      html: `<div style="background:#505060;color:#fff;border-radius:3px;width:${sz}px;height:${sz}px;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:600;border:2px solid rgba(255,255,255,0.9);box-shadow:0 1px 3px rgba(0,0,0,.4)">${n}</div>`,
      iconSize:   [sz, sz],
      iconAnchor: [sz / 2, sz / 2],
    });
  }

  function _popup(item) {
    const color  = SECTOR_COLORS[item.sector] || '#505060';
    const active = item.status !== 'surrendered' && item.status !== 'revoked';
    const statusHtml = active
      ? `<span style="color:#2d6a4f;font-size:10px">● active permit</span>`
      : `<span style="color:#888;font-size:10px">● ${item.status}</span>`;
    return (
      `<strong>${item.name || '(unnamed site)'}</strong>` +
      `<br><span style="color:${color};font-size:11px;font-weight:600">${item.sector}</span>` +
      (item.operator ? `<br><span style="font-size:11px">${item.operator}</span>` : '') +
      (item.id       ? `<br><span style="font-size:10px;color:#888">Permit: ${item.id}</span>` : '') +
      (item.activity ? `<br><span style="font-size:10px;color:#666">${item.activity.slice(0, 120)}${item.activity.length > 120 ? '…' : ''}</span>` : '') +
      `<br>${statusHtml}` +
      `<br><span style="font-size:10px;color:#aaa">EA Environmental Permit Register</span>`
    );
  }

  async function show(map) {
    const data = await _load();
    if (!data.length) return 0;

    if (_group) { map.removeLayer(_group); _group = null; }

    _group = L.markerClusterGroup({
      maxClusterRadius: 50,
      iconCreateFunction: cluster => _clusterIcon(cluster.getChildCount()),
      chunkedLoading: true,
    });

    for (const item of data) {
      const m = L.marker([item.lat, item.lng], { icon: _icon(item.sector, item.status) });
      m.bindPopup(_popup(item), { maxWidth: 300 });
      m.bindTooltip(item.name || item.sector, { sticky: true, direction: 'top' });
      _group.addLayer(m);
    }

    _group.addTo(map);
    return data.length;
  }

  function hide(map) {
    if (_group) { map.removeLayer(_group); _group = null; }
  }

  return { show, hide, SECTOR_COLORS };
})();
