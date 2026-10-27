# Stage 3 in January: the board-to-Sheet mirror

Alan, 2026-10-27: "make the January 13 meeting the first one run on the board." From that morning Matt, JP and Alan
edit only the board, a script writes the Sheet from the board so everything that still reads the Sheet keeps working,
and the Sheet → board sync stops the same morning. That is the roadmap's stage 3, moved from the May 2027 meeting to the
January 13, 2027 meeting. Stage 4 (the readers move to the board one at a time, rsd-shift-picking last) and stage 5 (the
Sheet goes read-only after the Fall 2027 meeting) keep their order. This file is the scope: what the board still needs,
what the mirror is, how it is proven before anyone relies on it, and the cutover. Nothing in it is built yet.

## Where it stands (checked 2026-10-27)

**People.** Editors on the board: Alan (owner), Matt, JP and Cameron (coordinators). Matt and Cameron have never signed
in (no account). JP signed in once, on 2026-10-14, and made one edit (a kiosk day). Every other edit since go-live on
2026-09-21 is Alan's or a routine's. The roadmap's "end of October: Matt and JP sign in" has not happened for Matt.
People are the critical path: the scripts below are about four weeks of work, and none of it matters unless the
coordinators edit on the board on January 13.

**What the mirror would own.** On the board today, January 15 to May 28, 2027 is 160 shows on 20 weekends; 40 of them
have names (187 shifts). Column C is set on 138 of them, mostly a status word the team typed ("Booked", "Prospective",
"Pending") with some notes ("expensive, maybe 2027, not working", "vendors not allowed"). Column A says "MF" on 17 shows
from 2026 on.

**Who reads the Sheet.** Every reader only reads; people are the only writers.

| reader | how | what it takes | runs |
|---|---|---|---|
| rsd-shift-picking (`lib/schedule.js`, `lib/shift-colors.js`, `lib/roster.js`, `lib/reconcile.js`) and everything built on it: the picking order, debt, reminders, shift cost, `tools/ruling.js`, `tools/date-fill-impact.js`, ALMA Stats (through `picking_owed.js`), the `events-picking-order` skill | the RSD Picking Feed (Apps Script, `appsscript/Code.gs`, read-only): every tab of all three books, values plus one font color and one background color per cell, the spreadsheet title, tab names; cached in `data/live-feed.json` by `fetch-live.js` | B, C (dead and positive words), E title, F-N day labels and the names under them, N/O Start/End (scan of M-R as a fallback), P city, Q venue, "Weekend M/D" banners in A-H (slash only), the title's and each name's font color, the Sheet row (for its Start Date fills), season and newest book from the title and tab name | 07:00 and 19:00 (com.rsd.shiftcost), Wednesday 09:00 and 13:00 (com.rsd.weeklystats), Wednesday 08:00 pages from the cache |
| rsd-event-analyzer (`lib/schedule-colors.js`, `lib/shifts.js`, `lib/upcoming.js`, `lib/categorize.js`) | the Picking Feed, live | the board first for 2026 on when the board has anyone on the show (since 2026-09-30); the Sheet otherwise: the title color as a tier hint, an event row only when F starts with a weekday, C "booked", dates, city, venue | Jan, May, Sep 8-11 at 09:00 |
| this repo's `sheet-sync.mjs` / `parse-sheet.mjs` | the public xlsx export, values only | the columns in `parse-sheet.mjs` `C` | hourly 7am-9pm, and inside every `run-event-check.sh` |
| rsd-shift-picking's coverage agent | this repo's `state/sheet-baseline.json` | whether the Sheet caught up with a moved shift | every minute |
| the board page | links | "Open the Sheet", and a "Sheet row" link per show (always the Sept-Feb tab) | open page |
| account skills, hand-run: `show-shift-calendar-sync` (Drive xlsx, header labels in rows 1-8, banners in column B only, "Shift N" rows), `count-mesa-shifts` (Drive CSV of the Jan-May book, "Weekend NN/NN", Mesa A/B rows), `vectorconnect-booking-request` (venue, promoter, cost) | Drive connector | as listed | by hand |
| the old `event-check` account skill (replaced 2026-09-23, **still installed**) | Drive connector | columns B-W | by hand; the one thing that ever **wrote** the Sheet (Z/AA through Chrome, last on 9/9) |
| people: SUNNY sends reps to "the Show Shift Schedule on the team website" | | | |

