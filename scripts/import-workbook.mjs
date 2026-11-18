#!/usr/bin/env node
/*
  import-workbook — read a coordinator's yearly schedule workbook (.xlsx, one tab per month) into board-shaped events.

  Built for another coordinator's divisions (the first two books came in 2026-11-06), whose schedule is not Rising
  Sun's Sheet: weeks run Tuesday to Monday, each week has sections side by side (KEY EVENTS, VARSITY / JV,
  WEEKLY EVENTS, WEEKLY MALL LEASES, then PROJECT SHOW(S) under the team booths), every event is a small block of rows
  (name, dates, city, cost, best ever, day rows, notes), and its status is the colour of the name cell.
  docs/import-workbook.md has the layout, what is skipped and what is still unknown.

  It writes nothing to any database: there is no --apply. It reads the workbook and writes one JSON file, which must
  sit outside this repo (the repo is public; another coordinator's events, reps and costs are not).

  Usage:
    import-workbook.mjs <book.xlsx> --division <id> --year <yyyy> [--out <file.json>] [--nicknames <file.json>]
                        [--tab <name>] [--strict]

    --division   the division the events belong to (lower case, e.g. abc); every event id starts with it
    --year       the year the workbook is for. A date cell in another year, outside its own week, is a stale date
    --out        where the events go (JSON, mode 600). Refused inside this repo or any other git work tree
    --nicknames  a JSON object { "<name as written in a shift cell>": "<rep name>" }; names it lacks are listed
    --tab        read one tab only
    --strict     exit 2 when anything could not be read (blocks no rule took, fills the colour key does not name)

  The report (stdout): events by section and status, booths, half shifts, open slots, field trainees, stale dates,
  blocks it could not read (tab and cells), fills the tab's colour key does not name, and the distinct names written in
  shift cells (for the nickname-to-rep table). Costs are never printed.
*/
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isMain } from './lib/is-main.mjs';
import { openWorkbook, cellRef, serialToDate } from './lib/xlsx.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------- small helpers --------------------------------------------------------------------------
const str = v => (v === null || v === undefined) ? '' : String(v).replace(/ /g, ' ').trim();
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
export const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthIdx = s => MONTHS.indexOf(String(s || '').toLowerCase().slice(0, 3));
const iso = d => d ? d.toISOString().slice(0, 10) : null;
const utc = (y, m, d) => new Date(Date.UTC(y, m, d));
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);
const daysBetween = (a, b) => Math.round((b.getTime() - a.getTime()) / 86400000);
export const slug = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '');
const normName = s => String(s || '').toLowerCase().replace(/[^a-z]/g, '');

const WEEKDAY = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
/** "Sat", "Fri (1/2 Shift)", "Thurs (1/2 shift)", "Sun " name a day; a longer phrase ("Saturday only ...") does not. */
const DAY_LABEL = /^(sun|sunday|mon|monday|tue|tues|tuesday|wed|weds|wednesday|thu|thur|thurs|thursday|fri|friday|sat|saturday)\.?\s*(\(.*\)?)?$/i;
export const weekdayOfLabel = s => { const m = str(s).match(DAY_LABEL); return m ? WEEKDAY[m[1].toLowerCase().slice(0, 3)] : null; };
/** "01/09 (1/2 Shift)", "1/9" -> { mo: 0, day: 9, y: null } */
const DATE_LABEL = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\s*(\(.*\)?)?$/;
const dateLabel = s => { const m = str(s).match(DATE_LABEL); return m && +m[1] >= 1 && +m[1] <= 12 ? { mo: +m[1] - 1, day: +m[2], y: m[3] ? (+m[3] < 100 ? 2000 + +m[3] : +m[3]) : null } : null; };
const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const isDayLabel = s => weekdayOfLabel(s) !== null || dateLabel(s) !== null;
/** A half shift is written into the day label: "(1/2)", "(1/2 Shift)", "(1/2 shift)". */
export const isHalf = s => /\(\s*1\s*\/\s*2\b|\b1\s*\/\s*2\s*shift/i.test(str(s));
const isSerial = v => typeof v === 'number' && v > 20000 && v < 80000;
const isOpen = s => /_/.test(s) && /^[_\s.\-–]+$/.test(s);

/** The dates cell under a name, as text: "Jan 2-3", "Feb 23-March 1", "Mar 20 - 21", "Jan 2", "1/9". Null for words ("TBD"). */
export function parseDatesText(raw, near) {
  const s = str(raw);
  const pick = (mo, day) => {                               // the year that puts mo/day nearest the week it sits in
    if (mo < 0 || day < 1 || day > 31) return null;
    const y0 = near ? near.getUTCFullYear() : 2000;
    let best = null;
    for (const y of [y0 - 1, y0, y0 + 1]) {
      const d = utc(y, mo, day); if (d.getUTCMonth() !== mo) continue;
      if (!best || (near && Math.abs(daysBetween(near, d)) < Math.abs(daysBetween(near, best)))) best = d;
    }
    return best;
  };
  let m = s.match(/^([A-Za-z]{3,9})\.?\s*(\d{1,2})(?:st|nd|rd|th)?\s*(?:[-–&]|to\b|thru\b|through\b)\s*(?:([A-Za-z]{3,9})\.?\s*)?(\d{1,2})(?:st|nd|rd|th)?\b/i);
  if (m && monthIdx(m[1]) >= 0 && (!m[3] || monthIdx(m[3]) >= 0)) {
    const start = pick(monthIdx(m[1]), +m[2]);
    if (!start) return null;
    let end = utc(start.getUTCFullYear(), m[3] ? monthIdx(m[3]) : start.getUTCMonth(), +m[4]);
    if (end < start) end = utc(end.getUTCFullYear() + 1, end.getUTCMonth(), end.getUTCDate());
    return daysBetween(start, end) <= 62 ? { start, end } : null;
  }
  m = s.match(/^([A-Za-z]{3,9})\.?\s*(\d{1,2})(?:st|nd|rd|th)?\s*$/);
  if (m && monthIdx(m[1]) >= 0) { const d = pick(monthIdx(m[1]), +m[2]); return d ? { start: d, end: d } : null; }
  const dl = dateLabel(s);
  if (dl) { const d = dl.y ? utc(dl.y, dl.mo, dl.day) : pick(dl.mo, dl.day); return d ? { start: d, end: d } : null; }
  return null;
}

/** "WEEK 1 (Dec 29 - Jan 4)", "WEEK 4 (Feb 23-March 1)", "WEEK 3 (Jan 12-18) (YEB ?)" in the tab for month `tabMonth` (0-11). */
export function parseWeekHeader(text, year, tabMonth) {
  const m = str(text).match(/^WEEK\s*(\d+)\s*\(\s*([A-Za-z]{3,9})\.?\s*(\d{1,2})\s*[-–]\s*(?:([A-Za-z]{3,9})\.?\s*)?(\d{1,2})\s*\)/i);
  if (!m || monthIdx(m[2]) < 0 || (m[4] && monthIdx(m[4]) < 0)) return null;
  const smo = monthIdx(m[2]);
  let sy = year;
  if (tabMonth === 0 && smo === 11) sy = year - 1;        // the January tab's first week starts in December
  if (tabMonth === 11 && smo === 0) sy = year + 1;
  const start = utc(sy, smo, +m[3]);
  // A week is Tuesday to Monday. Typed headers slip ("July 29 - Aug 3" for July 28, "July 30-6" for June 30 - July 6), so
  // when the two ends are not a Tuesday six days before a Monday, the Monday end wins, then the Tuesday start.
  const endMonths = m[4] ? [monthIdx(m[4])] : (+m[5] < +m[3] ? [smo + 1, tabMonth] : [smo]);
  const endOf = mo => mo > 11 ? utc(sy + 1, mo - 12, +m[5]) : utc(mo < smo ? sy + 1 : sy, mo, +m[5]);
  let pick = null;
  for (const mo of endMonths) { const end = endOf(mo); if (start.getUTCDay() === 2 && daysBetween(start, end) === 6) { pick = { start, end }; break; } }
  if (!pick) for (const mo of endMonths) { const end = endOf(mo); if (end.getUTCDay() === 1 && Math.abs(daysBetween(start, end)) < 40) { pick = { start: addDays(end, -6), end, corrected: true }; break; } }
  if (!pick && start.getUTCDay() === 2) pick = { start, end: addDays(start, 6), corrected: true };
  if (!pick) { const end = endOf(endMonths[0]); pick = { start, end: end < start ? addDays(start, 6) : end, odd: true }; }
  let fri = pick.start; while (fri.getUTCDay() !== 5 && fri < pick.end) fri = addDays(fri, 1);
  return { n: +m[1], start: pick.start, end: pick.end, friday: fri, tuesday: pick.start.getUTCDay() === 2, corrected: !!pick.corrected, odd: !!pick.odd };
}

/** "Best Ever (Jan): $16,879 (2025)", "Best Ever 14,316 (2024)", "New Event", "New Event - Last Worked: $8,428 (2017)". */
export function bestEverOf(s) {
  const t = str(s);
  if (/^new\s*event/i.test(t)) {
    const lw = t.match(/last\s*worked\s*:?\s*\$?\s*([\d,]+)(?:\.\d+)?\s*(?:\((\d{4})\))?/i);
    return { cpo: null, year: null, new: true, ...(lw ? { lastWorked: { amount: +lw[1].replace(/,/g, ''), year: lw[2] ? +lw[2] : null } } : {}) };
  }
  const m = t.match(/(?:best\s*ever|last\s*worked)\s*(?:\(([^)]*)\))?\s*:?\s*\$?\s*([\d,]+(?:\.\d+)?)\s*(?:\((\d{4})\))?/i);
  if (m) return { cpo: Math.round(Number(m[2].replace(/,/g, ''))), year: m[3] ? +m[3] : null, ...(m[1] ? { month: m[1].trim() } : {}) };
  return { cpo: null, year: null };
}

