// Public runtime config written by scripts/build_web.sh into /config.js (window.TAPESTRY_CONFIG).
export interface RuntimeConfig {
  buildId?: string; wsUrl?: string; supabaseUrl?: string; supabaseAnonKey?: string; turnstileSiteKey?: string;
  google?: boolean; centsPerHour?: number; maintenance?: boolean;
}
declare global { interface Window { TAPESTRY_CONFIG?: RuntimeConfig } }
export const runtimeConfig = (): RuntimeConfig => window.TAPESTRY_CONFIG || {};
