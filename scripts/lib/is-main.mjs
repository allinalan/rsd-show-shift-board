/*
  is-main — "is this file the script node was started with?", so a script can be run by a job AND imported
  (the tests import sync-requests.mjs for its clock rules, sheet-sync.mjs for its merge) without running twice.

  The usual one-liner, import.meta.url === `file://${process.argv[1]}`, is only true when both spell the path
  the same way, and they do not have to: node gives a module its REAL path, argv[1] is the path as it was typed.
  Start a script through a symlink (every temp folder on a Mac: /var/folders is a link to /private/var/folders)
  or from a folder with a space in its name, and the test is false, main() never runs, and the script exits 0
  having done and said nothing. That is how the Sync listener's tests failed on the mini from 2026-09-28 to
  2026-10-06 while passing on Linux, and install.sh --arm refuses while the tests fail.

  So both sides are resolved to real paths before they are compared.
*/
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const real = p => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };

/** `metaUrl` is the caller's import.meta.url; `started` is the path node was given (the tests pass their own). */
export function isMain(metaUrl, started = process.argv[1]) {
  if (!started) return false;                    // node -e, the REPL: nothing was started from a file
  return real(fileURLToPath(metaUrl)) === real(started);
}
