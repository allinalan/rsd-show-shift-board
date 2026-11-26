-- ---------- Look it up: Plan mode's "find this show online" (2026-11-25) ----------
-- Add event in Plan mode has a Look it up line. A press inserts a pending row: the words typed and the year. The mini's
-- listener (scripts/sync-requests.mjs, launchd com.allinalan.rsd-board-sync, every 30 s) takes the oldest, runs
-- rsd-shift-picking's lookup-show.js (Claude with web search, $10 a week) and writes what it found onto the row; the
-- page fills the Add event form from it and a coordinator presses Add event. Nothing here writes a show.
-- Editors read and ask (at most 3 open each); only the service key (the mini) moves a row past pending. The result can
-- carry a promoter's contact as found on their own page (editors only; event_contacts already shows those to anyone).
-- Also in supabase/schema.sql. Safe to run again.
create table if not exists show_lookups (
  id            bigserial primary key,
  requested_at  timestamptz not null default now(),
  requested_by  text not null default lower(coalesce(auth.jwt()->>'email','')),
  ask           text not null check (char_length(ask) between 3 and 300),
  year          int  not null check (year between 2020 and 2100),
  status        text not null default 'pending' check (status in ('pending','running','done','failed','refused')),
  started_at    timestamptz,
  finished_at   timestamptz,
  result        jsonb
);
create index if not exists show_lookups_open_idx on show_lookups (status) where status in ('pending','running');
grant usage on sequence show_lookups_id_seq to authenticated;
alter table show_lookups enable row level security;
drop policy if exists show_lookups_editor_read on show_lookups;
create policy show_lookups_editor_read on show_lookups for select using (is_editor());
drop policy if exists show_lookups_editor_ask on show_lookups;
create policy show_lookups_editor_ask on show_lookups for insert with check (
  is_editor() and status = 'pending' and requested_by = lower(coalesce(auth.jwt()->>'email',''))
  and started_at is null and finished_at is null and result is null
  and (select count(*) from show_lookups o where o.requested_by = lower(coalesce(auth.jwt()->>'email',''))
       and o.status in ('pending','running')) < 3);
do $$ begin
  begin execute 'alter publication supabase_realtime add table show_lookups'; exception when duplicate_object then null; end;
end $$;
