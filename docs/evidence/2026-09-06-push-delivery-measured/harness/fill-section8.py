#!/usr/bin/env python3
"""Fill spec §8 measured columns from L7 evidence files. Prints the table markdown."""
from __future__ import annotations

import json
from pathlib import Path

EVID = Path(__file__).resolve().parent.parent


def load(name: str):
    return json.loads((EVID / name).read_text())


def main() -> None:
    before = load("state/before/counts.json")
    after = load("state/after/counts.json")
    status = load("state/after/status-window-end.json")
    wake = status.get("wake") or {}
    bi, ai = before["invocations"], after["invocations"]
    br, ar = before["rows"], after["rows"]

    probes = EVID / "probes"
    wake_lat = json.loads((probes / "wake-latency.json").read_text()) if (probes / "wake-latency.json").exists() else None
    dropped = json.loads((probes / "wake-dropped.json").read_text()) if (probes / "wake-dropped.json").exists() else None
    realtime = json.loads((probes / "realtime-down.json").read_text()) if (probes / "realtime-down.json").exists() else None
    rotation = json.loads((probes / "rotation.json").read_text()) if (probes / "rotation.json").exists() else None
    honesty = (EVID / "honesty/probe.txt").read_text() if (EVID / "honesty/probe.txt").exists() else ""

    def ms(stats):
        if not stats or stats.get("n") == 0:
            return "n/a"
        mean = stats["mean"]
        mx = stats["max"]
        return f"mean {mean/1000:.3f} s, max {mx/1000:.3f} s (n={stats['n']})"

    print("## §8 measured cells")
    print()
    print(f"invocations before: read {bi['read']} + claim {bi['command']} + activity {bi['activity']} = **{bi['total']}**  [state/before/counts.json]")
    print(f"invocations after:  read {ai['read']} + claim {ai['command']} + activity {ai['activity']} = **{ai['total']}**  [state/after/counts.json]")
    print(f"rows before: audit {br['audit_log']} + idempotency {br['idempotency_keys']} + rate_buckets {br['rate_buckets']}  [state/before/counts.json]")
    print(f"rows after:  audit {ar['audit_log']} + idempotency {ar['idempotency_keys']} + rate_buckets {ar['rate_buckets']}  [state/after/counts.json]")
    print(f"after listen status wake.mode={wake.get('mode')!r}  [state/after/status-window-end.json]")
    if wake_lat:
        print(f"wake latency after: {ms(wake_lat.get('stats'))}  [probes/wake-latency.json]")
    if realtime:
        print(f"realtime down detect poll ms={realtime.get('detectPollMs')} delivery {ms(realtime.get('downStats'))} back-to-push ms={realtime.get('backToPushMs')}  [probes/realtime-down.json]")
    if dropped:
        print(f"wake dropped: {ms(dropped.get('stats'))}  [probes/wake-dropped.json]")
    if rotation:
        print(f"rotation resubscribeMs={rotation.get('resubscribeMs')}  [probes/rotation.json]")
    print()
    print("honesty excerpt:")
    print(honesty[:1500])


if __name__ == "__main__":
    main()
