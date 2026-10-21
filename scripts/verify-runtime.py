"""Verify the shipped runtime without executing the plugin or dependencies."""
from pathlib import Path
import hashlib
import json
import sys

root = Path(__file__).resolve().parents[1] / 'QQmailplugin'
manifest = json.loads((root / 'SHA256SUMS.json').read_text(encoding='utf-8'))
actual = {p.relative_to(root).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
          for p in root.rglob('*') if p.is_file() and p.name != 'SHA256SUMS.json'}
if manifest != actual:
    print('FAIL: runtime file inventory or SHA-256 mismatch', file=sys.stderr)
    sys.exit(1)
print(f'PASS: {len(actual)} runtime files match SHA-256 manifest')
