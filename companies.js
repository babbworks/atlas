'use strict';

/* companies.js — Companies House REST API integration
   Uses /search/companies?q= for both postcode and name lookups.
   Field names in search results: title, address (not company_name, registered_office_address).
   SIC codes are not returned by search — fetched separately for top results only. */

const Companies = (() => {

  /* Requests go to the local proxy (server.py) which adds auth server-side.
     This avoids CORS rejection of credentialed cross-origin browser requests. */
  const BASE      = '/api/ch';
  const CACHE     = new Map();
  const CACHE_TTL = 10 * 60 * 1000;

  /* SIC division ranges worth highlighting */
  const SIC_LABELS = [
    { from:  5, to:  9, label: 'Mining & Quarrying' },
    { from: 10, to: 33, label: 'Manufacturing'       },
    { from: 35, to: 39, label: 'Utilities'            },
    { from: 41, to: 43, label: 'Construction'         },
    { from: 49, to: 53, label: 'Transport'            },
  ];

  function _sicLabel(code) {
    const div = parseInt(String(code).slice(0, 2), 10);
    const m = SIC_LABELS.find(r => div >= r.from && div <= r.to);
    return m ? m.label : null;
  }

  function _isIndustrial(sics) {
    return (sics || []).some(c => {
      const div = parseInt(String(c).slice(0, 2), 10);
      return div >= 5 && div <= 43;
    });
  }

  function _evict() {
    const now = Date.now();
    for (const [k, v] of CACHE) {
      if (now - v.ts > CACHE_TTL) CACHE.delete(k);
    }
  }

  async function _get(path) {
    _evict();
    const hit = CACHE.get(path);
    if (hit) return hit.data;

    const resp = await fetch(BASE + path);
    if (resp.status === 401) throw new Error('API key invalid or expired');
    if (resp.status === 404) return null;
    if (!resp.ok) throw new Error(`Companies House HTTP ${resp.status}`);

    const data = await resp.json();
    CACHE.set(path, { data, ts: Date.now() });
    if (CACHE.size > 60) {
      const oldest = [...CACHE.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
      CACHE.delete(oldest[0]);
    }
    return data;
  }

  /* Normalise a search result item.
     Search endpoint uses: title, address, company_number, company_status, company_type */
  function _normalise(item) {
    const addr = item.address || item.registered_office_address || {};
    const addrLine = item.address_snippet ||
      [addr.premises, addr.address_line_1, addr.locality, addr.postal_code]
        .filter(Boolean).join(', ');

    const sics    = item.sic_codes || [];
    const sicInfo = sics.map(c => ({ code: c, label: _sicLabel(c) }));

    return {
      number:       item.company_number,
      name:         item.title || item.company_name || '',
      status:       item.company_status,
      type:         item.company_type,
      incorporated: item.date_of_creation || null,
      address:      addrLine,
      postcode:     addr.postal_code || '',
      sics,
      sicInfo,
      isIndustrial: _isIndustrial(sics),
      chUrl: `https://find-and-update.company-information.service.gov.uk/company/${item.company_number}`,
    };
  }

  /* Search by postcode — returns only companies whose address postcode matches */
  async function searchByPostcode(postcode) {
    const pc   = postcode.trim().toUpperCase();
    const data = await _get(`/search/companies?q=${encodeURIComponent(pc)}&items_per_page=20`);
    if (!data || !data.items) return [];

    /* Filter to exact postcode matches only */
    const matched = data.items.filter(item => {
      const p = (item.address || {}).postal_code || '';
      return p.toUpperCase().replace(/\s+/g, '') === pc.replace(/\s+/g, '');
    });

    /* Fetch SIC codes for up to 5 active companies */
    const results  = matched.map(_normalise);
    const toEnrich = results.filter(r => r.status === 'active').slice(0, 5);
    await Promise.allSettled(toEnrich.map(r => _enrichSics(r)));

    return results;
  }

  /* Search by company name */
  async function searchByName(name) {
    const data = await _get(`/search/companies?q=${encodeURIComponent(name.trim())}&items_per_page=10`);
    if (!data || !data.items) return [];
    return data.items.map(_normalise);
  }

  /* Fetch SIC codes and active officers from full company profile */
  async function _enrichSics(result) {
    try {
      const [profile, officersData] = await Promise.allSettled([
        _get(`/company/${result.number}`),
        _get(`/company/${result.number}/officers?items_per_page=20`),
      ]);

      if (profile.status === 'fulfilled' && profile.value) {
        const sics         = profile.value.sic_codes || [];
        result.sics        = sics;
        result.sicInfo     = sics.map(c => ({ code: c, label: _sicLabel(c) }));
        result.isIndustrial = _isIndustrial(sics);
      }

      if (officersData.status === 'fulfilled' && officersData.value) {
        result.officers = (officersData.value.items || [])
          .filter(o => !o.resigned_on)
          .map(o => ({
            name:        o.name || '',
            role:        o.officer_role || '',
            appointedOn: o.appointed_on || null,
          }));
      }
    } catch (_) { /* best-effort */ }
  }

  return { searchByPostcode, searchByName };
})();
