// The board -> Sheet mirror's layout (stage 3, docs/stage-3-january.md "The mirror"; Alan 2026-10-27: the January 13, 2027
// meeting is the first one run on the board, and a script writes the Sheet from the board so everything that still reads
// the Sheet keeps working). Pure: board shows in, a grid out. Nothing here talks to Google or the board.
//
// The grammar is the Sheet's own, written the same way every time, in the one form every reader accepts (checked against
// parse-sheet.mjs, rsd-shift-picking lib/schedule.js, rsd-event-analyzer, count-mesa-shifts and show-shift-calendar-sync):
//   - a banner for every weekend, "Weekend 01/15" in column B (two-digit month, slash);
//   - per show an event row: A flag ("MF"), B "Elite" or the level, C the board's status, D Best CPO, E the name, F-L the
//     day labels as weekday text, M cost, N/O Start/End, P city, Q venue, S-W promoter and contact, Z/AA VC status/number;
//   - a "Booth #N ..." row before each booth when a show has more than one (or a named one); picking-order and the
//     analyzer count the shifts under it for the show above, as they do the team's "Maricopa Booth #2 (...)" rows;
//   - a "Shift N" row per shift row, names under their days: "Name (ft. Helper & Helper)", "X" for no shift.
//   - Mesa Market Place is two shows a weekend on the Sheet ("... A Row", "... B Row"), one show with two booths on the
//     board: written back as the two rows.
//   - fonts: every cell of a show's block in its tier's color (title and names alike, as the team colors them: black
//     Traditional, teal Key, purple Elite, which the picking order reads as Key and the analyzer as Elite); a name marked
//     "didn't work" (`notWorked`) red. Nothing reads backgrounds; none are written.
// Dates are ISO here (the Picking Feed's form, what the parsers are tested with); the writer turns them into dates.
export const WIDTH = 27;                                         // A..AA
export const COL = { FLAG: 0, LEVEL: 1, STATUS: 2, BESTCPO: 3, DESC: 4, DAY0: 5, DAY9: 11, COST: 12, START: 13, END: 14,
  CITY: 15, LOC: 16, PROMOTER: 18, CONTACT: 19, PHONE: 20, EMAIL: 21, WEBSITE: 22, VCSTATUS: 25, VCNUM: 26 };
export const TIER_COLOR = { Traditional: '#000000', Key: '#46bdc6', Elite: '#9900ff' };
export const NOT_WORKED = '#ff0000';
const BLACK = '#000000';
const MESA = /mesa\s*market\s*place|swap\s*meet|swapmeet/i;
const looksBooth = d => /^booth\s*#?\s*\d/i.test(String(d || ''));
const looksShift = d => /^shift\s*\d/i.test(String(d || ''));
const t = v => (v === null || v === undefined) ? '' : String(v).trim();

const fromISO = s => { const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})$/); return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null; };
const isoOf = d => d.toISOString().slice(0, 10);
/** Every Friday from the one on or after `from` through `to` (ISO). */
export function fridays(from, to) {
  const out = []; let d = fromISO(from); if (!d || !fromISO(to)) return out;
  while (d.getUTCDay() !== 5) d = new Date(d.getTime() + 86400000);
  for (; isoOf(d) <= to; d = new Date(d.getTime() + 7 * 86400000)) out.push(isoOf(d));
  return out;
}
export const bannerText = friday => `Weekend ${friday.slice(5, 7)}/${friday.slice(8, 10)}`;

/** One slot as the team writes it. */
export function slotText(sl) {
  const rep = t(sl && sl.rep), ft = ((sl && sl.ft) || []).map(t).filter(Boolean);
  if (rep === '__X__') return 'X';
  const helpers = ft.length ? `(ft. ${ft.join(' & ')})` : '';
  return rep ? (helpers ? `${rep} ${helpers}` : rep) : helpers;
}
const level = e => (e.tier === 'Elite' ? 'Elite' : t(e.level));
const cost = e => (Number.isFinite(e.costNum) ? e.costNum : t(e.cost));

function eventRow(e, name, days) {
  const r = new Array(WIDTH).fill('');
  r[COL.FLAG] = e.flag === 'MF' ? 'MF' : ''; r[COL.LEVEL] = level(e); r[COL.STATUS] = t(e.status); r[COL.BESTCPO] = t(e.bestCPO);
  r[COL.DESC] = name; days.slice(0, COL.DAY9 - COL.DAY0 + 1).forEach((d, i) => { r[COL.DAY0 + i] = t(d); });
  r[COL.COST] = cost(e); r[COL.START] = t(e.startDate); r[COL.END] = t(e.endDate); r[COL.CITY] = t(e.cityState); r[COL.LOC] = t(e.location);
  r[COL.PROMOTER] = t(e.promoter); r[COL.CONTACT] = t(e.contact); r[COL.PHONE] = t(e.phone); r[COL.EMAIL] = t(e.email); r[COL.WEBSITE] = t(e.website);
  r[COL.VCSTATUS] = t(e.vcStatus); r[COL.VCNUM] = t(e.vcNumber);
  return r;
}

