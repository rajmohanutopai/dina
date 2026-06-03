#!/usr/bin/env python3
"""Generic mobile chat driver via idb.

Usage: python3 drive_chat.py <chip> <text> <outfile.png> [wait_seconds]
  <chip> = "Ask" or "Remember"

Taps the composer chip, types text, sends (↑ glyph or Return), waits, screenshots.
"""
import json, re, subprocess, sys, time

SIM = "6D57099D-48DA-430D-B4BB-1A2BF1EBACB7"
CHIP = sys.argv[1] if len(sys.argv) > 1 else "Ask"
TEXT = sys.argv[2] if len(sys.argv) > 2 else "hello"
OUT = sys.argv[3] if len(sys.argv) > 3 else "/tmp/sim_chat.png"
WAIT = int(sys.argv[4]) if len(sys.argv) > 4 else 8
SCREEN_H = 874


def run(args, **kw):
    return subprocess.run(args, capture_output=True, text=True, **kw)


def dump_ui():
    r = run(["idb", "ui", "describe-all", "--udid", SIM, "--json"])
    if r.returncode != 0:
        return []
    try:
        els = json.loads(r.stdout)
    except Exception:
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
    return tuple(map(float, nums[:4])) if len(nums) >= 4 else None


def center(e):
    fr = frame(e)
    if not fr:
        return None
    x, y, w, h = fr
    return (round(x + w / 2), round(y + h / 2))


def lbl(e):
    return (e.get("AXLabel") or e.get("label") or "") or ""


def tap(x, y, what):
    print(f"  tap {what} @ ({x},{y})")
    run(["idb", "ui", "tap", "--udid", SIM, str(x), str(y)])
    time.sleep(1.0)


def screenshot(path):
    run(["xcrun", "simctl", "io", SIM, "screenshot", path])
    print(f"  screenshot -> {path}")


def find_label(els, text, ymin=None):
    out = [e for e in els if lbl(e).strip().lower() == text.lower()
           and center(e) and (ymin is None or center(e)[1] >= ymin)]
    out.sort(key=lambda e: center(e)[1])
    return out


def find_glyph(els, glyph):
    return [e for e in els if glyph in lbl(e) and center(e)]


print(f"### chip={CHIP!r} text={TEXT!r}")
els = dump_ui()
chips = find_label(els, CHIP, ymin=SCREEN_H * 0.7)
if not chips:
    print(f"FATAL: composer {CHIP!r} chip not found near bottom")
    screenshot(OUT.replace(".png", "_nochip.png"))
    sys.exit(2)
cc = center(chips[-1])
tap(cc[0], cc[1], f"{CHIP} chip")
time.sleep(1.5)

run(["idb", "ui", "text", "--udid", SIM, TEXT])
time.sleep(1.2)

els2 = dump_ui()
landed = any(TEXT[:18].lower() in (lbl(e) + str(e.get("AXValue") or "")).lower() for e in els2)
print(f"  text present in UI tree: {landed}")
# Send button is a Button labelled "Send message" (filled circle, no literal glyph).
sends = [e for e in els2 if "send message" in lbl(e).lower() and center(e)]
sends += find_glyph(els2, "↑")
if sends:
    sends.sort(key=lambda e: center(e)[1])
    cs = center(sends[-1])
    tap(cs[0], cs[1], "Send message")
else:
    run(["idb", "ui", "key", "--udid", SIM, "40"])  # HID Return fallback
    print("  sent via Return key (no Send button found)")

for t in range(0, WAIT, 5):
    time.sleep(5)
    print(f"  ...waited {t+5}s")
screenshot(OUT)
print(f"### DONE -> {OUT}")
