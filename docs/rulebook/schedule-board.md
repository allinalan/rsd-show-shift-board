# Schedule Board rule book

The rules Schedule Board already runs by, in plain words, written down from its code on 2026-11-13 (the Workforce review; Alan OK'd the drafts that day). Under each rule: where it lives. A new rule gets one line at the end, with its date and pull request. Only the lines that start with "- " are rules.

- The board syncs itself from the Sheet every 60 minutes between 7am and 9pm. (2026-11-13, from the code)
  Where: config/event-check.json `sync.auto` (everyMinutes 60, hours [7, 21]); scripts/sync-requests.mjs:12-14,67-77
- A shift someone changed on the board is never overwritten; when the Sheet and the board both changed the same thing, neither is touched and the report names it. (2026-11-13, from the code)
  Where: scripts/sheet-sync.mjs:6-10 (THREE-WAY)
- A sync that would touch more than 40 shows or 250 shifts, or that reads the Sheet differently on more than a tenth of shows, writes nothing. (2026-11-13, from the code)
  Where: config/event-check.json `sync.maxEventsTouched`, `sync.maxSlotChanges`, `sync.structuralDriftShare`; scripts/sheet-sync.mjs:498,635-636
- A show's status never comes from the Sheet; VectorConnect wins, and a rep added to a show VectorConnect calls dead is held. (2026-11-13, from the code)
  Where: scripts/sheet-sync.mjs:18-22 (VECTORCONNECT WINS)
- A show deleted from the Sheet is flagged, never deleted from the board, and a show that moved weekends is flagged, never duplicated. (2026-11-13, from the code)
  Where: scripts/sheet-sync.mjs:20-22
- The roster follows the rep master list, and nothing changes when the master list shows fewer than 10 active reps or more than 12 names would come off at once. (2026-11-13, from the code)
  Where: scripts/lib/roster-sync.mjs:69-74,100 (minActive, maxRemove)
- If no sync gets through for 3 hours inside the hourly window, Alan is told once, and told again when it is back. (2026-11-13, from the code)
  Where: config/event-check.json `sync.watch.quietHours`; scripts/sync-requests.mjs:28,83,140
- A pause file stops the syncs, and a separate one stops only the roster step. (2026-11-13, from the code)
  Where: scripts/sync-requests.mjs:37,195,259; deploy/tick.py:12,255-257

From changes merged later on 2026-11-13:

- A blank Start Date is filled only from the show's own page; a date found only on a third-party listing is left blank and comes to Alan as a question. (2026-11-13, PR 44)

Left out of this book: Which book feeds which weekends and the handover morning (config `sheets`, `handover.on`) and the name aliases were seen in settings but not read through.
