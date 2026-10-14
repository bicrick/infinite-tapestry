// Pre-director moderation: fast keyword screen (sexual content, minors + sexual, slurs), plus OpenAI's free
// omni-moderation when OPENAI_API_KEY is set. Returns '' when clean, else a reason.
// Hard lines (never weakened): sexual content / nudity, minors + sexual, hateful slurs. Gore, horror, crude humor,
// historical or satirical scenes are allowed. Benign phrases (ALLOW) are removed before the keyword match.
const SEXUAL = /\b(sex|sexy|sexual|nude|nudes|naked|nudity|erotic|erotica|porn|porno|nsfw|topless|lingerie|genitals?|penis|vagina|nipples?|orgasm|seductive|sensual|fetish|bdsm|lewd|hentai|undress\w*|stripper|striptease|intercourse|masturbat\w*|boobs?|tits|breasts|xxx|horny|kinky|onlyfans|r34|rule ?34)\b/i;
const MINOR = /\b(child|children|kids?|minors?|underage|under-age|teens?|teenage|teenager|preteen|pre-teen|toddler|bab(y|ies)|infant|schoolgirl|schoolboy|loli|lolita|shota|jailbait|young (girl|boy)|little (girl|boy)|\d{1,2}\s*(yo|y\/o|years?[- ]old))\b/i;
// Slurs only. Historical / satirical figures and symbols (hitler, nazis, kkk...) are left to OpenAI hate with a high score.
const HATE = /\b(n[i1]gg(er|a)s?|f[a@]gg?ots?|k[i1]kes?|sp[i1]cs?|ch[i1]nks?|tr[a@]nn(y|ies)|wetbacks?|r[e3]tards?)\b/i;
const ANIMALS = "animals?|elephants?|goats?|lambs?|sheep|deer|fawns?|bears?|pandas?|seals?|owls?|ducks?|ducklings?|chicks?|birds?|turtles?|dragons?|dinosaurs?|whales?|dolphins?|foxes|fox|wolves|wolf|lions?|tigers?|cats?|kittens?|dogs?|puppies|puppy|bunnies|bunny|rabbits?|penguins?|otters?|giraffes?|horses?|ponies|pony|monkeys?|koalas?|sloths?|octopus(es)?|sharks?|cows?|pigs?|piglets?|yoda|groot|carrots?|spinach|corn|shower|grand|steps?|teeth";
const ALLOW = new RegExp("\\b(" + [
  "naked mole[- ]?rats?", "naked eye", "naked flame", "naked (tree|trees|branches)",
  "(chicken|turkey|duck|pheasant) breasts?", "breast ?strokes?", "breastplates?",
  "(blue|great|coal|marsh|willow|crested|long[- ]tailed) tits?", "tit ?mouse", "tit for tat",
  "(comic|landing|film|las vegas|vegas|sunset|mobius|möbius|bacon|neon|led|light) strips?", "strip malls?", "strip mines?",
  "(baby|babies|kid|kids) (" + ANIMALS + ")",
  "(kids|kid|children|child)['’]?s? (toys?|books?|drawings?|crayons?|cartoons?|tv|show|menu|meal|room|playground|blocks?|lego)",
  "toy (box|store|shop|blocks?)", "kid goats?", "sex pistols", "middlesex", "sussex", "essex",
].join("|") + ")\\b", "gi");
const strip = (t) => t.replace(ALLOW, " ");
// light de-obfuscation: n.a.k.e.d, n4ked, s3x
const norm = (t) => t.toLowerCase().replace(/[0@]/g, "o").replace(/3/g, "e").replace(/4/g, "a").replace(/[1!|]/g, "i").replace(/\$/g, "s")
  .replace(/\b(\w)[.\-_*](?=\w\b|\w[.\-_*])/g, "$1");

const SEXUAL_SCORE = 0.7, HATE_SCORE = 0.8, SELF_HARM_INSTR_SCORE = 0.9;

function keyword(text) {
  const t = strip(String(text || "")), n = strip(norm(String(text || "")));
  const sexual = SEXUAL.test(t) || SEXUAL.test(n), minor = MINOR.test(t) || MINOR.test(n);
  if (sexual && minor) return "minor_sexual";
  if (sexual) return "sexual";       // MINOR alone never blocks here
  if (HATE.test(t) || HATE.test(n)) return "hate";
  return "";
}

// OpenAI verdict from category scores (not the booleans, which overreact on gore/horror and anatomy words).
function openaiVerdict(res) {
  const c = res.categories || {}, s = res.category_scores || {};
  if (c["sexual/minors"] || (s["sexual/minors"] || 0) >= 0.5) return "minor_sexual";
  if ((s.sexual || 0) >= SEXUAL_SCORE) return "sexual";
  if ((s.hate || 0) >= HATE_SCORE || (s["hate/threatening"] || 0) >= HATE_SCORE) return "hate";
  if ((s["self-harm/instructions"] || 0) >= SELF_HARM_INSTR_SCORE) return "unsafe";   // only clearly instructional
  return "";                         // violence/graphic, gore, horror: allowed
}

async function moderate(text) {
  const t = String(text || "");
  const k = keyword(t);
  if (k) return k;
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
    return res ? openaiVerdict(res) : "";
  } catch (_) { return ""; }   // fail open to the keyword screen + the director's own check
}
module.exports = { moderate, keyword, openaiVerdict, ALLOW_SOURCE: ALLOW.source };