// ---------- the colour key (row 1 of each tab) --------------------------------------------------------
const ROLE = [
  [/^booked$/i, { status: 'Booked' }],
  [/charges.*orders.*match|match\s*complete/i, { status: 'Booked', flag: 'closedOut' }],
  [/cancel|missed/i, { status: 'Cancelled', dead: true }],
  [/not\s*booked/i, { status: 'Prospective', flag: 'notBooked' }],
  [/pros?pective|perspective|pending/i, { status: 'Prospective', flag: 'pending' }],
  [/priority\s*booking/i, { status: 'Prospective', flag: 'priorityBooking' }],
  [/sent\s*e-?mail/i, { status: 'Prospective', flag: 'emailSent' }],
  [/wait\s*-?\s*list/i, { status: 'Show Full', flag: 'waitlist' }],
  [/split\s*tab/i, { status: 'Booked', flag: 'splitTabs' }],
  [/field\s*train/i, { role: 'trainee' }],
  [/booth\s*in\s*use/i, { role: 'inUse' }],
  [/key\s*events/i, { role: 'section' }],
];
const roleOf = label => { for (const [re, r] of ROLE) if (re.test(label)) return r; return null; };
/**
 * Row 1 names the colours: each label cell carries its own fill; "Booked" has none. Read per tab, never hard-coded: the
 * books spell and place it differently from tab to tab, and one book carries Waitlist in some tabs only.
 */
export function readKey(sheet) {
  const byFill = new Map(); let noFill = null; const problems = [];
  for (let c = 0; c < sheet.cols; c++) {
    const x = sheet.get(0, c); const label = x ? str(x.v) : '';
    if (!label) continue;
    if (!x.fill) { if (/^booked$/i.test(label)) noFill = label; continue; }   // "auto" or "sa" in A1 is not a label
    if (byFill.has(x.fill) && byFill.get(x.fill) !== label) problems.push(`${sheet.name}!${cellRef(0, c)}: ${x.fill} is both "${byFill.get(x.fill)}" and "${label}"`);
    byFill.set(x.fill, label);
  }
  const fillOfRole = role => { for (const [f, l] of byFill) if ((roleOf(l) || {}).role === role) return f; return null; };
  return {
    byFill, noFill, problems,
    trainee: fillOfRole('trainee'), inUse: fillOfRole('inUse'), section: fillOfRole('section'),
    /** What a cell's fill says: { label, status, dead, flag }, or { unknown: fill } (and the key's label if it has one). */
    statusOf(fill) {
      if (!fill) return { label: noFill || 'Booked', status: 'Booked', dead: false, flag: null };
      const label = byFill.get(fill);
      if (!label) return { unknown: fill };
      const r = roleOf(label) || {};
      if (!r.status) return { unknown: fill, label };
      return { label, status: r.status, dead: !!r.dead, flag: r.flag || null };
    },
  };
}

