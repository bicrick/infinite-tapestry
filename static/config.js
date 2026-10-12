// Frontend config. When hosting the frontend separately (e.g. Vercel), set
// wsUrl to your GPU box, e.g. "wss://<podid>-8000.proxy.runpod.net/ws".
// Leave empty to use the page's own origin. A ?ws=... query param overrides it.
window.TAPESTRY_CONFIG = window.TAPESTRY_CONFIG || { wsUrl: "" };
