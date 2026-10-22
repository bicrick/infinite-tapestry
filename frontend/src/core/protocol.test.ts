import { describe, expect, it } from "vitest";
import { decodeItap, stale } from "./protocol";

function frame(index: number, overlap: number, prompt: string, img: number[]): ArrayBuffer {
  const p = new TextEncoder().encode(prompt);
  const buf = new ArrayBuffer(16 + p.length + img.length);
  const v = new DataView(buf);
  "ITAP".split("").forEach((c, i) => v.setUint8(i, c.charCodeAt(0)));
  v.setUint32(4, index); v.setUint16(8, 128); v.setUint16(10, 512); v.setUint16(12, overlap); v.setUint16(14, p.length);
  new Uint8Array(buf, 16).set(p); new Uint8Array(buf, 16 + p.length).set(img);
  return buf;
}

describe("decodeItap", () => {
  it("decodes the binary strip frame", () => {
    const m = decodeItap(frame(102661, 96, "a city ✦", [1, 2, 3]))!;
    expect(m.index).toBe(102661); expect(m.overlap).toBe(96); expect(m.prompt).toBe("a city ✦");
    expect([...new Uint8Array(m.jpeg)]).toEqual([1, 2, 3]);
  });
  it("rejects other payloads", () => {
    const b = frame(1, 0, "", []); new DataView(b).setUint8(0, 88);
    expect(decodeItap(b)).toBeNull();
  });
});

describe("stale", () => {
  it("prefers the pod heartbeat, falls back to the newest strip", () => {
    expect(stale({ now: 1000, heartbeat_at: 950 })).toBe(false);
    expect(stale({ now: 1000, heartbeat_at: 900 })).toBe(true);
    expect(stale({ now: 1000, heartbeat_at: 990, last_at: 1 })).toBe(false);
    expect(stale({ now: 1000, last_at: 930 })).toBe(true);
    expect(stale({ now: 1000 })).toBe(false);
  });
});
