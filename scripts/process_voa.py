#!/usr/bin/env python3
"""
process_voa.py — Filter VOA rating list to industrial properties
and output a postcode-indexed JSON for use by voa.js.

Usage:
    python3 scripts/process_voa.py voa_2023.zip

Output:
    data/voa_industrial.json

Field layout (asterisk-delimited):
    [0]  row id
    [1]  billing authority code
    [2]  (empty)
    [3]  UARN
    [4]  primary description code  ← we filter on this
    [5]  primary description text
    [6]  (internal ref)
    [7]  full address
    [8]  (empty)
    [9]  premises/number
    [10] street
    [11] town
    [12] locality
    [13] (empty)
    [14] postcode               ← our lookup key
    [15] (empty)
    [16] (empty)
    [17] rateable value

Industrial primary description codes (I*):
    IF   Factory and Premises
    IF3  Workshop and Premises
    IW   Warehouse and Premises
    IB   Business Units and Premises
    IH   Workshops and Premises
    (all other I* variants included)
"""

import sys
import os
import zipfile
import json
import collections
import time

SCRIPT_DIR  = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.dirname(SCRIPT_DIR)
OUTPUT_PATH = os.path.join(PROJECT_DIR, 'data', 'voa_industrial.json')

# Friendly labels for description codes shown in the UI
CODE_LABELS = {
    'IF':   'Factory',
    'IF3':  'Workshop',
    'IF4':  'Industrial Unit',
    'IW':   'Warehouse',
    'IW3':  'Storage Premises',
    'IB':   'Business Units',
    'IH':   'Workshop',
    'IH3':  'Workshop',
    'IL':   'Light Industrial',
    'IS':   'Storage',
}


def normalise_postcode(raw):
    """Uppercase and collapse whitespace: 'b19  3he' → 'B19 3HE'"""
    parts = raw.strip().upper().split()
    if len(parts) == 2:
        return f'{parts[0]} {parts[1]}'
    if len(parts) == 1 and len(raw) >= 5:
        # No space — insert before last 3 chars
        r = raw.strip().upper()
        return f'{r[:-3]} {r[-3:]}'
    return raw.strip().upper()


def process(zip_path):
    print(f'Reading {zip_path} …')
    t0 = time.time()

    by_postcode = collections.defaultdict(list)
    total = skipped = industrial = 0

    with zipfile.ZipFile(zip_path) as zf:
        # Use the main (non-historic) file
        names = [n for n in zf.namelist() if 'historic' not in n.lower() and n.endswith('.csv')]
        if not names:
            names = zf.namelist()[:1]
        csv_name = names[0]
        print(f'Processing {csv_name} …')

        with zf.open(csv_name) as f:
            for raw in f:
                total += 1
                if total % 200000 == 0:
                    elapsed = time.time() - t0
                    print(f'  {total:,} rows … {industrial:,} industrial ({elapsed:.0f}s)')

                try:
                    line = raw.decode('latin-1', errors='replace').rstrip('\r\n')
                    parts = line.split('*')
                    if len(parts) < 18:
                        skipped += 1
                        continue

                    code = parts[4].strip()
                    if not code.startswith('I'):
                        continue

                    postcode = parts[14].strip()
                    if not postcode or len(postcode) < 5:
                        skipped += 1
                        continue

                    pc = normalise_postcode(postcode)

                    # Build short address: premises + street
                    premises = parts[9].strip()
                    street   = parts[10].strip()
                    town     = parts[11].strip()
                    addr = ', '.join(p for p in [premises, street, town] if p)

                    rv_raw = parts[17].strip()
                    rv = int(rv_raw) if rv_raw.isdigit() else 0

                    label = CODE_LABELS.get(code, parts[5].strip().title())

                    by_postcode[pc].append({
                        'c': code,
                        'l': label,
                        'rv': rv,
                        'a': addr,
                    })
                    industrial += 1

                except Exception:
                    skipped += 1
                    continue

    elapsed = time.time() - t0
    print(f'\nDone: {total:,} total rows, {industrial:,} industrial, {skipped} skipped ({elapsed:.0f}s)')
    print(f'Unique postcodes: {len(by_postcode):,}')

    print(f'Writing {OUTPUT_PATH} …')
    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
    with open(OUTPUT_PATH, 'w', encoding='utf-8') as out:
        json.dump(dict(by_postcode), out, separators=(',', ':'))

    size_mb = os.path.getsize(OUTPUT_PATH) / 1_000_000
    print(f'Written: {size_mb:.1f} MB')
    print(f'\nPlace voa_industrial.json in data/ — already done.')
    print('Restart server.py and reload the app.')


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print('Usage: python3 scripts/process_voa.py <path-to-voa-zip>')
        sys.exit(1)
    process(sys.argv[1])