/**
 * The rows for the weekends `from`..`to` (ISO Fridays), from board shows (contacts merged in, as board-api events() gives).
 * -> { rows: string[][], colors: (string|null)[][], kinds: ('banner'|'event'|'booth'|'shift')[], shows: [{ id, name, row }],
 *      notes: string[] } (row = 0-based in `rows`)
 * `notes` names what the Sheet's grammar cannot hold exactly (a booth whose days differ from the show's, more than 7 days).
 */
export function renderWeekends(events, { from, to }) {
  const rows = [], colors = [], kinds = [], shows = [], notes = [];
  const push = (r, color, cellColor = () => color, kind = r[COL.DESC] && /^shift\b/i.test(r[COL.DESC]) ? 'shift' : r[COL.DESC] && looksBooth(r[COL.DESC]) && !r[COL.DAY0] ? 'booth' : r[COL.LEVEL] && /^weekend /i.test(r[COL.LEVEL]) && !r[COL.DESC] ? 'banner' : 'event') => {
    rows.push(r); colors.push(r.map((v, i) => (v === '' ? null : cellColor(i)))); kinds.push(kind); };
  const byWeekend = new Map();
  for (const e of events || []) if (e && e.weekend && e.weekend >= from && e.weekend <= to) (byWeekend.get(e.weekend) || byWeekend.set(e.weekend, []).get(e.weekend)).push(e);
  for (const fri of fridays(from, to)) {
    const banner = new Array(WIDTH).fill(''); banner[COL.LEVEL] = bannerText(fri); push(banner, BLACK);
    const list = (byWeekend.get(fri) || []).slice().sort((a, b) => (a.row || 1e9) - (b.row || 1e9) || t(a.name).localeCompare(t(b.name)) || t(a.id).localeCompare(t(b.id)));
    for (const e of list) {
      const color = TIER_COLOR[e.tier] || BLACK, booths = e.booths || [];
      const shiftRows = (b, days) => (b.shifts || []).forEach((s, k) => {
        const r = new Array(WIDTH).fill(''); r[COL.DESC] = looksShift(s.label) ? t(s.label) : `Shift ${k + 1}`;
        const marks = [], same = !(b.days || []).length || JSON.stringify(b.days || []) === JSON.stringify(days);   // no days of its own = the show's
        days.forEach((label, i) => {
          const di = same ? i : (b.days || []).indexOf(label);   // a booth with its own days: by day name, under the show's
          const sl = di >= 0 ? (s.slots || [])[di] : null; r[COL.DAY0 + i] = slotText(sl);
          marks[COL.DAY0 + i] = !!(sl && sl.notWorked && t(sl.rep) && t(sl.rep) !== '__X__');
        });
        push(r, color, c => (marks[c] ? NOT_WORKED : color));
      });
      shows.push({ id: e.id, name: e.name, row: rows.length });
      if (MESA.test(e.name) && booths.length) {           // one board show, two Sheet rows ("A Row", "B Row")
        booths.forEach((b, i) => {
          const m = String(b.label || '').match(/\b([AB])\s*row\b/i), lab = m ? `${m[1].toUpperCase()} Row` : (i ? 'B Row' : 'A Row');
          push(eventRow(e, `${t(e.name).replace(/\s*\(?\b[AB]\s*row\)?\s*$/i, '')} ${lab}`, b.days || e.days || []), color);
          shiftRows(b, b.days || e.days || []);
        });
        continue;
      }
      const days = (booths[0] && booths[0].days) || e.days || [];
      if (days.length > COL.DAY9 - COL.DAY0 + 1) notes.push(`${e.name} (${fri}): ${days.length} days, the Sheet has room for ${COL.DAY9 - COL.DAY0 + 1}`);
      push(eventRow(e, t(e.name), days), color);
      booths.forEach((b, i) => {
        if ((b.days || []).length && JSON.stringify(b.days || []) !== JSON.stringify(days)) notes.push(`${e.name} (${fri}): ${b.label || 'booth ' + (i + 1)} has its own days (${(b.days || []).join(', ')}); written under the show's (${days.join(', ')})`);
        if (booths.length > 1 || t(b.label)) {
          const r = new Array(WIDTH).fill(''); r[COL.DESC] = looksBooth(b.label) ? t(b.label) : `Booth #${i + 1}${t(b.label) ? ' ' + t(b.label) : ''}`; push(r, color);
        }
        shiftRows(b, days);
      });
    }
  }
  return { rows, colors, kinds, shows, notes };
}
