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

/**
 * Move a show to its true run. Per booth: a selling day whose date is in the new run stays (same rep); a day
 * whose weekday occurs once in the new run moves there (its rep with it); anything else is gone (its reps are
 * affected). New days the booth did not have come in empty, but only for a booth that sold every day of the old
 * run (a Saturday-only booth does not grow a Friday). SE days: kept where they were when the new run overlaps the
 * old one (unless the day is now a selling day), moved by the same offset when it does not.
 * @returns { patch, affected: [{ rep, from, to|null }], added: [iso], removed: [iso] } or { error }
 */
export function planMove(e, target) {
  if (!target || !ISO.test(target.start || '') || !ISO.test(target.end || '') || target.start > target.end) return { error: 'the new dates are not a valid run' };
  const tDates = runDays(target);
  if (tDates.length > 21) return { error: 'the new run is longer than three weeks' };
  const old = sellingRun(e);
  if (!old) return { error: 'the board has no usable selling days to move' };
  const overlap = !(target.end < old.start || target.start > old.end);
  const offset = dayDiff(target.start, old.start);
  const oldAll = new Set(runDays(old));
  const affected = [], added = new Set(), removed = new Set();
  const booths = (e.booths || []).map(b => {
    const days = b.days || [], dates = b.dates || [];
    const sell = [], se = [], loose = [];
    days.forEach((label, i) => { const d = dates[i]; if (isSE(label)) se.push(i); else if (d && ISO.test(d)) sell.push(i); else loose.push(i); });
    const mapTo = {}, used = new Set();
    for (const i of sell) if (tDates.includes(dates[i]) && !used.has(dates[i])) { mapTo[i] = dates[i]; used.add(dates[i]); }
    for (const i of sell) {
      if (mapTo[i]) continue;
      const c = tDates.filter(d => weekday(d) === weekday(dates[i]) && !used.has(d));
      if (c.length === 1) { mapTo[i] = c[0]; used.add(c[0]); }
    }
    const coversRun = sell.length > 0 && [...oldAll].every(d => sell.some(i => dates[i] === d));
    const cols = [];                                                   // { date, label, from: old index | null, se }
    for (const i of sell) if (mapTo[i]) cols.push({ date: mapTo[i], from: i, se: false });
    if (coversRun) for (const d of tDates) if (!used.has(d)) { cols.push({ date: d, from: null, se: false }); added.add(d); }
    const sellingNow = new Set(cols.map(c => c.date));
    for (const i of se) {
      const d = dates[i];
      if (!d || !ISO.test(d)) { cols.push({ date: null, from: i, se: true }); continue; }
      const nd = overlap ? d : addDaysIso(d, offset);
      if (!sellingNow.has(nd)) cols.push({ date: nd, from: i, se: true });
    }
    for (const i of loose) cols.push({ date: null, from: i, se: false, loose: true });
    cols.sort((a, c) => (a.date === null) - (c.date === null) || String(a.date).localeCompare(String(c.date)));
    const newDays = cols.map(c => (c.loose ? days[c.from] : c.se ? (c.date ? `${weekday(c.date)} SE` : days[c.from]) : weekday(c.date)));
    const newDates = cols.map(c => c.date);
    const shifts = (b.shifts || []).map(s => ({ ...s, slots: cols.map(c => (c.from !== null && s.slots && s.slots[c.from] ? JSON.parse(JSON.stringify(s.slots[c.from])) : { rep: '', ft: [] })) }));
    for (const i of sell) {
      const gone = !mapTo[i], moved = mapTo[i] && mapTo[i] !== dates[i];
      if (gone) removed.add(dates[i]);
      if (!gone && !moved) continue;
      for (const s of b.shifts || []) {
        const r = s.slots && s.slots[i] && String(s.slots[i].rep || '').trim();
        if (!r || r === '__X__') continue;
        for (const one of r.split(' / ').map(x => x.trim()).filter(Boolean)) affected.push({ rep: one, from: dates[i], to: gone ? null : mapTo[i] });
      }
    }
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
  return { patch, affected, added: [...added].sort(), removed: [...removed].sort() };
}
