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
| ~~sunny-bot~~ | switched 2026-10-03 | SUNNY now reads the board live (`lib/board.js` in sunny-bot: the public anon key, 10-minute cache): what is booked, costs, promoter contacts, who is working. Its two Mac mini jobs (`com.allinalan.sunny.refresh`, `com.allinalan.sunny.shiftsync`) are retired. SUNNY still sends reps to the Sheet to check for themselves, not the board link, until stage 3 |
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
(the deterministic Sheet → board sync, Wednesdays only at first; hourly from 2026-10-15, once three
Wednesdays come back clean, below) and `scripts/event-check.mjs` (VC via rsd-shift-picking's Keychain login and
the JSON store behind My Events, no Chrome, no account skills), both run from rsd-shift-picking's
Wednesday 08:00 job. The texts go through that repo's approvals loop (Alan replies approved / decline /
edits in iMessage; silence by the printed deadline sends). Still open for stage 2: count the four clean
Wednesdays from 2026-09-30.

*On demand and hourly, 2026-09-28 (Alan: the team re-staffs shows on the Sheet and wants the board to show it
now).* A **Sync from the Sheet** button in Plan mode rings the mini (`sheet_syncs`, `scripts/sync-requests.mjs`,
`com.allinalan.rsd-board-sync` every 30 s), which runs the same sync with the same guards and reports back on the
page. From 2026-10-15 (config `sync.auto.from`, the day after the third clean Wednesday: 9/30, 10/7, 10/14) the
same listener also syncs by itself every hour, 7am-9pm Phoenix; a Wednesday that isn't clean moves the date. A
run that stops (parser drift, over the limits) pauses the hourly sync until one gets through. These runs have no
VC pull, so they hold Sheet date moves on shows VC has a record for, and the Wednesday run, which is unchanged,
decides those. Every `--apply` run is recorded, so the page's sync line doubles as the sync's track record.

