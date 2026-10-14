// "Talk to Auto": the owner's planning chat. Auto sees the live state, drafts stories and proposes changes.
// Proposed changes are tool calls that the panel shows as action cards; nothing applies until the owner confirms.
const { env, rest } = require("./common");
const REP = { prefer: "return=representation" };
const lib = require("./stories");
const MODEL = () => env("AUTO_CHAT_MODEL", "claude-sonnet-5-5");
const SUMMARY_MODEL = () => env("AUTO_SUMMARY_MODEL", "claude-haiku-5-5");
const KEY = () => env("TAPESTRY_ANTHROPIC_API_KEY") || env("ANTHROPIC_API_KEY");

const SCENE = { type: "object", properties: { title: { type: "string", description: "2-4 word scene name" }, prompt: { type: "string", description: "image prompt, under 60 words" } }, required: ["title", "prompt"] };
const TOOLS = [
  { name: "propose_story", description: "Show a storyboard card the owner can edit, play now, add to the playlist or save to the library.",
    input_schema: { type: "object", properties: { title: { type: "string" }, theme: { type: "string", description: "one-sentence premise: who or what, where, what happens" }, style: { type: "string", description: "the ONE look for every scene, 2-5 words (e.g. linocut print, 1970s sci-fi paperback cover)" }, scenes: { type: "array", items: SCENE, minItems: 3, maxItems: 12 } }, required: ["title", "scenes"] } },
  { name: "set_theme", description: "Propose a temporary theme Auto leans toward (when no story is playing).",
    input_schema: { type: "object", properties: { theme: { type: "string" }, minutes: { type: "integer", minimum: 5, maximum: 1440 } }, required: ["theme"] } },
  { name: "set_paused", description: "Propose pausing or resuming Auto.", input_schema: { type: "object", properties: { paused: { type: "boolean" } }, required: ["paused"] } },
  { name: "queue_story", description: "Propose queueing a saved library story by id.",
    input_schema: { type: "object", properties: { story_id: { type: "integer" }, when: { type: "string", enum: ["now", "next", "end"] } }, required: ["story_id"] } },
];

const SYSTEM = `You are Auto, the curator of Infinite Tapestry: an endless, horizontally scrolling image painted live, strip by strip, by an image model. Viewers suggest ideas; between ideas you choose what to paint. You are talking with the owner in the admin panel. Be concise, warm and practical.
You help plan STORIES: a premise (theme), ONE look (style) and an ordered list of about 7 scenes that read like chapters: an arrival, exploring, a discovery, a twist, an ending. Each scene follows from the one before so a viewer can follow the story, and mixes shots (a vista, an interior, a close-up, a creature or character, a single object). Write each scene prompt with the whole story in mind: name the story's recurring subject and world in every scene so it stands on its own, in plain words, under 40 words. The look lives in "style" and is applied to every scene, so scenes describe content, not the medium. The renderer is weakest at photoreal people and crowds (keep people small or stylized), and can't do text. No nudity or sexual content.
To show a storyboard, call propose_story (the owner sees an editable card). To change anything live, call set_theme, set_paused or queue_story; each is shown to the owner as a card to confirm, so never claim it already happened. Use the LIVE STATE below to answer questions about what's playing.`;

async function liveState() {
  const [strips, ideas, cfg, l, pod] = await Promise.all([
    rest("GET", "strips?order=idx.desc&limit=12&select=idx,scene,created_at").catch(() => []),
    rest("GET", "ideas?status=in.(pending,playing)&order=created_at.asc&limit=15&select=body,status,votes").catch(() => []),
    rest("GET", "auto_config?id=eq.1&select=paused,theme,theme_until").catch(() => []),
    lib.library().catch(() => ({ stories: [], playlist: [] })),
    rest("GET", "pod_state?id=eq.1&select=status,desired").catch(() => []),
  ]);
  const name = (id) => (l.stories.find((s) => s.id === id) || {}).title || `#${id}`;
  const recentScenes = [...new Set(strips.map((s) => s.scene).filter(Boolean))];
  const p = pod[0] || {};
  return {
    gpu: { status: p.status, desired: p.desired, note: p.status === "running" ? "painting live" : "the GPU is off, so nothing is painting right now; recent_scenes are the last ones painted" },
    last_painted_at: strips[0] && strips[0].created_at, recent_scenes_newest_first: recentScenes,
    viewer_queue: ideas.map((i) => ({ idea: i.body, status: i.status, votes: i.votes })),
    auto: cfg[0] || {},
    playlist: l.playlist.map((p) => ({ story: name(p.story_id), status: p.status, at_scene: p.scene_index })),
    library: l.stories.map((s) => ({ id: s.id, title: s.title, scenes: s.scenes.length })),
  };
}

