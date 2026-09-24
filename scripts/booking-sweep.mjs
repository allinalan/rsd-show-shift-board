#!/usr/bin/env node
/*
  booking-sweep — the board's half of the post-meeting booking sweep (Alan, 2026-09-23).

  rsd-shift-picking's run-booking-sweep.sh runs this two days after a shift-picking meeting (and on each
  day of the follow-up week), right after a fresh VC My Events pull, the Sheet -> board sync and the event
  check, which wrote VC's status onto the board and left out/event-check/latest.json. This sorts every
  staffed upcoming show into what the sweep does with it:

    request   VC has no record for it this season -> a Booking Request. rsd-shift-picking looks up the
              previous record (rebook or new), fills VC's form and submits it after Alan replies "approved".
    email     VC has it as Prospective -> on the list emailed to Cutco's events team (Olean) asking them to book it.
    fix       VC has it booked or cleared to book, VC's name agrees, and the board's selling days are VC's
              moved by whole weeks -> the board's dates move to VC's (--apply) and the staffed reps are asked
              "do those dates still work?" (texts built in rsd-shift-picking, previewed to Alan first).
    question  any other date disagreement (VC only Prospective or pending, a different length or weekday
              pattern, a multi-week show, a name that does not agree) -> listed for Alan, nothing changed.
    hold      would be a request, but is not safe to send unattended (reason each).
    pending   a request already submitted and still inside requestPendingDays.

  Scope: upcoming, staffed (SE days never count), live (not dead or never-work), not Mesa (outside VC),
  not on the exclude list rsd-shift-picking passes (Alan's direct shows), not ruled off, not a
  placeholder-only date, not a board VC number missing from the pull, not a number two unrelated shows claim.

  Writes, only with --apply and only for `fix` shows: every date moves by the same whole number of weeks
  (startDate, endDate, weekend, dates, each booth's day dates; day names and shifts untouched), so the new
  selling days equal VC's by construction, and they are read back to prove it (a mismatch is put back and
  becomes a question). datesEstimated goes false and datesMoved records where they were. Nothing else is
  written here: rsd-shift-picking marks a show "Booking Request Submitted" after VC confirms the request.

  Usage:
    booking-sweep.mjs --vc <pull.json> [--check <out/event-check/latest.json>] [--exclude-file <json>]
                      [--meeting YYYY-MM-DD] [--apply] [--date YYYY-MM-DD] [--max-fixes N]
  --exclude-file: a JSON file with "exclude": [show names] (rsd-shift-picking data/booking-sweep-config.json).
  Output: out/booking-sweep/latest.json (+ a dated copy; mode 600: requests carry the promoter contacts the
  form needs, so this file never leaves the mini), out/reports/booking-sweep-<date>.md (no contacts).
  Exit: 0 ok · 1 error · 4 no trustworthy event check to work from (nothing written) ·
        5 refused: more date fixes than sweep.maxDateFixes (nothing written)
*/
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { boardApi } from './lib/board-api.mjs';
import { nameScore, dayDiff, addDaysIso, normName } from './lib/match.mjs';
import { isSEday } from './parse-sheet.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = f => args.includes(f);
const opt = (f, d = null) => { const i = args.indexOf(f); return i > -1 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d; };
const CFG = JSON.parse(fs.readFileSync(path.join(REPO, 'config', 'event-check.json'), 'utf8'));
export const SW = { holdDaysBefore: 10, maxDateFixes: 15, maxShiftDays: 56, duplicateWindowDays: 60, duplicateMinScore: 0.6, nameAgreeScore: 0.6,
  fixCategories: ['booked', 'coi', 'detail', 'contract'], ...(CFG.sweep || {}) };
const TODAY = opt('--date') || new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Phoenix' }).format(new Date());
const MESA = new RegExp(CFG.mesaPattern, 'i');
const t = v => String(v ?? '').replace(/\s+/g, ' ').trim();
const OUT_BASE = process.env.BOARD_OUT_DIR || path.join(REPO, 'out');
const OUT_S = path.join(OUT_BASE, 'booking-sweep'), OUT_R = path.join(OUT_BASE, 'reports');

// ---------- pure helpers (exported for the tests) ----------
/**
 * The show's selling days on the board: every booth's day dates, set-up/tear-down (SE) days left out.
 * null when there are none, or when they sit more than a week from the weekend the show is staffed for
 * (stale day cells: the Phoenix Quilt row carried 1/25/2024..1/27/2024) or span more than three weeks.
 */
