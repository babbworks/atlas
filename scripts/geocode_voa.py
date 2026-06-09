#!/usr/bin/env python3
"""
geocode_voa.py — Enrich VOA postcode data with coordinates via postcodes.io.

Reads  data/voa_industrial.json  (postcode → [{c,l,rv,a},...])
Writes data/voa_geo.json         (postcode → [lat, lng, count, maxRV, topCode])

Uses the postcodes.io bulk API (free, no auth, 100 postcodes per request).
Saves progress every 20 batches so it can be safely interrupted and resumed.

Usage:
    python3 scripts/geocode_voa.py
"""

import json
import os
import time
import urllib.request
import urllib.error

SCRIPT_DIR  = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.dirname(SCRIPT_DIR)
INPUT_PATH  = os.path.join(PROJECT_DIR, 'data', 'voa_industrial.json')
OUTPUT_PATH = os.path.join(PROJECT_DIR, 'data', 'voa_geo.json')
API_URL     = 'https://api.postcodes.io/postcodes'
BATCH_SIZE  = 100
SAVE_EVERY  = 20   # batches between progress saves


def geocode_batch(postcodes):
    body = json.dumps({'postcodes': postcodes}).encode()
    req  = urllib.request.Request(
        API_URL, data=body,
        headers={'Content-Type': 'application/json', 'Accept': 'application/json'},
    )
    with urllib.request.urlopen(req, timeout=20) as r:
        data = json.loads(r.read())

    result = {}
    for item in (data.get('result') or []):
        if item and item.get('result'):
            res = item['result']
            lat = res.get('latitude')
            lng = res.get('longitude')
            if lat is not None and lng is not None:
                result[item['query']] = (round(lat, 5), round(lng, 5))
    return result


def main():
    print(f'Loading {INPUT_PATH} …')
    with open(INPUT_PATH, encoding='utf-8') as f:
        voa = json.load(f)

    postcodes = list(voa.keys())
    print(f'{len(postcodes):,} postcodes loaded')

    # Resume support — reload any progress already saved
    geo = {}
    if os.path.exists(OUTPUT_PATH):
        try:
            with open(OUTPUT_PATH, encoding='utf-8') as f:
                geo = json.load(f)
            print(f'Resuming — {len(geo):,} postcodes already geocoded')
        except Exception:
            print('Could not read existing output, starting fresh')
            geo = {}

    todo = [pc for pc in postcodes if pc not in geo]
    print(f'{len(todo):,} remaining\n')

    if not todo:
        print('Nothing to do — already complete.')
        return

    total   = len(todo)
    done    = 0
    skipped = 0
    t0      = time.time()

    for batch_i, i in enumerate(range(0, total, BATCH_SIZE)):
        batch = todo[i:i + BATCH_SIZE]

        retry = 0
        while retry < 3:
            try:
                coords = geocode_batch(batch)
                break
            except (urllib.error.URLError, TimeoutError) as e:
                retry += 1
                print(f'  Batch {batch_i}: network error ({e}), retry {retry}/3')
                time.sleep(2 ** retry)
        else:
            skipped += len(batch)
            continue

        for pc in batch:
            if pc in coords:
                entries  = voa[pc]
                lat, lng = coords[pc]
                max_rv   = max((e.get('rv') or 0 for e in entries), default=0)
                top_code = entries[0]['c'] if entries else ''
                # Compact record: [lat, lng, count, maxRV, topCode]
                geo[pc] = [lat, lng, len(entries), max_rv, top_code]
                done += 1
            else:
                skipped += 1

        if batch_i % SAVE_EVERY == 0 and batch_i > 0:
            elapsed = time.time() - t0
            pct     = min(100, (i + len(batch)) / total * 100)
            rate    = done / elapsed if elapsed > 0 else 0
            eta     = (total - done) / rate / 60 if rate > 0 else 0
            print(f'  {i+len(batch):,}/{total:,}  ({pct:.0f}%)  '
                  f'{done:,} done  {skipped} skipped  ETA {eta:.1f} min')
            with open(OUTPUT_PATH, 'w', encoding='utf-8') as f:
                json.dump(geo, f, separators=(',', ':'))

        time.sleep(0.05)   # ~20 req/s — comfortably within free-tier limits

    # Final save
    print(f'\nDone: {done:,} geocoded, {skipped} skipped')
    print(f'Writing {OUTPUT_PATH} …')
    with open(OUTPUT_PATH, 'w', encoding='utf-8') as f:
        json.dump(geo, f, separators=(',', ':'))

    size_mb = os.path.getsize(OUTPUT_PATH) / 1_000_000
    elapsed = time.time() - t0
    print(f'Written: {size_mb:.1f} MB  ({elapsed/60:.1f} min total)')


if __name__ == '__main__':
    main()
