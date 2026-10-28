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
-- the Kiosk Schedule tab (2026-10-14): one row per mall per holiday season, id YYYY-<mall>. Its own table so mall
-- shifts never reach the routines that read `events` (event check, booking sweep, research, Sheet sync, SUNNY).
create table if not exists kiosks     (id text primary key, data jsonb not null default '{}'::jsonb, updated_at timestamptz not null default now());
-- shift coverage requests (2026-10-22): a rep asks from SUNNY, the mini (rsd-shift-picking coverage agent) texts both
-- reps and moves the shift only after both reply YES. Readable by everyone like `events` (names and shifts the board
-- already shows); anon writes only through coverage_request() below; the mini writes with the service key.
create table if not exists coverage   (id text primary key, data jsonb not null default '{}'::jsonb, updated_at timestamptz not null default now());

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
  foreach t in array array['events','history','settings','seasons','never_work','overrides','event_contacts','kiosks','coverage'] loop
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
  foreach t in array array['events','history','settings','seasons','never_work','overrides','event_contacts','kiosks','coverage'] loop
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
  if tbl not in ('events','history','settings','seasons','never_work','overrides','event_contacts','kiosks','coverage') then
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

-- ---------- safe saves for a show's shifts (stage 3, 2026-10-27) ----------
-- The January 13, 2027 meeting is the first one run on the board, with two coordinators typing at once. A slot save used
-- to copy the show's whole `booths` from the page and write it back, so a pick made a second earlier on another screen
-- was put back as it was, with no error. Now:
--   set_slot    one slot, written only if it still holds what the person saw (`p_seen`, its rep and ft); otherwise
--               nothing changes and the answer says what the slot holds now. `p_value.notWorked` (true / false) marks or
--               clears "didn't work" (stage 3: what a red name meant on the Sheet; a past day with a person on it only);
--               a different person in the slot always clears it.
--   set_booths  a show's whole `booths` (add or remove a booth or a shift row, a booth's name, a date move), written only
--               if `booths` is still exactly what the page read a moment before (`p_seen`); `p_extra` carries the other
--               fields such a change sets (dates), never `booths` or a promoter contact (those live in event_contacts).
-- Both lock the row, answer { ok: true } or { ok: false, why: 'changed' | 'gone' | 'bad' } and never raise for a stale
-- save; only a non-editor gets an error. Only the service key may name the changelog actor.
create or replace function set_slot(p_event text, p_booth int, p_shift int, p_day int, p_seen jsonb, p_value jsonb, p_actor text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare d jsonb; b jsonb; sh jsonb; slots jsonb; cur jsonb; nv jsonb; ft jsonb; rep text; nw boolean;
begin
  if not (is_editor() or auth.role() = 'service_role') then raise exception 'not an editor' using errcode = '42501'; end if;
  if p_booth is null or p_shift is null or p_day is null or p_booth < 0 or p_shift < 0 or p_day < 0
     or jsonb_typeof(p_seen) is distinct from 'object' or jsonb_typeof(p_value) is distinct from 'object' then
    return jsonb_build_object('ok', false, 'why', 'bad');
  end if;
  rep := btrim(coalesce(p_value->>'rep', ''));
  ft := case when jsonb_typeof(p_value->'ft') = 'array' then p_value->'ft' else '[]'::jsonb end;
  if length(rep) > 80 or jsonb_array_length(ft) > 6 then return jsonb_build_object('ok', false, 'why', 'bad'); end if;
  if p_value ? 'notWorked' then
    if jsonb_typeof(p_value->'notWorked') is distinct from 'boolean' then return jsonb_build_object('ok', false, 'why', 'bad'); end if;
    nw := (p_value->>'notWorked')::boolean;
    if nw and (rep = '' or rep = '__X__') then return jsonb_build_object('ok', false, 'why', 'bad'); end if;
  end if;
  select data into d from events where id = p_event for update;
  if d is null then return jsonb_build_object('ok', false, 'why', 'gone'); end if;
  b := d->'booths'->p_booth; sh := b->'shifts'->p_shift;
  if jsonb_typeof(sh) is distinct from 'object' then return jsonb_build_object('ok', false, 'why', 'gone'); end if;
  slots := case when jsonb_typeof(sh->'slots') = 'array' then sh->'slots' else '[]'::jsonb end;
  if p_day >= greatest(coalesce(jsonb_array_length(case when jsonb_typeof(b->'days') = 'array' then b->'days' end), 0), jsonb_array_length(slots)) then
    return jsonb_build_object('ok', false, 'why', 'gone');
  end if;
  cur := case when jsonb_typeof(slots->p_day) = 'object' then slots->p_day else '{}'::jsonb end;
  if coalesce(cur->>'rep', '') <> coalesce(p_seen->>'rep', '')
     or (case when jsonb_typeof(cur->'ft') = 'array' then cur->'ft' else '[]'::jsonb end)
        <> (case when jsonb_typeof(p_seen->'ft') = 'array' then p_seen->'ft' else '[]'::jsonb end) then
    return jsonb_build_object('ok', false, 'why', 'changed', 'now', jsonb_build_object('rep', coalesce(cur->>'rep', ''),
      'ft', case when jsonb_typeof(cur->'ft') = 'array' then cur->'ft' else '[]'::jsonb end));
  end if;
  nv := cur || jsonb_build_object('rep', rep, 'ft', ft);
  if nw is not null then nv := case when nw then nv || '{"notWorked": true}'::jsonb else nv - 'notWorked' end;
  elsif coalesce(cur->>'rep', '') <> rep then nv := nv - 'notWorked';
  end if;
  while jsonb_array_length(slots) < p_day loop slots := slots || jsonb_build_array(jsonb_build_object('rep', '', 'ft', '[]'::jsonb)); end loop;
  if jsonb_array_length(slots) = p_day then slots := slots || jsonb_build_array(nv); else slots := jsonb_set(slots, array[p_day::text], nv); end if;
  if p_actor is not null and auth.role() = 'service_role' then perform set_config('board.actor', p_actor, true); end if;
  update events set data = jsonb_set(data, array['booths', p_booth::text, 'shifts', p_shift::text, 'slots'], slots) where id = p_event;
  return jsonb_build_object('ok', true, 'slot', nv);
end $$;

create or replace function set_booths(p_event text, p_seen jsonb, p_booths jsonb, p_extra jsonb default '{}'::jsonb, p_actor text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare d jsonb; x jsonb := coalesce(p_extra, '{}'::jsonb);
begin
  if not (is_editor() or auth.role() = 'service_role') then raise exception 'not an editor' using errcode = '42501'; end if;
  if jsonb_typeof(p_booths) is distinct from 'array' or jsonb_array_length(p_booths) = 0
     or jsonb_typeof(p_seen) is distinct from 'array' or jsonb_typeof(x) <> 'object'
     or x ?| array['booths', 'contact', 'phone', 'email'] then
    return jsonb_build_object('ok', false, 'why', 'bad');
  end if;
  select data into d from events where id = p_event for update;
  if d is null then return jsonb_build_object('ok', false, 'why', 'gone'); end if;
  if coalesce(d->'booths', '[]'::jsonb) <> p_seen then return jsonb_build_object('ok', false, 'why', 'changed'); end if;
  if p_actor is not null and auth.role() = 'service_role' then perform set_config('board.actor', p_actor, true); end if;
  update events set data = data || x || jsonb_build_object('booths', p_booths) where id = p_event;
  return jsonb_build_object('ok', true);
end $$;
revoke all on function set_slot(text, int, int, int, jsonb, jsonb, text) from public;
revoke all on function set_booths(text, jsonb, jsonb, jsonb, text) from public;
-- Supabase grants anon execute on every new function in public by default: take it back (the functions refuse anon anyway)
revoke execute on function set_slot(text, int, int, int, jsonb, jsonb, text) from anon;
revoke execute on function set_booths(text, jsonb, jsonb, jsonb, text) from anon;
grant execute on function set_slot(text, int, int, int, jsonb, jsonb, text) to authenticated, service_role;
grant execute on function set_booths(text, jsonb, jsonb, jsonb, text) to authenticated, service_role;

-- ---------- row-level security ----------
do $$ declare t text; begin
  foreach t in array array['events','history','settings','seasons','never_work','overrides','kiosks','coverage'] loop
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

-- ---------- shift coverage: the one way in for a rep (2026-10-22) ----------
-- SUNNY calls this with the anon key (POST /rest/v1/rpc/coverage_request, body {"p": {...}}). It checks only what it
-- can check cheaply and safely: coverage is on, the requester may ask (settings/division.coverage.requesters, which the
-- mini writes from the rep master list), the cover is on the roster, 1-8 well-formed shifts after today in Phoenix, no
-- open request already on one of them, at most 3 open per requester and 30 new in an hour (all reps). It does NOT
-- check that the shifts are the requester's or that the cover is free: the mini checks everything again against the
-- board before anyone is texted, and refuses (status "refused", with the reason) what does not match. Never raises
-- for a bad request: { ok: false, why } in words a rep can read. Only "new" rows are made here; only the mini moves one on.
create or replace function coverage_request(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  st jsonb; req text; cov text; s jsonb; k jsonb; clean jsonb := '[]'::jsonb; n int; new_id text;
  today date := (now() at time zone 'America/Phoenix')::date;
  open_st text[] := array['new','waiting-approval','asking-requester','asking-cover'];
  bad constant text := 'That request did not come through right. Try again from SUNNY.';
begin
  perform pg_advisory_xact_lock(hashtext('coverage_request'));        -- one at a time: two taps cannot both pass the "already asked" check
  if p is null or jsonb_typeof(p) <> 'object' then return jsonb_build_object('ok', false, 'why', bad); end if;
  select data into st from settings where id = 'division';
  if st is null or coalesce(st->'coverage'->>'on', '') <> 'true' then
    return jsonb_build_object('ok', false, 'why', 'Request coverage is switched off right now. Text a coordinator.');
  end if;
  req := btrim(coalesce(p->>'requester', '')); cov := btrim(coalesce(p->>'cover', ''));
  if req = '' or length(req) > 60 then return jsonb_build_object('ok', false, 'why', bad); end if;
  if cov = '' or length(cov) > 60 then return jsonb_build_object('ok', false, 'why', 'Pick who is covering for you.'); end if;
  if jsonb_typeof(st->'coverage'->'requesters') is distinct from 'array' or not (st->'coverage'->'requesters') ? req then
    return jsonb_build_object('ok', false, 'why', 'Request coverage is not open to you yet. Text a coordinator.');
  end if;
  if jsonb_typeof(st->'roster') is distinct from 'array' or not (st->'roster') ? cov then
    return jsonb_build_object('ok', false, 'why', 'That person is not on the team roster.');
  end if;
  if lower(req) = lower(cov) then return jsonb_build_object('ok', false, 'why', 'Pick someone other than yourself.'); end if;
  if jsonb_typeof(p->'slots') is distinct from 'array' or jsonb_array_length(p->'slots') not between 1 and 8 then
    return jsonb_build_object('ok', false, 'why', 'Pick between 1 and 8 shifts.');
  end if;
  for s in select value from jsonb_array_elements(p->'slots') loop
    if jsonb_typeof(s) <> 'object' or coalesce(s->>'date', '') !~ '^\d{4}-\d{2}-\d{2}$'
       or length(coalesce(s->>'event', '')) not between 1 and 100 then
      return jsonb_build_object('ok', false, 'why', bad);
    end if;
    if (s->>'date')::date <= today then return jsonb_build_object('ok', false, 'why', 'One of those shifts is today or already over.'); end if;
    if s->>'kind' = 'show' then
      if coalesce(s->>'booth', '') !~ '^\d{1,2}$' or coalesce(s->>'shift', '') !~ '^\d{1,2}$' or coalesce(s->>'day', '') !~ '^\d{1,2}$' then
        return jsonb_build_object('ok', false, 'why', bad);
      end if;
      k := jsonb_build_object('kind', 'show', 'event', s->>'event', 'booth', (s->>'booth')::int, 'shift', (s->>'shift')::int, 'day', (s->>'day')::int);
    elsif s->>'kind' = 'kiosk' then
      k := jsonb_build_object('kind', 'kiosk', 'event', s->>'event', 'date', s->>'date');
    else
      return jsonb_build_object('ok', false, 'why', bad);
    end if;
    if clean @> jsonb_build_array(k) then return jsonb_build_object('ok', false, 'why', 'The same shift is in there twice.'); end if;
    if exists (select 1 from coverage c where c.data->>'status' = any(open_st) and c.data->'slots' @> jsonb_build_array(k)) then
      return jsonb_build_object('ok', false, 'why', 'One of those shifts already has a coverage request waiting.');
    end if;
    clean := clean || jsonb_build_array(k || jsonb_build_object('date', s->>'date', 'label', left(coalesce(s->>'label', ''), 120)));
  end loop;
  select count(*) into n from coverage c where c.data->>'requester' = req and c.data->>'status' = any(open_st);
  if n >= 3 then return jsonb_build_object('ok', false, 'why', 'You already have 3 requests waiting. Let those finish first.'); end if;
  select count(*) into n from coverage c where c.id > 'cv-' || to_char((now() - interval '1 hour') at time zone 'America/Phoenix', 'YYYYMMDD-HH24MI');
  if n >= 30 then return jsonb_build_object('ok', false, 'why', 'Too many requests right now. Try again in an hour, or text a coordinator.'); end if;
  new_id := 'cv-' || to_char(now() at time zone 'America/Phoenix', 'YYYYMMDD-HH24MI') || '-' || substr(md5(random()::text || clock_timestamp()::text), 1, 6);
  perform set_config('board.actor', 'sunny:coverage_request', true);
  insert into coverage (id, data) values (new_id, jsonb_build_object(
    'requester', req, 'cover', cov, 'slots', clean, 'via', 'sunny', 'status', 'new', 'why', '', 'code', '',
    'moved', '[]'::jsonb, 'createdAt', to_jsonb(now()), 'updatedAt', to_jsonb(now())));
  return jsonb_build_object('ok', true, 'id', new_id);
end $$;
revoke all on function coverage_request(jsonb) from public;
grant execute on function coverage_request(jsonb) to anon, authenticated;

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
  begin execute 'alter publication supabase_realtime add table kiosks';         exception when duplicate_object then null; end;
  begin execute 'alter publication supabase_realtime add table coverage';       exception when duplicate_object then null; end;
end $$;

-- ---------- first owner ----------
-- Replace the email, run once. Everyone else is added from the board's Division settings or the CLI.
insert into editors (email, role, name) values ('ahernandez@allinknifeguy.com', 'owner', 'Alan')
  on conflict (email) do update set role = 'owner';
