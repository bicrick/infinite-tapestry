#!/usr/bin/env node
// Local/manual runner for the Time Machine index (production runs it as the Vercel cron /api/tm?job=index).
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/tm/build_index.js [--rebuild]
const { runIndex } = require("../../web/lib/tmbuild");
runIndex({ rebuild: process.argv.includes("--rebuild") }).then((r) => console.log("tm index:", JSON.stringify(r))).catch((e) => { console.error(e); process.exit(1); });
