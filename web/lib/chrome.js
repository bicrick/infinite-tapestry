// Shared site chrome: one header and one footer for every public page.
// Static pages get it at build time (scripts/inject_chrome.js replaces <!--chrome:header--> / <!--chrome:footer-->);
// server-rendered pages (/s/<id>) call header()/footer() directly, so the two can never drift.
// Styles: /chrome.css. Account swap (Sign in -> @handle): /chrome.js. Theme: /theme.js (before paint).
const header = ({ overlay = false } = {}) => `<nav class="it-nav${overlay ? " it-overlay" : ""}" aria-label="Site">
  <a class="it-brand" href="/about" aria-label="Infinite Tapestry, home"><img class="it-mark" src="/brand/mark-plain.svg" alt="" width="22" height="13" />Infinite Tapestry</a>
  <div class="it-links"><a class="it-hide-m" href="/about#how">How it works</a><a class="it-hide-m" href="/time-machine">Time Machine</a><span class="it-acct"><a id="acct-in" href="/?signin=1">Sign in</a><a id="acct-me" class="it-me" href="/" hidden></a><button id="acct-out" type="button" hidden>Sign out</button></span><a class="it-live" href="/">Live <span aria-hidden="true">→</span></a></div>
</nav>${overlay ? "" : '<div class="it-spacer" aria-hidden="true"></div>'}`;

const footer = () => `<footer class="it-foot"><div class="it-foot-in">
  <a class="it-brand" href="/about"><img class="it-mark" src="/brand/mark-plain.svg" alt="" width="22" height="13" />Infinite Tapestry</a>
  <span class="theme-toggle" data-theme-toggle><button type="button" data-t="">Auto</button><button type="button" data-t="light">Light</button><button type="button" data-t="dark">Dark</button></span>
  <span class="it-foot-links"><a href="/about#how">How it works</a><a href="/time-machine">Time Machine</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href="/">Live</a></span>
</div></footer>`;

const head = () => `<link rel="stylesheet" href="/chrome.css" />`;
const scripts = () => `<script type="module" src="/chrome.js"></script>`;

module.exports = { header, footer, head, scripts };
