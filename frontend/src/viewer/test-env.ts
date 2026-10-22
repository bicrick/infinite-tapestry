// Minimal browser globals for unit-testing the viewer modules under Node (no DOM needed by the code under test).
export function fakeBrowser(o: { dpr?: number; innerW?: number; innerH?: number; fullscreen?: boolean } = {}): void {
  const g = globalThis as Record<string, unknown>;
  g.window = Object.assign((g.window as object) || {}, { devicePixelRatio: o.dpr ?? 1 });
  g.document = { fullscreenElement: o.fullscreen ? {} : null, hidden: false, body: { classList: { contains: () => false } } };
  g.innerWidth = o.innerW ?? 1280; g.innerHeight = o.innerH ?? 800;
}
export function fakeCanvas(cssW: number, cssH: number, dpr: number): HTMLCanvasElement {
  return { clientWidth: cssW, clientHeight: cssH, width: Math.floor(cssW * Math.min(dpr, 2)), height: Math.floor(cssH * Math.min(dpr, 2)) } as unknown as HTMLCanvasElement;
}
