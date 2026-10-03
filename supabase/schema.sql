-- RSD Show Shift Board — Supabase schema
-- Paste this whole file into the Supabase SQL editor once (Project → SQL → New query → Run).
-- Safe to re-run: every statement is idempotent.
--
-- Model: one table per collection, each row = { id, data jsonb }. The page and the CLI treat
-- `data` as the document. Reps read anonymously; only emails in `editors` can write.
-- `event_contacts` (promoter contact name, phone, email per event id) is its own table so those
-- three fields never sit in the public git repo's seed. It is NOT private: the open read policy lets
-- anyone with the anon key in config.js read every row from the API, page or no page, and follow
-- changes over realtime. Reps need them to call a promoter (Alan, 2026-09-19; re-confirmed 2026-10-02
-- knowing that scope). The page and the CLI split them out of `events` on every write and merge
-- them back on read; nothing else knows the table exists.
-- To lock contacts to editors later, change event_contacts_read to `using (is_editor())` — not to
-- `auth.role() = 'authenticated'`: sign-ups are open, so anyone can get a login.

create extension if not exists pgcrypto;

-- ---------- documents ----------
create table if not exists events     (id text primary key, data jsonb not null default '{}'::jsonb, updated_at timestamptz not null default now());
create table if not exists history    (id text primary key, data jsonb not null default '{}'::jsonb, updated_at timestamptz not null default now());
create table if not exists settings   (id text primary key, data jsonb not null default '{}'::jsonb, updated_at timestamptz not null default now());
create table if not exists seasons    (id text primary key, data jsonb not null default '{}'::jsonb, updated_at timestamptz not null default now());
create table if not exists never_work (id text primary key, data jsonb not null default '{}'::jsonb, updated_at timestamptz not null default now());
create table if not exists overrides  (id text primary key, data jsonb not null default '{}'::jsonb, updated_at timestamptz not null default now());
create table if not exists event_contacts (id text primary key, data jsonb not null default '{}'::jsonb, updated_at timestamptz not null default now());  -- readable on the page, never in git

-- who may edit. Alan adds rows here (or via `board editors add`). role: owner | coordinator
create table if not exists editors (
  email     text primary key,
  role      text not null default 'coordinator' check (role in ('owner','coordinator')),
  name      text,
  added_at  timestamptz not null default now()
);

-- an audit trail of every change, for "what did the bot do on Wednesday"
create table if not exists changelog (
  id        bigserial primary key,
  at        timestamptz not null default now(),
  actor     text,               -- email, or 'service:<routine>'
  tbl       text not null,
  doc_id    text not null,
  op        text not null,      -- set | update | delete
  patch     jsonb
);

create index if not exists events_year_idx     on events ((data->>'year'));
create index if not exists events_weekend_idx  on events ((data->>'weekend'));
create index if not exists events_status_idx   on events ((data->>'status'));
create index if not exists changelog_at_idx    on changelog (at desc);

-- ---------- helpers ----------
create or replace function touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

do $$ declare t text; begin
  foreach t in array array['events','history','settings','seasons','never_work','overrides','event_contacts'] loop
    execute format('drop trigger if exists %I_touch on %I', t, t);
    execute format('create trigger %I_touch before update on %I for each row execute function touch_updated_at()', t, t);
  end loop;
end $$;

create or replace function is_editor() returns boolean language sql stable security definer as $$
  select exists (select 1 from editors where email = lower(coalesce(auth.jwt()->>'email','')))
$$;
create or replace function is_owner() returns boolean language sql stable security definer as $$
  select exists (select 1 from editors where email = lower(coalesce(auth.jwt()->>'email','')) and role = 'owner')
$$;

-- every write lands in changelog: who, what, when. Routines announce themselves through
-- merge_doc's actor argument; people show up as their email.
create or replace function log_change() returns trigger language plpgsql security definer as $$
declare who text;
begin
  who := coalesce(nullif(current_setting('board.actor', true), ''), auth.jwt()->>'email', auth.role(), 'unknown');
  if tg_op = 'DELETE' then
    insert into changelog (actor, tbl, doc_id, op, patch) values (who, tg_table_name, old.id, 'delete', old.data);
    return old;
  end if;
  insert into changelog (actor, tbl, doc_id, op, patch) values (who, tg_table_name, new.id, lower(tg_op), new.data);
  return new;
end $$;

do $$ declare t text; begin
  foreach t in array array['events','history','settings','seasons','never_work','overrides','event_contacts'] loop
    execute format('drop trigger if exists %I_log on %I', t, t);
    execute format('create trigger %I_log after insert or update or delete on %I for each row execute function log_change()', t, t);
  end loop;
end $$;

