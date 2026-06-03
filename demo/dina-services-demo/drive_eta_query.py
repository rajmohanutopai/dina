#!/usr/bin/env python3
"""End-to-end: drive the in-app price_check query on the iOS sim via idb and
screenshot the rendered card. Self-contained so a flaky tool channel only has
to deliver ONE result (the final screenshot path + step log).

Flow: dump UI -> tap composer 'Ask' chip -> tap the text field -> type the
query -> tap the send button -> wait for the D2D round-trip -> screenshot.
Every step is logged; before/after UI dumps confirm the text actually landed.
"""
import json, re, subprocess, sys, time

SIM = "6D57099D-48DA-430D-B4BB-1A2BF1EBACB7"
QUERY = "When does bus 42 reach Castro?"


def run(args, **kw):
    return subprocess.run(args, capture_output=True, text=True, **kw)


def dump_ui():
    r = run(["idb", "ui", "describe-all", "--udid", SIM, "--json"])
    if r.returncode != 0:
        print("  describe-all FAILED:", r.stderr[:200])
        return []
    try:
        els = json.loads(r.stdout)
    except Exception as e:
        print("  JSON parse fail:", e)
        return []
    if isinstance(els, dict):
        els = els.get("value") or els.get("elements") or [els]
    return [e for e in els if isinstance(e, dict)]


def frame(e):
    f = e.get("frame")
    if isinstance(f, dict) and "x" in f:
        return f["x"], f["y"], f["width"], f["height"]
    s = e.get("AXFrame") or (f if isinstance(f, str) else "")
    nums = re.findall(r"-?\d+\.?\d*", s or "")
    if len(nums) >= 4:
        return tuple(map(float, nums[:4]))
    return None


def center(e):
    fr = frame(e)
    if not fr:
        return None
    x, y, w, h = fr
    return (round(x + w / 2), round(y + h / 2))


def lbl(e):
    return (e.get("AXLabel") or e.get("label") or "") or ""


def typ(e):
    return (e.get("type") or e.get("AXType") or "") or ""


def tap(x, y, what):
    print(f"  tap {what} @ ({x},{y})")
    r = run(["idb", "ui", "tap", "--udid", SIM, str(x), str(y)])
    if r.returncode != 0:
        print("    tap err:", r.stderr[:120])
    time.sleep(1.0)


def screenshot(path):
    r = run(["xcrun", "simctl", "io", SIM, "screenshot", path])
    print(f"  screenshot -> {path} (exit {r.returncode})")


def find_label(els, text, ymin=None):
    """Elements whose label equals `text` (case-insensitive), any type.
    Optionally only those below ymin. Sorted bottom-most last."""
    out = []
    for e in els:
        c = center(e)
        if not c:
            continue
        if lbl(e).strip().lower() == text.lower() and (ymin is None or c[1] >= ymin):
            out.append(e)
    out.sort(key=lambda e: center(e)[1])
    return out


def find_glyph(els, glyph):
    return [e for e in els if glyph in lbl(e) and center(e)]


print("### STEP 1: initial UI dump")
els = dump_ui()
print(f"  {len(els)} elements")
SCREEN_H = 874  # iPhone 17 Pro points

# The composer 'Ask' chip is a GenericElement (NOT a Button), bottom of screen.
asks = find_label(els, "Ask", ymin=SCREEN_H * 0.7)
if not asks:
    print("FATAL: composer 'Ask' chip not found near bottom")
    screenshot("/tmp/sim_price_noask.png")
    sys.exit(2)
ca = center(asks[-1])
print(f"### STEP 2: tap composer 'Ask' chip @ {ca}")
tap(ca[0], ca[1], "Ask chip")
time.sleep(1.5)  # let the keyboard / input mount

print(f"### STEP 3: type query (focus follows the Ask tap): {QUERY!r}")
r = run(["idb", "ui", "text", "--udid", SIM, QUERY])
print("  text exit", r.returncode, (r.stderr[:160] if r.returncode else ""))
time.sleep(1.2)
screenshot("/tmp/sim_eta_typed.png")

# Re-dump: keyboard shifts the composer up, so re-locate the send '↑' glyph.
els2 = dump_ui()
landed = any(QUERY[:18].lower() in (lbl(e) + str(e.get("AXValue") or "")).lower() for e in els2)
print(f"  query text present in UI tree: {landed}")
sends = find_glyph(els2, "↑")
if sends:
    sends.sort(key=lambda e: center(e)[1])
    cs = center(sends[-1])
    print(f"### STEP 4: tap send '↑' @ {cs}")
    tap(cs[0], cs[1], "send arrow")
else:
    # fallback to the original arrow position, else Return key
    print("### STEP 4: '↑' not found; tapping last-known (366,755) then Return")
    tap(366, 755, "send (fallback coords)")
    run(["idb", "ui", "key", "--udid", SIM, "40"])

print("### STEP 6: wait for D2D round-trip (discovery -> drcarl -> price daemon -> reply)")
for s in range(0, 60, 5):
    time.sleep(5)
    print(f"  ...waited {s+5}s")
screenshot("/tmp/sim_eta_result.png")
print("### DONE — see /tmp/sim_eta_result.png")
