// Composer and chat are plain <div>s, not <form>s (iOS shows its password/card/address bar for anything form-like).
// Give them form-style submit: requestSubmit(submitter) fires a cancelable "submit" event; [data-submit] buttons call it.
export type SubmitEvent2 = Event & { submitter: HTMLElement | null };

export function installFormSubmit(): void {
  for (const id of ["cmd", "chat-form"]) {
    const el = document.getElementById(id) as (HTMLElement & { requestSubmit?: (s?: HTMLElement | null) => void }) | null;
    if (!el || el.tagName === "FORM") continue;
    el.requestSubmit = (submitter) => { const ev = new Event("submit", { cancelable: true }) as SubmitEvent2; ev.submitter = submitter || null; el.dispatchEvent(ev); };
    el.addEventListener("pointerdown", (e) => { const t = e.target as Element; if (t.closest && t.closest("[data-submit]")) e.preventDefault(); });   // keep focus (and the keyboard) on send
    el.addEventListener("click", (e) => { const t = e.target as Element; const b = t.closest && t.closest<HTMLElement>("[data-submit]"); if (b && el.contains(b)) { e.preventDefault(); el.requestSubmit!(b); } });
  }
  const chatIn = document.getElementById("chat-input");
  if (chatIn) chatIn.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); (document.getElementById("chat-form") as HTMLFormElement).requestSubmit(); } });
}
