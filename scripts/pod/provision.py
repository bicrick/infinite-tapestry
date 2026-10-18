#!/usr/bin/env python3
"""One-command replacement GPU pod: create on RunPod, bootstrap over SSH, point the app at it.

Usage (from the ops box):  python3 scripts/pod/provision.py [--name tapestry-sdxl] [--max-price 0.90] [--pod ID]
Needs RUNPOD_API_KEY plus the secrets in ~/.tapestry/supabase.env (Supabase, R2) and TAPESTRY_ANTHROPIC_API_KEY,
and the SSH key ~/.ssh/rp_tapestry. Never prints secrets. Never terminates an existing pod.
Steps: create pod (RTX 4090 first, then other 24 GB GPUs under --max-price) -> wait for SSH -> write /root/.tapestry.env
and /root/run.sh -> pull the latest CI release from the Supabase `deploy` bucket -> install /post_start.sh -> start the
supervisor -> set pod_state.pod_id (Vercel + site follow it). Model weights download from Hugging Face on first start.
"""
import argparse, json, os, pathlib, shlex, subprocess, sys, time, urllib.request

IMAGE = "runpod/pytorch:2.4.0-py3.11-cuda12.4.1-devel-ubuntu22.04"
GPUS = ["NVIDIA GeForce RTX 4090", "NVIDIA RTX A5000", "NVIDIA GeForce RTX 3090", "NVIDIA L4"]
KEY = pathlib.Path.home() / ".ssh/rp_tapestry"
ENV_KEYS = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "TAPESTRY_ANTHROPIC_API_KEY", "RUNPOD_API_KEY",
            "R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_PUBLIC_URL", "R2_BUCKET"]
FIXED = {"TAPESTRY_BACKEND": "sdxl", "TAPESTRY_SUPABASE_PUBLIC": "1", "TAPESTRY_STORAGE_PREFIX": "live-sdxl", "TAPESTRY_GPU_CENTS_PER_HOUR": "89", "TAPESTRY_SITE_URL": "https://infinitetapestry.app"}
RUN_SH = """#!/bin/bash
set -a; . /root/.tapestry.env; set +a
cd /root/it
exec python -m infinite_tapestry.main --host 0.0.0.0 --port 8000 --data-dir /root/data-sdxl
"""
BOOT = r'''set -e; set -a; . /root/.tapestry.env; set +a
B="$SUPABASE_URL/storage/v1/object/deploy/worker"; H=(-H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY")
SHA=$(curl -sf "${H[@]}" "$B/latest.txt" | tr -dc a-f0-9 | head -c 40); D=/root/releases/$SHA; mkdir -p "$D"
curl -sf "${H[@]}" "$B/$SHA.tgz" -o /tmp/w.tgz && tar xzf /tmp/w.tgz -C "$D" && touch "$D/.ok" && ln -sfn "$D" /root/it
cp /root/it/scripts/pod/post_start.sh /post_start.sh && chmod +x /post_start.sh /root/it/scripts/pod/*.sh
pkill -f supervise.sh || true
nohup bash /root/it/scripts/pod/boot.sh >> /root/supervise.log 2>&1 < /dev/null &
echo "release $SHA"'''


def load_env():
    env = dict(os.environ)
    for f in ["~/.tapestry/supabase.env", "~/.tapestry/app.env"]:
        p = pathlib.Path(f).expanduser()
        if p.exists():
            for line in p.read_text().splitlines():
                line = line.strip().removeprefix("export ")
                if "=" in line and not line.startswith("#"):
                    k, v = line.split("=", 1)
                    env.setdefault(k.strip(), v.strip().strip('"').strip("'"))
    return env


def gql(env, q):
    r = urllib.request.Request("https://api.runpod.io/graphql", data=json.dumps({"query": q}).encode(),
                               headers={"content-type": "application/json", "authorization": "Bearer " + env["RUNPOD_API_KEY"]})
    j = json.loads(urllib.request.urlopen(r, timeout=60).read())
    if j.get("errors"):
        raise RuntimeError(j["errors"][0].get("message", "runpod error"))
    return j["data"]


