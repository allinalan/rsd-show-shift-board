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

  // ---- deploy/tick.py --dry: decides and prints, never sends. HOME is the temp dir, so it reads a fake board.env.
  fs.mkdirSync(path.join(home, '.rsd'), { recursive: true });
  fs.writeFileSync(path.join(home, '.rsd', 'board.env'), `BOARD_SUPABASE_URL=${base}\nBOARD_SERVICE_KEY=test\nBOARD_ALAN_IMESSAGE=+15555550100\n`);
  T('settings').set('division', { meetings: ['2027-01-15'] });
  const tickpy = (...a) => new Promise(r => execFile('/usr/bin/python3', ['-B', path.join(REPO, 'deploy/tick.py'), '--dry', ...a], { env: { PATH: process.env.PATH, HOME: home } }, (err, stdout, stderr) => r({ code: err ? err.code : 0, stdout, stderr })));
  r = await tickpy('--date', '2027-01-08');
  ok(r.code === 0 && /WOULD POST TO SLACK/.test(r.stdout) && /WOULD iMESSAGE ALAN/.test(r.stdout) && /say "run the board preflight"/.test(r.stdout), 'tick.py --dry: a due routine produces one Slack + one iMessage notice: ' + r.stderr);
  r = await tickpy('--date', '2027-01-14');
  ok(r.code === 0 && /nothing due/.test(r.stdout) && !/WOULD/.test(r.stdout), 'tick.py --dry: nothing due means no notices');
  fs.writeFileSync(path.join(home, '.rsd', 'board.env'), 'BOARD_SUPABASE_URL=\n');
  r = await tickpy(); ok(r.code === 1 && /AUTOMATION FAILURE/.test(r.stdout), 'tick.py --dry: missing env is a loud failure, exit 1');
  fs.rmSync(path.join(home, '.rsd'), { recursive: true, force: true });

  // ---- missing env is a loud failure
  r = await board(['tick'], { BOARD_SUPABASE_URL: '', BOARD_SERVICE_KEY: '' }); ok(r.code !== 0 && /board\.env/.test(r.stderr), 'no env: exits non-zero and says where to put it');
} finally { server.close(); fs.rmSync(home, { recursive: true, force: true }); }
console.log(`${pass} passed, ${failN} failed`); process.exit(failN ? 1 : 0);
