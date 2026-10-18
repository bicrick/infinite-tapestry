#!/usr/bin/env python3
"""Sample the prod pod's public /health for a while and summarise throughput. No SSH, no box state.
Usage: scripts/ops/pod_health.py [SECONDS=120]. The pod comes from POD_ID, else Supabase pod_state.pod_id
(SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY)."""
import json, os, statistics as S, sys, time, urllib.request


def pod_id():
    if os.environ.get("POD_ID"):
        return os.environ["POD_ID"]
    url, key = os.environ["SUPABASE_URL"].rstrip("/"), os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    req = urllib.request.Request(f"{url}/rest/v1/pod_state?id=eq.1&select=pod_id", headers={"apikey": key, "Authorization": f"Bearer {key}"})
    return json.loads(urllib.request.urlopen(req, timeout=20).read())[0]["pod_id"]


def main():
    secs = int(sys.argv[1]) if len(sys.argv) > 1 else 120
    pod = pod_id(); url = f"https://{pod}-8000.proxy.runpod.net/health"
    rows = []
    for _ in range(max(1, secs // 5)):
        try:
            rows.append(json.loads(urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "it-ops"}), timeout=10).read()))
        except Exception as e:
            print("health error:", type(e).__name__, file=sys.stderr)
        time.sleep(5)
    if not rows:
        sys.exit("no /health answers")
    last = rows[-1]
    ss = [r["gpu"]["strip_seconds"] for r in rows if r.get("gpu", {}).get("strip_seconds")]
    px = [r["gpu"]["px_per_sec"] for r in rows if r.get("gpu", {}).get("px_per_sec")]
    sp = [r["timeline"]["speed"] for r in rows if "timeline" in r]
    dep = [r["buffer"]["depth"] for r in rows if "buffer" in r]
    print(json.dumps({"pod": pod, "samples": len(rows), "status": last.get("status"), "alarms": last.get("alarms"),
                      "r2_write_ok": last.get("storage", {}).get("r2", {}).get("write_ok"),
                      "strip_seconds_median": S.median(ss) if ss else None, "gpu_px_per_sec_median": S.median(px) if px else None,
                      "timeline_px_per_sec_median": S.median(sp) if sp else None,
                      "buffer_depth_min": min(dep) if dep else None, "strip_index": last.get("strip_index")}, indent=1))


if __name__ == "__main__":
    main()
