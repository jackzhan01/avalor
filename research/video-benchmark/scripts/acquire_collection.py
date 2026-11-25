"""Checkpointed serial acquisition for an explicitly enumerated collection.

Downloads only: existing files are candidates, not declared verified media.
Layout review, extraction and annotation remain separate stages.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from vbench.paths import data_root  # noqa: E402
from vbench.util import write_json  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--scope', type=Path, required=True)
    args = ap.parse_args()
    scope = json.loads(args.scope.read_text(encoding='utf-8-sig'))
    root = data_root()
    raw = root / 'sources/raw'
    out = root / 'sources/acquisition-22.json'
    state = json.loads(out.read_text(encoding='utf8')) if out.exists() else {'schema': 'vbench.acquisition/1', 'videos': {}}
    for video in scope['videos']:
        bvid = video['bvid']
        if not bvid.startswith('BV') or not bvid.isalnum():
            raise ValueError('Invalid enumerated video identifier')
        row = state['videos'].setdefault(bvid, {})
        if video.get('existing_release'):
            row['status'] = 'existing_reviewed_release'
            write_json(out, state)
            continue
        for kind, fmt, ext in [('video', '30077/30080/100026', 'mp4'), ('audio', '30280', 'm4a')]:
            candidates = list(raw.glob(f'{bvid}.{kind}*.{ext}'))
            candidates = [p for p in candidates if p.stat().st_size > 0]
            if candidates and row.get(kind, {}).get('status') != 'failed':
                row[kind] = {'status': 'existing_candidate', 'path': str(candidates[0].relative_to(root)), 'bytes': candidates[0].stat().st_size}
                continue
            log = root / 'sources' / f'collection-fetch.{bvid}.{kind}.log'
            print(f'{bvid} {kind}: downloading', flush=True)
            with log.open('w', encoding='utf8') as handle:
                proc = subprocess.run([sys.executable, str(Path(__file__).with_name('fetch_media.py')),
                                       bvid, '--kind', kind, '--format', fmt, '--retries', '2', '--max-s', '1800'],
                                      stdout=handle, stderr=subprocess.STDOUT)
            row[kind] = {'status': 'downloaded_unverified' if proc.returncode == 0 else 'failed',
                         'returncode': proc.returncode, 'log': str(log.relative_to(root))}
            state['updated_utc'] = datetime.now(timezone.utc).isoformat()
            write_json(out, state)
            print(f'{bvid} {kind}: {row[kind]["status"]}', flush=True)
            # A platform throttle ends this queue; do not cycle through other IDs.
            detail = log.read_text(encoding='utf8')
            if proc.returncode and any(s in detail for s in ('HTTP Error 412', 'HTTP Error 429', 'code -352', 'code: -352')):
                state['stopped_reason'] = 'platform_throttle'
                write_json(out, state)
                return 1
            if proc.returncode:
                break
        state['updated_utc'] = datetime.now(timezone.utc).isoformat()
        write_json(out, state)
    print('Enumerated acquisition queue finished; media still requires verification.', flush=True)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