The booking sweep went unattended the same night (Alan, 2026-09-23): `scripts/booking-sweep.mjs` plus
rsd-shift-picking's `run-booking-sweep.sh` (com.rsd.bookingsweep, days 2-8 after a meeting), submitting VC
Booking Requests by script after Alan's reply. Its first real run is two days after the January 13, 2027 meeting,
so the Jan-May book must be on the board by then (below). The pre-meeting research went unattended on 2026-09-24:
`scripts/board-research.mjs` plus rsd-shift-picking's `run-preflight.sh` (com.rsd.preflight): the date research 7
days before each meeting and the preflight 2 days before, Claude with web search, the board corrected from official
pages (VC's dates, noted, when nothing online confirms), the report texted to Alan and emailed to the
coordinators. Its first real runs are January 6 and 11, 2027. Roll-forward is the last routine still hand-run.

**Before the January 2027 meeting: the Jan-May book.** The board and the sync hold only the Sept-Feb tab.
Add the Jan-May book to the sync (its own tab and column map, checked with `parse-sheet.mjs --verify`)
before the team moves to it, or the Wednesday check silently goes blind from March. The tick reminds on
Dec 28; the old Cowork "Jan-May Schedule Changeover Prep" task (bound to the MacBook) was written for the
Sheet-based routine and should be deleted.

**Stage 3 — the first meeting on the board (the May 2027 meeting).**
Coordinators enter picks in plan mode. Direction flips: board → Sheet export (a script writes the
Sheet from the board), so every reader above keeps working off a Sheet that is now a mirror.
Exit test: the mirror matches the board cell for cell after the meeting and after the sweep.

**Stage 4 — move the readers, one at a time (May → Aug 2027; the small ones start early, below).**
Order by blast radius, smallest first: ~~sunny shift sync~~ (done 2026-10-03, see below) → count-mesa-shifts → show-shift-calendar-sync
→ rsd-event-analyzer → rsd-shift-picking (last: it texts reps). For each: add a board adapter that
returns exactly the shape the Sheet parser returns today, run both for a full cycle, diff the
outputs, switch only on a clean diff, keep the Sheet path one release as the fallback. What the
board must carry before rsd-shift-picking and the analyzer can move: the font-color meanings (as
explicit fields, not colors), field-training markers, and stable rep ids instead of nicknames.

**Stage 5 — retire the Sheet (after the Fall 2027 meeting).**
Stop the mirror, make the Sheet read-only with a banner pointing at the board, remove the Sheet
paths and the Picking Feed's schedule half, update `REGISTRY.yaml` for every system above.

## Who switches, and when (Alan, 2026-09-28)

As of 2026-09-28 Alan is the only person who opens the board; Matt and JP work in the Sheet. The goal stands
(the Sheet retired by Fall 2027), so the critical path is people, not scripts: stage 3 has Matt and JP enter
picks on the board in May, and nothing after it happens if they don't. A board that lags the Sheet looks wrong to
anyone who checks it, which is why it has to be current (hourly) before they start looking. Stage 4's side-by-side
runs need no flip: the board already mirrors the Sheet, so a reader's board adapter can be diffed against its
Sheet path now.

| by | who | what | done when |
|---|---|---|---|
| Oct 15, 2026 | the mini | Hourly sync on (above). | the page's sync line reads "hourly" through a normal week |
| end of Oct 2026 | Matt, JP | Sign in once, on the device they would use at a meeting (on iPhone, the Home Screen icon). Use the board for the one question the Sheet can no longer answer: is this show booked? VC status lives only on the board; the Sheet's Z/AA columns froze on 9/9. | both have signed in; booking questions get answered from the board |
| ~~Nov 2026~~ done 2026-10-03 | Alan + Claude | SUNNY reads the board directly instead of a twice-a-month copy (Alan, 2026-10-03). There was no side-by-side run: both of SUNNY's old copies had stopped updating (Aug 28 and Sep 6), so there was nothing current to diff. Checked instead with sunny-bot's `scripts/board-audit/test-board.js` against the live board. **SUNNY is now a reader of the board: a change to the `events` / `event_contacts` shape (`booths[].shifts[].slots[]`, `days`/`dates`, `status`, `vcNumber`, `costNum`, `dead`) needs that test run.** | the board test passes; SUNNY's answers match the board page |
| Nov–Dec 2026 | Alan + Claude | The board → Sheet mirror (stage 3's script), writing to a **copy** of the Sheet, never the Sheet itself, and diffed against the real Sheet after each sync. The fields rsd-shift-picking and the analyzer need (font-color meanings, field-training markers, stable rep ids) go on the board. | the copy matches the Sheet cell for cell for two weeks |
| Jan 6, 2027 | Alan + Claude | The Jan-May book on the sync (above), before the date research's first real run: it can only research shows the board has. | `parse-sheet.mjs --verify` clean on the new tab |
| Jan 13, 2027 meeting | all three | Dress rehearsal: Matt and JP run the meeting on the Sheet as usual; Alan enters the same picks on the board live. Afterwards the two are compared, and whatever was slow or missing on the board is the list to fix before May. | the gap list is fixed |
| Feb–Apr 2027 | Alan + Claude | count-mesa-shifts and show-shift-calendar-sync: board adapters, both paths, diffed. The mirror keeps running against its copy. | clean diffs, then switch |
| May 2027 meeting | Matt, JP | Stage 3: picks go on the board, and the mirror starts writing the real Sheet. The flip is all at once: the Sheet → board sync stops the day the mirror starts (both directions at once is a two-way sync). From then on nobody edits the Sheet. | the mirror matches the board after the meeting and after the sweep |
| May–Aug 2027 | Alan + Claude | rsd-event-analyzer, then rsd-shift-picking (last: it texts reps). | each switched on a clean diff |
| after the Aug 2027 meeting | Alan | Stage 5: the Sheet goes read-only. | the Sheet shows the banner |

## Not decided yet

- Rep identity on the board: nicknames today; the readers in stage 4 want roster ids.
- Whether the rep-text step of the event check ever sends on its own. Today: drafts only.
- Whether rsd-shift-picking's `run-booking-sweep.sh` runs the Sheet sync before it sorts staffed shows (checked
  from this repo it can't be). If not, the sweep judges picks made on the Sheet from a board synced by the
  hourly run (07:00 at the latest, for a 07:30 sweep), which is fine unless the hourly sync is paused or off.
  Worth a look before the sweep's first real run on January 15, 2027.
