// Generative ambient: warm pad + airy upper layer, long generated reverb, slow random chord walk. No files.
export function createAmbient(ctx, out) {
  const m2f = m => 440 * Math.pow(2, (m - 69) / 12), R = Math.random;
  const master = ctx.createGain(); master.gain.value = 3; master.connect(out);
  // reverb: generated decaying-noise impulse (6 s), mostly wet
  const verb = ctx.createConvolver(), len = Math.floor(ctx.sampleRate * 6), ir = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) { const d = ir.getChannelData(ch); for (let i = 0; i < len; i++) { const x = i / len; d[i] = (R() * 2 - 1) * Math.pow(1 - x, 3.2) * (i < 2400 ? i / 2400 : 1); } }
  verb.buffer = ir;
  const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 3200; lp.Q.value = 0.3;
  const dry = ctx.createGain(); dry.gain.value = 0.55; const wet = ctx.createGain(); wet.gain.value = 0.75;
  const bus = ctx.createGain(); bus.gain.value = 0.9;
  bus.connect(lp); lp.connect(dry); dry.connect(master); lp.connect(verb); verb.connect(wet); wet.connect(master);
  const wave = ctx.createPeriodicWave(new Float32Array([0, 0, 0]), new Float32Array([0, 1, 0.25]));
  // chord pool (D major / B minor colour: maj9, m11, maj7#11, add9, sus2 ...) as pitch-class sets over a root
  const shapes = [[0, 7, 11, 14, 16, 19], [0, 7, 10, 14, 17, 19], [0, 7, 11, 14, 18, 23], [0, 7, 12, 14, 16, 19], [0, 7, 9, 14, 16, 21], [0, 5, 7, 12, 14, 19]];
  const roots = [50, 47, 43, 45, 52, 42];  // D B G A E F#
  const okShape = { 50: [0, 3, 4, 5], 47: [1, 4, 5], 43: [0, 2, 5], 45: [3, 4, 5], 52: [1, 4, 5], 42: [1, 5] };
  let root = 50, shape = 0, last = [];
  function nextChord() {
    let r; do { r = roots[Math.floor(R() * roots.length)]; } while (r === root && R() < 0.85);
    root = r; const ok = okShape[r] || [0]; shape = ok[Math.floor(R() * ok.length)];
    // voicing: random inversion/spread kept near the last chord (voice leading)
    let notes = shapes[shape].map(i => root + i + (R() < 0.25 ? 12 : 0));
    if (last.length) notes = notes.map(n => { const c = last.reduce((a, b) => Math.abs(b - n) < Math.abs(a - n) ? b : a, last[0]); return Math.abs(c - n) > 9 ? n + (c > n ? 12 : -12) : n; });
    notes = notes.map(n => Math.max(45, Math.min(76, n))); last = notes; return notes;
  }
  function voice(f, t, dur, a, rel, g, pan, trem) {
    const o = ctx.createOscillator(); o.setPeriodicWave(wave); o.frequency.value = f;
    const e = ctx.createGain(); e.gain.setValueAtTime(0, t); e.gain.linearRampToValueAtTime(g, t + a); e.gain.setValueAtTime(g, t + dur - rel); e.gain.linearRampToValueAtTime(0, t + dur);
    const p = ctx.createStereoPanner(); p.pan.value = pan;
    o.connect(e); let node = e;
    if (trem) { const tg = ctx.createGain(); tg.gain.value = 0.7; const l = ctx.createOscillator(); l.frequency.value = 0.08 + R() * 0.12; const lg = ctx.createGain(); lg.gain.value = 0.3; l.connect(lg); lg.connect(tg.gain); e.connect(tg); node = tg; l.start(t); l.stop(t + dur); }
    node.connect(p); p.connect(bus); o.start(t); o.stop(t + dur + 0.05);
  }
  function schedule(t) {
    const CL = 9 + R() * 6, c = nextChord();
    for (const m of c) for (const d of [-0.006, 0.006]) voice(m2f(m) * (1 + d), t, CL + 3.5, 3 + R(), 3.5, 0.028, d * 60, false);
    voice(m2f(root - 12), t, CL + 3.5, 2, 3.5, 0.07, 0, false);
    for (const m of c.slice(2)) if (R() < 0.8) voice(m2f(m + 12), t + R() * 1.5, CL + 4, 4, 4, 0.011, R() * 1.2 - 0.6, true);
    return t + CL;
  }
  return { master, schedule };
}
// realtime player: schedules ~1 chord ahead with a lazy timer (no per-frame work)
let P = null;
export function player() {
  if (P) return P;
  const AC = window.AudioContext || window.webkitAudioContext; const ctx = new AC({ latencyHint: "playback" });
  const fade = ctx.createGain(); fade.gain.value = 0; fade.connect(ctx.destination);
  const amb = createAmbient(ctx, fade); let next = 0, timer = 0, on = false;
  const pump = () => { while (next < ctx.currentTime + 14) next = amb.schedule(Math.max(next, ctx.currentTime + 0.05)); timer = setTimeout(pump, 4000); };
  P = {
    async start() { on = true; await ctx.resume(); if (!timer) pump(); const t = ctx.currentTime; fade.gain.cancelScheduledValues(t); fade.gain.setValueAtTime(fade.gain.value, t); fade.gain.linearRampToValueAtTime(0.8, t + 3); },
    stop() { on = false; const t = ctx.currentTime; fade.gain.cancelScheduledValues(t); fade.gain.setValueAtTime(fade.gain.value, t); fade.gain.linearRampToValueAtTime(0, t + 3);
      setTimeout(() => { if (!on) { clearTimeout(timer); timer = 0; next = 0; ctx.suspend(); } }, 3200); },
    get on() { return on; }, ctx
  };
  return P;
}
