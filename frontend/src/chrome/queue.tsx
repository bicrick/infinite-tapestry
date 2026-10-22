// Queue drawer list (#queue-list), the first Preact chrome component.
// It produces exactly the DOM that the old imperative renderQueue produced: the same <li> markup, classes and
// data-* attributes. The row markup is still an HTML string because the vote heart comes from social.js as HTML.
// Rows are keyed by id + signature, so an unchanged row keeps its node (with any .open class mobile.js toggled)
// and a changed row is replaced by a fresh node, which is what the hand-written keyed diff did.
import { render } from "preact";
import type { Scene } from "../core/protocol";
import type { TapestrySocialApi } from "../core/globals";
import { credit, esc, ideaTitle } from "../core/text";

export interface QueueRow { key: string; sig: string; cls: string; html: string }

/** One row's signature, class and inner HTML (verbatim from client.js renderQueue). */
export function queueRow(s: Scene, i: number, S: TapestrySocialApi | undefined): QueueRow {
  const key = String(s.id);
  const voted = !!(S && S.myVotes && S.myVotes().has(s.idea_id));
  const sig = JSON.stringify([i, s.title, s.origin, s.by, s.kind, s.prompt, s.votes, s.eta, voted]);
  const cls = "item " + (s.origin === "auto" ? "auto" : "user") + (s.kind === "idea" ? " idea" : "");
  let html: string;
  if (s.kind === "idea") {
    const c = credit(s.by, "user", { guestNames: true }), eta = s.eta != null && S && S.etaLabel ? S.etaLabel(s.eta) : "soon";
    html = `<span class="n">${i + 1}</span><div class="body"><div class="t" data-tip="${esc("Suggested by " + c)}">${esc(ideaTitle(s.prompt || s.title, s.by, s.image))}</div>` +
      `<div class="meta">${esc(c)} · Waiting · ${esc(eta)}</div><div class="p"><a class="open-s" href="/s/${s.idea_id}" target="_blank" rel="noopener">Open ↗</a><button class="linkish" type="button" data-report="${s.idea_id}">Report</button></div></div>` +
      (S && S.heart ? S.heart(s.idea_id, s.votes) : "");
  } else {
    // View-only queue: no reorder, drag, edit or remove controls. Planned user scene (already picked, plays next).
    const cs = credit(s.by, "user", { guestNames: true });
    html = `<span class="n">${i + 1}</span><div class="body"><div class="t" data-tip="${esc("Suggested by " + cs)}">${esc(ideaTitle(s.source || s.title, s.by, s.ref))}</div>` +
      `<div class="meta">${esc(cs)} · ${i === 0 ? "Up next" : "Planned"}</div></div>`;
  }
  return { key, sig, cls, html };
}

export function QueueRows({ rows }: { rows: QueueRow[] }) {
  return <>{rows.map((r) => <li key={r.key + "\u0000" + r.sig} data-sig={r.sig} class={r.cls} data-id={r.key} dangerouslySetInnerHTML={{ __html: r.html }} />)}</>;
}

/** Render the public queue (user items only, already filtered) into #queue-list. */
export function renderQueueList(list: HTMLElement, items: Scene[], S: TapestrySocialApi | undefined): void {
  render(<QueueRows rows={items.map((s, i) => queueRow(s, i, S))} />, list);
}
