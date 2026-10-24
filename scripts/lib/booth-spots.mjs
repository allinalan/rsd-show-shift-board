/*
  Booth spots (Alan, 2026-10-24: "copy over the actual BOOTH names when rolling over ... until it gets fixed").
  A Maricopa County Home Shows booth name is a place on that show's floor plan ("Booth #2 (Ag Building) (820/822)
  (8x20 Corner)"), and the spot can change from one edition to the next. A roll carries the name forward so the team
  sees where we were, tagged as last year's spot until someone fixes it: `rolledLabel` is the name as it was rolled,
  `rolledLabelYear` the year that spot was for. The tag stands only while the booth's name still says exactly that,
  so a rename anywhere (the board, the Sheet sync, the vendor lookup) clears it without having to know about it.
  Which shows: config/event-check.json `boothSpots`, matched like `tierRules`. index.html keeps the same rule.
*/
import { ruleTier } from './match.mjs';

const t = v => String(v ?? '').trim();
export const DEFAULT_SPOT_RULES = [{ match: 'Maricopa', except: ['Maricopa County Fair'] }];

/** Does this show's booth name say where on the floor plan we are (and so roll forward as last year's spot)? */
export const spotShow = (name, rules = DEFAULT_SPOT_RULES) => !!ruleTier(name, (rules || []).map(r => ({ ...r, tier: 'spot' })));

/** Is this booth's name still the one a roll carried in, i.e. last year's spot nobody has fixed yet? */
export const lastYearsSpot = b => !!(b && t(b.rolledLabel) && t(b.label) === t(b.rolledLabel));

/** The tag a booth gets as a roll carries it out of `fromYear`. A name still unfixed keeps the year it was really for. */
export function rollSpot(b, fromYear) {
  const label = t(b && b.label);
  if (!label) return {};
  return { rolledLabel: label, rolledLabelYear: lastYearsSpot(b) && b.rolledLabelYear ? b.rolledLabelYear : fromYear };
}

/** A show's booths rebuilt from elsewhere (the Sheet sync's new shift rows): a booth whose name is still the rolled one keeps its tag. */
export function keepSpotTags(booths, before) {
  const tagged = new Map((before || []).filter(lastYearsSpot).map(b => [t(b.label), b]));
  return (booths || []).map(b => {
    const was = tagged.get(t(b.label));
    return was && !t(b.rolledLabel) ? { ...b, rolledLabel: was.rolledLabel, rolledLabelYear: was.rolledLabelYear } : b;
  });
}
