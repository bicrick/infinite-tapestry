// Pre-director moderation: fast keyword screen (sexual content, minors), plus OpenAI's free
// omni-moderation when OPENAI_API_KEY is set. Returns '' when clean, else a reason.
const SEXUAL = /\b(sex|sexy|sexual|nude|nudes|naked|nudity|erotic|erotica|porn|porno|nsfw|topless|lingerie|genitals?|penis|vagina|nipples?|orgasm|seductive|sensual|fetish|bdsm|lewd|hentai|undress\w*|stripper|striptease|intercourse|masturbat\w*|boobs?|tits|breasts|xxx|horny|kinky|onlyfans|r34|rule ?34)\b/i;
const MINOR = /\b(child|children|kids?|minors?|underage|under-age|teens?|teenage|teenager|preteen|pre-teen|toddler|bab(y|ies)|infant|schoolgirl|schoolboy|loli|lolita|shota|jailbait|young (girl|boy)|little (girl|boy)|\d{1,2}\s*(yo|y\/o|years?[- ]old))\b/i;
const HATE = /\b(n[i1]gg(er|a)s?|f[a@]gg?ots?|k[i1]kes?|sp[i1]cs?|ch[i1]nks?|tr[a@]nn(y|ies)|wetbacks?|r[e3]tards?|heil|hitler|nazis?|kkk)\b/i;
// light de-obfuscation: n.a.k.e.d, n4ked, s3x
const norm = (t) => t.toLowerCase().replace(/[0@]/g, "o").replace(/3/g, "e").replace(/4/g, "a").replace(/[1!|]/g, "i").replace(/\$/g, "s")
  .replace(/\b(\w)[.\-_*](?=\w\b|\w[.\-_*])/g, "$1");

async function moderate(text) {
  const t = String(text || ""), n = norm(t);
  const sexual = SEXUAL.test(t) || SEXUAL.test(n), minor = MINOR.test(t) || MINOR.test(n);
  if (sexual && minor) return "minor_sexual";
  if (sexual) return "sexual";
  if (HATE.test(t) || HATE.test(n)) return "hate";
  const key = process.env.OPENAI_API_KEY;
  if (!key) return "";
  try {
    const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 3500);
    const r = await fetch("https://api.openai.com/v1/moderations", { method: "POST", signal: ctl.signal,
      headers: { authorization: "Bearer " + key, "content-type": "application/json" },
      body: JSON.stringify({ model: "omni-moderation-latest", input: t }) });
    clearTimeout(to);
    if (!r.ok) return "";
    const res = (await r.json()).results?.[0];
    if (!res) return "";
    const c = res.categories || {};
    if (c["sexual/minors"]) return "minor_sexual";
    if (c.sexual) return "sexual";
    if (c.hate || c["harassment/threatening"]) return "hate";
    if (c["violence/graphic"] || c["self-harm/instructions"] || c["hate/threatening"] || c["harassment/threatening"]) return "unsafe";
    return "";
  } catch (_) { return ""; }   // fail open to the keyword screen + the director's own check
}
module.exports = { moderate };
