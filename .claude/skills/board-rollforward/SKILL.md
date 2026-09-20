---
name: board-rollforward
description: "Roll the RSD Show Shift Board's events forward into the next calendar year: every live event moves ahead 364 days as Prospective with shifts cleared, promoter info, cost, tier, access, booths and booking notes carried over, dates marked estimated; anything on the Never list or marked skip-next-year is held back. Use when Alan says 'roll forward', 'build out 2028', 'set up next year's board', or at year end."
---

# board-rollforward

```
node scripts/board.mjs rollforward <year> --dry-run      # shows what would roll and what's held
node scripts/board.mjs rollforward <year>                # does it
```

Idempotent — an event already in the target year is skipped, so it's safe to run twice. Held back:
`skipNext` events (one-year skip; they roll the following year), `neverWork` events, and any event
whose series key is on the Never list. Dead (cancelled / no-date) events are held unless
`--include-dead`.

Run `node scripts/board.mjs export` first (the backup). Report: `rolled <n> into <year>, held <n>` and
the held names, to Alan in the conversation and as `out/reports/board-rollforward-<year>.md`. Never
send a message from this routine; promoter contacts roll with the event automatically. The next preflight will replace the estimated dates.

Alan can also do this from the board itself (plan mode → Roll forward); the CLI exists so a routine
can. Use `BOARD_ACTOR=service:board-rollforward`.
