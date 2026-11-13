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

  WHAT IT SAYS TO ALAN (2026-11-13). A sync that stopped used to log one line, exit 0 and pause the hourly sync,
  while the page told editors "Alan has the report": nothing was ever sent to him. And a 40-hour outage read the
  same as a one-second blip. Three things now go to #rsd-alerts, each ONCE, through slackroom (route rsd.alerts,
  the door deploy/tick.py uses; this script holds no channel, webhook or token):
    - a sync stopped, why (the guard's own words), and that the hourly sync is paused until someone looks;
    - no sync has got through for sync.watch.quietHours (3) inside the hourly window, while the hourly sync is on;
    - a sync got through again.
  What has been said, and any alert Slack has not taken yet (offered again every sync.watch.alertRetryMinutes),
  is kept in state/sync-requests.watch.json (600). PAUSED silences all of it.

  A BLIP IS NOT AN OUTAGE. A board read that fails is tried once more after sync.watch.retrySeconds, and a run
  that still cannot read the board exits 0 with its one log line until sync.watch.failuresBeforeExit runs in a
  row have failed (4, two minutes); from then on each run exits 1 until it clears. Writes are never repeated.

  Kill switch: a PAUSED file in the repo root (presses wait on the page; they are not lost), or
  ./install.sh --disarm. Log: logs/sync-requests.log (one line per sync, nothing when idle).

  Usage: sync-requests.mjs [-- <extra sheet-sync args>]        (the tests pass --grid and --date through)
  Exit:  0 nothing to do, a sync ran (whatever it found), or a first few failed reads · 1 the board could not be
         read failuresBeforeExit runs in a row, or an alert is still unsent after that many tries
*/
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { createRequire } from 'module';
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

// ---------- what it says to Alan: the rules (pure; the tests drive them with their own clock) -------------------
const HOUR = 3600000;
const WATCH_DEFAULTS = { quietHours: 3, retrySeconds: 5, failuresBeforeExit: 4, alertRetryMinutes: 10 };
/** config sync.watch over the defaults. */
export const watchSettings = sync => ({ ...WATCH_DEFAULTS, ...((sync && sync.watch) || {}) });
/** "9:02 AM" in Phoenix, with the day ("Nov 12, 8:59 PM") when that is not today. */
export function clock(ms, now) {
  const f = o => new Intl.DateTimeFormat('en-US', { timeZone: 'America/Phoenix', ...o }).format(new Date(ms));
  const time = f({ hour: 'numeric', minute: '2-digit' }).split(String.fromCharCode(0x202f)).join(' ');   // newer ICU puts a narrow no-break space before AM/PM
  return phoenix(ms).date === phoenix(now).date ? time : `${f({ month: 'short', day: 'numeric' })}, ${time}`;
}
const hoursOf = ms => { const h = Math.max(1, Math.floor(ms / HOUR)); return `${h} hour${h === 1 ? '' : 's'}`; };
/** The guard that stopped a sync, without its numbers ("parser drift", "over the limits"): two stops of one kind are one stop. */
export const stopKind = reason => String(reason || '').split(':')[0].trim().slice(0, 80) || 'stopped';
/** Today's first hour of the hourly window, as an instant (Phoenix is UTC-7 all year). */
export const windowStart = (now, auto) => Date.parse(`${phoenix(now).date}T${String(((auto && auto.hours) || [0, 24])[0]).padStart(2, '0')}:00:00-07:00`);

const stopText = y => `MAC MINI AUTOMATION FAILURE — rsd-show-shift-board sync: a Sheet -> board sync stopped and changed nothing (${y.via === 'auto' ? 'the hourly sync' : 'the Sync button'}). `
  + `Why, in the guard's own words: ${String(y.reason || 'no reason given').trim()} `
  + 'The hourly sync is now paused until a sync gets through, so a person has to look first.'
  + (y.report ? ` The plan it refused: ${y.report} in the board's folder on the mini.` : '') + ' Said once for this stop.';
const quietText = ({ floor, now, seen, st }) => 'MAC MINI AUTOMATION FAILURE — rsd-show-shift-board sync: '
  + `no Sheet -> board sync has got through for ${hoursOf(now - floor)} inside the hourly window (the last one through: ${st.done ? clock(st.done, now) : 'none seen yet'}). `
  + (seen.error ? `The mini cannot read the board (${seen.error}).`
    : st.stop || (seen.last && seen.last.status === 'stopped') ? 'The last sync stopped, and the hourly sync stays paused until one gets through: a person has to look first.'
      : (seen.last && seen.last.status === 'failed') || (seen.sync && seen.sync.status === 'failed') ? 'Each try is failing.' : 'The hourly sync is on, but none has finished.')
  + ' Changes made on the Sheet are not reaching the board. Said once; the next line is when a sync gets through.';
const backText = ({ st, done, now }) => `rsd-show-shift-board sync: the board is syncing from the Sheet again. A sync got through at ${clock(done, now)}`
  + (st.done ? `, the first since ${clock(st.done, now)}.` : '.')      // st.done is still the one before this
  + (st.stop ? ' The stop is cleared and the hourly sync is running again.' : '');

/**
 * What to say about the sync itself, and what to remember. `st` is what the listener remembers between runs,
 * `seen` what this run saw, `now` the clock, `sync` config sync. Returns { st, say }: the new memory, with every
 * new alert already added to st.unsent, and the texts that were added (each condition is said once).
 *   seen.sync   a sync this run ran: { status: 'done' | 'stopped' | 'failed', via, reason, report }, or null
 *   seen.last   the board's last finished run ({ status, finished_at }) when this run read it
 *   seen.error  why the board could not be read at all, or null
 */
export function watch({ st, seen, now, sync }) {
  const W = watchSettings(sync), auto = (sync || {}).auto;
  st = { since: now, done: null, stop: null, quiet: null, fails: 0, ...(st || {}), unsent: [...((st && st.unsent) || [])] };
  const say = [];
  // a sync that got through: this run's own, or the newest on the board's record (the button, the hourly, Wednesday's)
  const onRecord = seen.last && seen.last.status === 'done' ? Date.parse(seen.last.finished_at) : 0;
  const done = Math.max(seen.sync && seen.sync.status === 'done' ? now : 0, onRecord || 0, st.done || 0) || null;
  if (done && ((st.stop && done > st.stop.at) || (st.quiet && done > st.quiet.since))) {
    say.push(backText({ st, done, now }));
    st.stop = null; st.quiet = null; st.unsent = [];      // anything Slack had not taken yet is overtaken by this line
  }
  st.done = done;
  // a sync this run ran, stopped by a guard: once per stop, however many times the button is pressed into it
  if (seen.sync && seen.sync.status === 'stopped') {
    const kind = stopKind(seen.sync.reason);
    if (!st.stop || st.stop.kind !== kind) { say.push(stopText(seen.sync)); st.stop = { kind, at: now }; }
  }
  // nothing through for too long, counted only while the hourly sync is meant to be running (on, and inside its hours)
  if (!st.quiet && !autoWhyNot({ auto, last: null, now })) {
    const floor = Math.max(st.done || st.since, windowStart(now, auto));
    if (now - floor >= W.quietHours * HOUR) { say.push(quietText({ floor, now, seen, st })); st.quiet = { since: floor }; }
  }
  for (const text of say) st.unsent.push({ text, at: now, tries: 0, next: 0 });
  return { st, say };
}

/**
 * Offer Slack every alert it has not taken yet. One that fails is kept and offered again every alertRetryMinutes
 * (logged the first time only). Returns true while one has failed failuresBeforeExit times: the run then exits
 * non-zero, so an alert that cannot be said is not a silent one.
 */
export function deliver({ st, now, alert, W, log }) {
  for (const a of st.unsent) {
    if (a.next > now) continue;
    const r = alert(a.text);
    if (r && r.ok) { a.sent = true; log(`alert sent${r.via === 'fallback' ? ' (shared webhook)' : ''}: ${a.text.slice(0, 200)}`); continue; }
    a.tries = (a.tries || 0) + 1; a.next = now + W.alertRetryMinutes * 60000;
    if (a.tries === 1) log(`ALERT NOT SENT (${String((r && r.error) || 'no reason given').slice(0, 200)}); kept, and offered again every ${W.alertRetryMinutes} minutes: ${a.text.slice(0, 300)}`);
  }
  st.unsent = st.unsent.filter(a => !a.sent);
  return st.unsent.some(a => a.tries >= W.failuresBeforeExit);
}

/** One alert in #rsd-alerts through slackroom's node door (~/ai-system/lib/slackroom/slackroom.js, route rsd.alerts). */
export function slackAlert(text) {
  try {
    const room = createRequire(import.meta.url)(path.join(os.homedir(), 'ai-system', 'lib', 'slackroom', 'slackroom.js'));
    const r = room.post('rsd.alerts', text);
    return r && r.ok ? { ok: true, via: r.via } : { ok: false, error: (r && r.error) || 'slackroom gave no reason' };
  } catch (e) { return { ok: false, error: `slackroom could not be loaded: ${String(e.message || e).split('\n')[0].slice(0, 160)}` }; }
}

/** A board read, tried once more after a short wait: one dropped connection is not an outage. Never used for a write. */
export async function readTwice(fn, waitMs, wait = ms => new Promise(r => setTimeout(r, ms))) {
  try { return await fn(); } catch { await wait(waitMs); return fn(); }
}

let SYNC_CFG = null;                        // config sync, read once a run
const syncCfg = () => SYNC_CFG || (SYNC_CFG = JSON.parse(fs.readFileSync(path.join(REPO, 'config', 'event-check.json'), 'utf8')).sync || {});
const read = fn => { let w = WATCH_DEFAULTS; try { w = watchSettings(syncCfg()); } catch { /* hourly() says so when it needs the config */ } return readTwice(fn, w.retrySeconds * 1000); };
const seen = { sync: null, last: undefined };   // what this run saw, for watch()
/** What a sync this run ran came to: got through, stopped by a guard (its reason, its report), or failed. Null when the lock was busy. */
const ranAs = (r, s, via, tag) => r.code === 4 ? null : !s ? { status: 'failed', via }
  : s.stopped ? { status: 'stopped', via, reason: s.stopped, report: s.date ? `out/reports/sheet-sync-${s.date}-${tag}.md` : '' } : { status: s.wrote ? 'done' : 'failed', via };

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
  const open = await read(() => api.syncs.open());

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
  const left = (await read(() => api.syncs.byIds(ids))).filter(x => x.status === 'running').map(x => x.id);
  if (left.length) {
    const tail = (r.stderr || '').trim().split('\n').filter(Boolean).slice(-3).join(' | ').slice(-400);
    await api.syncs.move(left, 'running', { status: 'failed', finished_at: new Date().toISOString(),
      result: { error: r.killed ? `the sync took longer than ${RUN_TIMEOUT_MS / 60000} minutes and was stopped` : (tail || `sheet-sync exited ${r.code}`) } });
  }
  const { s, how } = outcome(r);
  say(`requests ${ids.join(',')} (${who}): ${how}`);
  seen.sync = ranAs(r, s, 'button', `req${ids[0]}`);
  if (!s || r.code) process.stderr.write(r.stderr || '');
  return 0;
}

