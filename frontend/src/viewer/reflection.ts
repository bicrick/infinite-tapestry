// Shared band reflection (WebGL2), used by the live viewer and the about page.
// Reflection: a heavily blurred, fading mirror of the band in the dark space above/below it.
// One tiny 128x16 thumbnail of the visible strips (GPU->GPU drawImage, no readback), mipmapped, drawn by one
// full-screen quad at 1/4 res (1/6 on phones) and upscaled by the compositor. Redraws only when the view moves
// or a strip lands, capped at 30 fps; idle = zero work. No CSS filters, no backdrop-filter.
// Usage: const refl = createReflection(bandCanvas, { surr: () => "5,5,6", coarse: () => false });
//        refl.frame(V = {left, cov, lod, fading}, yOff, bandH, w, h, alpha); refl.off();
// Ported verbatim from refl.js (same shader, constants and redraw keys); also exposed as window.TapestryReflection.

/** What the surround layers need from the last frame. */
export interface SurroundView { left: number; ww: number; fi: number; li: number; cov: number; lod: boolean; fading: number }
/** reach: device px the mirror/halo falloff is measured in (default bandH); glowK: halo strength multiplier (default 1).
 *  Both are only changed when zoomed out (see layout surroundReach/surroundGlow); the defaults are the original look. */
export interface Reflection { frame(v: SurroundView, yOff: number, bandH: number, w: number, h: number, a: number, reach?: number, glowK?: number, far?: number, ends?: readonly number[]): void; off(): void }
export interface ReflectionOpts { surr: () => string; coarse: () => boolean }

declare global { interface Window { TapestryReflection?: { create(canvas: HTMLCanvasElement, opts: ReflectionOpts): Reflection | null } } }

const NO_ENDS = [-1e3, 1, 1e3, 1] as const;   // mask == 1 on screen

