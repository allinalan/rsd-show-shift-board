/*
  Application dates and Submission Notes (Alan, 2026-10-26: "a section labeled Application Deadline so CUTCO knows when
  the application deadline is ... also a section called Application Opens ... if we manually override it from the
  research there should be a small comment on there so we know whether it's from the research agent or manual input").

  Each show carries
    applyOpens, applyBy            ISO dates ('' = not known). applyBy is the deadline (the field predates this).
    applyOpensSource, applyBySource   where the date came from, shown as a small tag under it:
        { kind: 'research', url, quote, checked }      a page states it for this edition (preflight, board-research.mjs)
        { kind: 'manual', by, at }                     a coordinator typed it (the board, or `board set`)
        { kind: 'rolled', from, fromYear }             last year's date moved a year on by a roll: an estimate (Alan,
                                                       2026-10-26: "dates should roll forward ... because it's a good
                                                       estimate"), replaced by research once this year's is posted
      A manual source can also carry found: { date, url, quote, checked }: research found a different date. The
      manual date is never changed by research; the board and the report show the disagreement.
    submissionNotes                what Cutco's events team reads in the Booking Request's Comments (at most 350
                                   characters, so the whole comment fits VC's 500). `notes` stays the team's own.

  Pure functions, no I/O. index.html keeps its own copy of the parts the page needs (rollAppDates, the tags): the
  tests hold the two together.
*/
import { addDaysIso } from './match.mjs';

export const APP_DATES = [['applyOpens', 'opens'], ['applyBy', 'deadline']];
export const SUBMISSION_MAX = 350;
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const KINDS = new Set(['research', 'manual', 'rolled']);
const t = v => String(v ?? '').replace(/\s+/g, ' ').trim();
export const srcKey = field => `${field}Source`;

/** Where a show's date came from. A date with no tag was typed in before tags existed: a person's, never overwritten. */
export function sourceOf(e, field) {
  if (!ISO.test(t(e && e[field]))) return null;
  const s = e[srcKey(field)];
  return s && typeof s === 'object' && KINDS.has(s.kind) ? s : { kind: 'manual' };
}

export const manualSource = (by, at) => ({ kind: 'manual', by: t(by), at });

