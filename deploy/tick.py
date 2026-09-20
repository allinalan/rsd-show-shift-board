#!/usr/bin/python3
"""
launchd entry point for the RSD Show Shift Board's daily tick on the Mac mini.

    /usr/bin/python3 deploy/tick.py            # the real run (what launchd calls)
    /usr/bin/python3 deploy/tick.py --dry      # decide and print; send nothing, pull nothing
    /usr/bin/python3 deploy/tick.py --status   # is it paused, configured, loaded; last run
    ... --date 2027-01-08                      # pretend today is that day (with --dry, for testing)

WHAT IT DOES (stage 1: decide and notify, nothing else)
-------------------------------------------------------
  1. PAUSED file in the repo root -> log one line, exit 0. That file is the kill switch.
  2. git pull --ff-only when the tree is clean (the mini holds no unique code).
  3. node scripts/board.mjs tick --json   -> which routines are due today. Deterministic.
  4. Nothing due -> one log line, exit 0. No Claude, no messages.
  5. Something due -> one Slack post and one iMessage to Alan naming the routine and the sentence
     to say in the Claude desktop app. It does NOT run the routine: the routines lean on account
     skills (event-check, vectorconnect-booking-request, vectorconnect-event-export, humanizer)
     that a headless `claude -p` on this mini cannot see (verified 2026-09-19). Unattended runs
     are stage 2 in docs/ROADMAP.md, after those skills are vendored into this repo.
  6. Any failure -> Slack alert with the reason and the log path, exit 1. Never silent.

WHY PYTHON
----------
On this mini the only identity allowed to control Messages.app is /usr/bin/python3
(~/ai-system/claude/shared/messages-tcc.md). This process sends the one iMessage itself, with
the account resolved inline. It never texts a rep: the only recipient it knows is
BOARD_ALAN_IMESSAGE from ~/.rsd/board.env. No business logic lives here.

Python 3.9 (Xcode Command Line Tools) is enough. No dependencies.
"""
import json
import os
import socket
import subprocess
import sys
import time
import urllib.request

REPO = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
LOG = os.path.join(REPO, "logs", "tick.log")
ENV_FILE = os.path.expanduser("~/.rsd/board.env")
NODE = "/usr/local/bin/node"            # the node identity every launchd job on the mini uses
LABEL = "com.allinalan.rsd-board-tick"
BOARD_URL = "https://allinalan.github.io/rsd-show-shift-board/"
MINI = "Alans-Mac-mini"

# what Alan says in the Claude desktop app (opened on this repo) to run each routine by hand
SAY = {
    "preflight": "run the board preflight",
    "booking-sweep": "run the board booking sweep",
    "event-check": "run the board event check",
}

DRY = "--dry" in sys.argv


def log(msg):
    line = time.strftime("[%Y-%m-%d %H:%M:%S] ") + msg
    if DRY or "--status" in sys.argv:
        print(line)
        return
    os.makedirs(os.path.dirname(LOG), exist_ok=True)
    with open(LOG, "a") as f:
        f.write(line + "\n")


def read_env():
    """~/.rsd/board.env as a dict. Values are never logged."""
    env = {}
    try:
        with open(ENV_FILE) as f:
            for raw in f:
                if "=" in raw and not raw.lstrip().startswith("#"):
                    k, v = raw.split("=", 1)
                    env[k.strip()] = v.strip().strip("\"'")
    except FileNotFoundError:
        pass
    return env


def slack(text):
    """One post to the mini's shared alert channel. Returns True only on HTTP 200."""
    if DRY:
        print("WOULD POST TO SLACK:\n  " + text.replace("\n", "\n  "))
        return True
    try:
        hook = subprocess.run(["/usr/bin/security", "find-generic-password", "-s", "csp-slack-webhook",
                               "-a", "csp-autopilot", "-w"], capture_output=True, text=True, timeout=15).stdout.strip()
        if not hook:
            log("SLACK NOT SENT (no csp-slack-webhook in Keychain): " + text[:200])
            return False
        req = urllib.request.Request(hook, data=json.dumps({"text": text}).encode(),
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=20) as r:
            ok = r.status == 200
        log(("slack sent: " if ok else "SLACK FAILED: ") + text[:160].replace("\n", " | "))
        return ok
    except Exception as e:  # noqa: BLE001
        log("SLACK FAILED (%s): %s" % (e, text[:160].replace("\n", " | ")))
        return False


def imessage_alan(text, env):
    """One iMessage to Alan, and only to Alan. Returns (sent, reason)."""
    to = env.get("BOARD_ALAN_IMESSAGE", "")
    if not to:
        return False, "BOARD_ALAN_IMESSAGE is not set in ~/.rsd/board.env"
    if DRY:
        print("WOULD iMESSAGE ALAN:\n  " + text.replace("\n", "\n  "))
        return True, "dry"
    esc = lambda s: s.replace("\\", "\\\\").replace('"', '\\"')  # noqa: E731
    script = ('tell application "Messages" to send "%s" to participant "%s" of '
              '(1st account whose service type = iMessage)' % (esc(text), esc(to)))
    try:
        r = subprocess.run(["/usr/bin/osascript", "-e", script], capture_output=True, text=True, timeout=45)
        if r.returncode == 0:
            log("imessage to Alan accepted by Messages")
            return True, "ok"
        return False, "osascript exit %s: %s" % (r.returncode, r.stderr.strip()[:200])
    except subprocess.TimeoutExpired:
        return False, "osascript timed out after 45s (Messages may need: killall Messages; open -a Messages)"
    except Exception as e:  # noqa: BLE001
        return False, str(e)[:200]


