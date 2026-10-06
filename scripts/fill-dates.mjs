#!/usr/bin/env node
/*
  fill-dates — a board show with no Start Date gets one (Alan, 2026-10-06: "if there is no start date, the agent will
  do a quick search of the event, find the start date, and update it").

  Most blank Start Dates need no search at all: the date is already in our own data. So, in this order:
    1. the show's own days: the Sheet's weekend header and day columns, already on the board as each booth's dates
    2. VectorConnect's dates for the show's record (--vc, the My Events pull)
    3. a page online (--research, research-events.js results): only a date a page states, with its URL
  A show none of these answers is listed, and goes to the search unless it is skipped: --skip-names (Alan: no money
  on golf tournaments or builder expos), --skip-tiers (Elite: the team handles those), Mesa, a junk row name.

  It writes startDate / endDate and says where they came from (startDateSource: sheet-days | vc | web, startDateFilledAt).
  A date from VC or a page also gets the board's usual datesNote / datesSource, so the page shows "VC dates" / "checked".
  The show's day columns are never touched. More than fillDates.maxAtOnce fills in one run writes none (exit 5).

  The Sheet is not written (nothing automated writes it). The Sheet sync leaves a filled date alone: the Sheet's
  cell is still blank, which is what it was at the last sync.

  Usage: fill-dates.mjs --vc <pull.json> [--research <results.json>] [--targets-out <file>] [--apply]
                        [--skip-names golf,builder] [--skip-tiers Elite] [--date YYYY-MM-DD]
  Output: out/fill-dates/latest.json (and <date>.json), out/reports/fill-dates-<date>.md. --targets-out writes the
          shows that still need a search, in board-research.mjs's targets shape (research-events.js reads it).
  Exit: 0 ok · 1 error · 5 too many fills at once (none written)
*/
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { boardApi } from './lib/board-api.mjs';
import { tierOf, dayDiff } from './lib/match.mjs';
import { sellingRun } from './lib/dates.mjs';
import { isMain } from './lib/is-main.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = f => args.includes(f);
const opt = (f, d = null) => { const i = args.indexOf(f); return i > -1 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d; };
const CFG = JSON.parse(fs.readFileSync(path.join(REPO, 'config', 'event-check.json'), 'utf8'));
const TODAY = opt('--date') || new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Phoenix' }).format(new Date());
const OUT_BASE = process.env.BOARD_OUT_DIR || path.join(REPO, 'out');
const MESA = new RegExp(CFG.mesaPattern, 'i');
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const t = v => String(v ?? '').replace(/\s+/g, ' ').trim();
const addDays = (iso, n) => new Date(Date.parse(iso + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const host = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return ''; } };
const writeJson = (f, obj) => { fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 }); fs.writeFileSync(f + '.tmp', JSON.stringify(obj, null, 1), { mode: 0o600 }); fs.renameSync(f + '.tmp', f); };
const junkName = n => t(n).length < 3 || /^(x+|tbd|test|\?+)$/i.test(t(n));
const staffedOf = e => (e.booths || []).some(b => (b.shifts || []).some(s => (s.slots || []).some(sl => t(sl && sl.rep) && t(sl.rep) !== '__X__')));

