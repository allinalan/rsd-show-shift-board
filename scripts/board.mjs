#!/usr/bin/env node
/*
  board — the command line for the RSD Show Shift Board.
  Every routine on the Mac mini reads and writes the board through this, so the page and the
  bots always agree on what a document looks like. No dependencies: Node 18+ and fetch.

  Setup (once, on the machine that runs routines):
    mkdir -p ~/.rsd && cat > ~/.rsd/board.env <<EOF
    BOARD_SUPABASE_URL=https://xxxx.supabase.co
    BOARD_SERVICE_KEY=eyJ...            # Supabase → Project settings → API → service_role (secret)
    EOF

  Usage:
    board list [--year 2027] [--status Prospective] [--staffed] [--no-vc] [--upcoming] [--weekend 2027-01-15] [--json]
    board get <id>
    board set <id> field=value [field=value ...]       (field:=json for arrays/objects/booleans)
    board add --name "…" --start 2027-03-06 [--end 2027-03-07] [--city "Prescott, AZ"] [field=value ...]
    board delete <id>
    board rollforward <year> [--include-dead] [--dry-run]
    board never <event-id> [--why "…"]
    board restore <never-id>
    board editors list | add <email> [--role owner|coordinator] [--name "…"] | remove <email>
    board settings get | set field=value ...            (meetings:='["2027-01-15","2027-05-01"]')
    board history set <baseId> <year> <cpo> [orders]
    board tick [--date 2027-01-08]                      (which routines are due today)
    board changelog [--limit 50]
    board seed [--force]                                (load seed/*.json into an empty database)
    board export [dir]                                  (dump every table to JSON — a backup)

  Promoter contact details (contact, phone, email) are not in `events`: they live in the
  `event_contacts` table, keyed by event id (readable on the live page, never in the git seed). `get`, `list --full`, `set`, `add`,
  `delete`, `rollforward`, `seed` and `export` handle the split, so routines still read and write
  them as plain event fields. Their seed is seed/private/event_contacts.json (gitignored).
*/
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');

// ---------- env ----------
function loadEnv() {
  const f = path.join(os.homedir(), '.rsd', 'board.env');
  if (fs.existsSync(f)) for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  const url = process.env.BOARD_SUPABASE_URL, key = process.env.BOARD_SERVICE_KEY;
  if (!url || !key) die('BOARD_SUPABASE_URL and BOARD_SERVICE_KEY are not set. Put them in ~/.rsd/board.env (see the header of this file).');
  return { url: url.replace(/\/$/, ''), key };
}
function die(msg, code = 1) { console.error('board: ' + msg); process.exit(code); }

