-- Auto as a director: a live admin steer note (a hint, not a rule) and a log of Auto's decisions.
-- The 8 seeded stories are retired (archived, not deleted); stories are now admin-drafted and played on demand only.
alter table auto_config add column if not exists steer text not null default '' check (char_length(steer) <= 300);
create table if not exists auto_decisions (
  id bigserial primary key,
  at timestamptz not null default now(),
  move text not null default '' check (char_length(move) <= 24),
  journey text not null default '' check (char_length(journey) <= 80),
  step int, total int,
  reason text not null default '' check (char_length(reason) <= 300),
  titles jsonb not null default '[]'::jsonb
);
create index if not exists auto_decisions_at on auto_decisions(at desc);
alter table auto_decisions enable row level security;   -- service role only
update stories set archived = true where id <= 8 and created_at = (select min(created_at) from stories) and not archived;
