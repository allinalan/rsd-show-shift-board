#!/usr/bin/env node
/*
  Tests for scripts/board.mjs against an in-memory stand-in for Supabase's REST API.
  No network, no real database, no ~/.rsd/board.env (HOME points at a temp dir).
      node tests/run-all.mjs
  The point of most of these: promoter contact/phone/email must never land in `events` (public).
  Every block is a section(): one that throws is one named failure, the rest still run, and the last line is
  always the count. Exit 1 on any failure (install.sh --check and --arm read that).
*/
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { fileURLToPath } from 'url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const db = {};                                   // table -> Map(id -> data)
const T = t => (db[t] = db[t] || new Map());
const FLAT = new Set(['sheet_syncs']); let flatId = 0, flatReads = 0;   // flatReads: GETs on a plain table (did the listener ask at all?)
const actors = new Set();                        // who merge_doc was told did the write (the changelog's actor)
const pgMatch = (row, u) => {
  for (const [k, v] of u.searchParams) {
    if (['select', 'order', 'limit', 'on_conflict'].includes(k)) continue;
    const m = v.match(/^(eq|in)\.(.*)$/); if (!m) continue;
    const vals = m[1] === 'eq' ? [m[2]] : m[2].replace(/^\(|\)$/g, '').split(',');
    if (!vals.includes(String(row[k]))) return false;
  }
  return true;
};
const server = http.createServer((req, res) => {
  let body = ''; req.on('data', c => body += c); req.on('end', () => {
    const u = new URL(req.url, 'http://x'); const p = u.pathname.replace('/rest/v1/', ''); const send = (code, v) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(v === undefined ? '' : JSON.stringify(v)); };
    if (FLAT.has(p)) {                           // a plain table (sheet_syncs): numbered rows, eq./in. filters, PATCH
      const rows = [...T(p).values()];
      if (req.method === 'GET') {
        flatReads++;
        const [col, dir] = (u.searchParams.get('order') || 'id').split('.'), lim = +u.searchParams.get('limit');
        const key = r => r[col] == null ? null : r[col], cmp = (a, b) => key(a) === key(b) ? 0 : key(a) === null ? 1 : key(b) === null ? -1 : (key(a) < key(b) ? -1 : 1) * (dir === 'desc' ? -1 : 1);
        const out = rows.filter(r => pgMatch(r, u)).sort(cmp); return send(200, lim ? out.slice(0, lim) : out);
      }
      if (req.method === 'POST') { for (const r of JSON.parse(body)) { const id = ++flatId; T(p).set(id, { id, requested_at: new Date().toISOString(), requested_by: '', status: 'pending', started_at: null, finished_at: null, result: null, ...r }); } return send(201); }
      if (req.method === 'PATCH') { const hit = rows.filter(r => pgMatch(r, u)); const patch = JSON.parse(body); hit.forEach(r => Object.assign(r, patch)); return send(200, hit); }
    }
    if (p === 'rpc/merge_doc') { const { tbl, doc_id, patch, actor } = JSON.parse(body); actors.add(actor); const cur = T(tbl).get(doc_id) || {}; const next = { ...cur, ...patch }; T(tbl).set(doc_id, next); return send(200, next); }
    const eq = u.searchParams.get('id'); const id = eq && eq.startsWith('eq.') ? decodeURIComponent(eq.slice(3)) : null;
    if (req.method === 'GET') { let r = [...T(p)].map(([i, data]) => ({ id: i, data, updated_at: 'now' })); if (id !== null) r = r.filter(x => x.id === id); r.sort((a, b) => a.id.localeCompare(b.id)); const lim = +u.searchParams.get('limit'); return send(200, lim ? r.slice(0, lim) : r); }
    if (req.method === 'POST') { for (const row of JSON.parse(body)) T(p).set(row.id, row.data); return send(201); }
    if (req.method === 'DELETE') { T(p).delete(id); return send(204); }
    send(405, { message: 'unsupported' });
  });
});

let pass = 0, failN = 0;
const ok = (cond, name) => { if (cond) pass++; else { failN++; console.error('  FAIL  ' + name); } };
// One block of tests. A check that fails is usually followed by code that leaned on it (autos[0] of an empty list),
// and that throw used to end the run on the spot, with no count and every later block unrun: on 2026-10-06 a
// listener failure hid the event-check and booking-sweep tests. A throw is now one more failure, named, with the
// line it came from, and the blocks after it still run.
const section = async (name, fn) => {
  try { await fn(); } catch (e) {
    failN++; console.error(`  FAIL  ${name}: threw, so the rest of this block did not run\n        ${String((e && e.stack) || e).split('\n').slice(0, 2).map(l => l.trim()).join('\n        ')}`);
  }
};
let r;                                           // the last command's result; every block reuses it
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'board-test-'));
let base = '';
const board = (args, env = {}) => new Promise(r => execFile(process.execPath, [path.join(REPO, 'scripts/board.mjs'), ...args],
  { env: { PATH: process.env.PATH, HOME: home, BOARD_SUPABASE_URL: base, BOARD_SERVICE_KEY: 'test', ...env } }, (err, stdout, stderr) => r({ code: err ? err.code : 0, stdout, stderr })));
const run = (bin, args) => new Promise(r => execFile(bin, args, { env: { PATH: process.env.PATH, HOME: home } }, (err, stdout, stderr) => r({ code: err ? err.code : 0, stdout, stderr })));
const stage = path.join(home, 'stage'), tickLog = path.join(stage, 'logs', 'tick.log');   // tick.py's staged copy: two blocks run it
const PRIV = ['contact', 'phone', 'email'];
const leaked = () => [...T('events').values()].filter(d => PRIV.some(k => k in d));
const isSE = l => /set\s*up|tear\s*down|\bse\b/i.test(String(l || ''));
const staffedOf = e => (e.booths || []).reduce((n, b) => n + (b.shifts || []).reduce((m, s) =>
  m + (s.slots || []).filter((sl, i) => sl.rep && sl.rep !== '__X__' && !isSE(b.days[i])).length, 0), 0);

