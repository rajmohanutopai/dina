#!/usr/bin/env python3
"""Measure WHERE a brand-new did:plc's first record stalls on the way to
the AppView — the "why does a new provider take ~30 min to be discoverable"
investigation.

It times the hops we can reach from a laptop:

    T0  (caller-supplied) createAccount returned / record written
    T1  the new did:plc resolves in the PLC directory      (tests H1: PLC propagation)
    T3  the AppView returns the provider via discovery      (end-to-end visible)

The gap that dominates localizes the bottleneck:
    big T0->T1   => PLC directory propagation is the lag (H1)
    small T0->T1, big T1->T3 => downstream of PLC: relay/firehose (H2)
                                or the AppView ingester gate waiting on
                                something. To split THAT further you need
                                the firehose tap (T2, see --jetstream-url,
                                requires the `websockets` pkg) or the
                                ingester's own per-record logs (deployed side).

Stdlib only for the PLC+AppView path so it runs in any venv. The optional
firehose tap uses `websockets` if installed (it is, in dina-services-demo/venv).

USAGE
  # 1) start watching BEFORE you create the identity, in one terminal:
  python measure_ingest_latency.py watch \
      --did did:plc:NEWLYCREATED \
      --capability appointment_status \
      --plc-url https://<test-plc-host> \
      --appview-url https://test-appview.dinakernel.com

  # 2) in another terminal, provision the node (that's T0). The watcher
  #    prints T1/T3 as they happen, then a timeline with deltas.

  # one-shot point check (no polling), e.g. to confirm current state:
  python measure_ingest_latency.py check --did did:plc:... \
      --capability appointment_status --appview-url https://test-appview.dinakernel.com

NOTES
  * --plc-url: the PLC *directory* the test stack uses. Resolve a DID with
    GET {plc-url}/{did}. If you don't know it, read it off a running Core's
    config (plcDirectoryUrl) or its boot log (plc_probe line). 'test-plc...'
    was NOT reachable in testing — find the real host.
  * T0 is wall-clock "now" when you start `watch`. For a true T0 use the
    Core boot log timestamp of "PDS identity loaded/provisioned" and pass
    --t0-epoch <unix_seconds>.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Optional


def _now() -> float:
    return time.time()


def _stamp(t: float) -> str:
    lt = time.localtime(t)
    return time.strftime("%H:%M:%S", lt) + f".{int((t % 1) * 1000):03d}"


def _get(url: str, timeout: float = 8.0) -> tuple[int, str]:
    req = urllib.request.Request(url, headers={"accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace") if e.fp else ""
    except Exception as e:  # noqa: BLE001 - network probe, any failure = "not yet"
        return 0, str(e)


def plc_resolves(plc_url: str, did: str) -> bool:
    """True once the PLC directory serves a document for `did`."""
    code, _ = _get(f"{plc_url.rstrip('/')}/{did}")
    return code == 200


def appview_has_provider(appview_url: str, capability: str, did: str) -> bool:
    """True once the AppView's service.search for `capability` lists `did`."""
    qs = urllib.parse.urlencode({"capability": capability})
    code, body = _get(
        f"{appview_url.rstrip('/')}/xrpc/com.dinakernel.service.search?{qs}"
    )
    if code != 200:
        return False
    try:
        data = json.loads(body)
    except json.JSONDecodeError:
        return False
    for svc in data.get("services", []) or []:
        if svc.get("operatorDid") == did or svc.get("did") == did:
            return True
    return False


def appview_resolve(appview_url: str, subject: dict) -> tuple[int, dict]:
    """One-shot resolve of a subject ref (the {type,uri,...} JSON form)."""
    qs = urllib.parse.urlencode({"subject": json.dumps(subject)})
    code, body = _get(
        f"{appview_url.rstrip('/')}/xrpc/com.dinakernel.peerlens.resolve?{qs}"
    )
    try:
        return code, json.loads(body)
    except json.JSONDecodeError:
        return code, {"_raw": body[:200]}


