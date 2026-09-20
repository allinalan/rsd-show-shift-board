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
- `deploy/tick.py` — the launchd entry point (`com.allinalan.rsd-board-tick`, 07:00 daily on the
  mini): decides what is due and notifies Alan. It does not run routines. `--dry`, `--status`.
- `install.sh` — preflight + plist, disarmed by default; `--arm`, `--disarm`, `--check`.
- `tests/run-all.mjs` — CLI + launcher tests against an in-memory fake database. Run before every commit.
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
- **Routines never send messages.** Only `deploy/tick.py` (rooted in `/usr/bin/python3`) talks to
  Messages.app, and only to Alan. Rep texts are drafts in `out/reports/`. No Messages MCP tools.
- **The Sheet is still the truth (stage 1).** rsd-shift-picking, rsd-event-analyzer, SUNNY's shift
  sync and three skills read it. Nothing here may retire, rename or restructure the Sheet. Read
  `docs/ROADMAP.md` before any change that touches another system.
- Headless `claude -p` on the mini cannot see the account skills the routines need, so routines
  are hand-run from the desktop app until stage 2.

## Production

Mac mini, `~/automations/rsd-show-shift-board`, registry entry `rsd-show-shift-board`. Kill switch:
a `PAUSED` file in the repo root, or `./install.sh --disarm`. Failures post to the shared Slack
alert webhook (Keychain `csp-slack-webhook`). After changing `deploy/tick.py` or the plist: run
`node tests/run-all.mjs`, `python3 deploy/tick.py --dry`, then `touch PAUSED; launchctl start
com.allinalan.rsd-board-tick; tail logs/tick.log; rm PAUSED`. If how the job starts changes, update
`install.sh`, this file and `~/ai-system/REGISTRY.yaml` in the same change.

The full spec and clarifications log lives in the RSD Events Team Cowork project
(`claude/show-shift-board-spec.md`); a copy belongs in `docs/spec.md` once Alan brings it over.
