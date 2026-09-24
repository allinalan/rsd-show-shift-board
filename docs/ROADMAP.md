# Roadmap: the board replaces the Sheet by Fall 2027

Alan's goal (2026-09-19): by the Fall 2027 shift-picking meeting (August 2027), every RSD events
automation reads and writes the Show Shift Board, and the Show Shift Schedule Google Sheet is an
archive. The rule for getting there: **stages, slowly, and no routine breaks.** One reader moves at
a time, each one runs in parallel against the Sheet first, and the Sheet is never retired as a side
effect of something else.

## Who still reads the Sheet (as of 2026-09-19)

| system | where | what it reads |
|---|---|---|
| rsd-shift-picking | `lib/schedule.js`, `lib/roster.js`, `lib/reconcile.js`, `fetch-live.js` (RSD Picking Feed, Apps Script) | every scheduled shift, rep nicknames, season from the tab name, font colors |
| rsd-event-analyzer | `lib/shifts.js`, `lib/upcoming.js`, `lib/categorize.js`, `lib/schedule-colors.js`, `tools/backfill.js`, 4 report templates | shifts per event, upcoming events, font colors via the Picking Feed |
| sunny-bot | `mini/run_shift_sync.sh` (`com.allinalan.sunny.shiftsync`, 1st and 15th) | who is working which show, for SUNNY's answers |
| ~~skill: event-check~~ | replaced 2026-09-23 | the Wednesday check now reads the board (`scripts/event-check.mjs`); the Sheet reaches it only through `scripts/sheet-sync.mjs`, and nothing writes the Sheet's Z/AA columns any more |
| skill: show-shift-calendar-sync | account skill | reps' shifts to calendars |
| skill: count-mesa-shifts | account skill | Mesa shift counts |
| skill: events-picking-order | `~/ai-system/claude/skills` | picking order, through rsd-shift-picking |

## Stages

**Stage 1 — the board exists, the Sheet is the truth (now → Jan 2027 meeting).**
Board live on Pages + Supabase, seeded from the Sheet, editors signed in. The daily tick decides
and notifies; every routine is hand-run from the Claude desktop app. The Sheet stays authoritative
and every reader above is untouched. Exit test: the board and the Sheet agree after a hand-run
`board-event-check` on three consecutive Wednesdays.

**Stage 2 — keep the board true without hands (Jan → Mar 2027).**
A deterministic Sheet → board sync (one direction, a script, no AI) so the board never drifts while
coordinators still edit the Sheet. Vendor the account skills the routines need into
`.claude/skills/` (or replace their VectorConnect half with a Playwright script like
rsd-event-analyzer's), then let `deploy/tick.py` run `board-event-check` unattended with an explicit
tool allow-list. Exit test: four unattended Wednesdays, each read back and matching VectorConnect.

*Started early, 2026-09-23 (Alan's call, after the Cowork routine failed two Wednesdays running on
Chrome and a logged-out session).* Built as scripts, not an unattended Claude: `scripts/sheet-sync.mjs`
(the deterministic Sheet → board sync, Wednesdays only for now; daily is a schedule change once three
Wednesdays come back clean) and `scripts/event-check.mjs` (VC via rsd-shift-picking's Keychain login and
the JSON store behind My Events, no Chrome, no account skills), both run from rsd-shift-picking's
Wednesday 08:00 job. The texts go through that repo's approvals loop (Alan replies approved / decline /
edits in iMessage; silence by the printed deadline sends). Still open for stage 2: count the four clean
Wednesdays from 2026-09-30.

The booking sweep went unattended the same night (Alan, 2026-09-23): `scripts/booking-sweep.mjs` plus
rsd-shift-picking's `run-booking-sweep.sh` (com.rsd.bookingsweep, days 2-8 after a meeting), submitting VC
Booking Requests by script after Alan's reply. Its first real run is two days after the January 13, 2027 meeting,
so the Jan-May book must be on the board by then (below). The preflight is the last routine still hand-run; Alan
asked (2026-09-24) for it to run itself two days before each meeting, next.

**Before the January 2027 meeting: the Jan-May book.** The board and the sync hold only the Sept-Feb tab.
Add the Jan-May book to the sync (its own tab and column map, checked with `parse-sheet.mjs --verify`)
before the team moves to it, or the Wednesday check silently goes blind from March. The tick reminds on
Dec 28; the old Cowork "Jan-May Schedule Changeover Prep" task (bound to the MacBook) was written for the
Sheet-based routine and should be deleted.

**Stage 3 — the first meeting on the board (the May 2027 meeting).**
Coordinators enter picks in plan mode. Direction flips: board → Sheet export (a script writes the
Sheet from the board), so every reader above keeps working off a Sheet that is now a mirror.
Exit test: the mirror matches the board cell for cell after the meeting and after the sweep.

**Stage 4 — move the readers, one at a time (May → Aug 2027).**
Order by blast radius, smallest first: sunny shift sync → count-mesa-shifts → show-shift-calendar-sync
→ rsd-event-analyzer → rsd-shift-picking (last: it texts reps). For each: add a board adapter that
returns exactly the shape the Sheet parser returns today, run both for a full cycle, diff the
outputs, switch only on a clean diff, keep the Sheet path one release as the fallback. What the
board must carry before rsd-shift-picking and the analyzer can move: the font-color meanings (as
explicit fields, not colors), field-training markers, and stable rep ids instead of nicknames.

**Stage 5 — retire the Sheet (after the Fall 2027 meeting).**
Stop the mirror, make the Sheet read-only with a banner pointing at the board, remove the Sheet
paths and the Picking Feed's schedule half, update `REGISTRY.yaml` for every system above.

## Not decided yet

- Rep identity on the board: nicknames today; the readers in stage 4 want roster ids.
- Whether the rep-text step of the event check ever sends on its own. Today: drafts only.
