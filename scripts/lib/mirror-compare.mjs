// The mirror's exit test (stage 3, docs/stage-3-january.md "The parallel run"): not "the copy matches the Sheet cell for
// cell" (the team's Sheet has spills and stale cells the mirror must not copy) but "each reader reads the mirror the way it
// reads the real Sheet". This file lines the two up; scripts/sheet-mirror.mjs feeds it. Pure.
import { parseAll, repKey } from '../parse-sheet.mjs';

const pad = n => String(n).padStart(2, '0');
/** "Weekend 1/15", "weekend 01-15" -> the Friday it names, in the book's season (a header from `seasonStartMonth` on is
 *  `seasonYear`, earlier months the year after: the same rule parse-sheet.mjs uses). */
export function bannerFriday(cell, { seasonYear = 2026, seasonStartMonth = 8 } = {}) {
  const m = String(cell || '').match(/^\s*weekend\s+(\d{1,2})\s*[-\/]\s*(\d{1,2})/i); if (!m) return null;
  const mo = +m[1], day = +m[2], y = mo >= seasonStartMonth ? seasonYear : seasonYear + 1;
  const d = new Date(Date.UTC(y, mo - 1, day)); const back = (d.getUTCDay() + 2) % 7;   // the Friday on or before it
  const f = new Date(d.getTime() - back * 86400000); return `${f.getUTCFullYear()}-${pad(f.getUTCMonth() + 1)}-${pad(f.getUTCDate())}`;
}
/** The row (0-based) of the first weekend banner on or after `from`: where the mirror's rows begin. -1 = none. */
export function ownedStart(values, book, from) {
  for (let i = 0; i < (values || []).length; i++) {
    const cell = (values[i] || []).slice(0, 8).find(c => /^\s*weekend\b/i.test(String(c || '')));
    const f = cell && bannerFriday(cell, book);
    if (f && f >= from) return i;
  }
  return -1;
}
/** The tab as the mirror would leave it: the team's rows above `start`, the rendered rows from it to the end. */
export function composeTab(real, rendered, start) {
  return { values: [...real.values.slice(0, start), ...rendered.rows], fontColors: [...(real.fontColors || []).slice(0, start), ...rendered.colors] };
}

const norm = s => String(s || '').toLowerCase().replace(/\(?\b([ab])\s*row\)?/g, '$1 row').replace(/[^a-z0-9]+/g, ' ').trim();
const STOP = new Set(['show', 'booth', 'event', 'fair', 'the', 'and', 'with', 'into', 'spring', 'fall', 'winter', 'annual', 'festival', 'street',
  'fine', 'arts', 'wine', 'market', 'home', 'garden', 'craft', 'crafts', 'vendor', 'county', 'days', 'park']);
/** The words that name a show (picking-order's own rule, lib/schedule.js sharesEventToken): parentheses, booth numbers and
 *  filler left out, so "Maricopa County Home & Garden Show\n(South Entrance Tent)" and "Maricopa Booth #2 (Ag Building)" are
 *  the same show as the board's "Maricopa County Home & Garden Show". */