async function hourly(api) {
  const auto = syncCfg().auto;
  if (!auto || !auto.from) return 0;                 // off: no need to ask the board anything more
  const now = Date.now();
  if (autoWhyNot({ auto, last: null, now })) return 0;             // before the start date or outside hours: no second read
  seen.last = await read(() => api.syncs.last());
  if (autoWhyNot({ auto, last: seen.last, now })) return 0;
  const r = await runSync(['--tag', 'auto', '--via', 'auto']);    // one report a day, the latest hour's; every run is on the record
  const { s, how } = outcome(r);
  say(`hourly sync: ${how}`);
  seen.sync = ranAs(r, s, 'auto', 'auto');
  if ((!s || r.code) && r.code !== 4) process.stderr.write(r.stderr || '');
  return 0;
}

// An outage would otherwise log the same line every 30 seconds: say it once, and say when it clears.
const STATE = process.env.BOARD_STATE_DIR || path.join(REPO, 'state'), LAST_ERR = path.join(STATE, 'sync-requests.error');
const WATCH = path.join(STATE, 'sync-requests.watch.json');   // what has been said to Alan, and what Slack has not taken yet
const loadWatch = () => { try { const j = JSON.parse(fs.readFileSync(WATCH, 'utf8')); return j && typeof j === 'object' && !Array.isArray(j) ? j : null; } catch { return null; } };
const saveWatch = st => { fs.mkdirSync(STATE, { recursive: true }); fs.writeFileSync(WATCH + '.tmp', JSON.stringify(st), { mode: 0o600 }); fs.renameSync(WATCH + '.tmp', WATCH); };

