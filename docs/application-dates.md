# Application dates and Submission Notes

Alan, 2026-10-26: "When it submits booking requests from the show shift board it can read submission notes so it can put
it in the comments section. We should also have a section labeled Application Deadline so CUTCO knows when the application
deadline is, the research agent SHOULD look into that as well. We also need a section called Application Opens ... If we
manually override it from the research there should be a small comment on there so we know whether it's from the research
agent or manual input." His answers to the questions were all defaults, except that dates roll forward as an estimate.

## On the board

Each show, in "Promoter, cost & VC details" (edited in Plan mode, read-only for reps), under the vendor application link:

| Shown as | Field | Notes |
|---|---|---|
| Application opens | `applyOpens` (YYYY-MM-DD) + `applyOpensSource` | |
| Application deadline | `applyBy` (YYYY-MM-DD) + `applyBySource` | "— passed" once it is behind us |
| Submission notes for Cutco | `submissionNotes` | 350 characters at most, with a counter |
| Team notes (never sent to Cutco) | `notes` | was "Notes for the booking request" until 2026-10-26 |

All of these are readable by anyone with the board's link and through the public API, like every other show field, and
SUNNY can read them. Nothing private goes in them. Quick add takes all four. Same-year series (Queen Creek, Mesa) share
them; an edit to Submission Notes also flows into later-year copies of the show.

The tag under each date (`scripts/lib/app-dates.mjs`, the page's `app-dates` block):

- `Research · fairtest.org · checked Oct 26`, with the page linked and the words it states the date in, below it;
- `Manual · Matt Foss · Oct 20` (the editors list's name; a `board set` gives it with `--by`);
- `Taken from last year` (dashed, an estimate): a roll carried last year's date a year on. Research replaces it once this
  year's is posted. An estimate nobody confirms keeps the date it really came from, so it never drifts; more than three
  years old, it is dropped;
- under a Manual date, in amber: `Research found Nov 15 on fairtest.org, your date kept`.

A date with no tag (typed before tags existed) counts as Manual: a person's, never overwritten.

## Research (the preflight, and the booking sweep's research step)

rsd-shift-picking's research asks for both dates with the page's own words (`docs/research-runs.md` there).
`board-research.mjs apply --mode full` decides (`decideAppDates`): only an official page, a real date, the words, and a
date that fits THIS edition (before the show's last day; a deadline at most 330 days and an opening at most 400 days before
its first). Then: a blank, an estimate or an earlier research date takes the finding (tagged Research); a Manual date is
kept and the finding is flagged on it (`--manual-wins off` would let research replace it); no page states it = left as it
is and listed as not posted yet; a failed lookup changes nothing. The report has a section for each. Elite and golf/builder
shows are not researched, the rolled-later window applies, and the 25-date-move guard is unchanged.

## The Booking Request

rsd-shift-picking's `lib/booking-sweep.js`: Comments = Submission Notes, then "Application opens: ... · Deadline: ...",
then the sweep's caveats, whole; over VC's 500 the request is held, never cut. VC's form has no field of its own for either
date (read 2026-10-26). `docs/booking-sweep.md` there.
