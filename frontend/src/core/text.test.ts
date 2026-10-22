import { describe, expect, it } from "vitest";
import { agoText, credit, esc, ideaTitle, srcLabel } from "./text";

describe("credit", () => {
  it("never credits the owner or system handles", () => {
    expect(credit("bicrick", "user")).toBe("Someone");
    expect(credit("@auto", "user")).toBe("Someone");
    expect(credit("", "auto")).toBe("Auto");
    expect(credit("", "user")).toBe("a guest");
    expect(credit("", null)).toBe("Auto");
  });
  it("formats handles and guests", () => {
    expect(credit("alice", "user")).toBe("@alice");
    expect(credit("alice, @bob, alice", "user")).toBe("@alice, @bob");
    expect(credit("otter-1234", "user")).toBe("a guest");
    expect(credit("otter-1234", "user", { guestNames: true })).toBe("otter-1234");
  });
  it("labels sources", () => {
    expect(srcLabel("", "auto")).toBe("✦ Auto");
    expect(srcLabel("alice", "user")).toBe("by @alice");
    expect(srcLabel("", "user")).toBe("Audience");
  });
});

describe("ideaTitle / esc / agoText", () => {
  it("image-only ideas read 'an image from X'", () => {
    expect(ideaTitle("", "otter-1234")).toBe("an image from otter-1234");
    expect(ideaTitle("Inspired by this image", "alice")).toBe("an image from @alice");
    expect(ideaTitle("x".repeat(130), "a")).toHaveLength(120);
  });
  it("escapes html", () => { expect(esc('<a href="x">&</a>')).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;"); expect(esc(null)).toBe(""); });
  it("says how far back the view is", () => {
    const now = 1_000_000;
    expect(agoText(null, now)).toBe("");
    expect(agoText(now - 30, now)).toBe("");
    expect(agoText(now - 10 * 60, now)).toBe("10 min ago");
    expect(agoText(now - 90 * 60, now)).toBe("1.5 h ago");
    expect(agoText(now - 2 * 3600, now)).toBe("2 h ago");
    expect(agoText(now - 12 * 3600, now)).toBe("12 h ago");
    expect(agoText(now - 48 * 3600, now, () => "DATE")).toBe("DATE");
  });
});