/** One run: the listener's work, then what it means for Alan. Returns the exit code. */
async function listen() {
  if (fs.existsSync(path.join(REPO, 'PAUSED'))) return 0;        // the kill switch: not a read, nothing counted, nothing said
  let code = 0, msg = '';
  try {
    code = await main();
    if (fs.existsSync(LAST_ERR)) { fs.rmSync(LAST_ERR, { force: true }); say('the board is reachable again'); }
  } catch (e) {
    msg = String(e.message || e).slice(0, 300) || 'failed without a reason';
    let last = ''; try { last = fs.readFileSync(LAST_ERR, 'utf8'); } catch { /* first time */ }
    if (msg !== last) {
      console.error(`[${stamp()}] sync-requests: ${msg} (said once; the next line is when it clears)`);
      try { fs.mkdirSync(STATE, { recursive: true }); fs.writeFileSync(LAST_ERR, msg, { mode: 0o600 }); } catch { /* the log line is enough */ }
    }
  }
  let sync = {}; try { sync = syncCfg(); } catch { /* said above when it mattered; the defaults stand in */ }
  const W = watchSettings(sync), now = Date.now(), had = loadWatch(), before = JSON.stringify(had);
  const { st } = watch({ st: had, seen: { ...seen, error: msg || null }, now, sync });
  st.fails = msg ? (st.fails || 0) + 1 : 0;
  if (msg && st.fails === W.failuresBeforeExit) console.error(`[${stamp()}] sync-requests: ${st.fails} runs in a row could not read the board (${msg}); this run and the next exit non-zero until it clears`);
  const unsaid = deliver({ st, now, alert: slackAlert, W, log: say });
  if (JSON.stringify(st) !== before) saveWatch(st);
  return (msg && st.fails >= W.failuresBeforeExit) || unsaid ? 1 : code;
}

if (isMain(import.meta.url)) {
  listen().then(c => process.exit(c)).catch(e => { console.error(`[${stamp()}] sync-requests: ${String((e && e.stack) || e).slice(0, 600)}`); process.exit(1); });
}
