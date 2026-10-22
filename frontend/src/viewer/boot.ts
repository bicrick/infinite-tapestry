// Side-effect entry for the live viewer, imported by entries/main.ts in the slot the old replay.js + client.js
// script tags held (after odometer/refl, before intro/offline/mobile/social/fun), so every global and listener is in
// place in the same order as before.
import "../core/globals";
import { replayStart } from "../core/replay-start";
import { installOps } from "../core/ops";
import { installFormSubmit } from "../chrome/forms";
import { installPhone } from "../chrome/phone";
import { startViewer } from "./app";

window.TapestryReplayStart = replayStart;   // a global on purpose: tests pin it (see scripts/dev/parity.mjs)
installFormSubmit();
installOps();
startViewer();
installPhone();