-- shallow-merge a patch into a document, creating it if needed. This is what the page's
-- doc(path).update(patch) calls, so a concurrent edit to a different field is never clobbered.
create or replace function merge_doc(tbl text, doc_id text, patch jsonb, actor text default null)
returns jsonb language plpgsql security definer as $$
declare out jsonb;
begin
  if tbl not in ('events','history','settings','seasons','never_work','overrides','event_contacts') then
    raise exception 'unknown table %', tbl;
  end if;
  if not (is_editor() or auth.role() = 'service_role') then
    raise exception 'not an editor' using errcode = '42501';
  end if;
  if actor is not null then perform set_config('board.actor', actor, true); end if;
  execute format('insert into %I (id, data) values ($1, $2) on conflict (id) do update set data = %I.data || excluded.data returning data', tbl, tbl)
    into out using doc_id, patch;
  return out;
end $$;

-- ---------- row-level security ----------
do $$ declare t text; begin
  foreach t in array array['events','history','settings','seasons','never_work','overrides'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I_read on %I', t, t);
    execute format('create policy %I_read on %I for select using (true)', t, t);          -- reps read anonymously
    execute format('drop policy if exists %I_write on %I', t, t);
    execute format('create policy %I_write on %I for all using (is_editor()) with check (is_editor())', t, t);
  end loop;
end $$;

-- promoter contacts: anyone can read, through the page or the API (reps call promoters; public on
-- purpose, Alan 2026-10-02); only editors write.
alter table event_contacts enable row level security;
drop policy if exists event_contacts_read on event_contacts;
create policy event_contacts_read on event_contacts for select using (true);
drop policy if exists event_contacts_write on event_contacts;
create policy event_contacts_write on event_contacts for all using (is_editor()) with check (is_editor());

alter table editors enable row level security;
drop policy if exists editors_self_read on editors;
create policy editors_self_read on editors for select using (email = lower(coalesce(auth.jwt()->>'email','')) or is_owner());
drop policy if exists editors_owner_write on editors;
create policy editors_owner_write on editors for all using (is_owner()) with check (is_owner());

alter table changelog enable row level security;
drop policy if exists changelog_editor_read on changelog;
create policy changelog_editor_read on changelog for select using (is_editor());
drop policy if exists changelog_editor_insert on changelog;
create policy changelog_editor_insert on changelog for insert with check (is_editor());

-- ---------- the Sheet sync's doorbell (2026-09-28) ----------
-- "Sync from the Sheet" on the page inserts a pending row. The mini's listener (scripts/sync-requests.mjs,
-- launchd com.allinalan.rsd-board-sync, every 30 s) claims every pending row, runs scripts/sheet-sync.mjs
-- --apply once for all of them, and the sync writes its result onto those rows. A sync run any other way
-- with --apply (the Wednesday job) adds its own row, so "last synced" on the page is true either way.
-- Editors read and ring; only the service key (the mini) moves a row past pending. The result carries
-- event names, rep names and field changes the board already shows, never promoter contacts.
create table if not exists sheet_syncs (
  id            bigserial primary key,
  requested_at  timestamptz not null default now(),
  requested_by  text not null default lower(coalesce(auth.jwt()->>'email','')),
  status        text not null default 'pending' check (status in ('pending','running','done','stopped','failed')),
  started_at    timestamptz,
  finished_at   timestamptz,
  result        jsonb
);
create index if not exists sheet_syncs_open_idx on sheet_syncs (status) where status in ('pending','running');
grant usage on sequence sheet_syncs_id_seq to authenticated;
alter table sheet_syncs enable row level security;
drop policy if exists sheet_syncs_editor_read on sheet_syncs;
create policy sheet_syncs_editor_read on sheet_syncs for select using (is_editor());
drop policy if exists sheet_syncs_editor_ring on sheet_syncs;
create policy sheet_syncs_editor_ring on sheet_syncs for insert with check (
  is_editor() and status = 'pending' and requested_by = lower(coalesce(auth.jwt()->>'email',''))
  and started_at is null and finished_at is null and result is null);

-- ---------- realtime ----------
-- lets the page redraw the instant anyone saves (the shift-picking meeting depends on this)
do $$ begin
  begin execute 'alter publication supabase_realtime add table events';     exception when duplicate_object then null; end;
  begin execute 'alter publication supabase_realtime add table history';    exception when duplicate_object then null; end;
  begin execute 'alter publication supabase_realtime add table settings';   exception when duplicate_object then null; end;
  begin execute 'alter publication supabase_realtime add table never_work'; exception when duplicate_object then null; end;
  begin execute 'alter publication supabase_realtime add table overrides';  exception when duplicate_object then null; end;
  begin execute 'alter publication supabase_realtime add table event_contacts'; exception when duplicate_object then null; end;
  begin execute 'alter publication supabase_realtime add table sheet_syncs';    exception when duplicate_object then null; end;
end $$;

-- ---------- first owner ----------
-- Replace the email, run once. Everyone else is added from the board's Division settings or the CLI.
insert into editors (email, role, name) values ('ahernandez@allinknifeguy.com', 'owner', 'Alan')
  on conflict (email) do update set role = 'owner';
