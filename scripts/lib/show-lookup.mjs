/*
  show-lookup — the board's "Look it up" (Alan, 2026-11-25: "Create a way in plan mode to use AI/Search feature where I
  can say 'add NHRA to 2027 Show shift board I believe its in the last week of February' It will then go look it up via
  AI web search and pull as much as info as it can to put onto the show shift schedule"; all his defaults the same day).

  In Plan mode, Add event has a Look it up line (editors only). A press leaves a pending row in show_lookups (the words
  and the year). The mini's 30-second listener (scripts/sync-requests.mjs, after its own sync work) takes the oldest one,
  runs rsd-shift-picking's lookup-show.js (Claude with web search: the preflight's lookup, scope "find", $10 a week) and
  writes back what goes in the form. The page fills the form; a coordinator checks it and presses Add event as always.
  Nothing here writes a show.

  What fills the form (formOf, pure): the preflight's own rules on a blank show (board-research.mjs decideFields and
  decideAppDates): venue, address, city, promoter, contact, website, application link and dates, indoor/outdoor and cost
  only from the event's, promoter's or host city's page. A venue, address or promoter found only on a third-party listing
  is named under the form (leftOut), never put in it. Dates: the show's own page (the board then shows "checked");
  otherwise the days the coordinator's words point to, marked est.; a listing's dates are named beside them, never used
  (the 2026-11-13 rule). The pages it used go in Team notes.
  Already on the board (onBoard, pure): that year's shows whose name matches what was found (lib/match.mjs nameScore), or,
  when nothing was identified, that share a distinctive word with the words typed. The page offers to fill that show's
  blank fields instead of adding a copy; it never moves its dates.
*/
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { decideFields, decideAppDates } from '../board-research.mjs';
import { nameScore, tokens, GENERIC, tokenEq, dayDiff } from './match.mjs';

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const t = v => String(v ?? '').replace(/\s+/g, ' ').trim();
const web = u => /^https?:\/\//i.test(t(u));
export const DEFAULTS = { on: true, timeoutMinutes: 7, staleMinutes: 15, maxDays: 7 };
export const phoenixToday = (ms = Date.now()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Phoenix' }).format(new Date(ms));

/**
 * What goes in the Add event form, from lookup-show.js's findings. Pure.
 * @param R  the findings (lib/research.js validate(), scope find): event, guess, dates, venue, address, promoter, ...
 * @returns { fields, sources, dates, from, leftOut, notes, summary }
 *   fields   the form's values by board field (name, startDate/endDate, cityState, location, address, promoter, contact,
 *            phone, email, website, applyUrl, applyOpens, applyBy, setting, cost); only what a page gave
 *   sources  applyOpens/applyBy: the research tag each date is saved with (lib/app-dates.mjs)
 *   dates    { how: 'official' | 'guess' | 'none', start, end, url, words, listing, setAside, otherYear, cancelled, notYetAnnounced }
 *   from     [{ url, fields }]: which page gave which fields (the hint under the form)
 *   leftOut  [{ field, value, url }]: found only on a third-party listing, so not put in the form
 *   notes    the Team notes line: when it was looked up, what was typed, the pages it used
 */
export function formOf(R, { year, today, ask = '', maxDays = DEFAULTS.maxDays }) {
  R = R || {};
  const ev = R.event || {}, d = R.dates || {}, g = R.guess || {};
  const inYear = iso => ISO.test(t(iso)) && +t(iso).slice(0, 4) === +year;
  const fits = (a, b) => inYear(a) && inYear(b) && a <= b && dayDiff(b, a) < maxDays;
  let dates;
  if (d.found && d.confidence === 'official' && fits(d.start, d.end)) dates = { how: 'official', start: d.start, end: d.end, url: t(d.sourceUrl), words: t(d.evidence).slice(0, 300) };
  else if (fits(g.start, g.end)) dates = { how: 'guess', start: g.start, end: g.end };
  else dates = { how: 'none' };
  if (d.found && d.confidence !== 'official' && ISO.test(t(d.start)) && ISO.test(t(d.end))) dates.listing = { start: d.start, end: d.end, url: t(d.sourceUrl) };
  if (d.found && d.confidence === 'official' && dates.how !== 'official') dates.otherYear = { start: t(d.start), end: t(d.end), url: t(d.sourceUrl) };
  if (t(d.notConfirmed)) dates.setAside = t(d.notConfirmed).slice(0, 300);
  if (d.cancelled) dates.cancelled = t(d.evidence).slice(0, 300) || 'a page says this edition is cancelled';
  if (d.notYetAnnounced) dates.notYetAnnounced = true;

  const { patch, changes } = decideFields({}, R);
  const fields = { name: t(ev.name).slice(0, 160), ...patch };
  if (!fields.cityState && t(ev.cityState)) fields.cityState = t(ev.cityState).slice(0, 80);
  if (dates.start) Object.assign(fields, { startDate: dates.start, endDate: dates.end });
  const sources = {};
  if (dates.start) {
    const app = decideAppDates({}, R, { start: dates.start, end: dates.end }, { today });
    for (const f of ['applyOpens', 'applyBy']) if (app.patch[f]) { fields[f] = app.patch[f]; sources[f] = app.patch[`${f}Source`]; }
  }

  const by = new Map();
  const credit = (url, field) => { if (!web(url)) return; const k = t(url); by.set(k, [...(by.get(k) || []), field]); };
  if (fields.name && ev.confidence === 'official') credit(ev.sourceUrl, 'name');
  if (dates.how === 'official') credit(dates.url, 'dates');
  for (const c of changes) credit(c.source, c.field);
  for (const f of Object.keys(sources)) credit(sources[f].url, f);
  const from = [...by].map(([url, fl]) => ({ url, fields: [...new Set(fl)] }));

  const leftOut = [];
  const listed = (field, value, g) => { const v = t(value); if (v && g && g.confidence === 'secondary' && web(g.sourceUrl) && !fields[field]) leftOut.push({ field, value: v.slice(0, 160), url: t(g.sourceUrl) }); };
  if (R.venue) listed('location', R.venue.value, R.venue);
  if (R.address) listed('address', [t(R.address.street), t(R.address.city), t(R.address.state), t(R.address.zip)].filter(Boolean).join(', '), R.address);
  if (R.promoter) { listed('promoter', R.promoter.name, R.promoter); listed('website', R.promoter.website, R.promoter); }

  const used = [...new Set([...by.keys(), ...(web(ev.sourceUrl) ? [t(ev.sourceUrl)] : [])])];
  const notes = `Looked up from the board ${today}${ask ? ` ("${t(ask).slice(0, 120)}")` : ''}${used.length ? `: ${used.join(' ')}` : ': no page found'}`;
  return { fields, sources, dates, from, leftOut, notes, summary: t(R.summary).slice(0, 300) };
}

/**
 * The shows already on that year's board that the lookup may be (at most 3, the likeliest first). Pure.
 * By the name it found (nameScore 0.5 or better); with no name found, a show sharing a distinctive word with the words.
 */
export function onBoard(events, { name, ask, year }) {
  const mine = (events || []).filter(e => +(e.year || String(e.id || '').slice(0, 4)) === +year && t(e.name));
  let hits = t(name) ? mine.map(e => ({ e, s: nameScore(name, e.name) })).filter(x => x.s >= 0.5) : [];
  if (!hits.length) {
    const words = tokens(ask).filter(w => w.length >= 3 && !GENERIC.has(w));
    hits = mine.map(e => ({ e, s: tokens(e.name).filter(w => !GENERIC.has(w) && words.some(x => tokenEq(x, w))).length })).filter(x => x.s > 0);
  }
  return hits.sort((a, b) => b.s - a.s || String(a.e.startDate || a.e.weekend || '').localeCompare(String(b.e.startDate || b.e.weekend || ''))).slice(0, 3)
    .map(({ e }) => ({ id: e.id, name: t(e.name), weekend: t(e.weekend), startDate: t(e.startDate), endDate: t(e.endDate), status: t(e.status), cityState: t(e.cityState) }));
}

/** The row's result in one log line: no contacts, no addresses. */
const said = (status, result) => status === 'done'
  ? `${result.fields.name || 'no event identified'}; dates ${result.dates.how}${result.dates.start ? ` ${result.dates.start}..${result.dates.end}` : ''}; ${Object.keys(result.fields).length} field(s); ${result.onBoard.length ? `maybe on the board already: ${result.onBoard.map(x => x.id).join(', ')}` : 'not on the board'}`
  : `${status}: ${result.error}`;

/**
 * One listener run's Look it up work: the oldest waiting press, one at a time. I/O through `api` (board-api lookups and
 * events) and `lookup` ({ ask, year } -> lookup-show.js's file as an object, or { failed }), so the tests drive it.
 * A row left "running" past staleMinutes was orphaned (a restart mid-lookup) and is marked failed, never run again by
 * itself: a lookup costs money. Returns what it did, for the tests and the log.
 */
export async function runLookups({ api, lookup, log = () => {}, cfg = {}, now = Date.now() }) {
  const C = { ...DEFAULTS, ...cfg };
  if (C.on === false) return { did: 'off' };
  const open = await api.lookups.open();
  const stale = open.filter(r => r.status === 'running' && now - Date.parse(r.started_at || 0) > C.staleMinutes * 60000);
  if (stale.length) {
    await api.lookups.move(stale.map(r => r.id), 'running', { status: 'failed', finished_at: new Date(now).toISOString(),
      result: { error: 'The lookup stopped partway (the Mac mini restarted, or it was stopped). Nothing was spent twice; press Look it up again.' } });
    log(`lookups ${stale.map(r => r.id).join(',')}: left running for over ${C.staleMinutes} minutes, marked failed`);
  }
  if (open.some(r => r.status === 'running' && !stale.includes(r))) return { did: 'busy' };
  const next = open.filter(r => r.status === 'pending').sort((a, b) => a.id - b.id)[0];
  if (!next) return { did: stale.length ? 'cleared' : 'idle' };
  const [row] = (await api.lookups.move([next.id], 'pending', { status: 'running', started_at: new Date(now).toISOString() })) || [];
  if (!row) return { did: 'lost' };
  const ask = t(row.ask), year = +row.year;
  let out;
  try { out = await lookup({ ask, year }); } catch (e) { out = { failed: String((e && e.message) || e).slice(0, 300) }; }
  let status, result;
  if (out.failed) { status = 'failed'; result = { error: `The lookup could not run on the Mac mini: ${out.failed}` }; }
  else if (out.refused) { status = 'refused'; result = { error: t(out.refused) }; }
  else if (!out.ok) { status = 'failed'; result = { error: `The lookup did not finish: ${t(out.error) || 'no reason given'}. Press Look it up again, or add the show by hand.`, cost: out.cost || 0 }; }
  else {
    const today = phoenixToday(now);
    const form = formOf(out.result, { year, today, ask, maxDays: C.maxDays });
    status = 'done';
    result = { ...form, onBoard: onBoard(await api.events(), { name: form.fields.name, ask, year }), cost: +Number(out.cost || 0).toFixed(2), model: t(out.model) };
  }
  await api.lookups.move([row.id], 'running', { status, finished_at: new Date().toISOString(), result });
  log(`lookup ${row.id} (${row.requested_by || 'someone'}): "${ask}" (${year}): ${said(status, result)}${result.cost ? ` [$${Number(result.cost).toFixed(2)}]` : ''}`);
  return { did: status, id: row.id, result };
}

/**
 * The real lookup: rsd-shift-picking's lookup-show.js (it owns the Claude key, the model and the money), one press at a
 * time, its file read back. The board's service key never goes to it (BOARD_* is left out of its environment).
 */
export function pickingLookup(cfg = {}) {
  const C = { ...DEFAULTS, ...cfg };
  const dir = process.env.RSD_PICKING_DIR || t(C.pickingDir) || path.join(os.homedir(), 'automations', 'rsd-shift-picking');
  return ({ ask, year }) => new Promise(resolve => {
    const script = path.join(dir, 'lookup-show.js');
    if (!fs.existsSync(script)) return resolve({ failed: `${script} is not there (rsd-shift-picking not pulled?)` });
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'board-lookup-')), out = path.join(tmp, 'result.json');
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('BOARD_')));
    execFile(process.execPath, [script, '--ask', ask, '--year', String(year), '--out', out], { cwd: dir, env, timeout: C.timeoutMinutes * 60000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        let o = null; try { o = JSON.parse(fs.readFileSync(out, 'utf8')); } catch { /* none written */ }
        fs.rmSync(tmp, { recursive: true, force: true });
        if (o) return resolve(o);
        const tail = String(stderr || '').trim().split('\n').filter(Boolean).slice(-2).join(' | ').slice(-300);
        resolve({ failed: err && err.killed ? `it took longer than ${C.timeoutMinutes} minutes and was stopped` : tail || `lookup-show.js exited ${err ? err.code : 0} without a result` });
      });
  });
}
