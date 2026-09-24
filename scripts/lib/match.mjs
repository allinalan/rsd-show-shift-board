/*
  match — pair board events with VectorConnect "My Events" rows. Pure functions, no I/O.

  The rules are the event-check skill's, turned into code (Alan's Sept-Feb checks, Aug-Sep 2026):
    * a board event that already carries a VC number is matched BY NUMBER first;
    * otherwise a match needs a name score >= minScore, a shared DISTINCTIVE word (a stop word or a
      generic word like "county", "art" or "wine" can never make two events the same: Santa Cruz
      County Fair once matched Navajo County Fair 200 miles away, and a reject pair only slid the
      match onto Mohave County Fair), and a date inside the VC record's run, give or take a few days;
    * the effective date is the board's start date when it sits near its weekend, else the weekend
      (schedule start dates are routinely stale; the weekend banner is what the staffing is for);
    * Queen Creek Family Market matches on the exact date only (VC titles carry stale date suffixes),
      and a placeholder record (00092192, 11/1-11/30) never books any date;
    * a name that matches well but dates 30+ days off is a date mismatch, never a missing booking;
    * aliases (schedule name -> contract name) and reject pairs are keyed by NAME, never by row;
    * afterwards, every VC number claimed by two board events is audited: the same show split into
      weeks is expected, anything else is a false positive until proven otherwise.
*/

export const STOPWORDS = new Set(['show', 'shows', 'festival', 'fest', 'annual', 'county', 'fair', 'of', 'the',
  'and', 'a', 'an', 'at', 'in', 'on', 'for', 'week', 'wk', 'w', 'row', 'weekend', 'more']);
// Words that appear across many unrelated events. They count toward a name score, but two events that
// share nothing else are not the same event. The first line is rsd-shift-picking's GENERIC_TOKENS.
export const GENERIC = new Set(['home', 'garden', 'county', 'craft', 'arts', 'art', 'fine', 'wine', 'days', 'day', 'annual', 'market',
  'expo', 'rv', 'holiday', 'city', 'fall', 'spring', 'winter', 'summer', 'rodeo', 'marketplace', 'az', 'arizona', 'nm', 'new', 'mexico',
  'show', 'fest', 'festival', 'family', 'health', 'women', 'woman', 'outdoor', 'sport', 'sportsman', 'gun', 'state',
  // family words: many towns hold one ("<Town> Oktoberfest", "<City> Gem Show", "Women's Day Out Expo <City>")
  'out', 'night', 'big', 'great', 'grand', 'world', 'park', 'club', 'center', 'food', 'foodie', 'music', 'beer', 'brew', 'brewing',
  'octoberfest', 'christmas', 'halloween', 'chili', 'bbq', 'taco', 'wedding', 'bridal', 'gem', 'rock', 'mineral', 'horse', 'car', 'auction']);

const pad = n => String(n).padStart(2, '0');
export const isoOf = d => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
export const toDate = iso => { const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null; };
export const addDaysIso = (iso, n) => { const d = toDate(iso); return d ? isoOf(new Date(d.getTime() + n * 864e5)) : null; };
export const dayDiff = (a, b) => Math.round((toDate(a) - toDate(b)) / 864e5);

export const normName = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
/**
 * The tier a rule gives a show by its name (config tierRules: [{ match, except: [], tier }]; Alan, 2026-09-24: every
 * Maricopa show is Elite, except the Maricopa County Fair), or null. Whole words: "Maricopa" never matches "Maricopan".
 */
export function ruleTier(name, rules = []) {
  const n = ` ${normName(name)} `;
  for (const r of rules || []) {
    const m = normName(r.match);
    if (m && n.includes(` ${m} `) && !(r.except || []).some(x => normName(x) && n.includes(` ${normName(x)} `))) return r.tier || null;
  }
  return null;
}
/** A show's tier for the automations: a tier rule wins over the tag on the board. */
export const tierOf = (e, rules) => ruleTier(e && e.name, rules) || (e && e.tier) || '';

