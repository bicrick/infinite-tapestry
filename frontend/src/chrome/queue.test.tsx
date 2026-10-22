// @vitest-environment happy-dom
// DOM-equivalence gate for the Preact queue list: after every snapshot it must produce the same markup as the
// legacy hand-written keyed diff (copied verbatim below), keep the same node for unchanged rows and use a fresh node for changed ones.
import { describe, expect, it } from "vitest";
import type { Scene } from "../core/protocol";
import type { TapestrySocialApi } from "../core/globals";
import { credit, esc, ideaTitle } from "../core/text";
import { renderQueueList } from "./queue";

function legacyRender(list: HTMLElement, items: Scene[], S: TapestrySocialApi | undefined): void {
  const old = new Map([...list.children].map((li) => [(li as HTMLElement).dataset.id, li as HTMLElement]));
  let prev: HTMLElement | null = null;
  items.forEach((s, i) => {
    const key = String(s.id);
    const voted = !!(S && S.myVotes && S.myVotes().has(s.idea_id));
    const sig = JSON.stringify([i, s.title, s.origin, s.by, s.kind, s.prompt, s.votes, s.eta, voted]);
    let li = old.get(key);
    if (li && li.dataset.sig === sig) {
      old.delete(key);
      if (li.previousElementSibling !== prev) list.insertBefore(li, prev ? prev.nextSibling : list.firstChild);
      prev = li;
      return;
    }
    if (li) { old.delete(key); }
    const fresh = document.createElement("li");
    if (li) li.replaceWith(fresh);
    li = fresh;
    li.dataset.sig = sig;
    li.className = "item " + (s.origin === "auto" ? "auto" : "user") + (s.kind === "idea" ? " idea" : "");
    li.dataset.id = key;
    if (s.kind === "idea") {
      const c = credit(s.by, "user", { guestNames: true }), eta = s.eta != null && S && S.etaLabel ? S.etaLabel(s.eta) : "soon";
      li.innerHTML = `<span class="n">${i + 1}</span><div class="body"><div class="t" data-tip="${esc("Suggested by " + c)}">${esc(ideaTitle(s.prompt || s.title, s.by, s.image))}</div>` +
        `<div class="meta">${esc(c)} · Waiting · ${esc(eta)}</div><div class="p"><a class="open-s" href="/s/${s.idea_id}" target="_blank" rel="noopener">Open ↗</a><button class="linkish" type="button" data-report="${s.idea_id}">Report</button></div></div>` +
        (S && S.heart ? S.heart(s.idea_id, s.votes) : "");
      list.insertBefore(li, prev ? prev.nextSibling : list.firstChild);
      prev = li;
      return;
    }
    const cs = credit(s.by, "user", { guestNames: true });
    li.innerHTML = `<span class="n">${i + 1}</span><div class="body"><div class="t" data-tip="${esc("Suggested by " + cs)}">${esc(ideaTitle(s.source || s.title, s.by, s.ref))}</div>` +
      `<div class="meta">${esc(cs)} · ${i === 0 ? "Up next" : "Planned"}</div></div>`;
    list.insertBefore(li, prev ? prev.nextSibling : list.firstChild);
    prev = li;
  });
  old.forEach((li) => li.remove());
}

const votes = new Set<unknown>([7]);
const S: TapestrySocialApi = {
  isAdmin: () => false, token: () => null, submitIdea: () => true,
  myVotes: () => votes, etaLabel: (e) => "~" + e + " min",
  heart: (id, v) => `<button class="heart" data-vote="${id}">♥<span>${v}</span></button>`,
};
const scene = (id: number, o: Partial<Scene> = {}): Scene => ({ id, title: "Scene " + id, origin: "user", by: "ann", kind: "scene", ...o });
const idea = (id: number, o: Partial<Scene> = {}): Scene => ({ id: "i" + id, idea_id: id, prompt: "Idea <" + id + "> & \"q\"", origin: "user", by: "bob", kind: "idea", votes: id, eta: id * 2, ...o });

const snapshots: Scene[][] = [
  [],
  [scene(1), idea(5), idea(7)],
  [scene(1), idea(5), idea(7)],                       // identical: every node kept
  [scene(1), idea(5, { votes: 9 }), idea(7)],         // one changed row
  [idea(5, { votes: 9 }), idea(7), idea(8, { eta: null })], // head consumed: everything shifts index
  [idea(7), idea(5, { votes: 9 })],                   // reorder + removal
  [idea(7), idea(5, { votes: 9 }), scene(2, { by: undefined })],
  [],
];

describe("Preact queue list", () => {
  it("matches the legacy keyed diff markup and node identity on every snapshot", () => {
    const a = document.createElement("ol"), b = document.createElement("ol");
    let prevA: Element[] = [], prevB: Element[] = [];
    for (const snap of snapshots) {
      // mobile.js toggles .open on tapped rows; it must survive exactly where it survived before
      prevA.forEach((li) => li.classList.add("open")); prevB.forEach((li) => li.classList.add("open"));
      legacyRender(a, snap, S); renderQueueList(b, snap, S);
      expect(b.innerHTML).toBe(a.innerHTML);
      const kept = (prev: Element[], now: Element[]) => now.map((n) => prev.includes(n));
      expect(kept(prevB, [...b.children])).toEqual(kept(prevA, [...a.children]));
      prevA = [...a.children]; prevB = [...b.children];
    }
  });
  it("renders without a social module", () => {
    const a = document.createElement("ol"), b = document.createElement("ol");
    const snap = [scene(1), idea(3)];
    legacyRender(a, snap, undefined); renderQueueList(b, snap, undefined);
    expect(b.innerHTML).toBe(a.innerHTML);
    expect(b.innerHTML).toContain("· Waiting · soon");
  });
});