// ---------- REST ----------
const TABLES = ['events', 'history', 'settings', 'seasons', 'never_work', 'overrides'];
const CONTACTS = 'event_contacts', PRIVATE = ['contact', 'phone', 'email'];   // own table: shown on the live page, never in `events`, never in the public git seed
const splitPriv = o => { const pub = {}, priv = {}; for (const k of Object.keys(o || {})) (PRIVATE.includes(k) ? priv : pub)[k] = o[k]; return { pub, priv }; };
const hasKeys = o => Object.keys(o).length > 0, hasValue = o => Object.values(o).some(v => v != null && String(v).trim() !== '');
const pickPriv = c => { const o = {}; for (const k of PRIVATE) if (c && c[k] != null) o[k] = c[k]; return o; };
let ENV = null;
async function rest(method, pathq, body, extraHeaders = {}) {
  ENV = ENV || loadEnv();
  const r = await fetch(ENV.url + '/rest/v1/' + pathq, {
    method, headers: { apikey: ENV.key, Authorization: 'Bearer ' + ENV.key, 'Content-Type': 'application/json', ...extraHeaders },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await r.text();
  if (!r.ok) die(`${method} ${pathq} → ${r.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}
const rows = async (t, q = '') => (await rest('GET', `${t}?select=id,data,updated_at${q ? '&' + q : ''}&order=id`)).map(r => ({ id: r.id, ...r.data, _updated: r.updated_at }));
const getDoc = async (t, id) => { const r = await rest('GET', `${t}?select=id,data&id=eq.${encodeURIComponent(id)}`); return r[0] ? { id: r[0].id, ...r[0].data } : null; };
const setDoc = (t, id, data) => rest('POST', `${t}?on_conflict=id`, [{ id, data }], { Prefer: 'resolution=merge-duplicates,return=minimal' });
const mergeDoc = (t, id, patch, actor) => rest('POST', 'rpc/merge_doc', { tbl: t, doc_id: id, patch, actor: actor || ACTOR });
const delDoc = (t, id) => rest('DELETE', `${t}?id=eq.${encodeURIComponent(id)}`, undefined, { Prefer: 'return=minimal' });
const ACTOR = process.env.BOARD_ACTOR || 'service:board-cli';
const contactMap = async () => { const m = {}; for (const r of await rest('GET', `${CONTACTS}?select=id,data`)) m[r.id] = r.data || {}; return m; };
const liveDocs = async t => { const m = {}; for (const r of await rest('GET', `${t}?select=id,data`)) m[r.id] = r.data || {}; return m; };
const emptyish = v => v == null || (typeof v === 'string' && v.trim() === '') || (Array.isArray(v) && v.length === 0) || (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0);
/**
 * A seed must never destroy state the seed file does not carry. `settings` holds `meetings`,
 * which comes from seed/private/go-live.md and can never be committed to this public repo — a
 * plain upsert replaced the whole row and silently emptied it, which would have stopped
 * tick.py ever reporting preflight due (caught at cutover, 2026-09-20). So an empty value in
 * the seed never overwrites a filled value in the database. To blank a field, use `set`.
 */
function keepFilled(data, liveDoc) {
  if (!liveDoc) return 0;
  let kept = 0;
  for (const [k, v] of Object.entries(liveDoc)) {
    if (!emptyish(v) && k in data && emptyish(data[k])) { data[k] = v; kept++; }
  }
  return kept;
}

// ---------- args ----------
const argv = process.argv.slice(2);
const cmd = argv.shift();
const flags = {}, pos = [], kv = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) { const k = a.slice(2); const nx = argv[i + 1]; if (nx !== undefined && !nx.startsWith('--') && !/^[a-zA-Z_]+:?=/.test(nx)) { flags[k] = nx; i++; } else flags[k] = true; }
  else if (/^[a-zA-Z_][\w.]*:=/.test(a)) { const [k, v] = a.split(/:=(.*)/s); kv[k] = JSON.parse(v); }
  else if (/^[a-zA-Z_][\w.]*=/.test(a)) { const [k, v] = a.split(/=(.*)/s); kv[k] = v; }
  else pos.push(a);
}
const json = !!flags.json;
const out = v => console.log(json ? JSON.stringify(v, null, 1) : v);

// ---------- dates (ported verbatim from the page so both sides agree) ----------
const iso = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const fromISO = s => { if (!s) return null; const [y, m, d] = String(s).split('-').map(Number); return (y && m && d) ? new Date(y, m - 1, d) : null; };
const parseUS = s => { if (!s) return null; const m = String(s).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); if (m) return new Date(+m[3], +m[1] - 1, +m[2]); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? fromISO(s) : null; };
const addDays = (d, n) => { const c = new Date(d); c.setDate(c.getDate() + n); return c; };
const DAYN = { monday: 0, mon: 0, tuesday: 1, tue: 1, tues: 1, wednesday: 2, wed: 2, thursday: 3, thu: 3, thur: 3, thurs: 3, friday: 4, fri: 4, saturday: 5, sat: 5, sunday: 6, sun: 6 };
function dayDates(days, startISO) {
  const sd = fromISO(startISO); if (!sd) return days.map(() => null);
  return days.map(d => {
    const base = (d || '').replace(/\bSE\b/i, '').trim().toLowerCase().replace(/\.$/, '');
    if (/^\d{1,2}\/\d{1,2}$/.test(base)) { const [m, dd] = base.split('/').map(Number); return iso(new Date(sd.getFullYear(), m - 1, dd)); }
    if (!(base in DAYN)) return null;
    const want = (DAYN[base] + 1) % 7;
    for (let k = 0; k < 14; k++) { const c = addDays(sd, k); if (c.getDay() === want) return iso(c); }
    return null;
  });
}
const fridayKey = startISO => { const d = fromISO(startISO); if (!d) return ''; const off = (d.getDay() + 6) % 7; return iso(addDays(d, 4 - off)); };
const normName = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const SERIES_STRIP = /\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec|week\s*\d+|wk\s*\d+|w\s*\d+|weekend\s*\d+|\d{4})\b/g;
const seriesKey = e => normName(e.name).replace(SERIES_STRIP, ' ').replace(/\s+/g, ' ').trim();
const baseId = id => String(id).replace(/^\d{4}-/, '');
const rollId = (e, Y) => Y + '-' + baseId(e.id).replace(/[^A-Za-z0-9_\-.~:@+]/g, '-');
const yearOf = e => +(e.year || e.season || 0);
const isSE = d => /\bSE\b/i.test(d || '');
const today = () => { const d = flags.date ? fromISO(flags.date) : new Date(); d.setHours(0, 0, 0, 0); return d; };

function rollDoc(e, Y) {
  const sd = parseUS(e.startDate);
  const n = sd ? Math.max(0, Y - sd.getFullYear()) : 1;
  const nsd = sd ? addDays(sd, 364 * n) : null, startISO = nsd ? iso(nsd) : null;
  const booths = (e.booths || []).map(b => ({ label: b.label || '', status: '', days: b.days, dates: startISO ? dayDates(b.days, startISO) : b.days.map(() => null),
    shifts: (b.shifts || []).map(s => ({ label: s.label, slots: b.days.map(() => ({ rep: '', ft: [] })) })) }));
  let weekend = startISO ? fridayKey(startISO) : '';
  if (!weekend && e.weekend) { const wd = fromISO(e.weekend); if (wd) { const k = Math.max(1, Y - wd.getFullYear()); weekend = iso(addDays(wd, 364 * k)); } }
  const all = booths.flatMap(b => b.dates).filter(Boolean).sort();
  return { year: Y, season: String(Y), source: 'board', name: e.name, weekend, days: e.days, dates: startISO ? dayDates(e.days || [], startISO) : [],
    startDate: startISO, endDate: startISO ? (all.length ? all[all.length - 1] : startISO) : null, datesEstimated: true,
    cityState: e.cityState || '', location: e.location || '', promoter: e.promoter || '', contact: e.contact || '', phone: e.phone || '',
    email: e.email || '', website: e.website || '', address: e.address || '', setting: e.setting || '', applyUrl: e.applyUrl || '', applyBy: '', notes: e.notes || '',
    cost: e.cost || '', costBasis: e.costBasis || 'date', bestCPO: e.bestCPO || '', bestEver: e.bestEver || null, tier: e.tier || 'Traditional', access: e.access || 'Unassigned',
    level: e.level || '', flag: e.flag || '', status: 'Prospective', vcNumber: '', dead: false, skipNext: false, neverWork: false, booths,
    lastYear: { status: e.status, vcNumber: e.vcNumber || '', cost: e.cost || '', row: e.row || null, sheetStatus: e.sheetStatus || '', year: yearOf(e) },
    rolledFrom: String(yearOf(e)), rolledFromId: e.id, createdAt: new Date().toISOString() };
}

// ---------- staffing helpers ----------
const filled = e => { let n = 0; (e.booths || []).forEach(b => (b.shifts || []).forEach(s => (s.slots || []).forEach((sl, di) => { if (isSE(b.days[di])) return; if (sl.rep && sl.rep !== '__X__') n++; }))); return n; };
const reps = e => { const r = new Set(); (e.booths || []).forEach(b => (b.shifts || []).forEach(s => (s.slots || []).forEach(sl => { if (sl.rep && sl.rep !== '__X__') sl.rep.split(' / ').forEach(x => r.add(x)); }))); return [...r]; };
const brief = e => ({ id: e.id, name: e.name, year: yearOf(e), weekend: e.weekend, start: e.startDate, end: e.endDate, status: e.status, vc: e.vcNumber || '', city: e.cityState || '',
  tier: e.tier, access: e.access, filled: filled(e), reps: reps(e), skipNext: !!e.skipNext, neverWork: !!e.neverWork, dead: !!e.dead, notes: e.notes || '' });

// ---------- commands ----------
const commands = {
  async list() {
    let ev = await rows('events');
    if (flags.year) ev = ev.filter(e => yearOf(e) === +flags.year);
    if (flags.status) ev = ev.filter(e => String(e.status).toLowerCase() === String(flags.status).toLowerCase());
    if (flags.weekend) ev = ev.filter(e => e.weekend === flags.weekend);
    if (flags.staffed) ev = ev.filter(e => filled(e) > 0);
    if (flags['no-vc']) ev = ev.filter(e => !e.vcNumber);
    if (flags.upcoming) { const t = iso(today()); ev = ev.filter(e => (e.endDate || e.startDate || e.weekend || '') >= t); }
    if (flags.live) ev = ev.filter(e => !e.dead && !e.neverWork);
    ev.sort((a, b) => (a.weekend || '').localeCompare(b.weekend || '') || a.name.localeCompare(b.name));
    if (json && flags.full) { const cm = await contactMap(); ev = ev.map(e => ({ ...e, ...pickPriv(cm[e.id]) })); }
    if (json) return out(flags.full ? ev : ev.map(brief));
    for (const e of ev) console.log(`${(e.weekend || '—').padEnd(11)} ${String(e.status || '').padEnd(28)} ${String(e.vcNumber || '').padEnd(9)} ${String(filled(e)).padStart(2)} filled  ${e.name}  [${e.id}]`);
    console.error(`${ev.length} events`);
  },
  async get() { const e = await getDoc('events', pos[0] || die('get <id>')); if (!e) die('no such event'); out({ ...e, ...pickPriv(await getDoc(CONTACTS, e.id)) }); },
  async set() {
    const id = pos[0] || die('set <id> field=value …'); if (!Object.keys(kv).length) die('nothing to set');
    if (kv.startDate) Object.assign(kv, recomputeDates(await getDoc('events', id), kv.startDate));
    const { pub, priv } = splitPriv(kv); let r = null;
    if (hasKeys(priv)) { if (!(await getDoc('events', id))) die('no such event'); await mergeDoc(CONTACTS, id, priv); }
    if (hasKeys(pub)) r = await mergeDoc('events', id, pub);
    out(json ? r : `updated ${id}: ${Object.keys(kv).join(', ')}`);
  },
  async add() {
    const name = flags.name || kv.name || die('add --name "…" --start YYYY-MM-DD'); const st = flags.start || kv.startDate || die('--start is required');
    const en = flags.end || kv.endDate || st; const s = fromISO(st), e2 = fromISO(en); if (!s) die('bad --start');
    const NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']; const days = [];
    for (let d = new Date(s); d <= e2 && days.length < 7; d = addDays(d, 1)) days.push(NAMES[d.getDay()]);
    const dates = dayDates(days, st), Y = s.getFullYear();
    const slug = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
    const id = `${Y}-${slug}-${Math.random().toString(36).slice(2, 7)}`;
    const doc = { year: Y, season: String(Y), source: 'board', name, weekend: fridayKey(st), days, dates, startDate: st, endDate: en, datesEstimated: false,
      cityState: flags.city || '', location: '', promoter: '', contact: '', phone: '', email: '', website: '', address: '', setting: '', applyUrl: '', applyBy: '', notes: '',
      cost: '', costBasis: 'date', bestCPO: '', tier: 'Traditional', access: 'Unassigned', level: '', flag: '', status: 'Prospective', vcNumber: '', dead: false, skipNext: false, neverWork: false,
      booths: [{ label: '', status: '', days, dates, shifts: [{ label: 'Shift 1', slots: days.map(() => ({ rep: '', ft: [] })) }] }], createdAt: new Date().toISOString(), createdBy: ACTOR, ...kv };
    const { pub, priv } = splitPriv(doc);
    await setDoc('events', id, pub); if (hasValue(priv)) await setDoc(CONTACTS, id, priv);
    out(json ? { id } : `added ${name} as ${id}`);
  },
  async delete() { await delDoc('events', pos[0] || die('delete <id>')); await delDoc(CONTACTS, pos[0]); out('deleted ' + pos[0]); },
  async rollforward() {
    const Y = +pos[0] || die('rollforward <year>');
    const all = await rows('events'), never = await rows('never_work'); const nk = new Set(never.map(n => n.seriesKey));
    const have = new Set(all.map(e => e.id));
    const src = all.filter(e => yearOf(e) === Y - 1);
    const held = src.filter(e => e.skipNext || e.neverWork || nk.has(seriesKey(e)));
    const todo = src.filter(e => !held.includes(e)).filter(e => flags['include-dead'] || !e.dead).filter(e => !have.has(rollId(e, Y)));
    console.error(`${src.length} in ${Y - 1} → ${todo.length} to roll, ${held.length} held (skip-next / never-work), ${src.length - held.length - todo.length} already in ${Y} or dead`);
    if (flags['dry-run']) return out(todo.map(e => ({ from: e.id, to: rollId(e, Y), name: e.name })));
    const cm = await contactMap();
    let n = 0; for (const e of todo) { const to = rollId(e, Y); await setDoc('events', to, splitPriv(rollDoc(e, Y)).pub); const c = pickPriv(cm[e.id]); if (hasValue(c)) await setDoc(CONTACTS, to, c); n++; }
    await setDoc('seasons', String(Y), { id: String(Y), label: String(Y), source: 'board', rolledFrom: String(Y - 1), rolledAt: new Date().toISOString(), count: n, by: ACTOR });
    out(`rolled ${n} events into ${Y}`);
  },
  async never() {
    const e = await getDoc('events', pos[0] || die('never <event-id> [--why …]')); if (!e) die('no such event');
    const key = seriesKey(e) || e.id, nid = key.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
    await setDoc('never_work', nid, { name: e.name, seriesKey: key, cityState: e.cityState || '', reason: flags.why || '', lastYear: yearOf(e), fromEventId: e.id, addedAt: new Date().toISOString(), addedBy: ACTOR });
    const sibs = (await rows('events')).filter(x => yearOf(x) === yearOf(e) && seriesKey(x) === key);
    for (const m of sibs) await mergeDoc('events', m.id, { neverWork: true, dead: true, status: 'Cancelled' });
    out(`never again: ${e.name} (${sibs.length} date${sibs.length === 1 ? '' : 's'} this year) → never_work/${nid}`);
  },
  async restore() { const n = await getDoc('never_work', pos[0] || die('restore <never-id>')); if (!n) die('not on the list'); await delDoc('never_work', n.id); if (n.fromEventId) await mergeDoc('events', n.fromEventId, { neverWork: false }).catch(() => {}); out('restored ' + n.name); },
  async editors() {
    const sub = pos[0] || 'list';
    if (sub === 'list') return out(await rest('GET', 'editors?select=email,role,name,added_at&order=added_at'));
    if (sub === 'add') { const email = (pos[1] || die('editors add <email>')).toLowerCase(); await rest('POST', 'editors?on_conflict=email', [{ email, role: flags.role || 'coordinator', name: flags.name || null }], { Prefer: 'resolution=merge-duplicates,return=minimal' }); return out(`${email} can now edit (${flags.role || 'coordinator'})`); }
    if (sub === 'remove') { await rest('DELETE', `editors?email=eq.${encodeURIComponent((pos[1] || die('editors remove <email>')).toLowerCase())}`, undefined, { Prefer: 'return=minimal' }); return out('removed ' + pos[1]); }
    die('editors list | add <email> | remove <email>');
  },
  async settings() {
    const sub = pos[0] || 'get'; const cur = (await getDoc('settings', 'division')) || {};
    if (sub === 'get') return out(cur);
    if (sub === 'set') { if (!Object.keys(kv).length) die('settings set field=value'); await mergeDoc('settings', 'division', kv); return out('settings updated: ' + Object.keys(kv).join(', ')); }
    die('settings get | set');
  },
  async history() {
    if (pos[0] !== 'set') die('history set <baseId> <year> <cpo> [orders]');
    const [, key, y, cpo, orders] = pos; const cur = (await getDoc('history', key)) || { years: {} };
    cur.years = cur.years || {}; cur.years[y] = { cpo: parseCpo(cpo), orders: orders ? +orders : null }; cur.updatedAt = new Date().toISOString();
    await setDoc('history', key, cur); out(`history ${key} ${y} = ${cur.years[y].cpo}`);
  },
  async tick() {
    const t = today(), s = (await getDoc('settings', 'division')) || {}; const ms = (s.meetings || []).map(fromISO).filter(Boolean);
    const due = [];
    for (const m of ms) { const d = Math.round((m - t) / 864e5); if (d === 7) due.push({ routine: 'preflight', meeting: iso(m), note: 'research every event: dates, promoter, name; fix the board; ask Alan/JP about the rest' }); if (d === -1) due.push({ routine: 'booking-sweep', meeting: iso(m), note: 'submit a booking request for every staffed event with no VC number' }); }
    // The Wednesday event check runs unattended now (rsd-shift-picking's 08:00 job, 2026-09-23), so it is not "due".
    // New freshmen come from the training sign-in sheet filled at the January and August meetings (Alan,
    // 2026-09-23): ask for it two days after either meeting, or on a fixed day when none is on the calendar.
    const janAug = ms.filter(m => [0, 7].includes(m.getMonth()));
    const freshNote = "ask Alan for this season's training sign-in sheet, so the new freshmen get onto the roster";
    for (const m of janAug) if (Math.round((t - m) / 864e5) === 2) due.push({ routine: 'freshmen-roster', meeting: iso(m), note: freshNote });
    if (((t.getMonth() === 0 && t.getDate() === 20) || (t.getMonth() === 7 && t.getDate() === 15)) && !janAug.some(m => m.getFullYear() === t.getFullYear() && m.getMonth() === t.getMonth()))
      due.push({ routine: 'freshmen-roster', note: freshNote + ' (no meeting on the calendar this month)' });
    if (t.getMonth() === 11 && t.getDate() === 28) due.push({ routine: 'season-changeover', note: 'the board and the sheet sync still read only the Sept-Feb book: add the Jan-May book before the January meeting (config/event-check.json)' });
    out(json ? { date: iso(t), due } : (due.length ? due.map(d => `${d.routine}${d.meeting ? ' (meeting ' + d.meeting + ')' : ''} — ${d.note}`).join('\n') : `nothing due on ${iso(t)}`));
  },
  async changelog() { out(await rest('GET', `changelog?select=at,actor,tbl,doc_id,op,patch&order=at.desc&limit=${+flags.limit || 50}`)); },
  async seed() {
    const existing = await rest('GET', 'events?select=id&limit=1');
    if (existing.length && !flags.force) die('events already has rows — pass --force to upsert the seed over them');
    for (const t of TABLES) {
      const f = path.join(REPO, 'seed', t + '.json'); if (!fs.existsSync(f)) continue;
      let docs = JSON.parse(fs.readFileSync(f, 'utf8')); if (!Array.isArray(docs)) docs = [docs];
      if (t === 'events') { const leak = docs.filter(d => hasValue(splitPriv(d).priv)); if (leak.length) die(`seed/events.json carries contact/phone/email on ${leak.length} event(s) (first: ${leak[0].id}). That table is public. Move them to seed/private/${CONTACTS}.json, then seed again. Nothing was written.`); }
      const live = await liveDocs(t);
      let kept = 0;
      for (let i = 0; i < docs.length; i += 100) {
        const chunk = docs.slice(i, i + 100).map(d => {
          const { id, ...data } = d;
          kept += keepFilled(data, live[id]);
          return { id, data };
        });
        await rest('POST', `${t}?on_conflict=id`, chunk, { Prefer: 'resolution=merge-duplicates,return=minimal' });
      }
      console.error(`${t}: ${docs.length}${kept ? ` (kept ${kept} field(s) the seed would have emptied)` : ''}`);
    }
    // promoter contacts: machine-local, gitignored. Missing file = loud, not fatal (a fresh clone won't have it).
    const cf = path.join(REPO, 'seed', 'private', CONTACTS + '.json');
    if (fs.existsSync(cf)) {
      const docs = JSON.parse(fs.readFileSync(cf, 'utf8'));
      for (let i = 0; i < docs.length; i += 100) await rest('POST', `${CONTACTS}?on_conflict=id`, docs.slice(i, i + 100).map(d => ({ id: d.id, data: pickPriv(d) })), { Prefer: 'resolution=merge-duplicates,return=minimal' });
      console.error(`${CONTACTS}: ${docs.length}`);
    } else console.error(`WARNING: ${cf} not found — NO promoter contacts were seeded. Copy it from the mini (or a backup) and run: board seed --force`);
    out('seeded');
  },
  async export() {
    const dir = pos[0] || path.join(REPO, 'backups', new Date().toISOString().slice(0, 10)); fs.mkdirSync(dir, { recursive: true });
    for (const t of [...TABLES, CONTACTS]) { const r = await rows(t); fs.writeFileSync(path.join(dir, t + '.json'), JSON.stringify(r.map(({ _updated, ...d }) => d), null, 1)); console.error(`${t}: ${r.length}`); }
    fs.writeFileSync(path.join(dir, 'editors.json'), JSON.stringify(await rest('GET', 'editors?select=email,role,name'), null, 1));
    out('exported to ' + dir);
  },
};
function parseCpo(s) { s = String(s || '').trim().toLowerCase().replace(/[$,]/g, ''); const m = s.match(/^(\d+(?:\.\d+)?)\s*(k)?$/); if (!m) return null; let n = parseFloat(m[1]); if (m[2]) n *= 1000; else if (n < 100) n *= 1000; return Math.round(n); }
function recomputeDates(e, startISO) {
  if (!e) return {}; const booths = JSON.parse(JSON.stringify(e.booths || [])); booths.forEach(b => { b.dates = dayDates(b.days, startISO); });
  const all = booths.flatMap(b => b.dates).filter(Boolean).sort();
  return { startDate: startISO, endDate: all.length ? all[all.length - 1] : startISO, dates: dayDates(e.days || [], startISO), booths, weekend: fridayKey(startISO), datesEstimated: false };
}

if (!cmd || flags.help || !commands[cmd]) { console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^\/\*\s*/, '')); process.exit(cmd && !commands[cmd] ? 1 : 0); }
commands[cmd]().catch(e => die(e.message || String(e)));