export const showWords = name => new Set(norm(String(name || '').replace(/\([^)]*\)/g, ' ').replace(/\bbooth\s*#?\s*\d+/gi, ' ')).split(' ').filter(w => w.length > 3 && !STOP.has(w)));
export const sameShow = (a, b) => { const A = showWords(a), B = showWords(b); for (const w of A) if (B.has(w)) return true; return norm(a) === norm(b); };
const plusDays = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const FIELDS = ['dead', 'tentative', 'scheduledType', 'nonSelling'];
/** The picking order's shifts (lib/schedule.js parseSchedule) from the real tab and from the mirror, on the owned weekends
 *  (Friday `from` to the Thursday after `to`). A shift is a rep on a day at a show; the two sides are paired by rep and day,
 *  then by show (`sameShow`). `explain(kind, real, mirror)` says why a difference is there (the command line knows the board). */
export function comparePicking(realShifts, mirrorShifts, { from, to, explain = () => null }) {
  const last = plusDays(to, 6), inRange = s => s.date && s.date >= from && s.date <= last;
  const who = s => s.repId || norm(s.repName);
  const group = list => { const m = new Map(); for (const s of list.filter(inRange)) { const k = `${s.date}|${who(s)}`; (m.get(k) || m.set(k, []).get(k)).push(s); } return m; };
  const R = group(realShifts), M = group(mirrorShifts);
  const onlyReal = [], onlyMirror = [], changed = []; let same = 0, renamed = 0;
  const brief = s => ({ date: s.date, rep: s.repName || s.repId, event: String(s.event || '').replace(/\s+/g, ' ').trim(), status: s.status || '', ...Object.fromEntries(FIELDS.map(f => [f, s[f] ?? null])) });
  for (const k of new Set([...R.keys(), ...M.keys()])) {
    const rs = (R.get(k) || []).slice(), ms = (M.get(k) || []).slice();
    for (const r of rs.splice(0)) {
      const i = ms.findIndex(m => sameShow(r.event, m.event));
      if (i < 0) { onlyReal.push({ ...brief(r), why: explain('real', r) }); continue; }
      const m = ms.splice(i, 1)[0];
      if (norm(r.event) !== norm(m.event)) renamed++;
      const diff = FIELDS.filter(f => (r[f] ?? null) !== (m[f] ?? null));
      if (diff.length) changed.push({ ...brief(r), fields: Object.fromEntries(diff.map(f => [f, { real: r[f] ?? null, mirror: m[f] ?? null }])), why: explain('changed', r, m) }); else same++;
    }
    for (const m of ms) onlyMirror.push({ ...brief(m), why: explain('mirror', null, m) });
  }
  const byDate = (a, b) => a.date.localeCompare(b.date) || String(a.event).localeCompare(String(b.event)) || String(a.rep).localeCompare(String(b.rep));
  return { same, renamed, onlyReal: onlyReal.sort(byDate), onlyMirror: onlyMirror.sort(byDate), changed: changed.sort(byDate) };
}

/** The board's own parser on the rendered rows, against the board: what a round trip board -> Sheet -> parse loses. */
export function compareBoard(boardEvents, rendered, { from, to, seasonYear = 2026, resolve }) {
  const grid = [new Array(27).fill(''), ...rendered.rows];          // row 1 is the header row the parser skips
  const parsed = parseAll(grid, { seasonYear, dateLabels: 'keep', repairs: false }).events;
  const k = (name, weekend) => `${norm(name)}|${weekend}`;
  const P = new Map(parsed.map(e => [k(e.name, e.weekend), e]));
  const out = [];
  const slotKey = sl => `${repKey(sl && sl.rep, resolve)}|${((sl && sl.ft) || []).map(x => repKey(x, resolve)).sort().join(',')}`;
  for (const b of boardEvents.filter(e => e.weekend && e.weekend >= from && e.weekend <= to)) {
    const p = P.get(k(b.name, b.weekend));
    if (!p) { out.push(`${b.name} (${b.weekend}): not read back at all`); continue; }
    const say = what => out.push(`${b.name} (${b.weekend}): ${what}`);
    for (const f of ['startDate', 'endDate', 'cityState', 'location', 'vcNumber']) if (String(b[f] || '') !== String(p[f] || '')) say(`${f} ${JSON.stringify(b[f] || '')} read back as ${JSON.stringify(p[f] || '')}`);
    if (String(b.status || '') !== String(p.sheetStatus || '')) say(`status ${JSON.stringify(b.status || '')} read back as ${JSON.stringify(p.sheetStatus || '')}`);
    const bb = b.booths || [], pb = p.booths || [];
    if (bb.length !== pb.length && !(bb.length === 0 && pb.length === 0)) { say(`${bb.length} booth(s) read back as ${pb.length}`); continue; }
    bb.forEach((x, i) => {
      const y = pb[i] || {};
      if ((x.days || []).length && JSON.stringify(x.days || []) !== JSON.stringify(y.days || [])) say(`booth ${i + 1} days ${(x.days || []).join(',')} read back as ${(y.days || []).join(',')}`);
      if ((x.shifts || []).length !== (y.shifts || []).length) { say(`booth ${i + 1}: ${(x.shifts || []).length} shift row(s) read back as ${(y.shifts || []).length}`); return; }
      (x.shifts || []).forEach((s, j) => (s.slots || []).forEach((sl, d) => {
        const ys = ((y.shifts[j] || {}).slots || [])[d];
        if (slotKey(sl) !== slotKey(ys)) say(`booth ${i + 1} ${s.label || 'shift ' + (j + 1)} day ${d + 1}: ${JSON.stringify(sl && sl.rep || '')} read back as ${JSON.stringify(ys && ys.rep || '')}`);
      }));
    });
  }
  return out;
}