// ---------- what a cell is ---------------------------------------------------------------------------
const SECTION_RX = [
  [/^key\s*events?$/i, 'key'], [/^varsity\s*\/?\s*jv$/i, 'vjv'], [/^weekly\s*events?$/i, 'weekly'],
  [/^weekly\s*mall\s*leases?$/i, 'mall'], [/^project\s*shows?$/i, 'project'],
];
export const sectionOf = s => { const t = str(s); for (const [re, k] of SECTION_RX) if (re.test(t)) return k; return null; };
/** The board's tier for each section. VARSITY / JV, WEEKLY EVENTS and PROJECT SHOW(S) are a guess until the coordinator's team says (docs). */
export const SECTION_TIER = { key: 'Key', vjv: 'Traditional', weekly: 'Traditional', project: 'Traditional' };
/** A shift cell that is a note about the day, not a person: no shift that day. */
const NOT_A_PERSON = /set\s*-?\s*up|tear\s*-?\s*down|break\s*-?\s*down|no\s+vendors|^closed\b|^off$|^x+$|^n\/?a$|not\s+happening|cancel/i;
/** What a dates cell says when there are no dates: "NO 2027", "NOT HAPPENONG 2026", "POSTPONED TO 2027", "*No Jan Market*". */
const NOT_HAPPENING = /^\W*(no|not)\b|not\s+happen|cancel|postpon|will\s+be\s+back/i;
const NOTE_HEAD = /^(event\s*notes|marketing\s*standards|service\s*standards|marketing\s*\/\s*service)\b/i;
/** "Priority", and the spellings the books also use ("Prioirty", "Priorirty"). */
const PRIORITY = /^\W*pri[a-z]{0,4}ty\b/i;
const BEST_EVER = /^(best\s*ever|new\s*event|last\s*worked)/i;
const COSTISH = s => /^\$|^free\b|^donation\b|charge\s*-?\s*back|overage|pay\s+(at|via|cash)|per\s+day|deposit/i.test(s);
const DATEY_TEXT = s => parseDatesText(s, null) !== null || /^(tbd|tba)\b|not\s+happening|^cancel|^postpon|^\*?\s*no\s+\w+\s+(market|show|event)|^every\s+(mon|tue|wed|thu|fri|sat|sun|week|other)|^(1st|2nd|3rd|4th|last)\s+(mon|tue|wed|thu|fri|sat|sun|week)/i.test(s);
const datey = v => isSerial(v) || (typeof v === 'string' && DATEY_TEXT(str(v)));
/** Text that is never an event's name. */
function neverAName(s) {
  return !s || NOTE_HEAD.test(s) || BEST_EVER.test(s) || /^\*/.test(s) || PRIORITY.test(s) || /^booth\b|^\?\s*booth|booth\s*#?\s*$/i.test(s)
    || /^\$/.test(s) || /^[\d,.\s/-]+$/.test(s) || /^[_\s.\-–]+$/.test(s) || isDayLabel(s) || DATEY_TEXT(s) || sectionOf(s) || /^week\s*\d/i.test(s)
    || /^(personal|team)\s*booths?$/i.test(s) || NOT_A_PERSON.test(s);
}

// ---------- one month tab ---------------------------------------------------------------------------
/**
 * Read one month tab. `sheet` is anything with { name, rows, cols, merges, get(r, c) } (lib/xlsx.mjs, or the tests'
 * in-memory grid, gridSheet() below). Returns { events, inventory, skipped, unparsed, unknownFills, slotFills, warnings, key }.
 */
