#!/usr/bin/env python3
"""
process_epr.py — Download the EA Environmental Permitting Regulations
Industrial Sites register and output a compact spatial JSON.

Downloads the official bulk ZIP from data.gov.uk, extracts the CSV,
filters to records with valid UK coordinates, and outputs:

Output: data/epr_permits.json
Format: [{id, name, operator, lat, lng, activity, sector, status}, ...]

Usage:
    python3 scripts/process_epr.py
"""

import csv
import io
import json
import os
import shutil
import subprocess
import tempfile
import urllib.request
import zipfile

SCRIPT_DIR  = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.dirname(SCRIPT_DIR)
OUTPUT_PATH = os.path.join(PROJECT_DIR, 'data', 'epr_permits.json')

ZIP_URL = (
    'https://environment.data.gov.uk/api/file/download'
    '?fileDataSetId=ed666abb-5613-4a0f-8ff4-8722f05756f2'
    '&fileName=Environmental%20Permitting%20Regulations%20-%20Industrial%20Sites.zip'
)

SECTOR_KEYWORDS = {
    'food':      'Food & Drink Processing',
    'metal':     'Metal Production',
    'mineral':   'Minerals & Ceramics',
    'chemical':  'Chemical / Pharmaceutical',
    'waste':     'Waste Management',
    'energy':    'Energy Production',
    'textile':   'Textiles',
    'paper':     'Paper & Pulp',
    'rubber':    'Rubber & Plastics',
    'surface':   'Surface Treatment',
    'intensive': 'Intensive Livestock',
    'slaughter': 'Slaughterhouse',
    'rendering': 'Rendering',
    'tanning':   'Tannery',
    'cement':    'Cement / Lime',
    'glass':     'Glass',
    'print':     'Printing',
}


def _sector_label(text):
    t = (text or '').lower()
    for kw, label in SECTOR_KEYWORDS.items():
        if kw in t:
            return label
    return 'Industrial'


def _col(row, *keys):
    for k in keys:
        v = row.get(k, '').strip()
        if v:
            return v
    return ''


def _process_rows(reader, results):
    skipped = 0
    before = len(results)
    for row in reader:
        lat_raw = _col(row, 'Latitude', 'latitude', 'Lat', 'lat', 'LATITUDE')
        lng_raw = _col(row, 'Longitude', 'longitude', 'Long', 'long', 'lng', 'LONGITUDE')
        try:
            lat = float(lat_raw)
            lng = float(lng_raw)
        except (ValueError, TypeError):
            skipped += 1
            continue

        if not (49.0 < lat < 61.5 and -8.5 < lng < 2.5):
            skipped += 1
            continue

        activity = _col(row, 'Activities', 'Activity', 'activity_description', 'Description')
        status   = _col(row, 'Permit Status', 'permit_status', 'Status', 'status') or 'active'

        results.append({
            'id':       _col(row, 'Permit Number', 'permit_number', 'PermitNumber', 'Permit_Number'),
            'name':     _col(row, 'Site Name', 'site_name', 'SiteName', 'Name'),
            'operator': _col(row, 'Operator Name', 'operator_name', 'OperatorName', 'Operator'),
            'lat':      round(lat, 5),
            'lng':      round(lng, 5),
            'activity': activity[:200],
            'sector':   _sector_label(activity),
            'status':   status.lower(),
        })

    added = len(results) - before
    print(f'  {added:,} with coordinates, {skipped} skipped')


def main():
    print(f'Downloading EPR Industrial Sites ZIP…')
    req = urllib.request.Request(ZIP_URL, headers={'Accept': '*/*'})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            zip_bytes = r.read()
    except Exception as e:
        print(f'Download failed: {e}')
        return

    print(f'Downloaded {len(zip_bytes)/1_000_000:.1f} MB')

    results = []
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        print(f'Files in ZIP: {zf.namelist()}')
        csv_names   = [n for n in zf.namelist() if n.lower().endswith('.csv')]
        accdb_names = [n for n in zf.namelist() if n.lower().endswith('.accdb') or n.lower().endswith('.mdb')]

        if not csv_names and accdb_names:
            mdb_export = (shutil.which('mdb-export') or
                          shutil.which('/opt/local/bin/mdb-export') or
                          (os.path.isfile('/opt/local/bin/mdb-export') and '/opt/local/bin/mdb-export'))
            if not mdb_export:
                print('ERROR: ZIP contains an Access database (.accdb) but mdbtools is not installed.')
                print('Install with:')
                print('  sudo port install mdbtools    (MacPorts — recommended on macOS 12)')
                print('  brew install mdbtools          (Homebrew — may fail on macOS 12)')
                print('Then re-run this script.')
                return

            tmpdir = tempfile.mkdtemp()
            try:
                for accdb_name in accdb_names:
                    accdb_path = os.path.join(tmpdir, os.path.basename(accdb_name))
                    with zf.open(accdb_name) as af:
                        with open(accdb_path, 'wb') as out:
                            out.write(af.read())

                    mdb_tables = mdb_export.replace('mdb-export', 'mdb-tables')
                    print(f'Extracted {accdb_name} — listing tables…')
                    tables_raw = subprocess.check_output(
                        [mdb_tables, '-1', accdb_path], text=True
                    ).strip().splitlines()
                    print(f'Tables: {tables_raw}')

                    for table in tables_raw:
                        if not table.strip():
                            continue
                        print(f'Exporting table: {table}')
                        csv_text = subprocess.check_output(
                            ['mdb-export', accdb_path, table], text=True, errors='replace'
                        )
                        reader = csv.DictReader(io.StringIO(csv_text))
                        print(f'  Columns: {reader.fieldnames}')
                        _process_rows(reader, results)
            finally:
                shutil.rmtree(tmpdir, ignore_errors=True)
        else:
            for csv_name in csv_names:
                print(f'Processing {csv_name}…')
                with zf.open(csv_name) as cf:
                    text = cf.read().decode('utf-8-sig', errors='replace')
                reader = csv.DictReader(io.StringIO(text))
                print(f'Columns: {reader.fieldnames}')
                _process_rows(reader, results)

    if not results:
        print('No results extracted — check column names above and update _col() calls.')
        return

    print(f'\nWriting {OUTPUT_PATH}…')
    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
    with open(OUTPUT_PATH, 'w', encoding='utf-8') as f:
        json.dump(results, f, separators=(',', ':'))

    size_mb = os.path.getsize(OUTPUT_PATH) / 1_000_000
    print(f'Written: {size_mb:.2f} MB  ({len(results):,} permits)')


if __name__ == '__main__':
    main()