def cmd_watch(args: argparse.Namespace) -> int:
    t0 = float(args.t0_epoch) if args.t0_epoch else _now()
    print(f"[T0] {_stamp(t0)}  start watching did={args.did}")
    print(f"     plc={args.plc_url or '(skipped)'}")
    print(f"     appview={args.appview_url} capability={args.capability}")
    print(f"     deadline={args.timeout}s poll={args.interval}s")

    t1: Optional[float] = None
    t3: Optional[float] = None
    deadline = t0 + args.timeout

    while _now() < deadline and (t1 is None or t3 is None):
        if t1 is None and args.plc_url and plc_resolves(args.plc_url, args.did):
            t1 = _now()
            print(f"[T1] {_stamp(t1)}  PLC resolves did  (+{t1 - t0:6.1f}s from T0)")
        if t3 is None and appview_has_provider(args.appview_url, args.capability, args.did):
            t3 = _now()
            print(f"[T3] {_stamp(t3)}  AppView discovery has provider  (+{t3 - t0:6.1f}s from T0)")
        if t1 is not None and t3 is not None:
            break
        time.sleep(args.interval)

    print("\n=== TIMELINE ===")
    print(f"  T0 provision/start : {_stamp(t0)}")
    if t1 is not None:
        print(f"  T1 PLC resolves    : {_stamp(t1)}  (T0->T1 = {t1 - t0:.1f}s)")
    elif args.plc_url:
        print(f"  T1 PLC resolves    : NOT within {args.timeout}s")
    if t3 is not None:
        print(f"  T3 AppView visible : {_stamp(t3)}  (T0->T3 = {t3 - t0:.1f}s)")
        if t1 is not None:
            print(f"                       (T1->T3 = {t3 - t1:.1f}s  <-- PLC->visible)")
    else:
        print(f"  T3 AppView visible : NOT within {args.timeout}s")

    print("\n=== READING THE RESULT ===")
    print("  T0->T1 dominates  => PLC directory propagation is the lag (H1)")
    print("  T1->T3 dominates  => relay/firehose (H2) or AppView ingester gate")
    print("                       (add the firehose tap / read deployed ingester logs)")
    return 0


def cmd_check(args: argparse.Namespace) -> int:
    print(f"did={args.did}")
    if args.plc_url:
        print(f"  PLC resolves: {plc_resolves(args.plc_url, args.did)}")
    print(
        f"  AppView discovery ({args.capability}) has provider: "
        f"{appview_has_provider(args.appview_url, args.capability, args.did)}"
    )
    if args.subject_uri:
        code, data = appview_resolve(
            args.appview_url, {"type": args.subject_type, "uri": args.subject_uri}
        )
        print(f"  resolve({args.subject_type}, {args.subject_uri}) -> HTTP {code}")
        print(f"    subjectId={data.get('subjectId')} reviewCount={data.get('reviewCount')}")
    return 0


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)

    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--did", required=True)
    common.add_argument("--appview-url", default="https://test-appview.dinakernel.com")
    common.add_argument("--plc-url", default="")
    common.add_argument("--capability", default="appointment_status")

    w = sub.add_parser("watch", parents=[common], help="poll until visible, print timeline")
    w.add_argument("--timeout", type=float, default=2400.0, help="max seconds to watch (default 40m)")
    w.add_argument("--interval", type=float, default=10.0, help="poll interval seconds")
    w.add_argument("--t0-epoch", default="", help="override T0 with a unix-seconds timestamp")
    w.set_defaults(func=cmd_watch)

    c = sub.add_parser("check", parents=[common], help="one-shot point check")
    c.add_argument("--subject-uri", default="", help="optionally also resolve a subject uri")
    c.add_argument("--subject-type", default="content")
    c.set_defaults(func=cmd_check)

    args = p.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