def create(env, name, max_price):
    pub = KEY.with_suffix(".pub").read_text().strip()
    for gpu in GPUS:
        for cloud in ["SECURE", "COMMUNITY"]:
            q = f'''mutation {{ podFindAndDeployOnDemand(input: {{ cloudType: {cloud}, gpuCount: 1, gpuTypeId: "{gpu}", name: "{name}",
              imageName: "{IMAGE}", containerDiskInGb: 60, volumeInGb: 0, ports: "8000/http,22/tcp", minVcpuCount: 4, minMemoryInGb: 24,
              env: [{{ key: "PUBLIC_KEY", value: {json.dumps(pub)} }}] }}) {{ id costPerHr machineId }} }}'''
            try:
                p = gql(env, q)["podFindAndDeployOnDemand"]
            except Exception as e:
                print(f"  {gpu} / {cloud}: {e}", flush=True)
                continue
            if p and float(p["costPerHr"]) > max_price:
                print(f"  {gpu} / {cloud}: ${p['costPerHr']}/h is over the cap; stopping (not terminating) it", flush=True)
                gql(env, f'mutation {{ podStop(input: {{podId: "{p["id"]}"}}) {{ id }} }}')
                continue
            if p:
                print(f"created {p['id']} ({gpu}, {cloud}, ${p['costPerHr']}/h)", flush=True)
                return p["id"]
    sys.exit("no GPU available under the price cap")


def ssh_addr(env, pid, timeout=900):
    t0 = time.time()
    while time.time() - t0 < timeout:
        d = gql(env, f'query {{ pod(input: {{podId: "{pid}"}}) {{ runtime {{ ports {{ ip isIpPublic privatePort publicPort }} }} }} }}')["pod"]
        for p in ((d or {}).get("runtime") or {}).get("ports") or []:
            if p["privatePort"] == 22 and p["isIpPublic"]:
                return p["ip"], p["publicPort"]
        time.sleep(10)
    sys.exit("pod never exposed SSH")


def ssh(addr, cmd, stdin=None):
    ip, port = addr
    return subprocess.run(["ssh", "-i", str(KEY), "-p", str(port), "-o", "StrictHostKeyChecking=no", "-o", "ConnectTimeout=20",
                           f"root@{ip}", cmd], input=stdin, capture_output=True, text=True, timeout=900)


def main():
    a = argparse.ArgumentParser()
    a.add_argument("--name", default="tapestry-sdxl")
    a.add_argument("--max-price", type=float, default=0.90)
    a.add_argument("--pod", help="bootstrap an existing pod id instead of creating one")
    a.add_argument("--no-switch", action="store_true", help="don't point pod_state.pod_id at it")
    o = a.parse_args()
    env = load_env()
    missing = [k for k in ENV_KEYS if not env.get(k)]
    if missing:
        sys.exit("missing env: " + ", ".join(missing))
    pid = o.pod or create(env, o.name, o.max_price)
    addr = ssh_addr(env, pid)
    print("ssh up", addr, flush=True)
    for _ in range(30):
        if ssh(addr, "true").returncode == 0:
            break
        time.sleep(10)
    body = "".join(f"{k}={shlex.quote(env[k])}\n" for k in ENV_KEYS) + "".join(f"{k}={v}\n" for k, v in FIXED.items()) + f"RUNPOD_POD_ID={pid}\n"
    r = ssh(addr, "umask 077; cat > /root/.tapestry.env", body)
    assert r.returncode == 0, r.stderr[-300:]
    ssh(addr, "cat > /root/run.sh && chmod +x /root/run.sh", RUN_SH)
    r = ssh(addr, "bash -s", BOOT)
    print(r.stdout.strip()[-200:] or r.stderr.strip()[-300:], flush=True)
    if not o.no_switch:
        req = urllib.request.Request(f"{env['SUPABASE_URL']}/rest/v1/pod_state?id=eq.1", method="PATCH",
                                     data=json.dumps({"pod_id": pid, "desired": "on"}).encode(),
                                     headers={"apikey": env["SUPABASE_SERVICE_ROLE_KEY"], "authorization": "Bearer " + env["SUPABASE_SERVICE_ROLE_KEY"],
                                              "content-type": "application/json", "prefer": "return=minimal"})
        urllib.request.urlopen(req, timeout=20)
        print("pod_state.pod_id ->", pid, flush=True)
    print(f"done. ws: wss://{pid}-8000.proxy.runpod.net/ws  (first start downloads SDXL weights, ~5-10 min)")


if __name__ == "__main__":
    main()
