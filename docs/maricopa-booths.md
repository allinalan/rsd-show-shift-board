# Maricopa booth spots: finding this year's

Alan, 2026-10-24: a rolled Maricopa show carries last year's booth names, tagged "2026's spot" on the board
(CLAUDE.md, "Maricopa booth spots"). The real spots for each show are on the promoter's vendor page, and he asked
for a lookup that reads them from there.

## What the promoter's site has (checked 2026-10-24, before signing in)

- `https://maricopacountyhomeshows.com/exhibit/vendors/` ("Vendor Login") is one WordPress password-protected page.
  It asks for a password only, the same one for every vendor. It is not an account per company.
- `https://maricopacountyhomeshows.com/exhibit/` has a "Floor Plans" box that asks for name, company, phone and
  e-mail before it shows plans. It is a lead form, not a login. Nothing here fills it in.
- What is behind the password (floor plan PDFs per show, an exhibitor list, booth assignments) is not known yet.

## The plan (Alan's "all defaults", 2026-10-24)

1. Alan signs in to the vendor page himself in the session's browser pane. Claude never types the password.
   Claude reads what the page holds.
2. The password goes into the Keychain from Alan's own terminal, never into a file, a log or this repo:
   `security add-generic-password -s maricopa-home-shows-vendor -a rsd -w` (it asks for the password).
3. `scripts/maricopa-booths.mjs` (not written yet; it waits on step 1): reads the password from the Keychain, opens the
   page without a browser (a WordPress password page is a POST to `wp-login.php?action=postpass` and a cookie), finds
   our booths on each show's plan, and writes the names in the January 2027 format: "Booth #N (Building) #numbers
   (size)". Dry unless `--apply`; read back after writing; a report under `out/`.
4. It only replaces a name still tagged as last year's spot. A name someone typed this season is reported, never
   overwritten (a board edit wins, as in the Sheet sync).
5. Run by hand until it gets one show right; only then scheduled (with its installer, REGISTRY.yaml and the Overseer's
   jobs.json in the same change).

If the plans name exhibitors, the lookup finds our booths by name. If they only show numbers, it needs our numbers
(from the contract) and adds the building and size.
