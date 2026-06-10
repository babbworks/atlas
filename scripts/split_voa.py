#!/usr/bin/env python3
"""
split_voa.py — Split voa_industrial.json into per-postcode-area files.

Reads data/voa_industrial.json and writes one file per postcode area
(the leading letters, e.g. "SW" from "SW1A 2AA") into data/voa/.

Output: data/voa/{AREA}.json  — same postcode→entries structure, area only.

Usage:
    python3 scripts/split_voa.py
"""

import json
import os
import re
import time

SCRIPT_DIR  = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.dirname(SCRIPT_DIR)
INPUT_PATH  = os.path.join(PROJECT_DIR, 'data', 'voa_industrial.json')
OUTPUT_DIR  = os.path.join(PROJECT_DIR, 'data', 'voa')


def postcode_area(pc):
    """Extract area letters from a normalised postcode: 'SW1A 2AA' → 'SW'"""
    m = re.match(r'^([A-Z]+)', pc.strip().upper())
    return m.group(1) if m else 'XX'


def main():
    t0 = time.time()
    print(f'Reading {INPUT_PATH} …')
    with open(INPUT_PATH, encoding='utf-8') as f:
        data = json.load(f)
    print(f'  Loaded {len(data):,} postcodes ({time.time()-t0:.1f}s)')

    by_area = {}
    for pc, entries in data.items():
        area = postcode_area(pc)
        by_area.setdefault(area, {})[pc] = entries

    os.makedirs(OUTPUT_DIR, exist_ok=True)
    sizes = {}
    for area, chunk in sorted(by_area.items()):
        path = os.path.join(OUTPUT_DIR, f'{area}.json')
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(chunk, f, separators=(',', ':'))
        sizes[area] = os.path.getsize(path)

    total_kb = sum(sizes.values()) / 1024
    print(f'\nWrote {len(by_area)} area files to data/voa/')
    print(f'Total size: {total_kb/1024:.1f} MB across {len(by_area)} files')
    print(f'Largest: {max(sizes, key=sizes.get)} ({max(sizes.values())/1024:.0f} KB)')
    print(f'Average: {total_kb/len(by_area):.0f} KB')
    print(f'Done in {time.time()-t0:.1f}s')


if __name__ == '__main__':
    main()
