#!/usr/bin/env node
/*
  sync-requests — the mini's half of keeping the board current with the Sheet between Wednesdays.

  THE BUTTON (Alan, 2026-09-28: the team re-staffs shows on the Sheet and wants the board to show it now).
  launchd (com.allinalan.rsd-board-sync) runs this every 30 seconds. Almost every time it asks the board
  one question (any pending rows in sheet_syncs?), hears no, and exits printing nothing. When an editor has
  pressed "Sync from the Sheet", it claims every pending row, runs scripts/sheet-sync.mjs --apply ONCE for all
  of them (five presses are one sync), and the sync writes its result onto those rows, which the page is
  watching. The board redraws on its own when the sync's writes land, as it does for any edit.

  THE HOURLY SYNC (Alan, 2026-09-28, the same day). From config sync.auto.from (the day after the third clean
  Wednesday), with no press waiting, it also runs the sync itself whenever the last finished run of any kind is
  over an hour old, inside sync.auto.hours (7am-9pm Phoenix). A board Matt and JP might open has to match the
  Sheet, or it just looks wrong. A run that STOPPED (parser drift, over the limits) pauses the hourly sync
  until a sync gets through: a person has to look first, and repeating it hourly would only repeat the stop.

  Either way it is the Wednesday sync with every guard it has: three-way, board edits win ties, VectorConnect's
  dead shows get no new reps, parser drift or an oversized change set stops it (the page says why; nothing is
  written). There is no VC pull on these runs, so a date the Sheet moved on a show VC has a record for is held
  for the Wednesday run. sheet-sync's lock keeps these and the Wednesday job from overlapping.

  Kill switch: a PAUSED file in the repo root (presses wait on the page; they are not lost), or
  ./install.sh --disarm. Log: logs/sync-requests.log (one line per sync, nothing when idle).

  Usage: sync-requests.mjs [-- <extra sheet-sync args>]        (the tests pass --grid and --date through)
  Exit:  0 nothing to do, or a sync ran (whatever it found) · 1 the board could not be read
*/
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { fileURLToPath } from 'url';
import { boardApi } from './lib/board-api.mjs';
import { isMain } from './lib/is-main.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PASS = process.argv.includes('--') ? process.argv.slice(process.argv.indexOf('--') + 1) : [];
const RUN_TIMEOUT_MS = 5 * 60000;          // a sync takes seconds; five minutes is a hung download
const STALE_RUNNING_MS = 15 * 60000;       // a row left "running" this long was orphaned (a restart mid-run)
const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const say = m => console.log(`[${stamp()}] ${m}`);

/** Phoenix's date and hour for an instant (the mini's clock is Phoenix too; this does not rely on it). */
export function phoenix(ms) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Phoenix', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
}
/**
 * Is the hourly sync due? `auto` is config sync.auto ({ from, everyMinutes, hours: [from, to) }), `last` the run
 * that finished last ({ status, finished_at } or null). Returns the reason it is not, or '' when it is due.
 */
export function autoWhyNot({ auto, last, now }) {
  if (!auto || !auto.from) return 'off';
  const { date, hour } = phoenix(now);
  if (date < auto.from) return `off until ${auto.from}`;
  const [h0, h1] = auto.hours || [0, 24];
  if (hour < h0 || hour >= h1) return 'outside hours';
  if (last && last.status === 'stopped') return 'paused: the last sync stopped, so a person looks first';
  if (last && now - Date.parse(last.finished_at) < (auto.everyMinutes ?? 60) * 60000) return 'synced recently';
  return '';
}

const runSync = (args) => new Promise(res => execFile(process.execPath, [path.join(REPO, 'scripts', 'sheet-sync.mjs'), '--apply', '--json', ...args, ...PASS],
  { cwd: REPO, env: process.env, timeout: RUN_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 },
  (err, stdout, stderr) => res({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, killed: !!(err && err.killed), stdout, stderr })));
const outcome = r => {
  let s = null; try { s = JSON.parse(r.stdout); } catch { /* no JSON: it failed before the report */ }
  return { s, how: s ? (s.stopped ? `stopped: ${s.stopped}` : `${s.wrote ? 'written' : 'not written'}, ${s.eventsTouched} event(s), ${s.slotChanges} shift change(s), ${s.held.length} held, ${s.conflicts.length} conflict(s)`)
    : r.code === 4 ? 'another sync was running' : `failed (exit ${r.code})` };
};

