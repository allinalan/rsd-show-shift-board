/*
  dates — a show's days on the board, and moving them to the true dates. Pure functions, no I/O.

  Used by scripts/booking-sweep.mjs and scripts/board-research.mjs (the date research 7 days before a meeting,
  the preflight 2 days before, and the booking sweep's VC-vs-board date mismatches; Alan, 2026-09-24: "if there
  are date mismatches from VC and the Board, do the research to find the actual date; if you cannot find it on
  the internet go off of VectorConnect but make a note on the Board").

  A board event keeps its days per booth: booths[].days (labels: "Friday", "Sat", "Monday SE"), booths[].dates
  (ISO, one per day) and booths[].shifts[].slots (one per day). Set-up/tear-down days ("SE") are never selling days.
*/
import { addDaysIso, dayDiff } from './match.mjs';

const ISO = /^\d{4}-\d{2}-\d{2}$/;
export const isSE = label => /set\s*up|tear\s*down|\bse\b/i.test(String(label || ''));
const WD = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const weekday = iso => WD[new Date(iso + 'T12:00:00Z').getUTCDay()];
/** The board's weekend key: the Friday of the Monday-to-Sunday week (board.mjs fridayKey). */
export const fridayKey = iso => { const off = (new Date(iso + 'T12:00:00Z').getUTCDay() + 6) % 7; return addDaysIso(iso, 4 - off); };
const WDN = { sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2, wednesday: 3, wed: 3, thursday: 4, thu: 4, thur: 4, thurs: 4, friday: 5, fri: 5, saturday: 6, sat: 6 };
/**
 * The weekday a day label names (0 = Sunday), read like the page's dayOf() in index.html: past any bracketed note
 * ("Friday (SE)", "Wed (set-up"), and an old year's full date as its weekday ("3/1/2024": the Sept-Feb Sheet holds
 * 2024 dates shown as "Friday"). null for a label that names no day ("Tucson, AZ", "Service Events").
 */
export function labelWeekday(label) {
  const s = String(label || '').toLowerCase().replace(/\([^)]*(\)|$)/g, ' ').replace(/\bse\b/g, ' ').trim().replace(/\.$/, '');
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return new Date(Date.UTC(+m[3], +m[1] - 1, +m[2], 12)).getUTCDay();
  for (const t of s.split(/[^a-z]+/)) if (Object.prototype.hasOwnProperty.call(WDN, t)) return WDN[t];
  return null;
}

/**
 * The show's selling days on the board: every booth's day dates, SE days left out. null when there are none,
 * or when they sit more than a week from the weekend the show is staffed for (stale day cells: the Phoenix
 * Quilt row carried 1/25/2024..1/27/2024) or span more than three weeks.
 */
export function sellingRun(e) {
  const ds = [];
  for (const b of e.booths || []) (b.dates || []).forEach((d, i) => { if (d && ISO.test(d) && !isSE((b.days || [])[i])) ds.push(d); });
  ds.sort();
  if (!ds.length) return null;
  const run = { start: ds[0], end: ds[ds.length - 1] };
  if (e.weekend && Math.abs(dayDiff(run.start, e.weekend)) > 7) return null;
  if (dayDiff(run.end, run.start) > 21) return null;
  return run;
}
export const sameRun = (a, b) => !!a && !!b && a.start === b.start && a.end === b.end;
/** The board's selling days sit inside the other run (VC often carries a set-up day): nothing wrong. */
export const within = (board, other) => !!board && !!other && other.start <= board.start && board.end <= other.end;
export const runDays = r => { const out = []; for (let d = r.start; d <= r.end && out.length < 60; d = addDaysIso(d, 1)) out.push(d); return out; };

/** Shows a sheet-sync roll-in made from last year's tab of a book (sheet-sync.mjs --roll-in): rolled, like rolledFrom. */
const ROLLED_IN_BY = new Set(['service:sheet-sync:roll-in']);
const rolled = e => !!e.rolledFrom || ROLLED_IN_BY.has(e.createdBy);

/**
 * A show rolled forward from last year (the board's roll: rolledFrom; a sheet-sync roll-in: createdBy) that nobody
 * has touched since (dates still estimated, still Prospective, no VC number, nobody on a shift) and whose first day is
 * more than `days` after `today`. The web research leaves these until they come inside the window (Alan, 2026-10-24:
 * rolling 2026 into 2027 must not spend January's research money on next fall's shows, nor trip the 25-move limit on
 * them; the same day, the May-Sept 2026 roll-in's July-September shows too). Touch it in any of those ways and it is
 * researched like any other show.
 */