export function sellingRun(e) {
  const ds = [];
  for (const b of e.booths || []) (b.dates || []).forEach((d, i) => { if (d && /^\d{4}-\d{2}-\d{2}$/.test(d) && !isSEday((b.days || [])[i])) ds.push(d); });
  ds.sort();
  if (!ds.length) return null;
  const run = { start: ds[0], end: ds[ds.length - 1] };
  if (e.weekend && Math.abs(dayDiff(run.start, e.weekend)) > 7) return null;
  if (dayDiff(run.end, run.start) > 21) return null;
  return run;
}
const sameRun = (a, b) => !!a && !!b && a.start === b.start && a.end === b.end;
/**
 * The board's selling days sit inside VC's run: nothing to fix. VC's record often carries a set-up or move-in day
 * the board keeps as an SE day (Run to the Sun: VC 10/21-10/25, the board sells 10/23-10/25), and a team may staff
 * only some days of a long show. Only a board day OUTSIDE VC's run is a date problem.
 */
export const within = (board, vc) => !!board && !!vc && vc.start <= board.start && board.end <= vc.end;

/** The whole-week move that turns the board's run into VC's, or null when it is anything else. */
export function weekShift(board, vc, maxDays = SW.maxShiftDays) {
  if (!board || !vc) return null;
  const k = dayDiff(vc.start, board.start);
  if (k === 0 || k % 7 !== 0 || Math.abs(k) > maxDays) return null;
  if (dayDiff(vc.end, vc.start) !== dayDiff(board.end, board.start)) return null;
  return k;
}

/** Every date on the event moved by k days: the patch, and nothing else changes. */
export function shiftPatch(e, k) {
  const mv = d => (d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? addDaysIso(d, k) : d);
  const booths = JSON.parse(JSON.stringify(e.booths || []));
  for (const b of booths) b.dates = (b.dates || []).map(mv);
  return { startDate: mv(e.startDate), endDate: mv(e.endDate), weekend: mv(e.weekend), dates: (e.dates || []).map(mv), booths, datesEstimated: false };
}

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const md = iso => `${MON[+iso.slice(5, 7) - 1]} ${+iso.slice(8, 10)}`;
/** "Oct 23-25", "Oct 30-Nov 1", "Oct 23"; what Alan reads in the preview. */
export const fmt = r => (r ? (r.start === r.end ? md(r.start) : r.start.slice(0, 7) === r.end.slice(0, 7) ? `${md(r.start)}-${+r.end.slice(8, 10)}` : `${md(r.start)}-${md(r.end)}`) : 'no usable dates');

