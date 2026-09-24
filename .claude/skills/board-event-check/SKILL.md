---
name: board-event-check
description: "The Wednesday Event Check against the RSD Show Shift Board: VectorConnect My Events vs every staffed board event, VC status written back to the board, JP's focus list and the rep updates sent through Alan's reply loop. It runs unattended every Wednesday at 08:00 (rsd-shift-picking run-event-check.sh); use this skill to run it by hand, re-run it after a failure, or explain what it found. Triggers: run the event check, check the board against VectorConnect, which staffed shows still aren't booked, why did the event check say X."
---

# board-event-check

Since 2026-09-23 this is scripts, not a Claude routine. The Wednesday 08:00 job in rsd-shift-picking
(`com.rsd.vcweekly` → `run-event-check.sh`) does it all:

1. `pull-vc-events.js` (rsd-shift-picking): My Events for Matt Foss over a window this repo computes
   (`node scripts/event-check.mjs --window`), through the Keychain login and the JSON store behind the
   grid. No Chrome, no ExtJS clicking, no ~/Downloads. Refuses partial or unfiltered data.
2. `node scripts/sheet-sync.mjs --apply --vc <pull>`: the Sheet's shift changes onto the board (three-way,
   VC wins, board edits win ties). Report: `out/reports/sheet-sync-<date>.md`.
3. `node scripts/event-check.mjs --vc <pull> --apply --sync-report ... --status-defs ...`: matching
   (`scripts/lib/match.mjs`) and write-back. Outputs `out/event-check/latest.json`,
   `out/reports/Event_Check_<label>_<date>.xlsx` and `out/reports/event-check-<date>.md`.
4. `event-texts.js` (rsd-shift-picking): JP's focus list + one update per rep whose show changed (the
   rep-text ledger decides), as one approval batch; Alan is texted the preview. `com.rsd.approvals`
   reads his reply every 5 minutes: approved / decline / edits (applied, then sent); no reply by the
   deadline in the preview sends it as drafted. Sends only 09:00-18:00 Phoenix.

## Running it by hand

From rsd-shift-picking: `./run-event-check.sh --dry` (every read, no board writes, texts nobody) or
`./run-event-check.sh` (live: board writes; the batch is saved and the launchd watcher texts Alan the
preview within 5 minutes). Never send from a Claude shell. `node approvals.js status` shows what is
waiting; `node approvals.js approve|decline <code>` records Alan's word from a session.

## Reading a result

Lead with the two numbers: staffed upcoming shows with no VC booking, and not fully booked. Then the
delta, dead shows with reps still on them, column C claiming Booked where VC disagrees, off-list statuses,
the sync's held items and conflicts. Name patterns, not rows. The workbook's "NOT Fully Booked" tab is
the work list, grouped by what unblocks each show.

## Rules that do not change

- A name on the board is a promise; a VC row is a booking; Prospective and OK to Book are not committed.
- Mesa Market Place Swapmeet is handled outside VC: never checked, never flagged.
- Queen Creek matches on the exact date; the placeholder 00092192 (11/1-11/30) books no date. Never submit
  a booking request against a date it covers without Alan or Olean.
- A cancelled show never means a weekend needs refilling.
- Aliases and reject pairs live in `config/event-check.json`, keyed by name. Add one only on Alan's word.
- Nothing here writes the Sheet. Promoter contacts never go into a tracked file (this repo is public).
