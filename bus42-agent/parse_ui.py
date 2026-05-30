#!/usr/bin/env python3
"""Parse /tmp/sim_ui.json (idb describe-all) → labelled interactive elements
with point-centers. Handles AXFrame as a string '{{x, y}, {w, h}}' OR a dict."""
import json, re, sys

els = json.load(open('/tmp/sim_ui.json'))
if isinstance(els, dict):
    els = els.get('value') or els.get('elements') or [els]

def parse_frame(e):
    f = e.get('frame')
    if isinstance(f, dict) and 'x' in f:
        return f['x'], f['y'], f['width'], f['height']
    s = e.get('AXFrame') or (f if isinstance(f, str) else '')
    nums = re.findall(r'-?\d+\.?\d*', s or '')
    if len(nums) >= 4:
        x, y, w, h = map(float, nums[:4])
        return x, y, w, h
    return None

def center(e):
    fr = parse_frame(e)
    if not fr:
        return None
    x, y, w, h = fr
    return (round(x + w / 2), round(y + h / 2))

print(f"elements: {len(els)}")
for e in els:
    if not isinstance(e, dict):
        continue
    t = e.get('type') or e.get('AXType') or ''
    lbl = e.get('AXLabel') or e.get('label') or ''
    val = e.get('AXValue') or e.get('value') or ''
    c = center(e)
    if t in ('Button', 'TextField', 'TextView', 'SecureTextField') or lbl or val:
        # keep it short
        lbl = (lbl[:40]) if isinstance(lbl, str) else lbl
        val = (val[:30]) if isinstance(val, str) else val
        print(f"  [{t}] label={lbl!r} value={val!r} center={c}")