def fail(reason):
    log("FAILED: " + reason)
    slack("MAC MINI AUTOMATION FAILURE — rsd-show-shift-board tick: %s\nLog: %s" % (reason, LOG))
    return 1


def git_pull():
    """The mini pulls before every run, but never over local edits."""
    if not os.path.isdir(os.path.join(REPO, ".git")):
        return "not a git checkout, pull skipped"
    g = lambda *a: subprocess.run(["/usr/bin/git", "-C", REPO] + list(a), capture_output=True, text=True, timeout=90)  # noqa: E731
    if g("remote").stdout.strip() == "":
        return "no remote yet, pull skipped"
    if g("status", "--porcelain").stdout.strip():
        return "tree is dirty, pull skipped"
    r = g("pull", "--ff-only")
    return "pulled: " + (r.stdout.strip().splitlines() or ["ok"])[-1] if r.returncode == 0 else "PULL FAILED: " + r.stderr.strip()[:200]


def status():
    env = read_env()
    loaded = LABEL in subprocess.run(["/bin/launchctl", "list"], capture_output=True, text=True).stdout
    print("repo:        " + REPO)
    print("host:        %s%s" % (socket.gethostname(), "" if socket.gethostname().startswith(MINI) else "   (NOT the mini: never arm here)"))
    print("kill switch: " + ("PAUSED file present, job does nothing" if os.path.exists(os.path.join(REPO, "PAUSED")) else "not paused"))
    print("launchd:     " + ("loaded (armed) as " + LABEL if loaded else "NOT loaded (disarmed)"))
    for k in ("BOARD_SUPABASE_URL", "BOARD_SERVICE_KEY", "BOARD_ALAN_IMESSAGE"):
        print("env %-20s %s" % (k + ":", "set" if env.get(k) else "MISSING in ~/.rsd/board.env"))
    try:
        mode = oct(os.stat(ENV_FILE).st_mode & 0o777)
        print("env file mode: %s%s" % (mode, "" if mode == "0o600" else "   (must be 0o600: chmod 600 ~/.rsd/board.env)"))
    except FileNotFoundError:
        print("env file:    ~/.rsd/board.env does not exist yet")
    try:
        with open(LOG) as f:
            print("last log:    " + (f.read().strip().splitlines() or ["(empty)"])[-1])
    except FileNotFoundError:
        print("last log:    (no runs yet)")
    return 0


def main():
    if "--status" in sys.argv:
        return status()
    if os.path.exists(os.path.join(REPO, "PAUSED")):
        log("PAUSED file present: doing nothing")
        return 0
    if not DRY:
        log("tick start (pid %d) — %s" % (os.getpid(), git_pull()))
    env = read_env()
    if not env.get("BOARD_SUPABASE_URL") or not env.get("BOARD_SERVICE_KEY"):
        return fail("~/.rsd/board.env is missing BOARD_SUPABASE_URL or BOARD_SERVICE_KEY")

    cmd = [NODE, os.path.join(REPO, "scripts", "board.mjs"), "tick", "--json"]
    if "--date" in sys.argv:
        cmd += ["--date", sys.argv[sys.argv.index("--date") + 1]]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=120, cwd=REPO)
    except Exception as e:  # noqa: BLE001
        return fail("could not run board tick: %s" % str(e)[:200])
    if r.returncode != 0:
        return fail("board tick exited %s: %s" % (r.returncode, r.stderr.strip()[:300]))
    try:
        tick = json.loads(r.stdout)
        due = tick["due"]
    except Exception:  # noqa: BLE001
        return fail("board tick printed something that is not the expected JSON: %s" % r.stdout.strip()[:200])

    if not due:
        log("nothing due on %s" % tick.get("date"))
        return 0

    lines = []
    for d in due:
        name = d.get("routine", "?")
        when = " (meeting %s)" % d["meeting"] if d.get("meeting") else ""
        lines.append('%s%s: open Claude on rsd-show-shift-board and say "%s"' % (name, when, SAY.get(name, "run the board " + name)))
    text = "Show Shift Board, %s. Due today, waiting on you:\n%s\n%s" % (tick.get("date"), "\n".join(lines), BOARD_URL)
    log("due: " + ", ".join(d.get("routine", "?") for d in due))

    posted = slack(text)
    sent, why = imessage_alan(text, env)
    if not sent:
        log("IMESSAGE NOT SENT: " + why)
        slack("rsd-show-shift-board tick: the iMessage to Alan did not go out (%s). The due list above is the only notice." % why)
    if not posted and not sent:
        log("FAILED: neither Slack nor iMessage delivered the due list")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
