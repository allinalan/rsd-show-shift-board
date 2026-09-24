# RSD Show Shift Board

The Rising Sun Division's event schedule: every show by weekend, who's staffed, what's booked,
what it costs, what it did last year. Reps read it; coordinators (Alan, Matt, JP) edit it; the
routines in `.claude/skills/` keep it true.

## Shape

- `index.html` — the whole app, one file, no build. Deployed by GitHub Pages from `main`.
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
  named in the report). Stops on parser drift (exit 2) or an oversized change set (exit 3). Dry unless `--apply`.
- `scripts/event-check.mjs` — the Wednesday Event Check against the board, unattended: matches every
  staffed non-Mesa event to a VectorConnect My Events pull (`scripts/lib/match.mjs`: VC number first, then
  name + shared distinctive word + date gate, aliases/rejects in `config/event-check.json`, Queen Creek by
  exact date, placeholder 00092192 never books a date, duplicate-number audit) and writes vcStatus /
  vcNumber / status / dead back (past events: vcStatus and vcNumber only). Refuses to write when the pull
  is too small (exit 4) or lacks the board's own VC numbers (exit 5). Writes `out/event-check/latest.json`
  (read by rsd-shift-picking's texts), the workbook and a summary under `out/reports/`.
- Both run from rsd-shift-picking's Wednesday 08:00 job (`run-event-check.sh` there), which owns the VC
  login (Playwright + Keychain; this repo has no node_modules) and all texting. `scripts/lib/board-api.mjs`
  is their REST layer (same env file and changelog path as board.mjs).
- `deploy/tick.py` — the launchd entry point (`com.allinalan.rsd-board-tick`, 07:00 daily on the
  mini): decides what is due and notifies Alan. It does not run routines. `--dry`, `--status`. Wednesday is
  no longer "due" (the event check runs unattended). It reminds Alan to send the freshmen training sign-in
  sheet two days after a January/August meeting (Jan 20 / Aug 15 when none is set) and about the Jan-May
  changeover on Dec 28, and wakes Messages with a cheap read before texting (a cold Messages after the
  2026-09-22 reboot timed out the 2026-09-23 notice).
- `install.sh` — preflight + plist, disarmed by default; `--arm`, `--disarm`, `--check`.
- `tests/run-all.mjs` — CLI, launcher, Sheet-parser, matcher, sync and event-check tests against an in-memory fake database. Run before every commit.
- `docs/ROADMAP.md` — the staged plan to replace the Sheet by Fall 2027. `docs/HANDOFF.md` — go-live steps.
- `.claude/skills/` — the routines: `board-tick` (daily), `board-preflight`, `board-booking-sweep`,
  `board-event-check`, `board-rollforward`. They lean on the account skills
  `vectorconnect-booking-request`, `event-check`, `vectorconnect-event-export`, `humanizer`.

## Data model (one table per collection; row = `{ id, data jsonb }`)

`events` — an event in a year. id `YYYY-<base>`; `base` is stable across years so `history/<base>`
follows the show. Fields the routines care about: `name, year, weekend (Friday ISO), startDate,
endDate, datesEstimated, status, vcNumber, vcStatus, tier, access, cityState, location, address,
setting, promoter, contact, phone, email, website, cost, costBasis, applyUrl, applyBy, notes,
booths[{label,days,dates,shifts[{label,slots[{rep,ft[]}]}]}], dead, skipNext, neverWork`.
`event_contacts` — promoter `contact, phone, email` per event id. **Visible to everyone on the live
page** (reps call promoters; Alan's call, 2026-09-19) but **never in git**: the public seed stays stripped. The
page's data layer and the CLI split those three fields out of every `events` write and merge them
back on read, so everything else treats them as event fields. `history` — results by year per show base. `settings/division` — name, short, code, roster,
`meetings` (ISO dates of shift-picking meetings). `never_work` — shows we never work again,
keyed by series key. `editors` — who may write. `changelog` — every write.

## Rules that are easy to get wrong

- A shift is a slot with a `rep` that isn't empty or `__X__`. **SE days are never shifts.**
- Same-year series (Queen Creek, Mesa) share name/promoter/cost/notes; shifts and status are per date.
- `notes` roll forward and are read into VC booking-request Comments. Don't overwrite them; append.
- Roll-forward holds back `skipNext`, `neverWork`, and Never-list series keys. Idempotent.
- The routines never text the whole roster. Only staffed reps on events whose status changed.
- Set `BOARD_ACTOR=service:<routine>` so the changelog says who did what.
- Never commit `~/.rsd/board.env` or a service key. The anon key in `config.js` is fine.
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
- **The Sheet is still the truth (stage 1).** rsd-shift-picking, rsd-event-analyzer, SUNNY's shift
  sync and three skills read it. Nothing here may retire, rename or restructure the Sheet. Read
  `docs/ROADMAP.md` before any change that touches another system.
- **Re-syncing from the Sheet goes through `parse-sheet.mjs --verify` first.** A misparse is the
  silent failure here: it writes a wrong seed and everyone then trusts it. `--verify` differing on
  one or two events is the team editing the Sheet; differing on most of them is the parser having
  drifted. Rep names are stored as `settings.roster` spells them, not as the Sheet does.
- Headless `claude -p` on the mini cannot see the account skills the routines need, so preflight,
  booking sweep and roll-forward are still hand-run from the desktop app. The event check no longer
  needs them: it is scripts (above); `board-event-check` is its hand-run fallback.
- **Nothing here writes the Sheet** (Alan, 2026-09-23: VC status lives on the board now; the Sheet's
  Z/AA columns froze "as of 9/9"). The sync only reads it; the team keeps editing it until stage 3.
- `state/` and `out/` hold private data (the baseline can carry promoter contacts; reports name reps).
  Both are gitignored. Tests point `BOARD_STATE_DIR` / `BOARD_OUT_DIR` at temp dirs.

## Production

Mac mini, `~/automations/rsd-show-shift-board`, registry entry `rsd-show-shift-board`. Kill switch:
a `PAUSED` file in the repo root, or `./install.sh --disarm`. Failures post to the shared Slack
alert webhook (Keychain `csp-slack-webhook`). After changing `deploy/tick.py` or the plist: run
`node tests/run-all.mjs`, `python3 deploy/tick.py --dry`, then `touch PAUSED; launchctl start
com.allinalan.rsd-board-tick; tail logs/tick.log; rm PAUSED`. If how the job starts changes, update
`install.sh`, this file and `~/ai-system/REGISTRY.yaml` in the same change.

The full spec and clarifications log lives in the RSD Events Team Cowork project
(`claude/show-shift-board-spec.md`); a copy belongs in `docs/spec.md` once Alan brings it over.
