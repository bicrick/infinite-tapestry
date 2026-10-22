import { describe, expect, it, vi } from "vitest";
import { addStripScene, sceneAt, timeAt, Timeline, PREFETCH_INFLIGHT, PREFETCH_WAIT_MS, type SceneRow } from "./timeline";

describe("scene index", () => {
  it("inserts out-of-order refs in index order and merges runs", () => {
    const rows: SceneRow[] = [];
    addStripScene(rows, 50, ["B", "bob", "none", "user"]);
    addStripScene(rows, 10, ["A", "", "none", "auto"]);
    addStripScene(rows, 12, ["A", "", "none", "auto"]);   // inside A's run
    addStripScene(rows, 40, ["B", "bob", "none", "user"]); // B starts earlier than we knew
    addStripScene(rows, 30, ["C", "", "photo", "auto"]);
    addStripScene(rows, 30, ["C", "", "photo", "auto"]);   // already known
    addStripScene(rows, 31, null);
    expect(rows.map((r) => [r[0], r[1]])).toEqual([[10, "A"], [30, "C"], [40, "B"]]);
    expect(sceneAt(rows, 9)).toBeNull();
    expect(sceneAt(rows, 35)![1]).toBe("C");
    expect(sceneAt(rows, 1e6)![1]).toBe("B");
  });
  it("interpolates strip times and extrapolates past the last sample", () => {
    const P: Array<[number, number]> = [[0, 100], [10, 200]];
    expect(timeAt([], 5, 2)).toBeNull();
    expect(timeAt(P, -3, 2)).toBe(100);
    expect(timeAt(P, 5, 2)).toBe(150);
    expect(timeAt(P, 12, 3)).toBe(206);
    expect(timeAt(P, 12, undefined)).toBe(204);
  });
});

describe("history LOD prefetch", () => {
  it("waits for the on-screen strips, then keeps only a few tiles in flight, same tiles as before", async () => {
    vi.useFakeTimers();
    let ready = false; let pending = 0; const got: number[] = [];
    const t = new Timeline({ httpBase: () => "", maxIndex: () => 64 * 10 + 5, stripSeconds: () => undefined,
      prefetchL2: (c) => { got.push(c); pending++; }, viewReady: () => ready, lodPending: () => pending });
    t.prefetchHistory();
    vi.advanceTimersByTime(1000);
    expect(got).toEqual([]);                       // strips still loading: nothing yet
    ready = true; vi.advanceTimersByTime(250);
    expect(got.length).toBe(PREFETCH_INFLIGHT);    // capped
    for (let k = 0; k < 20; k++) { pending = 0; vi.advanceTimersByTime(70); }
    expect(got).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    vi.useRealTimers();
  });
  it("goes anyway after the wait cap", () => {
    vi.useFakeTimers();
    const got: number[] = [];
    const t = new Timeline({ httpBase: () => "", maxIndex: () => 200, stripSeconds: () => undefined,
      prefetchL2: (c) => { got.push(c); }, viewReady: () => false, lodPending: () => 0 });
    t.prefetchHistory();
    vi.advanceTimersByTime(PREFETCH_WAIT_MS + 500);
    expect(got).toEqual([0, 1, 2]);
    vi.useRealTimers();
  });
});
