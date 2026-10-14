// Story library + playlist (admin only; callers check the admin first). Archive hides a story; delete (admin, confirmed) removes it.
const { rest } = require("./common");
const REP = { prefer: "return=representation" };

function cleanStory(b) {
  const title = String((b && b.title) || "").trim().slice(0, 80);
  const theme = String((b && b.theme) || "").trim().slice(0, 200);
  const scenes = (Array.isArray(b && b.scenes) ? b.scenes : []).slice(0, 20)
    .map((s) => ({ title: String((s && s.title) || "").trim().slice(0, 80), prompt: String((s && s.prompt) || "").trim().slice(0, 600) }))
    .filter((s) => s.prompt.length >= 3);
  if (!title) throw new Error("story needs a title");
  if (!scenes.length) throw new Error("story needs at least one scene");
  return { title, theme, scenes };
}

const OPEN = "status=in.(queued,playing)";
async function library() {
  const [stories, playlist, recent] = await Promise.all([
    rest("GET", "stories?archived=eq.false&order=id.asc&select=id,title,theme,scenes,updated_at"),
    rest("GET", `story_playlist?${OPEN}&order=position.asc,id.asc&select=id,story_id,status,scene_index,position,started_at`),
    rest("GET", "story_playlist?status=in.(done,skipped)&order=id.desc&limit=8&select=id,story_id,status,finished_at"),
  ]);
  return { stories, playlist, recent };
}
async function save(b) {
  const s = cleanStory(b);
  if (b.id) {
    const r = await rest("PATCH", `stories?id=eq.${Number(b.id)}`, { ...s, updated_at: new Date().toISOString() }, REP);
    return r[0];
  }
  return (await rest("POST", "stories", s, REP))[0];
}
async function enqueue(storyId, when) {
  const id = Number(storyId);
  if (!id) throw new Error("bad story");
  const open = await rest("GET", `story_playlist?${OPEN}&order=position.asc&select=id,position,status`);
  let position = Date.now() / 1000;
  if (when === "now") {
    position = (open.length ? open[0].position : position) - 1;
    const playing = open.filter((r) => r.status === "playing").map((r) => r.id);
    if (playing.length) await rest("PATCH", `story_playlist?id=in.(${playing.join(",")})`, { status: "skipped", finished_at: new Date().toISOString() }, { prefer: "return=minimal" });
  } else if (when === "next") {
    const cur = open.find((r) => r.status === "playing") || open[0];
    const after = cur ? open[open.indexOf(cur) + 1] : null;
    position = cur ? (after ? (cur.position + after.position) / 2 : cur.position + 1) : position;
  }
  return (await rest("POST", "story_playlist", { story_id: id, position }, REP))[0];
}
async function remove(pid) {
  await rest("PATCH", `story_playlist?id=eq.${Number(pid)}&${OPEN}`, { status: "skipped", finished_at: new Date().toISOString() }, { prefer: "return=minimal" });
}
async function move(pid, dir) {
  const open = await rest("GET", `story_playlist?${OPEN}&order=position.asc,id.asc&select=id,position`);
  const i = open.findIndex((r) => r.id === Number(pid)), j = i + (dir === "up" ? -1 : 1);
  if (i < 0 || j < 0 || j >= open.length) return;
  await rest("PATCH", `story_playlist?id=eq.${open[i].id}`, { position: open[j].position }, { prefer: "return=minimal" });
  await rest("PATCH", `story_playlist?id=eq.${open[j].id}`, { position: open[i].position }, { prefer: "return=minimal" });
}
module.exports = { cleanStory, library, save, enqueue, remove, move };
