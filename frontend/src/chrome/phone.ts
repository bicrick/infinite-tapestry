// Phones: slim pill -> compose sheet, overflow, sheet drag-to-dismiss, chat in a sheet.
import "../core/globals";

export function installPhone(): void {
  const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
  const phone = matchMedia("all");
  const body = document.body, cmd = $("cmd"), input = $<HTMLTextAreaElement>("cmd-input"), more = $("more-btn"), drawer = $("drawer");
  if (!cmd || !more) return;
  // Compose: focusing the pill turns the dock into a sheet with attach + queue/now + send.
  // Compose open/close: the pill morphs into the sheet via a View Transition (compositor transform + opacity, eased);
  // only the dock is captured, so the live tapestry keeps running underneath. Falls back to an instant switch.
  // Opening is synchronous (no View Transition): focus must land in the same tap so iOS raises the keyboard.
  const setCompose = (on: boolean) => {
    on = !!(on && phone.matches);
    if (body.classList.contains("composing") === on) return;
    const go = () => body.classList.toggle("composing", on);
    if (!on && document.startViewTransition && !matchMedia("(prefers-reduced-motion: reduce)").matches) { try { document.startViewTransition(go); return; } catch (_) { /* fall through */ } }
    go();
  };
  window.TapestryCompose = setCompose;
  // Expand only after the tap's synthesized click: expanding mid-tap moves the box, the click lands elsewhere and iOS drops focus.
  let tapping = false, tapTimer = 0;
  cmd.addEventListener("pointerdown", () => { tapping = true; clearTimeout(tapTimer); tapTimer = window.setTimeout(() => { tapping = false; }, 700); });
  input.addEventListener("focus", () => { setMore(false); if (!tapping) setCompose(true); });
  input.addEventListener("focus", () => { const S = window.TapestrySocial; if (S && S.warmSend) S.warmSend(); });
  // Tap on the compact pill: focus inside the click gesture (iOS raises the keyboard) and expand, every time.
  cmd.addEventListener("click", (e) => {
    tapping = false; clearTimeout(tapTimer);
    if ((e.target as Element).closest("button, label, a, input[type=file]")) return;
    if (document.activeElement !== input) input.focus({ preventScroll: true });
    setCompose(true);
  });
  // Keyboard gone (blur, Done, tap off) -> back to the compact pill. The draft stays in the box.
  cmd.addEventListener("focusout", () => setTimeout(() => { if (!cmd.contains(document.activeElement)) setCompose(false); }, 120));
  window.addEventListener("tapestry:kb", (e) => { if (!(e as CustomEvent).detail.open && body.classList.contains("composing")) { if (document.activeElement === input) input.blur(); setCompose(false); } });
  cmd.addEventListener("submit", () => { input.blur(); setCompose(false); setMore(false); setTimeout(() => { input.blur(); setCompose(false); }, 60); });   // collapse to the pill + dismiss keyboard right away
  document.addEventListener("pointerdown", (e) => {
    const t = e.target as Element;
    if (t.closest && t.closest(".cmd-terms")) return;
    if (body.classList.contains("composing") && !cmd.contains(t)) { input.blur(); setCompose(false); }
    if (body.classList.contains("more-open") && !cmd.contains(t)) setMore(false);
  }, true);
  // Overflow: secondary actions in a compact row above the pill.
  function setMore(on: boolean) { const cap = document.querySelector<HTMLElement>(".dock .now"); if (cap) cap.style.visibility = on ? "hidden" : ""; body.classList.toggle("more-open", on); more.setAttribute("aria-expanded", on ? "true" : "false"); }
  more.addEventListener("click", (e) => { e.preventDefault(); setMore(!body.classList.contains("more-open")); });
  cmd.querySelectorAll(".sec").forEach((b) => b.addEventListener("click", () => phone.matches && b.id !== "speed-btn" && setTimeout(() => setMore(false), 150)));
  // Bottom sheet: drag the handle (or the head) down to dismiss.
  const grab = $("drawer-grab"), head = drawer && drawer.querySelector<HTMLElement>(".drawer-head");
  let y0: number | null = null, dy = 0;
  const start = (e: PointerEvent) => { if (!phone.matches) return; y0 = e.clientY; dy = 0; drawer.style.transition = "none"; };
  const move = (e: PointerEvent) => { if (y0 === null) return; dy = Math.max(0, e.clientY - y0); drawer.style.transform = `translateY(${dy}px)`; };
  const end = () => {
    if (y0 === null) return; y0 = null;
    drawer.style.transition = ""; drawer.style.transform = "";
    if (dy > 90) drawer.classList.remove("open");
  };
  [grab, head].forEach((el) => el && el.addEventListener("pointerdown", (e) => { if ((e.target as Element).closest("button")) return; start(e); el.setPointerCapture && el.setPointerCapture(e.pointerId); }));
  [grab, head].forEach((el) => el && el.addEventListener("pointermove", move));
  [grab, head].forEach((el) => el && ["pointerup", "pointercancel"].forEach((t) => el.addEventListener(t, end)));
  // Placeholder fits the pill.
  const ph = () => { if (phone.matches) input.placeholder = "Where next?"; };
  phone.addEventListener("change", ph); setTimeout(ph, 0); setTimeout(ph, 3000);
}
