'use strict';

/* scoring.js — Opportunity scoring engine
   Estimates how worth investigating a site is for productive or underutilised use.
   OSM data only. Does not detect or assert vacancy. All scoring is probabilistic. */

const Scoring = (() => {

  const BANDS = [
    { max: 20,  label: 'Active Industrial Site',       code: 'active'    },
    { max: 40,  label: 'Stable Productive Site',       code: 'stable'    },
    { max: 60,  label: 'Mixed / Unclear Activity',     code: 'mixed'     },
    { max: 80,  label: 'Underutilisation Candidate',   code: 'candidate' },
    { max: 100, label: 'High Opportunity Candidate',   code: 'high'      },
  ];

  const BAND_COLORS = {
    active:    '#2d6a4f',
    stable:    '#4a8060',
    mixed:     '#9a7a10',
    candidate: '#c06820',
    high:      '#a82820',
  };

  /* ---- Geometry utilities ---------------------------------- */

  function _distM(lat1, lon1, lat2, lon2) {
    const R  = 6371000;
    const φ1 = lat1 * Math.PI / 180;
    const φ2 = lat2 * Math.PI / 180;
    const Δφ = (lat2 - lat1) * Math.PI / 180;
    const Δλ = (lon2 - lon1) * Math.PI / 180;
    const a  = Math.sin(Δφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(Δλ/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  }

  function _polyAreaM2(geometry) {
    if (!geometry || geometry.length < 3) return 0;
    let area = 0;
    const n = geometry.length;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      area += geometry[i].lon * geometry[j].lat;
      area -= geometry[j].lon * geometry[i].lat;
    }
    const avgLat = geometry.reduce((s, p) => s + p.lat, 0) / n;
    const latM   = 111320;
    const lonM   = 111320 * Math.cos(avgLat * Math.PI / 180);
    return Math.abs(area) / 2 * latM * lonM;
  }

  function _centroid(el) {
    if (el.type === 'node') return { lat: el.lat, lon: el.lon };
    const g = el.geometry;
    if (!g || !g.length) return null;
    let lat = 0, lon = 0;
    g.forEach(p => { lat += p.lat; lon += p.lon; });
    return { lat: lat / g.length, lon: lon / g.length };
  }

  function _hasPrefix(tags, prefix) {
    return Object.keys(tags).some(k => k.startsWith(prefix + ':'));
  }

  function _ageYears(ts) {
    if (!ts) return null;
    return (Date.now() - new Date(ts).getTime()) / (365.25 * 24 * 3600 * 1000);
  }

  function _fmtArea(m2) {
    if (m2 >= 10000) return `${(m2 / 10000).toFixed(1)} ha`;
    return `${Math.round(m2).toLocaleString()} m²`;
  }

  /* ---- Core scoring --------------------------------------- */

  function score(element, allElements, designations) {
    const tags    = element.tags || {};
    const signals = [];
    let s = 0;

    /* 1 — Building / land type baseline */
    if (tags.building === 'industrial') {
      s += 15; signals.push({ delta: +15, text: 'building=industrial' });
    }
    if (tags.building === 'warehouse') {
      s += 10; signals.push({ delta: +10, text: 'building=warehouse' });
    }
    if (tags.building === 'workshop') {
      s += 20; signals.push({ delta: +20, text: 'building=workshop' });
    }
    if (tags.building === 'arch') {
      s += 15; signals.push({ delta: +15, text: 'railway arch structure' });
    }
    if (tags.landuse === 'industrial') {
      s += 10; signals.push({ delta: +10, text: 'landuse=industrial' });
    }
    if (tags.landuse === 'commercial') {
      s += 5; signals.push({ delta: +5, text: 'landuse=commercial' });
    }

    const isBuilding = !!(tags.building);
    const isLanduse  = !!(tags.landuse);

    /* 2 — Site scale (calculated from polygon geometry)
           Buildings and landuse areas scored differently:
           large building = high opportunity signal;
           large landuse area = land designation, weaker signal alone */
    let areaM2 = 0;
    if (element.geometry && element.geometry.length >= 3) {
      areaM2 = _polyAreaM2(element.geometry);
    }

    if (isBuilding && areaM2 > 0) {
      let areaDelta = 0, areaText = '';
      if      (areaM2 > 25000) { areaDelta = 30; areaText = `major building — ${_fmtArea(areaM2)}`; }
      else if (areaM2 >  5000) { areaDelta = 20; areaText = `large building — ${_fmtArea(areaM2)}`; }
      else if (areaM2 >   500) { areaDelta = 10; areaText = `medium building — ${_fmtArea(areaM2)}`; }
      else                     { areaDelta =  4; areaText = `small unit — ${_fmtArea(areaM2)}`; }
      s += areaDelta;
      signals.push({ delta: areaDelta, text: areaText });
    } else if (isLanduse && areaM2 > 0) {
      /* Landuse area: large designation is a weaker but real signal */
      if      (areaM2 > 100000) { s += 15; signals.push({ delta: +15, text: `major land designation — ${_fmtArea(areaM2)}` }); }
      else if (areaM2 >  10000) { s += 8;  signals.push({ delta: +8,  text: `industrial land designation — ${_fmtArea(areaM2)}` }); }
    }

    /* 3 — Lifecycle / explicit vacancy (rare but highest value) */
    const abandoned = tags.abandoned === 'yes' || _hasPrefix(tags, 'abandoned');
    const disused   = tags.disused   === 'yes' || _hasPrefix(tags, 'disused');
    const vacant    = tags.vacant    === 'yes';

    if (abandoned) {
      s += 60; signals.push({ delta: +60, text: 'abandoned designation in OSM data' });
    } else if (disused) {
      s += 50; signals.push({ delta: +50, text: 'disused designation in OSM data' });
    } else if (vacant) {
      s += 50; signals.push({ delta: +50, text: 'vacant=yes in OSM data' });
    }

    /* 4 — Activity penalties (evidence of active occupation) */
    if (tags.craft) {
      s -= 15; signals.push({ delta: -15, text: `active craft use — ${tags.craft}` });
    }
    if (tags.industrial && tags.industrial !== 'yes') {
      s -= 20; signals.push({ delta: -20, text: `active industrial process — ${tags.industrial}` });
    }
    if (tags.man_made === 'works') {
      s -= 10; signals.push({ delta: -10, text: 'active works (man_made=works)' });
    }
    if (tags.shop) {
      s -= 10; signals.push({ delta: -10, text: `retail occupancy — shop=${tags.shop}` });
    }
    if (tags.office) {
      s -= 5;  signals.push({ delta: -5,  text: 'office occupancy present' });
    }
    if (tags.amenity === 'makerspace' || tags.leisure === 'hackerspace') {
      s -= 12; signals.push({ delta: -12, text: 'active maker/hack space' });
    }
    if (tags.operator) {
      s -= 10; signals.push({ delta: -10, text: `named operator: ${tags.operator.slice(0,40)}` });
    }
    if (tags.brand) {
      s -= 5;  signals.push({ delta: -5,  text: `brand identity present (${tags.brand})` });
    }
    if (tags.opening_hours) {
      s -= 5;  signals.push({ delta: -5,  text: 'opening hours recorded' });
    }
    if (Object.keys(tags).some(k => k.startsWith('addr:'))) {
      s -= 5;  signals.push({ delta: -5,  text: 'formal address registered' });
    }

    /* 5 — OSM data age (from out meta timestamp) */
    if (element.timestamp) {
      const age = _ageYears(element.timestamp);
      if (age !== null) {
        if (age > 7) {
          const d = Math.min(15, Math.round(age));
          s += d; signals.push({ delta: +d, text: `OSM record ${Math.round(age)} years without update` });
        } else if (age > 4) {
          s += 5; signals.push({ delta: +5, text: `OSM data ${Math.round(age)} years old` });
        }
      }
    }

    /* 6 — Absence signals (sparse metadata = higher uncertainty = higher investigation value) */
    if (!tags.name && isBuilding) {
      s += 5;  signals.push({ delta: +5, text: 'no site name recorded' });
    }
    if (!tags.operator) {
      s += 5;  signals.push({ delta: +5, text: 'no operator recorded' });
    }
    const hasContact = tags.website || tags.phone || tags.email ||
                       Object.keys(tags).some(k => k.startsWith('contact:'));
    if (!hasContact) {
      s += 3;  signals.push({ delta: +3, text: 'no contact information' });
    }
    if (tags.fixme) {
      s += 5;  signals.push({ delta: +5, text: 'fixme tag — data quality uncertain' });
    }
    if (tags.note) {
      const note = tags.note.toLowerCase();
      if (note.includes('clos') || note.includes('vacan') || note.includes('empty') || note.includes('demolish')) {
        s += 15; signals.push({ delta: +15, text: `note tag suggests closure/vacancy` });
      }
    }

    /* 7 — Context: spatial analysis against loaded elements
           Only runs when allElements supplied. No re-query.
           Counts active and industrial features within radii. */
    let contextDelta = 0;

    if (allElements && allElements.length > 1) {
      const c = _centroid(element);
      if (c) {
        let active100 = 0, industrial250 = 0, any500 = 0;

        for (const other of allElements) {
          if (other.id === element.id) continue;
          const oc = _centroid(other);
          if (!oc) continue;
          const d = _distM(c.lat, c.lon, oc.lat, oc.lon);
          const ot = other.tags || {};

          if (d < 100) {
            if (ot.craft || ot.shop || ot.operator ||
                (ot.industrial && ot.industrial !== 'yes')) active100++;
          }
          if (d < 250) {
            if (ot.building === 'industrial' || ot.building === 'warehouse' ||
                ot.building === 'workshop'   || ot.landuse  === 'industrial') industrial250++;
          }
          if (d < 500) any500++;
        }

        if (active100 >= 4) {
          contextDelta -= 20;
          signals.push({ delta: -20, text: `dense active cluster — ${active100} active uses within 100m` });
        } else if (active100 >= 1) {
          contextDelta -= 10;
          signals.push({ delta: -10, text: `${active100} active site${active100 > 1 ? 's' : ''} within 100m` });
        }

        if (industrial250 === 0 && any500 < 2) {
          contextDelta += 15;
          signals.push({ delta: +15, text: 'isolated — no industrial cluster in loaded area' });
        } else if (industrial250 > 8) {
          contextDelta -= 10;
          signals.push({ delta: -10, text: `established industrial district — ${industrial250} buildings within 250m` });
        }
      }
    }

    s += contextDelta;

    /* 7.5 — Official planning designations */
    if (designations && designations.length) {
      for (const { dataset, feature } of designations) {
        if (dataset === 'listed-building') {
          const g = (feature.grade || '').toLowerCase();
          if (g === 'grade i' || g.includes('grade i*')) {
            s += 20; signals.push({ delta: +20, text: `Grade I listed building — highest heritage protection` });
          } else if (g.includes('ii*')) {
            s += 16; signals.push({ delta: +16, text: `Grade II* listed building — significant heritage protection` });
          } else {
            s += 12; signals.push({ delta: +12, text: `Grade II listed building — statutory heritage protection` });
          }
        } else if (dataset === 'conservation-area') {
          s += 8;
          const name = feature.name ? ` (${feature.name})` : '';
          signals.push({ delta: +8, text: `within conservation area${name}` });
        } else if (dataset === 'article-4-direction-area') {
          s += 12;
          signals.push({ delta: +12, text: `Article 4 direction — permitted development rights removed` });
        } else if (dataset === 'brownfield-land') {
          s += 10;
          signals.push({ delta: +10, text: `on brownfield register — previously developed, development pressure likely` });
        } else if (dataset === 'scheduled-monument') {
          s += 18;
          signals.push({ delta: +18, text: `scheduled monument — highest statutory protection, change of use complex` });
        } else if (dataset === 'tree-preservation-order') {
          s += 5;
          signals.push({ delta: +5, text: `tree preservation order — may constrain site development` });
        } else if (dataset === 'flood-risk-zone') {
          const level = feature.floodLevel;
          if (level === '3') {
            s -= 15; signals.push({ delta: -15, text: `Flood Zone 3 — high flood risk, significant constraint for ground-floor use` });
          } else if (level === '2') {
            s -= 6;  signals.push({ delta: -6,  text: `Flood Zone 2 — medium flood risk, check insurance and planning conditions` });
          }
        }
      }
    }

    /* 8 — Clamp and classify */
    const final = Math.max(0, Math.min(100, Math.round(s)));
    const band  = BANDS.find(b => final <= b.max) || BANDS[BANDS.length - 1];

    /* 9 — Confidence: how much data exists to trust the score */
    const tagCount = Object.keys(tags).length;
    let conf = 30;
    if (tagCount >= 12) conf += 35;
    else if (tagCount >= 6) conf += 22;
    else if (tagCount >= 2) conf += 10;
    if (tags.name)                       conf += 8;
    if (tags.operator)                   conf += 8;
    if (abandoned || disused || vacant)  conf += 18;
    if (element.timestamp)               conf += 5;
    if (areaM2 > 0)                      conf += 5;
    if (tagCount <= 1)                   conf -= 20;
    if (!allElements || !allElements.length) conf -= 5; /* no context available */
    if (designations && designations.length) conf += 10; /* official data cross-referenced */
    conf = Math.max(5, Math.min(100, Math.round(conf)));

    return {
      score:          final,
      confidence:     conf,
      classification: band.label,
      code:           band.code,
      color:          BAND_COLORS[band.code],
      signals:        signals.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)),
      hasContext:     allElements && allElements.length > 1,
      areaM2,
    };
  }

  function bandForScore(s) {
    return BANDS.find(b => s <= b.max) || BANDS[BANDS.length - 1];
  }

  return { score, BANDS, BAND_COLORS, bandForScore };
})();