// ---------- the sweep ----------
async function main() {
  const checkPath = opt('--check') || path.join(OUT_BASE, 'event-check', 'latest.json');
  const vcPath = opt('--vc');
  const result = { date: TODAY, runAt: new Date().toISOString(), meeting: opt('--meeting'), mode: flag('--apply') ? 'apply' : 'dry', written: false,
    requests: [], holds: [], email: [], fixes: [], questions: [], pending: [], excluded: [], skipped: [], claimedVc: [] };
  const stop = async (why, code) => { result.stopped = why; await write(result); console.error('booking-sweep: ' + why); return code; };

  if (!fs.existsSync(checkPath)) return stop(`no event check result at ${checkPath}; run the event check first`, 4);
  const check = JSON.parse(fs.readFileSync(checkPath, 'utf8'));
  if (check.stopped) return stop(`the event check did not trust its VC data (${check.stopped}); nothing swept`, 4);
  if (check.date !== TODAY) return stop(`the event check is from ${check.date}, not today (${TODAY}); run it first`, 4);
  if (flag('--apply') && check.mode !== 'apply') return stop('the event check ran dry, so the board does not carry today\'s VC status; not sweeping for real on it', 4);
  if (!vcPath || !fs.existsSync(vcPath)) throw new Error('--vc <pull.json> is required (the same My Events pull the event check used)');
  const vc = (JSON.parse(fs.readFileSync(vcPath, 'utf8')).rows || []).map(r => ({ ...r, eventNumber: t(r.eventNumber) }));
  const excl = opt('--exclude-file') && fs.existsSync(opt('--exclude-file')) ? (JSON.parse(fs.readFileSync(opt('--exclude-file'), 'utf8')).exclude || []) : [];
  const exclude = new Set(excl.map(normName));
  const placeholders = new Set((CFG.placeholders || []).map(String));
  const vcByNumber = new Map(vc.map(v => [v.eventNumber, v]));
  const vcPlace = n => { const v = vcByNumber.get(n); return v ? [t(v.city), t(v.state)].filter(Boolean).join(', ') : ''; };

  const api = boardApi({ actor: 'service:booking-sweep' });
  const byId = new Map((await api.events()).map(e => [e.id, e]));
  const recs = (check.events || []).filter(r => r.upcoming && r.staffed);

  // VC numbers a checked show already claims: a "duplicate" there belongs to that show, not this one
  const claimed = new Map();
  for (const r of check.events || []) if (r.vcNumber && r.category !== 'no-vc') { if (!claimed.has(r.vcNumber)) claimed.set(r.vcNumber, []); claimed.get(r.vcNumber).push(r.id); }
  result.claimedVc = [...claimed.keys()];
  // A multi-week show is one VC record claimed by several weekly rows: judged as one run, never auto-moved.
  const groupOf = r => (r.vcNumber && (claimed.get(r.vcNumber) || []).filter(id => recs.some(x => x.id === id)).length > 1 ? r.vcNumber : null);
  const groupsDone = new Set(), emailed = new Set();

  for (const r of recs) {
    const e = byId.get(r.id);
    const base = { id: r.id, name: r.name, weekend: r.weekend, reps: r.reps || [], cityState: e ? t(e.cityState) : '' };
    if (!e) { result.skipped.push({ ...base, why: 'no longer on the board' }); continue; }
    if (e.dead || e.neverWork) { result.skipped.push({ ...base, why: 'dead or never-work on the board' }); continue; }
    if (MESA.test(r.name)) continue;
    if (exclude.has(normName(r.name))) { result.excluded.push(base); continue; }
    if (r.ruling || r.category === 'dead') { result.skipped.push({ ...base, why: r.ruling ? "not happening (Alan's ruling)" : `dead in VC (${r.vcStatus})` }); continue; }
    const run = sellingRun(e);
    base.run = run;
    if (r.openQuestion) { result.questions.push({ ...base, kind: 'placeholder', why: `only the placeholder VC record${(r.notes || []).join(' ').match(/placeholder (\d+)/) ? ' ' + (r.notes || []).join(' ').match(/placeholder (\d+)/)[1] : ''} covers ${fmt(run)}. Request it, or is it booked?` }); continue; }
    if (r.numberMissing) { result.questions.push({ ...base, kind: 'number-missing', why: `the board carries VC# ${r.vcNumber}, which is not in today's pull` }); continue; }
    if (r.suspicious) { result.questions.push({ ...base, kind: 'duplicate-number', why: `VC# ${r.vcNumber} is also claimed by an unrelated show` }); continue; }

    if (r.category === 'no-vc') {
      if (r.requestPending) { result.pending.push({ ...base, requestedAt: r.vcRequestedAt }); continue; }
      if (r.mismatchRow) {
        const m = r.mismatchRow;
        result.questions.push({ ...base, kind: 'vc-other-dates', vcNumber: m.eventNumber, why: `VC has ${m.eventNumber} ${m.name} on ${fmt({ start: m.startDate, end: m.endDate })} (${m.status}), the board has ${fmt(run)}. Not requested: fix the dates, or it is a different show` });
        continue;
      }
      const why = [];
      if (!run) why.push('the board has no usable selling-day dates for it');
      else if (dayDiff(run.start, TODAY) < SW.holdDaysBefore) why.push(`starts ${run.start}, too close to request unattended`);
      if (e.datesEstimated) why.push("its dates are still last year's +364 guess (the preflight confirms them)");
      const dup = run ? vc.filter(v => !claimed.has(v.eventNumber) && !placeholders.has(v.eventNumber) && nameScore(e.name, v.name) >= SW.duplicateMinScore && Math.abs(dayDiff(v.startDate, run.start)) <= SW.duplicateWindowDays) : [];
      if (dup.length) why.push(`VC already has ${dup.slice(0, 2).map(v => `${v.eventNumber} ${v.name} on ${fmt({ start: v.startDate, end: v.endDate })} (${v.status})`).join(' and ')}: a date or name mismatch, not a missing booking?`);
      if ((r.aliasCandidates || []).length) why.push(`VC has ${r.aliasCandidates.map(c => `${c.eventNumber} ${c.name} (${c.status})`).join('; ')} that weekend in the same city: renamed?`);
      const req = { ...base, fields: requestFields(e) };
      if (why.length) result.holds.push({ ...req, why });
      else result.requests.push(req);
      continue;
    }

    // VC has a record for it
    const vcRun = r.vcStart ? { start: r.vcStart, end: r.vcEnd || r.vcStart } : null;
    const prospective = /^prospective$/i.test(t(r.vcStatus));
    const g = groupOf(r);
    if (g) {
      if (groupsDone.has(g)) continue;
      groupsDone.add(g);
      const members = recs.filter(x => x.vcNumber === g && byId.get(x.id));
      const runs = members.map(x => sellingRun(byId.get(x.id))).filter(Boolean);
      const union = runs.length === members.length ? { start: runs.map(x => x.start).sort()[0], end: runs.map(x => x.end).sort().slice(-1)[0] } : null;
      const gbase = { ...base, id: members.map(x => x.id).join(','), ids: members.map(x => x.id), name: r.name, reps: [...new Set(members.flatMap(x => x.reps || []))], run: union };
      if (prospective && !emailed.has(g)) { emailed.add(g); result.email.push({ ...gbase, vcNumber: g, vcName: r.vcName, vcPlace: vcPlace(g), vcStatus: r.vcStatus, vcRun, datesDiffer: !within(union, vcRun) }); }
      if (vcRun && !within(union, vcRun)) result.questions.push({ ...gbase, kind: 'multi-week', vcNumber: g, vcStatus: r.vcStatus, vcRun, why: `one VC record covers its ${members.length} weeks: VC has ${fmt(vcRun)} (${r.vcStatus}), the board has ${fmt(union)}. Multi-week shows are never changed unattended` });
      continue;
    }
    if (prospective && !emailed.has(r.vcNumber)) { emailed.add(r.vcNumber); result.email.push({ ...base, vcNumber: r.vcNumber, vcName: r.vcName, vcPlace: vcPlace(r.vcNumber), vcStatus: r.vcStatus, vcRun, datesDiffer: !!run && !within(run, vcRun) }); }
    if (!vcRun || within(run, vcRun)) continue;
    if (!run) { result.questions.push({ ...base, kind: 'no-board-dates', vcNumber: r.vcNumber, vcStatus: r.vcStatus, vcRun, why: `VC has ${fmt(vcRun)} (${r.vcStatus}), and the board has no usable dates to compare` }); continue; }
    const agrees = nameScore(r.name, r.vcName) >= SW.nameAgreeScore || r.matchedBy === 'alias' || r.matchedBy === 'qcfm';
    const k = weekShift(run, vcRun);
    if (SW.fixCategories.includes(r.category) && agrees && k) {
      result.fixes.push({ ...base, vcNumber: r.vcNumber, vcStatus: r.vcStatus, vcName: r.vcName, from: run, to: vcRun, shift: k, applied: false });
    } else {
      const reason = !SW.fixCategories.includes(r.category) ? `VC only has it as ${r.vcStatus}, so VC's dates aren't confirmed yet`
        : !agrees ? `the VC record is named "${r.vcName}", which doesn't match the board's name` : 'the days don\'t line up (not a clean week move), and changing them changes who works which day';
      result.questions.push({ ...base, kind: 'dates', vcNumber: r.vcNumber, vcStatus: r.vcStatus, vcRun, why: `VC has ${fmt(vcRun)}, the board has ${fmt(run)}. Left alone: ${reason}` });
    }
  }

  // ---- the only write: date fixes, all or nothing on the count check
  let code = 0;
  const maxFixes = opt('--max-fixes') !== null ? Number(opt('--max-fixes')) : SW.maxDateFixes;
  if (result.fixes.length > maxFixes) {
    result.stopped = `${result.fixes.length} date fixes is more than ${maxFixes}; that looks systematic (a wrong year, a bad pull), so nothing was moved`;
    code = 5;
  } else if (flag('--apply') && result.fixes.length) {
    for (const f of result.fixes) {
      const cur = (await api.events()).find(x => x.id === f.id);
      if (!cur || !sameRun(sellingRun(cur), f.from)) { f.note = 'the board changed while the sweep ran; left alone'; result.questions.push({ ...f, kind: 'dates', why: `VC has ${fmt(f.to)}: ${f.note}` }); continue; }
      const snapshot = { startDate: cur.startDate, endDate: cur.endDate, weekend: cur.weekend, dates: cur.dates, booths: cur.booths, datesEstimated: cur.datesEstimated ?? false };
      await api.patchEvent(f.id, { ...shiftPatch(cur, f.shift), datesMoved: { from: f.from, to: f.to, at: TODAY, why: `VC ${f.vcNumber} (${f.vcStatus}) runs ${fmt(f.to)}`, by: 'service:booking-sweep' } });
      const after = (await api.events()).find(x => x.id === f.id);
      if (sameRun(sellingRun(after), f.to)) { f.applied = true; continue; }
      await api.patchEvent(f.id, snapshot);
      f.note = `read back ${fmt(sellingRun(after))}, not VC's ${fmt(f.to)}; put back`;
      result.questions.push({ ...f, kind: 'dates', why: `VC has ${fmt(f.to)}, the board has ${fmt(f.from)}: the move did not read back right, so it was put back` });
    }
    result.written = result.fixes.some(f => f.applied);
  }
  result.fixes = result.fixes.filter(f => f.applied || !flag('--apply') || code === 5);
  result.counts = Object.fromEntries(['requests', 'holds', 'email', 'fixes', 'questions', 'pending', 'excluded', 'skipped'].map(k => [k, result[k].length]));
  await write(result);
  console.log(summaryMd(result));
  return code;
}

