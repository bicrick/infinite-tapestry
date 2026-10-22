// Replay start position (GPU off / stream quiet): a uniformly random strip across the whole history, chosen per
// page load in the browser, so every visitor and every refresh lands somewhere different.
// RUNWAY keeps ~30 min of playback ahead (256 px strips at 60 px/s ≈ 4.3 s each) before the live edge loops it.
// LOST spans cover a stretch of history with missing strips (scattered blanks and a 28-strip gap at 105651-105678);
// a start inside one, or within RUNWAY before it, would open on blank columns, so those starts are skipped.
(function (root) {
  const RUNWAY = 420;
  const LOST = [[102661, 106143]];
  function replayStart(maxIndex, rand = Math.random) {
    const hi = maxIndex - RUNWAY;
    if (hi <= 0) return Math.max(0, Math.floor(maxIndex / 2));
    // Allowed starts: [0, hi] minus each [a - RUNWAY, b]; sample uniformly over their total length.
    const spans = [];
    let from = 0;
    for (const [a, b] of LOST) {
      const cut0 = Math.max(0, a - RUNWAY), cut1 = Math.min(hi, b);
      if (cut0 > hi || cut1 < from) continue;
      if (cut0 > from) spans.push([from, cut0 - 1]);
      from = cut1 + 1;
    }
    if (from <= hi) spans.push([from, hi]);
    const total = spans.reduce((n, [a, b]) => n + b - a + 1, 0);
    if (!total) return hi;
    let k = Math.floor(rand() * total);
    for (const [a, b] of spans) { if (k <= b - a) return a + k; k -= b - a + 1; }
    return hi;
  }
  root.TapestryReplayStart = replayStart;
  if (typeof module !== "undefined") module.exports = { replayStart, RUNWAY, LOST };
})(typeof window !== "undefined" ? window : globalThis);