/** The same day n years on (Feb 29 -> Feb 28). */
export function shiftYears(iso, n) {
  const y = +iso.slice(0, 4) + n, m = iso.slice(5, 7), d = +iso.slice(8, 10);
  const last = new Date(Date.UTC(y, +m, 0)).getUTCDate();
  return `${y}-${m}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

/**
 * A roll of a show from `fromYear` into Y: each application date comes along as last year's estimate. An estimate
 * nobody confirmed keeps the date and year it really came from, so it never drifts. Older than three years: dropped.
 */
export function rollAppDates(e, Y, fromYear) {
  const out = {};
  for (const [f] of APP_DATES) {
    const s = sourceOf(e, f);
    const from = s && s.kind === 'rolled' && ISO.test(t(s.from)) && +s.fromYear ? { date: s.from, year: +s.fromYear } : s ? { date: t(e[f]), year: +fromYear } : null;
    const n = from ? Y - from.year : 0;
    if (!from || n < 1 || n > 3) { out[f] = ''; out[srcKey(f)] = null; continue; }
    out[f] = shiftYears(from.date, n);
    out[srcKey(f)] = { kind: 'rolled', from: from.date, fromYear: from.year };
  }
  return out;
}

/**
 * How far before a show its own application dates can sit. Last year's date for the same show sits a year further
 * back, so a deadline more than 330 days or an opening more than 400 days before the show is last year's (or another
 * edition's) and is set aside, never carried as this year's.
 */
export const LEAD_DAYS = { deadline: 330, opens: 400 };

/**
 * The research's finding for one date, checked by code: an official page (the event's, promoter's or host city's),
 * an ISO date, the words that state it, and a date that fits THIS edition (before the show's last day, and within
 * LEAD_DAYS of its first; an opens date after the deadline is set aside). Returns { date, url, quote } or
 * { rejected: why } or null (no page states it).
 */
export function checkFinding(app, which, run, other) {
  if (!app || typeof app !== 'object') return null;
  const date = t(which === 'opens' ? app.opens : app.deadline), quote = t(which === 'opens' ? app.opensQuote : app.deadlineQuote).slice(0, 300);
  if (!date) return null;
  const url = t(app.sourceUrl);
  if (!ISO.test(date)) return { rejected: `"${date}" is not a date` };
  if (app.confidence !== 'official' || !/^https?:\/\//i.test(url)) return { rejected: 'not from the event\'s or promoter\'s own page' };
  if (!quote) return { rejected: 'no words from the page that state it' };
  if (!run || !ISO.test(t(run.start))) return { rejected: 'the board has no dates for this edition to check it against' };
  if (date > t(run.end || run.start) || date < addDaysIso(run.start, -LEAD_DAYS[which])) return { rejected: `${date} does not fit the edition on ${run.start} (last year's, or another edition's)` };
  if (which === 'opens' && other && ISO.test(other) && date > other) return { rejected: `opens ${date} is after the deadline ${other}` };
  return { date, url, quote };
}

/**
 * What research does to one application date. Pure.
 * @param finding  checkFinding()'s { date, url, quote }, or null when no page states it
 * @returns { kind, patch, ... }
 *   set        research filled or replaced it (blank, an estimate, or an earlier research value)
 *   confirmed  research found the same date again (its checked date moves)
 *   kept       a person's date, and research found another: not changed, flagged (patch adds `found` the first time)
 *   agrees     a person's date, and research found the same (a stale `found` flag is cleared)
 *   not-found  blank or still last year's estimate, and no page states it
 *   none       nothing to do
 */
export function decideAppDate(e, field, finding, { today, manualWins = true } = {}) {
  const cur = sourceOf(e, field), value = t(e[field]), sk = srcKey(field);
  if (!finding) return { kind: !cur || cur.kind === 'rolled' ? 'not-found' : 'none', estimate: !!cur && cur.kind === 'rolled', patch: {} };
  const found = { date: finding.date, url: finding.url, quote: finding.quote, checked: today };
  if (cur && cur.kind === 'manual' && manualWins) {
    if (value === finding.date) {
      if (!cur.found) return { kind: 'agrees', patch: {} };
      const { found: _, ...rest } = cur;
      return { kind: 'agrees', patch: { [sk]: rest } };
    }
    const same = cur.found && cur.found.date === finding.date && cur.found.url === finding.url;
    return { kind: 'kept', board: value, by: t(cur.by), found, patch: same ? {} : { [sk]: { ...cur, found } } };
  }
  const research = { kind: 'research', url: finding.url, quote: finding.quote, checked: today };
  if (cur && cur.kind === 'research' && value === finding.date)
    return { kind: 'confirmed', patch: cur.checked === today && cur.url === finding.url ? {} : { [sk]: research } };
  return { kind: 'set', from: value, fromKind: cur ? cur.kind : null, to: finding.date, url: finding.url, patch: { [field]: finding.date, [sk]: research } };
}

/**
 * Does this show still want its application dates looked up (Alan, 2026-10-26, defaults 7)? Either date blank or still
 * last year's estimate, and the deadline not passed.
 */
export function wantsAppDates(e, today) {
  const by = t(e.applyBy), byKind = (sourceOf(e, 'applyBy') || {}).kind;
  if (ISO.test(by) && byKind !== 'rolled' && by < today) return false;
  return APP_DATES.some(([f]) => { const s = sourceOf(e, f); return !s || s.kind === 'rolled'; });
}

/** A tag in words (the CLI, reports): "Research · example.org · checked 2026-10-26", "Manual · Matt Foss · 2026-10-26". */
export function tagText(e, field) {
  const s = sourceOf(e, field);
  if (!s) return '';
  const host = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (x) { return ''; } };
  if (s.kind === 'research') return `Research · ${host(s.url)} · checked ${t(s.checked)}`;
  if (s.kind === 'rolled') return `Taken from ${+s.fromYear === +(e.year || e.season) - 1 ? 'last year' : t(s.fromYear)} (${t(s.from)})`;
  return `Manual${s.by ? ` · ${t(s.by)}` : ''}${s.at ? ` · ${t(s.at)}` : ''}${s.found ? `; research found ${s.found.date} on ${host(s.found.url)}` : ''}`;
}
