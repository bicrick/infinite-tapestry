// CDN failover: the custom image domain is primary; if it is unreachable from this client (DNS blocked or a stale
// NXDOMAIN, i.e. fetch fails with a network error, not an HTTP status) for CDN_FAILS loads in a row, switch once,
// for the rest of the session, to the bucket's public r2.dev URL (same objects, same paths). Bytes are identical.
export const CDN_PRIMARY = "https://img.infinitetapestry.app/";
export const CDN_FALLBACK = "https://pub-631bdb4d40c54807b1c2de9402e07893.r2.dev/";
export const CDN_FAILS = 3;

let fails = 0;
let switched = false;
const listeners: Array<() => void> = [];

/** the URL to request: rewritten onto the fallback host once switched */
export function cdn(u: string): string {
  return switched && u.startsWith(CDN_PRIMARY) ? CDN_FALLBACK + u.slice(CDN_PRIMARY.length) : u;
}
export function cdnSwitched(): boolean { return switched; }
/** a load from `u` succeeded (any HTTP answer counts: the host is reachable) */
export function cdnOk(u: string): void { if (!switched && u.startsWith(CDN_PRIMARY)) fails = 0; }
/** a load of `u` (the URL as requested) failed with a network error; true when it should be retried at once
 *  through the fallback (it was a primary request and the switch is now on) */
export function cdnNetFail(u: string): boolean {
  if (!u.startsWith(CDN_PRIMARY)) return false;
  if (!switched && ++fails >= CDN_FAILS) {
    switched = true;
    for (const f of listeners) try { f(); } catch { /* ignore */ }
  }
  return switched;
}
/** called once, when the switch happens (e.g. to re-request tiles that failed on the primary host) */
export function onCdnSwitch(f: () => void): void { listeners.push(f); }
/** tests only */
export function cdnReset(): void { fails = 0; switched = false; listeners.length = 0; }
