// /?at=A&to=B share links get their own link preview: hand them to /api/page (same HTML, swapped meta).
// The static index.html would otherwise win over vercel.json rewrites.
export const config = { matcher: "/" };
export default function middleware(req) {
  const u = new URL(req.url);
  if (!/^\d+$/.test(u.searchParams.get("at") || "")) return;
  u.pathname = "/api/page"; u.searchParams.set("kind", "at");
  return new Response(null, { headers: { "x-middleware-rewrite": u.toString() } });
}
