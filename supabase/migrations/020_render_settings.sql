-- Live render settings (admin sliders). The pod re-reads auto_config every ~15 s; no GPU restart needed.
-- Keys (all optional; missing = built-in default): auto_min, auto_max, user_min, user_max (scene widths in strips),
-- seam_px (bridge crossfade width, 192), bridge_strength (bridge repaint strength, 0.85).
alter table auto_config add column if not exists render jsonb not null default '{}'::jsonb;
