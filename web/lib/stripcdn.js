// Where viewers load strip and LOD images: the public R2 bucket, always. R2 is the only binary store
// (the pod uploads every strip, tile and canvas there; Supabase Storage holds no strips any more).
const R2_PUBLIC_DEFAULT = "https://img.infinitetapestry.app";
const SESSION = "live-sdxl";   // the SDXL pod's storage prefix (strips rows, R2 keys)

function session() {
  return SESSION;
}

function stripBases(env = process.env) {
  const cdn = String(env.R2_PUBLIC_URL || R2_PUBLIC_DEFAULT).replace(/\/$/, "");
  return { strip_base: `${cdn}/${SESSION}/strips/`, lod_base: `${cdn}/${SESSION}/lod/` };
}

module.exports = { stripBases, session, SESSION, R2_PUBLIC_DEFAULT };
