// Reflection + glow on the ONE context (replaces refl.js's second canvas and its 2D drawImage readback).
//   1. replay this frame's band draws (tiles pass display list) into a 512x64 FBO, 4x downscale into a 128x16
//      mipmapped thumbnail (refl.js's exact thumbnail size);
//   2. run refl.js's shader, maths unchanged (mirror below/above, ripple, lod melt, exposure lift, glow bloom), into a
//      1/4-res FBO (1/6 on phones), <= 30 Hz and only when the band or the motion changed;
//   3. composite that FBO over the frame every frame (one quad, premultiplied, outside the band only).
// The glow is the shader's bloom term (as in refl.js). Fades with zoom like the classic surround (gone when the band is thin).
(() => {
  "use strict";
  const T = window.Tapestry;
  const VAR = [.55, .25, 1.25, 1.35, 1.12, .18]; // refl.js: aBelow, aAbove, fade, gain, sat, glow
  let ready = false, gl2 = false, P = {}, quad, mid, thumb, refl, last = 0, key = "", motion = 0, lastC = null;
  const FS100 = `precision mediump float; varying vec2 uv; uniform sampler2D tex; uniform vec2 band; uniform float bandH, t, amp, alpha;
uniform float aBelow, aAbove, fade, gain, sat, glow, light;
vec3 tap(vec2 q, float lod){ return LOOKUP; }
void main(){
  float top = band.x, bot = band.y; float d; float y;
  if (uv.y > bot) { d = (uv.y - bot) / bandH; y = 1. - d; } else if (uv.y < top) { d = (top - uv.y) / bandH; y = d; } else { gl_FragColor = vec4(0); return; }
  float dn = d / fade; if (dn > 1.15) { gl_FragColor = vec4(0); return; }
  float x = uv.x + sin(d * 38. + t * 2.1) * amp * (.002 + d * .01) + sin(d * 11. - t * 1.3) * amp * d * .006;
  float lod = 1.8 + dn * 4.; float s = (2. + dn * 9.) / 128.; float yy = clamp(fract(y), .05, .95);
  vec3 c = tap(vec2(x, yy), lod) * .4 + (tap(vec2(x - s, clamp(yy + .1, .05, .95)), lod) + tap(vec2(x + s, clamp(yy - .1, .05, .95)), lod)) * .3;
  float L = dot(c, vec3(.2126, .7152, .0722)); c = c * gain / (1. + L * (gain - 1.) * .85);
  c = clamp(mix(vec3(dot(c, vec3(.2126, .7152, .0722))), c, sat), 0., 1.);
  vec3 bloom = tap(vec2(x, .5), 6.5); bloom = mix(vec3(dot(bloom, vec3(.33))), bloom, sat) * gain;
  float f = exp(-dn * 3.) * smoothstep(0., .012, d + .006); float k = f * (uv.y > bot ? aBelow : aAbove) * alpha;
  float g = glow * exp(-dn * 1.8) * (uv.y > bot ? 1. : .6) * alpha * .35;
  gl_FragColor = vec4(c * k + bloom * g, k + g * light);
}`;
  function prog(gl, vs, fs) {
    const sh = (t, s) => { const o = gl.createShader(t); gl.shaderSource(o, s); gl.compileShader(o); if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) console.warn(gl.getShaderInfoLog(o)); return o; };
    const p = gl.createProgram(); gl.attachShader(p, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p); return p;
  }
  function target(gl, w, h, mip) {
    const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mip ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fb); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); return { t, fb, w, h };
  }
  function setup(gl) {
    gl2 = typeof WebGL2RenderingContext !== "undefined" && gl instanceof WebGL2RenderingContext;
    const VS = "attribute vec2 p; varying vec2 uv; void main(){ uv = p * .5 + .5; uv.y = 1. - uv.y; gl_Position = vec4(p, 0, 1); }";
    const fs = gl2
      ? "#version 300 es\n" + FS100.replace("varying vec2 uv;", "in vec2 uv; out vec4 o_;").replace(/gl_FragColor/g, "o_").replace("LOOKUP", "textureLod(tex, vec2(q.x, 1. - q.y), lod).rgb")
      : FS100.replace("LOOKUP", "texture2D(tex, vec2(q.x, 1. - q.y), lod).rgb"); // FBO rows are bottom-up: flip v. WebGL1: lod as bias (thumb is magnified, close enough)
    const vs = gl2 ? "#version 300 es\nin vec2 p; out vec2 uv; void main(){ uv = p * .5 + .5; uv.y = 1. - uv.y; gl_Position = vec4(p, 0, 1); }" : VS;
    P.refl = prog(gl, vs, fs); P.rl = { p: gl.getAttribLocation(P.refl, "p") };
    for (const n of ["band", "bandH", "t", "amp", "alpha", "aBelow", "aAbove", "fade", "gain", "sat", "glow", "light", "tex"]) P.rl[n] = gl.getUniformLocation(P.refl, n);
    // copy program: textured full-target quad (downscale and composite), premultiplied output
    P.copy = prog(gl, "attribute vec2 p; varying vec2 uv; void main(){ uv = p * .5 + .5; gl_Position = vec4(p, 0, 1); }",
      "precision mediump float; varying vec2 uv; uniform sampler2D t; void main(){ gl_FragColor = texture2D(t, uv); }");
    P.cl = { p: gl.getAttribLocation(P.copy, "p") };
    quad = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, quad); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    mid = target(gl, 512, 64, false); thumb = target(gl, 128, 16, true);
    ready = true;
  }
  const bindQuad = (gl, loc) => { gl.bindBuffer(gl.ARRAY_BUFFER, quad); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0); };
  const pass = {
    name: "reflection", order: 12, light: false,
    draw(gl, f) {
      const b = f.band; if (!b || !b.h) return;
      // strength: full at the live band, fading out as the band thins when zooming out (the classic surround rule)
      const alpha = Math.max(0, Math.min(1, (b.h - 40) / 120)); if (alpha <= 0) return;
      if (!ready) setup(gl);
      const fbW = f.fbW, fbH = f.fbH, div = matchMedia("(pointer: coarse)").matches || innerWidth <= 560 ? 6 : 4;
      const rw = Math.max(1, Math.round(fbW / div)), rh = Math.max(1, Math.round(fbH / div));
      if (!refl || refl.w !== rw || refl.h !== rh) { if (refl) { gl.deleteTexture(refl.t); gl.deleteFramebuffer(refl.fb); } refl = target(gl, rw, rh, false); key = ""; }
      const c = f.cam.centerTime; if (lastC !== null) motion = Math.max(motion * 0.96, Math.min(1, Math.abs(c - lastC) * f.cam.s / 40)); lastC = c;
      const k = Math.round(c * f.cam.s * 8) + ":" + Math.round(b.y) + ":" + Math.round(b.h) + ":" + alpha.toFixed(2) + ":" + rw + "x" + rh + ":" + pass.light + ":" + f.quads;
      const now = f.t;
      if ((k !== key || motion > 0.01) && now - last >= (Math.abs(f.cam.target.zoom - f.cam.zoom) > 0.02 ? 66 : 32)) { // 15 Hz while zooming, 30 Hz otherwise
        key = k; last = now;
        // 1. band -> 512x64 -> 128x16 (mipmapped)
        gl.disable(gl.BLEND);
        gl.bindFramebuffer(gl.FRAMEBUFFER, mid.fb); gl.viewport(0, 0, 512, 64); gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
        T.passes.tiles.replay(gl, f.W, b.y, b.h);
        gl.bindFramebuffer(gl.FRAMEBUFFER, thumb.fb); gl.viewport(0, 0, 128, 16);
        gl.useProgram(P.copy); bindQuad(gl, P.cl.p); gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, mid.t); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        gl.bindTexture(gl.TEXTURE_2D, thumb.t); gl.generateMipmap(gl.TEXTURE_2D);
        // 2. reflection at 1/4 res
        gl.bindFramebuffer(gl.FRAMEBUFFER, refl.fb); gl.viewport(0, 0, rw, rh); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
        gl.useProgram(P.refl); bindQuad(gl, P.rl.p); const U = P.rl, H = f.H;
        gl.uniform1i(U.tex, 0); gl.uniform2f(U.band, b.y / H, (b.y + b.h) / H); gl.uniform1f(U.bandH, b.h / H); gl.uniform1f(U.t, now / 1000); gl.uniform1f(U.amp, motion); gl.uniform1f(U.alpha, alpha);
        gl.uniform1f(U.aBelow, VAR[0]); gl.uniform1f(U.aAbove, VAR[1]); gl.uniform1f(U.fade, VAR[2]); gl.uniform1f(U.gain, pass.light ? 1 + (VAR[3] - 1) * .5 : VAR[3]);
        gl.uniform1f(U.sat, VAR[4]); gl.uniform1f(U.glow, VAR[5]); gl.uniform1f(U.light, pass.light ? 1 : 0);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); // the quad buffer is a 4-vertex strip covering clip space
        gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, fbW, fbH); gl.enable(gl.BLEND);
      }
      if (motion > 0.01) f.needAt = Math.min(f.needAt || 1e9, 33);
      // 3. composite (premultiplied), y flipped back (FBO rows are bottom-up like the default framebuffer)
      gl.useProgram(P.copy); bindQuad(gl, P.cl.p); gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, refl.t);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); gl.enable(gl.SCISSOR_TEST);
      // only the rows the mirror can reach (fade 1.25 x 1.15 band heights), never the band itself
      const d = f.dpr, ext = b.h * VAR[2] * 1.15, top = Math.max(0, b.y - ext), bot = Math.min(f.H, b.y + b.h + ext);
      for (const [y0, y1] of [[top, b.y], [b.y + b.h, bot]]) { if (y1 <= y0) continue; gl.scissor(0, Math.round((f.H - y1) * d), fbW, Math.round((y1 - y0) * d)); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); }
      gl.disable(gl.SCISSOR_TEST); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      f.quads++;
    },
  };
  T.passes = T.passes || {}; T.passes.reflection = pass;
})();