export function createReflection(canvas: HTMLCanvasElement, opts: ReflectionOpts): Reflection | null {
  const VAR = [.55, .25, 1.25, 1.35, 1.12, .18];   // between the first subtle pass and "Medium"
  const cv = document.createElement("canvas"); cv.id = "refl"; cv.setAttribute("aria-hidden", "true");
  const gl = cv.getContext("webgl2", { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, powerPreference: "low-power" });
  if (!gl) return null;
  canvas.after(cv);
  // Source = the band exactly as it was just painted this frame (strips, LOD underlay, crossfades), so the
  // reflection can never lag or miss what the art shows. Two-step GPU downscale keeps it alias-free.
  const TW = 128, TH = 16, src = document.createElement("canvas"); src.width = TW; src.height = TH;
  const sctx = src.getContext("2d") as CanvasRenderingContext2D, mid = document.createElement("canvas"); mid.width = TW * 4; mid.height = TH * 4;
  const mctx = mid.getContext("2d") as CanvasRenderingContext2D; sctx.imageSmoothingQuality = mctx.imageSmoothingQuality = "medium";
  const sh = (t: number, s: string) => { const o = gl.createShader(t) as WebGLShader; gl.shaderSource(o, s); gl.compileShader(o); if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) console.warn("refl shader:", gl.getShaderInfoLog(o)); return o; };
  const pr = gl.createProgram() as WebGLProgram;
  gl.attachShader(pr, sh(gl.VERTEX_SHADER, `#version 300 es
in vec2 p; out vec2 uv; void main(){ uv = p * .5 + .5; uv.y = 1. - uv.y; gl_Position = vec4(p, 0, 1); }`));
  gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, `#version 300 es
precision mediump float; in vec2 uv; out vec4 o;
uniform sampler2D tex; uniform vec2 band; uniform float bandH, t, amp, alpha, aspect; uniform vec3 bg;
uniform float aBelow, aAbove, fade, gain, sat, glow, light, soft, far; uniform highp vec4 ends;
vec3 tap(vec2 q, float lod){ return textureLod(tex, q, lod).rgb; }
void main(){
  float top = band.x, bot = band.y; float d; float y;
  if (uv.y > bot) { d = (uv.y - bot) / bandH; y = 1. - d; }          // below: mirror of the band, flipped
  else if (uv.y < top) { d = (top - uv.y) / bandH; y = d; }           // above: mirror the other way
  else { o = vec4(0); return; }
  float dn = d / fade;
  if (dn > 1.15) { o = vec4(0); return; }
  float x = uv.x + sin(d * 38. + t * 2.1) * amp * (.002 + d * .01) + sin(d * 11. - t * 1.3) * amp * d * .006;
  float lod = 1.8 + dn * 4.;                                            // soft even at the edge, melting with distance
  float s = (2. + dn * 9.) / 128.; float yy = clamp(fract(y) , .05, .95);
  vec3 c = tap(vec2(x, yy), lod) * .4
       + (tap(vec2(x - s, clamp(yy + .1, .05, .95)), lod) + tap(vec2(x + s, clamp(yy - .1, .05, .95)), lod)) * .3;
  // exposure lift so dark art still glows: gain on luminance with a soft shoulder, then saturation
  float L = dot(c, vec3(.2126, .7152, .0722));
  c = c * gain / (1. + L * (gain - 1.) * .85);
  c = clamp(mix(vec3(dot(c, vec3(.2126, .7152, .0722))), c, sat), 0., 1.);
  vec3 bloom = tap(vec2(x, .5), 6.5); bloom = mix(vec3(dot(bloom, vec3(.33))), bloom, sat) * gain;
  float f = exp(-dn * 3.) * smoothstep(0., .012, d + .006);   // starts right at the band edge
  float edge = mix(1., 1. - smoothstep(.55, 1.15, dn), soft);         // zoomed out: no visible cut-off (soft = 0 at zoom 1)
  float k = f * (uv.y > bot ? aBelow : aAbove) * alpha * edge * (1. - .85 * far);   // far out: the mirror gives way to the glow
  float g = glow * exp(-dn * 1.8) * (uv.y > bot ? 1. : .6) * alpha * .35 * edge;
  float xm = smoothstep(ends.x, ends.x + ends.y, uv.x) * (1. - smoothstep(ends.z - ends.w, ends.z, uv.x));   // band ends: mirror + halo end with the art (1 when off-screen)
  k *= xm; g *= xm;
  o = vec4(c * k + bloom * g, k + g * light);                            // premultiplied; glow is additive on dark
}`));
  gl.linkProgram(pr); gl.useProgram(pr);
  if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) { console.warn(gl.getProgramInfoLog(pr)); cv.remove(); return null; }
  const vb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, vb);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const lp = gl.getAttribLocation(pr, "p"); gl.enableVertexAttribArray(lp); gl.vertexAttribPointer(lp, 2, gl.FLOAT, false, 0, 0);
  const U: Record<string, WebGLUniformLocation | null> = {}; for (const n of ["band", "bandH", "t", "amp", "alpha", "bg", "aBelow", "aAbove", "fade", "gain", "sat", "glow", "light", "soft", "far", "ends"]) U[n] = gl.getUniformLocation(pr, n);
  const tx = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tx);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  document.documentElement.classList.add("refl-gl");
  let hasTex = false, key = "", motion = 0, lastLeft: number | null = null, cleared = true;
  return {
    frame(V: SurroundView, yOff: number, bandH: number, w: number, h: number, a: number, reach = bandH, glowK = 1, far = 0, ends: readonly number[] = NO_ENDS) {
      const now = performance.now();
      if (lastLeft !== null) motion = Math.max(motion * 0.96, Math.min(1, Math.abs(V.left - lastLeft) / 40));
      lastLeft = V.left;
      const k = (V.left * 8 | 0) + ":" + Math.round(yOff) + ":" + Math.round(bandH) + ":" + Math.round(reach) + ":" + glowK.toFixed(2) + ":" + far.toFixed(2) + ":" + a.toFixed(2) + ":" + w + "x" + h + ":" + opts.surr() + ":" + V.cov.toFixed(3) + ":" + V.fading + ":" + ends.map((e) => e.toFixed(4)).join(",");
      if (k === key && motion < 0.01) return;   // idle: zero work; any change: same-frame redraw
      const div = opts.coarse() || innerWidth <= 560 ? 6 : 4, W = Math.max(1, Math.round(w / div)), H = Math.max(1, Math.round(h / div));
      if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
      // Lay the mirror canvas over exactly the box the band canvas occupies. #view is 100vh, which on iOS is the
      // large viewport (URL bar hidden); a 100%-tall overlay was ~80px shorter, so band-relative uvs drifted
      // (gap above the band, overlap at the bottom edge).
      const cw = canvas.clientWidth + "px", ch = canvas.clientHeight + "px";
      if (cv.style.height !== ch || cv.style.width !== cw) { cv.style.width = cw; cv.style.height = ch; }
      gl.viewport(0, 0, W, H);
      if (k !== key) {
        key = k;
        if (V.cov > 0 || V.lod || !hasTex) {   // nothing painted at all (cold start): hold the last texture
          mctx.drawImage(canvas, 0, Math.max(0, yOff), w, Math.min(bandH, h - yOff), 0, 0, mid.width, mid.height);
          sctx.drawImage(mid, 0, 0, TW, TH);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src); gl.generateMipmap(gl.TEXTURE_2D); hasTex = true;
        }
      }
      gl.uniform2f(U.band, yOff / h, (yOff + bandH) / h); gl.uniform1f(U.bandH, reach / h);   // falloff + mirror unit (== bandH at zoom 1)
      gl.uniform1f(U.t, now / 1000); gl.uniform1f(U.amp, motion); gl.uniform1f(U.alpha, a); const lt = opts.surr()[0] === "2";
      gl.uniform1f(U.aBelow, VAR[0]); gl.uniform1f(U.aAbove, VAR[1]); gl.uniform1f(U.fade, VAR[2]); gl.uniform1f(U.gain, lt ? 1 + (VAR[3] - 1) * .5 : VAR[3]);
      gl.uniform1f(U.sat, VAR[4]); gl.uniform1f(U.glow, VAR[5] * glowK); gl.uniform1f(U.soft, reach > bandH ? Math.min(1, (reach / Math.max(1, bandH) - 1) * 4) : 0); gl.uniform1f(U.light, lt ? 1 : 0); gl.uniform1f(U.far, far); gl.uniform4f(U.ends, ends[0], ends[1], ends[2], ends[3]);
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); gl.drawArrays(gl.TRIANGLES, 0, 3); cleared = false;
    },
    off() { if (cleared) return; cleared = true; key = ""; gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); },
  };
}

window.TapestryReflection = { create: createReflection };
