// Where viewers load strip and LOD images.
// The live pod writes the public Supabase `strips` bucket when R2 uploads are off
// (TAPESTRY_R2=0 or the write keys are missing). R2_PUBLIC_URL alone must not win:
// that host keeps serving the last object that was actually uploaded, and newer
// indices 404. R2 is used only for an explicit TAPESTRY_STRIP_CDN=r2, or when
// write-capable R2 is configured the same way the pod uploads. TAPESTRY_STRIP_CDN=supabase
// forces the public bucket even if those keys are present.
const R2_PUBLIC_DEFAULT = "https://pub-631bdb4d40c54807b1c2de9402e07893.r2.dev";

function val(env, key, fallback) {
  const v = env[key];
  return v == null || v === "" ? fallback : v;
}

function session(env = process.env) {
  return val(env, "TAPESTRY_STORAGE_PREFIX", "live-sdxl");
}

function r2WriteReady(env = process.env) {
  if (val(env, "TAPESTRY_R2", "1") === "0") return false;
  return ["R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_PUBLIC_URL"].every((k) => val(env, k, ""));
}

function useR2(env = process.env) {
  const mode = String(val(env, "TAPESTRY_STRIP_CDN", "")).trim().toLowerCase();
  if (mode === "r2") return true;
  if (mode === "supabase") return false;
  return r2WriteReady(env);
}

function stripBases(env = process.env) {
  const prefix = session(env);
  const sb = String(val(env, "SUPABASE_URL", "")).replace(/\/$/, "");
  const root = `${sb}/storage/v1/object/public/strips/${prefix}`;
  if (useR2(env)) {
    const cdn = String(val(env, "R2_PUBLIC_URL", R2_PUBLIC_DEFAULT)).replace(/\/$/, "");
    // The pod keeps writing the Supabase public bucket too, so it is a real fallback for an R2 miss.
    const fb = sb ? { strip_base_fb: `${root}/strips/`, lod_base_fb: `${root}/lod/` } : {};
    return { strip_base: `${cdn}/${prefix}/strips/`, lod_base: `${cdn}/${prefix}/lod/`, ...fb };
  }
  return { strip_base: `${root}/strips/`, lod_base: `${root}/lod/` };
}

// The page may move a Supabase base onto R2 only when the build opted in
// (stripCdn === "r2" and a non-empty cdnBase). A public URL baked on its own does not.
function rewriteSupabaseBases(config, pageConfig) {
  const page = pageConfig || {};
  const out = Object.assign({}, config || {});
  const cdn = page.cdnBase;
  if (page.stripCdn === "r2" && cdn) {
    const re = /^https:\/\/[^/]+supabase\.co\/storage\/v1\/object\/public\/[^/]+\//;
    const host = String(cdn).replace(/\/$/, "") + "/";
    for (const k of ["strip_base", "lod_base"]) {
      if (re.test(out[k] || "")) out[k] = String(out[k]).replace(re, host);
    }
  }
  delete out.strip_base_fb;
  delete out.lod_base_fb;
  return out;
}

module.exports = { stripBases, session, useR2, r2WriteReady, rewriteSupabaseBases, R2_PUBLIC_DEFAULT };
