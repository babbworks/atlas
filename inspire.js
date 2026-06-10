'use strict';

/* inspire.js — HM Land Registry INSPIRE Index Polygons overlay
   Fetches registered property title boundaries by bbox via the public WFS.
   Endpoint: https://inspire.landregistry.gov.uk/inspire/ows
   CRS: EPSG:27700 (British National Grid) — converted to WGS84 for Leaflet.
   Free / open, no auth. OGL licence. England & Wales only. */

const INSPIRELayer = (() => {

  /* Cloudflare Worker proxy URL — fill in after deploying inspire-proxy/.
     Run:  cd inspire-proxy && npx wrangler deploy
     Then replace the placeholder below with your assigned workers.dev URL.
     For local dev run `npx wrangler dev` in inspire-proxy/ and use http://localhost:8787 */
  const WFS_BASE = 'https://inspire-proxy.REPLACE_WITH_YOUR_SUBDOMAIN.workers.dev';

  const MAX_FEATURES = 2000;

  let _group = null;
  let _map   = null;

  /* ---- BNG (EPSG:27700) → WGS84 (EPSG:4326) ----------------
     Helmert transformation via the OSGB standard approximate formula.
     Accurate to ~5m — sufficient for polygon outlines. */
  function _bngToWgs84(e, n) {
    const a = 6377563.396, b = 6356256.909;
    const F0 = 0.9996012717;
    const lat0 = 49 * Math.PI / 180, lon0 = -2 * Math.PI / 180;
    const N0 = -100000, E0 = 400000;
    const e2 = 1 - (b * b) / (a * a);
    const n_ = (a - b) / (a + b);

    let lat = lat0, M = 0;
    do {
      lat = (n - N0 - M) / (a * F0) + lat;
      const M1 = (1 + n_ + (5/4)*n_*n_ + (5/4)*n_*n_*n_) * (lat - lat0);
      const M2 = (3*n_ + 3*n_*n_ + (21/8)*n_*n_*n_) * Math.sin(lat - lat0) * Math.cos(lat + lat0);
      const M3 = ((15/8)*n_*n_ + (15/8)*n_*n_*n_) * Math.sin(2*(lat - lat0)) * Math.cos(2*(lat + lat0));
      const M4 = (35/24)*n_*n_*n_ * Math.sin(3*(lat - lat0)) * Math.cos(3*(lat + lat0));
      M = b * F0 * (M1 - M2 + M3 - M4);
    } while (Math.abs(n - N0 - M) >= 0.00001);

    const cosLat = Math.cos(lat), sinLat = Math.sin(lat), tanLat = Math.tan(lat);
    const nu  = a * F0 / Math.sqrt(1 - e2 * sinLat * sinLat);
    const rho = a * F0 * (1 - e2) / Math.pow(1 - e2 * sinLat * sinLat, 1.5);
    const eta2 = nu / rho - 1;

    const VII  = tanLat / (2 * rho * nu);
    const VIII = tanLat / (24 * rho * nu * nu * nu) * (5 + 3*tanLat*tanLat + eta2 - 9*tanLat*tanLat*eta2);
    const IX   = tanLat / (720 * rho * Math.pow(nu, 5)) * (61 + 90*tanLat*tanLat + 45*Math.pow(tanLat, 4));
    const X    = 1 / (cosLat * nu);
    const XI   = 1 / (cosLat * 6 * nu * nu * nu) * (nu / rho + 2*tanLat*tanLat);
    const XII  = 1 / (cosLat * 120 * Math.pow(nu, 5)) * (5 + 28*tanLat*tanLat + 24*Math.pow(tanLat, 4));
    const XIIA = 1 / (cosLat * 5040 * Math.pow(nu, 7)) * (61 + 662*tanLat*tanLat + 1320*Math.pow(tanLat, 4) + 720*Math.pow(tanLat, 6));

    const dE = e - E0;
    const latWGS = lat - VII*dE*dE + VIII*Math.pow(dE,4) - IX*Math.pow(dE,6);
    const lonWGS = lon0 + X*dE - XI*Math.pow(dE,3) + XII*Math.pow(dE,5) - XIIA*Math.pow(dE,7);

    return [latWGS * 180 / Math.PI, lonWGS * 180 / Math.PI];
  }

  /* ---- WGS84 bbox → BNG bbox for WFS request --------------- */
  function _wgs84ToBng(lat, lon) {
    /* Approximate inverse — sufficient for bbox padding */
    const a = 6378137, f = 1/298.257223563;
    const b = a*(1-f), e2 = 1-(b*b)/(a*a);
    const φ = lat*Math.PI/180, λ = lon*Math.PI/180;
    const sinφ = Math.sin(φ), cosφ = Math.cos(φ);
    const ν = a/Math.sqrt(1-e2*sinφ*sinφ);

    /* WGS84 → OSGB36 Helmert (approximate) */
    const dX=-446.448, dY=125.157, dZ=-542.060, s=20.4894e-6;
    const rx=-0.1502*Math.PI/(180*3600), ry=-0.2470*Math.PI/(180*3600), rz=-0.8421*Math.PI/(180*3600);
    const X=(ν+0)*cosφ*Math.cos(λ), Y=(ν+0)*cosφ*Math.sin(λ), Z=(ν*(1-e2))*sinφ;
    const X2=X+dX+X*s-Z*ry+Y*rz;
    const Y2=Y+dY+Y*s-X*rz+Z*rx;
    const Z2=Z+dZ+Z*s-Y*rx+X*ry;

    const a2=6377563.396, b2=6356256.909, e2b=1-(b2*b2)/(a2*a2);
    const p=Math.sqrt(X2*X2+Y2*Y2);
    let φ2=Math.atan2(Z2,p*(1-e2b)), φ2prev;
    do {
      φ2prev=φ2;
      const sinφ2=Math.sin(φ2);
      const ν2=a2/Math.sqrt(1-e2b*sinφ2*sinφ2);
      φ2=Math.atan2(Z2+e2b*ν2*Math.sin(φ2),p);
    } while(Math.abs(φ2-φ2prev)>1e-10);

    const λ2=Math.atan2(Y2,X2);
    const sinφ2f=Math.sin(φ2);
    const ν2f=a2/Math.sqrt(1-e2b*sinφ2f*sinφ2f);
    const h=(p/Math.cos(φ2))-ν2f;

    /* BNG projection */
    const F0=0.9996012717, φ0=49*Math.PI/180, λ0=-2*Math.PI/180;
    const N0=-100000, E0=400000;
    const n_=(a2-b2)/(a2+b2);
    const ν3=a2*F0/Math.sqrt(1-e2b*sinφ2f*sinφ2f);
    const ρ3=a2*F0*(1-e2b)/Math.pow(1-e2b*sinφ2f*sinφ2f,1.5);
    const η2=ν3/ρ3-1;
    const tanφ2=Math.tan(φ2), cosφ2=Math.cos(φ2);
    const dλ=λ2-λ0;

    const M1=(1+n_+(5/4)*n_*n_+(5/4)*n_*n_*n_)*(φ2-φ0);
    const M2=(3*n_+3*n_*n_+(21/8)*n_*n_*n_)*Math.sin(φ2-φ0)*Math.cos(φ2+φ0);
    const M3=((15/8)*n_*n_+(15/8)*n_*n_*n_)*Math.sin(2*(φ2-φ0))*Math.cos(2*(φ2+φ0));
    const M4=(35/24)*n_*n_*n_*Math.sin(3*(φ2-φ0))*Math.cos(3*(φ2+φ0));
    const M=b2*F0*(M1-M2+M3-M4);

    const I_=M+N0;
    const II_=ν3/2*sinφ2f*cosφ2;
    const III_=ν3/24*sinφ2f*Math.pow(cosφ2,3)*(5-tanφ2*tanφ2+9*η2);
    const IIIA_=ν3/720*sinφ2f*Math.pow(cosφ2,5)*(61-58*tanφ2*tanφ2+Math.pow(tanφ2,4));
    const IV_=ν3*cosφ2;
    const V_=ν3/6*Math.pow(cosφ2,3)*(ν3/ρ3-tanφ2*tanφ2);
    const VI_=ν3/120*Math.pow(cosφ2,5)*(5-18*tanφ2*tanφ2+Math.pow(tanφ2,4)+14*η2-58*tanφ2*tanφ2*η2);

    const N_=I_+II_*dλ*dλ+III_*Math.pow(dλ,4)+IIIA_*Math.pow(dλ,6);
    const E_=E0+IV_*dλ+V_*Math.pow(dλ,3)+VI_*Math.pow(dλ,5);

    return [Math.round(E_), Math.round(N_)];
  }

  /* ---- Parse GML polygon coordinates ---------------------- */
  function _parseGML(xmlText) {
    const parser = new DOMParser();
    const doc    = parser.parseFromString(xmlText, 'text/xml');

    /* Check for service errors */
    const err = doc.querySelector('ExceptionReport, ServiceException');
    if (err) throw new Error(err.textContent.trim().slice(0, 120));

    const features = [];
    const members  = doc.querySelectorAll('featureMember, member');

    for (const member of members) {
      const polygons = [];

      /* Each INSPIRE polygon may have outer ring + optional inner rings */
      const geoms = member.querySelectorAll('Polygon, MultiSurface Surface');
      for (const geom of geoms) {
        const rings = [];

        for (const ring of geom.querySelectorAll('exterior, outerBoundaryIs, interior, innerBoundaryIs')) {
          const coordsEl = ring.querySelector('posList, coordinates');
          if (!coordsEl) continue;
          const raw   = coordsEl.textContent.trim();
          const nums  = raw.split(/[\s,]+/).map(Number).filter(x => !isNaN(x));
          const latlngs = [];
          /* GML posList: E N E N … (BNG) */
          for (let i = 0; i + 1 < nums.length; i += 2) {
            latlngs.push(_bngToWgs84(nums[i], nums[i + 1]));
          }
          if (latlngs.length >= 3) rings.push(latlngs);
        }
        if (rings.length) polygons.push(rings);
      }

      const titleEl = member.querySelector('INSPIREID, inspireid, title, TITLE');
      const title   = titleEl ? titleEl.textContent.trim() : '';

      if (polygons.length) features.push({ polygons, title });
    }

    return features;
  }

  /* ---- Fetch from WFS -------------------------------------- */
  async function _fetch(bounds) {
    const sw = bounds.getSouthWest();
    const ne = bounds.getNorthEast();
    const [eMin, nMin] = _wgs84ToBng(sw.lat, sw.lng);
    const [eMax, nMax] = _wgs84ToBng(ne.lat, ne.lng);

    /* Pad bbox 10% to reduce clipping at edges */
    const eRange = eMax - eMin, nRange = nMax - nMin;
    const pad    = Math.max(eRange, nRange) * 0.05;

    const params = new URLSearchParams({
      SERVICE:      'WFS',
      REQUEST:      'GetFeature',
      TYPENAME:     'inspire:BasicPropertyUnit',
      BBOX:         `${Math.round(eMin-pad)},${Math.round(nMin-pad)},${Math.round(eMax+pad)},${Math.round(nMax+pad)},EPSG:27700`,
      maxFeatures:  MAX_FEATURES,
      outputFormat: 'GML2',
    });

    const url = `${WFS_BASE}?${params}`;
    const r   = await fetch(url, { headers: { Accept: 'application/xml' } });
    if (!r.ok) throw new Error(`WFS HTTP ${r.status}`);
    return r.text();
  }

  /* ---- Public: show for current map bounds ----------------- */
  async function show(map) {
    _map = map;
    const bounds = map.getBounds();

    /* Refuse if zoomed out too far — too many polygons */
    if (map.getZoom() < 14) {
      toast('Zoom in to zoom level 14 or higher to load property boundaries', 3500);
      return 0;
    }

    if (_group) { map.removeLayer(_group); _group = null; }

    let features;
    try {
      const gml = await _fetch(bounds);
      features  = _parseGML(gml);
    } catch (e) {
      console.warn('[INSPIRE]', e);
      toast(`INSPIRE: ${e.message}`, 5000);
      return 0;
    }

    if (!features.length) {
      toast('No registered title polygons found in this area', 3000);
      return 0;
    }

    _group = L.featureGroup();

    for (const { polygons, title } of features) {
      for (const rings of polygons) {
        try {
          const layer = L.polygon(rings, {
            color:       '#c07000',
            weight:      1.2,
            opacity:     0.7,
            fillColor:   '#e8a020',
            fillOpacity: 0.06,
          });
          if (title) layer.bindTooltip(`Title: ${title}`, { sticky: true, direction: 'top' });
          layer.addTo(_group);
        } catch (_) { /* skip malformed ring */ }
      }
    }

    _group.addTo(map);
    return features.length;
  }

  function hide(map) {
    if (_group) { map.removeLayer(_group); _group = null; }
  }

  return { show, hide };
})();
