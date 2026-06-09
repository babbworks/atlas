'use strict';

/* map.js — Leaflet map, inset navigator, region overlay, feature rendering */

const MapModule = (() => {

  /* ---- Constants ------------------------------------------- */
  const UK_CENTER    = [54.3, -2.8];
  const UK_ZOOM      = 6;
  const UK_MIN_ZOOM  = 5;
  const UK_MAX_ZOOM  = 19;
  const RUN_MIN_ZOOM = 10;

  const UK_BOUNDS = L.latLngBounds([49.5, -9.0], [61.2, 2.2]);

  const UK_REGIONS = [
    { id: 'highlands',          name: 'Highlands & Islands', short: 'Highlands',
      bounds: [[56.9,-7.8],[60.9,-1.5]],  c: [58.5,-4.8] },
    { id: 'scotland-central',   name: 'Central Scotland',    short: 'C. Scotland',
      bounds: [[55.3,-5.2],[57.0,-1.5]],  c: [56.1,-3.8] },
    { id: 'northern-ireland',   name: 'Northern Ireland',    short: 'N. Ireland',
      bounds: [[53.9,-8.2],[55.3,-5.4]],  c: [54.6,-6.7] },
    { id: 'north-east',         name: 'North East England',  short: 'North East',
      bounds: [[54.4,-2.6],[55.8,-0.8]],  c: [54.9,-1.6] },
    { id: 'north-west',         name: 'North West England',  short: 'North West',
      bounds: [[53.2,-3.5],[54.8,-1.9]],  c: [53.8,-2.6] },
    { id: 'yorkshire',          name: 'Yorkshire & Humber',  short: 'Yorkshire',
      bounds: [[53.3,-2.1],[54.6, 0.2]],  c: [53.9,-1.2] },
    { id: 'wales',              name: 'Wales',               short: 'Wales',
      bounds: [[51.3,-5.3],[53.4,-2.6]],  c: [52.3,-3.8] },
    { id: 'west-midlands',      name: 'West Midlands',       short: 'W. Midlands',
      bounds: [[51.9,-3.2],[53.2,-1.4]],  c: [52.5,-2.1] },
    { id: 'east-midlands',      name: 'East Midlands',       short: 'E. Midlands',
      bounds: [[52.1,-1.5],[53.5, 0.9]],  c: [52.8,-0.5] },
    { id: 'east-england',       name: 'East of England',     short: 'East England',
      bounds: [[51.4, 0.0],[52.9, 1.8]],  c: [52.1, 0.8] },
    { id: 'london',             name: 'London',              short: 'London',
      bounds: [[51.25,-0.6],[51.75,0.35]],c: [51.5,-0.1] },
    { id: 'south-east',         name: 'South East England',  short: 'South East',
      bounds: [[50.6,-1.9],[51.8, 1.8]],  c: [51.1, 0.3] },
    { id: 'south-west',         name: 'South West England',  short: 'South West',
      bounds: [[49.9,-5.8],[51.7,-1.5]],  c: [50.9,-3.6] },
  ];

  const GEO_PRESETS = {
    'jewellery-quarter':  { ll: [52.4865,-1.9082], z: 15 },
    'kelham-island':      { ll: [53.3892,-1.4773], z: 15 },
    'hackney-wick':       { ll: [51.5444,-0.0238], z: 15 },
    'fish-island':        { ll: [51.5400,-0.0132], z: 15 },
    'ancoats':            { ll: [53.4843,-2.2190], z: 15 },
    'digbeth':            { ll: [52.4720,-1.8858], z: 15 },
    'holbeck':            { ll: [53.7930,-1.5490], z: 15 },
    'leicester-textiles': { ll: [52.6380,-1.1280], z: 14 },
  };

  const FEATURE_STYLES = {
    craft:              { color: '#b35c00', label: 'Workshop / Craft',    abbr: 'W'  },
    workshop_building:  { color: '#b35c00', label: 'Workshop Building',   abbr: 'W'  },
    manufacturing:      { color: '#1a3a5c', label: 'Manufacturing',       abbr: 'M'  },
    industrial_building:{ color: '#2c2c2c', label: 'Industrial Building', abbr: 'IB' },
    warehouse:          { color: '#5c5c5c', label: 'Warehouse',           abbr: 'WH' },
    maker_space:        { color: '#2d6a4f', label: 'Maker Space',         abbr: 'MK' },
    railway_arch:       { color: '#4a4a8a', label: 'Railway Arch',        abbr: 'RA' },
    industrial_land:    { color: '#7a5c2e', fill: 'rgba(180,140,80,0.25)',  label: 'Industrial Land'  },
    commercial_land:    { color: '#4a6a4f', fill: 'rgba(90,160,90,0.20)',   label: 'Commercial Land'  },
    other:              { color: '#888',    label: 'Other',               abbr: '?'  },
  };

  /* ---- Private state --------------------------------------- */
  let _map, _insetMap, _viewportRect;
  let _baseLayers      = {};
  let _clusterGroup    = null;
  let _polygonLayer    = null;
  let _planningGroup   = null;
  let _voaGapGroup     = null;
  let _drawnItems      = null;
  let _drawControl     = null;
  let _regionRects     = {};
  let _regionLabels    = {};
  let _insetRects      = {};
  let _allElements     = [];
  let _callbacks       = {};
  let _regionOverlayOn = true;

  /* ---- Marker icons --------------------------------------- */
  function _makeIcon(type) {
    const s    = FEATURE_STYLES[type] || FEATURE_STYLES.other;
    const abbr = s.abbr || '?';
    const size = abbr.length > 1 ? 26 : 22;
    const fs   = abbr.length > 1 ?  8 : 11;
    return L.divIcon({
      className: '',
      html: `<div class="ind-marker" style="width:${size}px;height:${size}px;background:${s.color};font-size:${fs}px">${abbr}</div>`,
      iconSize:    [size, size],
      iconAnchor:  [size / 2, size / 2],
      popupAnchor: [0, -(size / 2 + 4)],
    });
  }

  /* ---- Base layers ---------------------------------------- */
  function _buildBaseLayers() {
    _baseLayers.osm = L.tileLayer(
      'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
      {
        attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        maxZoom: 19,
      }
    );
    _baseLayers.satellite = L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      {
        attribution: 'Imagery © Esri',
        maxZoom: 19,
      }
    );
  }

  /* ---- Region overlay on main map ----------------------- */
  function _buildRegionOverlay() {
    for (const r of UK_REGIONS) {
      const rect = L.rectangle(r.bounds, {
        color: '#444', weight: 1,
        fillColor: '#888', fillOpacity: 0.05,
        className: 'region-rect',
      });

      rect.on('mouseover', function () {
        this.setStyle({ fillOpacity: 0.14, color: '#1a3a5c', weight: 2 });
        this.bindTooltip(r.name, { sticky: false, direction: 'top' }).openTooltip();
      });
      rect.on('mouseout', function () {
        this.setStyle({ fillOpacity: 0.05, color: '#444', weight: 1 });
        this.closeTooltip();
      });
      rect.on('click', () => zoomToRegion(r.id));

      const label = L.marker(r.c, {
        icon: L.divIcon({
          className: 'region-label',
          html: `<span>${r.short}</span>`,
          iconAnchor: [0, 0],
        }),
        interactive: false,
      });

      _regionRects[r.id]  = rect;
      _regionLabels[r.id] = label;
    }
  }

  function _showRegionOverlay() {
    if (_regionOverlayOn) return;
    _regionOverlayOn = true;
    for (const r of UK_REGIONS) {
      if (!_map.hasLayer(_regionRects[r.id]))  _regionRects[r.id].addTo(_map);
      if (!_map.hasLayer(_regionLabels[r.id])) _regionLabels[r.id].addTo(_map);
    }
  }

  function _hideRegionOverlay() {
    if (!_regionOverlayOn) return;
    _regionOverlayOn = false;
    for (const r of UK_REGIONS) {
      if (_map.hasLayer(_regionRects[r.id]))  _map.removeLayer(_regionRects[r.id]);
      if (_map.hasLayer(_regionLabels[r.id])) _map.removeLayer(_regionLabels[r.id]);
    }
  }

  /* ---- Inset navigator ----------------------------------- */
  function _buildInset() {
    const NavControl = L.Control.extend({
      options: { position: 'bottomright' },
      onAdd() {
        const c = L.DomUtil.create('div', 'navigator-control');
        c.innerHTML = `
          <div class="nav-header">
            <span>Navigate UK</span>
            <button class="nav-collapse-btn" title="Collapse/expand">−</button>
          </div>
          <div class="nav-body">
            <div id="inset-map"></div>
          </div>`;
        L.DomEvent.disableClickPropagation(c);
        L.DomEvent.disableScrollPropagation(c);
        return c;
      },
    });

    new NavControl().addTo(_map);

    _insetMap = L.map('inset-map', {
      zoomControl: false, attributionControl: false,
      dragging: false, touchZoom: false,
      scrollWheelZoom: false, doubleClickZoom: false,
      boxZoom: false, keyboard: false, tap: false,
    });

    L.tileLayer(
      'https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png',
      { maxZoom: 8, attribution: '© CartoDB' }
    ).addTo(_insetMap);

    _insetMap.fitBounds(UK_BOUNDS);

    /* Region cells on inset */
    for (const r of UK_REGIONS) {
      const rect = L.rectangle(r.bounds, {
        color: '#666', weight: 0.5,
        fillColor: '#aaa', fillOpacity: 0.07,
      });

      rect.on('mouseover', function () {
        this.setStyle({ fillOpacity: 0.28, color: '#1a3a5c', weight: 1.5 });
        this.bindTooltip(r.name, { direction: 'top' }).openTooltip();
      });
      rect.on('mouseout', function () {
        this.setStyle({ fillOpacity: 0.07, color: '#666', weight: 0.5 });
        this.closeTooltip();
      });
      rect.on('click', () => zoomToRegion(r.id));
      rect.addTo(_insetMap);
      _insetRects[r.id] = rect;

      L.marker(r.c, {
        icon: L.divIcon({
          className: 'region-label',
          html: `<span style="font-size:8px;font-weight:600;color:#555">${r.short}</span>`,
          iconAnchor: [0, 0],
        }),
        interactive: false,
      }).addTo(_insetMap);
    }

    /* Viewport rect — shows where the main map is looking */
    _viewportRect = L.rectangle(_map.getBounds(), {
      color: '#c0392b', weight: 1.5,
      fillColor: '#c0392b', fillOpacity: 0.12,
      interactive: false,
      dashArray: '5,3',
    }).addTo(_insetMap);

    /* Collapse/expand */
    const collapseBtn = document.querySelector('.nav-collapse-btn');
    const navBody     = document.querySelector('.nav-body');
    if (collapseBtn && navBody) {
      collapseBtn.addEventListener('click', () => {
        const hidden = navBody.style.display === 'none';
        navBody.style.display = hidden ? '' : 'none';
        collapseBtn.textContent = hidden ? '−' : '+';
        if (hidden) setTimeout(() => _insetMap.invalidateSize(), 30);
      });
    }
  }

  function _syncViewport() {
    if (_viewportRect && _map) {
      _viewportRect.setBounds(_map.getBounds());
    }
  }

  /* ---- Leaflet.draw -------------------------------------- */
  function _initDraw() {
    _drawnItems = new L.FeatureGroup().addTo(_map);
    _drawControl = new L.Control.Draw({
      draw: {
        rectangle: {
          shapeOptions: {
            color: '#c0392b', weight: 2,
            fillOpacity: 0.07, dashArray: '5,4',
          },
        },
        polygon: false, polyline: false,
        circle: false, circlemarker: false, marker: false,
      },
      edit: { featureGroup: _drawnItems, edit: false, remove: false },
    });
  }

  function enableDraw() {
    _map.addControl(_drawControl);
    new L.Draw.Rectangle(_map, _drawControl.options.draw.rectangle).enable();
  }

  function clearDraw() {
    _drawnItems && _drawnItems.clearLayers();
    _drawControl && _map.removeControl(_drawControl);
    _initDraw();
  }

  /* ---- Feature rendering --------------------------------- */
  function _isArea(el) {
    const t = el.tags || {};
    return !!(t.landuse || t.building || t.area === 'yes' || el.type === 'relation');
  }

  function addFeatures(elements) {
    clearFeatures();
    _allElements = elements;

    for (const el of elements) {
      const tags  = el.tags || {};
      const type  = Overpass.classify(tags);
      const name  = Overpass.displayName(el) || type.replace(/_/g, ' ');
      const style = FEATURE_STYLES[type] || FEATURE_STYLES.other;

      if (el.type === 'node') {
        const m = L.marker([el.lat, el.lon], { icon: _makeIcon(type) });
        m.bindTooltip(name, { direction: 'top', offset: [0, -10] });
        m.on('click', () => _callbacks.onFeatureClick && _callbacks.onFeatureClick(el));
        _clusterGroup.addLayer(m);

      } else if (el.type === 'way' || el.type === 'relation') {

        if (_isArea(el)) {
          let coords;
          if (el.type === 'relation' && el.members) {
            const outer = el.members.find(m => m.role === 'outer');
            coords = outer ? outer.geometry : null;
          } else {
            coords = el.geometry;
          }
          if (!coords || !coords.length) continue;

          const latlngs = coords.map(p => [p.lat, p.lon]);
          const poly = L.polygon(latlngs, {
            color:       style.color,
            weight:      1.5,
            fillColor:   style.fill || style.color,
            fillOpacity: 0.25,
          });
          poly.bindTooltip(name, { sticky: true });
          poly.on('click', () => _callbacks.onFeatureClick && _callbacks.onFeatureClick(el));
          _polygonLayer.addLayer(poly);

        } else if (el.geometry && el.geometry.length) {
          const c = Overpass.centroid(el.geometry);
          if (!c) continue;
          const m = L.marker([c.lat, c.lon], { icon: _makeIcon(type) });
          m.bindTooltip(name, { direction: 'top', offset: [0, -10] });
          m.on('click', () => _callbacks.onFeatureClick && _callbacks.onFeatureClick(el));
          _clusterGroup.addLayer(m);
        }
      }
    }
  }

  function clearFeatures() {
    _clusterGroup  && _clusterGroup.clearLayers();
    _polygonLayer  && _polygonLayer.clearLayers();
    _allElements = [];
  }

  /* ---- Area analysis ------------------------------------ */
  function analyseArea(bounds) {
    const counts = {};
    for (const el of _allElements) {
      let lat, lon;
      if (el.type === 'node') {
        lat = el.lat; lon = el.lon;
      } else if (el.geometry && el.geometry.length) {
        const c = Overpass.centroid(el.geometry);
        if (!c) continue;
        lat = c.lat; lon = c.lon;
      } else continue;

      if (bounds.contains([lat, lon])) {
        const t = Overpass.classify(el.tags || {});
        counts[t] = (counts[t] || 0) + 1;
      }
    }
    return counts;
  }

  /* ---- Planning overlay rendering ----------------------- */

  function _listedBuildingIcon(grade) {
    const g = (grade || '').toLowerCase();
    let cls, abbr;
    if      (g.includes('grade i*') || g === 'grade i') { cls = 'lm-grade1';  abbr = 'I';   }
    else if (g.includes('ii*'))                          { cls = 'lm-grade2s'; abbr = 'II*'; }
    else                                                 { cls = 'lm-grade2';  abbr = 'II';  }
    const sz = abbr.length > 2 ? 22 : 18;
    return L.divIcon({
      className: '',
      html: `<div class="plan-marker ${cls}" style="width:${sz}px;height:${sz}px"><span>${abbr}</span></div>`,
      iconSize:   [sz, sz],
      iconAnchor: [sz / 2, sz / 2],
      popupAnchor: [0, -(sz / 2 + 4)],
    });
  }

  function setPlanningFeatures(byDataset) {
    _planningGroup.clearLayers();
    if (!byDataset) return;

    for (const [ds, features] of Object.entries(byDataset)) {
      const def = PlanningData.LAYER_DEFS[ds];
      if (!def) continue;

      for (const f of features) {
        const g = f.geom;
        const label = f.name || def.label;

        if (g.type === 'point') {
          const icon = ds === 'listed-building'
            ? _listedBuildingIcon(f.grade)
            : L.divIcon({
                className: '',
                html: `<div class="plan-marker lm-default" style="background:${def.color}">P</div>`,
                iconSize: [16, 16], iconAnchor: [8, 8],
              });

          const marker = L.marker([g.lat, g.lng], { icon });
          const gradeStr = f.grade ? ` — ${f.grade}` : '';
          const since    = f.startDate ? ` (listed ${f.startDate.slice(0,4)})` : '';
          const docLink  = f.docUrl
            ? `<br><a href="${f.docUrl}" target="_blank" rel="noopener" style="color:#c8960c">Historic England entry ↗</a>`
            : '';
          marker.bindPopup(
            `<strong>${label}</strong>${gradeStr}${since}${docLink}`,
            { maxWidth: 240 }
          );
          _planningGroup.addLayer(marker);

        } else if (g.type === 'polygon') {
          /* Flood zones get level-aware colours */
          let strokeColor = def.color;
          let fillColor   = def.fill || def.color;
          let tooltipText = label;
          if (ds === 'flood-risk-zone' && f.floodLevel) {
            const lc = def.levelColors && def.levelColors[f.floodLevel];
            if (lc) { strokeColor = lc; fillColor = lc; }
            tooltipText = `Flood Zone ${f.floodLevel}${f.floodType ? ' — ' + f.floodType : ''}`;
          }
          for (const ring of g.rings) {
            const poly = L.polygon(ring, {
              color:       strokeColor,
              weight:      1.2,
              fillColor:   fillColor,
              fillOpacity: 0.10,
              dashArray:   ds === 'flood-risk-zone' ? '3,3' : '5,4',
              interactive: true,
            });
            poly.bindTooltip(tooltipText, { sticky: true, direction: 'top' });
            poly.bindPopup(`<strong>${def.label}</strong><br>${tooltipText}`, { maxWidth: 220 });
            _planningGroup.addLayer(poly);
          }
        }
      }
    }
  }

  function clearPlanningFeatures() {
    _planningGroup && _planningGroup.clearLayers();
  }

  /* ---- Public init -------------------------------------- */
  function init(callbacks) {
    _callbacks = callbacks || {};

    _map = L.map('map', {
      center:               UK_CENTER,
      zoom:                 UK_ZOOM,
      minZoom:              UK_MIN_ZOOM,
      maxZoom:              UK_MAX_ZOOM,
      maxBounds:            UK_BOUNDS.pad(0.25),
      maxBoundsViscosity:   0.85,
    });

    _buildBaseLayers();
    _baseLayers.osm.addTo(_map);

    _clusterGroup = L.markerClusterGroup({
      maxClusterRadius: 48,
      showCoverageOnHover: false,
      spiderfyOnMaxZoom: true,
      chunkedLoading: true,
    }).addTo(_map);

    _polygonLayer  = L.featureGroup().addTo(_map);
    _planningGroup = L.featureGroup().addTo(_map);
    _voaGapGroup   = L.featureGroup().addTo(_map);

    _buildRegionOverlay();
    _showRegionOverlay();

    _buildInset();
    _initDraw();

    _map.on('zoomend moveend', () => {
      _syncViewport();
      const z = _map.getZoom();
      if (z < 9) _showRegionOverlay();
      else        _hideRegionOverlay();
      _callbacks.onMapMove && _callbacks.onMapMove(_map.getBounds(), z);
    });

    _map.on(L.Draw.Event.CREATED, e => {
      _drawnItems.clearLayers();
      _drawnItems.addLayer(e.layer);
      _map.removeControl(_drawControl);
      _callbacks.onAreaDrawn && _callbacks.onAreaDrawn(e.layer.getBounds());
    });

    return _map;
  }

  /* ---- Public API --------------------------------------- */
  function zoomToRegion(id) {
    const r = UK_REGIONS.find(x => x.id === id);
    if (r) _map.fitBounds(r.bounds, { padding: [20, 20], animate: true });
  }

  function zoomToPreset(id) {
    const p = GEO_PRESETS[id];
    if (p) _map.setView(p.ll, p.z, { animate: true });
  }

  function zoomToLatLng(lat, lng, zoom) {
    _map.setView([lat, lng], zoom || 13, { animate: true });
  }

  function setBaseLayer(id) {
    for (const [k, l] of Object.entries(_baseLayers)) {
      if (k === id) { if (!_map.hasLayer(l)) l.addTo(_map); }
      else          { if  (_map.hasLayer(l)) _map.removeLayer(l); }
    }
  }

  function getBounds() { return _map ? _map.getBounds() : null; }
  function getZoom()   { return _map ? _map.getZoom()   : 0;    }
  function getMap()    { return _map; }
  function canRun()    { return _map ? _map.getZoom() >= RUN_MIN_ZOOM : false; }

  /* Highlight queried region in inset */
  function markRegionQueried(bounds) {
    for (const r of UK_REGIONS) {
      const rb = L.latLngBounds(r.bounds);
      if (rb.intersects(bounds)) {
        _insetRects[r.id] && _insetRects[r.id].setStyle({ fillOpacity: 0.22, fillColor: '#c0392b', color: '#c0392b' });
      }
    }
  }

  /* ---- VOA Gap Finder markers --------------------------- */

  function _voaGapIcon(item) {
    /* Size by rateable value band — bigger = higher value site */
    let sz;
    if      (item.maxRV >= 100000) sz = 14;
    else if (item.maxRV >=  15000) sz = 11;
    else if (item.maxRV >=   5000) sz = 9;
    else                           sz = 7;
    return L.divIcon({
      className: '',
      html: `<div class="voa-gap-pin" style="width:${sz}px;height:${sz}px" title="${item.pc} — ${item.label} (${item.rvBand})"></div>`,
      iconSize:   [sz, sz],
      iconAnchor: [sz / 2, sz / 2],
    });
  }

  function setVOAGapMarkers(gaps, matched, onGapClick) {
    if (!_voaGapGroup) return;
    _voaGapGroup.clearLayers();

    /* Matched postcodes: faint grey dot — OSM already covers it */
    for (const item of matched) {
      L.circleMarker([item.lat, item.lng], {
        radius: 3,
        color: '#888', weight: 1,
        fillColor: '#bbb', fillOpacity: 0.35,
        interactive: false,
      }).addTo(_voaGapGroup);
    }

    /* Gap postcodes: amber diamond — no OSM match found */
    for (const item of gaps) {
      const marker = L.marker([item.lat, item.lng], {
        icon: _voaGapIcon(item),
        zIndexOffset: 300,
      });
      marker.on('click', () => onGapClick && onGapClick(item));
      marker.addTo(_voaGapGroup);
    }
  }

  function clearVOAGapMarkers() {
    if (_voaGapGroup) _voaGapGroup.clearLayers();
  }

  return {
    init,
    zoomToRegion, zoomToPreset, zoomToLatLng,
    getBounds, getZoom, getMap, canRun,
    addFeatures, clearFeatures, analyseArea,
    setPlanningFeatures, clearPlanningFeatures,
    setVOAGapMarkers, clearVOAGapMarkers,
    enableDraw, clearDraw,
    setBaseLayer, markRegionQueried,
    FEATURE_STYLES, UK_REGIONS,
  };
})();
