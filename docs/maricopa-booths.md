# Maricopa booth spots: finding this year's

Alan, 2026-10-24: a rolled Maricopa show carries last year's booth names, tagged "2026's spot" on the board
(CLAUDE.md, "Maricopa booth spots"). On 2026-10-26 he showed where the real spots are: the promoter's floor plans.

## Where the plans are

- `https://maricopacountyhomeshows.com/exhibit/` has a "Floor Plans" box (name, company, phone, e-mail). It is a lead
  form in front of `https://maricopacountyhomeshows.com/exhibit/download-floor-plans/`, which is a public page:
  no sign-in, no password. Alan filled the form in himself once; nothing here fills it in.
- That page links one plan per show: "January 15-17, 2027 Fairgrounds Show Map" and so on. They are PDFs in the
  site's uploads folder, renamed whenever the promoter updates them ("Jan-2027-10-26-26.pdf"). Each plan prints the
  exhibitor's name in its booth ("Cutco") and the booth's numbers at the box's corners.
- `/exhibit/vendors/` ("Vendor Login") is a different thing: one WordPress password page shared by every vendor.
  The plans do not need it, so nothing here uses it and no password is stored.

## `scripts/maricopa-booths.mjs`

Reads every plan, finds each Cutco booth, matches the plan to the board's Maricopa show that weekend, and (with
`--apply`) names the booths still tagged as last year's spot. How it reads a plan, what it writes and what it
refuses: the script's header. Dry by default:

    node scripts/maricopa-booths.mjs            # report only (out/reports/maricopa-booths-<date>.md)
    node scripts/maricopa-booths.mjs --apply    # write, then read back

Checked on 2026-10-26 against the four PDF plans read by eye (12 Cutco booths, all read the same). The case that
needs the rendered page: April's 1223 shares its column with 1225 below a wall, so it is 1223 alone; without
looking for the wall the text alone says 1223-1225. Area names come from each venue's number ranges
(config `maricopaMaps.venues`), not from the page's words, which name several buildings on every page.

Hand-run for now. Scheduling it (say weekly, since the plans change as the promoter sells) is a separate change
with its installer, REGISTRY.yaml and the Overseer's jobs.json.

## What the 2027 plans said (2026-10-26)

- January 15-17 (Fairgrounds): Ag Building 820-822 (the board agrees), Exhibit Building 125-127 (the board and the
  Sheet say 135/137), South Entrance Tent 3128-3130 (the board says only "South Entrance Tent"). Those names come
  from the Sept-Feb Sheet this season, so the lookup only reports them.
- March 5-7 (State Farm Stadium): Cutco at 601-603, 637-639 and 419, and no March Maricopa show on the board.
- April 30-May 2 (WestWorld): North Hall 709, North Hall 1223, Concourse 2049 (2049 was 2026's spot too).
- July 16-18 (State Farm Stadium): 301-303 and 921-923 (2026's spots again), 221-223 (2026: 421-423).
- October 8-10 (WestWorld): the link is a 2025 picture, not a plan for 2027.