export function parseMonthTab(sheet, { year, division, tabMonth, date1904 = false, file = '' }) {
  const key = readKey(sheet);
  const at = (r, c) => sheet.get(r, c);
  const val = (r, c) => { const x = at(r, c); return x ? x.v : ''; };
  const txt = (r, c) => str(val(r, c));
  const ref = (r, c) => `${sheet.name}!${cellRef(r, c)}`;
  const out = { events: [], inventory: [], skipped: { mall: 0 }, unparsed: [], suspects: [], unknownFills: [], slotFills: [], warnings: [...key.problems],
    key: Object.fromEntries([...key.byFill].map(([f, l]) => [l, f])) };
  const used = new Set(); const K = (r, c) => r * 16384 + c;
  const mark = (r, c) => used.add(K(r, c)); const isUsed = (r, c) => used.has(K(r, c));
  const mergeAt = new Map((sheet.merges || []).map(m => [K(m.r0, m.c0), m]));

  // weeks: "WEEK n (...)" in column A, Tuesday to Monday
  const weeks = [];
  for (let r = 1; r < sheet.rows; r++) {
    const t = txt(r, 0);
    if (!/^week\s*\d/i.test(t)) continue;
    const w = parseWeekHeader(t, year, tabMonth);
    if (!w) out.warnings.push(`${ref(r, 0)}: a week header whose dates cannot be read; its events get no weekend`);
    else if (w.corrected) out.warnings.push(`${ref(r, 0)}: "${t}" is not a Tuesday-to-Monday week; read as ${iso(w.start)} to ${iso(w.end)}`);
    else if (w.odd) out.warnings.push(`${ref(r, 0)}: "${t}" is not a Tuesday-to-Monday week and could not be squared; its days are placed from ${iso(w.start)}`);
    weeks.push({ row: r, w });
    mark(r, 0);
  }
  if (!weeks.length) { out.warnings.push(`${sheet.name}: no WEEK rows; nothing read from this tab`); return out; }
  const weekOfRow = r => { let w = null; for (const x of weeks) if (x.row < r) w = x.w; return w; };

  for (let wi = 0; wi < weeks.length; wi++) {
    const w0 = weeks[wi].row, w1 = wi + 1 < weeks.length ? weeks[wi + 1].row : sheet.rows, week = weeks[wi].w;

    // section headers: KEY EVENTS | VARSITY / JV | WEEKLY EVENTS | WEEKLY MALL LEASES, later PROJECT SHOW(S)
    const headers = [];
    for (let r = w0 + 1; r < w1; r++) {
      const inRow = [];
      for (let c = 1; c < sheet.cols; c++) { const k = sectionOf(val(r, c)); if (k) inRow.push({ row: r, c0: c, section: k }); }
      inRow.forEach((h, i) => {
        const m = mergeAt.get(K(r, h.c0));
        if (m && m.r0 === m.r1) h.c1 = m.c1;
        else if (i + 1 < inRow.length) h.c1 = inRow[i + 1].c0 - 1;
        else { const above = [...headers].reverse().find(x => x.c0 <= h.c0 && h.c0 <= x.c1); h.c1 = above ? above.c1 : sheet.cols - 1; }
        for (let c = h.c0; c <= h.c1; c++) mark(r, c);
        headers.push(h);
      });
    }
    if (!headers.length) { out.warnings.push(`${ref(w0, 0)}: a week with no section headers; nothing read from it`); continue; }
    const sectionAt = (r, c) => { for (let i = headers.length - 1; i >= 0; i--) { const h = headers[i]; if (h.row <= r && h.c0 <= c && c <= h.c1) return h; } return null; };
    const headerRowCovers = (r, c) => headers.some(h => h.row === r && h.c0 <= c && c <= h.c1);

    // column A: the booth inventory (personal booths by rep, then team booths); "Booth in Use" = in use that week
    let shelf = null; const inv = { tab: sheet.name, week: week ? week.n : null, weekend: week ? iso(week.friday) : null, personal: [], team: [] };
    for (let r = w0 + 1; r < w1; r++) {
      const t = txt(r, 0);
      if (/^personal\s*booths?$/i.test(t)) { shelf = 'personal'; mark(r, 0); continue; }
      if (/^team\s*booths?$/i.test(t)) { shelf = 'team'; mark(r, 0); continue; }
      if (!t || !shelf) continue;
      const x = at(r, 0);
      inv[shelf].push({ name: t.replace(/\s+/g, ' '), inUse: !!(x.fill && x.fill === key.inUse), cell: cellRef(r, 0) });
      if (x.fill && x.fill !== key.inUse) out.unknownFills.push({ cell: ref(r, 0), fill: x.fill, keyLabel: key.byFill.get(x.fill) || null, what: 'booth inventory' });
      mark(r, 0);
    }
    out.inventory.push(inv);

    // where events start: a name cell, coloured by its status (or plain = Booked, then its dates under it)
    const isStart = (r, c, h, soft) => {
      const x = at(r, c); if (!x || typeof x.v !== 'string') return false;
      const s = str(x.v);
      if (neverAName(s) || headerRowCovers(r, c)) return false;
      const st = x.fill ? key.statusOf(x.fill) : null;
      const statusFill = !!x.fill && x.fill !== key.trainee && x.fill !== key.inUse && x.fill !== key.section && !!(st.status || st.unknown);
      if (soft) return statusFill && (c - 1 < h.c0 || txt(r, c - 1) === '');
      if (x.link) return true;
      const datesBelow = datey(val(r + 1, c));
      if (statusFill && datesBelow) return true;
      if (c - 1 >= h.c0 && txt(r, c - 1) !== '') return false;     // otherwise a name to the right of something is a person, not an event
      return statusFill || datesBelow;
    };
    const starts = [];
    for (let c = 1; c < sheet.cols; c++) {
      let hardUntil = -1, softUntil = -1;           // under a name: its dates (never a name), then city and cost (only a coloured name)
      for (let r = w0 + 1; r < w1; r++) {
        const h = sectionAt(r, c); if (!h) continue;
        if (r <= hardUntil) continue;
        if (isStart(r, c, h, r <= softUntil)) { starts.push({ r, c, h }); hardUntil = r + 1; softUntil = r + 3; }
      }
    }
    // a label merged across a section above its events (a fair's name over its venues) names their group
    const groups = [];
    for (const m of sheet.merges || []) {
      if (m.r0 <= w0 || m.r0 >= w1 || m.r0 !== m.r1 || m.c1 - m.c0 < 2) continue;
      const t = txt(m.r0, m.c0); if (!t || sectionOf(t) || /^week/i.test(t)) continue;
      if (starts.some(s => s.r > m.r0 && s.r <= m.r0 + 2 && s.c >= m.c0 && s.c <= m.c1)) { groups.push({ ...m, label: t }); for (let c = m.c0; c <= m.c1; c++) mark(m.r0, c); }
    }

    for (const s of starts) {
      const h = s.h;
      const below = starts.filter(o => o.c === s.c && o.r > s.r).map(o => o.r);
      const headerBelow = headers.filter(x => x.row > s.r && x.c0 <= s.c && s.c <= x.c1).map(x => x.row);
      const end = Math.min(w1, ...below, ...headerBelow) - 1;
      const right = starts.filter(o => o.h === h && o.c > s.c).map(o => o.c - 1);
      const bound = Math.min(h.c1, ...right);
      if (h.section === 'mall') {                   // WEEKLY MALL LEASES: standing placeholders, skipped (counted)
        out.skipped.mall++;
        for (let r = s.r; r <= end; r++) for (let c = s.c; c <= bound; c++) mark(r, c);
        continue;
      }
      const group = groups.find(g => s.r > g.r0 && s.r <= g.r0 + 2 && s.c >= g.c0 && s.c <= g.c1);
      out.events.push(readBlock(s.r, s.c, end, bound, h.section, group ? group.label : null, weekOfRow(s.r)));
    }
  }

  // anything inside the tab that no rule took is a block this could not read: named by tab and cells, never dropped quietly
  const runs = [];
  for (let c = 1; c < sheet.cols; c++) {
    let run = null;
    for (let r = 1; r < sheet.rows; r++) {
      const loose = !isUsed(r, c) && txt(r, c) !== '';
      if (loose && run && run.r1 === r - 1) { run.r1 = r; run.cells++; continue; }
      if (loose) { run = { c, r0: r, r1: r, cells: 1 }; runs.push(run); }
    }
  }
  out.unparsed = runs.map(u => ({ tab: sheet.name, range: u.r0 === u.r1 ? cellRef(u.r0, u.c) : `${cellRef(u.r0, u.c)}:${cellRef(u.r1, u.c)}`, cells: u.cells, first: txt(u.r0, u.c).slice(0, 40) }));
  return out;

  // ---- one event block: rows r..end, columns c..bound ----------------------------------------------
  function readBlock(r, c, end, bound, section, group, week) {
    for (let rr = r; rr <= end; rr++) for (let cc = c; cc <= bound; cc++) if (txt(rr, cc) !== '' || (at(rr, cc) || {}).fill) mark(rr, cc);
    const nameCell = at(r, c);
    const name = str(nameCell.v).replace(/\s+/g, ' ');
    const st = key.statusOf(nameCell.fill);
    if (st.unknown) out.unknownFills.push({ cell: ref(r, c), fill: st.unknown, keyLabel: st.label || null, what: 'event name' });
    const flags = {};
    if (st.flag) flags[st.flag] = true;
    const ev = {
      id: '', division, year, season: String(year), source: 'workbook-import',
      name, section, tier: SECTION_TIER[section], group: group || '',
      weekend: week ? iso(week.friday) : null,
      status: st.status || '', dead: !!st.dead, sheetStatus: st.unknown ? `unknown fill ${st.unknown}` : st.label,
      datesText: '', startDate: '', endDate: '', datesStale: false,
      cityState: '', boothText: '', cost: '', costNum: null, costText: '', costNote: '', boothNote: '', costBasis: 'date',
      website: nameCell.link || '', bestCPO: '', bestEver: null,
      booths: [], notes: '', priority: [], flags, comments: [],
      sheetRef: { file, tab: sheet.name, cell: cellRef(r, c), rows: `${r + 1}-${end + 1}` },
    };
    const near = week ? week.friday : utc(year, tabMonth, 15);
    const staleCells = [];
    const isStaleDate = d => !!d && d.getUTCFullYear() !== year && !(week && d >= addDays(week.start, -7) && d <= addDays(week.end, 7));
    for (let rr = r; rr <= end; rr++) for (let cc = c; cc <= bound; cc++) { const x = at(rr, cc); if (x && x.comment) ev.comments.push({ cell: cellRef(rr, cc), text: x.comment }); }

    /**
     * A day row: [date serial, a date like "02/11 (1/2 shift)", or blank][day label][people ...], or [day label][people ...],
     * or (in the body only) [date serial][people ...] with no label at all. A long show can run its days down a second set
     * of columns beside the first ([serial][label][people] again, further right): those come back in `more`.
     */
    const dayRow = (row, body, from = c) => {
      const a = val(row, from), A = str(a), B = from + 1 <= bound ? txt(row, from + 1) : '';
      let labelCol = -1;
      if (B && isDayLabel(B) && (A === '' || isSerial(a) || dateLabel(A))) labelCol = from + 1;
      else if (A && isDayLabel(A)) labelCol = from;
      else if (body && isSerial(a) && B && !BEST_EVER.test(B) && !NOTE_HEAD.test(B)) labelCol = from;   // the serial stands in for the label
      if (labelCol < 0) return null;
      const d = { row, col: from, label: labelCol === from && isSerial(a) ? '' : txt(row, labelCol), serial: isSerial(a) ? a : null,
        hint: labelCol === from + 1 && dateLabel(A) ? A : '', slots: [], more: [], notes: [] };
      d.half = isHalf(d.label) || isHalf(d.hint);
      const pendingFt = [];
      for (let cc = labelCol + 1; cc <= bound; cc++) {
        const x = at(row, cc); const s = x ? str(x.v) : '';
        if (s === '') continue;
        if (cc + 1 <= bound && (isSerial(val(row, cc)) || dateLabel(s)) && isDayLabel(txt(row, cc + 1))) {   // the next set of day columns
          const next = dayRow(row, body, cc);
          if (next) { d.more.push(next, ...next.more); next.more = []; }
          break;
        }
        if (/^\*/.test(s)) { d.notes.push(s); continue; }   // "*Free entry day*": a note on the day, not a person
        if (x.fill && x.fill !== key.trainee) {
          const sf = key.statusOf(x.fill);
          out.slotFills.push({ cell: ref(row, cc), fill: x.fill, keyLabel: sf.label || null, open: isOpen(s) });
          if (sf.unknown && !sf.label) out.unknownFills.push({ cell: ref(row, cc), fill: x.fill, keyLabel: null, what: 'shift cell' });
        }
        if (isOpen(s)) { d.slots.push({ rep: '', ft: [] }); continue; }
        if (NOT_A_PERSON.test(s)) { d.slots.push({ rep: '__X__', ft: [], note: s }); continue; }
        const nm = s.replace(/\s+/g, ' ');
        if (x.fill && x.fill === key.trainee) {    // a field trainee rides with the rep beside them (board `ft`)
          const lead = [...d.slots].reverse().find(sl => sl.rep && sl.rep !== '__X__');
          if (lead) lead.ft.push(nm); else pendingFt.push(nm);
          continue;
        }
        const slot = { rep: nm, ft: pendingFt.splice(0) };
        if (x.strike) slot.struck = true;
        d.slots.push(slot);
      }
      if (pendingFt.length) d.slots.push({ rep: '', ft: pendingFt });   // a trainee with no rep that day: helper-only, never a staffed shift
      return d;
    };
    const setCost = (a, right) => {
      const A = str(a);
      ev.costText = typeof a === 'number' ? String(a) : A;
      const m = A.match(/^\$?\s*([\d,]+(?:\.\d+)?)\s*(?:\((.*)\)\s*)?$/);   // "$100 (Chargeback to a rep)", "58 (paid at event)"
      if (typeof a === 'number' || m) {
        ev.costNum = Math.round(typeof a === 'number' ? a : Number(m[1].replace(/,/g, '')));
        ev.cost = `$${ev.costNum.toLocaleString('en-US')}`;
        if (m && m[2]) ev.costNote = m[2].trim();
      } else if (/^free\b/i.test(A)) { ev.costNum = 0; ev.cost = 'FREE'; }
      else if (/^[\s$?]*$/.test(A)) flags.costUnknown = true;   // "$", "$?", "?$"
      else ev.cost = A;                             // "$30 per day (pay at event)", "$35 (indoor) $25 (outdoor)": kept as written
      if (right) ev.boothNote = right;
    };

    let rr = r + 1;
    let range = null;
    if (rr <= end && !dayRow(rr)) {               // the dates, right under the name
      const dv = val(rr, c);
      if (isSerial(dv)) {
        const d = serialToDate(dv, date1904); ev.datesText = iso(d);
        if (isStaleDate(d)) staleCells.push(cellRef(rr, c)); else range = { start: d, end: d };
      } else {
        ev.datesText = str(dv);
        range = parseDatesText(dv, near);
        if (!range) {                              // "TENTATIVE DATES - Mar 3-19": the dates inside the words
          const inner = ev.datesText.match(/\b([A-Za-z]{3,9})\.?\s*\d{1,2}(?:st|nd|rd|th)?\s*(?:[-–&]|to\b|thru\b)\s*(?:[A-Za-z]{3,9}\.?\s*)?\d{1,2}\b/);
          if (inner && monthIdx(inner[1]) >= 0) range = parseDatesText(inner[0], near);
        }
        if (/tentative|\?/i.test(ev.datesText) && range) flags.datesTentative = true;
        if (NOT_HAPPENING.test(ev.datesText)) flags.notHappening = true;
      }
      rr++;
    }
    // then city, cost, best ever, in that order, each optional; a day row or a booth row ends them
    let phase = 'head', booth = null;
    const notes = [];
    const newBooth = label => { booth = { label: label || '', status: '', days: [], dates: [], rows: [], more: [] }; ev.booths.push(booth); return booth; };
    const rowTexts = row => { const t = []; for (let cc = c; cc <= bound; cc++) { const s = txt(row, cc); if (s) t.push(s); } return t; };
    for (; rr <= end; rr++) {
      const a = val(rr, c), A = str(a), B = c + 1 <= bound ? txt(rr, c + 1) : '';
      if (!rowTexts(rr).length) continue;
      const day = dayRow(rr, phase === 'body');
      if (day) {
        phase = 'body'; if (!booth) newBooth(ev.boothText);
        booth.rows.push(day); booth.more.push(...day.more);
        for (const d of [day, ...day.more]) for (const n of d.notes) notes.push(`${d.label || cellRef(d.row, d.col)}: ${n}`);
        continue;
      }
      if (/^booth\b/i.test(A)) { phase = 'body'; newBooth(B && !isOpen(B) ? `${A} ${B}` : A); continue; }
      if (phase !== 'body') {
        if (BEST_EVER.test(A)) { ev.bestCPO = A; ev.bestEver = bestEverOf(A); phase = 'body'; continue; }
        if (phase !== 'head-cost' && (typeof a === 'number' || COSTISH(A))) { setCost(a, B); phase = 'head-cost'; continue; }
        if (phase === 'head' && A) {
          ev.cityState = A.replace(/\s+/g, ' ');
          for (let cc = c + 1; cc <= bound; cc++) {     // "Booth #12" beside the city (one or two columns over), often linked to a floor plan
            const s2 = txt(rr, cc), x = at(rr, cc);
            if (s2 && /booth/i.test(s2) && !ev.boothText) { ev.boothText = s2; if (x.link) ev.boothLink = x.link; }
            else if (s2) notes.push(s2);
          }
          phase = 'head-city'; continue;
        }
        if (phase === 'head-city' && A) { setCost(a, B); phase = 'head-cost'; continue; }
        phase = 'body';
      }
      // a coloured cell, or a name with a date under it, inside the notes may be an event no rule saw start: say so
      const x0 = at(rr, c) || {}, fillSays = x0.fill ? key.statusOf(x0.fill) : null;
      if (A && !NOTE_HEAD.test(A) && !/^\*/.test(A) && !PRIORITY.test(A) && ((fillSays && (fillSays.status || fillSays.unknown) && x0.fill !== key.trainee) || (rr + 1 <= end && datey(val(rr + 1, c)) && !dayRow(rr + 1, true))))
        out.suspects.push({ cell: ref(rr, c), inside: ref(r, c), why: fillSays ? `coloured ${x0.fill}` : 'a date under it' });
      notes.push(rowTexts(rr).join(' | '));        // notes, and anything else inside the block
    }

    // notes: what they flag, and who has priority
    for (const line of notes) {
      if (NOTE_HEAD.test(line) && line.replace(NOTE_HEAD, '').replace(/must\s*read|[()|:\s]/gi, '') === '') continue;
      const kind = (line.match(/\((found|growth|manages?|managed)\)/i) || [])[1];
      if (/\bpri[a-z]{0,4}ty\b/i.test(line) && kind) {
        const who = line.replace(/^\W*pri[a-z]{0,4}ty\s*/i, '').replace(/\((found|growth|manages?|managed)\)/i, '').replace(/\(?\b20\d\d\b\)?\s*[-:]?/g, '')
          .replace(/^[\s:-]+/, '').replace(/[*|]+/g, ' ').replace(/\s+/g, ' ').trim();
        ev.priority.push({ who, kind: /^manage/i.test(kind) ? 'manages' : kind.toLowerCase() });
      }
      if (/show\s*full/i.test(line)) flags.showFull = true;
      if (/wait\s*-?\s*list/i.test(line)) flags.waitlist = true;
      if (/application\s*(is\s*)?closed/i.test(line)) flags.applicationClosed = true;
      if (/application\s*(is\s*)?(available|opens?)/i.test(line)) flags.applicationNote = line.replace(/^[\s*]+|[\s*]+$/g, '');
      if (/promoter\s*declined/i.test(line)) flags.promoterDeclined = true;
      ev.notes += (ev.notes ? '\n' : '') + line;
    }

    // booths -> the board's booths: days, dates, shifts of slots (shift k = the k-th person written on each day)
    // A date serial in the book's year (or inside its own week) is believed, even when its weekday is not the label's (that
    // is listed: `labelOff`). A serial from another year is a stale copy, and so is a year-less "02/11" whose weekday is
    // not the label's in this year; either way the day is then placed by its label inside the week (Tuesday to Monday).
    let derived = false; const labelOff = [];
    for (const b of ev.booths) {
      let prev = null;
      b.rows.push(...b.more); delete b.more;      // a second set of day columns follows the first
      for (const d of b.rows) {
        let date = null;
        const wd = weekdayOfLabel(d.label), dl = dateLabel(d.label) || dateLabel(d.hint);
        const serial = d.serial !== null ? serialToDate(d.serial, date1904) : null;
        const hinted = dl ? (dl.y ? utc(dl.y, dl.mo, dl.day) : (parseDatesText(`${dl.mo + 1}/${dl.day}`, near) || {}).start || null) : null;
        const fits = x => !!x && !isStaleDate(x) && (wd === null || x.getUTCDay() === wd);
        if ((serial && isStaleDate(serial)) || (!serial && hinted && !fits(hinted))) staleCells.push(cellRef(d.row, d.col));
        if (serial && !isStaleDate(serial)) { date = serial; if (!fits(serial)) labelOff.push(cellRef(d.row, d.col)); }
        else if (fits(hinted)) date = hinted;
        else if (wd !== null) {                    // the weekday inside the week (Tuesday to Monday), or the next one after the day above
          date = prev ? addDays(prev, 1) : (week ? week.start : null);
          if (date) { while (date.getUTCDay() !== wd) date = addDays(date, 1); derived = true; }
        }
        if (date) prev = date;
        let label = d.label || (date ? WEEKDAY_SHORT[date.getUTCDay()] : serial ? `${serial.getUTCMonth() + 1}/${serial.getUTCDate()}` : '');
        if (d.half && !isHalf(label)) label += ' (1/2 Shift)';   // "02/11 (1/2 shift)" beside "Wed": the board keeps the half on the day
        b.days.push(label); b.dates.push(iso(date));
      }
      const width = Math.max(0, ...b.rows.map(d => d.slots.length));
      b.shifts = Array.from({ length: width }, (_, k) => ({ label: `Shift ${k + 1}`, slots: b.rows.map(d => d.slots[k] || { rep: '__X__', ft: [] }) }));
      b.halfDays = b.rows.map(d => !!d.half);
      delete b.rows;
    }
    const allDates = ev.booths.flatMap(b => b.dates).filter(Boolean).sort();
    if (range) { ev.startDate = iso(range.start); ev.endDate = iso(range.end); }
    else if (allDates.length) { ev.startDate = allDates[0]; ev.endDate = allDates[allDates.length - 1]; if (derived) ev.datesEstimated = true; }
    if (range && allDates.some(d => d < iso(addDays(range.start, -1)) || d > iso(addDays(range.end, 1)))) flags.datesDisagree = true;
    if (staleCells.length) { ev.datesStale = true; ev.staleCells = staleCells; }
    if (labelOff.length) { flags.dayLabelOff = true; ev.labelOffCells = labelOff; }
    if (!ev.booths.length && !/^(tbd|tba)\b/i.test(ev.datesText) && !flags.notHappening) flags.noDays = true;
    for (const k of ['flags', 'priority', 'comments']) if (Array.isArray(ev[k]) ? !ev[k].length : !Object.keys(ev[k]).length) delete ev[k];
    for (const k of ['group', 'boothText', 'costNote', 'boothNote']) if (!ev[k]) delete ev[k];
    return ev;
  }
}

