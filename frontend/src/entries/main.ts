// Live viewer (index.html). Order matches the old script tags' execution order:
// sync classics (odometer, refl, replay + client = viewer/boot, intro, offline), then deferred mobile, then the
// social/fun modules.
import "../legacy/odometer.js";
import "../legacy/refl.js";
import "../viewer/boot";
import "../legacy/intro.js";
import "../legacy/offline.js";
import "../legacy/mobile.js";
import "../legacy/social.js";
import "../legacy/fun.js";