async function main() {
  if (fs.existsSync(path.join(REPO, 'PAUSED'))) return 0;
  const api = boardApi({ actor: 'service:sheet-sync' });
  const open = await api.syncs.open();

  const running = open.filter(r => r.status === 'running');
  const orphaned = running.filter(r => Date.now() - Date.parse(r.started_at || 0) > STALE_RUNNING_MS);
  if (orphaned.length) {
    await api.syncs.move(orphaned.map(r => r.id), 'running', { status: 'failed', finished_at: new Date().toISOString(),
      result: { error: 'interrupted: the sync stopped partway (the mini restarted, or the run was killed). Press Sync again.' } });
    say(`requests ${orphaned.map(r => r.id).join(',')}: left running for over 15 minutes, marked failed`);
  }
  if (running.length > orphaned.length) return 0;   // a sync is under way; the next tick picks up anything newer

  const pending = open.filter(r => r.status === 'pending');
  if (!pending.length) return hourly(api);
  const claimed = (await api.syncs.move(pending.map(r => r.id), 'pending', { status: 'running', started_at: new Date().toISOString() })) || [];
  if (!claimed.length) return 0;
  const ids = claimed.map(r => r.id);
  const who = [...new Set(claimed.map(r => r.requested_by).filter(Boolean))].join(', ');

  const r = await runSync(['--tag', `req${ids[0]}`, '--requests', ids.join(','), '--via', 'button']);
  if (r.code === 4) {
    // another sync held the lock the whole time: put the requests back, the next tick tries again
    await api.syncs.move(ids, 'running', { status: 'pending', started_at: null });
    say(`requests ${ids.join(',')} (${who}): another sync was running; put back to try again`);
    return 0;
  }
  // sheet-sync writes its own outcome onto the rows; anything still "running" means it died before it could
  const left = (await api.syncs.byIds(ids)).filter(x => x.status === 'running').map(x => x.id);
  if (left.length) {
    const tail = (r.stderr || '').trim().split('\n').filter(Boolean).slice(-3).join(' | ').slice(-400);
    await api.syncs.move(left, 'running', { status: 'failed', finished_at: new Date().toISOString(),
      result: { error: r.killed ? `the sync took longer than ${RUN_TIMEOUT_MS / 60000} minutes and was stopped` : (tail || `sheet-sync exited ${r.code}`) } });
  }
  const { s, how } = outcome(r);
  say(`requests ${ids.join(',')} (${who}): ${how}`);
  if (!s || r.code) process.stderr.write(r.stderr || '');
  return 0;
}

async function hourly(api) {
  const CFG = JSON.parse(fs.readFileSync(path.join(REPO, 'config', 'event-check.json'), 'utf8'));
  const auto = (CFG.sync || {}).auto;
  if (!auto || !auto.from) return 0;                 // off: no need to ask the board anything more
  const now = Date.now();
  if (autoWhyNot({ auto, last: null, now })) return 0;             // before the start date or outside hours: no second read
  if (autoWhyNot({ auto, last: await api.syncs.last(), now })) return 0;
  const r = await runSync(['--tag', 'auto', '--via', 'auto']);    // one report a day, the latest hour's; every run is on the record
  const { s, how } = outcome(r);
  say(`hourly sync: ${how}`);
  if ((!s || r.code) && r.code !== 4) process.stderr.write(r.stderr || '');
  return 0;
}

// An outage would otherwise log the same line every 30 seconds: say it once, and say when it clears.
const STATE = process.env.BOARD_STATE_DIR || path.join(REPO, 'state'), LAST_ERR = path.join(STATE, 'sync-requests.error');
if (isMain(import.meta.url)) {
  main().then(c => {
    if (fs.existsSync(LAST_ERR)) { fs.rmSync(LAST_ERR, { force: true }); say('the board is reachable again'); }
    process.exit(c);
  }).catch(e => {
    const msg = String(e.message || e).slice(0, 300);
    let last = ''; try { last = fs.readFileSync(LAST_ERR, 'utf8'); } catch { /* first time */ }
    if (msg !== last) {
      console.error(`[${stamp()}] sync-requests: ${msg} (said once; the next line is when it clears)`);
      try { fs.mkdirSync(STATE, { recursive: true }); fs.writeFileSync(LAST_ERR, msg, { mode: 0o600 }); } catch { /* the log line is enough */ }
    }
    process.exit(1);
  });
}
