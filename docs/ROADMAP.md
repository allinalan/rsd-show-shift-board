# Roadmap: the board replaces the Sheet by Fall 2027

Alan's goal (2026-09-19): by the Fall 2027 shift-picking meeting (August 2027), every RSD events
automation reads and writes the Show Shift Board, and the Show Shift Schedule Google Sheet is an
archive. **Moved up 2026-10-27 (Alan: "make the January 13 meeting the first one run on the board"): stage 3, the
first meeting on the board, is the January 13, 2027 meeting, not May. Its scope, the mirror, the parallel run and the
cutover are in `docs/stage-3-january.md`.** The rule for getting there: **stages, slowly, and no routine breaks.** One reader moves at
a time, each one runs in parallel against the Sheet first, and the Sheet is never retired as a side
effect of something else.

## Who still reads the Sheet (as of 2026-09-19)

Kept as written then. Since 2026-09-30 rsd-event-analyzer reads the board first for 2026 on. The full list as of
2026-10-27, with what each reader takes from the Sheet and what its colors mean, is in `docs/stage-3-january.md`.

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

~~**Before the January 2027 meeting: the Jan-May book.**~~ Done 2026-10-23 (Alan sent the Jan-May 2027 Sheet). The
sync follows both books (`config/event-check.json` `sheets`), each feeding only its own weekends; the Jan-May book takes
over January and February on the morning of the January 13 meeting. Its March-May rows were still 2026's, so the first
load put them on the board as 2027 Prospective shows with no reps and estimated days, which the January 6 date research
then checks. When Matt and JP rebuild March-May for 2027, the first sync after a big batch of edits will stop over the
40-show limit; read its report and run it with `--force` on the mini. The Dec 28 reminder is gone; the old Cowork "Jan-May
Schedule Changeover Prep" task (bound to the MacBook) was written for the Sheet-based routine and should be deleted.

**Stage 3 — the first meeting on the board (the January 13, 2027 meeting; was May, Alan 2026-10-27).**
Coordinators enter picks in plan mode. Direction flips: board → Sheet export (a script writes the
Sheet from the board), so every reader above keeps working off a Sheet that is now a mirror.
Exit test: the mirror matches the board cell for cell after the meeting and after the sweep. Before it: 14 days of
every reader parsing a copy of the mirror exactly as it parses the real Sheet, by January 6 (go / no-go). Scope in
`docs/stage-3-january.md`.

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
| Nov 2026 | Alan + Claude | Safe slot saves (two coordinators at once), the board fields the mirror writes back (a "didn't work" mark per shift, column C, MF), the board → Sheet mirror (stage 3's script) writing **copies** of the books, never the books themselves, and the January 13 switches, built and off. Stable rep ids are stage 4's, not needed for the mirror. | `docs/stage-3-january.md` items 1-6 built |
| Dec 1, 2026 – Jan 6, 2027 | the mini | The parallel run: after each hourly sync every reader parses the copy and the real book; a difference goes to #rsd-board. (Was "cell for cell": the team's Sheet has spills and stale cells the mirror must not copy.) | 14 days in a row with no unexplained difference by Jan 6 = go |
| ~~Jan 6, 2027~~ done 2026-10-23 | Alan + Claude | The Jan-May book on the sync (above), before the date research's first real run: it can only research shows the board has. | the first load read back; the next sync of both books changed nothing |
| Jan 5-8, 2027 | all three | Practice on the board: a practice show, both coordinators at once, the projector view; and a dry run of the cutover morning. | what was slow or missing is fixed |
| Jan 13, 2027 meeting | Matt, JP, Alan | **Stage 3** (Alan, 2026-10-27): picks go on the board, and the mirror starts writing the real books from the January 15 weekend on. The flip is all at once: the Sheet → board sync stops that morning. From then on nobody edits the Sheet. If January 6 was no-go, this meeting is the old dress rehearsal (Matt and JP on the Sheet, Alan entering the same picks on the board) and the flip waits for May. | the mirror matches the board after the meeting and after the Jan 15 sweep |
| Feb–Apr 2027 | Alan + Claude | count-mesa-shifts and show-shift-calendar-sync: board adapters, both paths, diffed. The mirror keeps running against its copy. | clean diffs, then switch |
| May 2027 meeting | Matt, JP | The second meeting on the board. The summer picks go on the board and the mirror takes on the May-Sept book until rsd-shift-picking reads the board. | the mirror matches the board after the meeting and after the sweep |
| May–Aug 2027 | Alan + Claude | rsd-event-analyzer, then rsd-shift-picking (last: it texts reps). | each switched on a clean diff |
| after the Aug 2027 meeting | Alan | Stage 5: the Sheet goes read-only. | the Sheet shows the banner |

## Not decided yet

- Rep identity on the board: nicknames today; the readers in stage 4 want roster ids.
- Whether the rep-text step of the event check ever sends on its own. Today: drafts only.
- Whether rsd-shift-picking's `run-booking-sweep.sh` runs the Sheet sync before it sorts staffed shows (checked
  from this repo it can't be). If not, the sweep judges picks made on the Sheet from a board synced by the
  hourly run (07:00 at the latest, for a 07:30 sweep), which is fine unless the hourly sync is paused or off.
  Worth a look before the sweep's first real run on January 15, 2027. *Settled by stage 3 in January:* the sweep, the
  preflight and shift cost each stop without that day's Sheet sync report (`run-booking-sweep.sh` "no Sheet sync report
  for today"); from January 13 they read the mirror's report instead (`docs/stage-3-january.md` item 5).
