"""Smoke-test the Supabase RPCs with throwaway users (needs SUPABASE_URL, keys)."""
import json, os, sys, time, urllib.request, uuid

URL = os.environ["SUPABASE_URL"]; ANON = os.environ["SUPABASE_ANON_KEY"]; SR = os.environ["SUPABASE_SERVICE_ROLE_KEY"]


def call(path, body=None, token=None, key=ANON, method=None):
    h = {"apikey": key, "Content-Type": "application/json", "Authorization": "Bearer " + (token or key)}
    req = urllib.request.Request(URL + path, data=None if body is None else json.dumps(body).encode(), headers=h, method=method)
    try:
        r = urllib.request.urlopen(req); t = r.read().decode(); return r.status, (json.loads(t) if t else None)
    except urllib.error.HTTPError as e:
        t = e.read().decode()
        try: return e.code, json.loads(t)
        except Exception: return e.code, t


def make_user(tag):
    email = f"smoke-{tag}-{uuid.uuid4().hex[:6]}@example.com"; pw = uuid.uuid4().hex
    call("/auth/v1/admin/users", {"email": email, "password": pw, "email_confirm": True}, key=SR)
    s, tok = call("/auth/v1/token?grant_type=password", {"email": email, "password": pw})
    return tok["access_token"], tok["user"]["id"]


def rpc(name, args, tok):
    return call(f"/rest/v1/rpc/{name}", args, token=tok)


a, aid = make_user("a"); b, bid = make_user("b")
print("idea before handle:", rpc("submit_idea", {"p_body": "x y"}, a))
h = "smoke_" + uuid.uuid4().hex[:6]
print("handle:", rpc("set_handle", {"p_handle": h}, a)); rpc("set_handle", {"p_handle": h + "b"}, b)
s, idea = rpc("submit_idea", {"p_body": "a cathedral of whales drifting through fog"}, a); print("idea:", s, idea)
print("second idea:", rpc("submit_idea", {"p_body": "another one"}, a))
print("sexual idea:", rpc("submit_idea", {"p_body": "naked people dancing"}, b))
print("vote b:", rpc("toggle_vote", {"p_idea": idea}, b))
print("chat:", [rpc("send_chat", {"p_body": f"hi {i}"}, b)[1] for i in range(7)])
print("audit (anon):", call("/rest/v1/rpc/admin_audit", {}, token=b)[1])
print("fuel:", call("/rest/v1/fuel_status")[1])