/** The distinctive-ish word list of a name: lowercase, punctuation gone, stop words and bare numbers out, light stemming. */
export function tokens(name) {
  const out = [];
  const s = String(name || '').toLowerCase()
    .replace(/^\s*[a-z]{0,2}\d{3,10}\s*-\s*/, ' ')      // a VC number prefix "00101800 - "
    .replace(/&/g, ' and ').replace(/@/g, ' at ')
    .replace(/\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/g, ' ')  // date suffixes "1/24"
    .replace(/[^a-z0-9]+/g, ' ');
  for (let t of s.split(' ')) {
    if (!t || t.length < 2 || STOPWORDS.has(t) || /^\d+$/.test(t)) continue;
    t = t.replace(/^okt/, 'oct');                         // Oktoberfest / Octoberfest
    if (t.length > 3 && t.endsWith('s') && !t.endsWith('ss')) t = t.slice(0, -1);
    if (STOPWORDS.has(t)) continue;
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

export function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length; if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}
/** Same word, or a long word one typo away ("Sahaurita" / "Sahuarita"). */
export const tokenEq = (a, b) => a === b || (a.length >= 6 && b.length >= 6 && a[0] === b[0] && levenshtein(a, b) <= 2);

function dice(a, b) {
  const grams = s => { const g = new Map(); const t = s.replace(/\s+/g, ''); for (let i = 0; i < t.length - 1; i++) { const k = t.slice(i, i + 2); g.set(k, (g.get(k) || 0) + 1); } return g; };
  const A = grams(a), B = grams(b); let inter = 0, na = 0, nb = 0;
  for (const v of A.values()) na += v; for (const v of B.values()) nb += v;
  for (const [k, v] of A) inter += Math.min(v, B.get(k) || 0);
  return na + nb ? (2 * inter) / (na + nb) : 0;
}

/**
 * 0..1. Zero when the names share no DISTINCTIVE word, however alike the strings look: that is the
 * structural fix for same-shaped families (county fairs, "<City> Fine Art & Wine", "<City> Home Show").
 */
export function nameScore(a, b) {
  const A = tokens(a), B = tokens(b);
  if (!A.length || !B.length) return 0;
  const used = new Set(); let shared = 0, distinctive = 0;
  for (const t of A) {
    const j = B.findIndex((u, i) => !used.has(i) && tokenEq(t, u));
    if (j === -1) continue;
    used.add(j); shared++;
    if (!GENERIC.has(t) && !GENERIC.has(B[j])) distinctive++;
  }
  if (!distinctive) return 0;
  const jacc = shared / (A.length + B.length - shared);
  const cov = shared / Math.min(A.length, B.length);
  return 0.45 * cov + 0.25 * jacc + 0.30 * dice(A.join(' '), B.join(' '));
}

/**
 * The date a board event is judged on. First choice: its first resolved day date, which parse-sheet
 * anchors on the weekend banner (always right, because it is what the staffing is for). Then the start
 * date when it sits within `maxDrift` days of the weekend, then the weekend itself. Start dates are
 * routinely stale: the Queen Creek October rows carried 11/1, the placeholder's date, on 2026-09-23.
 */
const isSE = label => /set\s*up|tear\s*down|\bse\b/i.test(String(label || ''));
export function effectiveDate(e, maxDrift = 45) {
  const w = e.weekend || null, s = e.startDate || null;
  // Selling days only: a set-up day is not when the show runs, and some rows carry stale dates in their
  // day columns (the Phoenix Quilt row still has 1/25/2024..1/27/2024), leaving "Sunday SE" as the only
  // day that resolves. Then the start date or the weekend decides.
  const ds = (e.dates || []).map((d, i) => (d && !isSE((e.days || [])[i]) ? d : null)).filter(Boolean).sort();
  if (ds.length && (!w || Math.abs(dayDiff(ds[0], w)) <= 7)) return ds[0];
  if (s && w && Math.abs(dayDiff(s, w)) <= maxDrift) return s;
  return w || s || null;
}

/** True when `iso` falls inside the VC run, `slack` days either side. */
export function inRun(iso, row, slack = 4) {
  if (!iso || !row || !row.startDate) return false;
  const end = row.endDate || row.startDate;
  return dayDiff(iso, row.startDate) >= -slack && dayDiff(iso, end) <= slack;
}

/** A multi-week show split into weekly rows on the schedule is one VC record; strip the week marker to compare them. */
export const seriesKey = name => normName(String(name || '').replace(/\(?\b(w|wk|week)\s*#?\s*\d+\b\)?/gi, ' ').replace(/\b\d+(st|nd|rd|th)?\s*(week|weekend)\b/gi, ' '));

// ---------- VC status -> what unblocks it ----------
/**
 * The work-list buckets from the event-check skill, in the order the "NOT Fully Booked" tab lists them.
 * `booked` is the only fully booked bucket. Statuses are matched case-insensitively by prefix.
 */
export const CATEGORY_LABEL = {
  'no-vc': 'No VectorConnect record',
  dead: 'Show is dead, reps still on it',
  contract: 'Needs a contract',
  coi: 'Needs a COI',
  promoter: 'Waiting on the promoter',
  olean: 'Waiting on Olean / CO',
  'not-committed': 'Not a committed show',
  detail: 'Booked, pending a detail',
  booked: 'Booked',
  other: 'Status not on the definitions list',
};
export function statusCategory(status, { past = false } = {}) {
  const s = String(status || '').trim().toLowerCase();
  if (!s) return 'no-vc';
  if (/^(event )?closed$/.test(s)) return past ? 'booked' : 'dead';
  if (/^booked( own)?( event)?( - confirmed( event)?)?$/.test(s)) return 'booked';
  if (/^booked - needs insurance/.test(s)) return 'coi';
  if (/^booked/.test(s)) return 'detail';
  if (/^(ok to book - need contract|pending promoter - need contract|accepted - awaiting contract)/.test(s)) return 'contract';
  if (/^(cancel|promoter cancelled|promoter declined|coordinator declined|declined|show full|missed event|no show|olean cancelled|coordinator booked but cancel)/.test(s)) return 'dead';
  if (/^(pending promot|pending promo )/.test(s)) return 'promoter';
  if (/^(pending co|check requested|request to book|in process|mall |self booked|pending realtor)/.test(s)) return 'olean';
  if (/^(prospective|ok to book)$/.test(s)) return 'not-committed';
  return 'other';
}
export const isDead = (status, opts) => statusCategory(status, opts) === 'dead';

// ---------- matching ----------
/**
 * @param board  events in scope: { id, name, weekend, startDate, endDate, vcNumber }
 * @param vc     VC rows: { eventNumber, name, status, startDate, endDate, city }
 * @param cfg    { aliases:[{board,vc}], rejects:[{board,vc}], placeholders:[], qcfmPattern, minScore, dateSlackDays, effectiveDateMaxDrift }
 * @returns { results: Map(boardId -> result), claims: Map(vcNumber -> [boardId]), placeholderHits }
 *   result = { row|null, by: 'number'|'name'|'alias'|'qcfm'|null, score, effective, dateMismatch, note, numberMissing, placeholder }
 */
export function matchAll(board, vc, cfg = {}) {
  const slack = cfg.dateSlackDays ?? 4, minScore = cfg.minScore ?? 0.5, drift = cfg.effectiveDateMaxDrift ?? 45;
  const placeholders = new Set((cfg.placeholders || []).map(String));
  const qcfm = new RegExp(cfg.qcfmPattern || 'queen\\s*creek\\s*family\\s*market', 'i');
  const aliasMap = new Map((cfg.aliases || []).map(a => [normName(a.board), normName(a.vc)]));
  const rejects = new Set((cfg.rejects || []).map(r => normName(r.board) + '|' + normName(r.vc)));
  const byNumber = new Map(vc.map(r => [String(r.eventNumber), r]));
  const usable = vc.filter(r => !placeholders.has(String(r.eventNumber)));
  const results = new Map();

  for (const e of board) {
    const eff = effectiveDate(e, drift);
    const res = { row: null, by: null, score: 0, effective: eff, dateMismatch: false, note: '', numberMissing: false, placeholder: null };
    const num = String(e.vcNumber || '').trim();

    if (qcfm.test(e.name)) {
      // Exact date only (any of the event's resolved day dates); the placeholder is never evidence that a
      // November date is booked, and the stale "1/24" in VC's titles is ignored.
      const days = new Set([eff, ...(e.dates || [])].filter(Boolean));
      const hit = usable.find(r => qcfm.test(r.name) && days.has(r.startDate));
      if (hit) Object.assign(res, { row: hit, by: 'qcfm', score: 1 });
      else {
        const ph = vc.find(r => placeholders.has(String(r.eventNumber)) && inRun(eff, r, 0));
        if (ph) Object.assign(res, { placeholder: ph.eventNumber, note: `only the placeholder ${ph.eventNumber} (${ph.startDate} to ${ph.endDate}) covers this date; not treated as booked` });
        if (num && !placeholders.has(num) && !byNumber.has(num)) res.numberMissing = true;
      }
      results.set(e.id, res); continue;
    }

    if (num && placeholders.has(num)) res.note = `the board carried placeholder ${num}; ignored`;
    else if (num && byNumber.has(num)) {
      const row = byNumber.get(num);
      Object.assign(res, { row, by: 'number', score: 1, dateMismatch: !inRun(eff, row, slack) });
      results.set(e.id, res); continue;
    } else if (num) res.numberMissing = true;

    // Name matching, gated on dates. Aliases first (keyed by name), then the scorer.
    const alias = aliasMap.get(normName(e.name));
    let best = null, bestMismatch = null;
    for (const r of usable) {
      if (rejects.has(normName(e.name) + '|' + normName(r.name))) continue;
      const isAlias = alias && normName(r.name) === alias;
      const score = isAlias ? 1 : nameScore(e.name, r.name);
      if (score < minScore) continue;
      if (inRun(eff, r, slack)) { if (!best || score > best.score) best = { r, score, isAlias }; }
      else if (score >= 0.85 && eff && Math.min(Math.abs(dayDiff(eff, r.startDate)), Math.abs(dayDiff(eff, r.endDate || r.startDate))) >= 30) {
        if (!bestMismatch || score > bestMismatch.score) bestMismatch = { r, score };
      }
    }
    if (best) Object.assign(res, { row: best.r, by: best.isAlias ? 'alias' : 'name', score: +best.score.toFixed(3) });
    else if (bestMismatch) Object.assign(res, { row: null, dateMismatch: true, mismatchRow: bestMismatch.r, score: +bestMismatch.score.toFixed(3),
      note: `name matches ${bestMismatch.r.eventNumber} ${bestMismatch.r.name} but VC has ${bestMismatch.r.startDate} to ${bestMismatch.r.endDate}` });
    if (res.numberMissing && !best) res.note = (res.note ? res.note + '; ' : '') + `board carries VC# ${num}, which is not in this pull`;
    results.set(e.id, res);
  }

  const claims = new Map();
  for (const [id, r] of results) if (r.row) {
    const k = String(r.row.eventNumber);
    if (!claims.has(k)) claims.set(k, []);
    claims.get(k).push(id);
  }
  return { results, claims };
}

/**
 * Every VC number claimed by more than one board event. The same show split into weeks is expected
 * (Quartzsite w1/w2, Barrett-Jackson, the Arabian Horse Show, Tucson Rodeo); anything else is a bug.
 * @returns [{ number, ids, legit }]
 */
export function duplicateClaims(claims, boardById) {
  const out = [];
  for (const [number, ids] of claims) {
    if (ids.length < 2) continue;
    const keys = new Set(ids.map(id => seriesKey(boardById.get(id)?.name)));
    out.push({ number, ids, legit: keys.size === 1 });
  }
  return out;
}
