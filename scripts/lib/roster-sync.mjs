/*
  The board's roster follows the rep master list (Alan, 2026-10-21: "update the show shift board roster too (make that
  automatic)"). The master list (github.com/allinalan/rsd-rep-master-list, data/roster.json, a sibling checkout on the
  mini) says who is on the team; the board keeps its own short spellings ("J. Parker", "Matt A.", "Kendall H.") because
  every shift already stored on the board is stored that way. So this plans, it never renames:

    a board name tied to a rep who LEFT        -> off `roster`, onto `former` (still known to the Sheet sync and the
                                                  parser, so their old shifts are never "names the roster cannot place")
    an active rep (in a board tier) with no name -> added, under an alias of theirs or their first name ("First L." when
                                                  that first name is taken)
    a name the master list cannot tie to anyone -> left alone, and reported (someone added it by hand)
    a rep who left and came back               -> back on `roster`, off `former`

  A board name ties to a rep by its letters (case and punctuation ignored): the rep's name or an alias first, then, only
  when exactly one rep fits, their first name, "First L" or "F Last". Pure: no network, no files.
*/

// Leader since 2026-10-21 (Alan: Luke Mills works shifts, "yes, please add him on there")
export const BOARD_TIERS = ['Elite', 'Varsity', 'JV', 'Freshmen', 'Coordinator', 'Leader'];
const norm = s => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
const words = s => String(s || '').trim().split(/\s+/).filter(Boolean);

/** key -> [rep ids], exact (name, aliases) and derived (first name, First L, F Last) kept apart. */
function index(reps) {
  const exact = new Map(), derived = new Map();
  const add = (m, k, id) => { if (!k) return; const a = m.get(k) || []; if (!a.includes(id)) a.push(id); m.set(k, a); };
  for (const r of reps) {
    add(exact, norm(r.name), r.id);
    for (const a of r.aliases || []) add(exact, norm(a), r.id);
    const w = words(r.name), first = w[0] || '', last = w[w.length - 1] || '';
    add(derived, norm(first), r.id);
    if (w.length > 1) { add(derived, norm(first + last[0]), r.id); add(derived, norm(first[0] + last), r.id); }
  }
  return { exact, derived };
}

/** The rep a board name stands for, or null (never a guess between two). */
export function tie(name, reps, ix = index(reps)) {
  const k = norm(name);
  if (!k) return null;
  const e = ix.exact.get(k);
  if (e && e.length === 1) return reps.find(r => r.id === e[0]);
  if (e && e.length > 1) return null;
  const d = ix.derived.get(k);
  return d && d.length === 1 ? reps.find(r => r.id === d[0]) : null;
}

/**
 * The name a rep gets on the board when they have none: a one-word or "First L." alias, else the first name, else
 * "First L.". Only a name that leads back to this rep alone (tie()) and is not on the board already: a first name two
 * reps share would be "a name the master list cannot tie to anyone" on the very next run.
 */
export function nameFor(rep, taken, reps = [rep], ix = index(reps)) {
  const w = words(rep.name), first = w[0], last = w[w.length - 1];
  const free = n => n && !taken.has(norm(n)) && (tie(n, reps, ix) || {}).id === rep.id;
  const short = (rep.aliases || []).filter(a => /^[A-Za-z]+$/.test(a) || /^[A-Za-z]+ [A-Za-z]\.?$/.test(a)).sort((a, b) => a.length - b.length);
  for (const a of short) if (norm(a).startsWith(norm(first).slice(0, 2)) && free(a)) return a.replace(/^([A-Za-z]+) ([A-Za-z])$/, '$1 $2.');
  if (free(first)) return first;
  if (w.length > 1 && free(`${first} ${last[0]}.`)) return `${first} ${last[0]}.`;
  return free(rep.name) ? rep.name : null;
}

/**
 * @param board   the board's settings: { roster: [names], former: [names] }
 * @param reps    the master list's reps: [{ id, name, tier, status, aliases }]
 * @returns { roster, former, added: [{ name, rep }], removed: [{ name, rep }], back: [{ name, rep }], unknown: [names],
 *            problems: [why], changed }
 */
export function planRoster(board, reps, { tiers = BOARD_TIERS, maxRemove = 12, minActive = 10 } = {}) {
  const out = { roster: [], former: [], added: [], removed: [], back: [], unknown: [], problems: [], changed: false };
  const list = (reps || []).filter(r => r && r.id && r.name);
  const ix = index(list);
  const want = list.filter(r => r.status === 'active' && tiers.includes(r.tier));
  if (want.length < minActive) { out.problems.push(`the master list has ${want.length} active reps in the board's tiers (fewer than ${minActive}): it looks wrong, so nothing changes`); return out; }

  const roster = [...new Set((board.roster || []).map(s => String(s).trim()).filter(Boolean))];
  const former = [...new Set((board.former || []).map(s => String(s).trim()).filter(Boolean))];
  const has = new Set();                                                      // rep ids that already have a board name
  const keep = [], gone = [];
  for (const n of roster) {
    const r = tie(n, list, ix);
    if (!r) { keep.push(n); out.unknown.push(n); continue; }
    if (r.status !== 'active') { gone.push(n); out.removed.push({ name: n, rep: r.name }); continue; }
    keep.push(n); has.add(r.id);
  }
  // back from `former`: a rep who rejoined gets their old spelling back
  const stillFormer = [];
  for (const n of former) {
    const r = tie(n, list, ix);
    if (r && r.status === 'active' && tiers.includes(r.tier) && !has.has(r.id)) { keep.push(n); has.add(r.id); out.back.push({ name: n, rep: r.name }); }
    else if (!keep.some(k => norm(k) === norm(n))) stillFormer.push(n);
  }
  const taken = new Set([...keep, ...stillFormer, ...gone].map(norm));
  for (const r of want) {
    if (has.has(r.id)) continue;
    const n = nameFor(r, taken, list, ix);
    if (!n) { out.problems.push(`no free board name for ${r.name}`); continue; }
    keep.push(n); taken.add(norm(n)); has.add(r.id); out.added.push({ name: n, rep: r.name });
  }
  if (out.removed.length > maxRemove) { out.problems.push(`${out.removed.length} names would come off at once (limit ${maxRemove}): check the master list, or run with --force`); return out; }

  out.roster = keep.sort((a, b) => a.localeCompare(b));
  out.former = [...new Set([...stillFormer, ...gone])].sort((a, b) => a.localeCompare(b));
  out.changed = JSON.stringify(out.roster) !== JSON.stringify([...roster].sort((a, b) => a.localeCompare(b))) || JSON.stringify(out.former) !== JSON.stringify([...former].sort((a, b) => a.localeCompare(b)));
  return out;
}
