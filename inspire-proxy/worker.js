'use strict';

/* inspire-proxy — Cloudflare Worker
   Proxies HM Land Registry INSPIRE WFS requests, adding CORS headers so the
   browser app can call the endpoint from any origin (including GitHub Pages).

   The INSPIRE endpoint itself is free, public, OGL-licensed — no upstream
   auth required. This worker just adds CORS and forwards the request.

   Deploy:
     cd inspire-proxy
     npx wrangler deploy

   Local dev:
     npx wrangler dev
     Then set INSPIRE_PROXY in inspire.js to http://localhost:8787
*/

const UPSTREAM = 'https://inspire.landregistry.gov.uk/inspire/ows';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Accept, Content-Type',
  'Access-Control-Max-Age':       '86400',
};

export default {
  async fetch(request) {

    /* CORS preflight */
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (request.method !== 'GET') {
      return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS });
    }

    /* Forward query string to upstream */
    const incoming = new URL(request.url);
    const upstream  = new URL(UPSTREAM);
    upstream.search = incoming.search;

    let resp;
    try {
      resp = await fetch(upstream.toString(), {
        headers: { Accept: 'application/xml, text/xml' },
        cf: { cacheTtl: 300 },   /* cache WFS responses 5 min at Cloudflare edge */
      });
    } catch (err) {
      return new Response(`Upstream error: ${err.message}`, {
        status: 502,
        headers: { ...CORS_HEADERS, 'Content-Type': 'text/plain' },
      });
    }

    /* Stream response back with CORS headers added */
    const headers = new Headers(resp.headers);
    for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);

    return new Response(resp.body, {
      status:  resp.status,
      headers,
    });
  },
};
