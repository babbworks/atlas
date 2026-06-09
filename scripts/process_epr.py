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
import math
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


def _bng_to_wgs84(easting, northing):
    """Helmert transform: OSGB36 BNG → WGS84 lat/lng. Accurate to ~5 m."""
    a, b = 6377563.396, 6356256.909
    F0 = 0.9996012717
    lat0, lon0 = math.radians(49), math.radians(-2)
    N0, E0 = -100000, 400000
    e2 = 1 - (b * b) / (a * a)
    n = (a - b) / (a + b)

    lat = lat0
    M = 0.0
    for _ in range(100):
        lat = (northing - N0 - M) / (a * F0) + lat
        M1 = (1 + n + 1.25*n*n + 1.25*n**3) * (lat - lat0)
        M2 = (3*n + 3*n*n + 2.625*n**3) * math.sin(lat - lat0) * math.cos(lat + lat0)
        M3 = (1.875*n*n + 1.875*n**3) * math.sin(2*(lat - lat0)) * math.cos(2*(lat + lat0))
        M4 = (35/24)*n**3 * math.sin(3*(lat - lat0)) * math.cos(3*(lat + lat0))
        M = b * F0 * (M1 - M2 + M3 - M4)
        if abs(northing - N0 - M) < 1e-5:
            break

    sin_lat, cos_lat, tan_lat = math.sin(lat), math.cos(lat), math.tan(lat)
    nu  = a * F0 / math.sqrt(1 - e2 * sin_lat**2)
    rho = a * F0 * (1 - e2) / (1 - e2 * sin_lat**2)**1.5
    eta2 = nu / rho - 1

    dE = easting - E0
    lat_wgs = (lat
        - (tan_lat / (2 * rho * nu)) * dE**2
        + (tan_lat / (24 * rho * nu**3)) * (5 + 3*tan_lat**2 + eta2 - 9*tan_lat**2*eta2) * dE**4
        - (tan_lat / (720 * rho * nu**5)) * (61 + 90*tan_lat**2 + 45*tan_lat**4) * dE**6)
    lon_wgs = (lon0
        + dE / (cos_lat * nu)
        - dE**3 / (cos_lat * 6 * nu**3) * (nu/rho + 2*tan_lat**2)
        + dE**5 / (cos_lat * 120 * nu**5) * (5 + 28*tan_lat**2 + 24*tan_lat**4))

    return round(math.degrees(lat_wgs), 5), round(math.degrees(lon_wgs), 5)


def _process_rows(reader, results):
    skipped = 0
    before = len(results)
    for row in reader:
        # Try BNG Eastings/Northings first (EPR accdb format)
        e_raw = _col(row, 'Eastings', 'Easting', 'EASTING')
        n_raw = _col(row, 'Northings', 'Northing', 'NORTHING')
        lat, lng = None, None

        if e_raw and n_raw:
            try:
                e, n = float(e_raw), float(n_raw)
                if 0 < e < 700000 and 0 < n < 1300000:
                    lat, lng = _bng_to_wgs84(e, n)
            except (ValueError, TypeError):
                pass

        # Fall back to lat/lng columns
        if lat is None:
            lat_raw = _col(row, 'Latitude', 'latitude', 'Lat', 'lat')
            lng_raw = _col(row, 'Longitude', 'longitude', 'Long', 'lng')
            try:
                lat = float(lat_raw)
                lng = float(lng_raw)
            except (ValueError, TypeError):
                skipped += 1
                continue

        if not (49.0 < lat < 61.5 and -8.5 < lng < 2.5):
            skipped += 1
            continue

        name     = _col(row, 'Installation_Name', 'Primary_Name__IS_', 'Site Name', 'site_name', 'Name')
        operator = _col(row, 'Operator_Name', 'Operator Name', 'operator_name', 'Operator')
        activity = _col(row, 'Application_Sub_Type', 'Application_Type', 'Activities', 'Activity', 'Description')
        status   = _col(row, 'Status', 'Permit Status', 'permit_status') or 'active'
        permit   = _col(row, 'EPR_Ref', 'Permit_Number', 'Permit Number', 'permit_number')

        results.append({
            'id':       permit,
            'name':     name,
            'operator': operator,
            'lat':      lat,
            'lng':      lng,
            'activity': activity[:200],
            'sector':   _sector_label(operator + ' ' + name + ' ' + activity),
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
            candidates = [
                shutil.which('mdb-export'),
                '/opt/local/bin/mdb-export',                      # MacPorts
                '/tmp/mdbtools/src/util/mdb-export',               # built from source
                '/usr/local/bin/mdb-export',
            ]
            mdb_export = next((p for p in candidates if p and os.path.isfile(p)), None)
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

                    # Use All_EPR_Ind for complete picture; skip ASR sub-tables
                    target_tables = [t for t in tables_raw if t.strip() and not t.endswith('_ASR')]
                    for table in target_tables:
                        print(f'Exporting table: {table}')
                        csv_text = subprocess.check_output(
                            [mdb_export, accdb_path, table], text=True, errors='replace'
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
