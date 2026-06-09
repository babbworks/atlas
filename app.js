'use strict';

/* app.js — Application orchestrator: state, events, URL sharing */

const App = (() => {

  /* ---- Mode presets -------------------------------------- */
  const MODES = {
    'workshop-explorer':    ['workshops', 'craft_any', 'bldg_workshop'],
    'urban-manufacturing':  ['manufacturing', 'industrial_buildings', 'landuse_industrial', 'industrial_any'],
    'hidden-industry':      ['workshops', 'manufacturing', 'bldg_industrial', 'craft_any'],
  };

  /* ---- State -------------------------------------------- */
  const state = {
    currentMode:      null,
    lastResults:      [],
    quickScores:      new Map(),   /* elementId → quick score result (no context) */
    sortByScore:      false,
    minScore:         0,
    lifecycleOnly:    false,
    analysisReady:    false,
    planningResult:   null,        /* last PlanningData.query() result */
    gapFinderActive:  false,       /* VOA gap finder mode */
    lastGapResult:    null,        /* { gaps, matched, total } */
    areaMin:          0,           /* range filter: min m² (0 = off) */
    areaMax:          Infinity,    /* range filter: max m² */
    sortByArea:       false,
  };

  /* ---- DOM helpers -------------------------------------- */
  const $  = id  => document.getElementById(id);
  const qa = sel => document.querySelectorAll(sel);

  /* ---- Toast -------------------------------------------- */
  let _toastTimer;
  function toast(msg, dur = 2800) {
    const el = $('toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => { el.hidden = true; }, dur);
  }

  /* ---- Loading bar -------------------------------------- */
  function showLoading() {
    const bar  = $('loading-bar');
    const fill = $('loading-bar-fill');
    bar.hidden = false;
    fill.style.transition = 'none';
    fill.style.width = '0%';
    requestAnimationFrame(() => {
      fill.style.transition = 'width 0.5s ease';
      fill.style.width = '65%';
    });
  }

  function hideLoading() {
    const fill = $('loading-bar-fill');
    fill.style.width = '100%';
    setTimeout(() => {
      $('loading-bar').hidden = true;
      fill.style.width = '0';
    }, 400);
  }

  /* ---- Panel management --------------------------------- */
  function showPanel(id) {
    qa('.panel').forEach(p => { p.hidden = p.id !== id; });
  }

  /* ---- Filters ------------------------------------------ */
  function getActiveFilters() {
    return Array.from(qa('input[name="filter"]:checked')).map(el => el.value);
  }

  function getActivePlanningOverlays() {
    return Array.from(qa('input[name="planning-overlay"]:checked')).map(el => el.value);
  }

  function setFilters(arr) {
    qa('input[name="filter"]').forEach(cb => {
      cb.checked = arr.includes(cb.value);
    });
    _updateRunButton();
  }

  function _updateRunButton() {
    const btn      = $('btn-run-query');
    const hint     = $('run-hint');
    const hasF     = getActiveFilters().length > 0;
    const canRun   = MapModule.canRun();
    btn.disabled   = !(hasF && canRun);

    if (!canRun)    hint.textContent = 'Zoom in further to enable';
    else if (!hasF) hint.textContent = 'Select at least one filter above';
    else            hint.textContent = '';
  }

  /* ---- Run query ---------------------------------------- */
  async function runQuery() {
    const filters = getActiveFilters();
    if (!filters.length)     { toast('Select at least one filter first'); return; }
    if (!MapModule.canRun()) { toast('Zoom in to a smaller area first'); return; }

    showLoading();
    $('btn-run-query').disabled = true;

    try {
      const bounds  = MapModule.getBounds();
      const overlays = getActivePlanningOverlays();

      /* Run Overpass and planning queries in parallel */
      const [osmResult, planResult] = await Promise.allSettled([
        Overpass.query(filters, bounds),
        overlays.length ? PlanningData.query(overlays, bounds) : Promise.resolve(null),
      ]);

      if (osmResult.status === 'rejected') throw osmResult.reason;

      const { elements, truncated, fromCache } = osmResult.value;
      state.lastResults   = elements;
      state.analysisReady = true;

      if (planResult.status === 'fulfilled' && planResult.value) {
        state.planningResult = planResult.value;
        MapModule.setPlanningFeatures(state.planningResult.byDataset);
        if (state.planningResult.truncated) {
          toast('Planning overlay limit reached — zoom in for complete coverage', 4000);
        }
      } else if (planResult.status === 'rejected') {
        console.warn('[Planning]', planResult.reason);
        toast('Planning overlays unavailable: ' + planResult.reason.message, 4000);
      }

      /* Pre-compute quick scores (no context loop — fast) for badges + sort */
      state.quickScores = new Map();
      for (const el of elements) {
        state.quickScores.set(el.id, Scoring.score(el, []));
      }

      MapModule.addFeatures(elements);
      MapModule.markRegionQueried(bounds);
      _showResults(elements, truncated, fromCache);

      /* Re-run gap finder against the fresh OSM results if active */
      if (state.gapFinderActive) _runGapFinder();
      _saveURLState();
    } catch (err) {
      console.error('[Overpass]', err);
      toast('Query failed: ' + err.message, 5000);
    } finally {
      hideLoading();
      _updateRunButton();
    }
  }

  /* ---- Results panel ------------------------------------ */
  function _showResults(elements, truncated, fromCache) {
    const total = elements.length;

    const typeCount = {};
    for (const el of elements) {
      const t = Overpass.classify(el.tags || {});
      typeCount[t] = (typeCount[t] || 0) + 1;
    }

    const typeLines = Object.entries(typeCount)
      .sort((a, b) => b[1] - a[1])
      .map(([t, n]) => {
        const s = MapModule.FEATURE_STYLES[t] || MapModule.FEATURE_STYLES.other;
        return `<span style="color:${s.color};white-space:nowrap">● ${n} ${s.label}</span>`;
      }).join('  ');

    $('results-title').textContent = `Results (${total})`;
    $('results-summary').innerHTML =
      `<strong>${total}</strong> feature${total !== 1 ? 's' : ''}` +
      (fromCache ? ' <span style="color:#aaa">(cached)</span>' : '') +
      (truncated ? ' — <em>limit reached, zoom in for more</em>' : '') +
      (typeLines  ? `<br><span style="font-size:11px;line-height:1.8">${typeLines}</span>` : '');

    /* Reset chips to "All" when new results arrive */
    state.minScore      = 0;
    state.lifecycleOnly = false;
    state.areaMin       = 0;
    state.areaMax       = Infinity;
    _syncChips();
    _syncSizeChips();
    $('score-chips').hidden = false;

    /* Show size chips only when some results have polygon geometry */
    const hasPolygons = elements.some(el => el.geometry && el.geometry.length >= 3);
    $('size-chips').hidden = !hasPolygons;

    _renderResultsList(elements);
    showPanel('panel-results');
  }

  function _renderResultsList(elements) {
    const list = $('results-list');
    list.innerHTML = '';

    let display = elements.slice();

    /* Apply lifecycle-only filter */
    if (state.lifecycleOnly) {
      display = display.filter(el => Overpass.lifecycleStatus(el.tags) !== null);
    }

    /* Apply minimum score filter */
    if (state.minScore > 0) {
      display = display.filter(el => {
        const qs = state.quickScores.get(el.id);
        return qs && qs.score >= state.minScore;
      });
    }

    /* Apply area range filter */
    if (state.areaMin > 0 || state.areaMax < Infinity) {
      display = display.filter(el => {
        const qs = state.quickScores.get(el.id);
        const a  = qs ? qs.areaM2 : 0;
        return a >= state.areaMin && a < state.areaMax;
      });
    }

    if (state.sortByArea) {
      display.sort((a, b) => {
        const aa = state.quickScores.get(a.id);
        const ab = state.quickScores.get(b.id);
        return (ab ? ab.areaM2 : 0) - (aa ? aa.areaM2 : 0);
      });
    } else if (state.sortByScore) {
      display.sort((a, b) => {
        const sa = state.quickScores.get(a.id);
        const sb = state.quickScores.get(b.id);
        return (sb ? sb.score : 0) - (sa ? sa.score : 0);
      });
    }

    const total    = display.length;
    const capped   = display.slice(0, 300);

    const frag = document.createDocumentFragment();

    if (total === 0) {
      const li = document.createElement('li');
      li.style.cssText = 'padding:14px;color:#aaa;font-size:12px;font-style:italic';
      li.textContent = 'No results match the current filter.';
      frag.appendChild(li);
    } else {
      for (const el of capped) {
        const type      = Overpass.classify(el.tags || {});
        const name      = Overpass.displayName(el) || (el.tags && (el.tags.craft || el.tags.industrial)) || type.replace(/_/g, ' ');
        const style     = MapModule.FEATURE_STYLES[type] || MapModule.FEATURE_STYLES.other;
        const qs        = state.quickScores.get(el.id);
        const lifecycle = Overpass.lifecycleStatus(el.tags);

        const lcHtml = lifecycle
          ? `<span class="lifecycle-pill lp-${lifecycle}">${lifecycle.toUpperCase()}</span>`
          : '';

        const areaHtml = (qs && qs.areaM2 > 0)
          ? `<span class="result-area">${_fmtArea(qs.areaM2)}</span>`
          : '';

        const li = document.createElement('li');
        li.className = 'result-item';
        li.innerHTML = `
          <span class="result-dot" style="background:${style.color}"></span>
          <div style="flex:1;min-width:0">
            <div class="result-name">${_esc(name)}${lcHtml}</div>
            <div class="result-meta">${style.label}${areaHtml}</div>
          </div>
          ${qs ? `<div class="result-score-badge" style="border-color:${qs.color};color:${qs.color}" title="${qs.classification}">${qs.score}</div>` : ''}`;
        li.addEventListener('click', () => _showFeatureDetail(el));
        frag.appendChild(li);
      }

      if (total > 300) {
        const li = document.createElement('li');
        li.style.cssText = 'padding:9px 14px;color:#aaa;font-size:11px;';
        li.textContent = `… and ${total - 300} more — zoom in or raise the score threshold`;
        frag.appendChild(li);
      }
    }

    list.appendChild(frag);
  }

  /* ---- Feature detail panel ----------------------------- */
  function _showFeatureDetail(el) {
    const tags  = el.tags || {};
    const type  = Overpass.classify(tags);
    const name  = Overpass.displayName(el) || type.replace(/_/g, ' ');
    const style = MapModule.FEATURE_STYLES[type] || MapModule.FEATURE_STYLES.other;

    let lat = null, lon = null;
    if (el.type === 'node') {
      lat = el.lat; lon = el.lon;
    } else if (el.geometry && el.geometry.length) {
      const c = Overpass.centroid(el.geometry);
      if (c) { lat = c.lat; lon = c.lon; }
    }

    const osmUrl  = `https://www.openstreetmap.org/${el.type}/${el.id}`;
    const osmEdit = `https://www.openstreetmap.org/edit?${el.type}=${el.id}`;
    const gmUrl   = lat != null ? `https://www.google.com/maps?q=${lat.toFixed(6)},${lon.toFixed(6)}` : null;
    const svUrl   = lat != null ? `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${lat.toFixed(6)},${lon.toFixed(6)}` : null;

    const tagRows = Object.entries(tags)
      .map(([k, v]) =>
        `<div class="tag-row">` +
        `<span class="tag-key">${_esc(k)}</span>` +
        `<span class="tag-eq">=</span>` +
        `<span class="tag-val">${_esc(v)}</span>` +
        `</div>`
      ).join('');

    /* Full score with spatial context and official designations */
    const designations = (lat !== null && state.planningResult)
      ? PlanningData.nearbyDesignations(lat, lon, state.planningResult)
      : [];
    const sr = Scoring.score(el, state.lastResults, designations);

    const signalRows = sr.signals.map(sig => {
      const cls   = sig.delta > 0 ? 'signal-pos' : 'signal-neg';
      const arrow = sig.delta > 0 ? '▲' : '▼';
      const fmt   = sig.delta > 0 ? `+${sig.delta}` : `${sig.delta}`;
      return `<div class="signal-row ${cls}">
        <span class="signal-arrow">${arrow}</span>
        <span class="signal-delta">${fmt}</span>
        <span class="signal-text">${_esc(sig.text)}</span>
      </div>`;
    }).join('');

    $('feature-content').innerHTML = `
      <div class="feature-name">${_esc(name)}</div>
      <span class="feature-type-badge" style="background:${style.color}">${style.label}</span>
      ${sr.areaM2 > 0 ? `<span class="feature-area-badge">${_fmtArea(sr.areaM2)}</span>` : ''}
      ${lat != null ? `<div class="feature-coords">${lat.toFixed(5)}, ${lon.toFixed(5)}</div>` : ''}

      <div class="score-panel" style="border-left-color:${sr.color}">
        <div class="score-header">
          <div class="score-block">
            <div class="score-number" style="color:${sr.color}">${sr.score}</div>
            <div class="score-label">Opportunity</div>
          </div>
          <div class="score-block">
            <div class="score-number score-conf-num">${sr.confidence}</div>
            <div class="score-label">Confidence</div>
          </div>
          <div class="score-band-block">
            <div class="score-band" style="color:${sr.color}">${sr.classification}</div>
            ${sr.hasContext ? '<div class="score-context-note">includes spatial context</div>' : '<div class="score-context-note">quick score — no context</div>'}
          </div>
        </div>
        <div class="score-signals">
          ${signalRows || '<div style="color:#aaa;font-size:11px;padding:4px 0">No signals — insufficient tags</div>'}
        </div>
        <div id="score-extra-badges" class="score-extra-badges"></div>
        <div class="score-disclaimer">Score based on available OSM data only. Does not confirm vacancy or availability.</div>
      </div>

      <div class="feature-tags">
        <div class="feature-tags-title">OSM Tags</div>
        ${tagRows || '<div style="color:#aaa;font-size:12px">No tags recorded</div>'}
      </div>
      <div class="feature-links">
        <a class="feature-link" href="${osmUrl}" target="_blank" rel="noopener">View on OpenStreetMap ↗</a>
        <a class="feature-link feature-link-edit" href="${osmEdit}" target="_blank" rel="noopener">Edit in OSM iD ↗</a>
        ${gmUrl ? `<a class="feature-link" href="${gmUrl}" target="_blank" rel="noopener">Open in Google Maps ↗</a>` : ''}
        ${svUrl ? `<a class="feature-link" href="${svUrl}" target="_blank" rel="noopener">Street View ↗</a>` : ''}
      </div>
      <button class="btn-postcard" id="btn-create-postcard">⬡ Create Shareable Card</button>
      <div id="companies-section" class="companies-section"></div>
      <div id="voa-section" class="voa-section"></div>`;

    showPanel('panel-feature');

    document.getElementById('btn-create-postcard')
      .addEventListener('click', () => _openPostcard(el));

    _loadCompanies(tags);
    _loadVOA(tags);
  }

  /* ---- Companies House lookup --------------------------- */

  async function _loadCompanies(tags) {
    const section = $('companies-section');
    if (!section) return;

    const postcode = tags['addr:postcode'];
    const name     = tags.name || tags.operator;

    if (!postcode && !name) {
      section.innerHTML =
        `<div class="ch-header">Registered Businesses</div>` +
        `<p class="ch-empty">No address or name in OSM data to search with.</p>`;
      return;
    }

    section.innerHTML =
      `<div class="ch-header">Registered Businesses</div>` +
      `<div class="ch-loading">Searching Companies House…</div>`;

    try {
      let results = [];
      let searchedBy = '';

      if (postcode) {
        results   = await Companies.searchByPostcode(postcode);
        searchedBy = `postcode ${postcode}`;
      } else if (name) {
        results   = await Companies.searchByName(name);
        searchedBy = `name "${name}"`;
      }

      if (!results.length) {
        section.innerHTML =
          `<div class="ch-header">Registered Businesses</div>` +
          `<p class="ch-empty">No registered companies found for ${searchedBy}.</p>`;
        return;
      }

      /* Sort: industrial first, then active, then others */
      results.sort((a, b) => {
        if (a.isIndustrial !== b.isIndustrial) return a.isIndustrial ? -1 : 1;
        if (a.status === 'active' && b.status !== 'active') return -1;
        if (b.status === 'active' && a.status !== 'active') return  1;
        return 0;
      });

      const rows = results.map(c => {
        const statusCls = c.status === 'active' ? 'ch-active'
          : (c.status === 'dissolved' ? 'ch-dissolved' : 'ch-other');
        const sicChips = (c.sicInfo || [])
          .filter(s => s.label)
          .map(s => `<span class="ch-sic-chip">${_esc(s.label)}</span>`)
          .join('');
        const since = c.incorporated
          ? `<span class="ch-since">est. ${c.incorporated.slice(0,4)}</span>` : '';
        const officerHtml = (c.officers && c.officers.length)
          ? `<div class="ch-officers">${c.officers.slice(0, 4).map(o =>
              `<span class="ch-officer">${_esc(_fmtName(o.name))} <span class="ch-officer-role">${_esc(o.role.replace(/_/g,' '))}</span></span>`
            ).join('')}</div>` : '';
        return `<div class="ch-item${c.isIndustrial ? ' ch-industrial' : ''}">
          <div class="ch-item-top">
            <a class="ch-name" href="${c.chUrl}" target="_blank" rel="noopener">${_esc(c.name)}</a>
            <span class="ch-status ${statusCls}">${_esc(c.status || '?')}</span>
          </div>
          ${sicChips || since ? `<div class="ch-item-meta">${sicChips}${since}</div>` : ''}
          ${officerHtml}
        </div>`;
      }).join('');

      const note = postcode ? '' :
        `<p class="ch-note">Searched by name — results may include unrelated companies.</p>`;

      section.innerHTML =
        `<div class="ch-header">Registered Businesses
          <span class="ch-count">${results.length} found</span>
        </div>
        ${note}${rows}`;

      /* Feed confirmation badge back to score panel */
      const activeIndustrial = results.filter(r => r.status === 'active' && r.isIndustrial);
      if (activeIndustrial.length) {
        _addScoreBadge('badge-ch', `CH: ${activeIndustrial.length} active industrial compan${activeIndustrial.length > 1 ? 'ies' : 'y'} registered here`);
      } else {
        const active = results.filter(r => r.status === 'active');
        if (active.length) _addScoreBadge('badge-ch-neutral', `CH: ${active.length} active compan${active.length > 1 ? 'ies' : 'y'} registered here`);
      }

    } catch (err) {
      console.warn('[Companies]', err);
      section.innerHTML =
        `<div class="ch-header">Registered Businesses</div>` +
        `<p class="ch-empty ch-error">Lookup unavailable: ${_esc(err.message)}</p>`;
    }
  }

  /* ---- VOA business rates lookup ------------------------ */

  async function _loadVOA(tags) {
    const section  = $('voa-section');
    if (!section) return;

    const postcode = tags['addr:postcode'];
    if (!postcode) {
      section.innerHTML =
        `<div class="voa-header">Business Rates <span class="voa-source">VOA</span> <span class="coverage-badge">England &amp; Wales</span></div>` +
        `<p class="voa-empty">No postcode in OSM data.</p>`;
      return;
    }

    section.innerHTML =
      `<div class="voa-header">Business Rates <span class="voa-source">VOA</span> <span class="coverage-badge">England &amp; Wales</span></div>` +
      `<div class="voa-loading">Looking up ${_esc(postcode)}…</div>`;

    try {
      const results = await VOA.lookup(postcode);

      if (!results.length) {
        section.innerHTML =
          `<div class="voa-header">Business Rates <span class="voa-source">VOA</span> <span class="coverage-badge">England &amp; Wales</span></div>` +
          `<p class="voa-empty">No industrial entries at ${_esc(postcode)} in VOA data.</p>`;
        return;
      }

      const rows = results.map(r => {
        const rv = r.rateableValue
          ? `£${r.rateableValue.toLocaleString()}`
          : '—';
        return `<div class="voa-item">
          <div class="voa-item-top">
            <span class="voa-label">${_esc(r.label)}</span>
            <span class="voa-rv">${rv} RV</span>
          </div>
          ${r.rvBand ? `<div class="voa-band">${_esc(r.rvBand)}</div>` : ''}
          ${r.address ? `<div class="voa-addr">${_esc(r.address)}</div>` : ''}
        </div>`;
      }).join('');

      section.innerHTML =
        `<div class="voa-header">Business Rates
          <span class="voa-source">VOA</span>
          <span class="voa-count">${results.length} propert${results.length === 1 ? 'y' : 'ies'}</span>
          <span class="coverage-badge">England &amp; Wales</span>
        </div>
        ${rows}`;

      /* Feed confirmation badge back to score panel */
      const hasIndustrial = results.some(r => r.code && r.code.startsWith('I'));
      if (hasIndustrial) {
        _addScoreBadge('badge-voa', `VOA: ${results.length} industrial rating${results.length > 1 ? 's' : ''} at this postcode`);
      }

    } catch (err) {
      section.innerHTML =
        `<div class="voa-header">Business Rates <span class="voa-source">VOA</span></div>` +
        `<p class="voa-empty voa-error">${_esc(err.message)}</p>`;
    }
  }

  /* ---- CSV export --------------------------------------- */
  function _exportCSV() {
    if (!state.lastResults.length) {
      toast('No results to export — run a query first');
      return;
    }

    const cols = ['id','type','name','feature_type','lat','lon','area_m2','score','classification','lifecycle','postcode','osm_url'];
    const rows = [cols.join(',')];

    for (const el of state.lastResults) {
      const tags     = el.tags || {};
      const type     = Overpass.classify(tags);
      const name     = Overpass.displayName(el) || '';
      const lc       = Overpass.lifecycleStatus(tags) || '';
      const pc       = tags['addr:postcode'] || '';
      const qs       = state.quickScores.get(el.id);
      const osmUrl   = `https://www.openstreetmap.org/${el.type}/${el.id}`;

      let lat = '', lon = '';
      if (el.type === 'node') { lat = el.lat; lon = el.lon; }
      else if (el.geometry && el.geometry.length) {
        const c = Overpass.centroid(el.geometry);
        if (c) { lat = c.lat.toFixed(6); lon = c.lon.toFixed(6); }
      }

      const vals = [
        el.id, el.type,
        `"${name.replace(/"/g, '""')}"`,
        type, lat, lon,
        qs && qs.areaM2 > 0 ? Math.round(qs.areaM2) : '',
        qs ? qs.score : '',
        qs ? `"${qs.classification}"` : '',
        lc,
        pc,
        osmUrl,
      ];
      rows.push(vals.join(','));
    }

    const csv  = rows.join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `industrial-atlas-export-${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast(`Exported ${state.lastResults.length} features as CSV`);
  }

  /* ---- VOA Gap Finder ----------------------------------- */

  async function _runGapFinder() {
    if (!state.gapFinderActive) return;

    const bounds = MapModule.getBounds();
    if (!bounds) return;

    /* Require zoom ≥ 12 — gap finder over large areas produces too much noise */
    if (MapModule.getZoom() < 12) {
      toast('Zoom in further to run the Gap Finder (zoom 12+)', 3000);
      return;
    }

    showLoading();

    try {
      const result = await VOAGeo.findGaps(bounds, state.lastResults);
      state.lastGapResult = result;

      MapModule.setVOAGapMarkers(result.gaps, result.matched, _showGapDetail);
      _showGapPanel(result);
    } catch (err) {
      console.warn('[GapFinder]', err);
      toast('Gap finder error: ' + err.message, 4000);
    } finally {
      hideLoading();
    }
  }

  function _showGapPanel(result) {
    const { gaps, matched, total } = result;

    if (!total) {
      $('gap-content').innerHTML =
        `<p class="analysis-note">No VOA industrial properties found in this area.<br>
         Either the data file isn't loaded yet or there are no rated properties here.</p>`;
      showPanel('panel-gap');
      return;
    }

    const topGaps = gaps
      .slice()
      .sort((a, b) => (b.maxRV || 0) - (a.maxRV || 0))
      .slice(0, 200);

    const listItems = topGaps.map(item => {
      const rv = item.maxRV ? `£${item.maxRV.toLocaleString()} RV` : 'unrated';
      return `<li class="gap-item" data-pc="${_esc(item.pc)}">
        <div class="gap-item-top">
          <span class="gap-pin-dot"></span>
          <span class="gap-pc">${_esc(item.pc)}</span>
          <span class="gap-rv">${rv}</span>
        </div>
        <div class="gap-item-meta">
          ${_esc(item.label)}
          ${item.count > 1 ? ` · ${item.count} units` : ''}
          · ${_esc(item.rvBand)}
        </div>
      </li>`;
    }).join('');

    $('gap-content').innerHTML = `
      <div class="gap-summary">
        <div class="gap-stat"><span class="gap-stat-n gap-stat-missing">${gaps.length}</span><span class="gap-stat-l">unmapped</span></div>
        <div class="gap-stat"><span class="gap-stat-n gap-stat-matched">${matched.length}</span><span class="gap-stat-l">OSM-matched</span></div>
        <div class="gap-stat"><span class="gap-stat-n">${total}</span><span class="gap-stat-l">VOA total</span></div>
      </div>
      <p class="gap-note">Amber pins = rated industrial properties with no OSM feature within 60 m — potential mapping gaps.</p>
      <ul class="gap-list" id="gap-list">${listItems}</ul>
      ${gaps.length > 200 ? `<p class="gap-more">Showing top 200 by rateable value — zoom in for full list</p>` : ''}`;

    /* Wire up list item clicks */
    document.querySelectorAll('.gap-item').forEach(li => {
      li.addEventListener('click', () => {
        const pc   = li.dataset.pc;
        const item = gaps.find(g => g.pc === pc);
        if (item) _showGapDetail(item);
      });
    });

    showPanel('panel-gap');
  }

  function _showGapDetail(item) {
    $('gap-detail-content').innerHTML = `
      <div class="feature-name">${_esc(item.pc)}</div>
      <span class="feature-type-badge" style="background:#b35c00">${_esc(item.label)}</span>
      <div class="feature-coords">${item.lat.toFixed(5)}, ${item.lng.toFixed(5)}</div>

      <div class="gap-detail-box">
        <div class="gap-detail-row">
          <span class="gap-detail-key">Rateable value</span>
          <span class="gap-detail-val">${item.maxRV ? '£' + item.maxRV.toLocaleString() : '—'}</span>
        </div>
        <div class="gap-detail-row">
          <span class="gap-detail-key">Size band</span>
          <span class="gap-detail-val">${_esc(item.rvBand)}</span>
        </div>
        <div class="gap-detail-row">
          <span class="gap-detail-key">Units at postcode</span>
          <span class="gap-detail-val">${item.count}</span>
        </div>
        <div class="gap-detail-row">
          <span class="gap-detail-key">OSM coverage</span>
          <span class="gap-detail-val gap-missing">No industrial feature within 60 m</span>
        </div>
      </div>

      <div class="gap-action-note">This property appears on the VOA non-domestic rating register but has no corresponding OSM feature. Consider adding it to OpenStreetMap.</div>

      <div class="feature-links">
        <a class="feature-link feature-link-edit"
           href="https://www.openstreetmap.org/edit#map=19/${item.lat}/${item.lng}"
           target="_blank" rel="noopener">Edit this location in OSM iD ↗</a>
        <a class="feature-link"
           href="https://www.google.com/maps?q=${item.lat},${item.lng}"
           target="_blank" rel="noopener">Open in Google Maps ↗</a>
        <a class="feature-link"
           href="https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${item.lat},${item.lng}"
           target="_blank" rel="noopener">Street View ↗</a>
      </div>`;

    showPanel('panel-gap-detail');
    MapModule.getMap && MapModule.getMap().setView([item.lat, item.lng], 17);
  }

  /* ---- Area analysis ------------------------------------ */
  function _showAnalysis(bounds) {
    const counts = MapModule.analyseArea(bounds);
    const total  = Object.values(counts).reduce((s, n) => s + n, 0);

    if (!total) {
      $('analysis-content').innerHTML =
        `<p class="analysis-note">No loaded features found within this rectangle.<br>
         Run a query first, then draw your analysis area.</p>`;
    } else {
      const typeRows = Object.entries(counts)
        .sort((a, b) => b[1] - a[1])
        .map(([t, n]) => {
          const s = MapModule.FEATURE_STYLES[t] || MapModule.FEATURE_STYLES.other;
          return `<div class="analysis-row">
            <span class="analysis-label">
              <span style="background:${s.color};border-radius:50%;width:10px;height:10px;display:inline-block;flex-shrink:0"></span>
              ${s.label}
            </span>
            <span class="analysis-count">${n}</span>
          </div>`;
        }).join('');

      /* Score distribution for features in bounds */
      const bands = { high: 0, candidate: 0, mixed: 0, stable: 0, active: 0 };
      for (const el of state.lastResults) {
        let lat, lon;
        if (el.type === 'node') { lat = el.lat; lon = el.lon; }
        else if (el.geometry && el.geometry.length) {
          const c = Overpass.centroid(el.geometry);
          if (!c) continue;
          lat = c.lat; lon = c.lon;
        } else continue;
        if (!bounds.contains([lat, lon])) continue;
        const qs = state.quickScores.get(el.id);
        if (qs) bands[qs.code] = (bands[qs.code] || 0) + 1;
      }

      const BAND_META = [
        { code: 'high',      label: 'High Opportunity',        color: '#a82820' },
        { code: 'candidate', label: 'Underutilisation Candidate', color: '#c06820' },
        { code: 'mixed',     label: 'Mixed / Unclear',          color: '#9a7a10' },
        { code: 'stable',    label: 'Stable Productive',        color: '#4a8060' },
        { code: 'active',    label: 'Active Industrial',        color: '#2d6a4f' },
      ];
      const scoreRows = BAND_META.filter(b => bands[b.code])
        .map(b => `<div class="analysis-row">
          <span class="analysis-label">
            <span style="background:${b.color};border-radius:2px;width:10px;height:10px;display:inline-block;flex-shrink:0"></span>
            ${b.label}
          </span>
          <span class="analysis-count" style="color:${b.color}">${bands[b.code]}</span>
        </div>`).join('');

      const scoredTotal = Object.values(bands).reduce((s, n) => s + n, 0);
      const highCount   = (bands.high || 0) + (bands.candidate || 0);

      /* Area size breakdown for polygon features in bounds */
      const sizeBuckets = { major: 0, large: 0, medium: 0, small: 0 };
      let totalAreaM2 = 0, polygonCount = 0;
      for (const el of state.lastResults) {
        let lat, lon;
        if (el.type === 'node') { lat = el.lat; lon = el.lon; }
        else if (el.geometry && el.geometry.length) {
          const c = Overpass.centroid(el.geometry);
          if (!c) continue;
          lat = c.lat; lon = c.lon;
        } else continue;
        if (!bounds.contains([lat, lon])) continue;
        const qs = state.quickScores.get(el.id);
        if (!qs || qs.areaM2 <= 0) continue;
        polygonCount++;
        totalAreaM2 += qs.areaM2;
        if      (qs.areaM2 > 25000) sizeBuckets.major++;
        else if (qs.areaM2 >  5000) sizeBuckets.large++;
        else if (qs.areaM2 >   500) sizeBuckets.medium++;
        else                        sizeBuckets.small++;
      }

      const SIZE_META = [
        { key: 'major',  label: 'Major (>25,000 m²)',  color: '#1c4a8a' },
        { key: 'large',  label: 'Large (5–25,000 m²)', color: '#2d6a9a' },
        { key: 'medium', label: 'Medium (500–5,000 m²)', color: '#4a8ab0' },
        { key: 'small',  label: 'Small (<500 m²)',      color: '#7aaac8' },
      ];
      const sizeRows = SIZE_META.filter(b => sizeBuckets[b.key])
        .map(b => `<div class="analysis-row">
          <span class="analysis-label">
            <span style="background:${b.color};border-radius:2px;width:10px;height:10px;display:inline-block;flex-shrink:0"></span>
            ${b.label}
          </span>
          <span class="analysis-count" style="color:${b.color}">${sizeBuckets[b.key]}</span>
        </div>`).join('');

      const totalAreaFmt = totalAreaM2 >= 10000
        ? `${(totalAreaM2 / 10000).toFixed(1)} ha`
        : `${Math.round(totalAreaM2).toLocaleString()} m²`;

      $('analysis-content').innerHTML = `
        <div class="analysis-row analysis-total">
          <span class="analysis-label">Total features in area</span>
          <span class="analysis-count">${total}</span>
        </div>
        ${typeRows}
        ${scoreRows ? `
        <div class="analysis-section-head">Score distribution (${scoredTotal} scored)</div>
        ${scoreRows}
        ${highCount ? `<div class="analysis-highlight">⬡ ${highCount} site${highCount > 1 ? 's' : ''} score 60+ — worth investigating</div>` : ''}
        ` : ''}
        ${sizeRows ? `
        <div class="analysis-section-head">Building sizes (${polygonCount} with polygon data)</div>
        ${sizeRows}
        <div class="analysis-highlight" style="color:#1c4a8a">▦ ${totalAreaFmt} total floor area across ${polygonCount} polygon${polygonCount !== 1 ? 's' : ''}</div>
        ` : ''}`;
    }

    showPanel('panel-analysis');
  }

  /* ---- Geocoding (Nominatim) ----------------------------- */
  let _searchDebounce;

  async function _geocode(q) {
    const url = `https://nominatim.openstreetmap.org/search?format=json&countrycodes=gb&limit=6&q=${encodeURIComponent(q)}`;
    try {
      const r = await fetch(url, { headers: { 'Accept-Language': 'en-GB' } });
      return r.ok ? r.json() : [];
    } catch { return []; }
  }

  function _renderSuggestions(results) {
    const ul = $('search-suggestions');
    ul.innerHTML = '';
    if (!results.length) { ul.hidden = true; return; }

    for (const r of results) {
      const li   = document.createElement('li');
      const parts = r.display_name.split(',').slice(0, 3).join(', ');
      li.textContent = parts;
      li.setAttribute('role', 'option');
      li.addEventListener('mousedown', e => {
        e.preventDefault();
        MapModule.zoomToLatLng(parseFloat(r.lat), parseFloat(r.lon), 13);
        $('search-input').value = r.display_name.split(',')[0].trim();
        ul.hidden = true;
      });
      ul.appendChild(li);
    }
    ul.hidden = false;
  }

  function _doSearch(q) {
    if (!q || q.length < 2) return;
    _geocode(q).then(results => {
      if (results.length) {
        MapModule.zoomToLatLng(parseFloat(results[0].lat), parseFloat(results[0].lon), 13);
        $('search-input').value = results[0].display_name.split(',')[0].trim();
        $('search-suggestions').hidden = true;
      } else {
        toast(`No results for "${q}"`);
      }
    });
  }

  /* ---- URL state ---------------------------------------- */
  function _saveURLState() {
    const b = MapModule.getBounds();
    if (!b) return;
    const c = b.getCenter();
    const z = MapModule.getZoom();
    const f = getActiveFilters().join(',');
    const parts = [`v=${c.lat.toFixed(4)},${c.lng.toFixed(4)},${z}`];
    if (f)               parts.push(`f=${encodeURIComponent(f)}`);
    if (state.currentMode) parts.push(`m=${state.currentMode}`);
    history.replaceState(null, '', '#' + parts.join('&'));
  }

  function _loadURLState() {
    const hash = window.location.hash.slice(1);
    if (!hash) return;
    const params = {};
    hash.split('&').forEach(part => {
      const [k, v] = part.split('=');
      if (k && v !== undefined) params[k] = decodeURIComponent(v);
    });
    if (params.v) {
      const [lat, lng, z] = params.v.split(',').map(Number);
      if (lat && lng && z) MapModule.zoomToLatLng(lat, lng, z);
    }
    if (params.f) setFilters(params.f.split(','));
    if (params.m) _activateMode(params.m);
  }

  function _activateMode(modeId) {
    qa('.mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === modeId));
    const filters = MODES[modeId];
    if (filters) { setFilters(filters); state.currentMode = modeId; }
    else { state.currentMode = null; }
  }

  /* ---- Postcard: export-only vector background SVG ------ */
  function _svgExportBg(lat, lon, elements) {
    const W = 1200, H = 630, cx = W / 2, cy = H / 2;
    /* Scale: show roughly the same area as zoom 17 (~500m across).
       At UK lat (~53°N): 0.004° lat ≈ 445m, 0.007° lon ≈ 470m */
    const latScale = H / 0.008;
    const lonScale = W / 0.014;

    function proj(pLat, pLon) {
      return [cx + (pLon - lon) * lonScale, cy - (pLat - lat) * latScale];
    }

    /* Loaded polygon footprints */
    const polys = [];
    if (elements) {
      for (const el of elements) {
        if (!el.geometry || el.geometry.length < 3) continue;
        const type  = Overpass.classify(el.tags || {});
        const color = (MapModule.FEATURE_STYLES[type] || MapModule.FEATURE_STYLES.other).color;
        const pts   = el.geometry.map(p => {
          const [x, y] = proj(p.lat, p.lon);
          return `${x.toFixed(1)},${y.toFixed(1)}`;
        }).join(' ');
        polys.push(`<polygon points="${pts}" fill="${color}" fill-opacity="0.22" stroke="${color}" stroke-width="1.5" stroke-opacity="0.55"/>`);
      }
    }

    /* Grid centred on site */
    const STEP = 48;
    const grid = [];
    for (let x = ((cx % STEP) + STEP) % STEP; x < W; x += STEP)
      grid.push(`<line x1="${x.toFixed(0)}" y1="0" x2="${x.toFixed(0)}" y2="${H}" stroke="#182414" stroke-width="0.6"/>`);
    for (let y = ((cy % STEP) + STEP) % STEP; y < H; y += STEP)
      grid.push(`<line x1="0" y1="${y.toFixed(0)}" x2="${W}" y2="${y.toFixed(0)}" stroke="#182414" stroke-width="0.6"/>`);

    /* Site crosshair */
    const xh = `
      <circle cx="${cx}" cy="${cy}" r="70" fill="none" stroke="rgba(255,255,255,0.07)" stroke-width="1" stroke-dasharray="6 5"/>
      <circle cx="${cx}" cy="${cy}" r="10" fill="none" stroke="rgba(255,255,255,0.4)" stroke-width="2"/>
      <circle cx="${cx}" cy="${cy}" r="3"  fill="#fff"/>
      <line x1="${cx-90}" y1="${cy}" x2="${cx-14}" y2="${cy}" stroke="rgba(255,255,255,0.22)" stroke-width="1"/>
      <line x1="${cx+14}" y1="${cy}" x2="${cx+90}" y2="${cy}" stroke="rgba(255,255,255,0.22)" stroke-width="1"/>
      <line x1="${cx}" y1="${cy-90}" x2="${cx}" y2="${cy-14}" stroke="rgba(255,255,255,0.22)" stroke-width="1"/>
      <line x1="${cx}" y1="${cy+14}" x2="${cx}" y2="${cy+90}" stroke="rgba(255,255,255,0.22)" stroke-width="1"/>`;

    return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
      <rect width="${W}" height="${H}" fill="#0b1209"/>
      ${grid.join('')}
      ${polys.join('')}
      ${xh}
    </svg>`;
  }

  /* ---- Postcard: build card HTML ------------------------- */
  function _buildPostcard(el, sr) {
    const tags      = el.tags || {};
    const type      = Overpass.classify(tags);
    const name      = Overpass.displayName(el) || type.replace(/_/g, ' ');
    const style     = MapModule.FEATURE_STYLES[type] || MapModule.FEATURE_STYLES.other;
    const lifecycle = Overpass.lifecycleStatus(tags);

    let lat = null, lon = null;
    if (el.type === 'node') { lat = el.lat; lon = el.lon; }
    else if (el.geometry && el.geometry.length) {
      lat = el.geometry.reduce((s, p) => s + p.lat, 0) / el.geometry.length;
      lon = el.geometry.reduce((s, p) => s + p.lon, 0) / el.geometry.length;
    }

    /* Address */
    const addrParts = [];
    const hn = tags['addr:housenumber'], st = tags['addr:street'];
    if (hn && st) addrParts.push(`${hn} ${st}`);
    else if (st)  addrParts.push(st);
    const city = tags['addr:city'] || tags['addr:town'] || tags['addr:locality'];
    if (city) addrParts.push(city);
    if (tags['addr:postcode']) addrParts.push(tags['addr:postcode']);

    /* Interpreted tag rows for sidebar */
    const tagRows = [];
    if (tags.operator)   tagRows.push(['operator',   tags.operator]);
    if (tags.brand && tags.brand !== tags.operator) tagRows.push(['brand', tags.brand]);
    if (tags.craft && tags.craft !== 'yes') tagRows.push(['craft', tags.craft]);
    if (tags.industrial && tags.industrial !== 'yes') tagRows.push(['industrial', tags.industrial]);
    if (tags.man_made)   tagRows.push(['man_made',    tags.man_made]);
    if (tags.building && tags.building !== 'yes') tagRows.push(['building', tags.building]);
    if (tags.landuse)    tagRows.push(['landuse',     tags.landuse]);
    if (sr.areaM2 > 0)  tagRows.push(['area', sr.areaM2 >= 10000 ? `${(sr.areaM2/10000).toFixed(1)} ha` : `${Math.round(sr.areaM2).toLocaleString()} m\u00b2`]);
    if (tags.opening_hours) tagRows.push(['hours', tags.opening_hours.slice(0, 32)]);
    if (tags.website)    tagRows.push(['website', tags.website.replace(/^https?:\/\//, '').split('/')[0]]);
    if (tags.phone)      tagRows.push(['phone', tags.phone]);

    const tagHtml = tagRows.map(([k, v]) =>
      `<div class="pc-sb-tag-row">
        <span class="pc-sb-tag-key">${_esc(k)}</span>
        <span class="pc-sb-tag-val">${_esc(v)}</span>
      </div>`
    ).join('');

    /* Planning designation badges from score signals */
    const designationSigs = sr.signals.filter(s =>
      s.delta > 0 && (
        s.text.includes('listed building') || s.text.includes('conservation area') ||
        s.text.includes('Article 4') || s.text.includes('brownfield') ||
        s.text.includes('scheduled monument')
      )
    );
    const designBadgeHtml = designationSigs.map(s => {
      const label = s.text.replace(/—.*$/, '').trim();
      return `<span class="pc-sb-designation">${_esc(label)}</span>`;
    }).join('');

    /* Scoring signals */
    const sigHtml = sr.signals.slice(0, 5).map(sig => {
      const cls = sig.delta > 0 ? 'pc-sb-sig-pos' : 'pc-sb-sig-neg';
      const fmt = sig.delta > 0 ? `+${sig.delta}` : `${sig.delta}`;
      return `<div class="pc-sb-signal ${cls}">
        <span class="pc-sb-sig-delta">${fmt}</span>
        <span class="pc-sb-sig-text">${_esc(sig.text)}</span>
      </div>`;
    }).join('');

    /* Raw OSM tags for bottom strip — skip addr:*, name, source, skip very long values */
    const SKIP_KEYS = new Set(['name','name:en','source','source:date','created_by']);
    const rawTagChips = Object.entries(tags)
      .filter(([k]) => !k.startsWith('addr:') && !SKIP_KEYS.has(k))
      .slice(0, 18)
      .map(([k, v]) => {
        const display = `${k}=${v.length > 22 ? v.slice(0, 22) + '\u2026' : v}`;
        const isLC = k.startsWith('abandoned') || k.startsWith('disused') || k === 'vacant';
        return `<span class="pc-bs-tag-chip${isLC ? ' pc-bs-tag-lc' : ''}">${_esc(display)}</span>`;
      }).join('');

    /* Top-strip edit metadata */
    let editMeta = '';
    if (el.timestamp) {
      const d = new Date(el.timestamp);
      const mo = d.toLocaleString('en-GB', { month: 'short', year: 'numeric' });
      editMeta = `v${el.version || '?'} \u00b7 ${mo}`;
      if (el.user) editMeta += ` \u00b7 ${el.user}`;
    } else if (el.version) {
      editMeta = `v${el.version}`;
    }
    const tagCount = Object.keys(tags).length;
    if (tagCount) editMeta += (editMeta ? ' \u00b7 ' : '') + `${tagCount} tags`;

    const lcHtml   = lifecycle
      ? `<span class="lifecycle-pill lp-${lifecycle}" style="font-size:11px;padding:3px 10px">${lifecycle.toUpperCase()}</span>`
      : '';
    const coordStr = lat !== null
      ? `${Math.abs(lat).toFixed(4)}\u00b0${lat >= 0 ? 'N' : 'S'}\u2002${Math.abs(lon).toFixed(4)}\u00b0${lon >= 0 ? 'E' : 'W'}`
      : '';
    const exportBg = lat !== null ? _svgExportBg(lat, lon, state.lastResults) : '';
    const barPct   = Math.max(3, sr.score);

    return `<div class="postcard" id="postcard-canvas">
      <div class="pc-map-layer" id="pc-map-layer"><div id="pc-leaflet-map"></div></div>
      <div class="pc-export-bg" id="pc-export-bg" style="display:none">${exportBg}</div>

      <div class="pc-top-strip">
        <span class="pc-top-brand">\u25a6 INDUSTRIAL ATLAS UK</span>
        ${editMeta ? `<span class="pc-top-meta">${_esc(editMeta)}</span>` : ''}
        <div class="pc-top-right">
          <span class="pc-sb-badge" style="background:${style.color}">${_esc(style.label)}</span>
          ${lcHtml}
        </div>
      </div>

      <div class="pc-sidebar">
        <div class="pc-sb-body">
          <div class="pc-sb-name">${_esc(name)}</div>
          ${addrParts.length ? `<div class="pc-sb-address">${addrParts.map(_esc).join('<br>')}</div>` : ''}
          ${tagHtml ? `<div class="pc-sb-rule"></div><div class="pc-sb-tags">${tagHtml}</div>` : ''}
          ${designBadgeHtml ? `<div class="pc-sb-rule"></div><div class="pc-sb-designations">${designBadgeHtml}</div>` : ''}
          ${sigHtml ? `<div class="pc-sb-rule"></div><div class="pc-sb-signals">${sigHtml}</div>` : ''}
        </div>
        <div class="pc-sb-minimap" id="pc-minimap-wrap">
          <div id="pc-minimap"></div>
        </div>
      </div>

      <div class="pc-bottom-strip">
        <div class="pc-bs-score">
          <span class="pc-bs-score-num" style="color:${sr.color}">${sr.score}</span>
          <div class="pc-bs-score-info">
            <span class="pc-bs-band" style="color:${sr.color}">${_esc(sr.classification)}</span>
            <div class="pc-bs-bar-wrap"><div class="pc-bs-bar" style="width:${barPct}%;background:${sr.color}"></div></div>
            <span class="pc-bs-conf">confidence ${sr.confidence}${sr.hasContext ? ' \u00b7 spatial' : ''}</span>
          </div>
        </div>
        ${rawTagChips ? `<div class="pc-bs-tags">${rawTagChips}</div>` : ''}
        <div class="pc-bs-location">
          ${coordStr ? `<div class="pc-bs-coords">${_esc(coordStr)}</div>` : ''}
          <div class="pc-bs-osmref">osm.org/${_esc(el.type)}/${el.id}</div>
          <div class="pc-bs-attr">\u00a9 OpenStreetMap contributors, ODbL</div>
        </div>
      </div>

    </div>`;
  }


  /* ---- Postcard: open modal ------------------------------ */
  function _openPostcard(el) {
    const sr  = Scoring.score(el, state.lastResults);
    const tags = el.tags || {};

    /* Coordinates */
    let lat = null, lon = null;
    if (el.type === 'node') { lat = el.lat; lon = el.lon; }
    else if (el.geometry && el.geometry.length) {
      lat = el.geometry.reduce((s, p) => s + p.lat, 0) / el.geometry.length;
      lon = el.geometry.reduce((s, p) => s + p.lon, 0) / el.geometry.length;
    }

    /* Zoom: show the building footprint at a sensible scale */
    let zoom = 17;
    if      (sr.areaM2 > 80000) zoom = 14;
    else if (sr.areaM2 > 15000) zoom = 15;
    else if (sr.areaM2 > 3000)  zoom = 16;

    document.querySelector('.postcard-modal-overlay')?.remove();

    const overlay   = document.createElement('div');
    overlay.className = 'postcard-modal-overlay';
    const canShare  = !!(navigator.share);

    overlay.innerHTML = `
      <div class="postcard-scale-wrapper" id="pc-scale-wrap">
        ${_buildPostcard(el, sr)}
      </div>
      <div class="postcard-modal-actions">
        <button class="postcard-modal-btn" id="pc-close">✕ Close</button>
        <button class="postcard-modal-btn pc-primary" id="pc-download">↓ Download PNG</button>
        ${canShare ? '<button class="postcard-modal-btn" id="pc-share">⎘ Share</button>' : ''}
      </div>`;

    document.body.appendChild(overlay);

    /* Scale to fit viewport */
    const wrap  = document.getElementById('pc-scale-wrap');
    const card  = document.getElementById('postcard-canvas');
    const scale = Math.min((window.innerWidth - 48) / 1200, (window.innerHeight - 110) / 630, 1);
    wrap.style.width  = `${Math.round(1200 * scale)}px`;
    wrap.style.height = `${Math.round(630  * scale)}px`;
    card.style.transformOrigin = 'top left';
    card.style.transform       = `scale(${scale})`;

    /* Spin up Leaflet map as the card background */
    let pcMap = null, miniMap = null;
    if (lat !== null) {
      const type      = Overpass.classify(tags);
      const markerCol = (MapModule.FEATURE_STYLES[type] || MapModule.FEATURE_STYLES.other).color;

      pcMap = L.map('pc-leaflet-map', {
        zoomControl: false, attributionControl: false,
        dragging: false, touchZoom: false,
        scrollWheelZoom: false, doubleClickZoom: false,
        boxZoom: false, keyboard: false,
      });

      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, crossOrigin: 'anonymous' }).addTo(pcMap);
      pcMap.setView([lat, lon], zoom);

      /* Site marker */
      L.marker([lat, lon], {
        icon: L.divIcon({
          className: '',
          html: `<div style="
            width:20px;height:20px;
            background:${markerCol};
            border:3px solid #fff;
            border-radius:50%;
            box-shadow:0 2px 10px rgba(0,0,0,0.7)
          "></div>`,
          iconSize: [20, 20], iconAnchor: [10, 10],
        }),
        interactive: false,
      }).addTo(pcMap);

      /* Polygon footprint if available */
      if (el.geometry && el.geometry.length >= 3 && (tags.building || tags.landuse)) {
        L.polygon(el.geometry.map(p => [p.lat, p.lon]), {
          color: markerCol, weight: 2,
          fillColor: markerCol, fillOpacity: 0.18,
          interactive: false,
        }).addTo(pcMap);
      }

      setTimeout(() => {
        if (!pcMap) return;
        pcMap.invalidateSize();
        pcMap.panBy([160, 0], { animate: false });
      }, 60);

      /* Minimap — zoomed-in context view in sidebar */
      let miniZoom = 18;
      if      (sr.areaM2 > 50000) miniZoom = 15;
      else if (sr.areaM2 > 10000) miniZoom = 16;
      else if (sr.areaM2 > 2000)  miniZoom = 17;

      miniMap = L.map('pc-minimap', {
        zoomControl: false, attributionControl: false,
        dragging: false, touchZoom: false,
        scrollWheelZoom: false, doubleClickZoom: false,
        boxZoom: false, keyboard: false,
      });
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19, crossOrigin: 'anonymous',
      }).addTo(miniMap);
      miniMap.setView([lat, lon], miniZoom);

      if (el.geometry && el.geometry.length >= 3 && (tags.building || tags.landuse)) {
        L.polygon(el.geometry.map(p => [p.lat, p.lon]), {
          color: markerCol, weight: 2.5,
          fillColor: markerCol, fillOpacity: 0.28,
          interactive: false,
        }).addTo(miniMap);
      }
      L.marker([lat, lon], {
        icon: L.divIcon({
          className: '',
          html: `<div style="width:10px;height:10px;background:${markerCol};border:2px solid #fff;border-radius:50%;box-shadow:0 1px 5px rgba(0,0,0,0.7)"></div>`,
          iconSize: [10,10], iconAnchor: [5,5],
        }),
        interactive: false,
      }).addTo(miniMap);

      setTimeout(() => { if (miniMap) miniMap.invalidateSize(); }, 80);
    }

    /* Capture: use CORS so live OSM tiles are included in PNG */
    async function _capture() {
      card.classList.add('pc-exporting');
      card.style.transform = 'none';
      try {
        await new Promise(r => setTimeout(r, 400)); /* let any pending tiles render */
        return await html2canvas(card, {
          width: 1200, height: 630,
          scale: 1,
          useCORS: true,
          allowTaint: false,
          backgroundColor: '#0d1208',
          logging: false,
          imageTimeout: 10000,
        });
      } finally {
        card.style.transform = `scale(${scale})`;
        card.classList.remove('pc-exporting');
      }
    }

    /* Events */
    document.getElementById('pc-close').addEventListener('click', () => {
      pcMap   && pcMap.remove();
      miniMap && miniMap.remove();
      overlay.remove();
    });
    overlay.addEventListener('click', e => {
      if (e.target === overlay) {
        pcMap   && pcMap.remove();
        miniMap && miniMap.remove();
        overlay.remove();
      }
    });

    document.getElementById('pc-download').addEventListener('click', async () => {
      const btn = document.getElementById('pc-download');
      btn.textContent = '… Rendering';
      btn.disabled = true;
      try {
        const canvas = await _capture();
        const link   = document.createElement('a');
        const slug   = (Overpass.displayName(el) || String(el.id)).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
        link.download = `industrial-atlas-${slug}.png`;
        link.href     = canvas.toDataURL('image/png');
        link.click();
      } catch (err) {
        console.error('[Postcard]', err);
        toast('Could not render: ' + err.message, 5000);
      } finally {
        btn.textContent = '↓ Download PNG';
        btn.disabled = false;
      }
    });

    const shareBtn = document.getElementById('pc-share');
    if (shareBtn) {
      shareBtn.addEventListener('click', async () => {
        shareBtn.textContent = '… Rendering';
        shareBtn.disabled    = true;
        try {
          const canvas = await _capture();
          canvas.toBlob(async blob => {
            const dname = Overpass.displayName(el) || 'site';
            const file  = new File([blob], `industrial-atlas-${el.id}.png`, { type: 'image/png' });
            if (navigator.canShare?.({ files: [file] })) {
              await navigator.share({
                title: `Industrial Atlas UK — ${dname}`,
                text:  `Score ${sr.score} · ${sr.classification}`,
                files: [file],
              });
            } else {
              toast('File sharing not supported — use Download instead');
            }
          }, 'image/png');
        } catch (err) {
          if (err.name !== 'AbortError') toast('Share failed: ' + err.message, 4000);
        } finally {
          shareBtn.textContent = '⎘ Share';
          shareBtn.disabled    = false;
        }
      });
    }
  }

  /* ---- Score / lifecycle chips -------------------------- */
  function _syncChips() {
    qa('.score-chip').forEach(btn => {
      const isLC  = btn.dataset.lifecycle === '1';
      const isMin = btn.dataset.min !== undefined;
      if (isLC) {
        btn.classList.toggle('active', state.lifecycleOnly);
      } else if (isMin) {
        btn.classList.toggle('active', !state.lifecycleOnly && parseInt(btn.dataset.min, 10) === state.minScore);
      }
    });
  }

  function _syncSizeChips() {
    qa('.size-chip').forEach(btn => {
      const min = parseInt(btn.dataset.minArea, 10);
      const max = btn.dataset.maxArea === 'Infinity' ? Infinity : parseFloat(btn.dataset.maxArea);
      btn.classList.toggle('active', min === state.areaMin && max === state.areaMax);
    });
  }

  function _fmtArea(m2) {
    if (m2 >= 10000) return `${(m2 / 10000).toFixed(1)} ha`;
    return `${Math.round(m2).toLocaleString()} m²`;
  }

  /* ---- Coverage region detection ----------------------- */
  function _getCoverageRegion() {
    const b = MapModule.getBounds();
    if (!b) return 'england';
    const c = b.getCenter();
    if (c.lat > 55.8) return 'scotland';
    if (c.lat > 54.0 && c.lng < -5.5) return 'northern-ireland';
    return 'england';
  }

  function _updatePlanningCoverageWarning() {
    const warn = $('planning-coverage-warning');
    if (!warn) return;
    const region = _getCoverageRegion();
    warn.hidden = (region === 'england');
  }

  /* ---- External dataset layer toggles ---------------------- */
  let _strategyZonesGroup = null;

  async function _toggleExtLayer(value, enabled) {
    const map = MapModule.getMap();
    if (!map) return;

    if (value === 'fsa') {
      if (enabled) {
        toast('Loading FSA food industry data…', 2000);
        const n = await FSALayer.show(map);
        if (n) toast(`${n.toLocaleString()} FSA establishments loaded`);
        else   toast('FSA data unavailable');
      } else {
        FSALayer.hide(map);
      }

    } else if (value === 'epr') {
      if (enabled) {
        toast('Loading EA permitted sites data…', 2000);
        const n = await EPRLayer.show(map);
        if (n) toast(`${n.toLocaleString()} EA permitted sites loaded`);
        else   toast('EPR data not yet available — run scripts/process_epr.py first', 5000);
      } else {
        EPRLayer.hide(map);
      }

    } else if (value === 'inspire') {
      if (enabled) {
        toast('Loading property boundaries…', 2000);
        const n = await INSPIRELayer.show(map);
        if (n) toast(`${n.toLocaleString()} registered title polygons loaded`);
      } else {
        INSPIRELayer.hide(map);
      }

    } else if (value === 'strategy-zones') {
      if (enabled) {
        if (!_strategyZonesGroup) {
          _strategyZonesGroup = await StrategyZones.addToMap(map);
        } else {
          _strategyZonesGroup.addTo(map);
        }
        if (_strategyZonesGroup) toast('Strategy Zones & Freeports loaded');
        else                     toast('Strategy zone data unavailable');
      } else {
        if (_strategyZonesGroup) map.removeLayer(_strategyZonesGroup);
      }
    }
  }

  /* ---- Score confirmation badges (injected after async loads) */
  function _addScoreBadge(cls, text) {
    const el = $('score-extra-badges');
    if (!el) return;
    const b = document.createElement('span');
    b.className = `score-conf-badge ${cls}`;
    b.textContent = text;
    el.appendChild(b);
  }

  /* ---- Name formatter (Companies House "SURNAME, Forename" → "Forename Surname") */
  function _fmtName(raw) {
    if (!raw) return '';
    const m = raw.match(/^([^,]+),\s*(.+)$/);
    if (m) return `${m[2].trim()} ${m[1].trim().charAt(0) + m[1].trim().slice(1).toLowerCase()}`;
    return raw;
  }

  /* ---- HTML escape -------------------------------------- */
  function _esc(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* ---- File:// protocol warning ------------------------- */
  function _checkProtocol() {
    if (window.location.protocol !== 'file:') return;
    const banner = document.createElement('div');
    banner.id = 'file-warning';
    banner.innerHTML =
      '<strong>Serve from a local HTTP server for queries and map tiles to work.</strong> ' +
      'Open a terminal in this folder and run: ' +
      '<code>python3 -m http.server 8000</code> then open ' +
      '<a href="http://localhost:8000" target="_blank">http://localhost:8000</a>. ' +
      '<button onclick="this.parentNode.remove()" style="margin-left:12px;cursor:pointer;' +
      'background:transparent;border:1px solid #aaa;padding:2px 8px;font-family:inherit">dismiss</button>';
    document.body.appendChild(banner);
  }

  /* ---- Init --------------------------------------------- */
  function init() {
    _checkProtocol();
    VOA.preload();
    VOAGeo.preload();

    MapModule.init({
      onFeatureClick: _showFeatureDetail,
      onMapMove:      (_bounds, _zoom) => { _updateRunButton(); _updatePlanningCoverageWarning(); },
      onAreaDrawn:    _showAnalysis,
    });

    _loadURLState();
    _updateRunButton();

    /* Filters */
    qa('input[name="filter"]').forEach(cb => {
      cb.addEventListener('change', () => {
        state.currentMode = null;
        qa('.mode-btn').forEach(b => b.classList.remove('active'));
        _updateRunButton();
      });
    });

    /* Mode buttons */
    qa('.mode-btn').forEach(btn => {
      btn.addEventListener('click', () => _activateMode(btn.dataset.mode));
    });

    /* Base layer */
    qa('.base-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        qa('.base-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        MapModule.setBaseLayer(btn.dataset.layer);
      });
    });

    /* Run */
    $('btn-run-query').addEventListener('click', runQuery);

    /* Presets */
    qa('.preset-btn').forEach(btn => {
      btn.addEventListener('click', () => MapModule.zoomToPreset(btn.dataset.preset));
    });

    /* Search input */
    const searchInput = $('search-input');
    const suggestions = $('search-suggestions');

    searchInput.addEventListener('input', () => {
      clearTimeout(_searchDebounce);
      const q = searchInput.value.trim();
      if (q.length < 3) { suggestions.hidden = true; return; }
      _searchDebounce = setTimeout(async () => {
        const results = await _geocode(q);
        _renderSuggestions(results);
      }, 320);
    });

    searchInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        suggestions.hidden = true;
        _doSearch(searchInput.value.trim());
      }
      if (e.key === 'Escape') suggestions.hidden = true;
    });

    $('search-btn').addEventListener('click', () => {
      suggestions.hidden = true;
      _doSearch(searchInput.value.trim());
    });

    document.addEventListener('click', e => {
      if (!e.target.closest('.search-wrapper') && !e.target.closest('.suggestions')) {
        suggestions.hidden = true;
      }
    });

    /* Area analysis */
    $('btn-analyse').addEventListener('click', () => {
      if (!state.analysisReady || state.lastResults.length === 0) {
        toast('Run a query first, then draw an analysis area');
        return;
      }
      toast('Drag to draw a rectangle on the map', 3000);
      MapModule.enableDraw();
    });

    /* Planning overlay coverage warning */
    qa('input[name="planning-overlay"]').forEach(cb => {
      cb.addEventListener('change', _updatePlanningCoverageWarning);
    });

    /* External dataset layer toggles */
    qa('input[name="ext-layer"]').forEach(cb => {
      cb.addEventListener('change', () => _toggleExtLayer(cb.value, cb.checked));
    });

    /* VOA Gap Finder toggle */
    $('btn-gap-finder').addEventListener('click', () => {
      state.gapFinderActive = !state.gapFinderActive;
      $('btn-gap-finder').classList.toggle('active', state.gapFinderActive);
      $('btn-gap-finder').textContent = state.gapFinderActive ? '⬡ Gap Finder ON' : '⬡ VOA Gap Finder';
      if (state.gapFinderActive) {
        if (!VOAGeo.isAvailable()) {
          toast('Loading VOA spatial data — this may take a moment…', 3000);
        }
        _runGapFinder();
      } else {
        MapModule.clearVOAGapMarkers();
        state.lastGapResult = null;
        if ($('panel-gap').hidden === false || $('panel-gap-detail').hidden === false) {
          showPanel('panel-welcome');
        }
      }
    });

    $('btn-back-to-gaps').addEventListener('click', () => showPanel('panel-gap'));

    /* CSV export */
    $('btn-export-csv').addEventListener('click', _exportCSV);

    /* Clear */
    $('btn-clear').addEventListener('click', () => {
      MapModule.clearFeatures();
      MapModule.clearPlanningFeatures();
      MapModule.clearVOAGapMarkers();
      MapModule.clearDraw();
      state.lastResults    = [];
      state.planningResult = null;
      state.lastGapResult  = null;
      state.analysisReady  = false;
      state.minScore       = 0;
      state.lifecycleOnly  = false;
      state.areaMin        = 0;
      state.areaMax        = Infinity;
      state.sortByArea     = false;
      state.sortByScore    = false;
      $('btn-sort-score').classList.remove('active');
      $('btn-sort-area').classList.remove('active');
      $('btn-sort-score').textContent = '↕ Score';
      $('btn-sort-area').textContent  = '↕ Area';
      $('score-chips').hidden = true;
      $('size-chips').hidden  = true;
      showPanel('panel-welcome');
      history.replaceState(null, '', window.location.pathname);
    });

    /* Share */
    $('btn-share').addEventListener('click', () => {
      _saveURLState();
      const url = window.location.href;
      if (navigator.clipboard) {
        navigator.clipboard.writeText(url)
          .then(() => toast('Share link copied to clipboard'))
          .catch(() => window.prompt('Copy this link:', url));
      } else {
        window.prompt('Copy this link:', url);
      }
    });

    /* Panel close / back */
    qa('.panel-close').forEach(btn => {
      btn.addEventListener('click', () => {
        const t = btn.dataset.close;
        if      (t === 'feature')    showPanel('panel-results');
        else if (t === 'gap-detail') showPanel('panel-gap');
        else                         showPanel('panel-welcome');
      });
    });

    $('btn-back-to-results').addEventListener('click', () => showPanel('panel-results'));

    /* Score / lifecycle chips */
    qa('.score-chip').forEach(btn => {
      btn.addEventListener('click', () => {
        if (btn.dataset.lifecycle === '1') {
          state.lifecycleOnly = !state.lifecycleOnly;
          if (state.lifecycleOnly) state.minScore = 0;
        } else {
          state.lifecycleOnly = false;
          state.minScore = parseInt(btn.dataset.min, 10);
        }
        _syncChips();
        _renderResultsList(state.lastResults);
      });
    });

    /* Size chips */
    qa('.size-chip').forEach(btn => {
      btn.addEventListener('click', () => {
        state.areaMin = parseInt(btn.dataset.minArea, 10);
        state.areaMax = btn.dataset.maxArea === 'Infinity' ? Infinity : parseFloat(btn.dataset.maxArea);
        _syncSizeChips();
        _renderResultsList(state.lastResults);
      });
    });

    /* Sort by score toggle */
    $('btn-sort-score').addEventListener('click', () => {
      state.sortByScore = !state.sortByScore;
      if (state.sortByScore) state.sortByArea = false;
      $('btn-sort-score').classList.toggle('active', state.sortByScore);
      $('btn-sort-score').textContent = state.sortByScore ? '↓ Score' : '↕ Score';
      $('btn-sort-area').classList.remove('active');
      $('btn-sort-area').textContent = '↕ Area';
      _renderResultsList(state.lastResults);
    });

    /* Sort by area toggle */
    $('btn-sort-area').addEventListener('click', () => {
      state.sortByArea = !state.sortByArea;
      if (state.sortByArea) state.sortByScore = false;
      $('btn-sort-area').classList.toggle('active', state.sortByArea);
      $('btn-sort-area').textContent = state.sortByArea ? '↓ Area' : '↕ Area';
      $('btn-sort-score').classList.remove('active');
      $('btn-sort-score').textContent = '↕ Score';
      _renderResultsList(state.lastResults);
    });

    /* Mobile sidebar toggles */
    const mobL = $('mob-toggle-left');
    const mobR = $('mob-toggle-right');
    if (mobL) {
      mobL.addEventListener('click', () => {
        $('sidebar-left').classList.toggle('open');
        $('sidebar-right').classList.remove('open');
      });
    }
    if (mobR) {
      mobR.addEventListener('click', () => {
        $('sidebar-right').classList.toggle('open');
        $('sidebar-left').classList.remove('open');
      });
    }
  }

  return { init };
})();

document.addEventListener('DOMContentLoaded', () => App.init());
