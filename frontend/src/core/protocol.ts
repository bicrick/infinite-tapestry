// Wire types shared with the pod (WebSocket v2, infinite_tapestry/server.py) and Vercel (/api/live).
// The protocol itself is unchanged by the frontend migration; these types describe it.

/** Stream/painting config: server `config` message and /api/live `config`. */
export interface StreamConfig {
  height: number; strip_width: number; overlap: number; scroll_speed: number;
  scroll_speed_min: number; buffer_target: number; buffer_min: number;
  strip_base?: string; strip_ext?: string; strip_mime?: string; lod_base?: string;
  interpreter?: boolean;
  [k: string]: unknown;
}
export const DEFAULT_STREAM_CONFIG: StreamConfig = {
  height: 512, strip_width: 128, overlap: 32, scroll_speed: 30,
  scroll_speed_min: 8, buffer_target: 6, buffer_min: 2,
};

/** Scene label tuple: [title, by, style, origin]. */
export type SceneTuple = [string, string, string, string];
/** Strip reference (v2): index, overlap, prompt, scene. */
export interface StripRef { i: number; o?: number; p?: string; s?: SceneTuple }

export interface GpuInfo { px_per_sec?: number; strips_per_sec?: number; strip_seconds?: number }
export interface Scene { id?: string | number; title?: string; prompt?: string; source?: string; origin?: string; by?: string; kind?: string;
  idea_id?: number; votes?: number; eta?: number | null; image?: unknown; ref?: unknown; [k: string]: unknown }
export interface Director {
  current?: string; current_scene?: Scene; target_scene?: Scene | null; upcoming?: Scene[]; items?: Scene[]; upcoming_seq?: number;
  transition_progress?: number; held?: number; hold_for?: number; hold?: number; blend?: number;
  autopilot?: { enabled?: boolean; vibe?: string; busy?: boolean; error?: unknown };
}
export interface ClockMsg { type: "clock"; now: number; ts: number; pos: number; speed: number; viewers?: number; mode: string; manual: number; multiplier: number }

/** Every JSON message the pod sends (fields are optional: messages piggyback buffer/gpu/director). */
export interface ServerMsg {
  type?: string;
  buffer?: { depth?: number; low?: boolean };
  gpu?: GpuInfo;
  director?: Director;
  // strip / strip_scene / strips
  i?: number; o?: number; p?: string; s?: SceneTuple; items?: StripRef[];
  // clock
  now?: number; ts?: number; pos?: number; speed?: number; viewers?: number; mode?: string; manual?: number; multiplier?: number;
  // notice / activity / plan
  text?: string; titles?: string[]; req?: number; plan?: { source?: string; note?: string }; scenes?: Array<{ title?: string }>;
  interpreter?: boolean;
  [k: string]: unknown;
}

/** Client -> pod messages. */
export type ClientMsg =
  | { type: "pong" } | { type: "ping" } | { type: "upcoming_request" } | { type: "status_request" } | { type: "skip" } | { type: "clear" }
  | { type: "auth"; token: string }
  | { type: "history"; start: number; end: number; bytes?: boolean }
  | { type: "intent"; text: string; when: string; req: number }
  | { type: "speed"; mode: string; manual?: number }
  | { type: "autopilot"; enabled?: boolean; vibe?: string }
  | { type: "configure"; hold?: number; blend?: number };

/** /api/live (Vercel + Supabase): config, newest refs, pod state. */
export interface LiveApi {
  config?: Partial<StreamConfig>; items?: StripRef[]; max?: number;
  last_at?: number; heartbeat_at?: number | null; now: number;
  pod?: { status?: string; desired?: string; ws?: string };
}

// Binary strip frame (bytes=1): magic "ITAP"(4) + index u32 + width u16 + height u16 + overlap u16 + prompt_len u16 + prompt + image.
export const ITAP_MAGIC = "ITAP";
export const ITAP_HEADER = 16;
export interface ItapFrame { index: number; overlap: number; prompt: string; jpeg: ArrayBuffer }
export function decodeItap(buf: ArrayBuffer): ItapFrame | null {
  const view = new DataView(buf);
  let magic = "";
  for (let i = 0; i < 4; i++) magic += String.fromCharCode(view.getUint8(i));
  if (magic !== ITAP_MAGIC) return null;
  const index = view.getUint32(4);
  const overlap = view.getUint16(12);
  const promptLen = view.getUint16(14);
  const prompt = new TextDecoder().decode(new Uint8Array(buf, ITAP_HEADER, promptLen));
  const jpeg = buf.slice(ITAP_HEADER + promptLen);
  return { index, overlap, prompt, jpeg };
}

/** Pod liveness from /api/live: the pod's own 30 s heartbeat (last_at is only a fallback for old APIs). */
export const stale = (j: LiveApi): boolean => j.heartbeat_at != null ? j.now - j.heartbeat_at > 90 : !!(j.last_at && j.now - j.last_at > 60);
