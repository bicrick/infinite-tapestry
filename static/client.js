/**
 * Infinite Tapestry browser client.
 * Derives ws/wss from page origin (works behind RunPod/Vast HTTPS proxies).
 */
(function () {
  "use strict";

  const canvas = document.getElementById("view");
  const ctx = canvas.getContext("2d", { alpha: false });
  const statsEl = document.getElementById("stats");

  const MAGIC = "ITAP";
  const HEADER_SIZE = 16; // 4 + 4 + 2 + 2 + 2 + 2

  let config = {
    height: 512,
    strip_width: 128,
    overlap: 32,
    scroll_speed: 30,
    scroll_speed_min: 8,
    buffer_target: 6,
    buffer_min: 2,
  };

  /** @type {{index:number, overlap:number, bitmap:ImageBitmap, width:number, height:number}[]} */
  let strips = [];
  let panoramaWidth = 0;
  let scrollX = 0;
  let lastTs = 0;
  let ws = null;
  let reconnectDelay = 1000;
  let bufferDepth = 0;
  let bufferLow = false;
  let lastIndex = -1;
  let lastAckIndex = -1;
  let connected = false;
  let clientPingTimer = null;
  let ackTimer = 0;

  function wsUrlFromPage() {
    const loc = window.location;
    const proto = loc.protocol === "https:" ? "wss:" : "ws:";
    return proto + "//" + loc.host + "/ws";
  }

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(canvas.clientWidth * dpr);
    canvas.height = Math.floor(canvas.clientHeight * dpr);
  }

  window.addEventListener("resize", resize);
  resize();

  function decodeStrip(buf) {
    const view = new DataView(buf);
    const magic =
      String.fromCharCode(view.getUint8(0)) +
      String.fromCharCode(view.getUint8(1)) +
      String.fromCharCode(view.getUint8(2)) +
      String.fromCharCode(view.getUint8(3));
    if (magic !== MAGIC) {
      console.warn("bad magic", magic);
      return null;
    }
    const index = view.getUint32(4);
    const width = view.getUint16(8);
    const height = view.getUint16(10);
    const overlap = view.getUint16(12);
    const promptLen = view.getUint16(14);
    const promptBytes = new Uint8Array(buf, HEADER_SIZE, promptLen);
    const prompt = new TextDecoder().decode(promptBytes);
    const jpeg = buf.slice(HEADER_SIZE + promptLen);
    return { index, width, height, overlap, prompt, jpeg };
  }

  async function onStripBinary(arrayBuffer) {
    const meta = decodeStrip(arrayBuffer);
    if (!meta) return;
    if (meta.index <= lastIndex && strips.some((s) => s.index === meta.index)) {
      return;
    }
    const blob = new Blob([meta.jpeg], { type: "image/jpeg" });
    const bitmap = await createImageBitmap(blob);
    const entry = {
      index: meta.index,
      overlap: meta.overlap,
      width: bitmap.width,
      height: bitmap.height,
      bitmap,
      prompt: meta.prompt,
    };

    // Insert sorted; recompute panorama layout.
    const existing = strips.findIndex((s) => s.index === entry.index);
    if (existing >= 0) {
      strips[existing].bitmap.close?.();
      strips[existing] = entry;
    } else {
      strips.push(entry);
      strips.sort((a, b) => a.index - b.index);
    }
    lastIndex = Math.max(lastIndex, entry.index);
    recomputeWidth();
  }

  /** Ack strips that have entered the viewport so the generator stays N ahead. */
  function ackVisibleProgress() {
    if (!ws || ws.readyState !== WebSocket.OPEN || !strips.length) return;
    const scale = canvas.height / Math.max(1, strips[0].height || config.height);
    const viewWorld = canvas.width / scale;
    const rightEdge = scrollX + viewWorld;
    const layout = stripLayout();
    let visibleThrough = -1;
    for (const { s, drawX } of layout) {
      // Strip has reached the viewport (its left edge is left of the right edge).
      if (drawX < rightEdge) {
        visibleThrough = s.index;
      }
    }
    if (visibleThrough > lastAckIndex) {
      lastAckIndex = visibleThrough;
      ws.send(JSON.stringify({ type: "ack", index: visibleThrough }));
    }
  }

  function recomputeWidth() {
    let x = 0;
    for (let i = 0; i < strips.length; i++) {
      const s = strips[i];
      const advance = i === 0 ? s.width : Math.max(0, s.width - s.overlap);
      x += advance;
    }
    panoramaWidth = x;
  }

  function stripLayout() {
    const layout = [];
    let x = 0;
    for (let i = 0; i < strips.length; i++) {
      const s = strips[i];
      const drawX = i === 0 ? 0 : x - s.overlap;
      layout.push({ s, drawX });
      const advance = i === 0 ? s.width : Math.max(0, s.width - s.overlap);
      x += advance;
    }
    return layout;
  }

  function effectiveSpeed() {
    if (bufferLow || bufferDepth < config.buffer_min) {
      return config.scroll_speed_min;
    }
    // Smooth ramp between min and nominal based on depth.
    const t = Math.min(
      1,
      Math.max(0, (bufferDepth - config.buffer_min) / Math.max(1, config.buffer_target - config.buffer_min))
    );
    return config.scroll_speed_min + (config.scroll_speed - config.scroll_speed_min) * t;
  }

  function pixelsAhead() {
    const viewW = canvas.clientWidth || 1;
    // Scale: panorama is authored at config.height; view may letterbox.
    const scale = canvas.height / Math.max(1, config.height);
    const viewWorld = (canvas.width / scale);
    return panoramaWidth - scrollX - viewWorld;
  }

  function frame(ts) {
    if (!lastTs) lastTs = ts;
    const dt = Math.min(0.1, (ts - lastTs) / 1000);
    lastTs = ts;

    // Also slow down if the local pixel runway is short.
    let speed = effectiveSpeed();
    const ahead = pixelsAhead();
    if (ahead < config.strip_width * 2) {
      speed = Math.min(speed, config.scroll_speed_min);
    }
    if (ahead > 0) {
      scrollX += speed * dt;
    }

    draw();
    updateHud(speed, ahead);
    ackTimer += dt;
    if (ackTimer >= 0.25) {
      ackTimer = 0;
      ackVisibleProgress();
    }
    requestAnimationFrame(frame);
  }

  function draw() {
    const w = canvas.width;
    const h = canvas.height;
    ctx.fillStyle = "#0c1014";
    ctx.fillRect(0, 0, w, h);

    if (!strips.length) {
      ctx.fillStyle = "#8a9aab";
      ctx.font = "16px sans-serif";
      ctx.fillText(connected ? "Waiting for strips…" : "Connecting…", 24, h / 2);
      return;
    }

    const scale = h / Math.max(1, strips[0].height || config.height);
    const layout = stripLayout();

    ctx.save();
    ctx.scale(scale, scale);
    const worldScroll = scrollX;
    for (const { s, drawX } of layout) {
      const dx = drawX - worldScroll;
      // Cull offscreen
      if (dx + s.width < 0 || dx > w / scale) continue;
      ctx.drawImage(s.bitmap, dx, 0);
    }
    ctx.restore();
  }

  function updateHud(speed, ahead) {
    const low = bufferLow || ahead < config.strip_width * 2;
    statsEl.classList.toggle("low", low);
    statsEl.textContent =
      (connected ? "live" : "offline") +
      "  |  strips " +
      strips.length +
      "  |  buf " +
      bufferDepth +
      "/" +
      config.buffer_target +
      "  |  " +
      speed.toFixed(0) +
      " px/s" +
      "  |  ahead " +
      Math.max(0, ahead | 0) +
      "px" +
      (low ? "  (slowing)" : "");
  }

  function handleJson(msg) {
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "config") {
      config = Object.assign(config, msg);
      delete config.type;
    } else if (msg.type === "ping") {
      if (msg.buffer) {
        bufferDepth = msg.buffer.depth ?? bufferDepth;
        bufferLow = !!msg.buffer.low;
      }
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "pong" }));
      }
    } else if (msg.type === "pong") {
      // server replied to our ping
    } else if (msg.type === "status") {
      if (msg.buffer) {
        bufferDepth = msg.buffer.depth ?? bufferDepth;
        bufferLow = !!msg.buffer.low;
      }
    }
  }

  function startClientPings() {
    stopClientPings();
    // Client-initiated pings also defeat idle proxies if server push is quiet.
    clientPingTimer = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "ping" }));
      }
    }, 25000);
  }

  function stopClientPings() {
    if (clientPingTimer) {
      clearInterval(clientPingTimer);
      clientPingTimer = null;
    }
  }

  function connect() {
    const url = wsUrlFromPage();
    statsEl.textContent = "connecting " + url;
    ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";

    ws.onopen = () => {
      connected = true;
      reconnectDelay = 1000;
      startClientPings();
      ws.send(JSON.stringify({ type: "status_request" }));
    };

    ws.onmessage = (ev) => {
      if (typeof ev.data === "string") {
        try {
          handleJson(JSON.parse(ev.data));
        } catch (e) {
          console.warn("bad json", e);
        }
      } else {
        onStripBinary(ev.data);
      }
    };

    ws.onclose = () => {
      connected = false;
      stopClientPings();
      statsEl.textContent = "disconnected — retrying…";
      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(15000, reconnectDelay * 1.5);
    };

    ws.onerror = () => {
      // onclose will fire and reconnect
      try {
        ws.close();
      } catch (_) {}
    };
  }

  connect();
  requestAnimationFrame(frame);
})();