async function claude(body) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST", headers: { "x-api-key": KEY(), "anthropic-version": "2023-06-01", "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error("auto_unavailable");
  return j;
}

// History for the model: last N messages, starting at a plain user turn, with any unanswered tool calls closed.
function history(msgs) {
  let h = msgs.slice(-24);
  while (h.length && !(h[0].role === "user" && !(Array.isArray(h[0].content) && h[0].content.some((c) => c.type === "tool_result")))) h = h.slice(1);
  return h.map((m) => ({ role: m.role, content: m.content }));
}
function pendingResults(msgs) {
  const last = msgs[msgs.length - 1];
  if (!last || last.role !== "assistant" || !Array.isArray(last.content)) return [];
  return last.content.filter((c) => c.type === "tool_use").map((c) => ({ type: "tool_result", tool_use_id: c.id, content: "Shown to the owner as a card to confirm or edit." }));
}

async function chats() {
  return rest("GET", "auto_chats?order=updated_at.desc&limit=30&select=id,title,updated_at");
}
async function messages(id) {
  return rest("GET", `auto_chat_messages?chat_id=eq.${Number(id)}&order=id.asc&select=id,role,content,created_at`);
}
async function newChat() { return (await rest("POST", "auto_chats", {}, REP))[0]; }

async function send(chatId, text) {
  text = String(text || "").trim().slice(0, 4000);
  if (!text) throw new Error("empty");
  if (!KEY()) throw new Error("auto_unavailable");
  let chat = chatId ? (await rest("GET", `auto_chats?id=eq.${Number(chatId)}`))[0] : null;
  if (!chat) chat = await newChat();
  const prior = await messages(chat.id);
  const userContent = [...pendingResults(prior), { type: "text", text }];
  await rest("POST", "auto_chat_messages", { chat_id: chat.id, role: "user", content: userContent }, { prefer: "return=minimal" });
  const [state, others] = await Promise.all([liveState(), rest("GET", `auto_chats?id=neq.${chat.id}&summary=neq.&order=updated_at.desc&limit=3&select=title,summary`)]);
  const memory = [chat.summary && `Earlier in this chat: ${chat.summary}`, ...others.map((o) => `Past chat "${o.title}": ${o.summary}`)].filter(Boolean).join("\n");
  const sys = SYSTEM + (memory ? "\n\nMEMORY:\n" + memory : "") + "\n\nLIVE STATE (JSON):\n" + JSON.stringify(state);
  const out = await claude({ model: MODEL(), max_tokens: 2500, system: sys, tools: TOOLS,
    messages: [...history(prior), { role: "user", content: userContent }] });
  const content = (out.content || []).filter((c) => c.type === "text" || c.type === "tool_use");
  const saved = (await rest("POST", "auto_chat_messages", { chat_id: chat.id, role: "assistant", content }, REP))[0];
  const patch = { updated_at: new Date().toISOString() };
  if (chat.title === "New chat") patch.title = text.slice(0, 60);
  await rest("PATCH", `auto_chats?id=eq.${chat.id}`, patch, { prefer: "return=minimal" });
  await summarize(chat, [...prior, { role: "user", content: userContent }, saved]).catch(() => {});
  return { chat_id: chat.id, message: saved };
}

// Running summary: fold everything but the last 16 messages into chat.summary.
async function summarize(chat, msgs) {
  const old = msgs.filter((m) => m.id && m.id > (chat.summarized_upto || 0)).slice(0, -16);
  if (old.length < 8) return;
  const flat = old.map((m) => `${m.role}: ${(Array.isArray(m.content) ? m.content : []).map((c) => c.text || (c.type === "tool_use" ? `[proposed ${c.name} ${JSON.stringify(c.input).slice(0, 300)}]` : "")).join(" ")}`).join("\n").slice(0, 12000);
  const r = await claude({ model: SUMMARY_MODEL(), max_tokens: 400, messages: [{ role: "user", content:
    `Update this running summary of a planning chat about an art stream (owner preferences, decisions, stories made). Max 120 words.\nCurrent summary: ${chat.summary || "(none)"}\nNew messages:\n${flat}` }] });
  const summary = ((r.content || [])[0] || {}).text || "";
  if (summary) await rest("PATCH", `auto_chats?id=eq.${chat.id}`, { summary: summary.slice(0, 2000), summarized_upto: old[old.length - 1].id }, { prefer: "return=minimal" });
}

module.exports = { send, chats, messages, newChat, liveState, TOOLS, history, pendingResults };