/** A date a page states for this show, or null. The same bar board-research.mjs holds a researched date to. */
export function webRun(res, weekend) {
  const d = res && res.ok && res.result && res.result.dates;
  if (!d || !d.found || !ISO.test(d.start || '') || !ISO.test(d.end || '') || d.start > d.end || dayDiff(d.end, d.start) > 21) return null;
  if (d.confidence === 'none' || !/^https?:\/\//i.test(t(d.sourceUrl)) || !t(d.evidence)) return null;
  if (weekend && Math.abs(dayDiff(d.start, weekend)) > 150) return null;
  return { start: d.start, end: d.end, source: d.sourceUrl };
}

/**
 * What to do about one show's blank date. Pure.
 * @returns { kind: 'fill', start, end, source: 'sheet-days'|'vc'|'web', url? } | { kind: 'search' } | { kind: 'skip', why } | { kind: 'unfound', why }
 */
export function decide(e, { vcRow, res, skipNames = [], skipTiers = [], researched = false }) {
  const run = sellingRun(e);
  if (run) return { kind: 'fill', start: run.start, end: run.end, source: 'sheet-days' };
  const own = [...(e.dates || []), ...(e.booths || []).flatMap(b => b.dates || [])].filter(d => ISO.test(d || ''));
  if (own.length) return { kind: 'skip', why: `its day columns (${[...new Set(own)].sort().join(', ')}) do not sit with its weekend ${t(e.weekend) || '(none)'}; fix the row` };
  if (vcRow && ISO.test(vcRow.startDate || '')) return { kind: 'fill', start: vcRow.startDate, end: ISO.test(vcRow.endDate || '') ? vcRow.endDate : vcRow.startDate, source: 'vc' };
  const web = webRun(res, e.weekend);
  if (web) return { kind: 'fill', start: web.start, end: web.end, source: 'web', url: web.source };
  if (junkName(e.name)) return { kind: 'skip', why: 'not a real show name (clean the row up)' };
  if (MESA.test(t(e.name))) return { kind: 'skip', why: 'Mesa has no days on this row' };
  const hit = skipNames.find(p => t(e.name).toLowerCase().includes(p));
  if (hit) return { kind: 'skip', why: `not searched ("${hit}" shows are never looked up)` };
  const tier = t(tierOf(e, CFG.tierRules));
  if (skipTiers.includes(tier.toLowerCase())) return { kind: 'skip', why: `not searched (${tier}: the team handles it)` };
  if (researched) return { kind: 'unfound', why: res && !res.ok ? `the lookup failed (${t(res.error) || 'no reason'})` : res && res.notResearched ? 'not looked up (this week\'s search money was used up)' : 'no page online gives the date' };
  return { kind: 'search' };
}

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const md = iso => `${MON[+iso.slice(5, 7) - 1]} ${+iso.slice(8, 10)}`;
const fmt = (a, b) => (a === b ? md(a) : a.slice(0, 7) === b.slice(0, 7) ? `${md(a)}-${+b.slice(8, 10)}` : `${md(a)}-${md(b)}`);
const FROM = { 'sheet-days': "the Sheet's own day columns", vc: 'VectorConnect', web: 'a page online' };

export function summaryMd(r) {
  const L = [`# Blank Start Dates, ${r.date} (${r.mode}${r.written ? ', board updated' : ', board not written'})`, ''];
  if (r.stopped) L.push(`**STOPPED:** ${r.stopped}`, '');
  L.push(`${r.blank} live show(s) had no Start Date. Filled ${r.filled.length}; ${r.search.length} need a search; ${r.unfound.length} not found; ${r.skipped.length} left alone.`);
  if (r.filled.length) { L.push('', '## Filled'); for (const x of r.filled) L.push(`- ${x.name} (${x.weekend || 'no weekend'}): ${fmt(x.start, x.end)}, from ${FROM[x.source]}${x.url ? ` (${host(x.url)})` : ''}`); }
  if (r.search.length) { L.push('', '## To search'); for (const x of r.search) L.push(`- ${x.name} (${x.weekend || 'no weekend'})`); }
  if (r.unfound.length) { L.push('', '## Not found (still blank)'); for (const x of r.unfound) L.push(`- ${x.name} (${x.weekend || 'no weekend'}): ${x.why}`); }
  if (r.skipped.length) { L.push('', '## Left alone'); for (const x of r.skipped) L.push(`- ${x.name} (${x.weekend || 'no weekend'}): ${x.why}`); }
  return L.join('\n');
}

async function main() {
  const vcPath = opt('--vc');
  const vc = vcPath && fs.existsSync(vcPath) ? JSON.parse(fs.readFileSync(vcPath, 'utf8')) : null;
  const vcByNumber = new Map(((vc && vc.rows) || []).map(r => [t(r.eventNumber), r]));
  const rf = opt('--research');
  const RS = rf && fs.existsSync(rf) ? JSON.parse(fs.readFileSync(rf, 'utf8')) : null;
  const results = (RS && RS.results) || {};
  const skipNames = t(opt('--skip-names') || '').toLowerCase().split(',').map(x => x.trim()).filter(Boolean);
  const skipTiers = t(opt('--skip-tiers') || '').toLowerCase().split(',').map(x => x.trim()).filter(Boolean);
  const api = boardApi({ actor: 'service:fill-dates' });
  const floor = addDays(TODAY, -(CFG.scopeDaysBack ?? 60));
  const blank = (await api.events()).filter(e => !e.dead && !e.neverWork && (!t(e.startDate) || !t(e.endDate)) && (t(e.weekend) || '9999') >= floor);
  const r = { date: TODAY, runAt: new Date().toISOString(), mode: flag('--apply') ? 'apply' : 'dry', written: false, blank: blank.length, filled: [], search: [], unfound: [], skipped: [], cost: RS ? RS.cost ?? null : null };
  const patches = [];
  for (const e of blank) {
    const row = { id: e.id, name: t(e.name), weekend: t(e.weekend) };
    const d = decide(e, { vcRow: vcByNumber.get(t(e.vcNumber)) || null, res: results[e.id], skipNames, skipTiers, researched: !!RS && e.id in results });
    if (d.kind === 'skip') { r.skipped.push({ ...row, why: d.why }); continue; }
    if (d.kind === 'unfound') { r.unfound.push({ ...row, why: d.why }); continue; }
    if (d.kind === 'search') { r.search.push({ ...row, e }); continue; }
    // a Start Date that is already there is kept; only the blank side is filled
    const start = t(e.startDate) || d.start, end = t(e.endDate) || d.end;
    if (start > end) { r.skipped.push({ ...row, why: `its Start Date ${start} is after the end ${end} the ${FROM[d.source]} give(s); fix the row` }); continue; }
    const patch = { startDate: start, endDate: end, startDateSource: d.source, startDateFilledAt: TODAY };
    if (d.source === 'vc') Object.assign(patch, { datesNote: `Dates per VectorConnect ${t(e.vcNumber)} (the Sheet had no Start Date; filled ${TODAY})`, datesSource: { basis: 'vc', vcNumber: t(e.vcNumber), checkedAt: TODAY } });
    if (d.source === 'web') Object.assign(patch, { datesNote: `Dates per ${host(d.url)} (the Sheet had no Start Date; filled ${TODAY})`, datesSource: { basis: 'researched', url: d.url, checkedAt: TODAY } });
    patches.push({ id: e.id, patch });
    r.filled.push({ ...row, start, end, source: d.source, url: d.url || null });
  }
  const max = (CFG.fillDates && CFG.fillDates.maxAtOnce) ?? 60;
  let code = 0;
  if (patches.length > max) { r.stopped = `${patches.length} blank Start Dates at once is more than ${max}; that looks like the Sheet or the parser, not the shows. None filled.`; code = 5; }
  else if (flag('--apply')) {
    for (const p of patches) await api.patchEvent(p.id, p.patch);
    const after = new Map((await api.events()).map(e => [e.id, e]));
    const bad = patches.filter(p => t((after.get(p.id) || {}).startDate) !== p.patch.startDate || t((after.get(p.id) || {}).endDate) !== p.patch.endDate);
    if (bad.length) { r.stopped = `${bad.length} fill(s) did not read back from the board (${bad.map(b => b.id).join(', ')})`; code = 1; }
    r.written = patches.length > 0 && !bad.length;
  }
  const targets = r.search.map(({ e, ...row }) => ({ id: e.id, name: row.name, weekend: row.weekend, run: null, datesEstimated: false, cityState: t(e.cityState), location: t(e.location),
    address: t(e.address), promoter: t(e.promoter), website: t(e.website), applyUrl: t(e.applyUrl), applyBy: t(e.applyBy), cost: t(e.cost), setting: t(e.setting),
    staffed: staffedOf(e), reps: [], vc: null, mismatch: false, multiWeek: false, lastYear: e.lastYear || null }));
  r.search = r.search.map(({ e, ...row }) => row);
  if (opt('--targets-out')) writeJson(opt('--targets-out'), { date: TODAY, mode: 'dates', count: targets.length, targets, skippedTiers: [] });
  writeJson(path.join(OUT_BASE, 'fill-dates', 'latest.json'), r);
  writeJson(path.join(OUT_BASE, 'fill-dates', `${TODAY}.json`), r);
  fs.mkdirSync(path.join(OUT_BASE, 'reports'), { recursive: true });
  fs.writeFileSync(path.join(OUT_BASE, 'reports', `fill-dates-${TODAY}.md`), summaryMd(r) + '\n');
  console.log(summaryMd(r));
  return code;
}

if (isMain(import.meta.url)) main().then(c => process.exit(c || 0)).catch(e => { console.error('fill-dates: ' + e.message); process.exit(1); });
