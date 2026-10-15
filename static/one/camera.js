// Tapestry.camera: the ONE camera. State {centerTime (unit), zoom (log2 px-per-unit vs the live scale; 0 = live
// scale, < 0 = zoomed out), followLive}. Every input (wheel, keys, drag, pinch, buttons, deep links) writes a TARGET;
// one critically damped spring per axis (shared omega) moves the camera there. No lerps, no detents, no hand-offs.
// Zoom is anchored at a screen x: while the zoom spring runs, centreTime is solved so the anchored unit stays put.
(() => {
  "use strict";
  const T = (window.Tapestry = window.Tapestry || {});
  const RM = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const OMEGA = 16;           // rad/s: ~0.3 s to settle, no overshoot (critically damped)
  const Z_OUT = -1.5;         // zoomProgress reaches 1 here (UI morph is done)
    const MAGNET_Z = 0.15;      // released within this zoom and near the head -> go live
  const ls = new Map();
  const emit = (n, a) => { const s = ls.get(n); if (s) for (const f of s) f(a); };
  // Critically damped spring, exact step: e = x - target.
  function spring(x, v, target, dt) {
    if (RM) return [target, 0];
    const e = x - target, w = OMEGA, k = Math.exp(-w * dt), b = v + w * e;
    return [target + (e + b * dt) * k, (v - w * b * dt) * k];
  }
  const st = {
    c: 0, vc: 0, tc: 0, z: 0, vz: 0, tz: 0, followLive: false, playing: false,
    W: 1, H: 1, sLive: 100, head: 1, zMin: -12, rate: () => 0.35, anchor: null, drag: null, moving: true,
  };
  const sOf = (z) => st.sLive * Math.pow(2, z);
  const span = (z) => st.W / sOf(z);
  function clampT() {
    st.tz = Math.min(0, Math.max(st.zMin, st.tz));
    const sp = span(st.tz), h = st.head;
    st.tc = sp >= h / 0.8 ? h / 2 : Math.min(h - sp * rightK(st.tz), Math.max(sp * 0.3, st.tc));
  }
  // The head sits at the right screen edge at zoom 0 (exactly like the classic live view) and at 80% when zoomed out.
  const rightK = (z) => 0.5 - 0.2 * Math.min(1, Math.max(0, z / Z_OUT));
  const liveCentre = () => st.head - span(st.tz) * rightK(st.tz);
  function leaveLive() { if (st.followLive) { st.followLive = false; emit("live", false); } } // instant, no rubber band
  const cam = {
    // Layout: called on resize / manifest. sLive = live px per unit (CSS), head = newest unit.
    layout({ W, H, sLive, head, zMin }) {
      if (W) st.W = W; if (H) st.H = H; if (sLive) st.sLive = sLive; if (head != null) st.head = head; if (zMin != null) st.zMin = zMin;
      clampT(); st.moving = true;
    },
    setRate(fn) { st.rate = fn; },
    get() {
      const s = sOf(st.z);
      return { head: st.head, centerTime: st.c, zoom: st.z, followLive: st.followLive, playing: st.playing, s, span: st.W / s,
        zoomProgress: Math.min(1, Math.max(0, st.z / Z_OUT)), velocity: st.vc, target: { centerTime: st.tc, zoom: st.tz } };
    },
    get zoomProgress() { return Math.min(1, Math.max(0, st.z / Z_OUT)); },
    // Absolute target. anchorX (CSS px) keeps the unit under that x fixed while zooming.
    target({ centerTime, zoom, followLive, anchorX } = {}) {
      if (followLive === true) { st.followLive = true; emit("live", true); } else if (followLive === false || centerTime != null) leaveLive();
      if (zoom != null) { if (anchorX != null) st.anchor = { x: anchorX, u: st.c + (anchorX - st.W / 2) / sOf(st.z) }; else st.anchor = null; st.tz = zoom; }
      if (centerTime != null) { st.tc = centerTime; st.anchor = null; }
      clampT(); if (st.anchor) solveAnchor(true); st.moving = true; emit("change");
    },
    // Relative input (wheel, keys). dTime in units, dZoom in log2 steps.
    nudge({ dTime = 0, dZoom = 0, anchorX } = {}) {
      if (dZoom) {
        const ax = anchorX ?? st.W / 2;
        if (!st.anchor || Math.abs(st.anchor.x - ax) > 1) st.anchor = { x: ax, u: st.tc + (ax - st.W / 2) / sOf(st.tz) };
        st.tz += dZoom; if (dZoom < 0 || st.tz < -1e-3) { if (!st.followLive || dZoom < 0) stopPlay(); }
        clampT(); solveAnchor(true);
        if (st.followLive && dZoom < 0) leaveLive();
      }
      if (dTime) { stopPlay(); leaveLive(); st.anchor = null; st.tc += dTime; clampT(); }
      st.moving = true; emit("change");
    },
    // Drag: direct position (1:1 with the finger), release velocity fed into the spring.
    dragStart(x) { stopPlay(); leaveLive(); st.anchor = null; st.drag = { x, samples: [[performance.now(), x]] }; st.vc = 0; },
    dragMove(x) {
      const d = st.drag; if (!d) return; const s = sOf(st.z);
      st.c -= (x - d.x) / s; st.tc = st.c; d.x = x; clampT(); st.c = st.tc;
      d.samples.push([performance.now(), x]); if (d.samples.length > 6) d.samples.shift(); st.moving = true; emit("change");
    },
    dragEnd() {
      const d = st.drag; st.drag = null; if (!d) return;
      const a = d.samples[0], b = d.samples[d.samples.length - 1];
      if (b[0] - a[0] > 5 && performance.now() - b[0] < 80) {
        const v = -(b[1] - a[1]) / ((b[0] - a[0]) / 1000) / sOf(st.z); // units/s
        st.vc = v; st.tc = st.c + v * 2 / OMEGA; clampT(); // spring with initial velocity: glides ~2/omega worth
      }
      st.moving = true; cam.magnet();
    },
    pinch(ratio, midX) { cam.nudge({ dZoom: Math.log2(ratio), anchorX: midX }); },
    // Play: zoom to 0 at the current spot (same spring), then advance at the playback rate.
    play() {
      if (st.followLive) return;
      st.playing = true; st.anchor = null; st.tz = 0; st.tc = st.c; clampT(); st.moving = true; emit("play", true); emit("change");
    },
    pause() { stopPlay(); },
    goLive() { stopPlay(); st.anchor = null; st.tz = 0; st.followLive = true; st.tc = liveCentre(); clampT(); st.moving = true; emit("live", true); emit("change"); },
    magnet() { if (!st.followLive && st.tz > -MAGNET_Z && (st.head - st.tc) * sOf(0) < st.W) cam.goLive(); },
    // Advance one frame. Returns true while anything moves.
    setHead(fn) { st.headFn = fn; },
    step(dt) {
      let headMoved = false;
      if (st.headFn) { const h = st.headFn(dt); if (h != null && h !== st.head) { st.head = h; headMoved = true; if (!st.followLive) clampT(); } }
      if (st.followLive) { st.tc = liveCentre(); if (Math.abs(st.z - st.tz) < 1e-3 && !st.drag) { st.c = st.tc; st.vc = 0; } } // locked to the head: no spring lag
      if (st.playing && Math.abs(st.z - st.tz) < 0.01 && !st.drag) {
        st.tc += st.rate(st.tc) * dt; st.c = st.tc; st.vc = 0;
        if (st.tc >= liveCentre()) { cam.goLive(); }
      }
      [st.z, st.vz] = spring(st.z, st.vz, st.tz, dt);
      if (st.anchor && Math.abs(st.z - st.tz) < 1e-3 && Math.abs(st.vz) < 1e-2) st.anchor = null; // zoom done: the spring finishes any clamp offset
      if (st.anchor) solveAnchor(false);
      else if (!st.drag) [st.c, st.vc] = spring(st.c, st.vc, st.tc, dt);
      const s = sOf(st.z), still = Math.abs(st.z - st.tz) < 1e-4 && Math.abs(st.vz) < 1e-3 && Math.abs(st.c - st.tc) * s < 0.05 && Math.abs(st.vc) * s < 0.5;
      if (still) { st.z = st.tz; st.c = st.tc; st.vz = st.vc = 0; st.anchor = null; }
      const moving = !still || st.playing || !!st.drag || (st.followLive && headMoved); // following live with a still head = idle (zero GPU)
      if (st.moving && still && !st.playing) { st.moving = false; emit("settle"); }
      else if (!still) st.moving = true;
      return moving;
    },
    on(n, f) { if (!ls.has(n)) ls.set(n, new Set()); ls.get(n).add(f); return () => ls.get(n).delete(f); },
    // Jump with no animation (deep links, boot).
    set({ centerTime, zoom }) { if (zoom != null) st.z = st.tz = zoom; if (centerTime != null) st.c = st.tc = centerTime; st.vz = st.vc = 0; clampT(); st.c = st.tc; st.moving = true; },
    Z_OUT, _st: st,
  };
  function solveAnchor(targetOnly) {
    const a = st.anchor; if (!a) return;
    st.tc = a.u - (a.x - st.W / 2) / sOf(st.tz);
    clampT();
    if (!targetOnly) { st.c = a.u - (a.x - st.W / 2) / sOf(st.z); st.vc = 0; }
  }
  function stopPlay() { if (st.playing) { st.playing = false; emit("play", false); } }
  T.camera = cam;
})();
