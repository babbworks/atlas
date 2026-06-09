#!/usr/bin/env python3
"""
process_fsa.py — Download food manufacturer/processor locations from the
FSA Food Hygiene Ratings API and output a compact spatial JSON.

Fetches BusinessTypeId 7839 (Manufacturers/packers), 7 (Distributors/Transporters),
and 14 (Importers/Exporters) — the industrial food business types.

Output: data/fsa_food_industry.json
Format: [{name, lat, lng, type, postcode, authority, rating}, ...]

Usage:
    python3 scripts/process_fsa.py
"""

import json
import os
import time
import urllib.request
import urllib.parse

SCRIPT_DIR  = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.dirname(SCRIPT_DIR)
OUTPUT_PATH = os.path.join(PROJECT_DIR, 'data', 'fsa_food_industry.json')

API_BASE    = 'http://api.ratings.food.gov.uk'
PAGE_SIZE   = 500
HEADERS     = {'x-api-version': '2', 'Accept': 'application/json'}

# Only industrial food business types
BUSINESS_TYPES = {
    7839: 'Manufacturer/Packer',
    7:    'Distributor/Transporter',
    14:   'Importer/Exporter',
}


def fetch_page(business_type_id, page_number):
    params = urllib.parse.urlencode({
        'BusinessTypeId': business_type_id,
        'pageNumber':     page_number,
        'pageSize':       PAGE_SIZE,
    })
    url = f'{API_BASE}/Establishments?{params}'
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read())


def fetch_business_type(type_id, type_label, results):
    print(f'\nFetching {type_label} (typeId={type_id})…')
    page = 1
    total_pages = None
    count = 0

    while True:
        try:
            data = fetch_page(type_id, page)
        except Exception as e:
            print(f'  Error page {page}: {e}')
            time.sleep(3)
            try:
                data = fetch_page(type_id, page)
            except Exception as e2:
                print(f'  Retry failed: {e2} — skipping remaining')
                break

        meta = data.get('meta', {})
        if total_pages is None:
            total_pages = meta.get('totalPages', 1)
            total       = meta.get('totalCount', '?')
            print(f'  Total: {total} records, {total_pages} pages')

        for est in data.get('establishments', []):
            geo = est.get('geocode') or {}
            try:
                lat = float(geo.get('latitude')  or 0)
                lng = float(geo.get('longitude') or 0)
            except (TypeError, ValueError):
                continue

            if not (49.0 < lat < 61.5 and -8.5 < lng < 2.5):
                continue

            results.append({
                'name':      est.get('BusinessName', ''),
                'lat':       round(lat, 5),
                'lng':       round(lng, 5),
                'type':      type_label,
                'typeId':    type_id,
                'postcode':  est.get('PostCode', ''),
                'authority': est.get('LocalAuthorityName', ''),
                'rating':    est.get('RatingValue', ''),
            })
            count += 1

        if page >= total_pages:
            break
        page += 1
        time.sleep(0.1)

    print(f'  {count} records with valid UK coordinates')
    return count


def main():
    print('Downloading FSA food industry establishments…')
    results = []

    for type_id, type_label in BUSINESS_TYPES.items():
        fetch_business_type(type_id, type_label, results)

    print(f'\nTotal: {len(results):,} establishments')

    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
    with open(OUTPUT_PATH, 'w', encoding='utf-8') as f:
        json.dump(results, f, separators=(',', ':'))

    size_mb = os.path.getsize(OUTPUT_PATH) / 1_000_000
    print(f'Written: {OUTPUT_PATH} ({size_mb:.2f} MB)')


if __name__ == '__main__':
    main()