/** What the booking form needs from the board. Contacts are merged in by board-api (never in git). */
function requestFields(e) {
  const pick = k => t(e[k]);
  return { name: t(e.name), cityState: pick('cityState'), location: pick('location'), address: pick('address'), promoter: pick('promoter'),
    contact: pick('contact'), phone: pick('phone'), email: pick('email'), website: pick('website'), applyUrl: pick('applyUrl'), applyBy: pick('applyBy'),
    cost: pick('cost'), costNum: e.costNum ?? null, costBasis: pick('costBasis') || 'date', setting: pick('setting'), notes: t(e.notes), tier: pick('tier'),
    lastYearVcNumber: t(e.lastYear && e.lastYear.vcNumber), datesEstimated: !!e.datesEstimated };
}

// ---------- outputs ----------
export function summaryMd(r) {
  const md = [`# Booking sweep, ${r.date}${r.meeting ? ` (meeting ${r.meeting})` : ''} (${r.mode}${r.written ? ', board dates moved' : ''})`, ''];
  if (r.stopped) md.push(`**STOPPED:** ${r.stopped}`, '');
  const c = r.counts || {};
  md.push(`${c.requests ?? 0} to request, ${c.holds ?? 0} held, ${c.email ?? 0} Prospective for the Olean email, ${c.fixes ?? 0} date fix(es), ${c.questions ?? 0} question(s), ${c.pending ?? 0} request(s) already with Olean.`);
  const sec = (title, xs, line) => { if (xs && xs.length) { md.push('', `## ${title}`); for (const x of xs) md.push('- ' + line(x)); } };
  sec('Requests (submitted only after Alan approves)', r.requests, x => `${fmt(x.run)} ${x.name} (${x.reps.join(', ')})`);
  sec('Held', r.holds, x => `${fmt(x.run)} ${x.name}: ${x.why.join('; ')}`);
  sec('Prospective in VC (the Olean email)', r.email, x => `${x.vcNumber} ${x.name}: VC ${fmt(x.vcRun)}${x.datesDiffer ? `, board ${fmt(x.run)}` : ''}`);
  sec('Board dates moved to VC\'s', r.fixes, x => `${x.name}: ${fmt(x.from)} -> ${fmt(x.to)} (VC ${x.vcNumber}, ${x.vcStatus})${x.applied ? '' : ' (not applied)'}`);
  sec('Questions for Alan (nothing changed)', r.questions, x => `${x.name}: ${x.why}`);
  sec('Requests already with Olean', r.pending, x => `${x.name}: submitted ${x.requestedAt}`);
  sec('Left out (Alan\'s direct shows)', r.excluded, x => x.name);
  return md.join('\n');
}

async function write(result) {
  fs.mkdirSync(OUT_S, { recursive: true, mode: 0o700 }); fs.mkdirSync(OUT_R, { recursive: true });
  for (const f of [path.join(OUT_S, 'latest.json'), path.join(OUT_S, `${result.date}.json`)]) {
    fs.writeFileSync(f + '.tmp', JSON.stringify(result, null, 1), { mode: 0o600 });
    fs.renameSync(f + '.tmp', f);
  }
  fs.writeFileSync(path.join(OUT_R, `booking-sweep-${result.date}.md`), summaryMd(result) + '\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(c => process.exit(c)).catch(e => { console.error('booking-sweep: ' + (e.stack || e.message)); process.exit(1); });
}
