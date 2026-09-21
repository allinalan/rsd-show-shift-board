#!/usr/bin/env node
/*
  Tests for scripts/board.mjs against an in-memory stand-in for Supabase's REST API.
  No network, no real database, no ~/.rsd/board.env (HOME points at a temp dir).
      node tests/run-all.mjs
  The point of most of these: promoter contact/phone/email must never land in `events` (public).
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
const server = http.createServer((req, res) => {
  let body = ''; req.on('data', c => body += c); req.on('end', () => {
    const u = new URL(req.url, 'http://x'); const p = u.pathname.replace('/rest/v1/', ''); const send = (code, v) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(v === undefined ? '' : JSON.stringify(v)); };
    if (p === 'rpc/merge_doc') { const { tbl, doc_id, patch } = JSON.parse(body); const cur = T(tbl).get(doc_id) || {}; const next = { ...cur, ...patch }; T(tbl).set(doc_id, next); return send(200, next); }
    const eq = u.searchParams.get('id'); const id = eq && eq.startsWith('eq.') ? decodeURIComponent(eq.slice(3)) : null;
    if (req.method === 'GET') { let r = [...T(p)].map(([i, data]) => ({ id: i, data, updated_at: 'now' })); if (id !== null) r = r.filter(x => x.id === id); r.sort((a, b) => a.id.localeCompare(b.id)); const lim = +u.searchParams.get('limit'); return send(200, lim ? r.slice(0, lim) : r); }
    if (req.method === 'POST') { for (const row of JSON.parse(body)) T(p).set(row.id, row.data); return send(201); }
    if (req.method === 'DELETE') { T(p).delete(id); return send(204); }
    send(405, { message: 'unsupported' });
  });
});

let pass = 0, failN = 0;
const ok = (cond, name) => { if (cond) pass++; else { failN++; console.error('  FAIL  ' + name); } };
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'board-test-'));
let base = '';
const board = (args, env = {}) => new Promise(r => execFile(process.execPath, [path.join(REPO, 'scripts/board.mjs'), ...args],
  { env: { PATH: process.env.PATH, HOME: home, BOARD_SUPABASE_URL: base, BOARD_SERVICE_KEY: 'test', ...env } }, (err, stdout, stderr) => r({ code: err ? err.code : 0, stdout, stderr })));
const PRIV = ['contact', 'phone', 'email'];
const leaked = () => [...T('events').values()].filter(d => PRIV.some(k => k in d));
const isSE = l => /set\s*up|tear\s*down|\bse\b/i.test(String(l || ''));
const staffedOf = e => (e.booths || []).reduce((n, b) => n + (b.shifts || []).reduce((m, s) =>
  m + (s.slots || []).filter((sl, i) => sl.rep && sl.rep !== '__X__' && !isSE(b.days[i])).length, 0), 0);

await new Promise(r => server.listen(0, '127.0.0.1', r)); base = 'http://127.0.0.1:' + server.address().port;
try {
  // ---- add: contacts go to event_contacts, not events
  let r = await board(['add', '--name', 'Test Fair', '--start', '2026-03-06', '--end', '2026-03-07', '--json', 'phone=(928) 555-0100', 'contact=Jane Doe', 'promoter=Fair Co']);
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
  r = await board(['rollforward', '2027']); ok(r.code === 0, 'rollforward exits 0: ' + r.stderr);
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

  // ---- tick
  T('settings').set('division', { meetings: ['2027-01-15'] });
  const due = async d => JSON.parse((await board(['tick', '--json', '--date', d])).stdout).due.map(x => x.routine);
  ok((await due('2027-01-08')).join() === 'preflight', 'tick: preflight 7 days before a meeting');
  ok((await due('2027-01-16')).join() === 'booking-sweep', 'tick: booking sweep the day after');
  ok((await due('2027-01-13')).join() === 'event-check', 'tick: event check on a Wednesday');
  ok((await due('2027-01-14')).length === 0, 'tick: nothing on an ordinary Thursday');

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
  ok((await due('2027-01-08')).join() === 'preflight', 'seed: tick still reports preflight due afterwards');

  // ---- deploy/tick.py --dry: decides and prints, never sends. HOME is the temp dir, so it reads a fake board.env.
  // The launcher runs from a staged copy: tick.py takes its root from where it sits, so the stage has its own
  // PAUSED, logs/ and .git, and the real repo's kill switch or a dirty tree cannot reach these tests.
  fs.mkdirSync(path.join(home, '.rsd'), { recursive: true });
  fs.writeFileSync(path.join(home, '.rsd', 'board.env'), `BOARD_SUPABASE_URL=${base}\nBOARD_SERVICE_KEY=test\nBOARD_ALAN_IMESSAGE=+15555550100\n`);
  T('settings').set('division', { meetings: ['2027-01-15'] });
  const stage = path.join(home, 'stage'), tickLog = path.join(stage, 'logs', 'tick.log');
  for (const f of ['deploy/tick.py', 'scripts/board.mjs', '.gitignore']) { fs.mkdirSync(path.dirname(path.join(stage, f)), { recursive: true }); fs.copyFileSync(path.join(REPO, f), path.join(stage, f)); }
  const run = (bin, args) => new Promise(r => execFile(bin, args, { env: { PATH: process.env.PATH, HOME: home } }, (err, stdout, stderr) => r({ code: err ? err.code : 0, stdout, stderr })));
  const tickpy = (...a) => run('/usr/bin/python3', ['-B', path.join(stage, 'deploy/tick.py'), '--dry', ...a]);
  r = await tickpy('--date', '2027-01-08');
  ok(r.code === 0 && /WOULD POST TO SLACK/.test(r.stdout) && /WOULD iMESSAGE ALAN/.test(r.stdout) && /say "run the board preflight"/.test(r.stdout), 'tick.py --dry: a due routine produces one Slack + one iMessage notice: ' + r.stderr);
  r = await tickpy('--date', '2027-01-14');
  ok(r.code === 0 && /nothing due/.test(r.stdout) && !/WOULD/.test(r.stdout), 'tick.py --dry: nothing due means no notices');

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
  r = await tickreal('--date', '2027-01-08');
  ok(r.code === 0 && count(r.stdout, /^SLACK: /gm) === 2 && count(r.stdout, /^IMESSAGE: /gm) === 1 && /say "run the board preflight"/.test(r.stdout), 'tick.py: a dirty tree on a due day sends the alert and still the due notice: ' + r.stdout + r.stderr);
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

  fs.writeFileSync(path.join(home, '.rsd', 'board.env'), 'BOARD_SUPABASE_URL=\n');
  r = await tickpy(); ok(r.code === 1 && /AUTOMATION FAILURE/.test(r.stdout), 'tick.py --dry: missing env is a loud failure, exit 1');
  fs.rmSync(path.join(home, '.rsd'), { recursive: true, force: true });

  // ---- parse-sheet: the Sheet's shape, read the way the 2026-09-13 migration read it.
  // A synthetic grid, because the real schedule is 800 rows of promoter contacts and cannot live
  // in a public repo. The real check is `parse-sheet.mjs <xlsx> --verify` against seed/events.json.
  {
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
  }

  // ---- missing env is a loud failure
  r = await board(['tick'], { BOARD_SUPABASE_URL: '', BOARD_SERVICE_KEY: '' }); ok(r.code !== 0 && /board\.env/.test(r.stderr), 'no env: exits non-zero and says where to put it');
} finally { server.close(); fs.rmSync(home, { recursive: true, force: true }); }
console.log(`${pass} passed, ${failN} failed`); process.exit(failN ? 1 : 0);
