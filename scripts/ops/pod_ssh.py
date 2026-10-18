#!/usr/bin/env python3
"""Run a shell command on the prod pod over SSH (for debugging; deploys never need this).
Usage: scripts/ops/pod_ssh.py 'command'. Resolves the pod's SSH ip:port from the RunPod API (RUNPOD_API_KEY; pod from
POD_ID or Supabase pod_state). Key: POD_SSH_KEY_FILE (default ~/.ssh/rp_tapestry; its public half is SSH_PUB in
web/lib/gpu.js, so pods created by the GPU switch accept it). Needs paramiko."""
import json, os, sys, urllib.request

sys.path.insert(0, os.path.dirname(__file__))
from pod_health import pod_id  # noqa: E402


def ssh_addr(pod):
    q = {"query": f'query {{ pod(input: {{podId: "{pod}"}}) {{ runtime {{ ports {{ ip publicPort privatePort isIpPublic }} }} }} }}'}
    req = urllib.request.Request(f"https://api.runpod.io/graphql?api_key={os.environ['RUNPOD_API_KEY']}", data=json.dumps(q).encode(),
                                 headers={"Content-Type": "application/json", "User-Agent": "it-ops"})
    ports = json.loads(urllib.request.urlopen(req, timeout=20).read())["data"]["pod"]["runtime"]["ports"]
    p = next(p for p in ports if p["privatePort"] == 22 and p["isIpPublic"])
    return p["ip"], p["publicPort"]


def main():
    import paramiko
    host, port = (os.environ["POD_SSH_HOST"], int(os.environ["POD_SSH_PORT"])) if os.environ.get("POD_SSH_HOST") else ssh_addr(pod_id())
    c = paramiko.SSHClient(); c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(host, port, "root", key_filename=os.path.expanduser(os.environ.get("POD_SSH_KEY_FILE", "~/.ssh/rp_tapestry")), timeout=20)
    _, o, e = c.exec_command(sys.argv[1])
    sys.stdout.write(o.read().decode("utf-8", "replace")); sys.stderr.write(e.read().decode("utf-8", "replace"))
    sys.exit(o.channel.recv_exit_status())


if __name__ == "__main__":
    main()