**What the colors mean to the readers** (nothing reads notes, bold or color runs inside a cell; the Feed returns
backgrounds and nothing reads them):
- **Title font (column E):** black or dark grey = Traditional; teal (#46bdc6, #4bacc6) = Key; purple (#9900ff) and
  magenta (#ff00ff) = Key to the picking order and Elite to the analyzer.
- **A name's font:** red (#ff0000) = didn't work: the shift is dead, no credit and no charge. Blue (#0000ff, #4a86e8) = the
  show wasn't booked yet: it counts only if the rep filed stats. The darker reds only make the shift-cost check list the
  rep for Alan. On the feed of 2026-10-27: red names 12 (May-Sep 2026), 14 (Sept-Feb 2026), 1 (Jan-May 2027); blue names
  0, 0 and 10 (two shows already marked Booked, likely last year's cells).
- **Field training:** "(ft. Name)" after the lead rep; the lead rep is outside the parentheses everywhere.

## What has to change before January 13

Each item is a must for the first meeting on the board unless it says "later".

1. **A shift saved at a meeting can't erase another one.** Today a slot save (`setSlot` in index.html) copies the show's
   `booths` from the page's own copy, changes one slot and writes all of `booths` back. Two coordinators putting names
   into the same show within a second or two of each other (before realtime reaches the second page) means the later
   save puts the earlier slot back as it was: one pick is gone, with no error. Found in the code, not seen happen (nobody
   but Alan edits today). Fix: a database function that sets one slot only if it still holds what the coordinator saw,
   and otherwise says who just took it; the other whole-`booths` writes (add or remove a booth or a shift row, a date
   move) re-read the row first, the way the kiosk days already do.
2. **What the colors and columns say gets a home on the board** (the mirror writes it back the way the readers expect):
   - a "didn't work" mark on each shift, set in Plan mode; the mirror paints that name red;
   - Key / Traditional / Elite already live on the board as `tier`; the mirror paints the title black, teal or purple
     (purple reads Key to the picking order and Elite to the analyzer, which is what each wants);
   - column C: the board's own status from now on, and the free text in it today moved once into each show's team notes;
   - column A "MF": the board carries it (`flag`) but can't edit it.
3. **Every edit the team makes on the Sheet today can be made on the board.** Already there: add a show, remove one (two
   taps), add or remove a booth or a shift row, a name with field-training helpers, "no shift this day", dates, status,
   cost, notes, Never work again. Not yet tried by anyone but Alan: a meeting's pace, two coordinators at once, adding a
   day (an SE day, a Thursday) to one booth, and the board on a projector. The practice session (below) is how that gets
   checked.
4. **Matt, JP and Cameron sign in** on the device each would use at the meeting (on an iPhone, the Home Screen icon) and
   make some real edits before January. The holiday kiosks (Nov 27 - Dec 27) live only on the board already, so
   staffing them there is practice with nothing on the Sheet to fall out of step with.
5. **The jobs that need a Sheet sync stop needing one on January 13.** rsd-shift-picking's booking sweep
   (`run-booking-sweep.sh:104-118`), preflight (`run-preflight.sh`) and shift cost (`run-shift-cost.sh`) each stop with "no
   Sheet sync report for today" when that day's `out/reports/sheet-sync-<date>.json` is missing. With the sync off, the
   booking sweep's first real run (January 15) and the twice-daily shift cost would stop. From the cutover date each asks
   for the day's mirror report instead (written, read back, not stopped). All of this, and every item below, keys off one
   date in config, so nothing changes early:
   - `sheet-sync.mjs` refuses to run on a book the mirror owns, so the two can never run at once (a two-way sync);
   - the coverage agent stops emailing rsdcoordinator2 to change the Sheet and stops its "did the Sheet catch up" check (the
     baseline it reads stops changing, so every check would end "never caught up"); the board is the record;
   - rsd-shift-picking's Start Date fills (`data/schedule-date-fills*.json`) match on name and Sheet row, and the mirror lays
     out its own rows, so a fill could land on another Mesa row with the same name: none applies to a mirrored weekend, and
     `tools/date-fill-impact.js` skips them (the mirror writes the board's dates, so they are not needed there);
   - SUNNY points reps at the board, not the Sheet, and the board page's "Sheet row" link goes (or points at the row the
     mirror wrote).
6. **The old `event-check` account skill is removed** (Alan's step): it is the one thing that ever wrote the Sheet, and a
   hand-run of it would type into the mirrored rows.
7. **Later (stage 4, not needed on January 13):** stable rep ids instead of nicknames. The mirror writes each name as the
   board stores it (the roster's spelling); whether every reader still places every name that way is one of the things
   the parallel run checks.

## The mirror

**What it owns.** Every weekend from January 15, 2027 on, in both books that carry it: the Jan-May book's `2027` tab, and
the Sept-Feb book's `2026` tab from that weekend through February. The two get the same rows. January and February sit in
both books, and rsd-shift-picking keeps each show from the newest book, so a show taken off the board but left in the
older book would still count for the reps on it. Everything before January 15, every older tab, the header rows, the
titles, the tab names and order, and link sharing stay exactly as they are (the readers find the season, the newest book
and the first year tab from them). From the May 2027 meeting it also owns the summer, in the May-Sept book, until
rsd-shift-picking reads the board (August).

**How it lays the rows out.** The Sheet's own grammar, written the same way every time, in a form every reader above
accepts: a "Weekend 01/15" banner (two-digit month, slash, in column B: the only form count-mesa, calendar-sync, the
picking order and the board's parser all read); then for each show an event row (A flag, B level or "Elite", C status, D
Best CPO, E name, F-L the day labels as weekday text ("Friday", "Saturday SE"; a date there breaks the analyzer), M cost,
N Start Date, O End Date, P city, Q venue, S-W promoter and contact columns as today, Z VC status, AA VC number); a booth
row per named booth; a "Shift N" row per shift row with the names under their days ("Name (ft. Helper)", "X" for no
shift). Fonts: the title by tier, a name red when marked "didn't work", everything else black. Shows keep the order they
last had on the Sheet, new ones after them. It does not copy the team's mistakes (spilled columns, stale date cells,
stray text), which is why a cell-for-cell match with today's Sheet is the wrong test (below).

**How it writes.** One write per run with the Google Sheets API, replacing only the rows it owns, with a key held on the
mini (600, in REGISTRY.yaml) and a code allow-list of the three file ids. In order:
1. Render the board into a grid. Parse that grid in memory with the board's own `parse-sheet.mjs` and with
   rsd-shift-picking's `lib/schedule.js`; both must give back exactly the board's shows, days, names and colors, or nothing
   is written and #rsd-alerts says why (a renderer bug never reaches the Sheet).
2. Read the owned rows as they are and compare them with what the mirror last wrote. Anything typed there since (someone
   forgot and edited the Sheet) is posted in #rsd-board with the cell and what it said, so it can go on the board; the
   board still wins.
3. Write, then read the rows back (values and font colors) and check they are exactly the grid. Success is the read-back,
   never the API's answer. The run's report (`out/reports/sheet-mirror-<date>.json`) is what the gated jobs in item 5 read.
4. The sync's guards: more than 40 shows changed since the last write stops it (exit 3; read the report, then `--force` by
   hand on the mini), a lock so two runs never overlap, a `MIRROR-PAUSED` file in the repo root, every run recorded for the
   page's sync line.

**When it runs.** From the sync listener (`com.allinalan.rsd-board-sync`, every 30 s) once the board's changelog has a
show change newer than the last write and nothing has changed for 2 minutes (a meeting is a burst of edits; it writes
when they pause), and at 06:45 and 18:45, ahead of the picking order's 07:00 and 19:00 pulls, changed or not.

## The parallel run and the exit test

The roadmap's test was "the copy matches the Sheet cell for cell." It can't and shouldn't: the team's Sheet has spilled
columns (`SHEET_REPAIRS`), stale date cells and stray text that the parsers read around. The test is what the readers
see: for every weekend the mirror will own, each reader's own parse of the mirror equals its parse of the real Sheet.

From December 1 the mirror writes **copies** of the two books (spreadsheets of their own that nothing reads) after every
hourly Sheet → board sync. A diff then runs each reader on the real book and on the copy: `parse-sheet.mjs` (the round
trip Sheet → board → copy), rsd-shift-picking's parser and roster match (who works which shift, Key or Traditional,
dead, tentative), the analyzer's tier hint and event rows, and the count-mesa and calendar-sync patterns. A difference
goes to #rsd-board once a day with the show and the field. Fixes go into the renderer or onto the board, never into a
reader. Some differences are the mirror being right (a weekday where the Jan-May book has a date, a stale 2025 Start
Date); each of those is named in the daily note once and then set aside by show.

**Exit test:** 14 days in a row with no unexplained difference, ending no later than **January 6, 2027** (the date
research runs that day). That is the go / no-go. No-go means January 13 runs as the roadmap's old dress rehearsal (Matt
and JP on the Sheet, Alan entering the same picks on the board) and the flip waits for the May meeting.

## Cutover

- **Jan 5-8, practice:** thirty minutes with Matt, JP and Alan on the board, on a practice show on a far weekend (removed
  after): names in fast, two people on the same show at once, add a day, add a booth, field training, "didn't work", the
  projector view. What's slow or missing is fixed before the 13th. The same week, a dry run of the morning: the handover
  preview the tick already asks for (`sheet-sync.mjs --date 2027-01-13`) and the mirror's first real write, dry.
- **Jan 12, evening:** the last Sheet → board sync of both books, read back. From then on what is typed on the Sheet does
  not reach the board.
- **Jan 13, before the meeting:**
  1. the handover sync and its read-back;
  2. the cutover date in config switches the Sheet → board sync off for good, the mirror onto the real books, and the
     gated jobs onto the mirror's report (item 5);
  3. the mirror's first real write, read back; the Picking Feed pulled and rsd-shift-picking's parse compared with the
     board;
  4. a line above the owned rows: the board's link, and "written by the board; what is typed here is replaced";
  5. the owned rows protected so only Alan's account can type there.
- **The meeting** runs on the board. The mirror writes as picks pause; nobody waits on it.
- **After:** the mirror read back once the meeting ends; the 19:00 pull parsed and compared with the board; the booking
  sweep (Jan 15) on the mirror's report; the Wednesday Jan 20 event check with no Sheet sync.

## Timeline

| by | who | what |
|---|---|---|
| Nov 8 | Matt, JP, Cameron | Signed in on their meeting device; some real edits (the kiosks). |
| Nov 8 | Alan | The answers below; one Allow click for the mirror's Google key; the old event-check skill removed. |
| Nov 8 | Claude | Safe slot saves on the board (item 1), with tests; deployed and read back. |
| Nov 29 | Claude | The mirror (render, write, read-back, guards) and the reader diff, writing copies; the board fields in item 2; the January 13 switches in item 5, built and off. |
| Dec 1 - Jan 6 | the mini | The parallel run; 14 clean days by January 6. |
| Jan 6 | Alan | Go / no-go. |
| Jan 5-8 | all three | Practice; the dry run of the morning. |
| Jan 12-13 | Claude, on the mini | The cutover. |
| May 2027 meeting | | The second meeting on the board; the mirror takes on the May-Sept book. |
| May - Aug 2027 | | Stage 4 as the roadmap has it, rsd-shift-picking last. |

## Questions (answered 2026-MM-DD)

Defaults first; "all defaults" is an answer.

1. **The weekends it owns:** January 15 on, the same rows in both books that carry them, everything earlier left as the
   team left it. Default: yes. Why: the picking order keeps a show from whichever book is newest, so both have to agree.
2. **Red names:** a "didn't work" mark on each shift on the board, painted red. Default: yes.
3. **Blue names:** not carried. Default: not carried. Why: no current book uses them (ten on the Jan-May book look like
   last year's), and the booking status is on the board.
4. **Column C:** the board's status from January 13, and today's free text moved once into team notes. Default: yes.
5. **Column A "MF":** what does it mean? Default: keep it as a tick on the board that the mirror writes back.
6. **Promoter contacts** in the mirrored rows, as the Sheet has them today. Default: keep writing them. Why: nothing changes
   for anyone still opening the Sheet.
7. **Google access for the mirror:** a Sheets key on Alan's account (one Allow click), limited in code to the three files.
   Default: that. The other way is a service account shared on only those files: narrower, more setup.
8. **The lock on January 13:** the owned rows protected so only Alan's account can type there, set by the mirror on his
   go that morning. Default: yes.
9. **Go / no-go on January 6**, with the dress rehearsal as the fallback. Default: yes.