// ---------- a whole workbook ------------------------------------------------------------------------
/** Month tabs only ("January" ... "December"); anything else (TEMPLATE, Service Events, a mall tab) is listed as skipped. */
export const tabMonthOf = name => MONTH_NAMES.findIndex(m => m.toLowerCase() === str(name).toLowerCase());

export function parseWorkbook(wb, { year, division, file = '', tab = null, nicknames = null }) {
  const res = { events: [], inventory: [], skippedTabs: [], unparsed: [], suspects: [], unknownFills: [], slotFills: [], warnings: [], keys: {}, mall: 0 };
  for (const name of wb.sheetNames) {
    if (tab && name !== tab) continue;
    const mi = tabMonthOf(name);
    if (mi < 0) { res.skippedTabs.push(name); continue; }
    const t = parseMonthTab(wb.sheet(name), { year, division, tabMonth: mi, date1904: !!wb.date1904, file });
    res.events.push(...t.events); res.inventory.push(...t.inventory); res.unparsed.push(...t.unparsed); res.suspects.push(...t.suspects);
    res.unknownFills.push(...t.unknownFills); res.slotFills.push(...t.slotFills); res.warnings.push(...t.warnings);
    res.keys[name] = t.key; res.mall += t.skipped.mall;
  }
  if (tab && !wb.sheetNames.includes(tab)) throw new Error(`no tab "${tab}". Tabs: ${wb.sheetNames.join(', ')}`);

  // ids: <division>-<year>-<name>-<MMDD of the weekend>, unique within the import
  const seen = new Map(), byShow = new Map();
  for (const e of res.events) {
    const base = `${division}-${year}-${slug(e.name) || 'event'}-${e.weekend ? e.weekend.slice(5).replace('-', '') : 'noweek'}`;
    const n = (seen.get(base) || 0) + 1; seen.set(base, n);
    e.id = n === 1 ? base : `${base}-${n}`;
    const k = `${slug(e.name)}|${e.weekend}|${e.startDate}`;
    if (byShow.has(k)) e.duplicateOf = byShow.get(k); else byShow.set(k, e.id);
  }

  // the names written in shift cells, and the nickname table
  const names = new Map();
  const nick = nicknames ? new Map(Object.entries(nicknames).map(([k, v]) => [normName(k), String(v)])) : null;
  const unmapped = new Map();
  for (const e of res.events) for (const b of e.booths) for (const s of b.shifts) for (const sl of s.slots) {
    for (const who of [sl.rep, ...(sl.ft || [])]) if (who && who !== '__X__' && !names.has(normName(who) || who)) names.set(normName(who) || who, who);
    if (!nick) continue;
    if (sl.rep && sl.rep !== '__X__') { const to = nick.get(normName(sl.rep)); if (to) { if (to !== sl.rep) { sl.asWritten = sl.rep; sl.rep = to; } } else unmapped.set(normName(sl.rep), sl.rep); }
    sl.ft = (sl.ft || []).map(f => { const to = nick.get(normName(f)); if (!to) unmapped.set(normName(f), f); return to || f; });
  }
  res.slotNames = [...names.values()].sort((a, b) => a.localeCompare(b));
  if (nick) res.unmappedNames = [...unmapped.values()].sort((a, b) => a.localeCompare(b));
  res.report = report(res);
  return res;
}