export function rolledForLater(e, today, days) {
  if (!e || !rolled(e) || !e.datesEstimated || (e.status || 'Prospective') !== 'Prospective' || e.vcNumber) return false;
  if ((e.booths || []).some(b => (b.shifts || []).some(s => (s.slots || []).some(x => x && x.rep && x.rep !== '__X__')))) return false;
  const first = (sellingRun(e) || {}).start || e.startDate || e.weekend;
  return !!first && ISO.test(first) && dayDiff(first, today) > days;
}

/**
 * A booth's days as dated before a move: each cell's own date, and for a day without one (the cell held "3/1/2024",
 * which the Sheet shows as "Friday") the date its label's weekday stands for: the one such date within 3 days of the
 * run, between the booth's dated days either side of it and on none of them. null when there is not exactly one, or
 * when two undated days would be the same day.
 */
function oldDates(b, run) {
  const days = b.days || [], own = days.map((_, i) => (ISO.test((b.dates || [])[i] || '') ? b.dates[i] : null));
  const read = own.map((d, i) => {
    const w = d ? null : labelWeekday(days[i]);
    if (w === null) return null;
    const before = own.slice(0, i).filter(Boolean).pop(), after = own.slice(i + 1).find(Boolean), c = [];
    for (let x = addDaysIso(run.start, -3); x <= addDaysIso(run.end, 3); x = addDaysIso(x, 1))
      if (WD.indexOf(weekday(x)) === w && (!before || x > before) && (!after || x < after) && !own.includes(x)) c.push(x);
    return c.length === 1 ? c[0] : null;
  });
  return own.map((d, i) => d || (read[i] && read.indexOf(read[i]) === read.lastIndexOf(read[i]) ? read[i] : null));
}

/**
 * Where a set-up or tear-down day goes when its show moves: on its own weekday and the same side of the run, at most
 * one day further from the run than it was (Bluegrass on the Beach 2027's "Mon SE" after a Fri-Sun run stays the
 * Monday after; shifting it by the run's offset put it on Sunday on 2026-09-24, where it was dropped). A day inside
 * the old run takes its weekday in the new one when that weekday occurs there once. null when it has nowhere to go.
 */
function placeSE(d, span, target, tDates) {
  if (d >= span.start && d <= span.end) { const c = tDates.filter(x => weekday(x) === weekday(d)); return c.length === 1 ? c[0] : null; }
  const before = d < span.start, edge = before ? target.start : target.end, step = before ? -1 : 1;
  const gap = Math.abs(dayDiff(d, before ? span.start : span.end));
  let nd = addDaysIso(edge, step);
  while (weekday(nd) !== weekday(d)) nd = addDaysIso(nd, step);
  return Math.abs(dayDiff(nd, edge)) <= gap + 1 ? nd : null;
}

/**
 * Move a show to its true run. Per booth: a selling day whose date is in the new run stays (same rep); a day
 * whose weekday occurs once in the new run moves there (its rep with it); anything else is gone (its reps are
 * affected). A day with no date whose label names a weekday (oldDates) is read as that day and moved the same way,
 * after the days that have their own date. New days the booth did not have come in empty, but only for a booth that
 * sold every day of the old run (a Saturday-only booth does not grow a Friday). SE days keep their weekday next to
 * the run (placeSE); one with nowhere to go is gone, and its reps are affected. A day whose date can't be read
 * (a column that names no day, "Tucson, AZ") stays as it was, undated, and is listed in `loose` for the report.
 * @returns { patch, affected: [{ rep, from, to|null }], added: [iso], removed: [iso], loose: [{ booth, label, reps }] }
 *   or { error }
 */
