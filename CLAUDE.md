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
- `seed/*.json` — the data as of the migration off the Google Sheet. Also what the page shows
  when `config.js` is blank (read-only preview). `seed/private/` (gitignored, mode 600) holds the
  promoter contacts; it exists only on the mini.
- `supabase/schema.sql` — tables, row-level security, the `editors` list, `merge_doc`, changelog.
- `scripts/board.mjs` — the CLI every routine uses. `node scripts/board.mjs` prints usage.
- `scripts/check-public.mjs` — the pre-commit leak check (this repo is public).
- `scripts/parse-sheet.mjs` — reads the Sheet into board shape while the Sheet is still the truth
  (stage 1). `--verify` lines the parse up against `seed/events.json` field by field and exits
  non-zero if a structural field has drifted; `--diff` is the change report. Needs SheetJS from a
  sibling project, or `--grid` with a pre-dumped grid.
- `scripts/sheet-sync.mjs` — the Sheet -> board sync (stage 2 of the roadmap, live 2026-09-23). Three-way:
  the Sheet now vs the Sheet at the last sync (`state/sheet-baseline.json`, gitignored, 600) vs the board
  now. Carries shifts added/removed/re-staffed, shift rows, new events and event details; never status
  (VC's), never promoter contacts (edited on the board: the parser misreads spilled contact cells). VC
  wins: a rep added to a VC-dead show, or a date moved away from a VC booking, is held; an event deleted or
  moved on the Sheet is flagged, never deleted or duplicated. Board edits win ties (both changed = held,
  named in the report; both changed to the same thing, shift rows included, = settled). Two identical rows for one market on one day are one event (the extra row is reported,
  never added); a start date weeks away from the event's own banner-resolved days is a stale cell and is never
  copied. Stops on parser drift (exit 2) or an oversized change set (exit 3). Dry unless `--apply`. `--apply`
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
  one VC record, never Mesa. From then on the Sheet sync leaves that cost alone (the Sheet's cost cell no longer carries
  and is never a conflict). More than `checkWrite.maxCostChanges` (80) differences in one run changes none and says so. Alan's global "not-worked" rulings
  (rsd-shift-picking data/event-rulings.json, `--rulings`) outrank VC: the show is dead on the board, VC's
  status is kept beside it, and the rep text uses the ruling's repReason. Refuses to write when the pull
  is too small (exit 4) or lacks the board's own VC numbers (exit 5). Writes `out/event-check/latest.json`
  (read by rsd-shift-picking's texts), the workbook and a summary under `out/reports/`.
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
  board days are not inside VC's run; `--skip-tiers Elite` leaves out, and counts, the tiers the team handles itself);
  `apply` takes the findings and writes the board. Alan's date rule: the date
  a page states for this edition wins (quote and URL kept); nothing found online and VC disagrees = VC's dates,
  with `datesNote` on the board saying so; a failed lookup changes nothing; a cancellation is reported, never
  written; multi-week shows are never moved; more than 25 moves at once moves none (exit 5). When the page backs the
  board and VC's run does not cover it (VC holds one day of two), the report says VC is the one to fix. Each show is
  looked up once (rsd-shift-picking keeps the findings and reuses them; `counts.reused` says how many). A move
  (`planMove`) keeps reps on days that still happen, carries a rep to the same weekday in the new run, and reports
  the reps whose day is gone (they get a text through Alan). The preflight (`--mode full`) also fills blanks and
  corrects venue/promoter/website/application from official pages; an existing contact, cost, address or
  indoor/outdoor answer is only reported, never overwritten. Every move writes `datesNote` (shown on the board as
  "checked" or "VC dates"), `datesSource`, `datesMoved`. Output `out/research/<label>-<date>.json` (600) and a
  report without contacts. Runs: the date research 7 days before a meeting, the preflight 2 days before
  (rsd-shift-picking com.rsd.preflight), and the booking sweep's disagreements.
- Both run from rsd-shift-picking's Wednesday 08:00 job (`run-event-check.sh` there), which owns the VC
  login (Playwright + Keychain; this repo has no node_modules) and all texting. `scripts/lib/board-api.mjs`
  is their REST layer (same env file and changelog path as board.mjs).
- `deploy/tick.py` — the launchd entry point (`com.allinalan.rsd-board-tick`, 07:00 daily on the
  mini): decides what is due and notifies Alan. It does not run routines. `--dry`, `--status`. Wednesday is
  no longer "due" (the event check runs unattended); the date research (7 days before a meeting), the preflight
  (2 days before) and the booking sweep (days 2-8 after) are marked `auto` (they run themselves from
  rsd-shift-picking), so they are logged, never a "go run it" notice. It reminds Alan to send the freshmen training sign-in
  sheet two days after a January/August meeting (Jan 20 / Aug 15 when none is set) and about the Jan-May
  changeover on Dec 28, and wakes Messages with a cheap read before texting (a cold Messages after the
  2026-09-22 reboot timed out the 2026-09-23 notice).
- `install.sh` — preflight + both plists (the tick and the sync listener), disarmed by default; `--arm`, `--disarm`,
  `--check` act on both. The preflight also checks SheetJS and that `sheet_syncs` exists.
- `scripts/lib/is-main.mjs` — `isMain(import.meta.url)`: "is this file the script node was started with?", by real path.
  Every script that is both run and imported guards its `main()` with it (rule below).
- `tests/run-all.mjs` — CLI, launcher, Sheet-parser, matcher, sync and event-check tests against an in-memory fake database. Run before every commit.
  Each block is a `section()`: one that throws is a single named failure, the blocks after it still run, and the count
  always prints. `./install.sh --arm` refuses while this fails.
- `docs/ROADMAP.md` — the staged plan to replace the Sheet by Fall 2027. `docs/HANDOFF.md` — go-live steps.
- `.claude/skills/` — the routines: `board-tick` (daily), `board-preflight` and `board-booking-sweep` (hand-run fallbacks),
  `board-event-check`, `board-rollforward`. They lean on the account skills
  `vectorconnect-booking-request`, `event-check`, `vectorconnect-event-export`, `humanizer`.

## Data model (one table per collection; row = `{ id, data jsonb }`)

`events` — an event in a year. id `YYYY-<base>`; `base` is stable across years so `history/<base>`
follows the show. Fields the routines care about: `name, year, weekend (Friday ISO), startDate,
endDate, datesEstimated, datesNote, datesSource, datesMoved, status, vcNumber, vcStatus, tier, access, cityState, location, address,
setting, promoter, contact, phone, email, website, cost, costBasis, applyUrl, applyBy, notes,
booths[{label,days,dates,shifts[{label,slots[{rep,ft[]}]}]}], dead, skipNext, neverWork`.
`event_contacts` — promoter `contact, phone, email` per event id. **Public on purpose, not just to
people with the link**: the select policy is open, so anyone with the anon key in `config.js` can read
every row straight from the API, signed in or not, and follow changes over realtime (Alan's call,
2026-09-19: reps call promoters; re-confirmed 2026-10-02 with that scope in view). The Show Shift
Schedule Sheet carries the same columns and exports without sign-in from "Open the Sheet"; also known
and accepted. **Never in git**: the public seed stays stripped. Locking it is one policy line
(`using (is_editor())`, `supabase/schema.sql`; not `authenticated`, sign-ups are open); the page already
handles that (editors get contacts after sign-in, everyone else gets no rows). The
page's data layer and the CLI split those three fields out of every `events` write and merge them
back on read, so everything else treats them as event fields. `history` — results by year per show base. `settings/division` — name, short, code, roster,
`meetings` (ISO dates of shift-picking meetings). `never_work` — shows we never work again,
keyed by series key. `editors` — who may write. `changelog` — every write. `sheet_syncs` — a plain table (not
`{id, data}`): one row per Sync press or `--apply` sync run (`status` pending → running → done | stopped | failed,
`result` = counts and the changed/held/conflict lists, never contacts). Editors read and insert pending rows; only
the service key moves them on.

## Rules that are easy to get wrong

- A shift is a slot with a `rep` that isn't empty or `__X__`. **SE days are never shifts.**
- **Tier rules** (config/event-check.json `tierRules`, Alan 2026-09-24): every show named Maricopa is Elite, except the
  Maricopa County Fair. The Sheet sync creates new shows with the rule's tier, and the research runs and the booking
  sweep use `tierOf()` (lib/match.mjs), so the rule wins even over a wrong tag. Elite shows are never researched and
  never sent to Olean (rsd-shift-picking skipTiers / excludeTiers).
- Same-year series (Queen Creek, Mesa) share name/promoter/cost/notes; shifts and status are per date.
- `notes` roll forward and are read into VC booking-request Comments. Don't overwrite them; append.
- Roll-forward holds back `skipNext`, `neverWork`, and Never-list series keys. Idempotent.
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
  `docs/ROADMAP.md` before any change that touches another system.
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
- **Nothing here writes the Sheet** (Alan, 2026-09-23: VC status lives on the board now; the Sheet's
  Z/AA columns froze "as of 9/9"). The sync only reads it; the team keeps editing it until stage 3.
- `state/` and `out/` hold private data (the baseline can carry promoter contacts; reports name reps).
  Both are gitignored. Tests point `BOARD_STATE_DIR` / `BOARD_OUT_DIR` at temp dirs.

## Production

Mac mini, `~/automations/rsd-show-shift-board`, registry entry `rsd-show-shift-board`. Two launchd jobs:
`com.allinalan.rsd-board-tick` (07:00 daily, armed 2026-09-20) and `com.allinalan.rsd-board-sync` (every 30 s: the
Sync button, and the hourly sync from 2026-10-15).
The sync listener was armed 2026-10-06 11:34 (Alan's go the same morning) and proven through launchd a minute later:
it ran the press that had waited since 2026-10-03 (`docs/HANDOFF.md` section 10). It was built 2026-09-28 and sat
unarmed for eight days because `./install.sh --arm` was never run again on the mini and the registry had no entry
for the label, so nothing looked for it. `./install.sh --arm` loads both jobs; an armed listener runs every waiting
press at once, as a real Sheet -> board sync. `logs/sync-requests.log` is stamped in UTC (the tick's log is local).
Kill switch for both: a `PAUSED` file in the repo root, or `./install.sh --disarm`. Tick failures post to the
shared Slack alert webhook (Keychain `csp-slack-webhook`); the sync listener's go to its log and onto the
request, which the page shows. After changing `deploy/tick.py` or a plist: run
`node tests/run-all.mjs`, `python3 deploy/tick.py --dry`, then `touch PAUSED; launchctl start
com.allinalan.rsd-board-tick; tail logs/tick.log; rm PAUSED`. If how a job starts changes, update
`install.sh`, this file and `~/ai-system/REGISTRY.yaml` in the same change.

The full spec and clarifications log lives in the RSD Events Team Cowork project
(`claude/show-shift-board-spec.md`); a copy belongs in `docs/spec.md` once Alan brings it over.