/** The counts. No names, no costs: what the report prints and a caller can quote. */
export function report(res) {
  const cnt = (m, k) => { m[k] = (m[k] || 0) + 1; };
  const r = { events: res.events.length, bySection: {}, byStatus: {}, bySectionStatus: {}, byKeyLabel: {}, booths: 0, multiBoothEvents: 0,
    days: 0, halfShiftDays: 0, slots: { staffed: 0, open: 0, noShift: 0, helperOnly: 0 }, fieldTrainees: 0, struck: 0,
    staleDates: { events: 0, cells: 0 }, datesEstimated: 0, datesDisagree: 0, dayLabelOff: 0, noDays: 0, notHappening: 0, tbdDates: 0, costUnknown: 0, costText: 0,
    duplicates: 0, mallBlocksSkipped: res.mall, skippedTabs: res.skippedTabs,
    inventory: { personalBooths: 0, teamBooths: 0, inUseMarks: 0 },
    unparsedBlocks: res.unparsed.length, suspectsInNotes: res.suspects.length, unknownFills: {}, slotFills: {}, distinctSlotNames: (res.slotNames || []).length, warnings: res.warnings.length };
  for (const e of res.events) {
    cnt(r.bySection, e.section); cnt(r.byStatus, e.status || '(unknown fill)'); cnt(r.byKeyLabel, e.sheetStatus);
    r.bySectionStatus[e.section] = r.bySectionStatus[e.section] || {}; cnt(r.bySectionStatus[e.section], e.status || '(unknown fill)');
    r.booths += e.booths.length; if (e.booths.length > 1) r.multiBoothEvents++;
    if (e.datesStale) { r.staleDates.events++; r.staleDates.cells += (e.staleCells || []).length; }
    if (e.datesEstimated) r.datesEstimated++;
    const f = e.flags || {};
    if (f.datesDisagree) r.datesDisagree++; if (f.dayLabelOff) r.dayLabelOff++; if (f.noDays) r.noDays++; if (f.notHappening) r.notHappening++; if (f.costUnknown) r.costUnknown++;
    if (/^(tbd|tba)\b/i.test(e.datesText)) r.tbdDates++;
    if (e.cost && e.costNum === null) r.costText++;
    if (e.duplicateOf) r.duplicates++;
    for (const b of e.booths) {
      r.days += b.days.length; r.halfShiftDays += (b.halfDays || []).filter(Boolean).length;
      for (const s of b.shifts) s.slots.forEach(sl => {
        if (sl.rep === '__X__') { if (sl.note) r.slots.noShift++; }
        else if (sl.rep) r.slots.staffed++;
        else if ((sl.ft || []).length) r.slots.helperOnly++;
        else r.slots.open++;
        r.fieldTrainees += (sl.ft || []).length; if (sl.struck) r.struck++;
      });
    }
  }
  const personal = new Set(), team = new Set();
  for (const w of res.inventory) {
    for (const p of w.personal) { personal.add(p.name.toLowerCase()); if (p.inUse) r.inventory.inUseMarks++; }
    for (const t of w.team) { team.add(t.name.toLowerCase()); if (t.inUse) r.inventory.inUseMarks++; }
  }
  r.inventory.personalBooths = personal.size; r.inventory.teamBooths = team.size;
  for (const u of res.unknownFills) { const k = `${u.fill} on ${u.what}${u.keyLabel ? ` (key: ${u.keyLabel})` : ''}`; cnt(r.unknownFills, k); }
  for (const s of res.slotFills) cnt(r.slotFills, `${s.keyLabel || s.fill}${s.open ? ' (open slot)' : ''}`);
  return r;
}