await new Promise(r => server.listen(0, '127.0.0.1', r)); base = 'http://127.0.0.1:' + server.address().port;
try {
  await section('board.mjs: add, set, get, list, rollforward, delete', async () => {
    // ---- add: contacts go to event_contacts, not events
    r = await board(['add', '--name', 'Test Fair', '--start', '2026-03-06', '--end', '2026-03-07', '--json', 'phone=(928) 555-0100', 'contact=Jane Doe', 'promoter=Fair Co']);
    ok(r.code === 0, 'add exits 0: ' + r.stderr); const id = JSON.parse(r.stdout).id;
    ok(leaked().length === 0, 'add: no contact field in events');
    ok(T('event_contacts').get(id)?.phone === '(928) 555-0100', 'add: phone stored in event_contacts');
    ok(T('events').get(id)?.promoter === 'Fair Co', 'add: promoter (public) stays in events');

    // ---- set: mixed patch is split
    r = await board(['set', id, 'email=jane@example.com', 'cityState=Prescott, AZ']);
    ok(r.code === 0, 'set exits 0: ' + r.stderr);
    ok(leaked().length === 0, 'set: no contact field in events');
    ok(T('event_contacts').get(id)?.email === 'jane@example.com' && T('event_contacts').get(id)?.phone === '(928) 555-0100', 'set: email merged, phone kept');
    ok(T('events').get(id)?.cityState === 'Prescott, AZ', 'set: public field written');
    r = await board(['set', '2026-nope', 'phone=(928) 555-0101']);
    ok(r.code !== 0 && !T('event_contacts').has('2026-nope'), 'set: contact patch on a missing event is refused');

    // ---- get / list --full merge contacts back for routines; brief list does not
    r = await board(['get', id, '--json']); ok(JSON.parse(r.stdout).phone === '(928) 555-0100', 'get: contacts merged');
    r = await board(['list', '--json', '--full']); ok(JSON.parse(r.stdout)[0].contact === 'Jane Doe', 'list --full: contacts merged');
    r = await board(['list', '--json']); ok(!('phone' in JSON.parse(r.stdout)[0]), 'list (brief): no contacts');

    // ---- startDate recompute still works and clears datesEstimated
    r = await board(['set', id, 'startDate=2026-03-13']); const ev = T('events').get(id);
    ok(ev.weekend === '2026-03-13' && ev.endDate === '2026-03-14' && ev.datesEstimated === false, 'set startDate: weekend/end recomputed');

    // ---- rollforward: contacts follow the show, held-back rules hold, idempotent
    T('events').set('2026-skip', { year: 2026, name: 'Skip Show', startDate: '2026-04-03', booths: [], skipNext: true });
    T('events').set('2026-staffed', { year: 2026, name: 'Staffed Show', startDate: '2026-05-01', days: ['Friday'], booths: [{ label: '', days: ['Friday', 'Saturday SE'], shifts: [{ label: 'Shift 1', slots: [{ rep: 'Alan', ft: [] }, { rep: 'Matt A.', ft: [] }] }] }] });
    // booth spots: a Maricopa show's booth names roll as last year's spot; an unfixed one keeps the year it was for
    const bo = (label, extra = {}) => ({ label, days: ['Friday'], ...extra, shifts: [{ label: 'Shift 1', slots: [{ rep: 'Eli', ft: [] }] }] });
    T('events').set('2026-mchgs', { year: 2026, name: 'Maricopa County Home & Garden Show', startDate: '2026-10-02', days: ['Friday'],
      booths: [bo('Booth #1 (606-608)'), bo('Booth #2 (Ag Building) (820/822)', { rolledLabel: 'Booth #2 (Ag Building) (820/822)', rolledLabelYear: 2025 }), bo('')] });
    T('events').set('2026-mcfair', { year: 2026, name: 'Maricopa County Fair - WK 1', startDate: '2026-04-03', days: ['Friday'], booths: [bo('Booth #1 (Ag Building)')] });
    r = await board(['rollforward', '2027']); ok(r.code === 0, 'rollforward exits 0: ' + r.stderr);
    const mb = (T('events').get('2027-mchgs') || {}).booths || [];
    ok(mb[0]?.label === 'Booth #1 (606-608)' && mb[0]?.rolledLabel === 'Booth #1 (606-608)' && mb[0]?.rolledLabelYear === 2026, 'rollforward: a Maricopa booth name comes along, tagged as 2026\'s spot: ' + JSON.stringify(mb[0]));
    ok(mb[1]?.rolledLabelYear === 2025, 'rollforward: a name nobody fixed in 2026 is still 2025\'s spot');
    ok(mb[2] && !('rolledLabel' in mb[2]), 'rollforward: a booth with no name gets no tag');
    ok(T('events').get('2027-mcfair')?.booths[0].label === 'Booth #1 (Ag Building)' && !('rolledLabel' in T('events').get('2027-mcfair').booths[0])
      && !('rolledLabel' in T('events').get('2027-staffed').booths[0]), 'rollforward: the Maricopa County Fair and other shows keep their names, untagged');
    const rolled = '2027-' + id.replace(/^\d{4}-/, '');
    ok(T('events').has(rolled) && T('events').get(rolled).status === 'Prospective' && T('events').get(rolled).datesEstimated === true, 'rollforward: event rolled as Prospective, dates estimated');
    ok(T('event_contacts').get(rolled)?.phone === '(928) 555-0100', 'rollforward: contacts copied to the new id');
    ok(leaked().length === 0, 'rollforward: no contact field in events');
    ok(!T('events').has('2027-skip'), 'rollforward: skipNext held back');
    ok(T('events').get('2027-staffed').booths[0].shifts[0].slots.every(s => s.rep === ''), 'rollforward: shifts cleared');
    const n = T('events').size; await board(['rollforward', '2027']); ok(T('events').size === n, 'rollforward: idempotent');

    // ---- staffed: SE days never count
    T('events').set('2026-se-only', { year: 2026, name: 'SE Only', startDate: '2026-06-05', booths: [{ days: ['Friday SE'], shifts: [{ label: 'S', slots: [{ rep: 'Alan', ft: [] }] }] }] });
    r = await board(['list', '--year', '2026', '--staffed', '--json']); const staffed = JSON.parse(r.stdout).map(e => e.id);
    ok(staffed.includes('2026-staffed') && !staffed.includes('2026-se-only'), 'staffed: an SE-day-only name is not a shift');
    ok(JSON.parse(r.stdout).find(e => e.id === '2026-staffed').filled === 1, 'staffed: the SE slot on a mixed booth is not counted');

    // ---- delete removes the contact row too
    await board(['delete', id]); ok(!T('events').has(id) && !T('event_contacts').has(id), 'delete: event and its contacts removed');
  });

  await section('board.mjs: tick and seed', async () => {
    // ---- tick
    T('settings').set('division', { meetings: ['2027-01-15'] });
    const due = async d => JSON.parse((await board(['tick', '--json', '--date', d])).stdout).due.map(x => x.routine);
    const dueFullEarly = async d => JSON.parse((await board(['tick', '--json', '--date', d])).stdout).due;
    ok((await due('2027-01-08')).join() === 'date-research', 'tick: the date research 7 days before a meeting');
    ok((await due('2027-01-13')).join() === 'preflight', 'tick: the preflight 2 days before a meeting');
    ok((await dueFullEarly('2027-01-08'))[0].auto === true && (await dueFullEarly('2027-01-13'))[0].auto === true, 'tick: both run themselves (auto)');
    ok((await due('2027-01-16')).length === 0, 'tick: nothing the day after a meeting (the sweep waits a day for the picks to reach the board)');
    const dueFull = async d => JSON.parse((await board(['tick', '--json', '--date', d])).stdout).due;
    let bs = (await dueFull('2027-01-17')).find(x => x.routine === 'booking-sweep');
    ok(bs && bs.auto === true && bs.day === 2 && bs.followUp === false && bs.meeting === '2027-01-15', 'tick: the booking sweep is due two days after a meeting, and runs itself (auto)');
    bs = (await dueFull('2027-01-23')).find(x => x.routine === 'booking-sweep');
    ok(bs && bs.followUp === true && bs.day === 8, 'tick: the booking sweep follows up through day 8');
    ok((await due('2027-01-24')).length === 0, 'tick: and not on day 9');
    ok((await due('2027-01-06')).length === 0, 'tick: Wednesday is no longer "due" (the event check runs unattended at 08:00)');
    ok((await due('2027-01-14')).length === 0, 'tick: nothing on an ordinary Thursday');
    ok((await due('2027-01-17')).join() === 'booking-sweep,freshmen-roster', 'tick: freshmen roster two days after a January meeting (the sweep\'s first day too)');
    T('settings').set('division', { meetings: ['2027-04-28'] });
    ok((await due('2027-08-15')).join() === 'freshmen-roster', 'tick: freshmen roster on Aug 15 when no August meeting is on the calendar');
    T('settings').set('division', { meetings: ['2027-08-03'] });
    ok((await due('2027-08-15')).length === 0 && (await due('2027-08-05')).join() === 'booking-sweep,freshmen-roster', 'tick: with an August meeting, the reminder follows the meeting, not the fixed day');
    ok((await due('2026-12-28')).length === 0, 'tick: no Dec 28 changeover reminder (the board has followed the Jan-May book since 2026-10-23)');
    T('settings').set('division', { meetings: ['2027-01-15'] });
    ok((await due('2027-01-12')).join() === 'handover-preview' && (await due('2027-01-11')).length === 0, 'tick: the day before the books hand over (config sheets handover.on), preview that sync');
    T('settings').set('division', { meetings: ['2027-01-15'] });

    // ---- seed: refuses a public seed that carries contacts; the real seed is clean
    const real = JSON.parse(fs.readFileSync(path.join(REPO, 'seed/events.json'), 'utf8'));
    ok(real.filter(e => PRIV.some(k => e[k] && String(e[k]).trim())).length === 0, 'seed/events.json carries no contact fields');
    for (const t of Object.keys(db)) db[t].clear();
    r = await board(['seed']); ok(r.code === 0 && T('events').size === real.length, 'seed: loads the public seed: ' + r.stderr.slice(-200));
    ok(leaked().filter(d => PRIV.some(k => d[k])).length === 0, 'seed: no contact values in events');
    if (fs.existsSync(path.join(REPO, 'seed/private/event_contacts.json'))) ok(T('event_contacts').size > 0, 'seed: private contacts loaded when the file exists');

    // ---- seed never empties a field the database has filled. seed/settings.json ships
    // meetings: [] because the dates live in seed/private/go-live.md and this repo is public;
    // a plain upsert wiped them, and tick.py would then never report preflight due.
    T('settings').set('division', { ...T('settings').get('division'), meetings: ['2027-01-15'], name: 'Hand-edited Division' });
    r = await board(['seed', '--force']);
    ok(r.code === 0, 'seed --force exits 0: ' + r.stderr.slice(-200));
    ok(JSON.stringify(T('settings').get('division').meetings) === '["2027-01-15"]', 'seed: keeps meeting dates the seed file does not carry');
    ok(T('settings').get('division').name === 'Rising Sun Division', 'seed: a filled field in the seed still overwrites the database');
    ok(/kept \d+ field/.test(r.stderr), 'seed: says out loud which fields it kept');
    ok((await due('2027-01-08')).join() === 'date-research', 'seed: tick still reports the date research due afterwards');
  });

  await section('board.mjs: kiosks (the Kiosk Schedule tab)', async () => {
    const seed = JSON.parse(fs.readFileSync(path.join(REPO, 'seed/kiosks.json'), 'utf8'));
    // ---- the public seed: one shift per mall per day, inside the mall's own dates, nothing private
    ok(seed.every(k => k.id.startsWith(k.year + '-') && k.name && k.startDate <= k.endDate), 'kiosks seed: every mall has a YYYY- id, a name and its dates in order');
    ok(seed.every(k => Object.entries(k.shifts || {}).every(([d, s]) => d >= k.startDate && d <= k.endDate && typeof s.rep === 'string' && s.rep)), 'kiosks seed: every shift sits inside its mall\'s dates and names someone (or __X__ = closed)');
    ok(seed.every(k => !PRIV.some(p => p in k)), 'kiosks seed: no contact fields');
    ok(seed.filter(k => k.year === 2026).every(k => k.status === 'Prospective' && k.shifts['2026-12-25']?.rep === '__X__'), 'kiosks seed: 2026 malls start Prospective, Christmas closed');
    ok(!seed.some(k => /park-place/.test(k.id)) && seed.some(k => k.id === '2026-kierland'), 'kiosks seed: no Park Place in any season; Kierland in 2026, Prospective (Alan, 2026-10-14)');
    ok(seed.find(k => k.id === '2026-arrowhead').costNum === 7300 && seed.find(k => k.id === '2026-chandler-fashion-center').costNum === 7000, 'kiosks seed: 2026 Arrowhead $7,300, Chandler $7,000 (Alan, 2026-10-14)');
    ok(seed.every(k => k.cost === '' ? k.costNum == null : +k.cost.replace(/[$,]/g, '') === k.costNum), 'kiosks seed: every cost carries its number, and they agree');

    // ---- kiosks seed adds what is missing and never touches a mall the board already has
    T('kiosks').clear();
    r = await board(['kiosks', 'seed']); ok(r.code === 0 && T('kiosks').size === seed.length, 'kiosks seed: loads every mall into an empty table: ' + r.stderr);
    const ah = T('kiosks').get('2026-arrowhead');
    T('kiosks').set('2026-arrowhead', { ...ah, status: 'Booked', shifts: { ...ah.shifts, '2026-11-27': { rep: 'Cameron' } } });
    T('kiosks').delete('2026-kierland');
    r = await board(['kiosks', 'seed']);
    ok(r.code === 0 && /added 1\b/.test(r.stdout), 'kiosks seed: adds only the missing mall: ' + r.stdout);
    ok(T('kiosks').get('2026-arrowhead').status === 'Booked' && T('kiosks').get('2026-arrowhead').shifts['2026-11-27'].rep === 'Cameron', 'kiosks seed: an edited mall is left as the board has it');

    // ---- list: staffed and open days per mall
    r = await board(['kiosks', '--year', '2026', '--json', '--date', '2026-11-01']); const l = JSON.parse(r.stdout);
    ok(l.length === 5 && l.every(k => k.year === 2026), 'kiosks: --year lists that season only');
    const a = l.find(k => k.id === '2026-arrowhead');
    ok(a && a.staffed === 1 && a.open === 29 && a.reps.join() === 'Cameron', 'kiosks: a booked mall counts staffed and open days, and Christmas (closed) is neither');
    ok(a && a.cost === 7300 && a.perDays === 30 && a.perDay === 243.33, 'kiosks: cost per day before the season = the cost over the 30 days not closed: ' + JSON.stringify(a && [a.cost, a.perDay, a.perDays]));
    ok(l.find(k => k.id === '2026-kierland')?.open === 0, 'kiosks: a Prospective mall has no open shifts');
    r = await board(['kiosks', '--year', '2025', '--json']); const c = JSON.parse(r.stdout).find(k => k.id === '2025-chandler-fashion-center');
    ok(c && c.staffed === 30 && c.reps.includes('J. Parker'), 'kiosks: 2025 Chandler, 30 staffed days, as the mall sheet had them');
    const sv = JSON.parse(r.stdout).find(k => k.id === '2025-sierra-vista');
    ok(sv && sv.perDay === 31.25 && sv.perDays === 16, 'kiosks: a season that is over spreads its cost over the days worked (Sierra Vista 2025: $500 / 16 = $31.25, as the sheet had it)');
  });

  await section('deploy/tick.py', async () => {
    // ---- deploy/tick.py --dry: decides and prints, never sends. HOME is the temp dir, so it reads a fake board.env.
    // The launcher runs from a staged copy: tick.py takes its root from where it sits, so the stage has its own
    // PAUSED, logs/ and .git, and the real repo's kill switch or a dirty tree cannot reach these tests.
    fs.mkdirSync(path.join(home, '.rsd'), { recursive: true });
    fs.writeFileSync(path.join(home, '.rsd', 'board.env'), `BOARD_SUPABASE_URL=${base}\nBOARD_SERVICE_KEY=test\nBOARD_ALAN_IMESSAGE=+15555550100\n`);
    T('settings').set('division', { meetings: ['2027-01-15'] });
    for (const f of ['deploy/tick.py', 'scripts/board.mjs', 'scripts/lib/roster-sync.mjs', 'config/event-check.json', '.gitignore']) { fs.mkdirSync(path.dirname(path.join(stage, f)), { recursive: true }); fs.copyFileSync(path.join(REPO, f), path.join(stage, f)); }
    fs.writeFileSync(path.join(stage, 'ROSTER-PAUSED'), '');     // these blocks are about the due list; the roster step has its own block
    const tickpy = (...a) => run('/usr/bin/python3', ['-B', path.join(stage, 'deploy/tick.py'), '--dry', ...a]);
    r = await tickpy('--date', '2027-01-17');
    ok(r.code === 0 && /WOULD POST TO SLACK/.test(r.stdout) && /WOULD iMESSAGE ALAN/.test(r.stdout) && /training sign-in sheet/.test(r.stdout), 'tick.py --dry: a due routine produces one Slack + one iMessage notice: ' + r.stderr);
    r = await tickpy('--date', '2027-01-08');
    ok(r.code === 0 && /due, runs itself: date-research/.test(r.stdout) && !/WOULD/.test(r.stdout), 'tick.py --dry: the date research runs itself, no notice: ' + r.stdout);
    r = await tickpy('--date', '2027-01-14');
    ok(r.code === 0 && /nothing due/.test(r.stdout) && !/WOULD/.test(r.stdout), 'tick.py --dry: nothing due means no notices');
    r = await tickpy('--date', '2027-01-20');
    ok(r.code === 0 && /due, runs itself: booking-sweep/.test(r.stdout) && !/WOULD/.test(r.stdout), 'tick.py --dry: a routine that runs itself (the booking sweep) is logged, never a "go run it" notice: ' + r.stdout);
    r = await tickpy('--date', '2027-01-17');
    ok(r.code === 0 && /WOULD iMESSAGE ALAN/.test(r.stdout) && /training sign-in sheet/.test(r.stdout) && !/booking sweep/.test(r.stdout.split('WOULD iMESSAGE ALAN')[1] || ''), 'tick.py --dry: on the sweep\'s first day the notice is only the freshmen sheet: ' + r.stdout);

    // ---- a real (not --dry) run, with slack() and imessage_alan() swapped for printers before main() starts, so the
    // pull and the log are exercised and nothing is sent. The guard on subprocess.run is the backstop: whatever tick.py
    // grows into, a process rooted in node never reaches Messages.app or the Keychain (messages-tcc.md).
    const REAL = `import subprocess, sys
sys.path.insert(0, ${JSON.stringify(path.join(stage, 'deploy'))})
real_run = subprocess.run
def guarded(cmd, *a, **k):
      assert cmd[0] not in ('/usr/bin/osascript', '/usr/bin/security'), 'a test reached for Messages or the Keychain'
      return real_run(cmd, *a, **k)
subprocess.run = guarded
import tick
assert callable(tick.slack) and callable(tick.imessage_alan)
tick.slack = lambda text: print('SLACK: ' + text) or True
tick.imessage_alan = lambda text, env: print('IMESSAGE: ' + text) or (True, 'fake')
sys.exit(tick.main())
`;
    const tickreal = async (...a) => { fs.rmSync(tickLog, { force: true }); const o = await run('/usr/bin/python3', ['-B', '-c', REAL, ...a]); return { ...o, log: fs.existsSync(tickLog) ? fs.readFileSync(tickLog, 'utf8') : '' }; };
    const git = (...a) => run('/usr/bin/git', ['-C', stage, '-c', 'user.name=test', '-c', 'user.email=test@example.com', ...a]);
    const count = (s, re) => (s.match(re) || []).length;

    // the kill switch, on a day a routine IS due: one log line, exit 0, nothing decided, nothing sent
    fs.writeFileSync(path.join(stage, 'PAUSED'), '');
    r = await tickreal('--date', '2027-01-08');
    ok(r.code === 0 && /PAUSED file present: doing nothing/.test(r.log) && count(r.log, /\n/g) === 1 && r.stdout === '', 'tick.py: PAUSED present logs one line, exits 0, sends no notices: ' + r.stderr + r.stdout);
    r = await tickpy('--date', '2027-01-08');
    ok(r.code === 0 && /PAUSED file present: doing nothing/.test(r.stdout) && !/WOULD/.test(r.stdout), 'tick.py --dry: PAUSED present means no notices either');
    fs.rmSync(path.join(stage, 'PAUSED'));

    // the pull: a skipped or failed one means stale code on the mini, so it alerts; the two harmless skips do not
    r = await tickreal('--date', '2027-01-14');
    ok(r.code === 0 && /not a git checkout/.test(r.log) && /nothing due/.test(r.log) && r.stdout === '', 'tick.py: not a git checkout is no alert: ' + r.stderr + r.stdout);
    await git('init', '-q');
    r = await tickreal('--date', '2027-01-14');
    ok(r.code === 0 && /no remote yet/.test(r.log) && r.stdout === '', 'tick.py: no remote yet is no alert: ' + r.stderr + r.stdout);
    await git('init', '-q', '--bare', path.join(home, 'origin.git')); await git('remote', 'add', 'origin', path.join(home, 'origin.git'));
    await git('add', '-A'); await git('commit', '-q', '-m', 'stage'); r = await git('push', '-q', '-u', 'origin', 'HEAD');
    ok(r.code === 0, 'stage: a clean checkout with a remote to pull from: ' + r.stderr);
    r = await tickreal('--date', '2027-01-14');
    ok(r.code === 0 && /— pulled: /.test(r.log) && r.stdout === '', 'tick.py: a clean pull is no alert (and logs/ does not dirty the tree): ' + r.log + r.stdout);

    fs.writeFileSync(path.join(stage, 'stray.txt'), 'left behind by some other tool');
    r = await tickreal('--date', '2027-01-14');
    ok(r.code === 0 && count(r.stdout, /^SLACK: /gm) === 1 && /AUTOMATION FAILURE/.test(r.stdout) && /tree is dirty, pull skipped: \?\? stray\.txt/.test(r.stdout) && r.stdout.includes(stage), 'tick.py: a dirty tree posts one Slack alert naming the repo and the path: ' + r.stdout + r.stderr);
    ok(/tree is dirty/.test(r.log) && /nothing due/.test(r.log), 'tick.py: a dirty tree is not fatal, the tick still decides');
    r = await tickreal('--date', '2027-01-17');
    ok(r.code === 0 && count(r.stdout, /^SLACK: /gm) === 2 && count(r.stdout, /^IMESSAGE: /gm) === 1 && /training sign-in sheet/.test(r.stdout), 'tick.py: a dirty tree on a due day sends the alert and still the due notice: ' + r.stdout + r.stderr);
    r = await tickpy('--date', '2027-01-14');
    ok(r.code === 0 && /nothing due/.test(r.stdout) && !/WOULD/.test(r.stdout), 'tick.py --dry: a dirty tree sends nothing, --dry pulls nothing');
    fs.rmSync(path.join(stage, 'stray.txt'));

    await git('remote', 'set-url', 'origin', path.join(home, 'gone.git'));
    r = await tickreal('--date', '2027-01-14');
    ok(r.code === 0 && count(r.stdout, /^SLACK: /gm) === 1 && /could not update its code: PULL FAILED: .*gone\.git/.test(r.stdout) && r.stdout.includes(stage), 'tick.py: a failed pull posts one Slack alert with git\'s reason: ' + r.stdout + r.stderr);
    ok(/PULL FAILED/.test(r.log) && /nothing due/.test(r.log), 'tick.py: a failed pull is not fatal, the tick still decides');

    // the net under main(): an exception nobody planned for is a loud failure, not a traceback only launchd.log sees
    await git('remote', 'set-url', 'origin', path.join(home, 'origin.git'));   // a clean pull again, so one failure is one alert
    fs.chmodSync(path.join(home, '.rsd', 'board.env'), 0o000);
    r = await tickreal('--date', '2027-01-14');
    ok(r.code === 1 && count(r.stdout, /^SLACK: /gm) === 1 && /AUTOMATION FAILURE.*unexpected PermissionError in read_env\(\), tick\.py line \d+/.test(r.stdout) && /launchd\.log/.test(r.stdout), 'tick.py: an unexpected exception posts one Slack alert naming the function and line, exit 1: ' + r.stdout);
    ok(/FAILED: unexpected PermissionError/.test(r.log) && /Traceback/.test(r.stderr), 'tick.py: an unexpected exception is logged, and the full trace goes to stderr');
    r = await tickpy('--date', '2027-01-14');
    ok(r.code === 1 && count(r.stdout, /WOULD POST TO SLACK/g) === 1 && /unexpected PermissionError/.test(r.stdout), 'tick.py --dry: an unexpected exception is reported, still nothing sent');
    fs.chmodSync(path.join(home, '.rsd', 'board.env'), 0o600);
    fs.rmSync(tickLog, { force: true }); fs.chmodSync(path.dirname(tickLog), 0o500);
    r = await tickreal('--date', '2027-01-14');
    ok(r.code === 1 && count(r.stdout, /^SLACK: /gm) === 1 && /unexpected PermissionError in log\(\)/.test(r.stdout) && r.log === '', 'tick.py: when the log is what broke, the Slack alert still goes out: ' + r.stdout);
    fs.chmodSync(path.dirname(tickLog), 0o700);

    // ---- channels, not texts to Alan (2026-10-07): with slackroom on the machine the due notice is one message in
    // #rsd-board that names him, and no iMessage; alerts go to #rsd-alerts. A pretend slackroom in the temp HOME
    // records what it was handed. Only imessage_alan() is swapped here: slack() itself is under test.
    const roomDir = path.join(home, 'ai-system', 'lib', 'slackroom'), roomPosts = path.join(roomDir, 'posts.jsonl');
    fs.mkdirSync(roomDir, { recursive: true });
    fs.writeFileSync(path.join(roomDir, 'slackroom.py'), `import json, os
HERE = os.path.dirname(os.path.abspath(__file__))
def _cfg():
    try:
        return json.load(open(os.path.join(HERE, "box.json")))
    except Exception:
        return {}
def live(route):
    return route in _cfg().get("live", [])
def resolve(route):
    return {"live": live(route), "why": "not set up (test)"}
def post(route, text, mention=None, fallback=True, **k):
    ok = route not in _cfg().get("fail", [])
    with open(os.path.join(HERE, "posts.jsonl"), "a") as f:
        f.write(json.dumps({"route": route, "text": text, "mention": mention, "fallback": fallback}) + "\\n")
    return {"ok": ok, "via": "route" if ok else None, "error": None if ok else "channel_not_found"}
`);
    const roomSays = cfg => { fs.writeFileSync(path.join(roomDir, 'box.json'), JSON.stringify(cfg)); fs.rmSync(roomPosts, { force: true }); };
    const roomGot = () => (fs.existsSync(roomPosts) ? fs.readFileSync(roomPosts, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);
    const ROOMED = REAL.replace("tick.slack = lambda text: print('SLACK: ' + text) or True\n", '');
    const tickroom = async (...a) => { fs.rmSync(tickLog, { force: true }); const o = await run('/usr/bin/python3', ['-B', '-c', ROOMED, ...a]); return { ...o, log: fs.existsSync(tickLog) ? fs.readFileSync(tickLog, 'utf8') : '' }; };
    roomSays({ live: ['rsd.board'] });
    r = await tickroom('--date', '2027-01-17');
    let got = roomGot();
    ok(r.code === 0 && got.length === 1 && got[0].route === 'rsd.board' && got[0].mention === true && got[0].fallback === false && /Due today, waiting on you/.test(got[0].text) && /training sign-in sheet/.test(got[0].text),
      'tick.py: #rsd-board live, a due routine is one message there, naming Alan, strict: ' + JSON.stringify(got) + r.stderr);
    ok(!/IMESSAGE: /.test(r.stdout) && /due list posted in #rsd-board/.test(r.log), 'tick.py: #rsd-board live, no iMessage goes to Alan: ' + r.stdout);
    r = await tickpy('--date', '2027-01-17');
    ok(r.code === 0 && /WOULD POST IN #rsd-board/.test(r.stdout) && !/WOULD iMESSAGE ALAN/.test(r.stdout) && roomGot().length === 1, 'tick.py --dry: #rsd-board live, it says so and posts nothing');
    roomSays({ live: [] });
    r = await tickroom('--date', '2027-01-17');
    got = roomGot();
    ok(r.code === 0 && got.length === 1 && got[0].route === 'rsd.alerts' && got[0].fallback === true && /Due today/.test(got[0].text) && count(r.stdout, /^IMESSAGE: /gm) === 1,
      'tick.py: #rsd-board not live, the notice goes the old way (the alert route and an iMessage): ' + JSON.stringify(got) + r.stdout);
    roomSays({ live: ['rsd.board'], fail: ['rsd.board'] });
    r = await tickroom('--date', '2027-01-17');
    got = roomGot();
    ok(r.code === 0 && got.map(g => g.route).join() === 'rsd.board,rsd.alerts' && count(r.stdout, /^IMESSAGE: /gm) === 1 && /SLACK FAILED \(#rsd-board: channel_not_found\); notifying the old way/.test(r.log),
      'tick.py: #rsd-board live but Slack refuses it, the old notice goes instead, so a due routine is never left unseen: ' + JSON.stringify(got) + r.log);
    roomSays({ live: ['rsd.board'] });
    r = await tickroom('--date', '2027-01-14');
    ok(r.code === 0 && roomGot().length === 0 && /nothing due/.test(r.log), 'tick.py: nothing due posts nothing in any channel');
    fs.rmSync(path.join(home, 'ai-system'), { recursive: true, force: true });

    fs.writeFileSync(path.join(home, '.rsd', 'board.env'), 'BOARD_SUPABASE_URL=\n');
    r = await tickpy(); ok(r.code === 1 && /AUTOMATION FAILURE/.test(r.stdout), 'tick.py --dry: missing env is a loud failure, exit 1');
    fs.rmSync(path.join(home, '.rsd'), { recursive: true, force: true });
  });

  // ---- parse-sheet: the Sheet's shape, read the way the 2026-09-13 migration read it.
  // A synthetic grid, because the real schedule is 800 rows of promoter contacts and cannot live
  // in a public repo. The real check is `parse-sheet.mjs <xlsx> --verify` against seed/events.json.
  await section('parse-sheet', async () => {
    const G = [];
    const row = o => { const r = new Array(27).fill(null); for (const [i, v] of Object.entries(o)) r[+i] = v; G.push(r); };
    const SER = d => Math.round((Date.parse(d + 'T00:00:00Z') - Date.UTC(1899, 11, 30)) / 86400000);
    row({ 2: 'Status', 4: 'HEADER ROW IS SKIPPED' });                       // row 1
    row({ 1: 'Weekend 09-04' });                                            // row 2
    row({ 1: 'JV', 2: 'Booked', 3: '17k', 4: 'Corn Fest', 5: 'Saturday', 6: 'Sunday', 7: 'Monday SE',
          12: '166.66', 13: SER('2026-09-05'), 14: SER('2026-09-06'), 15: 'Phoenix, AZ', 16: 'The Park',
          18: 'Corn Co', 19: 'Rich', 20: '(602) 555-0100', 21: 'rich@example.com', 22: 'corn.example.com',
          25: 'Booked', 26: '00101800' });                                  // row 3
    row({ 4: 'Shift 1', 5: 'Cam (Ft. Reed & Jo)', 6: '(ft. Chris)', 7: 'Eli' });   // row 4
    row({ 4: 'Shift 2', 5: 'x', 6: 'Matt A' });                             // row 5
    row({ 2: 'Prospective', 4: 'Stale Dates Fair', 5: 'Saturday', 6: 'Sunday (SE)', 7: '45318',
          12: '100', 13: SER('2025-09-06'), 14: SER('2025-09-07') });       // row 6 — start a year out
    row({ 4: 'Shift 1', 5: 'JP' });                                         // row 7
    row({ 2: 'Booked', 4: 'Mesa Market Place Swapmeet A ROW', 5: 'Friday', 6: 'Saturday', 12: '2089' }); // row 8
    row({ 4: 'Shift 1', 5: 'Kendall' });                                    // row 9
    row({ 2: 'Booked', 4: 'Mesa Market Place Swapmeet B ROW', 5: 'Friday', 6: 'Saturday', 12: '2089' }); // row 10
    row({ 4: 'Shift 1', 6: 'Sarah' });                                      // row 11
    const gridFile = path.join(home, 'grid.json');
    fs.writeFileSync(gridFile, JSON.stringify(G));

    const ps = (...a) => new Promise(res => execFile(process.execPath, [path.join(REPO, 'scripts/parse-sheet.mjs'), '--grid', gridFile, '--tab', '2026', ...a],
      { env: { PATH: process.env.PATH, HOME: home } }, (err, stdout, stderr) => res({ code: err ? err.code : 0, stdout, stderr })));

    r = await ps('--json');
    ok(r.code === 0, 'parse-sheet: exits 0: ' + r.stderr);
    const ev = JSON.parse(r.stdout);
    ok(ev.length === 3, `parse-sheet: header row is not an event, Mesa A/B merge into one (got ${ev.length})`);

    const corn = ev[0];
    ok(corn.name === 'Corn Fest' && corn.weekend === '2026-09-04', 'parse-sheet: event row and weekend banner');
    ok(corn.days.join('|') === 'Saturday|Sunday|Monday SE', 'parse-sheet: day labels come off the event row');
    ok(corn.dates.join('|') === '2026-09-05|2026-09-06|2026-09-07', 'parse-sheet: dates step from the banner, SE day included');
    ok(corn.cost === '$167' && corn.costNum === 167, 'parse-sheet: cost rounds to whole dollars');
    ok(corn.level === 'JV' && corn.vcNumber === '00101800', 'parse-sheet: level and VC number');
    ok(corn.phone === '(602) 555-0100' && corn.email === 'rich@example.com', 'parse-sheet: contact block read straight when it is straight');
    const s1 = corn.booths[0].shifts[0].slots, s2 = corn.booths[0].shifts[1].slots;
    ok(s1[0].rep === 'Cam' && s1[0].ft.join(',') === 'Reed,Jo', 'parse-sheet: "(Ft. X & Y) Rep" keeps the rep and the trainees');
    ok(s1[1].rep === '' && s1[1].ft.join(',') === 'Chris', 'parse-sheet: helper-only cell is not a staffed shift');
    ok(s2[0].rep === '__X__', 'parse-sheet: an x is a closed slot, not a rep');
    ok(s1[2].rep === 'Eli', 'parse-sheet: the SE-day cell is still read into the slot');
    ok(staffedOf(corn) === 2, `parse-sheet: Cam and Matt A are the shifts — Eli's SE day is not one (got ${staffedOf(corn)})`);

    const stale = ev[1];
    ok(stale.dates[0] === '2026-09-05', 'parse-sheet: a Start Date a year out does not move the dates off the banner');
    ok(stale.dates[1] === null, 'parse-sheet: a day label with a parenthetical gets no date');
    ok(stale.days[2] === '1/27/2024' && stale.dates[2] === null, 'parse-sheet: a day cell holding a date stays a label, undated');

    const mesa = ev[2];
    ok(mesa.name === 'Mesa Market Place Swapmeet' && mesa.booths.length === 2, 'parse-sheet: Mesa A/B is one event with two booths');
    ok(mesa.booths[0].label === 'A Row' && mesa.booths[1].label === 'B Row', 'parse-sheet: the two Mesa rows keep their row labels');
    ok(mesa.costBasis === 'month' && String(mesa.mergedRows) === '8,10', 'parse-sheet: Mesa bills by the month, and says which rows it merged');

    // the drift guard: a structural field that moves on most events is the parser, not the Sheet
    const asSeed = evs => evs.map((e, i) => ({ ...e, id: `t-${i}` }));
    const seedOk = path.join(home, 'seed-ok.json');
    fs.writeFileSync(seedOk, JSON.stringify(asSeed(ev)));
    r = await ps('--verify', '--seed', seedOk);
    ok(r.code === 0 && /cityState   differs on    0/.test(r.stdout), 'parse-sheet --verify: a faithful parse differs on nothing: ' + r.stdout.slice(0, 200));

    const seedDrift = path.join(home, 'seed-drift.json');
    fs.writeFileSync(seedDrift, JSON.stringify(asSeed(ev).map(e => ({ ...e, cityState: 'MOVED' }))));
    r = await ps('--verify', '--seed', seedDrift);
    ok(r.code === 2 && /cityState/.test(r.stderr), 'parse-sheet --verify: exits 2 and names the field when a structural field drifts');

    // a rep the roster cannot place must be named, never passed through quietly
    const seedAlias = path.join(home, 'seed-alias.json');
    fs.writeFileSync(seedAlias, JSON.stringify(asSeed(ev)));
    r = await ps('--verify', '--seed', seedAlias);
    ok(!/reps the roster cannot place/.test(r.stdout), 'parse-sheet --verify: Cam, JP and Matt A all resolve to the roster');
  });

  await section('parse-sheet: booth names typed in column B (Maricopa Summer, the May-Sept book)', async () => {
    const { parseAll } = await import(path.join(REPO, 'scripts/parse-sheet.mjs'));
    const G = [], row = o => { const r = new Array(27).fill(null); for (const [i, v] of Object.entries(o)) r[+i] = v; G.push(r); };
    row({ 4: 'HEADER' });
    row({ 1: 'Weekend 07-17' });
    row({ 1: 'Invite Only', 2: 'Booked', 4: 'Maricopa County Summer Home & Landscape Show', 5: 'Friday', 6: 'Saturday', 7: 'Sunday', 12: '7100' });
    row({ 1: 'Booth #301-303', 4: 'Shift 1', 5: 'Alan', 6: 'Alan', 7: 'Adam C.' });
    row({ 4: 'Shift 2', 5: 'Jason', 6: 'Jason', 7: 'Jason' });
    row({});
    row({ 1: 'Booth #421-423', 4: 'Shift 1', 5: 'Matt', 6: 'Matt', 7: 'Matt' });
    row({ 4: 'Shift 2', 5: 'JP', 6: 'Luke', 7: 'Luke' });
    row({ 1: 'Elite', 4: 'Maricopa County Home & Flower Show', 5: 'Friday', 6: 'Saturday', 12: '7000' });
    row({ 4: 'Booth #1 (10x10 Corner) #1038' });
    row({ 1: 'Booth #1 (10x10 Corner) #1038', 4: 'Shift 1', 5: 'Foss', 6: 'Foss' });    // column B repeats the booth row above
    row({ 4: 'Shift 2', 5: 'Adam C', 6: 'Adam C' });
    row({ 4: 'Booth #2 (10x10 Corner) #520' });
    row({ 1: 'Booth #2 (10x10 Corner)', 4: 'Shift 1', 5: 'Luke', 6: 'Luke' });
    row({ 2: 'Booked', 4: 'Plain Fair', 5: 'Saturday', 12: '100' });
    row({ 4: 'Shift 1', 5: 'Eli' });
    const ev = parseAll(G, { seasonYear: 2027, seasonStartMonth: 5 }).events;
    const [sum, flower, plain] = ev, lab = e => e.booths.map(b => `${b.label}=${b.shifts.map(s => s.slots[0].rep).join('+')}`).join(' | ');
    ok(ev.length === 3 && lab(sum) === 'Booth #301-303=Alan+Jason | Booth #421-423=Matt+JP', 'column B "Booth ..." on a shift row starts a named booth: ' + lab(sum));
    ok(lab(flower) === 'Booth #1 (10x10 Corner) #1038=Foss+Adam C | Booth #2 (10x10 Corner) #520=Luke', 'under a booth row, column B only repeats it (no extra booth, the fuller name kept): ' + lab(flower));
    ok(lab(plain) === '=Eli', 'a show with no booth names still has its one unnamed booth');
  });

  await section('lib/booth-spots.mjs, and the page\'s copy of it', async () => {
    const S = await import(path.join(REPO, 'scripts/lib/booth-spots.mjs'));
    const cfg = JSON.parse(fs.readFileSync(path.join(REPO, 'config/event-check.json'), 'utf8')).boothSpots;
    const names = ['Maricopa County Home & Garden Show', 'Maricopa County Summer Home & Landscape Show', 'Maricopa County Fair - WK 1', 'maricopa county fair', 'Maricopan Days', 'Phoenix Home Show', ''];
    ok(names.map(n => S.spotShow(n, cfg)).join() === 'true,true,false,false,false,false,false', 'spotShow: the Maricopa home shows, not the Maricopa County Fair, whole words only');
    const b = { label: 'Booth #2 (Ag Building) (820/822)' };
    ok(JSON.stringify(S.rollSpot(b, 2026)) === JSON.stringify({ rolledLabel: b.label, rolledLabelYear: 2026 }) && JSON.stringify(S.rollSpot({ label: ' ' }, 2026)) === '{}', 'rollSpot: tags a named booth with the year it is rolled from, never an unnamed one');
    ok(S.rollSpot({ ...b, rolledLabel: b.label, rolledLabelYear: 2025 }, 2026).rolledLabelYear === 2025 && S.rollSpot({ ...b, rolledLabel: 'Booth #2 (old)', rolledLabelYear: 2025 }, 2026).rolledLabelYear === 2026, 'rollSpot: an unfixed name keeps its year; a fixed one is this year\'s');
    ok(S.lastYearsSpot({ label: 'X ', rolledLabel: 'X' }) && !S.lastYearsSpot({ label: 'Y', rolledLabel: 'X' }) && !S.lastYearsSpot({ label: 'X' }) && !S.lastYearsSpot(null), 'lastYearsSpot: only while the name still says what was rolled');
    const kept = S.keepSpotTags([{ label: 'X' }, { label: 'Z' }, { label: 'Y', rolledLabel: 'Y', rolledLabelYear: 2024 }], [{ label: 'X', rolledLabel: 'X', rolledLabelYear: 2026 }, { label: 'Q', rolledLabel: 'Z', rolledLabelYear: 2026 }]);
    ok(kept[0].rolledLabelYear === 2026 && !('rolledLabel' in kept[1]) && kept[2].rolledLabelYear === 2024, 'keepSpotTags: a rebuilt booth still named as rolled keeps its tag; a fixed one does not get it back');
    // the page keeps its own copy (it cannot read config): run that block by itself and hold it to the same answers
    const html = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');
    const m = html.match(/\/\* booth-spots:start[\s\S]*?\*\/([\s\S]*?)\/\* booth-spots:end \*\//);
    ok(!!m, 'index.html: the booth-spots block is marked');
    const P = new Function(m[1] + '\nreturn { spotShow, lastYearsSpot, rollSpot, spotTag, unspot };')();
    ok(names.every(n => P.spotShow(n) === S.spotShow(n, cfg)), 'index.html spotShow agrees with config boothSpots on every name');
    ok(JSON.stringify(P.rollSpot({ ...b, rolledLabel: b.label, rolledLabelYear: 2025 }, 2026)) === JSON.stringify(S.rollSpot({ ...b, rolledLabel: b.label, rolledLabelYear: 2025 }, 2026)), 'index.html rollSpot agrees with the lib');
    ok(/2026's spot/.test(P.spotTag({ label: 'X', rolledLabel: 'X', rolledLabelYear: 2026 })) && P.spotTag({ label: 'Y', rolledLabel: 'X', rolledLabelYear: 2026 }) === ''
      && /Last year's spot/.test(P.spotTag({ label: 'X', rolledLabel: 'X', rolledLabelYear: '<b>' })), 'index.html: the tag shows while unfixed, says the year, and never prints a stored value that is not a year');
    const u = { label: 'X', rolledLabel: 'X', rolledLabelYear: 2026 }; P.unspot(u);
    ok(JSON.stringify(u) === '{"label":"X"}', 'index.html unspot: "same spot this year" drops the tag, keeps the name');
    ok(/const spot=spotShow\(e\.name\)\?b=>rollSpot\(b,yearOf\(e\)\)/.test(html), 'index.html: Roll forward tags the Maricopa shows\' booth names');
    ok(/source:'board',madeBy:/.test(html), 'index.html: every database row is editable as a board show, whatever made it (the 166 Sheet-sync shows were read-only)');
  });

  await section('application dates: lib/app-dates.mjs, the page\'s copy, board set, the roll, the research', async () => {
    const A = await import(path.join(REPO, 'scripts/lib/app-dates.mjs'));
    const html = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');
    const m = html.match(/\/\* app-dates:start[\s\S]*?\*\/([\s\S]*?)\/\* app-dates:end \*\//);
    ok(!!m, 'index.html: the app-dates block is marked');
    const P = new Function(m[1] + '\nreturn { APP_DATES, SUBMISSION_MAX, appSrc, rollAppDates, appTag };')();
    ok(P.APP_DATES.map(x => x[0]).join() === A.APP_DATES.map(x => x[0]).join() && P.SUBMISSION_MAX === A.SUBMISSION_MAX, 'index.html: the same two dates and the same 350-character limit as the lib');
    const research = { kind: 'research', url: 'https://www.fairtest.org/vendors', quote: 'Applications due January 15', checked: '2026-10-26' };
    const cases = [
      { year: 2026, applyBy: '2026-01-15', applyBySource: research, applyOpens: '2025-10-01', applyOpensSource: { kind: 'manual', by: 'Matt Foss', at: '2026-10-20' } },
      { year: 2026, applyBy: '2026-01-15', applyBySource: { kind: 'rolled', from: '2024-01-16', fromYear: 2024 }, applyOpens: '' },
      { year: 2024, applyBy: '2024-02-29', applyOpens: 'soon' },
      { year: 2026, applyBy: '2026-01-15', applyBySource: { kind: 'odd' } },
    ];
    for (const [i, c] of cases.entries()) for (const Y of [2027, 2028, 2030])
      ok(JSON.stringify(P.rollAppDates(c, Y, c.year)) === JSON.stringify(A.rollAppDates(c, Y, c.year)), `index.html rollAppDates agrees with the lib (case ${i}, into ${Y})`);
    const r1 = A.rollAppDates(cases[0], 2027, 2026), r2 = A.rollAppDates(cases[1], 2027, 2026), r3 = A.rollAppDates(cases[2], 2025, 2024);
    ok(r1.applyBy === '2027-01-15' && r1.applyBySource.kind === 'rolled' && r1.applyBySource.from === '2026-01-15' && r1.applyBySource.fromYear === 2026 && r1.applyOpens === '2026-10-01',
      'rollAppDates: last year\'s dates come along a year on, tagged with the date they came from (Alan, 2026-10-26: a good estimate)');
    ok(r2.applyBy === '2027-01-16' && r2.applyBySource.from === '2024-01-16' && r2.applyOpens === '' && r2.applyOpensSource === null, 'rollAppDates: an estimate nobody confirmed keeps its real date and year; a blank stays blank');
    ok(r3.applyBy === '2025-02-28' && r3.applyOpens === '', 'rollAppDates: Feb 29 lands on Feb 28; a value that is not a date is not carried');
    ok(A.rollAppDates({ applyBy: '2020-01-10' }, 2027, 2020).applyBy === '', 'rollAppDates: a date more than three years old is not carried');
    const tagR = P.appTag(cases[0], 'applyBy'), tagM = P.appTag(cases[0], 'applyOpens'), tagE = P.appTag({ year: 2027, ...r1 }, 'applyBy'), tag2 = P.appTag({ year: 2026, ...cases[1] }, 'applyBy');
    ok(/Research · <a href="https:\/\/www\.fairtest\.org\/vendors"[^>]*>fairtest\.org<\/a> · checked Oct 26/.test(tagR) && /Applications due January 15/.test(tagR), 'the page: a researched date says Research, links the page, says the day checked and shows its words');
    ok(/Manual · Matt Foss · Oct 20/.test(tagM) && /Taken from last year/.test(tagE) && /Taken from 2024/.test(tag2), 'the page: Manual · <editor> · <date>; a rolled date says Taken from last year (or the year it really came from)');
    const found = { ...cases[0], applyOpensSource: { ...cases[0].applyOpensSource, found: { date: '2025-10-15', url: 'https://fairtest.org/apply', quote: 'x', checked: '2026-10-26' } } };
    ok(/Research found Oct 15 on <a[^>]*>fairtest\.org<\/a>, your date kept/.test(P.appTag(found, 'applyOpens')), 'the page: research disagreeing with a date typed by hand shows under it; the date stays');
    const evil = { applyBy: '2026-01-15', applyBySource: { kind: 'research', url: 'javascript:alert(1)', quote: '<img src=x onerror=alert(1)>', checked: '2026-10-26' } };
    ok(!/javascript:|<img/.test(P.appTag(evil, 'applyBy')) && P.appTag({ applyBy: '' }, 'applyBy') === '' && /Manual/.test(P.appTag({ applyBy: '2026-01-15' }, 'applyBy')), 'the page: a stored link or quote never runs; no date, no tag; an old untagged date counts as a person\'s');
    // research's finding, checked by code
    const run = { start: '2027-03-06', end: '2027-03-07' }, app = (x = {}) => ({ url: 'https://fairtest.org/apply', opens: '2026-11-01', opensQuote: 'Applications open November 1', deadline: '2027-01-15', deadlineQuote: 'Apply by January 15', confidence: 'official', sourceUrl: 'https://fairtest.org/apply', ...x });
    ok(A.checkFinding(app(), 'deadline', run).date === '2027-01-15' && A.checkFinding(app(), 'opens', run, '2027-01-15').date === '2026-11-01', 'checkFinding: an official page, a date, the words, this edition');
    ok(A.checkFinding(app({ deadline: '2026-01-15' }), 'deadline', run).rejected && A.checkFinding(app({ deadline: '2027-04-01' }), 'deadline', run).rejected, 'checkFinding: last year\'s date, or one after the show, is set aside (never carried as this year\'s)');
    ok(A.checkFinding(app({ confidence: 'secondary' }), 'deadline', run).rejected && A.checkFinding(app({ deadlineQuote: '' }), 'deadline', run).rejected && A.checkFinding(app({ deadline: 'mid January' }), 'deadline', run).rejected, 'checkFinding: a third-party page, no words, or not a date is set aside');
    ok(A.checkFinding(app({ opens: '2027-02-01' }), 'opens', run, '2027-01-15').rejected && A.checkFinding(app({ deadline: '' }), 'deadline', run) === null && A.checkFinding(app(), 'deadline', null).rejected, 'checkFinding: opens after the deadline is set aside; nothing stated is null; no board dates to check against is set aside');
    const f = { date: '2027-01-15', url: 'https://fairtest.org/apply', quote: 'Apply by January 15' }, opt = { today: '2026-10-26' };
    const man = { applyBy: '2027-01-10', applyBySource: { kind: 'manual', by: 'JP', at: '2026-10-01' } };
    const dk = A.decideAppDate(man, 'applyBy', f, opt);
    ok(dk.kind === 'kept' && !('applyBy' in dk.patch) && dk.patch.applyBySource.found.date === '2027-01-15' && dk.patch.applyBySource.by === 'JP', 'decideAppDate: a date typed by hand is never changed; the different finding is flagged on it');
    ok(Object.keys(A.decideAppDate({ ...man, applyBySource: dk.patch.applyBySource }, 'applyBy', f, opt).patch).length === 0, 'decideAppDate: the same disagreement again writes nothing new');
    const ag = A.decideAppDate({ applyBy: '2027-01-15', applyBySource: { ...dk.patch.applyBySource } }, 'applyBy', f, opt);
    ok(ag.kind === 'agrees' && !('found' in ag.patch.applyBySource), 'decideAppDate: research agreeing with a person clears the flag');
    ok(A.decideAppDate(man, 'applyBy', f, { ...opt, manualWins: false }).patch.applyBy === '2027-01-15', 'decideAppDate: with "a date typed by hand wins" off, research replaces it');
    const est = A.decideAppDate({ applyBy: '2027-01-16', applyBySource: { kind: 'rolled', from: '2026-01-16', fromYear: 2026 } }, 'applyBy', f, opt);
    ok(est.kind === 'set' && est.patch.applyBy === '2027-01-15' && est.patch.applyBySource.kind === 'research' && est.fromKind === 'rolled', 'decideAppDate: this year\'s date replaces last year\'s estimate');
    ok(A.decideAppDate({ applyBy: '' }, 'applyBy', null, opt).kind === 'not-found' && A.decideAppDate({ applyBy: '2027-01-16', applyBySource: { kind: 'rolled', from: '2026-01-16', fromYear: 2026 } }, 'applyBy', null, opt).estimate
      && A.decideAppDate({ applyBy: '2027-01-15', applyBySource: research }, 'applyBy', null, opt).kind === 'none', 'decideAppDate: not stated anywhere leaves it as it is (blank or estimate listed as not found); a research date is not cleared');
    ok(A.wantsAppDates({ applyBy: '' }, '2026-10-26') && A.wantsAppDates({ applyBy: '2027-01-16', applyBySource: { kind: 'rolled' } }, '2026-10-26') && !A.wantsAppDates({ applyBy: '2026-10-01', applyOpens: '' }, '2026-10-26')
      && !A.wantsAppDates({ applyBy: '2027-01-15', applyBySource: research, applyOpens: '2026-11-01', applyOpensSource: research }, '2026-10-26'), 'wantsAppDates: blank or last year\'s estimate, and the deadline not passed');
    const { decideAppDates } = await import(path.join(REPO, 'scripts/board-research.mjs'));
    const both = decideAppDates({ applyBy: '' }, { application: app() }, run, opt);
    ok(both.patch.applyBy === '2027-01-15' && both.patch.applyOpens === '2026-11-01' && both.found.length === 2, 'decideAppDates: both dates from one page');
    const bad = decideAppDates({ applyBy: '' }, { application: app({ opens: '2026-01-01', deadline: '2026-02-01' }) }, run, opt);
    ok(!('applyBy' in bad.patch) && bad.rejected.length === 2 && bad.notFound.length === 2, 'decideAppDates: last year\'s pair is set aside and listed, nothing written');
    // board set: a date typed in is a person's; the CLI refuses a bad date and over-long notes
    T('events').set('2026-ad1', { name: 'App Dates Test Fair', year: 2026, startDate: '2026-12-05', booths: [] });
    r = await board(['set', '2026-ad1', 'applyBy=2026-11-01', 'submissionNotes=Ask for booth 12, returning vendor', '--by', 'Matt Foss', '--date', '2026-10-26']);
    const ad = T('events').get('2026-ad1');
    ok(r.code === 0 && ad.applyBy === '2026-11-01' && ad.applyBySource.kind === 'manual' && ad.applyBySource.by === 'Matt Foss' && ad.applyBySource.at === '2026-10-26' && ad.submissionNotes === 'Ask for booth 12, returning vendor', 'board set: a date typed in is tagged Manual with who and when');
    r = await board(['set', '2026-ad1', 'applyBy=']);
    ok(r.code === 0 && T('events').get('2026-ad1').applyBy === '' && T('events').get('2026-ad1').applyBySource === null, 'board set: clearing a date clears its tag');
    r = await board(['set', '2026-ad1', 'applyOpens=Jan 5']);
    const r2b = await board(['set', '2026-ad1', 'submissionNotes=' + 'x'.repeat(351)]);
    ok(r.code !== 0 && r2b.code !== 0 && T('events').get('2026-ad1').submissionNotes === 'Ask for booth 12, returning vendor', 'board set: a date that is not YYYY-MM-DD, or Submission Notes over 350 characters, is refused');
    // the roll carries the dates as last year's estimate, and the Submission Notes as they are
    await board(['set', '2026-ad1', 'applyBy=2026-11-01', 'applyOpens=2026-08-01', '--by', 'JP', '--date', '2026-10-26']);
    T('events').set('2026-ad1', { ...T('events').get('2026-ad1'), days: ['Saturday'], weekend: '2026-12-04', booths: [{ label: '', days: ['Saturday'], dates: ['2026-12-05'], shifts: [] }] });
    r = await board(['rollforward', '2027']);
    const rolled = T('events').get('2027-ad1');
    ok(r.code === 0 && rolled && rolled.applyBy === '2027-11-01' && rolled.applyBySource.kind === 'rolled' && rolled.applyBySource.from === '2026-11-01' && rolled.applyOpens === '2027-08-01'
      && rolled.submissionNotes === 'Ask for booth 12, returning vendor', 'board rollforward: application dates roll as last year\'s estimate, Submission Notes as they are');
    ok(/applyOpens:P\('qaApplyOpens'\)\.value/.test(html) && /\.\.\.rollAppDates\(e,Y,yearOf\(e\)\)/.test(html) && /Team notes \(never sent to Cutco\)/.test(html) && !/Notes for the booking request/.test(html),
      'index.html: quick add takes both dates and the Submission Notes; Roll forward carries the dates; the team\'s notes say they never go to Cutco');
    for (const id of [...T('events').keys()].filter(k => /^202[67]-ad1$/.test(k))) T('events').delete(id);
    T('seasons').delete('2027');
  });

  await section('maricopa-booths: reading the promoter\'s plans, and what it writes', async () => {
    const M = await import(path.join(REPO, 'scripts/maricopa-booths.mjs'));
    const links = M.parseMapLinks(`<a href="/x">Download Floor Plans</a>
      <a href="https://m.example/wp-content/uploads/2026/10/Jan-2027.pdf"><strong>January 15-17, 2027</strong> Fairgrounds Show Map</a>
      <a href="/wp-content/uploads/May.pdf">April 30-May 2, 2027 Scottsdale Show Map</a>
      <a href="/wp-content/uploads/2025/09/Unknown-1.jpeg">October 8-10, 2027 Scottsdale Show Map</a>`, 'https://m.example/exhibit/');
    ok(links.length === 3 && links.map(l => `${l.start}/${l.venue}/${l.pdf}`).join() === '2027-01-15/Fairgrounds/true,2027-04-30/Scottsdale/true,2027-10-08/Scottsdale/false'
      && links[1].href === 'https://m.example/wp-content/uploads/May.pdf', 'parseMapLinks: each "<dates> <venue> Show Map" link, its start date, venue and whether it is a PDF: ' + JSON.stringify(links));
    // one page: Cutco in a box from 820 down to 822, the next column 20pt over, the next booth down past 822 (824)
    const w = (t, x, y) => ({ t, x, y, x0: x - 5, x1: x + 5, y0: y - 2.5, y1: y + 2.5 });
    const page = { page: 2, width: 612, height: 792, words: [w('Cutco', 237, 98), w('820', 234, 83), w('822', 234.1, 113), w('824', 233.9, 118), w('819', 224, 83), w('821', 274, 91), w('Cutco', 500, 400), w('1223', 498, 390), w('1225', 498, 409), w('738', 516, 403)] };
    const spots = M.findSpots(page, { wallBetween: (pg, n) => n.t === '1225' });
    ok(spots.map(s => s.numbers.join('-')).join() === '820-822,1223', 'findSpots: the corner numbers above and below in the nearest column (822, not 824 a hair closer in x); a wall below makes it one booth (1223); a number level with the name is the booth beside it: ' + JSON.stringify(spots));
    ok(M.areaOf('Fairgrounds', 821) === 'Ag Building' && M.areaOf('Scottsdale', 2049) === 'Concourse' && M.areaOf('State Farm Stadium', 301) === '' && M.areaOf('Somewhere', 5) === '', 'areaOf: the venue\'s number ranges from config; none for one-hall State Farm Stadium or an unknown venue');
    ok(M.spotName(1, { area: 'Ag Building', numbers: [820, 822] }) === 'Booth #2 (Ag Building) (820-822)' && M.spotName(0, { area: '', numbers: [709] }) === 'Booth #1 (709)', 'spotName: "Booth #N (Area) (numbers)"');
    const tag = (label, y = 2026) => ({ label, rolledLabel: label, rolledLabelYear: y, shifts: [] });
    const ev = { id: '2027-x', name: 'Maricopa County Summer Home & Landscape Show', booths: [tag('Booth #301-303'), tag('Booth #421-423'), tag('Booth #921-923')] };
    const S = (...n) => ({ page: 1, numbers: n, area: '' });
    let p = M.planShow(ev, [S(921, 923), S(221, 223), S(301, 303)]);
    ok(p.ok && p.writes.length === 1 && p.writes[0].booth === 1 && p.writes[0].to === 'Booth #2 (221-223)' && p.kept.map(k => `${k.booth}:${k.confirm}`).sort().join() === '0:true,2:true',
      'planShow: a spot a booth already names is kept (and its tag comes off); the new one goes to the tagged booth left: ' + JSON.stringify(p));
    p = M.planShow({ ...ev, booths: [{ label: 'Booth #1 South Entrance Tent', shifts: [] }, tag('Booth #421-423'), { label: 'Booth #3 (#135/137)', shifts: [] }] }, [S(3128, 3130), S(221, 223), S(125, 127)]);
    ok(p.writes.length === 0 && p.report.some(r => /3128-3130/.test(r)) && p.report.some(r => /221-223/.test(r)) && p.report.filter(r => /named this season/.test(r)).length === 2,
      'planShow: a name set this season is never overwritten, and beside one no spot is guessed onto a tagged booth either: ' + JSON.stringify(p.report));
    p = M.planShow(ev, [S(921, 923), S(221, 223)]);
    ok(!p.ok && p.writes.length === 0 && p.kept.every(k => !k.confirm) && /2 Cutco booth\(s\), the board has 3/.test(p.report.join()), 'planShow: a different number of Cutco booths than the board has: nothing written, no tag dropped');
    p = M.planShow(ev, [S(921, 923), S(), S(301, 303)]);
    ok(!p.ok && p.writes.length === 0 && /no booth number beside them/.test(p.report.join()), 'planShow: a Cutco with no number beside it: nothing written for the show');
  });

  await section('tick.py: the freshmen reminder', async () => {
    // ---- tick.py words the freshmen reminder as an ask, not an "open Claude on this repo" routine
    fs.mkdirSync(path.join(home, '.rsd'), { recursive: true });
    fs.writeFileSync(path.join(home, '.rsd', 'board.env'), `BOARD_SUPABASE_URL=${base}\nBOARD_SERVICE_KEY=test\nBOARD_ALAN_IMESSAGE=+15555550100\n`);
    T('settings').set('division', { meetings: ['2027-01-15'] });
    r = await run('/usr/bin/python3', ['-B', path.join(stage, 'deploy/tick.py'), '--dry', '--date', '2027-01-17']);
    ok(r.code === 0 && /New freshmen: send Claude this season's training sign-in sheet/.test(r.stdout), 'tick.py --dry: the freshmen reminder reads as an ask: ' + r.stdout.slice(0, 300));
    fs.rmSync(path.join(home, '.rsd'), { recursive: true, force: true });
  });

  // ---- lib/match.mjs: the event-check skill's rules, as code
  await section('lib/match.mjs', async () => {
    const M = await import(path.join(REPO, 'scripts/lib/match.mjs'));
    ok(M.nameScore('Santa Cruz County Fair', 'Navajo County Fair') === 0, 'match: two county fairs share no distinctive word, so they score zero');
    ok(M.nameScore('Kierland Fine Art & Wine Festival', 'Waterfront Fine Art & Wine Festival') === 0, 'match: "<City> Fine Art & Wine" family scores zero across cities');
    ok(M.nameScore('Oro Valley Festival of the Arts', 'Tempe Fall Festival of the Arts') < 0.5, 'match: Oro Valley vs Tempe festival of the arts stays under the bar');
    ok(M.nameScore('Lake Havasu City Oktoberfest', 'Lake Havasu City Octoberfest') >= 0.5, 'match: Oktoberfest and Octoberfest are the same word');
    ok(M.nameScore('Sahaurita Art on the Lake', 'Sahuarita Art on the Lake Festival') >= 0.5, 'match: a one-letter typo in a long word still matches');
    ok(M.nameScore("Women's Day Out Expo - Glendale", "Women's Day Out Expo - Mesa") === 0, 'match: a family of same-named expos never matches across cities');
    ok(M.effectiveDate({ weekend: '2027-01-29', startDate: '2027-01-28', days: ['1/25/2024', '1/26/2024', 'Sunday SE'], dates: [null, null, '2027-01-31'] }) === '2027-01-28', 'match: a set-up day is never the effective date');
    ok(M.effectiveDate({ weekend: '2026-10-09', startDate: '2026-11-01', days: ['Saturday'], dates: ['2026-10-10'] }) === '2026-10-10', 'match: the banner-resolved day beats a stale start date');
    const pinetop = { weekend: '2026-09-25', startDate: '2026-10-27', endDate: '2026-10-27', days: ['Friday', 'Saturday', 'Sunday', 'Monday SE'], dates: ['2026-09-25', '2026-09-26', '2026-09-27', '2026-09-28'] };
    ok(M.lastDay(pinetop) === '2026-09-27' && M.dateCellsOff(pinetop).join() === 'startDate,endDate', 'match: a Start/End Date cell weeks after the show\'s own days never makes a finished show upcoming (Pinetop-Lakeside 2026)');
    const havasu = { weekend: '2027-01-22', startDate: '2026-01-22', endDate: '2026-01-25', days: ['Thursday', 'Friday', 'Saturday', 'Sunday'], dates: ['2027-01-21', '2027-01-22', '2027-01-23', '2027-01-24'] };
    ok(M.lastDay(havasu) === '2027-01-24', 'match: last year\'s Start/End Date cells never make a show count as over (Havasu Island Balloon 2027)');
    ok(M.lastDay({ weekend: '2026-11-13', startDate: '2026-11-28', endDate: '2026-11-28', days: ['Saturday'], dates: ['2026-11-14'] }) === '2026-11-14', 'match: an End Date copied from the next market\'s row is not this row\'s last day');
    ok(M.lastDay({ weekend: '2027-02-12', startDate: '2027-02-12', endDate: '2027-02-21', days: ['Friday', 'Saturday', 'Sunday'], dates: ['2027-02-12', '2027-02-13', '2027-02-14'] }) === '2027-02-21'
      && M.lastDay({ weekend: '2027-02-19', startDate: '2027-02-20', endDate: '2027-02-28' }) === '2027-02-28' && M.dateCellsOff({ weekend: '2027-02-19', startDate: '2027-02-20', endDate: '2027-02-28' }).length === 0,
      'match: an End Date that belongs to the show (a run longer than the staffed days) still counts');
    ok(M.lastDay({ weekend: '2026-10-16' }) === '2026-10-16' && M.lastDay({ weekend: '2026-12-11', startDate: '2026-12-12', endDate: 'TBD' }) === '2026-12-12', 'match: a weekend alone, or a junk End Date, falls back to the show\'s start');
    const cat = (s, past) => M.statusCategory(s, { past });
    ok(cat('OK to Book - Need Contract') === 'contract' && cat('Pending Promoter - Acceptance') === 'promoter' && cat('Show Full - on Waiting List') === 'dead'
      && cat('Booked Own') === 'booked' && cat('Booked - Needs Insurance') === 'coi' && cat('Prospective') === 'not-committed' && cat('OK to Book') === 'not-committed'
      && cat('Missed Event - No Response From CO') === 'dead' && cat('Pending Promo - Payment Needed') === 'promoter' && cat('Check Requested') === 'olean' && cat('') === 'no-vc',
      'match: VC statuses land in the right work-list bucket, whatever their case or truncation');
    ok(cat('Closed', true) === 'booked' && cat('Closed', false) === 'dead', 'match: Closed is a finished show in the past, a dead one ahead');
    const vc = [
      { eventNumber: '00100001', name: 'Graham County Fair', status: 'Booked', startDate: '2026-10-08', endDate: '2026-10-11' },
      { eventNumber: '00100002', name: 'Navajo County Fair', status: 'Booked', startDate: '2026-09-17', endDate: '2026-09-20' },
      { eventNumber: '00103124', name: 'Queen Creek Family Market 1/24', status: 'Prospective', startDate: '2026-10-24', endDate: '2026-10-24' },
      { eventNumber: '00092192', name: 'Queen Creek Family Market 11/1', status: 'Booked', startDate: '2026-11-01', endDate: '2026-11-30' },
      { eventNumber: '00100005', name: 'Prescott Fall Arts & Crafts Show', status: 'Booked', startDate: '2026-10-03', endDate: '2026-10-04' },
      { eventNumber: '00100006', name: 'Quartzsite RV Show', status: 'Booked', startDate: '2027-01-15', endDate: '2027-01-25' },
      { eventNumber: '00100007', name: 'Tucson Home Show', status: 'Booked', startDate: '2027-03-12', endDate: '2027-03-14' },
    ];
    const boardEv = [
      { id: 'a', name: 'Santa Cruz County Fair', weekend: '2026-09-18', startDate: '2026-09-18' },
      { id: 'b', name: 'Graham Co. Fair renamed on the board', weekend: '2026-10-09', startDate: '2026-10-09', vcNumber: '00100001' },
      { id: 'c', name: 'Queen Creek Family Market-October', weekend: '2026-10-23', startDate: '2026-11-01', days: ['Saturday'], dates: ['2026-10-24'], vcNumber: '00092192' },
      { id: 'd', name: 'Queen Creek Family Market-November', weekend: '2026-11-13', startDate: '2026-11-14', days: ['Saturday'], dates: ['2026-11-14'] },
      { id: 'e', name: 'FallFest In the Park', weekend: '2026-10-02', startDate: '2026-10-03' },
      { id: 'f', name: 'Quartzsite RV Show w 1', weekend: '2027-01-15', startDate: '2027-01-15' },
      { id: 'g', name: 'Quartzsite RV Show W 2', weekend: '2027-01-22', startDate: '2027-01-22' },
      { id: 'h', name: 'Tucson Home Show', weekend: '2027-01-08', startDate: '2027-01-09' },
    ];
    const cfg = JSON.parse(fs.readFileSync(path.join(REPO, 'config/event-check.json'), 'utf8'));
    const { results, claims } = M.matchAll(boardEv, vc, cfg);
    ok(!results.get('a').row, 'match: Santa Cruz County Fair does not steal Navajo County Fair');
    ok(results.get('b').by === 'number' && results.get('b').row.eventNumber === '00100001', 'match: a board VC number wins over the name');
    ok(results.get('c').by === 'qcfm' && results.get('c').row.eventNumber === '00103124', 'match: Queen Creek matches the exact date, ignoring the placeholder number the board carried');
    ok(!results.get('d').row && results.get('d').placeholder === '00092192', 'match: a date only the placeholder covers is an open question, not a booking');
    ok(results.get('e').by === 'alias' && results.get('e').row.eventNumber === '00100005', 'match: a confirmed alias matches a name that shares no words');
    ok(results.get('f').row && results.get('g').row && results.get('f').row.eventNumber === results.get('g').row.eventNumber, 'match: both weeks of a two-week show land on the one VC record');
    ok(!results.get('h').row && results.get('h').dateMismatch, 'match: a perfect name two months off is a date mismatch, not a match and not a missing booking');
    const dup = M.duplicateClaims(claims, new Map(boardEv.map(x => [x.id, x])));
    ok(dup.length === 1 && dup[0].legit, 'match: the week-split show is a legitimate duplicate claim');
    ok(!M.duplicateClaims(new Map([['1', ['a', 'b']]]), new Map(boardEv.map(x => [x.id, x])))[0].legit, 'match: two unrelated events claiming one number is flagged');
  });

  // ---- sheet-sync: three-way, VC wins, board edits win, held changes stay pending
  await section('sheet-sync: the three-way merge', async () => {
    const S = await import(path.join(REPO, 'scripts/sheet-sync.mjs'));
    const PS = await import(path.join(REPO, 'scripts/parse-sheet.mjs'));
    const resolve = PS.makeRepResolver(['Cameron', 'Eli', 'Kendall', 'Kendall H.', 'Sarah', 'Jerry']);
    const ev = (reps, extra = {}) => ({ name: 'Corn Fest', weekend: '2026-09-04', startDate: '2026-09-05', endDate: '2026-09-06', days: ['Saturday', 'Sunday'], dates: ['2026-09-05', '2026-09-06'],
      booths: [{ label: '', days: ['Saturday', 'Sunday'], dates: ['2026-09-05', '2026-09-06'], shifts: [{ label: 'Shift 1', slots: reps.map(r => ({ rep: r, ft: [] })) }] }], ...extra });
    let p = S.planEvent({ base: ev(['Cameron', '']), sheet: ev(['Cam', 'Sarah']), board: ev(['Cameron', '']), resolve, vcRow: null, today: '2026-08-01' });
    ok(p.patch.booths && p.patch.booths[0].shifts[0].slots[1].rep === 'Sarah' && p.slotChanges === 1, 'sync: a shift added on the Sheet reaches an untouched board (Cam is Cameron, not a change)');
    p = S.planEvent({ base: ev(['Kendall', '']), sheet: ev(['Kendall G.', '']), board: ev(['Kendall', '']), resolve, vcRow: null, today: '2026-08-01' });
    ok(!p.patch.booths && !p.conflicts.length, 'sync: "Kendall G." on the Sheet is the board\'s "Kendall", not a change');
    p = S.planEvent({ base: ev(['Cameron', '']), sheet: ev(['Sarah', '']), board: ev(['Eli', '']), resolve, vcRow: null, today: '2026-08-01' });
    ok(!p.patch.booths && p.conflicts.length === 1 && p.keepBase.slots.has('0.0.0'), 'sync: when the Sheet and the board both changed a shift, neither wins and it is held');
    const dead = { eventNumber: '9', status: 'Promoter Cancelled Event', startDate: '2026-09-05', endDate: '2026-09-06' };
    p = S.planEvent({ base: ev(['Cameron', ''], { cost: '$300', costNum: 300 }), sheet: ev(['Cameron', ''], { cost: '$350', costNum: 350 }), board: ev(['Cameron', ''], { cost: '$450', costNum: 450, costSource: 'VC' }), resolve, vcRow: null, today: '2026-08-01' });
    ok(!('cost' in p.patch) && !p.conflicts.some(c => /cost/.test(c)), 'sheet-sync: a cost the event check took from VC is not overwritten by the Sheet and is not a conflict');
    p = S.planEvent({ base: ev(['Cameron', ''], { cost: '$300', costNum: 300 }), sheet: ev(['Cameron', ''], { cost: '$350', costNum: 350 }), board: ev(['Cameron', ''], { cost: '$300', costNum: 300 }), resolve, vcRow: null, today: '2026-08-01' });
    ok(p.patch.cost === '$350', 'sheet-sync: without a VC cost the Sheet\'s cost still carries');
    p = S.planEvent({ base: ev(['Cameron', '']), sheet: ev(['', 'Sarah']), board: ev(['Cameron', '']), resolve, vcRow: dead, today: '2026-08-01' });
    ok(p.patch.booths && p.patch.booths[0].shifts[0].slots[0].rep === '' && p.patch.booths[0].shifts[0].slots[1].rep === '' && p.held.length === 1, 'sync: on a show VC calls dead, a removal applies but a new rep is held');
    const booked = { eventNumber: '8', status: 'Booked', startDate: '2026-09-05', endDate: '2026-09-06' };
    p = S.planEvent({ base: ev(['Cameron', '']), sheet: ev(['Cameron', ''], { startDate: '2026-10-10', endDate: '2026-10-11', dates: ['2026-10-10', '2026-10-11'] }), board: ev(['Cameron', '']), resolve, vcRow: booked, today: '2026-08-01' });
    ok(!('startDate' in p.patch) && p.held.length === 1 && p.keepBase.fields.has('startDate'), 'sync: a date moved away from a VC-booked record is held');
    p = S.planEvent({ base: ev(['Cameron', '']), sheet: ev(['Cameron', ''], { startDate: '2026-09-06', endDate: '2026-09-06' }), board: ev(['Cameron', '']), resolve, vcRow: null, today: '2026-08-01' });
    ok(p.patch.startDate === '2026-09-06', 'sync: a date change with no VC record behind it is carried');
    p = S.planEvent({ base: ev(['Cameron', '']), sheet: ev(['Cameron', ''], { startDate: '2026-11-01', endDate: '2026-11-01' }), board: ev(['Cameron', '']), resolve, vcRow: null, today: '2026-08-01' });
    ok(!('startDate' in p.patch) && !p.held.length, 'sync: a start date weeks away from the event\'s own days is a stale cell, never copied (QCFM\'s 11/1)');
    const two = reps => ({ ...ev(reps.slice(0, 2)), booths: [{ label: '', days: ['Saturday', 'Sunday'], dates: ['2026-09-05', '2026-09-06'], shifts: [{ label: 'Shift 1', slots: reps.slice(0, 2).map(r => ({ rep: r, ft: [] })) }, { label: 'Shift 2', slots: reps.slice(2).map(r => ({ rep: r, ft: [] })) }] }] });
    p = S.planEvent({ base: ev(['Cameron', '']), sheet: two(['Cameron', '', 'Eli', 'Eli']), board: ev(['Cameron', '']), resolve, vcRow: null, today: '2026-08-01' });
    ok(p.patch.booths && p.patch.booths[0].shifts.length === 2, 'sync: a shift row added on the Sheet is carried when the board still has the old shape');
    p = S.planEvent({ base: ev(['Cameron', '']), sheet: two(['Cameron', '', 'Eli', 'Eli']), board: ev(['Sarah', '']), resolve, vcRow: null, today: '2026-08-01' });
    ok(!p.patch.booths && p.keepBase.whole && p.conflicts.length === 1, 'sync: a Sheet row change on top of a board edit is held whole');
    p = S.planEvent({ base: two(['Cameron', '', 'Eli', 'Eli']), sheet: ev(['Cameron', '']), board: ev(['Cameron', '']), resolve, vcRow: null, today: '2026-08-01' });
    ok(!p.patch.booths && !p.conflicts.length && !p.keepBase.whole, 'sync: a row removed on the board and then on the Sheet too is settled, not a conflict, and the baseline moves on');
    p = S.planEvent({ base: ev(['Cameron', '']), sheet: two(['Cameron', '', 'Eli', 'Eli']), board: two(['Cameron', '', 'Eli', 'Eli']), resolve, vcRow: null, today: '2026-08-01' });
    ok(!p.patch.booths && !p.conflicts.length && !p.keepBase.whole, 'sync: a row added on the board and then on the Sheet with the same reps is settled');
    p = S.planEvent({ base: two(['Cameron', '', 'Eli', 'Eli']), sheet: ev(['Sarah', '']), board: ev(['Cameron', '']), resolve, vcRow: null, today: '2026-08-01' });
    ok(!p.patch.booths && p.keepBase.whole && p.conflicts.length === 1, 'sync: the same row removed on both, but different reps on what is left, is still held whole');
    p = S.planEvent({ base: two(['Cameron', '', 'Eli', 'Eli']), sheet: two(['Sarah', '', 'Eli', 'Eli']), board: ev(['Cameron', '']), resolve, vcRow: null, today: '2026-08-01' });
    ok(!p.patch.booths && p.keepBase.whole && p.conflicts.length === 1, 'sync: a Sheet re-staff on top of a row removed on the board is held whole');
  });

  // ---- sheet-sync end to end: the fake database, a synthetic grid, a baseline file, --apply twice
  await section('sheet-sync end to end', async () => {
    const PS = await import(path.join(REPO, 'scripts/parse-sheet.mjs'));
    const G = [], row = o => { const r = new Array(27).fill(null); for (const [i, v] of Object.entries(o)) r[+i] = v; G.push(r); };
    const SER = d => Math.round((Date.parse(d + 'T00:00:00Z') - Date.UTC(1899, 11, 30)) / 86400000);
    row({ 2: 'Status', 4: 'header' });
    row({ 1: 'Weekend 09-04' });
    row({ 2: 'Booked', 4: 'Corn Fest', 5: 'Saturday', 6: 'Sunday', 12: '100', 13: SER('2026-09-05'), 14: SER('2026-09-06'), 15: 'Phoenix, AZ' });
    row({ 4: 'Shift 1', 5: 'Cam', 6: '' });
    row({ 2: 'Booked', 4: 'Dead Fest', 5: 'Saturday', 6: 'Sunday', 12: '100', 13: SER('2026-09-05'), 14: SER('2026-09-06'), 15: 'Mesa, AZ' });
    row({ 4: 'Shift 1', 5: 'Eli', 6: '' });
    const baseGrid = JSON.parse(JSON.stringify(G));
    const { events: baseEvents } = PS.parseAll(baseGrid, { seasonYear: 2026 });
    const ids = ['2026-corn-fest-t1', '2026-dead-fest-t2'];
    const baseline = baseEvents.map((e, i) => ({ ...e, id: ids[i] }));
    for (const t of Object.keys(db)) db[t].clear();
    baseline.forEach((e, i) => { const { id, ...d } = e; T('events').set(id, { ...d, year: 2026, vcStatus: i === 1 ? 'Promoter Cancelled Event' : 'Booked', vcNumber: i === 1 ? '00200002' : '00200001', booths: JSON.parse(JSON.stringify(d.booths)).map(b => ({ ...b, shifts: b.shifts.map(s => ({ ...s, slots: s.slots.map(sl => ({ ...sl, rep: sl.rep === 'Cam' ? 'Cameron' : sl.rep })) })) })) }); });
    T('settings').set('division', { roster: ['Cameron', 'Eli', 'Sarah', 'Kendall'] });
    const state = path.join(home, 'sync-state'), outd = path.join(home, 'sync-out');
    fs.mkdirSync(state, { recursive: true }); fs.writeFileSync(path.join(state, 'sheet-baseline.json'), JSON.stringify(baseline));
    G[3][6] = 'Sarah';        // Corn Fest Sunday: a rep added
    G[5][5] = '';             // Dead Fest Saturday: Eli removed
    G[5][6] = 'Sarah';        // Dead Fest Sunday: a rep added to a show VC calls dead
    row({ 2: 'Prospective', 4: 'Corn Fest', 5: 'Saturday', 6: 'Sunday', 12: '100', 13: SER('2026-09-05'), 14: SER('2026-09-06'), 15: 'Phoenix, AZ' });
    row({ 4: 'Shift 1', 5: 'Cameron', 6: 'Sarah' });   // the same market, same weekend, same staffing, written twice
    const gridFile = path.join(home, 'sync-grid.json'); fs.writeFileSync(gridFile, JSON.stringify(G));
    const vcFile = path.join(home, 'sync-vc.json');
    fs.writeFileSync(vcFile, JSON.stringify({ rows: [{ eventNumber: '00200001', name: 'Corn Fest', status: 'Booked', startDate: '2026-09-05', endDate: '2026-09-06' }, { eventNumber: '00200002', name: 'Dead Fest', status: 'Promoter Cancelled Event', startDate: '2026-09-05', endDate: '2026-09-06' }] }));
    const sync = (...a) => new Promise(res => execFile(process.execPath, [path.join(REPO, 'scripts/sheet-sync.mjs'), '--grid', gridFile, '--vc', vcFile, '--date', '2026-08-01', '--json', ...a],
      { env: { PATH: process.env.PATH, HOME: home, BOARD_SUPABASE_URL: base, BOARD_SERVICE_KEY: 'test', BOARD_STATE_DIR: state, BOARD_OUT_DIR: outd } }, (err, stdout, stderr) => res({ code: err ? err.code : 0, stdout, stderr })));
    r = await sync();
    const dry = JSON.parse(r.stdout);
    ok(r.code === 0 && dry.eventsTouched === 2 && dry.held.length === 1 && !dry.wrote, 'sheet-sync dry: two events planned, one addition held, nothing written: ' + r.stderr.slice(0, 200));
    ok(dry.duplicates.length === 1 && dry.created.length === 0, 'sheet-sync: the same event written twice on the Sheet is reported, and the board keeps one');
    ok(T('events').get('2026-corn-fest-t1').booths[0].shifts[0].slots[1].rep === '', 'sheet-sync dry: the board is untouched');
    r = await sync('--apply');
    ok(r.code === 0 && JSON.parse(r.stdout).wrote, 'sheet-sync --apply exits 0 and writes: ' + r.stderr.slice(0, 200));
    ok(T('events').get('2026-corn-fest-t1').booths[0].shifts[0].slots[1].rep === 'Sarah', 'sheet-sync --apply: the new shift is on the board');
    const df = T('events').get('2026-dead-fest-t2').booths[0].shifts[0].slots;
    ok(df[0].rep === '' && df[1].rep === '', 'sheet-sync --apply: the removal on the dead show applied, the addition did not');
    r = await sync('--apply');
    const again = JSON.parse(r.stdout);
    ok(r.code === 0 && again.eventsTouched === 0 && again.held.length === 1, 'sheet-sync: a second run changes nothing, and the held change comes back until someone decides');
    ok(fs.statSync(path.join(state, 'sheet-baseline.json')).mode % 0o1000 === 0o600, 'sheet-sync: the baseline (it can carry promoter contacts) is mode 600');
    const runs = [...T('sheet_syncs').values()];
    ok(runs.length === 2 && runs.every(x => x.status === 'done' && x.requested_by === 'service:sheet-sync' && x.finished_at) && runs[0].result.eventsTouched === 2 && runs[0].result.counts.held === 1,
      'sheet-sync --apply: each run is on the record for the page (the dry run is not): ' + JSON.stringify(runs.map(x => [x.status, x.requested_by, x.result && x.result.eventsTouched])));
    ok(!fs.existsSync(path.join(state, 'sheet-sync.lock')), 'sheet-sync --apply: the lock is released when the run ends');
  });

  // ---- two books (Alan, 2026-10-23): the Sept-Feb and Jan-May schedules, each feeding its own weekends, the Jan-May
  // book's first load (last year's March-May rows: no reps, estimated days, Cancelled, Elite, skips), and the handover
  await section('sheet-sync: two books, a first load, the handover', async () => {
    const S = await import(path.join(REPO, 'scripts/sheet-sync.mjs'));
    const PS = await import(path.join(REPO, 'scripts/parse-sheet.mjs'));
    const SER = d => Math.round((Date.parse(d + 'T00:00:00Z') - Date.UTC(1899, 11, 30)) / 86400000);
    const grid = () => { const G = []; G.row = o => { const r = new Array(27).fill(null); for (const [i, v] of Object.entries(o)) r[+i] = v; G.push(r); return G.length - 1; }; return G; };

    // the reader: a year-old header means its week's Friday, set-up in a rep cell is no shift, the Jan-May book's date
    // cells read as weekdays, the service-call row is not a show, column B Elite is kept
    const P = grid();
    P.row({ 2: 'Status', 4: 'header' });
    P.row({ 1: 'Weekend 03/13' });
    P.row({ 1: 'Elite', 2: 'Booked', 4: 'Spring Fest', 5: SER('2024-03-15'), 6: 'Saturday', 7: 'Sunday SE', 12: '4250', 13: SER('2026-03-13'), 14: SER('2026-03-15') });
    P.row({ 4: 'Shift 1', 5: 'set-up 11-7', 6: 'Eli', 7: 'SET UP DAY' });
    P.row({ 4: 'Service Events', 5: 'Monday (3/10)', 6: 'Tuesday' });
    P.row({ 4: 'Shift 1', 5: 'Sarah' });
    let pe = PS.parseAll(P, { seasonYear: 2026, dateLabels: 'weekday' }).events;
    ok(pe.length === 1 && pe[0].weekend === '2027-03-12', 'parse: "Weekend 03/13" in the Jan-May 2027 book (a Saturday) is the 2027-03-12 weekend, and the service-call row is not a show: ' + JSON.stringify(pe.map(e => [e.name, e.weekend])));
    ok(pe[0].days.join('|') === 'Friday|Saturday|Sunday SE' && pe[0].dates.join('|') === '2027-03-12|2027-03-13|2027-03-14', 'parse: a day cell holding an old date reads as its weekday, so the days fall in 2027: ' + JSON.stringify([pe[0].days, pe[0].dates]));
    ok(pe[0].booths[0].shifts.length === 1 && pe[0].booths[0].shifts[0].slots.map(s => s.rep).join('|') === '__X__|Eli|__X__', 'parse: set-up text in a rep cell is no shift, and the service-call row\'s names went nowhere: ' + JSON.stringify(pe[0].booths[0].shifts));
    ok(pe[0].tierTag === 'Elite' && pe[0].level === '', 'parse: column B "Elite" is kept as the tier tag');
    pe = PS.parseAll(P, { seasonYear: 2026 }).events;
    ok(pe[0].days[0] === '3/15/2024', 'parse: without dateLabels a date cell stays as the migration wrote it (what --verify lines up with the seed)');
    const books = JSON.parse(fs.readFileSync(path.join(REPO, 'config/event-check.json'), 'utf8'));
    ok([...books.sheets, ...(books.rollIns || [])].every(b => b.dateLabels === 'weekday'),
      'config: every schedule book reads a date cell as the weekday it shows (2026-10-27: Sept-Feb rows held 2024 dates formatted as "Friday", and the page could not place "1/26/2024"): ' +
      JSON.stringify([...books.sheets, ...(books.rollIns || [])].map(b => [b.key, b.dateLabels])));

    // planEvent: a blank Start Date never blanks the board; estimated board dates give way to the Sheet's; column C carries
    const resolve = PS.makeRepResolver(['Cameron', 'Eli', 'Sarah', 'Kendall', 'Zach']);
    const ev = (extra = {}) => ({ name: 'Corn Fest', weekend: '2027-03-12', startDate: '2027-03-13', endDate: '2027-03-14', days: ['Saturday', 'Sunday'], dates: ['2027-03-13', '2027-03-14'],
      booths: [{ label: '', days: ['Saturday', 'Sunday'], dates: ['2027-03-13', '2027-03-14'], shifts: [{ label: 'Shift 1', slots: [{ rep: '', ft: [] }, { rep: '', ft: [] }] }] }], ...extra });
    let p = S.planEvent({ base: ev(), sheet: ev({ startDate: '', endDate: '' }), board: ev(), resolve, vcRow: null, today: '2026-10-24' });
    ok(!('startDate' in p.patch) && !p.conflicts.length && p.keepBase.fields.has('startDate'), 'sync: a Start Date cell emptied on the Sheet does not empty the board\'s, and the baseline keeps the date (the next one typed is a move, not a conflict)');
    // the first sync after the Sept-Feb book reads its date cells as weekdays (2026-10-27): the baseline still has the
    // date text, so a show the board still has that way gets the weekdays, and one already fixed on the board is left alone
    const dl = (days, dates) => ev({ days, dates, booths: [{ label: '', days, dates, shifts: [{ label: 'Shift 1', slots: [{ rep: '', ft: [] }, { rep: 'Zach', ft: [] }] }] }] });
    const asDates = dl(['3/16/2024', '3/17/2024'], [null, null]), asDays = dl(['Saturday', 'Sunday'], ['2027-03-13', '2027-03-14']);
    p = S.planEvent({ base: asDates, sheet: asDays, board: asDates, resolve, vcRow: null, today: '2026-10-27' });
    ok(!p.conflicts.length && p.patch.booths && p.patch.booths[0].days.join() === 'Saturday,Sunday' && p.patch.booths[0].dates.join() === '2027-03-13,2027-03-14' && p.patch.booths[0].shifts[0].slots[1].rep === 'Zach',
      'sync: a show still carrying "3/16/2024" gets the weekday the Sheet shows and its date, reps untouched: ' + JSON.stringify([p.patch.booths, p.conflicts]));
    p = S.planEvent({ base: asDates, sheet: asDays, board: asDays, resolve, vcRow: null, today: '2026-10-27' });
    ok(!p.conflicts.length && !p.held.length && !('booths' in p.patch), 'sync: a show already fixed on the board is left alone, no conflict: ' + JSON.stringify([p.patch, p.conflicts]));
    p = S.planEvent({ base: ev({ startDate: '2026-03-14', endDate: '2026-03-15' }), sheet: ev({ startDate: '2027-03-20', endDate: '2027-03-21' }), board: ev({ datesEstimated: true }), resolve, vcRow: null, today: '2026-10-24' });
    ok(p.patch.startDate === '2027-03-20' && p.patch.datesEstimated === false && !p.conflicts.length, 'sync: the Sheet\'s real date replaces an estimated one on the board (not a conflict): ' + JSON.stringify([p.patch, p.conflicts]));
    p = S.planEvent({ base: ev({ startDate: '2026-03-14', endDate: '2026-03-15' }), sheet: ev(), board: ev({ datesEstimated: true }), resolve, vcRow: null, today: '2026-10-24' });
    ok(p.patch.datesEstimated === false && !('startDate' in p.patch), 'sync: the Sheet confirming the estimate just clears "est."');
    p = S.planEvent({ base: ev({ sheetStatus: 'Prospective' }), sheet: ev({ sheetStatus: 'Booked' }), board: ev({ sheetStatus: 'In Progress' }), resolve, vcRow: null, today: '2026-10-24' });
    ok(p.patch.sheetStatus === 'Booked' && !p.conflicts.length, 'sync: column C is the Sheet\'s own words, so its change carries even where the board holds another book\'s');
    ok(S.owned(S.rangeOn({ weekends: { from: '2027-03-01' }, handover: { on: '2027-01-13', weekends: { from: '2027-01-01' } } }, '2027-01-12'), '2027-01-08') === false
      && S.owned(S.rangeOn({ weekends: { from: '2027-03-01' }, handover: { on: '2027-01-13', weekends: { from: '2027-01-01' } } }, '2027-01-13'), '2027-01-08') === true, 'sync: a book feeds January only from handover morning');

    // the two books end to end. Sept-Feb: a December show and a January one. Jan-May: the same January show (its Sunday
    // differs from day one: Alan's call keeps Sept-Feb's), and last year's March rows.
    const A = grid();
    A.row({ 2: 'Status', 4: 'header' });
    A.row({ 1: 'Weekend 12-04' });
    A.row({ 2: 'Booked', 4: 'Winter Fair', 5: 'Saturday', 6: 'Sunday', 12: '100', 13: SER('2026-12-05'), 14: SER('2026-12-06'), 15: 'Mesa, AZ' });
    A.row({ 4: 'Shift 1', 5: 'Eli', 6: '' });
    A.row({ 1: 'Weekend 01-08' });
    const aJan = A.row({ 2: 'Booked', 4: 'Jan Show', 5: 'Saturday', 6: 'Sunday', 12: '200', 13: SER('2027-01-09'), 14: SER('2027-01-10'), 15: 'Phoenix, AZ' });
    A.row({ 4: 'Shift 1', 5: 'Cam', 6: 'Sarah' });
    A.row({ 1: 'Weekend 02-12' });                                   // only in this book (Casa Grande's case)
    A.row({ 2: 'Booked', 4: 'Feb Only Show', 5: 'Saturday', 12: '75', 13: SER('2027-02-13'), 14: SER('2027-02-13'), 15: 'Casa Grande, AZ' });
    A.row({ 4: 'Shift 1', 5: 'Eli' });
    A.row({ 1: 'Weekend 02-26' });                                   // moved to the 3/5 weekend on the board (research)
    A.row({ 2: 'Booked', 4: 'Border Fest', 5: 'Saturday', 12: '300', 13: SER('2027-02-27'), 14: SER('2027-02-27'), 15: 'Yuma, AZ' });
    A.row({ 4: 'Shift 1', 5: 'Sarah' });
    const B = grid();
    B.row({ 2: 'Status', 4: 'header' });
    B.row({ 1: 'Weekend 1/8' });
    const bJan = B.row({ 2: 'Prospective', 4: 'Jan Show', 5: 'Saturday', 6: 'Sunday', 12: '200', 13: SER('2027-01-09'), 14: SER('2027-01-10'), 15: 'Phoenix, AZ' });
    B.row({ 4: 'Shift 1', 5: 'Cameron', 6: 'Kendall' });
    B.row({ 1: 'Weekend 03/06' });
    const bElPaso = B.row({ 2: 'Booked', 4: 'El Paso Home & Garden Show', 5: 'Friday', 6: 'Saturday', 12: '1315', 15: 'El Paso, TX' });   // config skip: last year's row
    B.row({ 4: 'Shift 1', 5: 'Jerry', 6: 'Jerry' });
    B.row({ 1: 'Weekend 03/13' });
    const bSpring = B.row({ 1: 'Elite', 2: 'Booked', 4: 'Spring Fest', 5: 'Friday', 6: 'Saturday', 7: 'Sunday', 12: '4250', 13: SER('2026-03-13'), 14: SER('2026-03-15'), 15: 'Tempe, AZ' });
    B.row({ 4: 'Shift 1', 5: 'TC', 6: 'TC', 7: 'TC' });
    B.row({ 4: 'Shift 2', 5: 'Zach', 6: 'Zach', 7: 'x' });
    const bCorner = B.row({ 2: 'Prospective', 4: 'Corner Market', 5: 'Saturday', 12: '50', 15: 'Gilbert, AZ' });
    B.row({ 4: 'Shift 1', 5: 'Kendall' });                            // one name only: too few to recognise a rename by
    B.row({ 1: 'no dates', 2: 'Prospective', 4: 'Gone Fair', 5: 'Saturday', 12: '90', 15: 'Mesa, AZ' });
    B.row({ 4: 'Shift 1', 5: '' });
    B.row({ 4: 'Service Events', 5: 'Monday (3/10)', 6: 'Tuesday' });

    for (const t of Object.keys(db)) db[t].clear();
    T('settings').set('division', { roster: ['Cameron', 'Eli', 'Sarah', 'Kendall', 'Zach', 'Jerry'] });
    const { events: aEvents } = PS.parseAll(JSON.parse(JSON.stringify(A)), { seasonYear: 2026 });
    const aIds = ['2026-winter-fair-t1', '2027-jan-show-t2', '2027-feb-only-t3', '2027-border-fest-t4'];
    const legacy = aEvents.map((e, i) => ({ ...e, id: aIds[i] }));
    legacy.forEach(e => { const { id, ...d } = e; T('events').set(id, { ...JSON.parse(JSON.stringify(d)), year: +d.weekend.slice(0, 4), booths: d.booths.map(b => ({ ...b, shifts: b.shifts.map(s => ({ ...s, slots: s.slots.map(sl => ({ ...sl, rep: sl.rep === 'Cam' ? 'Cameron' : sl.rep })) })) })) }); });
    T('events').get('2027-border-fest-t4').weekend = '2027-03-05';
    const state = path.join(home, 'books-state'), outd = path.join(home, 'books-out');
    fs.mkdirSync(state, { recursive: true }); fs.writeFileSync(path.join(state, 'sheet-baseline.json'), JSON.stringify(legacy));   // the one-book baseline, as on the mini
    const gA = path.join(home, 'books-a.json'), gB = path.join(home, 'books-b.json');
    const save = () => { fs.writeFileSync(gA, JSON.stringify(A)); fs.writeFileSync(gB, JSON.stringify(B)); };
    save();
    const sync = (...a) => new Promise(res => execFile(process.execPath, [path.join(REPO, 'scripts/sheet-sync.mjs'), '--json', ...a],
      { env: { PATH: process.env.PATH, HOME: home, BOARD_SUPABASE_URL: base, BOARD_SERVICE_KEY: 'test', BOARD_STATE_DIR: state, BOARD_OUT_DIR: outd } }, (err, stdout, stderr) => res({ code: err ? err.code : 0, stdout, stderr })));
    const J = r => { try { return JSON.parse(r.stdout); } catch { return {}; } };
    const ev2 = id => T('events').get(id), named = n => [...T('events')].find(([, d]) => d.name === n);
    const reps = d => d.booths.map(b => b.shifts.map(s => s.slots.map(sl => sl.rep).join(',')).join(' / ')).join(' | ');

    r = await sync('--grid', gA, '--grid-jan-may', gB, '--date', '2026-10-24', '--apply');
    ok(r.code === 5 && /Jan-May book has no baseline yet \(run sheet-sync\.mjs --first-load jan-may/.test(J(r).stopped || '') && T('events').size === 4 && !fs.existsSync(path.join(state, 'sheet-baseline-sept-feb.json')),
      'two books: a book with no baseline stops the whole run (exit 5) and says to first-load it; nothing written: ' + r.code + ' ' + (J(r).stopped || r.stderr.slice(0, 200)));

    r = await sync('--first-load', 'jan-may', '--grid-jan-may', gB, '--date', '2026-10-24');
    let fl = J(r);
    ok(r.code === 0 && fl.created.length === 3 && fl.skipped.length === 1 && fl.later.length === 1 && fl.later[0].id === '2027-jan-show-t2' && T('events').size === 4,
      'first load (dry): three new shows, last year\'s El Paso row skipped, the January show remembered against the board\'s id, nothing written: ' + JSON.stringify({ code: r.code, created: fl.created, skipped: fl.skipped, later: fl.later, err: r.stderr.slice(0, 300) }));
    ok((fl.onlyInOther || []).map(x => x.id).sort().join() === '2027-border-fest-t4,2027-feb-only-t3', 'first load: the report names the Sept-Feb shows on January-February weekends this book does not have: ' + JSON.stringify(fl.onlyInOther));

    r = await sync('--first-load', 'jan-may', '--grid-jan-may', gB, '--date', '2026-10-24', '--apply');
    fl = J(r);
    const spring = named('Spring Fest'), gone = named('Gone Fair');
    ok(r.code === 0 && fl.readBack && fl.readBack.ok === 3 && spring && gone && T('events').size === 7, 'first load --apply: all three shows written and read back: ' + JSON.stringify({ code: r.code, readBack: fl.readBack, err: r.stderr.slice(0, 300) }));
    const sp = spring[1];
    ok(sp.year === 2027 && sp.weekend === '2027-03-12' && sp.startDate === '2027-03-12' && sp.endDate === '2027-03-14' && sp.datesEstimated === true, 'first load: last year\'s row lands on its 2027 weekend, days placed from the header and marked estimated: ' + JSON.stringify([sp.weekend, sp.startDate, sp.endDate, sp.datesEstimated]));
    ok(sp.status === 'Prospective' && sp.tier === 'Elite' && reps(sp) === ',, / ,,' && ![sp, gone[1]].some(d => PRIV.some(k => k in d)), 'first load: Prospective (last year\'s "Booked" is not this year\'s), Elite from column B, no reps, no contacts in events: ' + JSON.stringify([sp.status, sp.tier, reps(sp)]));
    ok(gone[1].status === 'Cancelled' && gone[1].dead === true, 'first load: a row column B marks "no dates" is Cancelled');
    ok(!named('El Paso Home & Garden Show') && ![...T('events').values()].some(d => /service events/i.test(d.name)), 'first load: the skipped row and the service-call row are not on the board');
    const mode = f => fs.statSync(path.join(state, f)).mode % 0o1000;
    ok(['sheet-baseline-jan-may.json', 'sheet-stale-jan-may.json', 'sheet-baseline-sept-feb.json', 'sheet-baseline.json'].every(f => fs.existsSync(path.join(state, f)) && mode(f) === 0o600),
      'first load: each book\'s baseline, the stale cells and the combined baseline are written, mode 600 (the Sept-Feb book\'s moved out of the one-book file)');
    let combined = JSON.parse(fs.readFileSync(path.join(state, 'sheet-baseline.json'), 'utf8'));
    ok(combined.filter(e => e.id === '2027-jan-show-t2').map(e => e.book).join() === 'sept-feb' && combined.some(e => e.book === 'jan-may' && e.name === 'Spring Fest'),
      'combined baseline (the coverage agent\'s): the January show once, from the book that feeds it today: ' + JSON.stringify(combined.map(e => [e.book, e.name, e.id])));
    r = await sync('--first-load', 'jan-may', '--grid-jan-may', gB, '--date', '2026-10-24', '--apply');
    ok(r.code === 1 && /already on the board/.test(r.stderr) && T('events').size === 7, 'first load runs once: a second refuses');
    const staleN = () => JSON.parse(fs.readFileSync(path.join(state, 'sheet-stale-jan-may.json'), 'utf8')).length;
    ok(staleN() === 7, 'first load: last year\'s seven filled cells are kept, by show: ' + staleN());

    r = await sync('--grid', gA, '--grid-jan-may', gB, '--date', '2026-10-25', '--apply');
    ok(r.code === 0 && J(r).wrote && J(r).eventsTouched === 0 && J(r).books.length === 2 && !J(r).conflicts.length, 'two books: right after the first load, both books agree with the board: ' + JSON.stringify(J(r).books) + r.stderr.slice(0, 200));

    // the team edits: last year's TC overwritten on Friday, Spring Fest's real dates, a January pick in the Jan-May book,
    // a December pick in the Sept-Feb book
    B[bSpring + 1][5] = 'Zach';
    B[bSpring][13] = SER('2027-03-12'); B[bSpring][14] = SER('2027-03-14');
    B[bJan + 1][5] = 'Eli';
    A[3][6] = 'Sarah';
    B[bSpring + 2][6] = '';                                          // last year's Zach on Saturday, Shift 2, cleared
    B[bElPaso][4] = 'El Paso Home & Garden Expo';                    // the skipped row renamed: it stays skipped
    B.row({ 1: 'Weekend 03/06' });                                   // the show the Sept-Feb book feeds, added to this book too
    B.row({ 2: 'Prospective', 4: 'Border Fest', 5: 'Saturday', 12: '300', 15: 'Yuma, AZ' });
    B.row({ 4: 'Shift 1', 5: 'Cameron' });
    save();
    r = await sync('--grid', gA, '--grid-jan-may', gB, '--date', '2026-10-26', '--apply');
    let s2 = ev2(spring[0]);
    ok(r.code === 0 && reps(s2) === 'Zach,, / ,,' && s2.datesEstimated === false, 'two books: a name written over last year\'s comes over; last year\'s names nobody touched do not; the real dates clear "est.": ' + JSON.stringify([reps(s2), s2.datesEstimated]) + r.stderr.slice(0, 200));
    ok(ev2('2026-winter-fair-t1').booths[0].shifts[0].slots[1].rep === 'Sarah' && ev2('2027-jan-show-t2').booths[0].shifts[0].slots[0].rep === 'Cameron', 'two books: the Sept-Feb book still feeds December and January; the Jan-May book\'s January pick waits for the handover');
    ok(T('events').size === 7 && J(r).flagged.some(f => /Border Fest .*the other book feeds today \(2027-border-fest-t4\): not linked/.test(f)) && ev2('2027-border-fest-t4').booths[0].shifts[0].slots[0].rep === 'Sarah',
      'one show, one book: a row matching a show the other book feeds is not linked, and the board keeps that book\'s: ' + JSON.stringify(J(r).flagged));
    ok(!named('El Paso Home & Garden Expo'), 'a skipped row renamed stays skipped (never created with last year\'s names)');
    ok(staleN() === 5, 'held-back cells are used up once the Sheet says anything else there, a blank included: ' + staleN());
    B[bSpring + 2][6] = 'Zach'; save();                              // Zach picks Saturday again, typed in fresh
    r = await sync('--grid', gA, '--grid-jan-may', gB, '--date', '2026-10-27', '--apply');
    s2 = ev2(spring[0]);
    ok(r.code === 0 && reps(s2) === 'Zach,, / ,Zach,', 'a rep typed back into a cleared cell of last year\'s comes over (it is not held back for ever): ' + reps(s2));
    B[bCorner][4] = 'Totally New Thing'; save();                     // renamed past recognition, last year's Kendall still on it
    r = await sync('--grid', gA, '--grid-jan-may', gB, '--date', '2026-10-28', '--apply');
    ok(r.code === 0 && T('events').size === 7 && J(r).held.some(h => h.name === 'Totally New Thing' && /may be that show renamed/.test(h.why)),
      'a new row carrying the names of a show gone from that weekend is held, not created with last year\'s names: ' + JSON.stringify(J(r).held) + JSON.stringify(J(r).created));
    B[bCorner][4] = 'Corner Market'; B[bSpring][4] = 'Spring Fest Tempe'; save();
    r = await sync('--grid', gA, '--grid-jan-may', gB, '--date', '2026-10-29', '--apply');
    s2 = ev2(spring[0]);
    ok(r.code === 0 && reps(named('Corner Market')[1]) === '' && s2.name === 'Spring Fest Tempe' && reps(s2) === 'Zach,, / ,Zach,',
      'renames do not set last year\'s names loose: the cells stay held back by show, not by name: ' + JSON.stringify([reps(named('Corner Market')[1]), s2.name, reps(s2)]));

    r = await sync('--grid', gA, '--grid-jan-may', gB, '--date', '2027-01-13', '--apply');
    const jan = ev2('2027-jan-show-t2').booths[0].shifts[0].slots;
    ok(r.code === 0 && jan[0].rep === 'Eli' && jan[1].rep === 'Sarah', 'handover morning: what changed in the Jan-May book since its first load comes over (Eli); where the books disagreed that day, the board keeps what it had (Sarah, not Kendall): ' + JSON.stringify(jan) + r.stderr.slice(0, 200));
    combined = JSON.parse(fs.readFileSync(path.join(state, 'sheet-baseline.json'), 'utf8'));
    ok(combined.filter(e => e.id === '2027-jan-show-t2').map(e => e.book).join() === 'jan-may', 'handover: the combined baseline follows the January show to the Jan-May book');
    const fl13 = J(r).flagged;
    ok(fl13.some(f => /Feb Only Show .*only in the Sept-Feb book/.test(f)) && !fl13.some(f => /Border Fest .*only in the Sept-Feb book/.test(f)) && combined.some(e => e.id === '2027-feb-only-t3' && e.book === 'sept-feb') && combined.some(e => e.id === '2027-border-fest-t4' && e.book === 'jan-may'),
      'handover: a show only the Sept-Feb book had is flagged (and stays in the combined baseline); one the Jan-May book takes the same morning is not: ' + JSON.stringify(fl13));
    A[aJan + 1][6] = 'Zach'; save();
    r = await sync('--grid', gA, '--grid-jan-may', gB, '--date', '2027-01-14', '--apply');
    ok(r.code === 0 && ev2('2027-jan-show-t2').booths[0].shifts[0].slots[1].rep === 'Sarah' && J(r).eventsTouched === 0, 'after the handover the Sept-Feb book no longer feeds January');
    ok(!J(r).flagged.some(f => /Feb Only Show/.test(f)), 'a show left behind at the handover is said once');
    ok(ev2('2027-border-fest-t4').booths[0].shifts[0].slots[0].rep === 'Sarah' && J(r).conflicts.some(c => c.id === '2027-border-fest-t4'),
      'a show both sides had, on which the Jan-May book disagrees (Cameron vs the board\'s Sarah), stays a conflict run after run: the Sheet does not quietly win the second time: ' + JSON.stringify(J(r).conflicts));
    r = await sync('--grid', gA, '--grid-jan-may', gB, '--book', 'sept-feb', '--date', '2027-01-14');
    ok(r.code === 0 && J(r).books.length === 1 && J(r).books[0].key === 'sept-feb', '--book runs one book alone');
  });

  // ---- the May-Sept roll-in (Alan, 2026-10-24: "upload also events from this link without names to 2027"): last summer's
  // tab into 2027 once, no names, leaving alone what the board has in 2027 and what the 2026 roll-forward will bring
  await section('sheet-sync: the May-Sept roll-in', async () => {
    const SER = d => Math.round((Date.parse(d + 'T00:00:00Z') - Date.UTC(1899, 11, 30)) / 86400000);
    const G = [], row = o => { const r = new Array(27).fill(null); for (const [i, v] of Object.entries(o)) r[+i] = v; G.push(r); return G.length - 1; };
    row({ 0: ' ' });                                                                              // row 1: blank
    row({ 1: 'Type', 2: 'Status', 4: 'Event Description', 5: 'Elite,Key, Traditional, Pros' });   // row 2: the header
    row({ 1: 'Weekend 05/01' });
    row({ 2: 'Booked', 4: 'May Fair', 5: 'Saturday', 12: '100', 13: SER('2026-05-02'), 14: SER('2026-05-02') });   // the Jan-May load has it
    row({ 4: 'Shift 1', 5: 'Eli' });
    row({ 2: 'promoter declined', 4: 'Valley Fair', 5: 'Friday', 6: 'Saturday', 12: '300' });
    row({ 4: 'Shift 1', 5: 'Sarah', 6: 'Sarah' });
    row({ 1: 'Weekend 06-05' });
    row({ 1: 'Invite Only', 2: 'Booked', 4: 'Maricopa County Summer Home Show', 5: 'Friday', 6: 'Saturday', 7: 'Sunday', 12: '7099.52', 13: SER('2026-06-05'), 14: SER('2026-06-07') });
    row({ 1: 'Booth #301-303', 4: 'Shift 1', 5: 'Foss', 6: 'Foss', 7: 'Foss' });
    row({ 1: 'Booth #421-423', 4: 'Shift 1', 5: 'Eli', 6: 'Eli', 7: 'Eli' });
    row({ 2: 'Prospective', 4: 'Gary Rodeo', 5: 'Friday', 12: '350' });
    row({ 4: 'Booked' });                                                                         // a status typed into a shift label
    row({ 1: 'Weekend 07-03' });
    row({ 2: 'moved to OCT', 4: 'Pine Crafts', 5: 'Saturday', 12: '95' });
    row({ 1: 'Weekend 08-28' });
    row({ 2: 'Booked', 4: 'Corn Fest', 5: 'Saturday', 12: '125' });                               // fall 2026: same weekend a year earlier
    row({ 2: 'Booked', 4: 'County Fair', 5: 'Thursday', 6: 'Friday', 12: '100' });                // fall 2026: on 10/2 (it moved)
    row({ 2: 'Prospective', 4: 'Business Expo', 5: 'Saturday', 12: '100' });                      // not in the fall book
    for (const t of Object.keys(db)) db[t].clear();
    T('settings').set('division', { roster: ['Eli', 'Sarah', 'Foss'] });
    const show = (id, name, weekend, year) => T('events').set(id, { name, weekend, year, startDate: weekend, endDate: weekend, days: ['Saturday'], dates: [weekend], booths: [], status: 'Prospective' });
    show('2027-may-fair-j1', 'May Fair', '2027-04-30', 2027);
    show('2026-corn-fest-r3', 'Corn Fest', '2026-08-28', 2026);
    show('2026-county-fair-r9', 'County Fair', '2026-10-02', 2026);
    const state = path.join(home, 'rollin-state'), outd = path.join(home, 'rollin-out'), gridFile = path.join(home, 'rollin-grid.json');
    fs.mkdirSync(state, { recursive: true }); fs.writeFileSync(gridFile, JSON.stringify(G));
    const roll = (...a) => new Promise(res => execFile(process.execPath, [path.join(REPO, 'scripts/sheet-sync.mjs'), '--roll-in', 'may-sept-2026', '--grid-may-sept-2026', gridFile, '--date', '2026-10-24', '--json', ...a],
      { env: { PATH: process.env.PATH, HOME: home, BOARD_SUPABASE_URL: base, BOARD_SERVICE_KEY: 'test', BOARD_STATE_DIR: state, BOARD_OUT_DIR: outd } }, (err, stdout, stderr) => res({ code: err ? err.code : 0, stdout, stderr })));
    const J = x => { try { return JSON.parse(x.stdout); } catch { return {}; } };

    r = await roll();
    ok(r.code === 1 && /run the Jan-May book's first load before/.test(r.stderr) && T('events').size === 3, 'roll-in: refuses before the Jan-May first load (its May duplicates are judged against the board)');
    fs.writeFileSync(path.join(state, 'sheet-baseline-jan-may.json'), '[]');
    r = await roll();
    let ri = J(r);
    ok(r.code === 0 && ri.parsed === 8 && T('events').size === 3, 'roll-in (dry): the header row and the "Booked" label row are not shows; nothing written: ' + JSON.stringify({ code: r.code, parsed: ri.parsed, err: r.stderr.slice(0, 300) }));
    ok(ri.created.map(c => c.name).join() === 'Valley Fair,Maricopa County Summer Home Show,Gary Rodeo,Business Expo' && ri.already.map(c => c.id).join() === '2027-may-fair-j1'
      && ri.withRoll.map(c => c.id).sort().join() === '2026-corn-fest-r3,2026-county-fair-r9' && ri.skipped.map(c => c.name).join() === 'Pine Crafts',
      'roll-in: new shows made; the board\'s 2027 May show left alone; the fall book\'s shows (same weekend, or moved) left to the 2026 roll-forward; "moved to OCT" skipped: ' + JSON.stringify({ created: ri.created.map(c => c.name), already: ri.already, withRoll: ri.withRoll, skipped: ri.skipped }));
    r = await roll('--apply');
    ri = J(r);
    const made = name => [...T('events').values()].find(d => d.name === name);
    const msh = made('Maricopa County Summer Home Show'), vf = made('Valley Fair');
    ok(r.code === 0 && ri.readBack && ri.readBack.ok === 4 && T('events').size === 7, 'roll-in --apply: four shows written and read back: ' + JSON.stringify({ code: r.code, readBack: ri.readBack, err: r.stderr.slice(0, 300) }));
    ok(msh && msh.year === 2027 && msh.weekend === '2027-06-04' && msh.startDate === '2027-06-04' && msh.datesEstimated === true && msh.tier === 'Elite' && msh.status === 'Prospective'
      && msh.booths.every(b => b.shifts.every(s => s.slots.every(sl => !sl.rep))), 'roll-in: last summer\'s row is a 2027 show on its Friday, estimated, Elite by the Maricopa rule, Prospective, no names: ' + JSON.stringify(msh && [msh.weekend, msh.startDate, msh.tier, msh.status]));
    ok(vf && vf.status === 'Cancelled' && vf.dead === true && made('Business Expo').weekend === '2027-08-27', 'roll-in: "promoter declined" is Cancelled; a show the fall book does not have is made on its own weekend');
    ok(msh && msh.booths.map(b => `${b.label}/${b.rolledLabel}/${b.rolledLabelYear}`).join() === 'Booth #301-303/Booth #301-303/2026,Booth #421-423/Booth #421-423/2026',
      'roll-in: the Maricopa show\'s booth names (column B) come over as 2026\'s spots: ' + JSON.stringify(msh && msh.booths.map(b => [b.label, b.rolledLabel, b.rolledLabelYear])));
    ok(vf && vf.booths.every(b => !('rolledLabel' in b)), 'roll-in: a show that is not Maricopa gets no spot tag');
    ok(fs.existsSync(path.join(state, 'roll-in-may-sept-2026.json')) && JSON.parse(fs.readFileSync(path.join(state, 'roll-in-may-sept-2026.json'), 'utf8')).created.length === 4, 'roll-in: what it made is recorded in state/');
    r = await roll('--apply');
    ok(r.code === 1 && /already ran/.test(r.stderr) && T('events').size === 7, 'roll-in runs once: a second refuses');
  });

  // ---- tier rules (Alan, 2026-09-24: Maricopa is Elite, always, except the Maricopa County Fair)
  await section('tier rules', async () => {
    const { ruleTier, tierOf } = await import(path.join(REPO, 'scripts/lib/match.mjs'));
    const R = JSON.parse(fs.readFileSync(path.join(REPO, 'config', 'event-check.json'), 'utf8')).tierRules;
    ok(ruleTier('Maricopa County Home & Garden Show', R) === 'Elite' && ruleTier('Maricopa County Fair', R) === null && ruleTier('Maricopa County Fair & Rodeo', R) === null
      && ruleTier('Queen Creek Family Market', R) === null && ruleTier('Maricopan Days', R) === null, 'tier rules: every Maricopa show is Elite except the Maricopa County Fair (whole words only)');
    ok(tierOf({ name: 'Maricopa County Home & Garden Show', tier: 'Traditional' }, R) === 'Elite' && tierOf({ name: 'Maricopa County Fair', tier: 'Key' }, R) === 'Key' && tierOf({ name: 'Corn Fest', tier: 'Traditional' }, R) === 'Traditional',
      'tier rules: a rule wins over the tag on the board; without one the tag stands');
    const PS = await import(path.join(REPO, 'scripts/parse-sheet.mjs'));
    const G = [], row = o => { const r = new Array(27).fill(null); for (const [i, v] of Object.entries(o)) r[+i] = v; G.push(r); };
    const SER = d => Math.round((Date.parse(d + 'T00:00:00Z') - Date.UTC(1899, 11, 30)) / 86400000);
    row({ 2: 'Status', 4: 'header' });
    row({ 1: 'Weekend 09-18' });
    row({ 2: 'Booked', 4: 'Maricopa County Home & Garden Show', 5: 'Saturday', 6: 'Sunday', 12: '100', 13: SER('2026-09-19'), 14: SER('2026-09-20'), 15: 'Phoenix, AZ' });
    row({ 4: 'Shift 1', 5: 'Eli', 6: 'Sarah' });
    row({ 2: 'Booked', 4: 'Maricopa County Fair', 5: 'Saturday', 6: 'Sunday', 12: '100', 13: SER('2026-09-19'), 14: SER('2026-09-20'), 15: 'Phoenix, AZ' });
    row({ 4: 'Shift 1', 5: 'Cameron', 6: '' });
    for (const t of Object.keys(db)) db[t].clear();
    T('settings').set('division', { roster: ['Cameron', 'Eli', 'Sarah', 'Kendall'] });
    const state = path.join(home, 'tier-state'), outd = path.join(home, 'tier-out');
    fs.mkdirSync(state, { recursive: true }); fs.writeFileSync(path.join(state, 'sheet-baseline.json'), '[]');
    const gridFile = path.join(home, 'tier-grid.json'); fs.writeFileSync(gridFile, JSON.stringify(G));
    const vcFile = path.join(home, 'tier-vc.json'); fs.writeFileSync(vcFile, JSON.stringify({ rows: [] }));
    r = await new Promise(res => execFile(process.execPath, [path.join(REPO, 'scripts/sheet-sync.mjs'), '--grid', gridFile, '--vc', vcFile, '--date', '2026-08-01', '--json', '--apply'],
      { env: { PATH: process.env.PATH, HOME: home, BOARD_SUPABASE_URL: base, BOARD_SERVICE_KEY: 'test', BOARD_STATE_DIR: state, BOARD_OUT_DIR: outd } }, (err, stdout, stderr) => res({ code: err ? err.code : 0, stdout, stderr })));
    const made = [...T('events').values()];
    const mc = made.find(e => e.name === 'Maricopa County Home & Garden Show'), fair = made.find(e => e.name === 'Maricopa County Fair');
    ok(r.code === 0 && mc && mc.tier === 'Elite' && fair && fair.tier === 'Traditional', 'sheet-sync: a new Maricopa show is created Elite; the Maricopa County Fair is not: ' + JSON.stringify({ code: r.code, tiers: made.map(e => [e.name, e.tier]), err: r.stderr.slice(0, 200) }));
  });

  // ---- lib/is-main.mjs: "am I the script that was started?" must not depend on how the path was spelled. A Mac's
  // temp folder is reached through a link (/var -> /private/var) and node gives a module its real path, so comparing
  // the two as text made a script started from a staged copy exit 0 having done nothing: the listener's tests failed
  // on the mini from 2026-09-28 to 2026-10-06 and passed on Linux. The link here is made on purpose, so this is
  // checked on any machine.
  await section('lib/is-main.mjs', async () => {
    const { isMain } = await import(path.join(REPO, 'scripts/lib/is-main.mjs'));
    const dir = path.join(home, 'is main'), linked = path.join(home, 'is-main-link');          // a space in the name, and a link to it
    fs.mkdirSync(path.join(dir, 'lib'), { recursive: true }); fs.symlinkSync(dir, linked);
    fs.copyFileSync(path.join(REPO, 'scripts/lib/is-main.mjs'), path.join(dir, 'lib', 'is-main.mjs'));
    fs.writeFileSync(path.join(dir, 'probe.mjs'), "import { isMain } from './lib/is-main.mjs';\nif (isMain(import.meta.url)) console.log('ran');\nexport const loaded = true;\n");
    fs.writeFileSync(path.join(dir, 'importer.mjs'), "import { loaded } from './probe.mjs';\nconsole.log('imported ' + loaded);\n");
    const node = (file, cwd) => new Promise(res => execFile(process.execPath, [file], { cwd }, (err, stdout, stderr) => res({ code: err ? err.code : 0, stdout, stderr })));
    r = await node(path.join(dir, 'probe.mjs')); ok(r.stdout === 'ran\n', 'is-main: started by its full path, a space in a folder name, it runs: ' + r.stdout + r.stderr);
    r = await node(path.join(linked, 'probe.mjs')); ok(r.stdout === 'ran\n', 'is-main: started through a link, it runs: ' + r.stdout + r.stderr);
    r = await node('probe.mjs', linked); ok(r.stdout === 'ran\n', 'is-main: started by a relative path from a linked folder, it runs: ' + r.stdout + r.stderr);
    r = await node(path.join(linked, 'importer.mjs')); ok(r.stdout === 'imported true\n', 'is-main: imported by another script, it does not run: ' + r.stdout + r.stderr);
    ok(isMain(import.meta.url) === true && isMain(import.meta.url, '') === false && isMain(import.meta.url, path.join(REPO, 'scripts/board.mjs')) === false, 'is-main: true for the file node started, false for any other and when nothing was started from a file');
    const byHand = fs.readdirSync(path.join(REPO, 'scripts')).filter(f => f.endsWith('.mjs') && /import\.meta\.url\s*===?/.test(fs.readFileSync(path.join(REPO, 'scripts', f), 'utf8')));
    ok(byHand.length === 0, 'is-main: no script compares import.meta.url to a path by hand: ' + byHand.join(', '));
  });

  // ---- Sync from the Sheet (2026-09-28): the no-VC date hold, the lock, the record, the button's listener
  await section('Sync from the Sheet: the lock, the record, the listener, the hourly sync', async () => {
    const S = await import(path.join(REPO, 'scripts/sheet-sync.mjs'));
    const PS = await import(path.join(REPO, 'scripts/parse-sheet.mjs'));
    const resolve = PS.makeRepResolver(['Cameron', 'Sarah']);
    const ev = (extra = {}) => ({ name: 'Corn Fest', weekend: '2026-09-04', startDate: '2026-09-05', endDate: '2026-09-06', days: ['Saturday', 'Sunday'], dates: ['2026-09-05', '2026-09-06'],
      booths: [{ label: '', days: ['Saturday', 'Sunday'], dates: ['2026-09-05', '2026-09-06'], shifts: [{ label: 'Shift 1', slots: [{ rep: 'Cameron', ft: [] }, { rep: '', ft: [] }] }] }], ...extra });
    const moved = ev({ startDate: '2026-09-06', endDate: '2026-09-06' });
    let p = S.planEvent({ base: ev(), sheet: moved, board: ev({ vcNumber: '00300001', vcStatus: 'Booked' }), resolve, vcRow: null, today: '2026-08-01', noVcPull: true });
    ok(!('startDate' in p.patch) && p.held.length === 1 && /no VC pull/.test(p.held[0]), 'sync, no VC pull: a date moved on a show VC has a record for is held for the Wednesday run');
    p = S.planEvent({ base: ev(), sheet: moved, board: ev({ vcNumber: '', vcStatus: '' }), resolve, vcRow: null, today: '2026-08-01', noVcPull: true });
    ok(p.patch.startDate === '2026-09-06' && !p.held.length, 'sync, no VC pull: a date move on a show VC has no record for is carried');
    p = S.planEvent({ base: ev(), sheet: moved, board: ev({ vcNumber: '00092192', vcStatus: 'Booked' }), resolve, vcRow: null, today: '2026-08-01', noVcPull: true });
    ok(p.patch.startDate === '2026-09-06', 'sync, no VC pull: the placeholder record holds no date');
    const sum = S.syncSummary({ date: '2026-08-01', wrote: true, eventsTouched: 1, slotChanges: 1, applied: Array.from({ length: 50 }, (_, i) => ({ id: 'x' + i, name: 'E' + i, weekend: '2026-09-04', changes: ['a'] })),
      created: [{ id: 'n', name: 'New', weekend: '2026-09-04', staffed: 2, status: 'Booking Request Needed', phone: '(928) 555-0100' }], held: [], conflicts: [], flagged: [], unresolved: [], duplicates: [] });
    ok(sum.applied.length === 40 && sum.counts.applied === 50 && !JSON.stringify(sum).includes('555-0100') && !('id' in sum.created[0]), 'sync record: lists are capped (counts say how many), and nothing but names, weekends and changes goes on it');

    // a small Sheet, a baseline, a board: then the listener, run the way launchd runs it, from a staged copy
    const G = [], row = o => { const r = new Array(27).fill(null); for (const [i, v] of Object.entries(o)) r[+i] = v; G.push(r); };
    const SER = d => Math.round((Date.parse(d + 'T00:00:00Z') - Date.UTC(1899, 11, 30)) / 86400000);
    row({ 2: 'Status', 4: 'header' });
    row({ 1: 'Weekend 09-04' });
    row({ 2: 'Booked', 4: 'Corn Fest', 5: 'Saturday', 6: 'Sunday', 12: '100', 13: SER('2026-09-05'), 14: SER('2026-09-06'), 15: 'Phoenix, AZ' });
    row({ 4: 'Shift 1', 5: 'Cameron', 6: '' });
    const { events: baseEvents } = PS.parseAll(JSON.parse(JSON.stringify(G)), { seasonYear: 2026 });
    const baseline = [{ ...baseEvents[0], id: '2026-corn-fest-b1' }];
    for (const t of Object.keys(db)) db[t].clear();
    { const { id, ...d } = baseline[0]; T('events').set(id, { ...JSON.parse(JSON.stringify(d)), year: 2026, vcNumber: '', vcStatus: '' }); }
    T('settings').set('division', { roster: ['Cameron', 'Sarah'] });
    G[3][6] = 'Sarah';                                              // the team adds a rep on the Sheet
    const state = path.join(home, 'btn-state'), outd = path.join(home, 'btn-out');
    fs.mkdirSync(state, { recursive: true }); fs.writeFileSync(path.join(state, 'sheet-baseline.json'), JSON.stringify(baseline));
    const gridFile = path.join(home, 'btn-grid.json'); fs.writeFileSync(gridFile, JSON.stringify(G));
    const stage2 = path.join(home, 'stage-sync');
    fs.cpSync(path.join(REPO, 'scripts'), path.join(stage2, 'scripts'), { recursive: true });
    fs.cpSync(path.join(REPO, 'config'), path.join(stage2, 'config'), { recursive: true });
    const stageCfg = path.join(stage2, 'config', 'event-check.json');
    const setAuto = auto => { const c = JSON.parse(fs.readFileSync(stageCfg, 'utf8')); c.sync.auto = auto; fs.writeFileSync(stageCfg, JSON.stringify(c)); };
    setAuto(null);                                                  // the button first; the hourly sync has its own tests below
    const env = { PATH: process.env.PATH, HOME: home, BOARD_SUPABASE_URL: base, BOARD_SERVICE_KEY: 'test', BOARD_STATE_DIR: state, BOARD_OUT_DIR: outd, BOARD_SYNC_LOCK_WAIT_MS: '0' };
    const listen = (grid = gridFile) => new Promise(res => execFile(process.execPath, [path.join(stage2, 'scripts/sync-requests.mjs'), '--', '--grid', grid, '--date', '2026-08-01'],
      { env }, (err, stdout, stderr) => res({ code: err ? err.code : 0, stdout, stderr })));
    const ring = (extra = {}) => { const id = ++flatId; T('sheet_syncs').set(id, { id, requested_at: new Date().toISOString(), requested_by: 'matt@example.com', status: 'pending', started_at: null, finished_at: null, result: null, ...extra }); return id; };
    const rowOf = id => T('sheet_syncs').get(id);

    // "prints nothing, writes nothing" is also what a listener that never started looks like (2026-09-28 to 10-06,
    // lib/is-main.mjs), so the one read is counted: silence only passes when it really asked the board.
    let reads = flatReads;
    r = await listen();
    ok(r.code === 0 && r.stdout === '' && r.stderr === '' && T('sheet_syncs').size === 0 && flatReads - reads === 1, `listener: nobody pressed Sync, so it reads once (${flatReads - reads}), prints nothing, writes nothing: ` + r.stdout + r.stderr);

    fs.writeFileSync(path.join(stage2, 'PAUSED'), '');
    const a = ring(); reads = flatReads;
    r = await listen();
    ok(r.code === 0 && rowOf(a).status === 'pending' && T('events').get('2026-corn-fest-b1').booths[0].shifts[0].slots[1].rep === '' && flatReads === reads, 'listener: PAUSED leaves the request waiting and the board alone (not even a read)');
    fs.rmSync(path.join(stage2, 'PAUSED'));

    fs.writeFileSync(path.join(state, 'sheet-sync.lock'), JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    r = await listen();
    ok(r.code === 0 && rowOf(a).status === 'pending' && rowOf(a).started_at === null && /another sync was running/.test(r.stdout), 'listener: while another sync holds the lock, the request goes back to waiting: ' + r.stdout + r.stderr);
    fs.writeFileSync(path.join(state, 'sheet-sync.lock'), JSON.stringify({ pid: 999999, at: new Date().toISOString() }));   // a sync that died

    const b = ring();
    r = await listen();
    const ra = rowOf(a), rb = rowOf(b);
    ok(r.code === 0 && ra.status === 'done' && rb.status === 'done' && ra.result.eventsTouched === 1 && ra.result.slotChanges === 1 && ra.result.noVcPull === true,
      'listener: two presses are one sync, and both rows get its result: ' + JSON.stringify([ra.status, rb.status, ra.result]) + r.stderr.slice(0, 300));
    ok(T('events').get('2026-corn-fest-b1').booths[0].shifts[0].slots[1].rep === 'Sarah', 'listener: the Sheet\'s new rep is on the board');
    ok(actors.has('service:sheet-sync:button'), 'listener: the changelog says the button did it: ' + [...actors].join(', '));
    ok(T('sheet_syncs').size === 2 && fs.existsSync(path.join(outd, 'reports', `sheet-sync-2026-08-01-req${a}.json`)), 'listener: no extra record row, and the report is named for the request (the Wednesday report is not overwritten)');
    ok(!fs.existsSync(path.join(state, 'sheet-sync.lock')), 'listener: a lock left by a dead sync is taken over, then released');
    ok(new RegExp(`requests ${a},${b} \\(matt@example\\.com\\): written, 1 event\\(s\\), 1 shift change`).test(r.stdout), 'listener: one log line per sync, naming who asked: ' + r.stdout);

    const c = ring();
    r = await listen(path.join(home, 'no-such-grid.json'));
    ok(r.code === 0 && rowOf(c).status === 'failed' && /no-such-grid/.test(rowOf(c).result.error), 'listener: a sync that fails marks the request failed, with the reason: ' + JSON.stringify(rowOf(c)));

    const d = ring({ status: 'running', started_at: new Date(Date.now() - 20 * 60000).toISOString() });
    r = await listen();
    ok(r.code === 0 && rowOf(d).status === 'failed' && /interrupted/.test(rowOf(d).result.error), 'listener: a request left running by a restart is marked failed, not left spinning on the page');

    const e1 = ring({ status: 'running', started_at: new Date().toISOString() }), e2 = ring();
    r = await listen();
    ok(r.code === 0 && rowOf(e2).status === 'pending', 'listener: while a sync is under way, a new press waits for the next look');
    T('sheet_syncs').delete(e1);

    r = await new Promise(res => execFile(process.execPath, [path.join(stage2, 'scripts/sync-requests.mjs')], { env: { ...env, BOARD_SUPABASE_URL: 'http://127.0.0.1:9' } }, (err, stdout, stderr) => res({ code: err ? err.code : 0, stdout, stderr })));
    const r2 = await new Promise(res => execFile(process.execPath, [path.join(stage2, 'scripts/sync-requests.mjs')], { env: { ...env, BOARD_SUPABASE_URL: 'http://127.0.0.1:9' } }, (err, stdout, stderr) => res({ code: err ? err.code : 0, stdout, stderr })));
    ok(r.code === 1 && /sync-requests:/.test(r.stderr) && r2.code === 1 && r2.stderr === '', 'listener: the board unreachable is said once, not every 30 seconds: ' + r.stderr + '|' + r2.stderr);
    r = await listen();
    ok(r.code === 0 && /reachable again/.test(r.stdout), 'listener: and it says when the board is back');

    // ---- the hourly sync (Alan, 2026-09-28): on from config sync.auto.from, 7am-9pm Phoenix, an hour after the last run
    const SR = await import(path.join(REPO, 'scripts/sync-requests.mjs'));
    const AUTO = JSON.parse(fs.readFileSync(path.join(REPO, 'config', 'event-check.json'), 'utf8')).sync.auto;
    ok(AUTO && AUTO.from === '2026-10-15' && AUTO.everyMinutes === 60 && JSON.stringify(AUTO.hours) === '[7,21]', 'hourly sync: configured to start 2026-10-15, hourly, 7am-9pm');
    const at = s => Date.parse(s), ago = (s, min) => new Date(at(s) - min * 60000).toISOString();
    ok(JSON.stringify(SR.phoenix(at('2026-10-20T14:30:00Z'))) === '{"date":"2026-10-20","hour":7}' && SR.phoenix(at('2026-10-16T03:30:00Z')).date === '2026-10-15', 'hourly sync: Phoenix date and hour (UTC-7, no daylight saving)');
    const why = (now, last = null, auto = AUTO) => SR.autoWhyNot({ auto, last, now: at(now) });
    ok(why('2026-10-14T20:00:00Z') === 'off until 2026-10-15' && why('2026-10-15T13:59:00Z') === 'outside hours' && why('2026-10-15T14:00:00Z') === '' && why('2026-10-16T04:00:00Z') === 'outside hours',
      'hourly sync: nothing before the start date, nothing before 7am or from 9pm, due at 7am on the first day');
    ok(why('2026-10-20T18:00:00Z', { status: 'done', finished_at: ago('2026-10-20T18:00:00Z', 30) }) === 'synced recently' && why('2026-10-20T18:00:00Z', { status: 'failed', finished_at: ago('2026-10-20T18:00:00Z', 61) }) === '',
      'hourly sync: not within an hour of the last run (a button press counts), and a failed run is retried an hour later');
    ok(/paused/.test(why('2026-10-20T18:00:00Z', { status: 'stopped', finished_at: ago('2026-10-20T18:00:00Z', 300) })) && why('2026-10-20T18:00:00Z', null, null) === 'off' && why('2026-10-20T18:00:00Z', null, { from: null }) === 'off',
      'hourly sync: a run that stopped pauses it until a sync gets through; null turns it off');

    T('sheet_syncs').clear();
    setAuto({ from: '2000-01-01', everyMinutes: 60, hours: [0, 24] });   // any hour: the clock of the day the tests run must not matter
    G[3][5] = '';                                                   // on the Sheet, Cameron comes off Saturday
    fs.writeFileSync(gridFile, JSON.stringify(G));
    r = await listen();
    let autos = [...T('sheet_syncs').values()];
    ok(r.code === 0 && autos.length === 1 && autos[0].requested_by === 'service:sheet-sync:auto' && autos[0].status === 'done' && autos[0].result.eventsTouched === 1 && /hourly sync: written, 1 event/.test(r.stdout),
      'hourly sync: with nobody pressing, it runs by itself, records itself, and logs one line: ' + r.stdout + r.stderr.slice(0, 200) + JSON.stringify(autos.map(x => [x.requested_by, x.status])));
    ok(T('events').get('2026-corn-fest-b1').booths[0].shifts[0].slots[0].rep === '' && actors.has('service:sheet-sync:auto'), 'hourly sync: the Sheet\'s change is on the board, and the changelog says the hourly sync did it');
    r = await listen();
    ok(r.code === 0 && r.stdout === '' && T('sheet_syncs').size === 1, 'hourly sync: not again within the hour');
    autos[0].finished_at = new Date(Date.now() - 2 * 3600000).toISOString();
    r = await listen();
    autos = [...T('sheet_syncs').values()];
    ok(r.code === 0 && autos.length === 2 && autos[1].status === 'done' && autos[1].result.eventsTouched === 0, 'hourly sync: an hour later it runs again (already up to date)');
    autos[1].status = 'stopped'; autos[1].finished_at = new Date(Date.now() - 2 * 3600000).toISOString();
    r = await listen();
    ok(r.code === 0 && T('sheet_syncs').size === 2, 'hourly sync: after a run that stopped, it waits for a person');
    const p1 = ring();
    r = await listen();
    ok(r.code === 0 && rowOf(p1).status === 'done' && T('sheet_syncs').size === 3, 'hourly sync: a press still goes through while it is paused, and that sync is the only run');
    r = await listen();
    ok(r.code === 0 && T('sheet_syncs').size === 3, 'hourly sync: the press counts as the latest sync, so the hour starts over');
  });

  // ---- event-check end to end: write-back rules, Mesa, the past, the placeholder, the safety refusal
  await section('event-check end to end', async () => {
    for (const t of Object.keys(db)) db[t].clear();
    const e = (id, name, weekend, reps, extra = {}) => T('events').set(id, { year: 2026, name, weekend, startDate: weekend, endDate: weekend, days: ['Friday'], dates: [weekend],
      booths: [{ label: '', days: ['Friday'], dates: [weekend], shifts: [{ label: 'Shift 1', slots: reps.map(r => ({ rep: r, ft: [] })) }] }], status: 'Booked', ...extra });
    e('2026-a', 'Alpha Days', '2026-10-09', ['Eli'], { vcNumber: '00300001', vcStatus: 'OK to Book - Need Contract', status: 'OK to Book - Need Contract', cost: '$300', costNum: 300, costBasis: 'date' });
    e('2026-b', 'Graham County Fair', '2026-10-09', ['Sarah'], { status: 'Prospective' });
    e('2026-c', 'Mesa Market Place Swapmeet', '2026-10-09', ['Reed']);
    e('2026-d', 'Past Show', '2026-09-11', ['Eli'], { vcNumber: '00300004', vcStatus: 'Booked', status: 'Booked' });
    e('2026-e', 'Queen Creek Family Market-November', '2026-11-13', ['Kendall'], { vcNumber: '00092192', vcStatus: 'Booked', status: 'Booked', dates: ['2026-11-14'], days: ['Saturday'] });
    e('2026-f', 'Beta Fest', '2026-10-16', ['Cameron'], { vcNumber: '00300006', vcStatus: 'Booked', status: 'Booked' });
    e('2026-k', 'Cochise County Fair', '2026-10-02', ['J. Parker'], { vcNumber: '00300011', vcStatus: 'OK to Book - Need Contract', status: 'OK to Book - Need Contract' });
    e('2026-l', 'Lambda Market', '2026-11-20', ['Eli'], { status: 'Booking Request Submitted', vcRequestedAt: '2026-09-28' });
    e('2026-m', 'Mu Pageant', '2026-11-27', ['Sarah'], { status: 'Booking Request Submitted', vcRequestedAt: '2026-09-01' });
    e('2026-n', 'Nu Artisan Fair', '2026-09-18', ['Adam'], { startDate: '2026-10-20', endDate: '2026-10-20', vcNumber: '00300012', vcStatus: 'Promoter Cancelled Event', status: 'Cancelled', dead: true });
    e('2026-o', 'Omicron Balloon Fest', '2026-10-23', ['Sarah'], { startDate: '2025-10-24', endDate: '2025-10-26', vcNumber: '00300013', vcStatus: 'Booked', status: 'Booked', days: ['Friday', 'Saturday', 'Sunday'], dates: ['2026-10-23', '2026-10-24', '2026-10-25'] });
    // Mesa: VC keeps one record per calendar month, the board one per weekend (Alan, 2026-10-14: "Mesa should be listed as an event")
    const fss = ['Friday', 'Saturday', 'Sunday'];
    e('2026-p', 'Mesa Market Place Swapmeet', '2026-10-30', ['Foss'], { days: fss, dates: ['2026-10-30', '2026-10-31', '2026-11-01'], endDate: '2026-11-01' });
    e('2026-q', 'Mesa Market Place Swapmeet', '2026-12-11', ['Sean'], { days: fss, dates: ['2026-12-11', '2026-12-12', '2026-12-13'] });
    e('2026-r', 'Mesa Market Place Swapmeet', '2026-11-13', ['Kendall'], { days: fss, dates: ['2026-11-13', '2026-11-14', '2026-11-15'], vcNumber: '00300099', vcMonths: [{ from: 'x' }] });
    // booked in VC, not on the board (Alan, 2026-10-26): unstaffed board shows count too; a show on another weekend is named
    e('2026-s', 'Sigma Art Walk', '2026-12-18', [], { status: 'Prospective' });
    e('2026-t', 'Tau Craft Fair', '2026-11-06', [], { status: 'Prospective' });
    T('kiosks').set('2026-arrowhead', { name: 'Arrowhead', year: 2026, status: 'Prospective', startDate: '2026-11-27', endDate: '2026-12-28', shifts: {} });
    const filler = Array.from({ length: 22 }, (_, i) => ({ eventNumber: String(310000 + i), name: `Filler Show ${String.fromCharCode(65 + i)}`, status: 'Booked', startDate: '2026-12-0' + (1 + (i % 9)), endDate: '2026-12-0' + (1 + (i % 9)) }));
    const rows = [
      { eventNumber: '00300001', name: 'Alpha Days', status: 'Booked', startDate: '2026-10-09', endDate: '2026-10-11', eventCost: 450.4 },
      { eventNumber: '00300002', name: 'Graham County Fair', status: 'Pending Promoter - Acceptance into Event', startDate: '2026-10-08', endDate: '2026-10-11' },
      { eventNumber: '00300004', name: 'Past Show', status: 'Closed', startDate: '2026-09-11', endDate: '2026-09-13', eventCost: 200 },
      { eventNumber: '00092192', name: 'Queen Creek Family Market 11/1', status: 'Booked', startDate: '2026-11-01', endDate: '2026-11-30' },
      { eventNumber: '00300006', name: 'Beta Fest', status: 'Promoter Cancelled Event', startDate: '2026-10-16', endDate: '2026-10-18' },
      { eventNumber: '00300011', name: 'Cochise County Fair', status: 'OK to Book - Need Contract', startDate: '2026-10-01', endDate: '2026-10-04' },
      { eventNumber: '00300012', name: 'Nu Artisan Fair', status: 'Promoter Cancelled Event', startDate: '2026-09-18', endDate: '2026-09-20' },
      { eventNumber: '00300013', name: 'Omicron Balloon Fest', status: 'Booked', startDate: '2026-10-23', endDate: '2026-10-25' },
      { eventNumber: '00300020', name: 'Mesa Market Place Swapmeet - October', status: 'Booked', startDate: '2026-10-01', endDate: '2026-10-31', eventCost: 2089 },
      { eventNumber: '00300021', name: 'Mesa Market Place Swapmeet - November', status: 'Prospective', startDate: '2026-11-01', endDate: '2026-11-30' },
      { eventNumber: '00300030', name: 'Zeta Home Show', status: 'Booked', startDate: '2026-11-06', endDate: '2026-11-08', city: 'Glendale', location: 'State Farm Stadium', eventCost: 11668.05 },
      { eventNumber: '00300031', name: 'Sigma Art Walk', status: 'Booked - Needs Insurance', startDate: '2026-11-27', endDate: '2026-11-29' },
      { eventNumber: '00300032', name: 'Gilbert Service & Sales Event @ Desert Monks', status: 'Booked', startDate: '2026-11-16', endDate: '2026-11-16' },
      { eventNumber: '00300033', name: 'Arrowhead Towne Center', status: 'Booked', startDate: '2026-11-24', endDate: '2026-12-28', location: 'Arrowhead Towne Center' },
      { eventNumber: '00300034', name: 'Tau Craft Fair', status: 'Booked', startDate: '2026-11-06', endDate: '2026-11-07' },
      { eventNumber: '00300035', name: 'Old Expo', status: 'Booked', startDate: '2026-09-01', endDate: '2026-09-02' },
      { eventNumber: '00300036', name: 'Upsilon Expo', status: 'Prospective', startDate: '2026-11-13', endDate: '2026-11-14' },
      { eventNumber: '00300037', name: 'Mecum Kansas City', status: 'Booked', startDate: '2026-12-03', endDate: '2026-12-05', city: 'Kansas City', state: 'MO' },
      { eventNumber: '00300038', name: 'Laughlin River Run', status: 'Booked', startDate: '2026-11-20', endDate: '2026-11-22', city: 'Laughlin', state: 'NV' },
      { eventNumber: '00300039', name: 'Houston Home Show', status: 'Booked', startDate: '2026-11-20', endDate: '2026-11-22', city: 'Houston', state: 'TX' },
      { eventNumber: '00300040', name: 'El Paso Winter Expo', status: 'Booked', startDate: '2026-11-20', endDate: '2026-11-22', city: 'El Paso', state: 'TX' },
      { eventNumber: '00300041', name: 'Las Cruces Craft Fair', status: 'Booked', startDate: '2026-11-20', endDate: '2026-11-21', city: 'Las Cruces', state: 'NM' },
      ...filler];
    const vcFile = path.join(home, 'ec-vc.json'); fs.writeFileSync(vcFile, JSON.stringify({ coordinator: 'Matt Foss', rows }));
    const outd = path.join(home, 'ec-out');
    const ec = (...a) => new Promise(res => execFile(process.execPath, [path.join(REPO, 'scripts/event-check.mjs'), ...a],
      { env: { PATH: process.env.PATH, HOME: home, BOARD_SUPABASE_URL: base, BOARD_SERVICE_KEY: 'test', BOARD_OUT_DIR: outd } }, (err, stdout, stderr) => res({ code: err ? err.code : 0, stdout, stderr })));
    r = await ec('--window', '--date', '2026-10-01');
    const win = JSON.parse(r.stdout);
    ok(r.code === 0 && win.from < '2026-09-11' && win.to > '2026-11-14', 'event-check --window covers every event in scope with room: ' + r.stdout);
    const rulingsFile = path.join(home, 'ec-rulings.json');
    fs.writeFileSync(rulingsFile, JSON.stringify({ rulings: [{ event: 'Cochise County Fair', from: '2026-09-25', to: '2026-10-10', ruling: 'not-worked', note: 'we could not get in', repReason: "we couldn't get in" },
      { event: 'Alpha Days', from: '2026-10-01', to: '2026-10-31', ruling: 'not-worked', rep: 'eli-camacho', note: 'rep-scoped: does not kill the show' }] }));
    r = await ec('--vc', vcFile, '--apply', '--date', '2026-10-01', '--rulings', rulingsFile);
    ok(r.code === 0, 'event-check --apply exits 0: ' + r.stderr.slice(0, 300));
    const A = T('events').get('2026-a'), B = T('events').get('2026-b'), C = T('events').get('2026-c'), D = T('events').get('2026-d'), E = T('events').get('2026-e'), F = T('events').get('2026-f');
    ok(A.vcStatus === 'Booked' && A.status === 'Booked' && A.vcCheckedAt === '2026-10-01', 'event-check: a status change is written in VC\'s words and the board\'s');
    ok(B.vcNumber === '00300002' && B.status === 'Pending Promoter Acceptance', 'event-check: a name match gets its VC number and status');
    ok(C.vcNumber === '00300020' && C.vcStatus === 'Booked' && C.vcCheckedAt === '2026-10-01' && C.status === 'Booked' && C.cost === undefined && C.vcMonths === undefined,
      'event-check: a Mesa weekend gets its month\'s VC number and status, and nothing else');
    const P = T('events').get('2026-p'), Q = T('events').get('2026-q'), Rm = T('events').get('2026-r');
    ok(P.vcNumber === '00300020' && P.vcStatus === 'Booked' && JSON.stringify(P.vcMonths) === JSON.stringify([
      { from: '2026-10-30', to: '2026-10-31', vcNumber: '00300020', vcStatus: 'Booked' }, { from: '2026-11-01', to: '2026-11-01', vcNumber: '00300021', vcStatus: 'Prospective' }]),
      'event-check: a Mesa weekend that runs into the next month carries both months, day by day: ' + JSON.stringify(P.vcMonths));
    ok(!Q.vcCheckedAt && !Q.vcNumber, 'event-check: a Mesa weekend whose month has no VC record yet is left alone');
    ok(Rm.vcNumber === '00300021' && Rm.vcStatus === 'Prospective' && Rm.status === 'Booked' && Rm.vcMonths === null,
      'event-check: a wrong Mesa number is corrected, the board status Alan set is kept, and a stale month split is cleared');
    const ecMd = fs.readFileSync(path.join(outd, 'reports', 'event-check-2026-10-01.md'), 'utf8');
    ok(/Mesa Swapmeet: 3 weekend\(s\) carry their month's VectorConnect number/.test(ecMd) && /November 00300021 is Prospective/.test(ecMd) && /No VectorConnect Mesa record yet for December 2026 \(1 weekend\)/.test(ecMd),
      'event-check: the report says which Mesa months VC has, which are not Booked, and which weekends have no month yet');
    ok(A.cost === '$450' && A.costNum === 450 && A.costSource === 'VC' && A.costWas === '$300', 'event-check: VC\'s Event Cost replaces the board\'s, in whole dollars, and the old one is kept beside it');
    ok(D.cost === '$200' && D.costNum === 200 && D.costSource === 'VC', 'event-check: a finished show gets VC\'s cost too');
    ok(B.cost === undefined && F.cost === undefined, 'event-check: a VC record with no cost yet leaves the board\'s cost alone');
    ok(D.vcStatus === 'Closed' && D.status === 'Booked' && !D.dead, 'event-check: a finished show VC has closed out stays Booked, not Cancelled');
    ok(!E.vcCheckedAt && E.status === 'Booked', 'event-check: a placeholder-only date is not written either way');
    ok(F.dead === true && F.status === 'Cancelled', 'event-check: a show VC cancelled is marked dead');
    const K = T('events').get('2026-k');
    ok(K.dead === true && K.status === 'Cancelled' && K.vcStatus === 'OK to Book - Need Contract', 'event-check: Alan\'s not-worked ruling kills the show whatever VC still says, and VC\'s status is kept beside it');
    ok(A.status === 'Booked' && !A.dead, 'event-check: a rep-scoped ruling never kills the show');
    const latest = JSON.parse(fs.readFileSync(path.join(outd, 'event-check', 'latest.json'), 'utf8'));
    ok(latest.headline.deadWithReps === 2 && latest.headline.openQuestions === 1 && latest.written, 'event-check: the headline counts the dead shows and the open question');
    const ecNu = latest.events.find(x => x.id === '2026-n'), ecOmicron = latest.events.find(x => x.id === '2026-o');
    ok(ecNu.upcoming === false && ecNu.lastDay === '2026-09-18', 'event-check: a finished show with a stale End Date cell weeks later is past, so it never reaches JP\'s list or a rep (Pinetop-Lakeside, 2026-10-14)');
    ok(ecOmicron.upcoming === true && ecOmicron.lastDay === '2026-10-25', 'event-check: a show still carrying last year\'s Start/End Date is upcoming');
    ok(latest.flags.dateCellsOff.map(x => x.id).sort().join() === '2026-n,2026-o' && /disagrees with the show's own days[^]*Omicron Balloon Fest: days Oct 23-25, Start 2025-10-24, End 2025-10-26/.test(fs.readFileSync(path.join(outd, 'reports', 'event-check-2026-10-01.md'), 'utf8')),
      'event-check: the report names every row whose Start/End Date cells were set aside, with what they say');
    ok(latest.costs.changed.length === 2 && latest.costs.changed.some(x => x.name === 'Alpha Days' && x.from === '$300' && x.to === '$450') && /Costs set from VectorConnect \(2\)/.test(fs.readFileSync(path.join(outd, 'reports', 'event-check-2026-10-01.md'), 'utf8')), 'event-check: the report lists every cost it set from VC');
    ok(latest.flags.ruledOff.length === 1 && latest.events.find(x => x.id === '2026-k').ruling.reason === "we couldn't get in", 'event-check: the ruling travels to the texts with its reason');
    const vcOnly = latest.flags.bookedNotOnBoard.filter(x => !/^Filler/.test(x.name)), byNum = n => vcOnly.find(x => x.vcNumber === n);
    ok(byNum('00300030') && !byNum('00300030').board && byNum('00300030').cost === 11668 && byNum('00300030').location === 'State Farm Stadium',
      'event-check: an upcoming show VC has Booked that no board show claims is listed, with where and what it costs: ' + JSON.stringify(vcOnly));
    ok(byNum('00300031') && byNum('00300031').board && byNum('00300031').board.id === '2026-s' && byNum('00300031').board.weekend === '2026-12-18',
      'event-check: "Booked - ..." counts, and a show the board has on another weekend is named beside it (a date to fix, not a show to add)');
    ok(!byNum('00300034') && !byNum('00300032') && !byNum('00300033') && !byNum('00300035') && !byNum('00300036') && !byNum('00300020') && !byNum('00300013') && !byNum('00092192'),
      'event-check: never listed: a show the board has unstaffed (by name and date), a Service & Sales event (config vcOnlyOk), a mall kiosk, a past show, a show VC has not booked, Mesa, anything the board claims');
    ok(!byNum('00300037') && !byNum('00300038') && !byNum('00300039') && byNum('00300040') && byNum('00300041'),
      'event-check: only the division is listed: Arizona, New Mexico and El Paso, not Missouri, Nevada or the rest of Texas (Alan, 2026-10-26)');
    ok(vcOnly.length === 4 && latest.flags.bookedNotOnBoard.length === 4 + filler.length, 'event-check: nothing else is listed (the filler rows, no state, are booked shows the board does not have)');
    const ecMd2 = fs.readFileSync(path.join(outd, 'reports', 'event-check-2026-10-01.md'), 'utf8');
    ok(/## Booked in VectorConnect, not on the board[^]*Nov 6-8 Zeta Home Show \(00300030, Booked, State Farm Stadium, Glendale, \$11,668\)/.test(ecMd2)
      && /## Booked in VectorConnect, on the board on another weekend[^]*Sigma Art Walk[^]*the board has Sigma Art Walk on 2026-12-18, Prospective/.test(ecMd2), 'event-check: the report has both lists');
    ok(!JSON.stringify(latest).includes('555-'), 'event-check: the result carries no contact data');
    ok(T('events').get('2026-l').status === 'Booking Request Submitted' && latest.events.find(x => x.id === '2026-l').requestPending === true, 'event-check: a booking request inside 14 days keeps "Booking Request Submitted" (it is with Olean)');
    ok(T('events').get('2026-m').status === 'Booking Request Needed' && latest.flags.staleRequests.some(x => x.id === '2026-m'), 'event-check: a request with no VC record after 14 days goes back to "Booking Request Needed" and is flagged');
    ok(latest.headline.requestsPending === 1 && !latest.events.find(x => x.id === '2026-l').notes.join().includes('stale'), 'event-check: the headline counts requests with Olean apart from shows with no booking');
    const { boardStatus } = await import(path.join(REPO, 'scripts/parse-sheet.mjs'));
    ok(boardStatus('Request to Book', '', 1).status === 'Booking Request Submitted', 'event-check: VC\'s "Request to Book" reads as Booking Request Submitted on the board');
    // a pull that lacks the numbers the board already has must not be trusted
    T('events').set('2026-g', { ...T('events').get('2026-f'), name: 'Gamma', vcNumber: '00300099', dead: false, status: 'Booked', vcCheckedAt: undefined });
    T('events').set('2026-h', { ...T('events').get('2026-f'), name: 'Delta', vcNumber: '00300098', dead: false, status: 'Booked', vcCheckedAt: undefined });
    T('events').set('2026-i', { ...T('events').get('2026-f'), name: 'Epsilon', vcNumber: '00300097', dead: false, status: 'Booked', vcCheckedAt: undefined });
    T('events').set('2026-j', { ...T('events').get('2026-f'), name: 'Zeta', vcNumber: '00300096', dead: false, status: 'Booked', vcCheckedAt: undefined });
    r = await ec('--vc', vcFile, '--apply', '--date', '2026-10-01');
    ok(r.code === 5 && !T('events').get('2026-g').vcCheckedAt, 'event-check: when the pull is missing the board\'s VC numbers, it refuses to write (exit 5)');
    fs.writeFileSync(vcFile, JSON.stringify({ rows: rows.slice(0, 3) }));
    r = await ec('--vc', vcFile, '--apply', '--date', '2026-10-01');
    ok(r.code === 4, 'event-check: a VC pull too small to judge against exits 4 and writes nothing');
  });

  // ---- fill-dates: a blank Start Date comes from the show's own days, then VC, then a page online (Alan, 2026-10-06)
  {
    for (const t of Object.keys(db)) db[t].clear();
    const ev = (id, name, weekend, dates, extra = {}) => T('events').set(id, { year: 2026, name, weekend, startDate: '', endDate: '', days: dates.map(() => 'Saturday'), dates,
      booths: [{ label: '', days: dates.map(() => 'Saturday'), dates, shifts: [{ label: 'Shift 1', slots: dates.map(() => ({ rep: 'Eli', ft: [] })) }] }], status: 'Booked', ...extra });
    ev('2026-days', 'Own Days Fair', '2026-10-09', ['2026-10-09', '2026-10-10']);
    ev('2026-vc', 'VC Only Fest', '2026-10-16', [], { vcNumber: '00400001' });
    ev('2026-web', 'Search Me Harvest Fest', '2026-10-23', []);
    ev('2026-golf', 'Fall Golf Tournament', '2026-10-23', []);
    ev('2026-x', 'x', '2026-10-23', []);
    ev('2026-elite', 'Maricopa County Something', '2026-10-30', []);
    ev('2026-has', 'Already Dated', '2026-10-09', ['2026-10-09'], { startDate: '2026-10-09', endDate: '2026-10-09' });
    const vcFile = path.join(home, 'fd-vc.json'); fs.writeFileSync(vcFile, JSON.stringify({ rows: [{ eventNumber: '00400001', name: 'VC Only Fest', status: 'Booked', startDate: '2026-10-16', endDate: '2026-10-18' }] }));
    const outd = path.join(home, 'fd-out'), tgt = path.join(home, 'fd-targets.json');
    const fd = (...a) => new Promise(res => execFile(process.execPath, [path.join(REPO, 'scripts/fill-dates.mjs'), '--vc', vcFile, '--date', '2026-10-06', '--skip-names', 'golf,builder', '--skip-tiers', 'Elite', ...a],
      { env: { PATH: process.env.PATH, HOME: home, BOARD_SUPABASE_URL: base, BOARD_SERVICE_KEY: 'test', BOARD_OUT_DIR: outd } }, (err, stdout, stderr) => res({ code: err ? err.code : 0, stdout, stderr })));
    r = await fd('--targets-out', tgt);
    ok(r.code === 0 && T('events').get('2026-days').startDate === '', 'fill-dates: a dry run writes nothing: ' + r.stderr.slice(0, 200));
    r = await fd('--apply', '--targets-out', tgt);
    const D = id => T('events').get(id);
    ok(r.code === 0 && D('2026-days').startDate === '2026-10-09' && D('2026-days').endDate === '2026-10-10' && D('2026-days').startDateSource === 'sheet-days' && !D('2026-days').datesNote, 'fill-dates: the show\'s own day columns fill a blank Start Date, with no "checked" note');
    ok(D('2026-vc').startDate === '2026-10-16' && D('2026-vc').endDate === '2026-10-18' && D('2026-vc').datesSource.basis === 'vc', 'fill-dates: no days on the row, so VC\'s dates, marked as VC dates');
    const targets = JSON.parse(fs.readFileSync(tgt, 'utf8'));
    ok(targets.count === 1 && targets.targets[0].id === '2026-web' && targets.mode === 'dates', 'fill-dates: only the show nothing answers goes to the search');
    const latest = JSON.parse(fs.readFileSync(path.join(outd, 'fill-dates', 'latest.json'), 'utf8'));
    ok(latest.skipped.some(x => x.id === '2026-golf' && /golf/.test(x.why)) && latest.skipped.some(x => x.id === '2026-x') && latest.skipped.some(x => x.id === '2026-elite' && /Elite/.test(x.why)) && D('2026-golf').startDate === '',
      'fill-dates: golf, a junk row name and an Elite show are never searched, and stay blank');
    ok(D('2026-has').startDateSource === undefined, 'fill-dates: a show that has its dates is not touched');
    const resFile = path.join(home, 'fd-res.json');
    fs.writeFileSync(resFile, JSON.stringify({ cost: 0.5, results: { '2026-web': { ok: true, result: { dates: { found: true, start: '2026-10-24', end: '2026-10-25', confidence: 'official', sourceUrl: 'https://searchmefest.example/dates', evidence: 'October 24-25, 2026' } } } } }));
    r = await fd('--apply', '--research', resFile);
    ok(r.code === 0 && D('2026-web').startDate === '2026-10-24' && D('2026-web').endDate === '2026-10-25' && D('2026-web').datesSource.basis === 'researched' && /searchmefest\.example/.test(D('2026-web').datesNote), 'fill-dates: a date a page states fills it, with the page named');
    T('events').get('2026-web').startDate = ''; T('events').get('2026-web').endDate = '';
    fs.writeFileSync(resFile, JSON.stringify({ results: { '2026-web': { ok: true, result: { dates: { found: false } } } } }));
    r = await fd('--apply', '--research', resFile);
    ok(D('2026-web').startDate === '' && JSON.parse(fs.readFileSync(path.join(outd, 'fill-dates', 'latest.json'), 'utf8')).unfound.length === 1, 'fill-dates: a show no page dates stays blank and is listed');
    fs.writeFileSync(resFile, JSON.stringify({ results: { '2026-web': { ok: true, result: { dates: { found: true, start: '2027-02-20', end: '2027-02-21', confidence: 'official', sourceUrl: 'https://searchmefest.example/next', evidence: 'February 20-21, 2027' } } } } }));
    r = await fd('--apply', '--research', resFile);
    ok(D('2026-web').startDate === '' && /not this row's weekend/.test(JSON.parse(fs.readFileSync(path.join(outd, 'fill-dates', 'latest.json'), 'utf8')).unfound[0].why), 'fill-dates: a page that dates ANOTHER edition of the show (months from the row\'s weekend) is never written');
    const FDm = await import(path.join(REPO, 'scripts/fill-dates.mjs'));
    const rec = FDm.recentFills([{ id: 'a', name: 'New', weekend: '2026-10-09', startDate: '2026-10-09', endDate: '2026-10-10', startDateSource: 'sheet-days', startDateFilledAt: '2026-10-06' },
      { id: 'b', name: 'Old', startDate: '2026-09-01', endDate: '2026-09-02', startDateSource: 'vc', startDateFilledAt: '2026-09-20' }, { id: 'c', name: 'Typed by hand', startDate: '2026-10-12', endDate: '2026-10-12' }], '2026-10-07');
    ok(rec.length === 1 && rec[0].id === 'a' && rec[0].source === 'sheet-days', 'fill-dates: the weekly list is the fills of the last 7 days, read from the board; a date typed in the Sheet is not a fill');
    ok(Array.isArray(JSON.parse(fs.readFileSync(path.join(outd, 'fill-dates', 'latest.json'), 'utf8')).recent), 'fill-dates: every run records the recent fills');
    ok(FDm.webRun({ ok: true, result: { dates: { found: true, start: '2026-10-24', end: '2026-10-25', confidence: 'official', sourceUrl: '', evidence: 'x' } } }, '2026-10-23') === null, 'fill-dates: a found date without a source page is not used');
    { const rolled = { id: '2027-rolled', name: 'Rolled Test Fair', weekend: '2027-09-10', startDate: null, rolledFrom: '2026', datesEstimated: true, status: 'Prospective',
        booths: [{ days: ['Saturday'], dates: [null], shifts: [{ label: 'Shift 1', slots: [{ rep: '', ft: [] }] }] }] };
      ok(FDm.decide(rolled, { today: '2026-10-24' }).kind === 'skip' && FDm.decide(rolled, { today: '2027-04-01' }).kind === 'search' && FDm.decide({ ...rolled, status: 'Booked' }, { today: '2026-10-24' }).kind === 'search',
        'fill-dates: an untouched show rolled for next year is not searched while it is more than 183 days out; inside the window, or once touched, it is (Alan, 2026-10-24)');
      const rolledIn = { ...rolled, rolledFrom: undefined, createdBy: 'service:sheet-sync:roll-in' };
      ok(FDm.decide(rolledIn, { today: '2026-10-24' }).kind === 'skip' && FDm.decide({ ...rolledIn, createdBy: 'service:sheet-sync' }, { today: '2026-10-24' }).kind === 'search',
        'fill-dates: a sheet-sync roll-in show counts as rolled; a show the Sheet itself added does not'); }
  }

  // ---- booking-sweep end to end: the buckets, the only write (whole-week date moves), and its refusals
  await section('booking-sweep end to end', async () => {
    for (const t of Object.keys(db)) db[t].clear();
    const addD = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
    const ev = (id, name, weekend, reps, extra = {}) => { const days = ['Friday', 'Saturday', 'Sunday']; const dates = days.map((_, i) => addD(weekend, i));
      T('events').set(id, { year: 2026, name, weekend, startDate: dates[0], endDate: dates[2], days, dates,
        booths: [{ label: '', days, dates, shifts: [{ label: 'Shift 1', slots: days.map((_, i) => ({ rep: reps[i] || '', ft: [] })) }] }], status: 'Prospective', ...extra }); };
    ev('2026-r1', 'Pinecone Craft Fair', '2026-11-13', ['Eli', 'Eli'], { cityState: 'Flagstaff, AZ', promoter: 'Pinecone Co', cost: '$300', setting: 'outdoor', notes: 'north lot, not south',
      submissionNotes: 'Returning vendor since 2022', applyBy: '2026-10-20', applyBySource: { kind: 'rolled', from: '2025-10-20', fromYear: 2025 }, applyOpens: '2026-08-01', applyOpensSource: { kind: 'manual', by: 'JP', at: '2026-09-01' } });
    T('event_contacts').set('2026-r1', { contact: 'Jane Doe', phone: '(928) 555-0100', email: 'jane@example.com' });
    ev('2026-r2', 'Estimated Expo', '2026-11-20', ['Sarah'], { datesEstimated: true });
    ev('2026-r3', 'Soon Fest', '2026-10-02', ['Reed']);
    ev('2026-p1', 'Prospect Days', '2026-11-06', ['Kendall']);
    ev('2026-f1', 'Shifted Show', '2026-10-16', ['Cameron', 'Eli', 'Sarah'], { vcNumber: '00400002' });
    ev('2026-q1', 'Off By One Fest', '2026-10-16', ['Reed'], { vcNumber: '00400003' });
    ev('2026-q2', 'Pending Promo Show', '2026-10-30', ['Reed'], { vcNumber: '00400004' });
    ev('2026-x1', 'Wigwam Holiday Festival of Art', '2026-11-27', ['Eli']);
    ev('2026-d1', 'Duplicate Rodeo', '2026-11-20', ['Kendall']);
    ev('2026-s1', 'Sent Already Show', '2026-11-13', ['Sarah'], { status: 'Booking Request Submitted', vcRequestedAt: '2026-09-29' });
    ev('2026-c1', 'Contained Show', '2026-10-23', ['Eli'], { vcNumber: '00400006' });
    ev('2026-d2', 'Placeholder Bazaar', '2026-11-27', ['Reed'], { cityState: 'Queen Creek, AZ' });
    const filler = Array.from({ length: 22 }, (_, i) => ({ eventNumber: String(410000 + i), name: `Filler Show ${String.fromCharCode(65 + i)}`, status: 'Booked', startDate: '2026-12-0' + (1 + (i % 9)), endDate: '2026-12-0' + (1 + (i % 9)) }));
    const vcRows = [
      { eventNumber: '00400001', name: 'Prospect Days', status: 'Prospective', startDate: '2026-11-06', endDate: '2026-11-08' },
      { eventNumber: '00400002', name: 'Shifted Show', status: 'Booked', startDate: '2026-10-23', endDate: '2026-10-25' },
      { eventNumber: '00400003', name: 'Off By One Fest', status: 'Booked', startDate: '2026-10-17', endDate: '2026-10-18' },
      { eventNumber: '00400004', name: 'Pending Promo Show', status: 'Pending Promoter - Acceptance into Event', startDate: '2026-11-06', endDate: '2026-11-08' },
      { eventNumber: '00400005', name: 'Duplicate Rodeo', status: 'Booked', startDate: '2026-11-06', endDate: '2026-11-08' },
      { eventNumber: '00400006', name: 'Contained Show', status: 'Booked', startDate: '2026-10-21', endDate: '2026-10-25' },
      { eventNumber: '00092192', name: 'Placeholder Bazaar', status: 'Booked', startDate: '2026-11-01', endDate: '2026-11-30' },
      ...filler];
    const vcFile = path.join(home, 'bs-vc.json'); fs.writeFileSync(vcFile, JSON.stringify({ coordinator: 'Matt Foss', rows: vcRows }));
    const outd = path.join(home, 'bs-out'), exFile = path.join(home, 'bs-exclude.json');
    fs.writeFileSync(exFile, JSON.stringify({ exclude: ['Wigwam Holiday Festival of Art'] }));
    const envB = { PATH: process.env.PATH, HOME: home, BOARD_SUPABASE_URL: base, BOARD_SERVICE_KEY: 'test', BOARD_OUT_DIR: outd };
    const node = (script, ...a) => new Promise(res => execFile(process.execPath, [path.join(REPO, script), ...a], { env: envB }, (err, stdout, stderr) => res({ code: err ? err.code : 0, stdout, stderr })));
    r = await node('scripts/event-check.mjs', '--vc', vcFile, '--apply', '--date', '2026-10-01');
    ok(r.code === 0, 'booking-sweep fixture: the event check ran: ' + r.stderr.slice(0, 300));
    const before = JSON.stringify(T('events').get('2026-f1'));
    r = await node('scripts/booking-sweep.mjs', '--vc', vcFile, '--exclude-file', exFile, '--meeting', '2026-09-29', '--date', '2026-10-01');
    const dry = JSON.parse(fs.readFileSync(path.join(outd, 'booking-sweep', 'latest.json'), 'utf8'));
    ok(r.code === 0 && dry.mode === 'dry' && JSON.stringify(T('events').get('2026-f1')) === before, 'booking-sweep dry: writes nothing: ' + r.stderr.slice(0, 200));
    r = await node('scripts/booking-sweep.mjs', '--vc', vcFile, '--exclude-file', exFile, '--meeting', '2026-09-29', '--date', '2026-10-01', '--apply');
    const out = JSON.parse(fs.readFileSync(path.join(outd, 'booking-sweep', 'latest.json'), 'utf8'));
    const ids = k => out[k].map(x => x.id).sort().join();
    ok(r.code === 0 && out.mode === 'apply', 'booking-sweep --apply exits 0: ' + r.stderr.slice(0, 300));
    ok(ids('requests') === '2026-d2,2026-r1', 'booking-sweep: a staffed show VC does not have is a request (a placeholder record is never a duplicate): ' + ids('requests'));
    const req = out.requests.find(x => x.id === '2026-r1');
    ok(req && req.fields.submissionNotes === 'Returning vendor since 2022' && req.fields.applyOpens === '2026-08-01' && req.fields.applyBy === '2026-10-20' && req.fields.applyByKind === 'rolled' && req.fields.applyOpensKind === 'manual',
      'booking-sweep: the request carries the Submission Notes and each application date with where it came from (lib/booking-sweep.js writes the Comments)');
    ok(req.fields.phone === '(928) 555-0100' && req.fields.contact === 'Jane Doe' && req.fields.setting === 'outdoor' && req.fields.notes === 'north lot, not south' && req.run.start === '2026-11-13' && req.run.end === '2026-11-15', 'booking-sweep: the request carries what the form needs, contacts included');
    ok(ids('holds') === '2026-d1,2026-r2,2026-r3', 'booking-sweep: estimated dates, a show days away and a same-name VC record at other dates are held: ' + ids('holds'));
    ok(out.holds.find(x => x.id === '2026-d1').why.join().includes('00400005'), 'booking-sweep: the duplicate hold names the VC record');
    ok(ids('email') === '2026-p1' && out.email[0].vcNumber === '00400001' && out.email[0].datesDiffer === false, 'booking-sweep: a Prospective VC record goes on the Olean email');
    ok(JSON.stringify(T('events').get('2026-f1')) === before && out.written === false, 'booking-sweep: never writes dates any more (the date research does, before it runs)');
    ok(ids('questions') === '2026-f1,2026-q1,2026-q2' && /could not settle/.test(out.questions.find(x => x.id === '2026-f1').why), 'booking-sweep: a date disagreement still standing is a question for Alan: ' + ids('questions'));
    ok(!out.questions.some(x => x.id === '2026-c1'), 'booking-sweep: board selling days inside VC\'s run (a set-up day in VC) are not a date problem');
    ok(out.claimedVc.includes('00400006') && !out.claimedVc.includes('00092192'), 'booking-sweep: the VC numbers the board already claims travel with the result');
    ok(ids('pending') === '2026-s1' && ids('excluded') === '2026-x1', 'booking-sweep: a request already with Olean waits; Alan\'s direct shows are left out');
    ok((fs.statSync(path.join(outd, 'booking-sweep', 'latest.json')).mode & 0o777) === 0o600, 'booking-sweep: the output (it carries promoter contacts) is mode 600');
    const md = fs.readFileSync(path.join(outd, 'reports', 'booking-sweep-2026-10-01.md'), 'utf8');
    ok(!md.includes('555-') && !md.includes('jane@') && md.includes('Pinecone Craft Fair'), 'booking-sweep: the report carries no contacts');
    T('events').set('2026-p1', { ...T('events').get('2026-p1'), tier: 'Elite' });
    const elFile = path.join(home, 'bs-elite.json');
    fs.writeFileSync(elFile, JSON.stringify({ exclude: ['Wigwam Holiday Festival of Art'], excludeTiers: ['Elite'] }));
    r = await node('scripts/booking-sweep.mjs', '--vc', vcFile, '--exclude-file', elFile, '--meeting', '2026-09-29', '--date', '2026-10-01', '--apply');
    const elo = JSON.parse(fs.readFileSync(path.join(outd, 'booking-sweep', 'latest.json'), 'utf8'));
    ok(r.code === 0 && !elo.email.some(x => x.id === '2026-p1') && elo.excluded.some(x => x.id === '2026-p1' && x.tier === 'Elite') && /Elite shows\)\n- .*Prospect Days \(Elite\)/.test(fs.readFileSync(path.join(outd, 'reports', 'booking-sweep-2026-10-01.md'), 'utf8')), 'booking-sweep: an Elite show is never sent to Olean or requested; the team books it (Alan, 2026-09-24)');
    { const p1 = T('events').get('2026-p1'); delete p1.tier; T('events').set('2026-p1', p1); }
    const spFile = path.join(home, 'bs-sponsor.json');
    fs.writeFileSync(spFile, JSON.stringify({ exclude: ['Wigwam Holiday Festival of Art'], sponsorships: [{ name: 'Pinecone Craft Fair', kind: 'Gold Sponsorship', until: '2026-12-31' }, { name: 'Prospect Days', kind: 'Silver Sponsorship', until: '2026-10-01' }] }));
    r = await node('scripts/booking-sweep.mjs', '--vc', vcFile, '--exclude-file', spFile, '--meeting', '2026-09-29', '--date', '2026-10-01', '--apply');
    const sp = JSON.parse(fs.readFileSync(path.join(outd, 'booking-sweep', 'latest.json'), 'utf8'));
    ok(r.code === 0 && sp.sponsored.map(x => x.id).join() === '2026-r1' && !sp.requests.some(x => x.id === '2026-r1') && sp.sponsored[0].kind === 'Gold Sponsorship' && sp.counts.sponsored === 1, 'booking-sweep: a show under a sponsorship is covered, never requested: ' + JSON.stringify(sp.sponsored.map(x => x.id)));
    ok(sp.email.some(x => x.id === '2026-p1'), 'booking-sweep: a sponsorship past its "until" lapses, and the show is swept normally again');
    ok(/## Covered by a sponsorship/.test(fs.readFileSync(path.join(outd, 'reports', 'booking-sweep-2026-10-01.md'), 'utf8')), 'booking-sweep: the report lists what a sponsorship covers');
    const resFile = path.join(home, 'bs-research.json');
    fs.writeFileSync(resFile, JSON.stringify({ date: '2026-10-01', label: 'booking-sweep', vcDisagrees: [{ id: '2026-f1', name: 'Shifted Show', web: { start: '2026-10-16', end: '2026-10-18' }, source: 'https://www.shiftedshow.org/dates' }],
      failed: [{ id: '2026-q1', name: 'Off By One Fest', why: 'the lookup failed (API 529)' }] }));
    r = await node('scripts/booking-sweep.mjs', '--vc', vcFile, '--exclude-file', exFile, '--research', resFile, '--meeting', '2026-09-29', '--date', '2026-10-01', '--apply');
    const withR = JSON.parse(fs.readFileSync(path.join(outd, 'booking-sweep', 'latest.json'), 'utf8'));
    const qf = withR.questions.find(x => x.id === '2026-f1'), qq = withR.questions.find(x => x.id === '2026-q1');
    ok(r.code === 0 && qf.kind === 'vc-wrong' && /shiftedshow\.org says Oct 16-18, which is what the board has: VC is the one to fix/.test(qf.why), 'booking-sweep --research: when the show\'s own page backs the board, the question says VC is wrong: ' + (qf && qf.why));
    ok(/lookup failed \(the lookup failed \(API 529\)\), so nothing was changed/.test(qq.why), 'booking-sweep --research: a failed lookup is named as such: ' + (qq && qq.why));
    fs.writeFileSync(resFile, JSON.stringify({ date: '2026-09-30', label: 'booking-sweep', vcDisagrees: [{ id: '2026-f1', web: { start: '2026-10-16', end: '2026-10-18' }, source: 'https://x.org' }] }));
    r = await node('scripts/booking-sweep.mjs', '--vc', vcFile, '--exclude-file', exFile, '--research', resFile, '--meeting', '2026-09-29', '--date', '2026-10-01', '--apply');
    ok(/could not settle/.test(JSON.parse(fs.readFileSync(path.join(outd, 'booking-sweep', 'latest.json'), 'utf8')).questions.find(x => x.id === '2026-f1').why), 'booking-sweep --research: a research result from another day is ignored');
    r = await node('scripts/booking-sweep.mjs', '--vc', vcFile, '--date', '2026-10-02', '--apply');
    ok(r.code === 4 && T('events').get('2026-f1').weekend === '2026-10-16', 'booking-sweep: an event check from another day is not swept on (exit 4)');
    const { sellingRun } = await import(path.join(REPO, 'scripts/booking-sweep.mjs'));
    ok(sellingRun({ weekend: '2026-10-16', booths: [{ days: ['Thursday SE', 'Friday', 'Saturday'], dates: ['2026-10-15', '2026-10-16', '2026-10-17'] }] }).start === '2026-10-16', 'sellingRun: a set-up day is not a selling day');
    ok(sellingRun({ weekend: '2027-01-29', booths: [{ days: ['Friday'], dates: ['2024-01-26'] }] }) === null, 'sellingRun: stale day cells a year off are not trusted');
  });

  // ---- lib/dates.mjs planMove: moving a show to its true dates, shifts and all
  await section('lib/dates.mjs planMove', async () => {
    const { planMove, fridayKey, weekday } = await import(path.join(REPO, 'scripts/lib/dates.mjs'));
    const show = (days, dates, reps, extra = {}) => ({ weekend: fridayKey(dates.find(d => d) || '2026-10-09'), days, dates, booths: [{ label: '', days, dates, shifts: [{ label: 'Shift 1', slots: reps.map(r => ({ rep: r, ft: [] })) }] }], ...extra });
    let p = planMove(show(['Saturday', 'Sunday'], ['2026-10-10', '2026-10-11'], ['Eli', 'Sarah']), { start: '2026-10-09', end: '2026-10-10' });
    ok(p.patch.booths[0].days.join() === 'Friday,Saturday' && p.patch.booths[0].dates.join() === '2026-10-09,2026-10-10' && p.patch.booths[0].shifts[0].slots.map(x => x.rep).join() === ',Eli', 'planMove: Sat-Sun to Fri-Sat keeps Saturday\'s rep, adds an empty Friday');
    ok(p.affected.length === 1 && p.affected[0].rep === 'Sarah' && p.affected[0].to === null && p.removed.join() === '2026-10-11' && p.added.join() === '2026-10-09', 'planMove: the Sunday rep is reported, her day is gone');
    ok(p.patch.startDate === '2026-10-09' && p.patch.endDate === '2026-10-10' && p.patch.weekend === '2026-10-09' && p.patch.datesEstimated === false, 'planMove: start, end, weekend and the estimate flag follow');
    p = planMove(show(['Friday', 'Saturday', 'Sunday', 'Monday SE'], ['2026-10-16', '2026-10-17', '2026-10-18', '2026-10-19'], ['Cameron', 'Eli', 'Sarah', 'Reed']), { start: '2026-10-23', end: '2026-10-25' });
    ok(p.patch.booths[0].dates.join() === '2026-10-23,2026-10-24,2026-10-25,2026-10-26' && p.patch.booths[0].days.join() === 'Friday,Saturday,Sunday,Monday SE' && p.patch.booths[0].shifts[0].slots.map(x => x.rep).join() === 'Cameron,Eli,Sarah,Reed', 'planMove: a whole week later carries every rep and the tear-down day');
    ok(p.affected.map(a => `${a.rep}:${a.to}`).join() === 'Cameron:2026-10-23,Eli:2026-10-24,Sarah:2026-10-25', 'planMove: every selling-day rep is told the new date (the SE rep is not)');
    p = planMove(show(['Saturday', 'Sunday'], ['2027-02-27', '2027-02-28'], ['Eli', 'Sarah']), { start: '2027-03-05', end: '2027-03-07' });
    ok(p.patch.booths[0].days.join() === 'Friday,Saturday,Sunday' && p.patch.booths[0].shifts[0].slots.map(x => x.rep).join() === ',Eli,Sarah' && p.added.join() === '2027-03-05', 'planMove: to a longer run the next week, reps keep their weekday and the new day is empty');
    ok(planMove(show(['Saturday'], [null], ['Eli']), { start: '2026-10-10', end: '2026-10-10' }).error, 'planMove: a show with no usable days is not moved');
    // Bluegrass on the Beach 2027, moved 2027-02-27..28 -> 03-05..07 on 2026-09-24: its Friday cell held "3/1/2024" (the
    // Sheet shows it as "Friday") with no date, and the Mon SE shifted six days landed on Sunday and was dropped unreported
    const bluegrass = () => show(['3/1/2024', 'Saturday', 'Sunday', 'Mon SE'], [null, '2027-02-27', '2027-02-28', '2027-03-01'], ['Zach', 'Zach', 'Zach', 'Zach']);
    p = planMove(bluegrass(), { start: '2027-03-05', end: '2027-03-07' });
    ok(p.patch.booths[0].days.join() === 'Friday,Saturday,Sunday,Monday SE' && p.patch.booths[0].dates.join() === '2027-03-05,2027-03-06,2027-03-07,2027-03-08' && p.patch.booths[0].shifts[0].slots.map(x => x.rep).join() === 'Zach,Zach,Zach,Zach', 'planMove: Bluegrass keeps Zach on Fri, Sat, Sun and the Mon SE: ' + JSON.stringify([p.patch.booths[0].days, p.patch.booths[0].dates]));
    ok(p.added.length === 0 && p.removed.length === 0 && p.loose.length === 0 && p.affected.map(a => `${a.rep}:${a.from}>${a.to}`).join() === 'Zach:2027-02-26>2027-03-05,Zach:2027-02-27>2027-03-06,Zach:2027-02-28>2027-03-07', 'planMove: Bluegrass adds no empty Friday and tells Zach each new date: ' + JSON.stringify(p.affected));
    p = planMove(show(['Saturday', 'Sunday', 'Mon SE'], ['2027-02-27', '2027-02-28', '2027-03-01'], ['Eli', 'Sarah', 'Reed']), { start: '2027-03-05', end: '2027-03-07' });
    ok(p.patch.booths[0].days.join() === 'Friday,Saturday,Sunday,Monday SE' && p.patch.booths[0].dates.join() === '2027-03-05,2027-03-06,2027-03-07,2027-03-08' && p.patch.booths[0].shifts[0].slots.map(x => x.rep).join() === ',Eli,Sarah,Reed', 'planMove: a Mon SE after the run stays the Monday after, rep and all (not shifted onto Sunday)');
    p = planMove(show(['Friday SE', 'Saturday', 'Sunday'], ['2026-10-09', '2026-10-10', '2026-10-11'], ['Reed', 'Eli', 'Sarah']), { start: '2026-10-09', end: '2026-10-11' });
    ok(p.patch.booths[0].days.join() === 'Friday,Saturday,Sunday' && p.patch.booths[0].shifts[0].slots.map(x => x.rep).join() === ',Eli,Sarah' && p.affected.map(a => `${a.rep}:${a.from}>${a.to}`).join() === 'Reed:2026-10-09>null' && p.removed.join() === '2026-10-09', 'planMove: a set-up day the run now sells on has nowhere to go, and its rep is reported: ' + JSON.stringify(p.affected));
    p = planMove(show(['Thursday SE', 'Friday', 'Saturday', 'Sunday', 'Monday SE'], ['2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18', '2026-10-19'], ['Reed', 'Cameron', 'Eli', 'Sarah', 'Jo']), { start: '2026-10-17', end: '2026-10-18' });
    ok(p.patch.booths[0].dates.join() === '2026-10-15,2026-10-17,2026-10-18,2026-10-19' && p.patch.booths[0].shifts[0].slots.map(x => x.rep).join() === 'Reed,Eli,Sarah,Jo' && p.affected.map(a => `${a.rep}:${a.to}`).join() === 'Cameron:null', 'planMove: set-up and tear-down days stay put when the run shrinks inside them');
    p = planMove(bluegrass(), { start: '2027-03-06', end: '2027-03-07' });
    ok(p.patch.booths[0].days.join() === 'Saturday,Sunday,Monday SE' && p.patch.booths[0].shifts[0].slots.map(x => x.rep).join() === 'Zach,Zach,Zach' && p.affected[0].rep === 'Zach' && p.affected[0].from === '2027-02-26' && p.affected[0].to === null && p.removed.join() === '2027-02-26', 'planMove: an undated Friday whose day is gone is reported with the date it stood for');
    p = planMove(show(['Saturday', 'Sunday', 'Tucson, AZ'], ['2027-02-27', '2027-02-28', null], ['Eli', 'Sarah', 'Jo']), { start: '2027-03-06', end: '2027-03-07' });
    ok(p.patch.booths[0].days.join() === 'Saturday,Sunday,Tucson, AZ' && p.patch.booths[0].dates[2] === null && p.patch.booths[0].shifts[0].slots[2].rep === 'Jo' && p.loose.length === 1 && p.loose[0].label === 'Tucson, AZ' && p.loose[0].reps.join() === 'Jo', 'planMove: a column that names no day stays as it was and is listed: ' + JSON.stringify(p.loose));
    p = planMove(show(['Friday', 'Friday', 'Saturday'], [null, null, '2027-02-27'], ['Jo', 'Eli', 'Sarah']), { start: '2027-03-05', end: '2027-03-06' });
    ok(p.loose.length === 2 && p.patch.booths[0].dates.join() === '2027-03-05,2027-03-06,,' && p.affected.map(a => `${a.rep}:${a.to}`).join() === 'Sarah:2027-03-06', 'planMove: two undated days that would be the same day are not guessed at, they are listed: ' + JSON.stringify(p.loose));
    const { summaryMd: researchMd } = await import(path.join(REPO, 'scripts/board-research.mjs'));
    const md = researchMd({ label: 'date-check', date: '2026-10-27', counts: {}, changes: [{ name: 'Rodeo Test', from: { start: '2027-02-27', end: '2027-02-28' }, to: { start: '2027-03-06', end: '2027-03-07' }, basis: 'web', host: 'rodeotest.org', affected: [], loose: p.loose, applied: true }] });
    ok(/## Days a move could not date[^\n]*\n- Rodeo Test: "Friday", Jo on it\n- Rodeo Test: "Friday", Eli on it/.test(md), 'board-research: the report lists the days a move could not date, with their reps: ' + md);
    const { labelWeekday } = await import(path.join(REPO, 'scripts/lib/dates.mjs'));
    ok([['Friday (SE)', 5], ['Wed (set-up', 3], ['Thursday\n (SET UP DAY)', 4], ['1/26/2024', 5], ['3/1/2024', 5], ['Sat.', 6], ['Mon SE', 1], ['Tucson, AZ', null], ['Service Events', null], ['SE Surprise', null], ['', null]].every(([l, w]) => labelWeekday(l) === w), 'dates: labelWeekday reads a weekday the way the page does');
    ok(weekday('2026-10-09') === 'Friday' && fridayKey('2026-10-11') === '2026-10-09' && fridayKey('2026-10-12') === '2026-10-16', 'dates: weekday names and the board\'s Friday key');
  });

  // ---- board-research end to end: targets, the date rule, the preflight's fields, the cap
  await section('board-research end to end', async () => {
    for (const t of Object.keys(db)) db[t].clear();
    const addD = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
    const ev = (id, name, first, n, reps, extra = {}) => { const dates = Array.from({ length: n }, (_, i) => addD(first, i)); const W = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
      const days = dates.map(d => W[new Date(d + 'T12:00:00Z').getUTCDay()]);
      const wk = (() => { const off = (new Date(first + 'T12:00:00Z').getUTCDay() + 6) % 7; return addD(first, 4 - off); })();
      T('events').set(id, { year: 2026, name, weekend: wk, startDate: dates[0], endDate: dates[n - 1], days, dates, booths: [{ label: '', days, dates, shifts: [{ label: 'Shift 1', slots: days.map((_, i) => ({ rep: reps[i] || '', ft: [] })) }] }], status: 'Booked', ...extra }); };
    ev('2026-m1', 'Heber Test Oktoberfest', '2026-10-10', 2, ['Eli', 'Sarah'], { vcNumber: '00500001' });
    ev('2026-m2', 'Havasu Test Craft Show', '2026-11-13', 2, ['Reed', 'Kendall'], { vcNumber: '00500002' });
    ev('2026-m3', 'Page Test Balloon Fest', '2026-11-07', 2, ['Eli'], { vcNumber: '00500003' });
    ev('2026-c1', 'Estimated Test Fair', '2026-12-05', 2, [], { datesEstimated: true, status: 'Prospective' });
    ev('2026-x1', 'Cancelled Test Fest', '2026-12-12', 2, ['Reed'], { status: 'Prospective' });
    ev('2026-p1', 'Promoter Test Market', '2026-12-19', 1, [], { status: 'Prospective' });
    T('event_contacts').set('2026-p1', { contact: 'Existing Person' });
    const vcRows = [
      { eventNumber: '00500001', name: 'Heber Test Oktoberfest', status: 'Booked', startDate: '2026-10-09', endDate: '2026-10-10' },
      { eventNumber: '00500002', name: 'Havasu Test Craft Show', status: 'Booked', startDate: '2026-11-14', endDate: '2026-11-15' },
      { eventNumber: '00500003', name: 'Page Test Balloon Fest', status: 'Booked', startDate: '2026-11-06', endDate: '2026-11-07' },
      ...Array.from({ length: 22 }, (_, i) => ({ eventNumber: String(510000 + i), name: `Filler Show ${String.fromCharCode(65 + i)}`, status: 'Booked', startDate: '2027-01-0' + (1 + (i % 9)), endDate: '2027-01-0' + (1 + (i % 9)) }))];
    const vcFile = path.join(home, 'br-vc.json'); fs.writeFileSync(vcFile, JSON.stringify({ coordinator: 'Matt Foss', rows: vcRows }));
    const outd = path.join(home, 'br-out');
    const envB = { PATH: process.env.PATH, HOME: home, BOARD_SUPABASE_URL: base, BOARD_SERVICE_KEY: 'test', BOARD_OUT_DIR: outd };
    const node = (script, ...a) => new Promise(res => execFile(process.execPath, [path.join(REPO, script), ...a], { env: envB }, (err, stdout, stderr) => res({ code: err ? err.code : 0, stdout, stderr })));
    r = await node('scripts/event-check.mjs', '--vc', vcFile, '--apply', '--date', '2026-10-01');
    ok(r.code === 0, 'board-research fixture: the event check ran: ' + r.stderr.slice(0, 200));
    const check = path.join(outd, 'event-check', 'latest.json'), tfile = path.join(home, 'br-targets.json'), mfile = path.join(home, 'br-mismatch.json');
    r = await node('scripts/board-research.mjs', 'targets', '--mode', 'mismatches', '--check', check, '--out', mfile, '--date', '2026-10-01');
    const mm = JSON.parse(fs.readFileSync(mfile, 'utf8'));
    ok(r.code === 0 && mm.targets.map(x => x.id).sort().join() === '2026-m1,2026-m2,2026-m3', 'board-research targets: the shows whose dates disagree with VC: ' + mm.targets.map(x => x.id).join());
    r = await node('scripts/board-research.mjs', 'targets', '--mode', 'full', '--check', check, '--out', tfile, '--date', '2026-10-01');
    const tg = JSON.parse(fs.readFileSync(tfile, 'utf8'));
    ok(r.code === 0 && tg.count === 6 && tg.targets[0].mismatch && tg.targets.find(x => x.id === '2026-p1').contact === 'Existing Person' && (fs.statSync(tfile).mode & 0o777) === 0o600, 'board-research targets (full): every upcoming show, disagreements first, contacts included, mode 600');
    T('events').set('2026-x1', { ...T('events').get('2026-x1'), tier: 'Elite' });
    const efile = path.join(home, 'br-elite.json');
    r = await node('scripts/board-research.mjs', 'targets', '--mode', 'full', '--check', check, '--out', efile, '--date', '2026-10-01', '--skip-tiers', 'Elite');
    const el = JSON.parse(fs.readFileSync(efile, 'utf8'));
    ok(r.code === 0 && el.count === 5 && !el.targets.some(x => x.id === '2026-x1') && el.skippedTiers.map(x => x.id).join() === '2026-x1', 'board-research targets: an Elite show is never researched (Alan, 2026-09-24), and is counted');
    { const x1 = T('events').get('2026-x1'); delete x1.tier; T('events').set('2026-x1', x1); }
    { // a roll into next year: untouched shows more than 183 days out wait; a near one, or one somebody touched, is researched
      const rolled = { rolledFrom: '2026', datesEstimated: true, status: 'Prospective' };
      ev('2027-r-far', 'Rolled Far Test Fair', '2027-06-05', 2, [], { year: 2027, ...rolled });
      ev('2027-r-near', 'Rolled Near Test Fair', '2027-03-06', 2, [], { year: 2027, ...rolled });
      ev('2027-r-staffed', 'Rolled Staffed Test Fair', '2027-06-12', 2, ['Eli'], { year: 2027, ...rolled });
      ev('2027-r-booked', 'Rolled Booked Test Fair', '2027-06-19', 2, [], { year: 2027, ...rolled, status: 'Booked', vcNumber: '00500009' });
      // a sheet-sync roll-in (no rolledFrom, createdBy says so) is rolled too; a show the Sheet itself added is not
      const rolledIn = { datesEstimated: true, status: 'Prospective', createdBy: 'service:sheet-sync:roll-in' };
      ev('2027-ri-far', 'Rolled In Far Test Fair', '2027-07-10', 2, [], { year: 2027, ...rolledIn });
      ev('2027-ri-dated', 'Rolled In Dated Test Fair', '2027-07-17', 2, [], { year: 2027, ...rolledIn, datesEstimated: false });
      ev('2027-sync-far', 'Sheet Added Far Test Fair', '2027-07-24', 2, [], { year: 2027, ...rolledIn, createdBy: 'service:sheet-sync' });
      const rfile2 = path.join(home, 'br-rolled.json');
      r = await node('scripts/board-research.mjs', 'targets', '--mode', 'dates', '--check', check, '--out', rfile2, '--date', '2026-10-01');
      const rt = JSON.parse(fs.readFileSync(rfile2, 'utf8')), ids = rt.targets.map(x => x.id);
      ok(r.code === 0 && rt.rolledLater.map(x => x.id).sort().join() === '2027-r-far,2027-ri-far' && !ids.includes('2027-r-far') && !ids.includes('2027-ri-far')
        && ['2027-r-near', '2027-r-staffed', '2027-r-booked', '2027-ri-dated', '2027-sync-far'].every(id => ids.includes(id)) && /2 rolled for next year/.test(r.stderr),
        'board-research targets: an untouched rolled show (the board\'s roll or a sheet-sync roll-in) more than 183 days out is left for later, and counted; a near, dated or touched one, or one the Sheet added, is researched (Alan, 2026-10-24): ' + ids.join());
      for (const id of ['2027-r-far', '2027-r-near', '2027-r-staffed', '2027-r-booked', '2027-ri-far', '2027-ri-dated', '2027-sync-far']) T('events').delete(id);
    }
    const found =(s, e2, url, extra = {}) => ({ ok: true, result: { dates: { found: true, start: s, end: e2, confidence: 'official', sourceUrl: url, evidence: `the show runs ${s} to ${e2}`, cancelled: false, notYetAnnounced: false, note: '' }, summary: '', ...extra } });
    const none = { ok: true, result: { dates: { found: false, start: '', end: '', confidence: 'none', sourceUrl: '', evidence: '', cancelled: false, notYetAnnounced: false, note: '' }, summary: '' } };
    const research = { results: {
      '2026-m1': found('2026-10-09', '2026-10-10', 'https://www.hebertest.org/oktoberfest'),
      '2026-m2': none,
      '2026-m3': { ok: false, error: 'the lookup failed (API 529)' },
      '2026-c1': found('2026-12-05', '2026-12-06', 'https://estimatedtestfair.com/'),
      '2026-x1': { ok: true, result: { dates: { found: false, start: '', end: '', confidence: 'official', sourceUrl: 'https://cancelledtest.org/news', evidence: 'The 2026 festival is cancelled', cancelled: true, notYetAnnounced: false, note: '' }, summary: '' } },
      '2026-p1': found('2026-12-19', '2026-12-19', 'https://promotertest.com/market', {
        venue: { value: 'Test Park Pavilion', confidence: 'official', sourceUrl: 'https://promotertest.com/market' },
        address: { street: '12 Park Rd', city: 'Mesa Verde', state: 'AZ', zip: '85001', confidence: 'official', sourceUrl: 'https://promotertest.com/market' },
        promoter: { name: 'Promoter Test LLC', contactName: 'New Person', phone: '(480) 555-0199', email: 'promoter@example.com', website: 'https://promotertest.com', confidence: 'official', sourceUrl: 'https://promotertest.com/vendors' },
        indoorOutdoor: { value: 'outdoor', evidence: 'all booths are outdoors on the lawn', sourceUrl: 'https://promoterest.com/vendors' },
        boothCost: { amount: '150', note: '10x10', sourceUrl: 'https://promotertest.com/vendors' },
        application: { url: 'https://promotertest.com/apply', opens: '2026-09-01', opensQuote: 'Vendor applications open September 1', deadline: '2026-11-15', deadlineQuote: 'Applications are due November 15, 2026',
          confidence: 'official', sourceUrl: 'https://promotertest.com/apply' } }),
    } };
    const rfile = path.join(home, 'br-research.json'); fs.writeFileSync(rfile, JSON.stringify(research));
    const before = JSON.stringify(T('events').get('2026-m1'));
    r = await node('scripts/board-research.mjs', 'apply', '--targets', tfile, '--research', rfile, '--mode', 'full', '--label', 'preflight', '--date', '2026-10-01');
    let out = JSON.parse(fs.readFileSync(path.join(outd, 'research', 'latest.json'), 'utf8'));
    ok(r.code === 0 && !out.written && JSON.stringify(T('events').get('2026-m1')) === before && out.changes.length === 2, 'board-research apply (dry): lists the moves, writes nothing: ' + r.stderr.slice(0, 200));
    r = await node('scripts/board-research.mjs', 'apply', '--targets', tfile, '--research', rfile, '--mode', 'full', '--label', 'preflight', '--date', '2026-10-01', '--apply');
    out = JSON.parse(fs.readFileSync(path.join(outd, 'research', 'latest.json'), 'utf8'));
    const M1 = T('events').get('2026-m1'), M2 = T('events').get('2026-m2');
    ok(r.code === 0 && out.written, 'board-research apply: exits 0 and writes: ' + r.stderr.slice(0, 300));
    ok(M1.booths[0].days.join() === 'Friday,Saturday' && M1.booths[0].shifts[0].slots.map(x => x.rep).join() === ',Eli' && /per hebertest\.org/.test(M1.datesNote) && M1.datesSource.basis === 'researched', 'board-research: found online -> the web\'s dates win, noted on the board');
    const c1 = out.changes.find(x => x.id === '2026-m1');
    ok(c1.affected.length === 1 && c1.affected[0].rep === 'Sarah' && c1.affected[0].to === null && c1.applied, 'board-research: the rep whose day is gone is reported for the text');
    ok(c1.after && c1.after.first === '2026-10-09' && c1.after.startDate === '2026-10-09' && c1.after.endDate === '2026-10-10' && c1.vcRun && c1.vcRun.start === '2026-10-09', 'board-research: a move records the show as it now stands (what reps are told is compared against it)');
    ok(M2.booths[0].dates.join() === '2026-11-14,2026-11-15' && /Dates per VectorConnect 00500002; not confirmed online/.test(M2.datesNote) && M2.datesSource.basis === 'vc', 'board-research: not found online -> VC\'s dates, with a note on the board (Alan\'s rule)');
    ok(T('events').get('2026-m3').booths[0].dates.join() === '2026-11-07,2026-11-08' && out.failed.some(x => x.id === '2026-m3'), 'board-research: a failed lookup changes nothing (it is not "not found")');
    const C1 = T('events').get('2026-c1');
    ok(C1.datesEstimated === false && /confirmed on estimatedtestfair\.com/.test(C1.datesNote) && out.confirmed >= 2, 'board-research: confirmed dates clear the +364 guess');
    ok(out.cancelled.some(x => x.id === '2026-x1') && !T('events').get('2026-x1').dead, 'board-research: a cancellation found online is reported, never written');
    const P1 = T('events').get('2026-p1'), PC = T('event_contacts').get('2026-p1');
    ok(P1.location === 'Test Park Pavilion' && P1.address === '12 Park Rd, Mesa Verde, AZ 85001' && P1.promoter === 'Promoter Test LLC' && P1.applyUrl === 'https://promotertest.com/apply' && P1.applyBy === '2026-11-15' && P1.cost === '$150' && P1.setting === 'outdoor', 'board-research (full): blanks filled from the official pages');
    ok(P1.applyOpens === '2026-09-01' && P1.applyBySource.kind === 'research' && P1.applyBySource.url === 'https://promotertest.com/apply' && /due November 15/.test(P1.applyBySource.quote)
      && P1.applyBySource.checked === '2026-10-01' && P1.applyOpensSource.kind === 'research' && out.appDates.found.length === 2, 'board-research (full): the application dates, each tagged Research with the page, its words and the day checked');
    ok(out.appDates.notFound.some(x => x.id === '2026-m1' && x.which === 'deadline') && /Application dates no page states yet/.test(fs.readFileSync(path.join(outd, 'reports', 'preflight-2026-10-01.md'), 'utf8')), 'board-research (full): a show no page gives application dates for is listed as not found');
    ok(PC.contact === 'Existing Person' && PC.phone === '(480) 555-0199' && PC.email === 'promoter@example.com' && !('phone' in P1), 'board-research (full): an existing contact is never overwritten; new contact details go to event_contacts');
    ok(out.fieldNotes.some(x => x.id === '2026-p1' && x.field === 'contact'), 'board-research (full): the different contact online is reported instead');
    const md = fs.readFileSync(path.join(outd, 'reports', 'preflight-2026-10-01.md'), 'utf8');
    ok(!md.includes('555-0199') && !md.includes('promoter@example') && !md.includes('New Person') && md.includes('Heber Test Oktoberfest'), 'board-research: the report carries no contact details');
    for (const id of ['2026-m1', '2026-m2']) T('events').set(id, JSON.parse(id === '2026-m1' ? before : JSON.stringify({ ...M2, booths: [{ ...M2.booths[0], days: ['Friday', 'Saturday'], dates: ['2026-11-13', '2026-11-14'] }], dates: ['2026-11-13', '2026-11-14'], days: ['Friday', 'Saturday'] })));
    r = await node('scripts/board-research.mjs', 'apply', '--targets', tfile, '--research', rfile, '--mode', 'dates', '--date', '2026-10-01', '--apply', '--max-date-changes', '1');
    ok(r.code === 5 && JSON.stringify(T('events').get('2026-m1')) === before, 'board-research: more date changes than the cap moves none (exit 5)');
    r = await node('scripts/board-research.mjs', 'targets', '--mode', 'dates', '--check', check, '--date', '2026-10-02');
    ok(r.code === 4, 'board-research targets: an event check from another day is refused (exit 4)');
    const { decideDates, decideFields, sameUrl } = await import(path.join(REPO, 'scripts/board-research.mjs'));
    ok(sameUrl('http://www.heberovergaard.org', 'https://heberovergaard.org/') && sameUrl('heberovergaard.org', 'https://heberovergaard.org/event/oktoberfest/', false) && !sameUrl('https://a.org/apply', 'https://a.org/apply-2027'), 'board-research: the same site is the same URL (http/https, www, trailing slash)');
    const sf = decideFields({ website: 'http://www.heberovergaard.org', applyUrl: 'https://heberovergaard.org/apply/' }, { promoter: { name: '', contactName: '', phone: '', email: '', website: 'https://heberovergaard.org/event/oktoberfest/', confidence: 'official', sourceUrl: 'https://heberovergaard.org/' },
      application: { url: 'https://www.heberovergaard.org/apply', deadline: '', confidence: 'official', sourceUrl: 'https://heberovergaard.org/apply' } });
    ok(!sf.changes.length, 'board-research (full): a website on the same site, or the same application page, is not a correction: ' + JSON.stringify(sf.changes));
    ok(decideDates({ vc: null }, { ok: false, notResearched: true, error: 'not researched: the run reached its $40 spend cap' }, { start: '2026-10-10', end: '2026-10-11' }).kind === 'not-researched', 'board-research: a show past the spend cap is "not researched", not a failed lookup');
    const two = found('2026-09-25', '2026-09-26', 'https://chilitest.org/');
    const dShort = decideDates({ vc: { number: '1', start: '2026-09-25', end: '2026-09-25' } }, two, { start: '2026-09-25', end: '2026-09-26' });
    const dSetup = decideDates({ vc: { number: '1', start: '2026-09-24', end: '2026-09-26' } }, two, { start: '2026-09-25', end: '2026-09-26' });
    ok(dShort.kind === 'confirmed' && dShort.vcDisagrees && dSetup.kind === 'confirmed' && !dSetup.vcDisagrees, 'board-research: VC holding one day of a two-day show is VC\'s to fix; a VC set-up day is not');
    const withReuse = { results: { ...research.results, '2026-m1': { ...research.results['2026-m1'], reused: 'confirmed' } }, model: 'claude-sonnet-5', meeting: '2027-01-13', perMeeting: 60, spentBefore: 12.5, cost: 3.1 };
    fs.writeFileSync(rfile, JSON.stringify(withReuse));
    r = await node('scripts/board-research.mjs', 'apply', '--targets', tfile, '--research', rfile, '--mode', 'full', '--label', 'preflight', '--date', '2026-10-01');
    const ru = JSON.parse(fs.readFileSync(path.join(outd, 'research', 'latest.json'), 'utf8'));
    ok(r.code === 0 && ru.counts.reused === 1 && ru.meeting === '2027-01-13' && ru.perMeeting === 60 && ru.spentBefore === 12.5 && ru.model === 'claude-sonnet-5' && /1 already known from earlier runs/.test(r.stdout), 'board-research: findings reused from earlier runs are counted, and the meeting\'s budget travels with the result');

    // multi-week: one VC record over two board weeks is never moved, so the sweep's research leaves it out
    for (const t of Object.keys(db)) db[t].clear();
    ev('2026-w1', 'Quartz Test Show', '2027-01-15', 2, ['Eli'], { vcNumber: '00500009' });
    ev('2026-w2', 'Quartz Test Show', '2027-01-22', 2, ['Reed'], { vcNumber: '00500009' });
    fs.writeFileSync(vcFile, JSON.stringify({ coordinator: 'Matt Foss', rows: [{ eventNumber: '00500009', name: 'Quartz Test Show', status: 'Booked', startDate: '2027-01-16', endDate: '2027-01-24' }, ...vcRows.slice(3)] }));
    r = await node('scripts/event-check.mjs', '--vc', vcFile, '--apply', '--date', '2026-10-01');
    r = await node('scripts/board-research.mjs', 'targets', '--mode', 'mismatches', '--check', check, '--out', mfile, '--date', '2026-10-01');
    const mw = JSON.parse(fs.readFileSync(mfile, 'utf8'));
    r = await node('scripts/board-research.mjs', 'targets', '--mode', 'dates', '--check', check, '--out', tfile, '--date', '2026-10-01');
    const dw = JSON.parse(fs.readFileSync(tfile, 'utf8'));
    ok(mw.count === 0 && dw.targets.filter(x => x.multiWeek).length === 2 && dw.targets.find(x => x.id === '2026-w1').mismatch, 'board-research targets: a multi-week show is researched by the date runs but left out of the sweep\'s mismatches: ' + JSON.stringify({ mm: mw.count, mw: dw.targets.map(x => [x.id, x.multiWeek, x.mismatch]) }));
  });

  await section('board roster sync (settings.roster follows the rep master list)', async () => {
    // fictional people only: this repo is public
    const rep = (id, name, tier, status = 'active', aliases = []) => ({ id, name, tier, status, aliases });
    const master = [
      rep('avery-stone', 'Avery Stone', 'Elite', 'active', ['Avery']), rep('blake-rivers', 'Blake Rivers', 'Varsity', 'active', ['B. Rivers']),
      rep('casey-moon', 'Casey Moon', 'JV', 'active', ['Casey M', 'Casey M.']), rep('casey-lake', 'Casey Lake', 'JV', 'active', ['Casey']),
      rep('drew-park', 'Drew Park', 'Freshmen', 'left'), rep('emery-cole', 'Emery Cole', 'Freshmen', 'left'),
      rep('finley-ash', 'Finley Ash', 'Freshmen'), rep('gray-hill', 'Gray Hill', 'Freshmen'), rep('harper-vale', 'Harper Vale', 'Freshmen'),
      rep('indy-reed', 'Indy Reed', 'Freshmen'), rep('jules-fox', 'Jules Fox', 'Freshmen'), rep('kai-brook', 'Kai Brook', 'Coordinator', 'active', ['Brook']),
      rep('lane-gale', 'Lane Gale', 'Leader'), rep('finley-oak', 'Finley Oak', 'Freshmen'),
    ];
    fs.mkdirSync(path.join(home, '.rsd'), { recursive: true });
    fs.writeFileSync(path.join(home, '.rsd', 'board.env'), `BOARD_SUPABASE_URL=${base}\nBOARD_SERVICE_KEY=test\nBOARD_ALAN_IMESSAGE=+15555550100\n`);
    const mdir = path.join(home, 'automations', 'rsd-rep-master-list', 'data'); fs.mkdirSync(mdir, { recursive: true });
    const mfile = path.join(mdir, 'roster.json'); fs.writeFileSync(mfile, JSON.stringify({ reps: master }));
    const boardRoster = ['Avery', 'B. Rivers', 'Casey', 'Casey M.', 'Drew', 'Emery', 'Finley A.', 'Gray', 'Brook', 'Oldtimer'];
    T('settings').set('division', { meetings: ['2027-01-15'], roster: boardRoster, name: 'Rising Sun Division' });

    r = await board(['roster', 'sync', '--json', '--from', mfile]);
    let p = JSON.parse(r.stdout);
    ok(r.code === 0 && p.changed && !p.applied && JSON.stringify(T('settings').get('division').roster) === JSON.stringify(boardRoster), 'roster sync: dry by default, nothing written');
    ok(JSON.stringify(p.removed.map(x => x.name)) === '["Drew","Emery"]', 'roster sync: the two who left come off: ' + JSON.stringify(p.removed));
    ok(JSON.stringify(p.added.map(x => `${x.name}=${x.rep}`).sort()) === JSON.stringify(['Finley O.=Finley Oak', 'Harper=Harper Vale', 'Indy=Indy Reed', 'Jules=Jules Fox', 'Lane=Lane Gale']), 'roster sync: new active reps are added, first name, or "First L." when it is taken: ' + JSON.stringify(p.added));
    ok(p.roster.includes('Lane') && p.added.some(x => x.rep === 'Lane Gale'), 'roster sync: a Leader goes on too (Alan, 2026-10-21: Luke Mills works shifts)');
    ok(JSON.stringify(p.unknown) === '["Oldtimer"]' && p.roster.includes('Oldtimer'), 'roster sync: a name the master list does not know is left alone, and named');
    ok(p.roster.includes('Casey') && p.roster.includes('Casey M.') && p.roster.includes('Finley A.') && p.roster.includes('Brook'), 'roster sync: existing spellings stay as they are (aliases, "First L.", a last-name nickname)');

    r = await board(['roster', 'sync', '--apply', '--from', mfile]);
    const st = T('settings').get('division');
    ok(r.code === 0 && /roster updated/.test(r.stdout) && JSON.stringify(st.former) === '["Drew","Emery"]' && !st.roster.includes('Drew') && st.roster.includes('Harper'), 'roster sync --apply: written, read back, the leavers kept in former: ' + r.stdout + r.stderr);
    ok(st.name === 'Rising Sun Division' && JSON.stringify(st.meetings) === '["2027-01-15"]', 'roster sync --apply: the rest of the settings are untouched');
    r = await board(['roster', 'sync', '--apply', '--from', mfile]);
    ok(r.code === 0 && /already matches/.test(r.stdout), 'roster sync: a second run changes nothing');

    // someone comes back: their old spelling, off former
    fs.writeFileSync(mfile, JSON.stringify({ reps: master.map(x => (x.id === 'drew-park' ? { ...x, status: 'active' } : x)) }));
    r = await board(['roster', 'sync', '--apply', '--json', '--from', mfile]); p = JSON.parse(r.stdout);
    ok(p.applied && p.back.length === 1 && p.back[0].name === 'Drew' && T('settings').get('division').roster.includes('Drew') && JSON.stringify(T('settings').get('division').former) === '["Emery"]', 'roster sync: a rep who rejoins gets their old spelling back');

    // guards: a master list that looks wrong, or too many off at once, changes nothing (exit 3)
    const before = JSON.stringify(T('settings').get('division'));
    fs.writeFileSync(mfile, JSON.stringify({ reps: master.slice(0, 3) }));
    r = await board(['roster', 'sync', '--apply', '--from', mfile]);
    ok(r.code === 3 && /REFUSED/.test(r.stdout) && JSON.stringify(T('settings').get('division')) === before, 'roster sync: a master list with too few active reps is refused, nothing written');
    const many = master.map(x => ({ ...x, status: 'left' })).concat(Array.from({ length: 12 }, (_, i) => rep(`new-${i}`, `New Person${i} Zed${i}`, 'Freshmen')));
    T('settings').set('division', { ...T('settings').get('division'), roster: Array.from({ length: 13 }, (_, i) => `Old${i}`).concat(['Avery', 'B. Rivers', 'Casey', 'Casey M.', 'Gray', 'Harper', 'Indy', 'Jules', 'Brook', 'Finley A.', 'Finley O.', 'Drew', 'Emery']) });
    fs.writeFileSync(mfile, JSON.stringify({ reps: many }));
    const before2 = JSON.stringify(T('settings').get('division'));
    r = await board(['roster', 'sync', '--apply', '--from', mfile]);
    ok(r.code === 3 && /would come off at once/.test(r.stdout) && JSON.stringify(T('settings').get('division')) === before2, 'roster sync: more than 12 off at once is refused unless --force: ' + r.stdout);
    r = await board(['roster', 'sync', '--from', path.join(home, 'nope.json')]);
    ok(r.code !== 0 && /cannot read the rep master list/.test(r.stderr), 'roster sync: no master list is a loud failure');

    // the tick runs it every morning: --dry prints the change; ROSTER-PAUSED stops this step alone
    fs.writeFileSync(mfile, JSON.stringify({ reps: master }));
    T('settings').set('division', { meetings: ['2027-01-15'], roster: boardRoster });
    fs.rmSync(path.join(stage, 'ROSTER-PAUSED'), { force: true });
    const tickpy = (...a) => run('/usr/bin/python3', ['-B', path.join(stage, 'deploy/tick.py'), '--dry', ...a]);
    r = await tickpy('--date', '2027-01-14');
    ok(r.code === 0 && /WOULD UPDATE THE ROSTER/.test(r.stdout) && /Off \(left the team\): Drew \(Drew Park\), Emery \(Emery Cole\)/.test(r.stdout) && /nothing due/.test(r.stdout) && JSON.stringify(T('settings').get('division').roster) === JSON.stringify(boardRoster), 'tick.py --dry: the roster change is printed, nothing written, the due list still decided: ' + r.stdout + r.stderr);
    fs.writeFileSync(path.join(stage, 'ROSTER-PAUSED'), '');
    r = await tickpy('--date', '2027-01-14');
    ok(r.code === 0 && /ROSTER-PAUSED present: roster not synced/.test(r.stdout) && !/WOULD UPDATE THE ROSTER/.test(r.stdout) && /nothing due/.test(r.stdout), 'tick.py: ROSTER-PAUSED stops the roster step alone');
    fs.rmSync(mfile);
    fs.rmSync(path.join(stage, 'ROSTER-PAUSED'));
    r = await tickpy('--date', '2027-01-14');
    ok(r.code === 0 && /WOULD POST TO SLACK/.test(r.stdout) && /no rep master list/.test(r.stdout) && /nothing due/.test(r.stdout), 'tick.py: no master list on the mini is an alert, and the tick carries on');
    fs.writeFileSync(path.join(stage, 'ROSTER-PAUSED'), '');
    fs.rmSync(path.join(home, '.rsd'), { recursive: true, force: true });   // as the blocks before left it: the next block checks a missing env
  });

  await section('index.html: coverage asks (read-only marks from the coverage table)', async () => {
    // The page's one piece of coverage logic, run by itself: the block between the markers may use nothing else from the page.
    const html = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');
    const m = html.match(/\/\* coverage-map:start[^*]*\*\/([\s\S]*?)\/\* coverage-map:end \*\//);
    ok(!!m, 'index.html: the coverage-map block is marked');
    const { COV_OPEN, covKey, coverageMap, covHolds } = new Function(m[1] + '\nreturn { COV_OPEN, covKey, coverageMap, covHolds };')();
    const row = (status, slots, extra = {}) => ({ id: 'cv-' + status, data: { requester: 'Marcus R.', cover: 'Jordan L.', status, slots, ...extra } });
    const show = { kind: 'show', event: '2026-prescott-fall', booth: 0, shift: 1, day: 2, date: '2026-11-14', label: 'Prescott' };
    const kiosk = { kind: 'kiosk', event: '2026-arrowhead', date: '2026-11-28', label: 'Arrowhead kiosk' };
    const sk = covKey.show('2026-prescott-fall', 0, 1, 2), kk = covKey.kiosk('2026-arrowhead', '2026-11-28');
    ok(JSON.stringify(COV_OPEN) === JSON.stringify(['new', 'waiting-approval', 'asking-requester', 'asking-cover']), 'the open statuses are the contract\'s four');
    let cm = coverageMap([row('asking-cover', [show, kiosk])]);
    ok(cm.size === 2 && cm.get(sk).text === 'Waiting on Jordan L.' && cm.get(kk).text === 'Waiting on Jordan L.' && cm.get(sk).waiting, 'asking-cover: "Waiting on <cover>" on a show slot (event + booth/shift/day) and a kiosk day (mall + date)');
    for (const st of ['new', 'waiting-approval', 'asking-requester']) { cm = coverageMap([row(st, [show])]); ok(cm.size === 1 && cm.get(sk).text === 'Coverage asked: Jordan L.' && !cm.get(sk).waiting, `${st}: "Coverage asked: <cover>"`); }
    for (const st of ['done', 'partial', 'declined', 'cancelled', 'expired', 'refused', 'someday', '', undefined]) ok(coverageMap([row(st, [show, kiosk])]).size === 0, `status ${JSON.stringify(st)}: shows nothing`);
    ok(coverageMap([row('new', [show], { cover: '  ' }), row('new', [show], { requester: '' }), row('new', [show], { cover: 7 })]).size === 0, 'no cover or no requester: nothing (fail closed)');
    cm = coverageMap([row('new', [{ ...show, booth: -1 }, { ...show, shift: 1.5 }, { ...show, day: null }, { ...show, event: '' }, { ...show, kind: 'booth' }, { ...kiosk, date: '11/28' }, { ...kiosk, event: null }, null, 'x'])]);
    ok(cm.size === 0, 'malformed slots are skipped, none of them throws');
    cm = coverageMap([row('new', [{ ...show, booth: '0', shift: '1', day: '2' }])]);
    ok(cm.has(sk), 'indexes written as digit strings still land on the slot');
    ok(coverageMap(null).size === 0 && coverageMap([null, {}, { data: null }, { data: 'x' }]).size === 0, 'no rows, or rows with no data: an empty map');
    cm = coverageMap([row('asking-cover', [show], { cover: 'Jordan L.' }), row('new', [show], { cover: 'Sarah' })]);
    ok(cm.get(sk).text === 'Waiting on Jordan L.', 'two open asks on one slot: the one already asking the cover wins, in either order');
    cm = coverageMap([row('new', [show], { cover: 'Sarah' }), row('asking-cover', [show], { cover: 'Jordan L.' })]);
    ok(cm.get(sk).text === 'Waiting on Jordan L.', 'two open asks on one slot, the other order');
    const mk = coverageMap([row('new', [show])]).get(sk);
    ok(covHolds(mk, 'Marcus R.') && covHolds(mk, 'marcus r. ') && covHolds(mk, 'Sarah / Marcus R.'), 'the mark shows while the slot holds the requester (any case, either half of a split)');
    ok(!covHolds(mk, 'Jordan L.') && !covHolds(mk, '') && !covHolds(mk, '__X__') && !covHolds(null, 'Marcus R.'), 'and not once the slot holds someone else, nobody, or no shift');
    // read-only: the page reads coverage and never writes it or asks for coverage itself
    ok(/from\('coverage'\)\.select\(/.test(html), 'index.html reads the coverage table');
    ok(!/from\('coverage'\)\.(insert|update|upsert|delete)\b/.test(html) && !/coverage_request/.test(html) && !/['"]coverage\//.test(html), 'index.html never writes coverage, never calls coverage_request');
  });

  await section('index.html: Grid shows every day; the weekend jump (Alan, 2026-10-27)', async () => {
    const html = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');
    // the page's own scripts parse: a name declared twice (wkShort, 2026-10-27) stops the whole board, and no block test sees it
    const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
    let parsed = inline.length > 1; for (const src of inline) { try { new Function(src); } catch (err) { parsed = false; console.log('  page script: ' + err.message); } }
    ok(parsed, 'index.html: every inline script parses (nothing declared twice)');
    const g = html.match(/function gridCells\([\s\S]*?\n}\n/);
    ok(!!g && !/colspan/.test(g[0]), 'Grid: one cell per day, read-only too (a run of the same name was one cell with the name in its first column)');
    const seg = html.match(/<div class="segrow">([\s\S]*?)<\/header>/);
    ok(!!seg && /id="wkJump"/.test(seg[1]) && /<select id="wkJumpSel" aria-label="Jump to a weekend">/.test(seg[1])
      && /id="wkPrev" aria-label="Previous weekend"/.test(seg[1]) && /id="wkNext" aria-label="Next weekend"/.test(seg[1]),
      'the weekend jump and its arrows sit in the pinned row, beside the season tabs, and say what they do');
    ok(/\.wkpick select\{[^}]*font-size:16px/.test(html), 'the weekend jump\'s select is 16px (iOS zooms the page on a smaller field)');
    // pinch zoom on a phone: only the board scales, so every on-screen position read goes through screenRect, which corrects
    // for WebKit reporting a zoomed box in the board's own px (right in Chrome, off by the zoom on an iPhone)
    ok(/@media \(pointer:coarse\)\{ #board,#board \.gridwrap\{touch-action:pan-x pan-y\} \}/.test(html), 'pinch zoom: on a touch screen a pinch on the board is the board\'s, not the page\'s');
    ok(/const ZMIN=\.55, ZMAX=1\.5,/.test(html), 'pinch zoom: 55% to 150%');
    const sr = html.match(/function screenRect\([\s\S]*?\n}\n/), raw = (html.match(/getBoundingClientRect\(/g) || []).length;
    ok(!!sr && raw === (sr[0].match(/getBoundingClientRect\(/g) || []).length, 'every getBoundingClientRect is inside screenRect (call screenRect instead)');
  });

  await section('index.html: every day label the board holds finds its day (Alan, 2026-10-27)', async () => {
    const html = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');
    const a = html.indexOf('/* ---- date helpers ---- */'), z = html.indexOf('/* ---- meetings ---- */');
    ok(a > 0 && z > a, 'index.html: the date helpers block is where the test reads it');
    const H = new Function(html.slice(a, z) + '\nreturn {dayOf,offDay,notShift,isSE,slotDates,dshort};')();
    const D = await import(path.join(REPO, 'scripts/lib/dates.mjs'));
    // the labels on the live board on 2026-10-27 that Grid could not place: each one's dates against its weekend
    const cases = [
      ['2026-11-27', ['Thursday (Thanksgiving Day)', 'Friday', 'Saturday', 'Sunday'], '2026-11-26,2026-11-27,2026-11-28,2026-11-29'],
      ['2027-02-26', ['Friday (set-up)', 'Saturday', 'Sunday', 'Monday'], '2027-02-26,2027-02-27,2027-02-28,2027-03-01'],
      ['2027-05-14', ['Thursday\n (SET UP DAY)', 'Friday', 'Saturday'], '2027-05-13,2027-05-14,2027-05-15'],
      ['2027-02-05', ['Friday (SE)', 'Saturday', 'Sunday', 'Monday (SE)'], '2027-02-05,2027-02-06,2027-02-07,2027-02-08'],
      ['2027-04-16', ['Wed (set-up', 'Thurs', 'Friday', 'Sat', 'Sun'], '2027-04-14,2027-04-15,2027-04-16,2027-04-17,2027-04-18'],
      ['2027-07-02', ['Tuesday', 'Wednesday (SC1)', 'Thursday', 'Friday', 'Saturday', 'Sunday'], '2027-06-29,2027-06-30,2027-07-01,2027-07-02,2027-07-03,2027-07-04'],
      ['2026-10-30', ['1/26/2024', '1/27/2024', '1/28/2024'], '2026-10-30,2026-10-31,2026-11-01'],
      ['2027-06-18', ['Saturday', 'Sunday', 'MUST be set up by 8 am morning of'], '2027-06-19,2027-06-20,'],
      ['2027-02-26', ['Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday', 'Tucson, AZ'], '2027-02-23,2027-02-24,2027-02-25,2027-02-26,2027-02-27,2027-02-28,'],
    ];
    for (const [w, days, want] of cases) {
      const got = H.slotDates({ days, dates: days.map(() => null) }, w).map(x => x || '').join();
      ok(got === want, `Grid: ${JSON.stringify(days)} on the ${w} weekend falls on ${want}: ${got}`);
    }
    const off = ['Friday (set-up)', 'Wed (set-up', 'Thursday\n (SET UP DAY)', 'MUST be set up by 8 am morning of', 'Tucson, AZ', 'Service Events', 'Sunday tear-down'];
    const days = ['Friday', 'Thursday (Thanksgiving Day)', 'Wednesday (SC1)', 'Thurs', '3/5', '1/26/2024', ''];
    const se = ['Friday (SE)', 'Monday (SE)', 'Sunday SE', 'Mon SE', 'SE Surprise'];
    ok(off.every(H.offDay) && ![...days, ...se].some(H.offDay), 'a set-up day and a column that names no day are not shifts; a weekday with a note, a date and an SE day are not that: ' +
      JSON.stringify([...off, ...days, ...se].map(l => [l, H.offDay(l)])));
    ok(se.every(H.isSE) && !off.some(H.isSE), 'SE still means a sharpening day only (a set-up day does not show as "sharpening")');
    ok([...off.slice(0, 4), 'Sunday tear-down', ...days, ...se].every(l => H.notShift(l) === D.isSE(l)),
      'the page and the scripts agree on which days are not shifts, "set-up" with a hyphen included: ' + JSON.stringify([...off.slice(0, 4), ...days, ...se].map(l => [l, H.notShift(l), D.isSE(l)])));
    ok(H.dshort('1/26/2024') === 'Fri' && H.dshort('Wed (set-up') === 'Wed' && H.dshort('Friday (SE)') === 'Fri SE' && H.dshort('Mon SE') === 'Mon SE' && H.dshort('Thurs') === 'Thu',
      'a column\'s short name is its weekday (a date shown as "Friday" on the Sheet was "1/2")');
    ok(H.dayOf('constructor')[0] === 'none' && H.dayOf('Tucson, AZ')[0] === 'none', 'a word that is not a weekday names no day');
    for (const f of ['sellableSlots', 'filledSlots', 'pickState']) ok(new RegExp(`function ${f}\\([^\\n]*\\n?[\\s\\S]{0,400}?notShift\\(`).test(html), `index.html ${f} skips set-up days and columns that name no day`);
  });

  await section('never again leaves the year it was marked in as it was (Salt River Spooktacular 2026, Alan 2026-10-27)', async () => {
    // Kendall worked it; "never again" meant 2027 on. The button and `board never` both marked every 2026 date
    // Cancelled and dead, so the 2026 board showed a show that ran as crossed off.
    const show = { year: 2025, name: 'Spooktacular Balloon Festival', status: 'Booked', vcStatus: 'Booked', dead: false, neverWork: false, days: ['Friday'],
      booths: [{ label: '', days: ['Friday'], shifts: [{ label: 'Shift 1', slots: [{ rep: 'Kendall', ft: [] }] }] }] };
    T('events').set('2025-spook', { ...show, startDate: '2025-10-24', weekend: '2025-10-24' });
    T('events').set('2025-spook-2', { ...show, startDate: '2025-10-31', weekend: '2025-10-31' });
    r = await board(['never', '2025-spook', '--why', 'price for the crowd']);
    ok(r.code === 0, 'never exits 0: ' + r.stderr);
    const nw = [...T('never_work').values()].find(n => n.fromEventId === '2025-spook');
    ok(nw && nw.seriesKey && nw.lastYear === 2025 && nw.reason === 'price for the crowd', 'never: the show is on the Never list: ' + JSON.stringify(nw));
    for (const id of ['2025-spook', '2025-spook-2']) {
      const e = T('events').get(id);
      ok(e.status === 'Booked' && e.dead === false && e.neverWork === false, `never: ${id} keeps its status and stays live in 2025: ` + JSON.stringify({ status: e.status, dead: e.dead, neverWork: e.neverWork }));
    }
    // a name of only month and year words has no series key: the list entry is kept under the show's id, and matched by it
    T('events').set('2025-oct', { ...show, name: 'October 2025', startDate: '2025-10-10', weekend: '2025-10-10' });
    r = await board(['never', '2025-oct']); ok(r.code === 0 && T('events').get('2025-oct').status === 'Booked', 'never: a show with no series key is listed too: ' + r.stderr);
    r = await board(['rollforward', '2026', '--dry-run', '--json']);
    ok(r.code === 0 && !JSON.parse(r.stdout).some(x => /spook|oct/.test(x.from)), 'rollforward: the Never list alone still holds them all back: ' + r.stdout + r.stderr);
    // the page's button: writes the Never list, never the show's rows
    const html = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');
    const go = html.match(/closest\('\[data-never-go\]'\)\)\{([\s\S]*?)\n    return; \}/);
    ok(!!go && /db\.doc\('never_work\/'/.test(go[1]) && !/events\//.test(go[1]) && !/Cancelled|dead/.test(go[1]), 'index.html: Never work again writes the Never list and leaves the show\'s dates alone');
    ok(/neverKeys\(\)\.has\(seriesKey\(e\)\|\|e\.id\)/.test(html), 'index.html: a show already on the Never list says so on its card instead of offering the button again');
  });

  await section('no env', async () => {
    // ---- missing env is a loud failure
    r = await board(['tick'], { BOARD_SUPABASE_URL: '', BOARD_SERVICE_KEY: '' }); ok(r.code !== 0 && /board\.env/.test(r.stderr), 'no env: exits non-zero and says where to put it');
  });
} finally { server.close(); fs.rmSync(home, { recursive: true, force: true }); }
console.log(`${pass} passed, ${failN} failed`); process.exit(failN ? 1 : 0);
