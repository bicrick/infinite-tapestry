import { afterEach, describe, expect, it, vi } from "vitest";
import { cdn, cdnNetFail, cdnOk, cdnReset, cdnSwitched, onCdnSwitch, CDN_FAILS, CDN_FALLBACK, CDN_PRIMARY } from "./cdn";

const u = CDN_PRIMARY + "live-sdxl/strips/00000001.webp";
afterEach(() => cdnReset());

describe("cdn failover", () => {
  it("leaves URLs alone until switched", () => {
    expect(cdn(u)).toBe(u);
    expect(cdnSwitched()).toBe(false);
  });
  it("switches once after CDN_FAILS consecutive network failures and rewrites the host only", () => {
    const f = vi.fn(); onCdnSwitch(f);
    for (let i = 1; i < CDN_FAILS; i++) expect(cdnNetFail(u)).toBe(false);
    expect(cdnNetFail(u)).toBe(true);
    expect(cdnNetFail(u)).toBe(true);
    expect(f).toHaveBeenCalledTimes(1);
    expect(cdn(u)).toBe(CDN_FALLBACK + "live-sdxl/strips/00000001.webp");
    expect(cdn("https://example.com/x")).toBe("https://example.com/x");
  });
  it("a success resets the count; other hosts never count", () => {
    for (let i = 1; i < CDN_FAILS; i++) cdnNetFail(u);
    cdnOk(u);
    for (let i = 1; i < CDN_FAILS; i++) expect(cdnNetFail(u)).toBe(false);
    for (let i = 0; i < 10; i++) expect(cdnNetFail(CDN_FALLBACK + "x")).toBe(false);
    expect(cdnSwitched()).toBe(false);
  });
});