// ---------- the out file: never inside this repo (it is public), never inside any git work tree ----------
export function outRefusal(file, repo = REPO) {
  const abs = path.resolve(file);
  let dir = path.dirname(abs);
  while (!fs.existsSync(dir)) dir = path.dirname(dir);
  const real = fs.realpathSync(dir), repoReal = fs.realpathSync(repo);
  if (real === repoReal || real.startsWith(repoReal + path.sep)) return `${abs} is inside this repo, which is public; write it to a scratch folder outside any repo`;
  try {
    const top = execFileSync('git', ['-C', real, 'rev-parse', '--show-toplevel'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    if (top) return `${abs} is inside the git work tree ${top}; a coordinator's events must not sit where a commit can pick them up`;
  } catch { /* not in a work tree: fine */ }
  return null;
}

// ---------- CLI ----------------------------------------------------------------------------------------
function printReport(res, { division, year, file, out }) {
  const r = res.report, L = [];
  const kv = o => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ') || 'none';
  L.push(`import-workbook: ${path.basename(file)} as ${division} ${year}`);
  L.push(`  events ${r.events} (by section: ${kv(r.bySection)})`);
  for (const [s, m] of Object.entries(r.bySectionStatus)) L.push(`    ${s.padEnd(8)} ${kv(m)}`);
  L.push(`  colour key labels on names: ${kv(r.byKeyLabel)}`);
  L.push(`  booths ${r.booths} (${r.multiBoothEvents} events with more than one); booth inventory: ${r.inventory.personalBooths} personal, ${r.inventory.teamBooths} team, ${r.inventory.inUseMarks} in-use marks`);
  L.push(`  day rows ${r.days}, half-shift days ${r.halfShiftDays}; slots: ${r.slots.staffed} staffed, ${r.slots.open} open, ${r.slots.noShift} no-shift notes, ${r.slots.helperOnly} trainee-only; field trainees ${r.fieldTrainees}; struck through ${r.struck}`);
  L.push(`  dates: ${r.staleDates.events} events with stale dates (${r.staleDates.cells} cells), ${r.datesEstimated} placed from the week alone (est.), ${r.datesDisagree} where the dates cell and the day rows disagree, ${r.dayLabelOff} whose day labels name another weekday than their date cells, ${r.tbdDates} TBD, ${r.notHappening} not happening, ${r.noDays} with no day rows`);
  L.push(`  costs: ${r.costUnknown} unknown ("$", "$?"), ${r.costText} kept as text`);
  L.push(`  skipped: ${r.mallBlocksSkipped} weekly mall lease blocks; tabs ${r.skippedTabs.join(', ') || 'none'}${r.duplicates ? `; ${r.duplicates} events written twice for the same week and day (duplicateOf)` : ''}`);
  L.push(`  unparsed blocks ${r.unparsedBlocks}${res.unparsed.length ? ':' : ''}`);
  for (const u of res.unparsed) L.push(`    ${u.tab}!${u.range} (${u.cells} cell${u.cells > 1 ? 's' : ''}) "${u.first}"`);
  L.push(`  cells inside an event's notes that look like an event of their own ${res.suspects.length}${res.suspects.length ? ':' : ''}`);
  for (const u of res.suspects) L.push(`    ${u.cell} (inside ${u.inside}): ${u.why}`);
  L.push(`  unknown fills ${res.unknownFills.length}${res.unknownFills.length ? ': ' + kv(r.unknownFills) : ''}`);
  if (res.unknownFills.length) L.push(`    first cells: ${res.unknownFills.slice(0, 12).map(u => u.cell).join(', ')}`);
  L.push(`  fills on shift cells: ${kv(r.slotFills)}`);
  L.push(`  warnings ${res.warnings.length}${res.warnings.length ? ':' : ''}`);
  for (const w of res.warnings.slice(0, 40)) L.push(`    ${w}`);
  L.push(`  distinct names in shift cells ${r.distinctSlotNames}: ${res.slotNames.join(', ')}`);
  if (res.unmappedNames) L.push(`  not in the nickname table ${res.unmappedNames.length}: ${res.unmappedNames.join(', ')}`);
  L.push(out ? `  written to ${out} (mode 600)` : '  no --out: nothing written');
  console.log(L.join('\n'));
}

function main() {
  const args = process.argv.slice(2), flags = {}, pos = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) { const k = a.slice(2); flags[k] = (args[i + 1] !== undefined && !args[i + 1].startsWith('--')) ? args[++i] : true; }
    else pos.push(a);
  }
  const die = (m, code = 1) => { console.error('import-workbook: ' + m); process.exit(code); };
  if (!pos[0] || flags.help) {
    const src = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
    console.error(src.slice(src.indexOf('/*') + 2, src.indexOf('*/')).trim());
    process.exit(1);
  }
  const division = String(flags.division || ''), year = Number(flags.year);
  if (!/^[a-z][a-z0-9-]{0,23}$/.test(division)) die('--division <id> is required: lower case letters, digits and dashes (e.g. abc)');
  if (/^(rising-sun|rsd)$/.test(division)) die(`--division ${division} is Rising Sun's; its board is fed by the Sheet sync, never by a workbook import`);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) die('--year <yyyy> is required');
  if (!fs.existsSync(pos[0])) die(`no such file: ${pos[0]}`);
  const out = flags.out && flags.out !== true ? String(flags.out) : null;
  if (flags.out === true) die('--out needs a file path');
  if (out) { const why = outRefusal(out); if (why) die(`refused: ${why}`); }
  let nicknames = null;
  if (flags.nicknames) {
    try { nicknames = JSON.parse(fs.readFileSync(String(flags.nicknames), 'utf8')); } catch (e) { die(`--nicknames: cannot read ${flags.nicknames} as JSON: ${e.message}`); }
    if (!nicknames || typeof nicknames !== 'object' || Array.isArray(nicknames)) die('--nicknames: the file must hold one JSON object { "<name as written>": "<rep name>" }');
  }
  let wb;
  try { wb = openWorkbook(fs.readFileSync(pos[0])); } catch (e) { die(e.message); }
  let res;
  try { res = parseWorkbook(wb, { year, division, file: path.basename(pos[0]), tab: flags.tab && flags.tab !== true ? String(flags.tab) : null, nicknames }); }
  catch (e) { die(e.message); }
  if (out) {
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    const doc = { meta: { division, year, file: path.basename(pos[0]), importedAt: new Date().toISOString(), tool: 'rsd-show-shift-board scripts/import-workbook.mjs', keys: res.keys },
      report: res.report, events: res.events, inventory: res.inventory, unparsed: res.unparsed, suspects: res.suspects, unknownFills: res.unknownFills, warnings: res.warnings,
      slotNames: res.slotNames, ...(res.unmappedNames ? { unmappedNames: res.unmappedNames } : {}) };
    fs.writeFileSync(out, JSON.stringify(doc, null, 1) + '\n', { mode: 0o600 });
    fs.chmodSync(out, 0o600);
  }
  printReport(res, { division, year, file: pos[0], out });
  if (flags.strict && (res.unparsed.length || res.suspects.length || res.unknownFills.length)) die(`--strict: ${res.unparsed.length} unparsed block(s), ${res.suspects.length} suspect cell(s), ${res.unknownFills.length} unknown fill(s)`, 2);
}

/** An in-memory sheet for tests: rows of values, or { v, fill, link, comment, strike } per cell. */
export function gridSheet(name, rows, merges = []) {
  const cells = new Map(); let cols = 0;
  rows.forEach((row, r) => (row || []).forEach((x, c) => {
    if (x === null || x === undefined || x === '') return;
    const cell = typeof x === 'object' ? { v: x.v ?? '', fill: x.fill || null, link: x.link || null, comment: x.comment || null, strike: !!x.strike } : { v: x, fill: null, link: null, comment: null, strike: false };
    cells.set(r * 16384 + c, cell); cols = Math.max(cols, c + 1);
  }));
  return { name, rows: rows.length, cols, merges, get: (r, c) => cells.get(r * 16384 + c) };
}

if (isMain(import.meta.url)) main();
