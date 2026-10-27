# RSD Show Shift Board

The Rising Sun Division's event schedule: every show by weekend, who's staffed, what's booked,
what it costs, what it did last year. Reps read it; coordinators (Alan, Matt, JP) edit it; the
routines in `.claude/skills/` keep it true.

## Shape

- `index.html` — the whole app, one file, no build. Deployed by GitHub Pages from `main`.
- `manifest.webmanifest`, `icons/` — the iPhone Home Screen app ("RSD Board"). An icon keeps its own
  sign-in, apart from Safari's, and Safari's seven-day wipe of site data doesn't touch it.
- `supabase/email-templates/magic-link-or-otp.html` — the sign-in email exactly as set in Supabase
  (subject in its header comment). Restore it from here on a rebuild.
- `config.js` — Supabase URL + anon key for this deployment (public by design; RLS guards writes).
- The **Kiosk Schedule** tab (Alan, 2026-10-14): the holiday mall kiosks, one `kiosks` row per mall per season, one
  shift per mall per day. Read the data model below before touching it. `seed/kiosks.json` is the 2025 mall sheet
  (`2025 Mall Schedule - AZ.xlsx` on Alan's Drive) as worked, plus 2026 as set up that day: Chandler Fashion Center
  ($7,000) and Arrowhead ($7,300), Sierra Vista and Cielo Vista Mall rolled from 2025 as Prospective, Kierland new and
  Prospective ("we are not in yet"). Park Place Mall is out, 2025 included (Alan, 2026-10-14). Nov 27 - Dec 27, Christmas
  closed. In plan mode the captain is picked from each mall's column header and the name there opens the mall to rename.
  A wider screen gets the table (`.kgrid`); a phone gets **one mall at a time** (Alan, 2026-10-14: "I need to be able to
  see it by mall not by date"; it replaced a by-day list the same day): mall buttons, the mall's card (status, captain,
  cost, filled/open), then its days down the page (`.kmv-top` / `.kmv-days`, `kMallTop` / `kMallDays`). Both rendered,
  one shown by CSS at 640px. The mall picked is remembered on that device by base (`store.kMall`, carries into next
  season); first visit = the first booked mall. On a phone the kiosk day and captain pickers are a sheet from the bottom
  (`#pickpop.sheet`): the day tapped scrolls to the top, the board's sticky header lets go while it is up, so the run
  shows above it; names in two columns; no keyboard until the name box is tapped; it rides above the keyboard
  (visualViewport). In season the days already gone fold away so it opens on today; names under "Tap your name" are alphabetical; the header tags only what isn't Booked. UI pass the same day: phone
  targets 38-44px, a redraw keeps keyboard focus and half-typed card fields (`kFocusKey`), the season tabs scroll on a
  small phone instead of pushing Never off screen, and the captain is the same picker on the card and header. **Days in a
  row** (Alan, 2026-10-14: fill a name in for several days without picking each one): the day picker's 1-7, or "Pick the
  last day" and a tap on that mall's later day. What lands on the day tapped (a name, a split, Closed) lands on every open
  day after it; a day someone has or a closed day is skipped and named in the toast, never overwritten (decided on a fresh
  read). The run lights up before anything saves (the picker opens beside the column where there's room), saves as one
  write, is read back, and Undo (12 s) restores only the days it changed that nobody has touched since. Taking someone
  off is still one day. `setKioskRun` / `undoKioskRun` in index.html. Removing a
  mall is two taps, armed in the page (rule below). After the delete the page reads the row back, so "Removed" means removed. `board kiosks` lists them; `board kiosks seed` adds the
  seed's malls the board lacks and never touches one it has.
- `seed/*.json` — the data as of the migration off the Google Sheet. Also what the page shows
  when `config.js` is blank (read-only preview). `seed/private/` (gitignored, mode 600) holds the
  promoter contacts; it exists only on the mini.
- `supabase/schema.sql` — tables, row-level security, the `editors` list, `merge_doc`, changelog.
- `scripts/board.mjs` — the CLI every routine uses. `node scripts/board.mjs` prints usage.
- **The roster follows the rep master list** (Alan, 2026-10-21: "update the show shift board roster too (make that
  automatic)"). Every morning the tick pulls `~/automations/rsd-rep-master-list` and runs `board roster sync --apply`
  (`scripts/lib/roster-sync.mjs`): a name tied to a rep who LEFT moves from `settings.roster` to `settings.former`; an
  active rep in a board tier (Elite, Varsity, JV, Freshmen, Coordinator, and Leader since Alan's yes for Luke Mills the same day) with no name gets one (an alias of
  theirs, else the first name, else "First L.", only a name that ties back to them alone); a name the master list cannot
  tie to anyone (Carlton, Nathaniel on 2026-10-21) is left alone and named; a rep who rejoins gets their old spelling
  back. It never renames: every shift is stored as the roster spells it. Ties by letters only (case and punctuation
  ignored): name or alias first, then a first name, "First L" or "F Last" that fits exactly one rep. Refused, nothing
  written (exit 3, an alert): fewer than 10 active reps in the master list, or more than 12 names off at once (`--force`
  by hand). Written through merge_doc and read back. One FYI line in #rsd-board when it changed. `ROSTER-PAUSED` in the
  repo root stops this step alone. By hand: `node scripts/board.mjs roster sync` (dry) / `--apply`. The Sheet sync and
  the parser count `former` as known, so a leaver's old shifts are never "names the roster cannot place"; Division
  settings keeps `former` through a save, and says the roster is kept in step every morning. First run 2026-10-21: the
  nine fall freshmen marked left that day moved to `former` (41 names -> 32).
- `scripts/check-public.mjs` — the pre-commit leak check (this repo is public).
- `scripts/parse-sheet.mjs` — reads the Sheet into board shape while the Sheet is still the truth
  (stage 1). `--verify` lines the parse up against `seed/events.json` field by field and exits
  non-zero if a structural field has drifted; `--diff` is the change report. Needs SheetJS from a
  sibling project, or `--grid` with a pre-dumped grid. Since 2026-10-23 (the Jan-May book): a weekend header
  that lands on another day means that week's Friday (the Jan-May 2027 book kept 2026's headers from March on);
  set-up text in a rep cell ("set-up 11-7", "SET UP DAY") is no shift (`__X__`; Alan: set-up is never a shift);
  the "Service Events" row is not a show; column B "Elite" is kept as `tierTag`; `--season-year` (the Jan-May
  2027 book, tab 2027, is 2026: January-July headers are the year after) and `--date-labels weekday` (that book's
  day cells hold earlier years' dates). Read the Sept-Feb book exactly as before (checked cell for cell). **Every book
  reads date cells as weekdays since 2026-10-27** (config `dateLabels`, Alan's go): seven Sept-Feb rows held a 2024 date
  formatted to show as the weekday, so the team saw "Friday" and the board got "1/26/2024", a day the page cannot place
  (Grid hid it and still counted it open; Casa Grande Gun Show sat on the 10/30 weekend as "Open 3" after it ran Oct
  10-11). Those seven were corrected on the board the same day (actor `service:date-labels-fix`; Bluegrass on the Beach
  also got Zach's Friday and Mon SE back, lost in the 2026-09-24 date move). Parsing that day's book both ways changed
  those seven and nothing else. The parser's default is still `keep`, so `--verify` lines up with the seed. Since
  2026-10-24 (the May-Sept book): `--season-start-month` (5 for a May-Sept book: every header from May on is
  `--season-year`), a header row below row 1 ("Event Description") and a status word typed into a shift row's label
  ("Booked") are not shows. Also since 2026-10-24: a "Booth ..." typed in column B of a shift row, with no booth row
  above it, starts a named booth (Maricopa Summer Home & Landscape writes "Booth #301-303" beside Shift 1; its six rows
  had fallen into one unnamed booth). Under a booth row of its own, column B only repeats it. No other show in the
  three books changed (checked by parsing each before and after).
- **The May-Sept 2026 roll-in** (Alan, 2026-10-24: "upload also events from this link without names to 2027"; config
  `rollIns`). The May-Sept book's newest tab is last summer's (May 1 - Sept 25, 2026), so it was rolled into 2027
  **once** and is **not synced** (the 2027 summer schedule goes on the board at the May 2027 meeting, stage 3):
  `node scripts/sheet-sync.mjs --roll-in may-sept-2026` (dry), then `--apply`, after the Jan-May first load (it refuses
  before). Same rules as the March-May load: Prospective 2027 shows with no names, days a year on marked estimated,
  rows marked out (adds "do not work again") Cancelled, Elite kept, "moved to ..." rows skipped. Left alone: shows the
  board already has in 2027 on that weekend (the Jan-May book's May copies), and from `fallFrom` (2027-08-27) every show
  the board has in fall 2026 on any weekend: those come into 2027 with their history and the fall book's newer dates
  when 2026 is rolled forward (board Roll forward / `board.mjs rollforward 2027`). `state/roll-in-may-sept-2026.json`
  lists what it made; a second run refuses. Rehearsed 2026-10-24 on a copy of the board: 69 new (1 Cancelled), 16
  already there, 41 left to the roll-forward, 1 skipped. Its untouched shows count as rolled for the research cut-off
  (below): the 31 that start after early July 2027 are not looked up for the January meeting.
- **Maricopa booth spots** (Alan, 2026-10-24: "copy over the actual BOOTH names when rolling over ... until it gets
  fixed"). A Maricopa County Home Shows booth name is a spot on that show's floor plan ("Booth #2 (Ag Building)
  (820/822) (8x20 Corner)"). Every roll (the board's Roll forward, `board rollforward`, the Sheet sync's first load and
  roll-in) carries the name and tags the booth `rolledLabel` (the name as rolled) + `rolledLabelYear` (the year that spot
  was for). The page shows "2026's spot" beside the name while the name still says exactly what was rolled, so a rename
  anywhere (the board, the Sheet sync, a lookup) clears it with nothing else to know; in Plan mode "same spot in <year>"
  drops the tag and keeps the name. A name nobody fixed keeps its original year through the next roll. Which shows:
  config `boothSpots` (Maricopa, not the Maricopa County Fair), mirrored in index.html `SPOT_RULE` (the tests hold the
  two together). `scripts/lib/booth-spots.mjs`. Applied by hand the same day (actor `service:maricopa-booths-fix`): the
  July 2027 Summer show rebuilt as its three booths, and the April 2027 Home & Flower show's three names tagged as 2026's.
  **This year's spots come off the promoter's floor plans** (Alan, 2026-10-26): `scripts/maricopa-booths.mjs` reads
  the public plan PDFs (config `maricopaMaps`; no password, the vendor page is not involved), finds every "Cutco" and
  the booth numbers at its box's corners (pdftotext word places, plus the rendered page to see a wall between the
  name and a number), names the area from the venue's number ranges, and with `--apply` renames only booths still
  tagged as last year's spot (a booth already holding the plan's numbers just loses its tag). A name set this season
  is reported, never overwritten; a count that doesn't match, or a Cutco with no number, writes nothing for that
  show. Needs poppler (Homebrew). Hand-run; not scheduled. First run 2026-10-26 (actor `service:maricopa-booths`).
  Details and what the 2027 plans said: `docs/maricopa-booths.md`.
- `scripts/sheet-sync.mjs` — the Sheet -> board sync (stage 2 of the roadmap, live 2026-09-23). **Two books since
  2026-10-23** (Alan: "upload the Jan-May 2027 sheet"): the Sept-Feb and Jan-May schedules are separate Google Sheets
  that both carry January and February (config `sheets`). Each weekend is fed by one book only: until the January
  13 meeting the Sept-Feb book feeds through February and the Jan-May book from March 1; from that morning
  (`handover.on`) the Jan-May book feeds from January 1. Each book has its own baseline
  (`state/sheet-baseline-<key>.json`); the Jan-May book's January-February part stays as it was read on its first
  load (2026-10-23), so on handover morning only what the team changed in that book since then comes over: Alan
  settled the six shows the books disagreed on that day (Gold Canyon keeps J. Parker; Foss stays on the Arabian
  Horse Shows; Foss off Downtown Chandler Saturday; the Boat, RV & Outdoor Expo has no Thursday shift, J. Parker
  Friday-Sunday), and those stay as he set them. `state/sheet-baseline.json` is now every book's current part in one
  file (each entry tagged `book`, plus once each show no book feeds any more), kept for rsd-shift-picking's coverage
  agent. A run reads every book and writes all of them or none; a book with no baseline stops it (exit 5). **One show,
  one book**: a row matching a show another book feeds today is not linked (flagged; it links once that book lets go),
  and two books writing the same show in one run stops it (exit 6). A show a book stops feeding at the handover that no
  other book carries (Casa Grande Home & Backyard and Tri-State Home & Garden were Sept-Feb-only on 2026-10-23) is
  flagged once: nothing syncs it after that. The tick says "preview the Jan-May handover for the board" the day before
  `handover.on` (run `sheet-sync.mjs --date <handover>` dry and fix what it would stop on). On handover morning the
  shows coming in from the set-aside part are not counted by the drift guard. `--book <key>` runs one book alone. The first load
  (`--first-load <key>`, dry, then `--apply`; once) brought the Jan-May book's March-May rows on as 2027 Prospective
  shows **with no reps** (every name there was 2026's), days from the header marked estimated, column B/C "no
  dates / cancelled / declined / not allowed / territory" as Cancelled, column B Elite as Elite, and the
  `firstLoad.skip` rows (last year's copies of shows already on the board) left off; the cells it cleared are in
  `state/sheet-stale-<key>.json`, kept **by board show** (a rename on the Sheet does not set them loose), and read as
  empty while they still say the same thing. Once the Sheet says anything else in that cell (a blank included) the
  entry is used up, so a name the team writes over one, or types back after clearing it, comes over; an untouched one
  never does (a rep who re-picks the exact slot they had in 2026 only shows once the cell is cleared and typed again;
  each report lists the names still held back). A skipped row stays skipped if renamed or moved, and a new row that
  carries the names of a show gone from that weekend is held, not created (likely that show renamed past recognition).
  When a show was added on both the Sheet and the board, what they disagree on stays a conflict every run (before
  2026-10-23 the Sheet's value quietly won on the second run). Expect a stop when Matt and JP rebuild March-May for 2027:
  more than 40 shows changed at once is exit 3 (read the report, then `--force` by hand on the mini); their date and
  cost fixes on rows still carrying last year's dates are not counted as parser drift. Three-way:
  the Sheet now vs the Sheet at the last sync (the book's baseline, gitignored, 600) vs the board
  now. Carries shifts added/removed/re-staffed, shift rows, new events and event details; never status
  (VC's), never promoter contacts (edited on the board: the parser misreads spilled contact cells). VC
  wins: a rep added to a VC-dead show, or a date moved away from a VC booking, is held; an event deleted or
  moved on the Sheet is flagged, never deleted or duplicated. Board edits win ties (both changed = held,
  named in the report; both changed to the same thing, shift rows included, = settled). Two identical rows for one market on one day are one event (the extra row is reported,
  never added); a start date weeks away from the event's own banner-resolved days is a stale cell and is never
  copied, and a blank Start Date cell never blanks the board's; board dates marked `datesEstimated` are a placeholder
  the Sheet's real date replaces (and clears "est."); column C (`sheetStatus`) always carries, the board never edits
  it. Stops on parser drift (exit 2) or an oversized change set (exit 3). Dry unless `--apply`. `--apply`
  takes `state/sheet-sync.lock` first (a second run waits up to 3 minutes, then exits 4) and records its outcome
  in `sheet_syncs` for the page (best effort). With no VC pull (the button's and the hourly runs) a date moved on a
  show VC has a record for is held for the Wednesday run. `--tag` names the report `sheet-sync-<date>-<tag>`, so
  the Wednesday report the event check reads is never overwritten. `--via button|auto` makes the actor
  `service:sheet-sync:button` / `:auto` in the changelog and the record.
- `scripts/sync-requests.mjs` — the mini's half of the board's **Sync from the Sheet** button (Plan mode, editors
  only; Alan, 2026-09-28: the team re-staffs on the Sheet and wants the board to show it now). launchd
  `com.allinalan.rsd-board-sync`, every 30 s: reads `sheet_syncs` for pending rows (idle = one read, no output),
  claims them all, runs `sheet-sync.mjs --apply --requests <ids>` once, and puts rows back to pending when the
  lock is busy or marks them failed when the sync died. With nothing pressed it is also **the hourly sync**
  (Alan, 2026-09-28): from config `sync.auto.from` (2026-10-15, the day after the third clean Wednesday), inside
  `sync.auto.hours` (7am-9pm Phoenix), when the last finished run of any kind is over `everyMinutes` (60) old. A
  run that stopped pauses it until a sync gets through; `from: null` turns it off. Kill switch: `PAUSED`
  (requests wait, not lost). Log: `logs/sync-requests.log`, one line per sync; an outage is logged once, and
  again when it clears.
- `scripts/event-check.mjs` — the Wednesday Event Check against the board, unattended: matches every
  staffed non-Mesa event to a VectorConnect My Events pull (`scripts/lib/match.mjs`: VC number first, then
  name + shared distinctive word + date gate, aliases/rejects in `config/event-check.json`, Queen Creek by
  exact date, placeholder 00092192 never books a date, duplicate-number audit) and writes vcStatus /
  vcNumber / status / dead back (past events: vcStatus and vcNumber only), **and the cost** (Alan, 2026-10-06: "Rule is
  to ALWAYS go off of VC"): a matched show's `cost` / `costNum` become VC's Event Cost in whole dollars, past or upcoming,
  with `costSource: VC` and the old figure in `costWas`. Not when VC has no cost yet, not when several board rows share
  one VC record, never Mesa. **Mesa** (Alan, 2026-10-14: "Mesa should be listed as an event"): VC keeps one Mesa
  record per calendar month, so each Mesa weekend gets that month's `vcNumber` / `vcStatus`, plus `vcMonths` (day
  ranges, each with its month's number) when the weekend runs into the next month; status, cost and reps are left
  alone and Mesa is still never judged or texted about. The report names the months VC does not show as Booked and the
  months with no record yet. SUNNY reads these to give a rep the number to tab a Mesa order under. From then on the Sheet sync leaves that cost alone (the Sheet's cost cell no longer carries
  and is never a conflict). More than `checkWrite.maxCostChanges` (80) differences in one run changes none and says so. Alan's global "not-worked" rulings
  (rsd-shift-picking data/event-rulings.json, `--rulings`) outrank VC: the show is dead on the board, VC's
  status is kept beside it, and the rep text uses the ruling's repReason. Refuses to write when the pull
  is too small (exit 4) or lacks the board's own VC numbers (exit 5). **Booked in VC, not on the board** (Alan,
  2026-10-26: the March 5-7 Maricopa show was Booked in VC, on no Sheet, and nothing noticed): every upcoming VC record
  whose status starts "Booked" that no board show of any year claims (by VC number, or the usual name-and-date match,
  staffed or not) is listed in `flags.bookedNotOnBoard`, and one the board has under the same name within 60 days on
  another weekend carries that show (`board`: a date to fix, not a show to add). Never listed: Mesa, the placeholder, a
  mall kiosk (the kiosks table), a record in config `vcOnlyOk` (by number or name pattern; the reps' own Service & Sales
  events by default), anything outside the division (config `division`, Alan 2026-10-26: Arizona, New Mexico and El
  Paso, by VC's state field; Mecum Kansas City and Laughlin NV are off). Both lists are in the report and in Alan's
  Wednesday text. It writes nothing. Writes `out/event-check/latest.json`
  (read by rsd-shift-picking's texts), the workbook and a summary under `out/reports/`.
- `scripts/fill-dates.mjs` — a show with no Start Date gets one (Alan, 2026-10-06), run by rsd-shift-picking's
  `run-event-check.sh` right after the event check (stage 3b). In order: the show's own day columns (the Sheet's weekend
  header, already on the board as booth dates), then VectorConnect's dates for its record, then a page online
  (`--research`, rsd-shift-picking's research-events.js; at most $3 a week there, each show looked up once). Writes
  `startDate` / `endDate` with `startDateSource` (sheet-days | vc | web); a VC or web date also gets the usual `datesNote` /
  `datesSource` ("VC dates" / "checked" on the page). Never searched: golf and builder shows (`--skip-names`), Elite
  (`--skip-tiers`), a junk row name, an untouched rolled show more than 183 days out (below); those stay blank and are
  listed. The day columns are never touched and the Sheet is
  never written. More than `fillDates.maxAtOnce` (60) fills at once writes none (exit 5). Output
  `out/fill-dates/latest.json` and `out/reports/fill-dates-<date>.md`.
- `scripts/booking-sweep.mjs` — the board's half of the post-meeting booking sweep (2026-09-23), run by
  rsd-shift-picking's `run-booking-sweep.sh` (launchd com.rsd.bookingsweep, days 2-8 after a meeting) right after
  a fresh event check and the date research on every VC disagreement (below). Sorts every staffed upcoming show:
  request (VC has no record), email (VC: Prospective), question (a date disagreement still standing: with
  `--research`, whether the show's own page backs the board, so VC is the one to fix, or the lookup failed; board
  selling days inside VC's run are fine), hold, pending, excluded (Alan's direct shows, and any show whose tier is in
  the exclude file's excludeTiers: Elite since 2026-09-24, the team books those itself), and sponsored (a show under a sponsorship named in the
  exclude file, e.g. a market season Alan sponsors: never requested, emailed or asked about until its `until` date).
  Writes nothing since 2026-09-24 (dates are the research's job). Output `out/booking-sweep/latest.json` (600: it carries promoter contacts for VC's form) and a report.
  rsd-shift-picking turns it into Alan's approval batch, submits the requests in VC after his "approved", and marks
  each one `status: Booking Request Submitted` + `vcRequestedAt`. The event check keeps that status 14 days
  (`requestPendingDays`) while Olean works it.
- `scripts/board-research.mjs` + `scripts/lib/dates.mjs` — researching shows on the web (Alan, 2026-09-24), the
  board's half; rsd-shift-picking owns the Claude API calls (web search), the texts and the email. `targets`
  lists what to research (`--mode dates|full|mismatches`: every upcoming live non-Mesa show, or only the ones whose
  board days are not inside VC's run; `--skip-tiers Elite` leaves out, and counts, the tiers the team handles itself; `--skip-names golf,builder` the shows Alan
  spends no search money on, 2026-10-06; a show rolled forward (the board's roll, `rolledFrom`, or the sheet-sync
  roll-in, `createdBy service:sheet-sync:roll-in`) that nobody has touched since (dates still estimated,
  Prospective, no VC number, no reps) and that starts more than `research.rolledLaterDays` (183) out is left out and listed
  as `rolledLater`, Alan 2026-10-24: a roll must not spend the next meeting's research money or trip the 25-move limit;
  `rolledForLater()` in lib/dates.mjs, shared with fill-dates);
  `apply` takes the findings and writes the board. Alan's date rule: the date
  a page states for this edition wins (quote and URL kept); nothing found online and VC disagrees = VC's dates,
  with `datesNote` on the board saying so; a failed lookup changes nothing; a cancellation is reported, never
  written; multi-week shows are never moved; more than 25 moves at once moves none (exit 5). When the page backs the
  board and VC's run does not cover it (VC holds one day of two), the report says VC is the one to fix. Each show is
  looked up once (rsd-shift-picking keeps the findings and reuses them; `counts.reused` says how many). A move
  (`planMove`) keeps reps on days that still happen, carries a rep to the same weekday in the new run, and reports
  the reps whose day is gone (they get a text through Alan). Since 2026-10-27 (Bluegrass on the Beach 2027, moved
  2026-09-24, had Zach's Friday parked on a hidden column and his Mon SE dropped unreported): a day with no date whose
  label names a weekday ("3/1/2024", "Friday (SE)") is read as that day and moved like the rest; an SE day keeps its
  weekday beside the run (a Mon SE after Fri-Sun stays the Monday after), and one with nowhere to go is reported with
  its reps; a column that names no day stays as it was and is listed in the report ("Days a move could not date").
  The preflight (`--mode full`) also fills blanks and
  corrects venue/promoter/website/application from official pages; an existing contact, cost, address or
  indoor/outdoor answer is only reported, never overwritten. Every move writes `datesNote` (shown on the board as
  "checked" or "VC dates"), `datesSource`, `datesMoved`. Output `out/research/<label>-<date>.json` (600) and a
  report without contacts. Runs: the date research 7 days before a meeting, the preflight 2 days before
  (rsd-shift-picking com.rsd.preflight), and the booking sweep's disagreements.
- Both run from rsd-shift-picking's Wednesday 08:00 job (`run-event-check.sh` there), which owns the VC
  login (Playwright + Keychain; this repo has no node_modules) and all texting. `scripts/lib/board-api.mjs`
  is their REST layer (same env file and changelog path as board.mjs).
- `deploy/tick.py` — the launchd entry point (`com.allinalan.rsd-board-tick`, 07:00 daily on the
  mini): keeps `settings.roster` in step with the rep master list (above), then decides what is due and notifies Alan.
  It does not run routines. `--dry`, `--status`. Wednesday is
  no longer "due" (the event check runs unattended); the date research (7 days before a meeting), the preflight
  (2 days before) and the booking sweep (days 2-8 after) are marked `auto` (they run themselves from
  rsd-shift-picking), so they are logged, never a "go run it" notice. It reminds Alan to send the freshmen training sign-in
  sheet two days after a January/August meeting (Jan 20 / Aug 15 when none is set), and wakes Messages with a cheap
  read before texting (a cold Messages after the 2026-09-22 reboot timed out the 2026-09-23 notice). The Dec 28
  "add the Jan-May book" reminder is gone: the sync has followed both books since 2026-10-23.
- `install.sh` — preflight + both plists (the tick and the sync listener), disarmed by default; `--arm`, `--disarm`,
  `--check` act on both. The preflight also checks SheetJS and that `sheet_syncs` exists.
- `scripts/lib/is-main.mjs` — `isMain(import.meta.url)`: "is this file the script node was started with?", by real path.
  Every script that is both run and imported guards its `main()` with it (rule below).
- `tests/run-all.mjs` — CLI, launcher, Sheet-parser, matcher, sync and event-check tests against an in-memory fake database. Run before every commit.
  Each block is a `section()`: one that throws is a single named failure, the blocks after it still run, and the count
  always prints. `./install.sh --arm` refuses while this fails.
- `docs/ROADMAP.md` — the staged plan to replace the Sheet by Fall 2027. `docs/stage-3-january.md` — stage 3 moved to the
  January 13, 2027 meeting (Alan, 2026-10-27): what the board still needs, the board → Sheet mirror, the parallel run, the
  cutover. `docs/HANDOFF.md` — go-live steps.
- `.claude/skills/` — the routines: `board-tick` (daily), `board-preflight` and `board-booking-sweep` (hand-run fallbacks),
  `board-event-check`, `board-rollforward`. They lean on the account skills
  `vectorconnect-booking-request`, `event-check`, `vectorconnect-event-export`, `humanizer`.

## Data model (one table per collection; row = `{ id, data jsonb }`)

`events` — an event in a year. id `YYYY-<base>`; `base` is stable across years so `history/<base>`
follows the show. Fields the routines care about: `name, year, weekend (Friday ISO), startDate,
endDate, datesEstimated, datesNote, datesSource, datesMoved, status, vcNumber, vcStatus, tier, access, cityState, location, address,
setting, promoter, contact, phone, email, website, cost, costBasis, applyUrl, applyOpens, applyBy, applyOpensSource, applyBySource,
submissionNotes, notes,
booths[{label,days,dates,shifts[{label,slots[{rep,ft[]}]}],rolledLabel?,rolledLabelYear?}], dead, skipNext, neverWork`.
`source` says what made the row (`board`, `sheet-sync`); the page treats every database row as a board show whatever it
says (until 2026-10-24 a `sheet-sync` row was read-only there: 166 shows, both 2027 Maricopa home shows among them).
`event_contacts` — promoter `contact, phone, email` per event id. **Public on purpose, not just to
people with the link**: the select policy is open, so anyone with the anon key in `config.js` can read
every row straight from the API, signed in or not, and follow changes over realtime (Alan's call,
2026-09-19: reps call promoters; re-confirmed 2026-10-02 with that scope in view). The Show Shift
Schedule Sheet carries the same columns and exports without sign-in from "Open the Sheet"; also known
and accepted. **Never in git**: the public seed stays stripped. Locking it is one policy line
(`using (is_editor())`, `supabase/schema.sql`; not `authenticated`, sign-ups are open); the page already
handles that (editors get contacts after sign-in, everyone else gets no rows). The
page's data layer and the CLI split those three fields out of every `events` write and merge them
back on read, so everything else treats them as event fields. `history` — results by year per show base. `settings/division` — name, short, code, roster, former (reps who left, kept so their old shifts resolve), rosterSyncedAt,
`meetings` (ISO dates of shift-picking meetings). `never_work` — shows we never work again,
keyed by series key. `kiosks` — the Kiosk Schedule: id `YYYY-<mall>` (base stable across seasons), `name, year,
cityState, status (Booked | Prospective | Cancelled), captain, cost (free text, "$7,038 ($230/day)"), startDate, endDate,
order (column), notes, shifts{ISO date: {rep, note?}}, lastYear{year, status, captain, cost, costNum, days}, rolledFrom`,
`costNum` (the season's cost as a number; the page sets both from what is typed). Cost per day (Alan, 2026-10-14) is
worked out, never stored: before and during the season, `costNum` over the days in its dates not marked closed (an
estimate, "est." on the page); once the season is over, over the days worked, which is how the mall sheet's $/day was
figured (Sierra Vista 2025: $500 / 16 = $31.25). One shift
per day: `rep` is a roster name, two joined by " / " for a split day, or `__X__` for no shift (the mall is closed; `note`
says why, e.g. Christmas). Open = a Booked mall's upcoming day with no rep; a Prospective mall has none. The page writes a
day by re-reading the row and sending the whole `shifts` map through `merge_doc` (shallow), so a concurrent edit to
another day survives. Its own table on purpose: nothing that reads `events` may ever see a mall. `coverage` — reps' shift
coverage requests (2026-10-22): `requester` and `cover` (board spellings), `slots[]` (`{kind: show, event, booth, shift, day, date}`
indexes into `booths[].shifts[].slots[]`, or `{kind: kiosk, event, date}`), `status` (new → waiting-approval → asking-requester →
asking-cover → done | partial | declined | cancelled | expired | refused), `why`, `code`, `moved`. Readable by everyone; a rep makes a
`new` row only through `coverage_request()` (schema.sql: on/requesters/roster/1-8 future shifts/no open request on a slot/3 open
per rep/30 an hour), called by SUNNY; rsd-shift-picking's coverage agent (`coverage.js`, docs/shift-coverage.md there) moves
it on, texts both reps and moves the shift only after both reply YES. Who may ask is `settings/division.coverage` (`on`, `tiers`,
`requesters`), written only by that agent from the rep master list. `editors` — who may write. `changelog` — every write. `sheet_syncs` — a plain table (not
`{id, data}`): one row per Sync press or `--apply` sync run (`status` pending → running → done | stopped | failed,
`result` = counts and the changed/held/conflict lists, never contacts). Editors read and insert pending rows; only
the service key moves them on.

## Rules that are easy to get wrong

- **Text contrast is 4.5:1 or better everywhere** (WCAG AA; Alan, 2026-10-14). `--ink-3` (#685d4e light, #a39784 dark) and
  `--mute` were darkened to get there; grey text is never faded further with `opacity` (the old tab counts, stamp and legend
  were, and fell under 3:1). The one exception on purpose: a closed or cancelled show's card recedes. On a phone the season
  tabs, Cards/Grid and the Plan mode switch are 44px tall (Apple's minimum touch target).

- **The HIG pass (Alan, 2026-10-15) is the page's design system; the block of that name near the end of the CSS.**
  Type is the `--t-*` scale only (Apple's Dynamic Type at Large: 11, 12, 13, 15, 17, 22, 28px); nothing under 11px.
  Bricolage (`--f-disp`) is for titles and the big numbers only; everything else is `--f-body` (system-ui: SF Pro on an
  iPhone), numbers use `--f-num` with tabular figures, `--f-code` only for the sign-in code and the import box. Labels
  are sentence case; caps only on the small badges (tier, access, SE). On a touch screen every field is 16px
  (`pointer:coarse`), or iOS zooms the whole page when it is tapped and leaves it zoomed. The header pins only its
  last row (`.segrow`, plus `.modes` beside it on a wide screen): it sticks at a negative top that `syncTopH()`
  measures into `--stick`, and `--topH` is the part left in sight, which the Grid day row and the cards view's weekend
  headers pin under; put nothing below `.segrow`. Failures go through `toastErr()` (red, `role=alert`, 6 s), news
  through `toast()`. Motion uses the `--ease-*` / `--d-*` tokens; under reduced motion no animation runs, so nothing
  may wait on `animationend` without checking `RM` first.
- **Grid is one cell per day, read-only too** (Alan, 2026-10-27: "think of it like an Excel. I want to see Alec on all the
  days he's working"). A run of one name, of open days or of no-shift days is never merged into one spanning cell (it put
  the name in the first column only). The tests hold `gridCells` to it. **The weekend jump** (same day: a month jump still left
  7 phone screens of scrolling to Nov 20) sits in the pinned row beside the season tabs (`#wkJump`; `renderWeekJump`,
  `markWeekend`, `jumpToWeekend`, `stepWeekend`): ‹ › step one weekend, and the button between says the weekend in view and
  opens a native select (16px) of the season's weekends as filtered, under month headers, each with what its header says
  (open shifts, Full, past). A past weekend opens the "Earlier" fold first; jumps are instant. Hidden on Kiosk and Never.
- **Pinch zoom on a phone** (Alan, 2026-10-27: "pinching kinda like the sheets"). On a touch screen a pinch on the board zooms
  the board only: CSS `zoom` on `#board`, 55% to 150%, back to 100% when it ends near it, remembered per device (`store.zoom`;
  `applyZoom`, the pinch block after `stepWeekend`). The pinned row stays full size; not on Kiosk or Never; a computer keeps
  its browser zoom. Text can go under the 11px floor by the reader's choice. Two rules follow from it: every on-screen
  position read goes through `screenRect()` (WebKit, so every iPhone browser, has reported a zoomed box in the board's own
  px where Chrome reports it on screen; a hidden 100px probe says which, and the tests allow no other
  `getBoundingClientRect`), and a length inside the board that must match the screen (a sticky top under the pinned row,
  a margin that bleeds to the screen edge, a `vw` width) divides by `--bz`. Checked in Chrome both ways (its own rects and
  WebKit-style rects patched in); not yet on an iPhone (no Xcode on the MacBook).
- **A two-tap remove is armed in the page, never in the button** (`armed`, `arm()`, `isArmed()` in index.html; 10 s,
  "keep it" backs out). Any save redraws the board half a second later, and a button that kept its own "tap again" was
  reset by it, so the second tap only armed it again and nothing was removed (Park Place 2025, 2026-10-14; the show
  board's Remove, remove booth and shift-row x had the same flaw until the same day). On the show board the key carries
  what the booth or row holds as well as its place (`armKey`), so a row someone else removes meanwhile can't hand the
  "tap again" to the row that slides into its place, and the armed button is redrawn in place (`armRedraw`), not the
  board, which would drop what is half-typed in another field. A removed show is read back like a mall: a delete the
  database refuses comes back without an error.

- **Upcoming or past is the show's last day, `lastDay()` (lib/match.mjs), never the raw End Date cell** (2026-10-14).
  Its own selling days, then the End Date only when the Start Date sits within a week of them. Cells from another
  edition kept Pinetop-Lakeside (ran Sep 25-27, cells Oct 27) on JP's list weeks after it ran, and made Havasu Island
  Balloon 2027 (cells Jan 2026) count as over. The event check, the Sheet sync's VC-dead hold, the research targets
  and `board list --upcoming` use it; the check lists the cells it set aside in `flags.dateCellsOff` (the upcoming
  ones reach Alan's Wednesday report). rsd-shift-picking also never names a show whose dates have passed.
  To correct only the cells, patch them (`patchEvent`, lib/board-api.mjs): `board set <id> startDate=…` moves the
  whole show (re-dates every booth from its day names, resets the weekend and End Date, clears `datesNote`). All 13
  rows with stale cells were corrected that way on 2026-10-14 (changelog actor `service:date-cells-fix`).
- **Application dates and Submission Notes** (Alan, 2026-10-26; `scripts/lib/app-dates.mjs`, the page's `app-dates` block,
  `docs/application-dates.md`). `applyOpens` and `applyBy` (the deadline) each carry a source shown as a small tag under the
  date: Research (page, its words, the day checked), Manual (`by`, `at`: typed on the board or with `board set ... --by`), or
  rolled ("Taken from last year": a roll carries last year's dates a year on as an estimate, Alan's one change to the
  defaults). Research never changes a Manual date: a different finding is stored on its source as `found` and shown under it.
  Research takes a date only from the show's or promoter's own page, with its words, inside this edition (a deadline at most
  330 days, an opening at most 400 days before the show), so last year's date never passes as this year's. `submissionNotes`
  (350 characters) is what Cutco reads first in the Booking Request's Comments; `notes` is now the team's own and never goes
  to Cutco (label "Team notes (never sent to Cutco)"). The page and `board.mjs` load the lib's rules; the tests hold the page's
  copy to it. The Show Research switches (rsd-shift-picking `config/divisions/<id>.json` `showResearch`, The Block's rules)
  reach `board-research.mjs apply` as `--app-dates` and `--manual-wins`.
- **A show's shifts and booths are saved so two screens never undo each other** (stage 3, 2026-10-27: two coordinators
  type at the January 13 meeting). The page saves one slot with `set_slot` (written only if the slot still holds what the
  page showed; otherwise nothing changes and the coordinator is told who has it) and any other change to `booths` (add or
  remove a booth or a shift row, a booth's name, the spot tag, a date move) with `set_booths`, built on a fresh read of the
  row and written only if `booths` hasn't moved since (`saveShow` and the `safe-saves` block in index.html,
  `supabase/schema.sql`). Never write a whole `booths` copied from the page through `merge_doc` again: that is how a pick
  made a second earlier on another screen was put back with no error. The routines (Sheet sync, coverage agent, research,
  roll-forward) still write through `merge_doc`; the coverage agent's slot move should go through `set_slot` before the
  January meeting (stage 3 doc, item 1).
- A shift is a slot with a `rep` that isn't empty or `__X__`. **SE days are never shifts.** Nor are set-up / tear-down
  days ("set-up" with a hyphen too) or a day column that names no day ("Tucson, AZ", "Service Events"): the page's
  `offDay()` / `notShift()`, the scripts' `isSE()` (2026-10-27). A day label is read for the weekday it names past
  the notes the Sheet adds ("Friday (SE)", "Wed (set-up", an old year's "1/26/2024"): the page's `dayOf()`. Before that,
  Grid hid those days and still counted them open.
- **Tier rules** (config/event-check.json `tierRules`, Alan 2026-09-24): every show named Maricopa is Elite, except the
  Maricopa County Fair. The Sheet sync creates new shows with the rule's tier, and the research runs and the booking
  sweep use `tierOf()` (lib/match.mjs), so the rule wins even over a wrong tag. Elite shows are never researched and
  never sent to Olean (rsd-shift-picking skipTiers / excludeTiers).
- Same-year series (Queen Creek, Mesa) share name/promoter/cost/notes; shifts and status are per date.
- `notes` (the team's notes) and `submissionNotes` roll forward; only `submissionNotes` is read into VC booking-request
  Comments (since 2026-10-26). Don't overwrite either; append.
- Roll-forward holds back `skipNext`, `neverWork`, and Never-list series keys. Idempotent. On the board a year's own tab
  rolls it into the next ("Roll 2026 into 2027"); an empty tab offers rolling the year before into itself (Alan,
  2026-10-24: the button used to live only on the target tab, so 2026 looked impossible to roll).
- **Never work again is about the years after** (Alan, 2026-10-27). The card's button and `board never` add the show to
  `never_work` and leave the year it was marked in alone: status, `dead` and reps stay as they are, and the card then says
  it is on the Never list. Until that day both also marked every date of it that year Cancelled and dead, so Salt River
  Fields Spooktacular 2026, which Kendall worked, showed crossed off (put back to Booked the same day, actor
  `service:never-work-fix`). The list is what holds a show back from the roll; a row's `neverWork` is the older mark, and
  the scripts still skip a row that carries it. Not working this year's date either is a status change, made by hand.
- The routines never text the whole roster. Only staffed reps on events whose status changed.
- Set `BOARD_ACTOR=service:<routine>` so the changelog says who did what.
- **A script's "am I the one that was started?" check is `isMain(import.meta.url)`** (`scripts/lib/is-main.mjs`), never
  `import.meta.url === \`file://${process.argv[1]}\``. Node gives a module its real path and argv the path as typed, so
  through a link (a Mac's temp folder: `/var` is a link to `/private/var`) or a folder with a space the hand-made test is
  false and the script exits 0 having done and said nothing. From 2026-09-28 to 2026-10-06 that made the listener's
  tests fail on the mini (they passed on Linux, where the change was written), which is also why `install.sh --arm`
  would have refused. The tests refuse a hand-made comparison in `scripts/`.
- Never commit `~/.rsd/board.env` or a service key. The anon key in `config.js` is fine.
- **Editors sign in with an emailed code** (8 digits, one hour), typed into the board on the device
  being signed in; that device then stays signed in until "sign out", which is this device only. The
  link in the same email still works on the device that opens it. The Supabase "Magic link or OTP"
  template must carry `{{ .Token }}`, or the email is link-only and the code box has nothing to take.
  Why and how: `docs/HANDOFF.md` section 9. Never request a code for someone else's address to test it.
- **This repo is public.** No phone numbers, no promoter or rep e-mails, no contact fields in
  `seed/events.json`, nothing from `seed/private/`, no reports (`out/` is gitignored). The
  pre-commit hook enforces it; do not bypass it with `--no-verify`.
- **Nothing in this repo sends a text except `deploy/tick.py`**, rooted in `/usr/bin/python3`, and only
  to Alan. The event check's texts (JP's list, rep updates) are built and sent by rsd-shift-picking's
  approvals loop, after Alan's reply or the deadline printed in his preview. No Messages MCP tools.
- **E-mail to coordinators goes through the mailroom, never the chat Gmail connector.** The
  connector rewrote the board link into a Google redirect in the go-live e-mail (2026-09-20,
  `docs/HANDOFF.md` section 8). The sanctioned path is hand-run from a session on the mini: write
  the text to a file under `out/` (gitignored), then
  `/usr/bin/python3 ~/ai-system/lib/mailroom/gmail_send.py preview --to '<Name> <address>' --subject '...' --body-file out/<file>`
  (no network; prints recipients, the exact text, every link, a fingerprint). Show Alan every
  recipient and the exact text, wait for his go in a later message, then run the same command with
  `send` and `--confirm <fingerprint>`, and read the result: exit 0 means sent and the text stored
  in Sent is identical. Addresses come from `node scripts/board.mjs editors` or
  `seed/private/go-live.md` at run time; never write one into this repo. `./install.sh --check`
  says whether the mailroom is ready. Routines and the tick still never e-mail. The rule in full:
  `@~/ai-system/claude/shared/email-sending.md`.
- **The Sheet is still the truth (stage 1).** rsd-shift-picking, rsd-event-analyzer and three skills read it. Nothing here may retire, rename or restructure the Sheet. Read
  `docs/ROADMAP.md` before any change that touches another system. From the January 13, 2027 meeting the board is the
  truth and the Sheet a mirror the board writes (`docs/stage-3-january.md`; not built yet as of 2026-10-27).
- **SUNNY reads this board live (since 2026-10-03).** sunny-bot's `lib/board.js` reads `events`, `event_contacts` and
  `settings` with the public anon key on every rep question (10-minute cache). It depends on the event shape
  (`booths[].shifts[].slots[]`, `days`/`dates`, `status`, `vcNumber`, `costNum`, `costBasis`, `dead`, `cityState`). After
  changing any of those, run `node scripts/board-audit/test-board.js` in sunny-bot.
- **Re-syncing from the Sheet goes through `parse-sheet.mjs --verify` first.** A misparse is the
  silent failure here: it writes a wrong seed and everyone then trusts it. `--verify` differing on
  one or two events is the team editing the Sheet; differing on most of them is the parser having
  drifted. Rep names are stored as `settings.roster` spells them, not as the Sheet does.
- Headless `claude -p` on the mini cannot see the account skills the routines need, so roll-forward is
  still hand-run from the desktop app. The event check, the booking sweep and the preflight no longer need them:
  they are scripts (above); `board-event-check`, `board-booking-sweep` and `board-preflight` are their hand-run
  fallbacks.
- **Board statuses** (index.html SORDER): Booked, Pending Promoter Acceptance, OK to Book - Need Contract, Pending
  Coordinator, Booking Request Submitted (2026-09-23: the sweep sent it, Olean has it; VC's "Request to Book" reads
  the same), Booking Request Needed, Prospective, Show Full, Cancelled.
- **A coverage request moves a shift on the board, never on the Sheet** (2026-10-22). rsd-shift-picking's coverage agent
  writes the slot (actor `service:coverage`) after both reps reply YES and emails rsdcoordinator2 the confirmed change; the
  coordinators change the Sheet as they always have, and the hourly sync then finds the two agreeing. Until they do, the board
  holding the cover and the Sheet still holding the requester is the sync's "board edited, Sheet unchanged" case: kept, not a
  conflict. The agent reads `state/sheet-baseline.json` a day later to see whether the Sheet caught up (since 2026-10-23
  that file is both books' current part combined, written by every sync, so a show in either book is found there; keep
  it an array of shows with their board `id`). SUNNY is the only caller of `coverage_request()`; nothing in this repo
  texts a rep about it.
- **Nothing here writes the Sheet** (Alan, 2026-09-23: VC status lives on the board now; the Sheet's
  Z/AA columns froze "as of 9/9"). The sync only reads it; the team keeps editing it until stage 3.
- `state/` and `out/` hold private data (the baselines can carry promoter contacts; reports and the stale-cell files
  name reps). Both are gitignored. Tests point `BOARD_STATE_DIR` / `BOARD_OUT_DIR` at temp dirs. The sync's files there:
  `sheet-baseline-sept-feb.json`, `sheet-baseline-jan-may.json` (each book's), `sheet-stale-jan-may.json` (last year's
  cells the first load did not carry) and `sheet-baseline.json` (the combined view). Losing a book's baseline stops the
  sync (exit 5). Do not re-run `--first-load` to "fix" it without Alan: it would link to the shows already on the board,
  but it would also treat every name on the tab at that moment as last year's and never carry it.

## Production

Mac mini, `~/automations/rsd-show-shift-board`, registry entry `rsd-show-shift-board`. Two launchd jobs:
`com.allinalan.rsd-board-tick` (07:00 daily, armed 2026-09-20) and `com.allinalan.rsd-board-sync` (every 30 s: the
Sync button, and the hourly sync from 2026-10-15).
The sync listener was armed 2026-10-06 11:34 (Alan's go the same morning) and proven through launchd a minute later:
it ran the press that had waited since 2026-10-03 (`docs/HANDOFF.md` section 10). It was built 2026-09-28 and sat
unarmed for eight days because `./install.sh --arm` was never run again on the mini and the registry had no entry
for the label, so nothing looked for it. `./install.sh --arm` loads both jobs; an armed listener runs every waiting
press at once, as a real Sheet -> board sync. `logs/sync-requests.log` is stamped in UTC (the tick's log is local).
Kill switch for both: a `PAUSED` file in the repo root, or `./install.sh --disarm`. Tick failures post to
`#rsd-alerts` through slackroom (`~/ai-system/lib/slackroom`, route `rsd.alerts`), which itself falls back to the
shared Slack alert webhook (Keychain `csp-slack-webhook`); the sync listener's go to its log and onto the
request, which the page shows. **A due routine is one message in `#rsd-board` that names Alan** (route
`rsd.board`; Alan, 2026-10-07: channels, not texts to him). Only while that route is not live, or when Slack
refuses the post, it is the old pair: the alert channel and an iMessage to `BOARD_ALAN_IMESSAGE`, so a due routine
is never left unseen. `python3 deploy/tick.py --status` says which it is right now. After changing `deploy/tick.py` or a plist: run
`node tests/run-all.mjs`, `python3 deploy/tick.py --dry`, then `touch PAUSED; launchctl start
com.allinalan.rsd-board-tick; tail logs/tick.log; rm PAUSED`. If how a job starts changes, update
`install.sh`, this file and `~/ai-system/REGISTRY.yaml` in the same change.

`set_slot` and `set_booths` went into the live database on 2026-10-27 as SQL (the Supabase connector's execute_sql, the
same statements as `supabase/schema.sql`), after 22 cases ran against them in a transaction that rolled itself back
(editor, service key and anon; nothing stayed), then again on the deployed functions, and a call over the REST API to an
id that does not exist (the service key answered "gone", the anon key "permission denied"). Supabase grants anon execute on
every new function in `public`; the schema takes it back for these two.

The `kiosks` table went into the live database on 2026-10-14: the same statements as `supabase/schema.sql`, run as SQL
(Supabase's migration tool hung on them), then the ten malls from `seed/kiosks.json` (the changelog names
`service:kiosk-setup`), and the same day the costs and costNum. The Supabase tool holds a `delete` for a confirmation a
cloud session cannot show, so `2025-park-place-mall` was left for Alan to remove on the board (Plan mode, 2025, the mall's
card, Remove) or in the SQL editor: `delete from kiosks where id = '2025-park-place-mall';`. Checked as anon the same day: reads all rows; an insert and `merge_doc` are refused. No job
reads or writes it; the tab shows once `main` carries it.

The full spec and clarifications log lives in the RSD Events Team Cowork project
(`claude/show-shift-board-spec.md`); a copy belongs in `docs/spec.md` once Alan brings it over.