export function planMove(e, target) {
  if (!target || !ISO.test(target.start || '') || !ISO.test(target.end || '') || target.start > target.end) return { error: 'the new dates are not a valid run' };
  const tDates = runDays(target);
  if (tDates.length > 21) return { error: 'the new run is longer than three weeks' };
  const old = sellingRun(e);
  if (!old) return { error: 'the board has no usable selling days to move' };
  const whens = (e.booths || []).map(b => oldDates(b, old));
  const span = { ...old };                                            // the old run with the days read from their labels
  (e.booths || []).forEach((b, k) => whens[k].forEach((d, i) => { if (d && !isSE((b.days || [])[i])) { if (d < span.start) span.start = d; if (d > span.end) span.end = d; } }));
  const oldAll = new Set(runDays(old));
  const affected = [], added = new Set(), removed = new Set(), loose = [];
  const repsOn = (b, i) => (b.shifts || []).flatMap(s => {
    const r = s.slots && s.slots[i] && String(s.slots[i].rep || '').trim();
    return !r || r === '__X__' ? [] : r.split(' / ').map(x => x.trim()).filter(Boolean);
  });
  const booths = (e.booths || []).map((b, k) => {
    const days = b.days || [], when = whens[k];
    const sell = [], se = [], undated = [];
    days.forEach((label, i) => { if (isSE(label)) se.push(i); else if (when[i]) sell.push(i); else undated.push(i); });
    const own = i => ISO.test((b.dates || [])[i] || ''), order = [...sell.filter(own), ...sell.filter(i => !own(i))];
    const mapTo = {}, used = new Set();
    for (const i of order) if (tDates.includes(when[i]) && !used.has(when[i])) { mapTo[i] = when[i]; used.add(when[i]); }
    for (const i of order) {
      if (mapTo[i]) continue;
      const c = tDates.filter(d => weekday(d) === weekday(when[i]) && !used.has(d));
      if (c.length === 1) { mapTo[i] = c[0]; used.add(c[0]); }
    }
    const coversRun = sell.length > 0 && [...oldAll].every(d => sell.some(i => when[i] === d));
    const cols = [];                                                   // { date, label, from: old index | null, se }
    for (const i of sell) if (mapTo[i]) cols.push({ date: mapTo[i], from: i, se: false });
    if (coversRun) for (const d of tDates) if (!used.has(d)) { cols.push({ date: d, from: null, se: false }); added.add(d); }
    for (const i of sell) {
      const gone = !mapTo[i], moved = mapTo[i] && mapTo[i] !== when[i];
      if (gone) removed.add(when[i]);
      if (gone || moved) for (const rep of repsOn(b, i)) affected.push({ rep, from: when[i], to: gone ? null : mapTo[i] });
    }
    const taken = new Set(cols.map(c => c.date));
    for (const i of se) {
      const d = when[i];
      if (!d) { cols.push({ date: null, from: i, se: true }); loose.push({ booth: b.label || '', label: days[i], reps: repsOn(b, i) }); continue; }
      const nd = placeSE(d, span, target, tDates);
      if (nd && !taken.has(nd)) { cols.push({ date: nd, from: i, se: true }); taken.add(nd); continue; }
      removed.add(d);
      for (const rep of repsOn(b, i)) affected.push({ rep, from: d, to: null });
    }
    for (const i of undated) { cols.push({ date: null, from: i, se: false, loose: true }); loose.push({ booth: b.label || '', label: days[i], reps: repsOn(b, i) }); }
    cols.sort((a, c) => (a.date === null) - (c.date === null) || String(a.date).localeCompare(String(c.date)));
    const newDays = cols.map(c => (c.loose ? days[c.from] : c.se ? (c.date ? `${weekday(c.date)} SE` : days[c.from]) : weekday(c.date)));
    const newDates = cols.map(c => c.date);
    const shifts = (b.shifts || []).map(s => ({ ...s, slots: cols.map(c => (c.from !== null && s.slots && s.slots[c.from] ? JSON.parse(JSON.stringify(s.slots[c.from])) : { rep: '', ft: [] })) }));
    return { ...b, days: newDays, dates: newDates, shifts };
  });
  const all = booths.flatMap(b => b.dates).filter(d => d && ISO.test(d)).sort();
  const firstSell = booths.flatMap(b => b.dates.filter((d, i) => d && !isSE(b.days[i]))).sort()[0] || target.start;
  // top-level days/dates mirror the event's full day list (every booth's days, once each, in date order)
  const seen = new Map();
  for (const b of booths) b.dates.forEach((d, i) => { if (d && !seen.has(d)) seen.set(d, b.days[i]); });
  const order = [...seen.keys()].sort();
  const patch = { startDate: all[0] || target.start, endDate: all[all.length - 1] || target.end, weekend: fridayKey(firstSell),
    days: order.map(d => seen.get(d)), dates: order, booths, datesEstimated: false };
  return { patch, affected, added: [...added].sort(), removed: [...removed].sort(), loose };
}
