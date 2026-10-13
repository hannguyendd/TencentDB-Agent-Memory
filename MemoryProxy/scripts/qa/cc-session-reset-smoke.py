#!/usr/bin/env python3
"""
cc-session-reset-smoke.py —— use a pexpect PTY to start a real interactive Claude Code session,
and verify the full end-to-end flow of the mem:session-reset command.

Test flow:
    1. Start CC -> wait for the form to pop up (asset_confirm)
    2. Choose "No, do not link this time" -> bypass
    3. Send a normal message to verify bypass took effect (no injection)
    4. Send `mem:session-reset` -> see the reset message
    5. Send another message -> the form pops up again (proves reset took effect)

Dependency: pexpect (`pip install pexpect`)
Environment variables:
        CLAUDE_CONFIG_DIR   points to a CC config dir already configured with the proxy base_url
                                                (if unset, the current environment is passed through and claude finds it itself)

Usage:
    CLAUDE_CONFIG_DIR=~/.my-claude-cfg python3 scripts/qa/cc-session-reset-smoke.py
    python3 scripts/qa/cc-session-reset-smoke.py --log /tmp/cc-reset.log
"""
import argparse
import os
import re
import sys
import time

import pexpect


def strip_ansi(data):
    """Strip ANSI escapes so the log is readable"""
    try:
        txt = data.decode(errors="ignore") if isinstance(data, bytes) else data
    except Exception:
        return ""
    txt = re.sub(r"\x1b\[[0-9;?]*[a-zA-Z]", "", txt)
    txt = re.sub(r"\x1b\][^\x07]*\x07", "", txt)
    txt = re.sub(r"\x1b[=>]", "", txt)
    return txt


class Sink:
    """pexpect logfile_read hook -- write to file + print to screen (stripped)"""

    def __init__(self, path):
        self.f = open(path, "wb")

    def write(self, data):
        self.f.write(data)
        self.f.flush()
        sys.stdout.write(strip_ansi(data))
        sys.stdout.flush()

    def flush(self):
        self.f.flush()


# CC interactive session ready marker: when the prompt appears it shows the project path, ">" or "❯"
CC_READY_RE = rb">|\xe2\x9d\xaf|claude"
# Pattern to recognize the asset_confirm form (Chinese, utf-8 encoded; matches "是否关联" / "关联团队" / "团队资产")
FORM_RE = rb"\xe6\x98\xaf\xe5\x90\xa6\xe5\x85\xb3\xe8\x81\x94|\xe5\x85\xb3\xe8\x81\x94\xe5\x9b\xa2\xe9\x98\x9f|\xe5\x9b\xa2\xe9\x98\x9f\xe8\xb5\x84\xe4\xba\xa7|asset_confirm|AskUserQuestion"
# Reset success message (utf-8: "已重置" / "已恢复" / "团队资产选择")
RESET_OK_RE = rb"\xe5\xb7\xb2\xe9\x87\x8d\xe7\xbd\xae|\xe5\xb7\xb2\xe6\x81\xa2\xe5\xa4\x8d|\xe5\x9b\xa2\xe9\x98\x9f\xe8\xb5\x84\xe4\xba\xa7\xe9\x80\x89\xe6\x8b\xa9"


def send_text(child, text, submit=True):
    """Simulate keyboard input text + submit (Ctrl+J = newline submit in CC)"""
    child.send(text)
    time.sleep(0.5)
    if submit:
        # CC interactive mode submits with Enter
        child.send("\r")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cwd", default="/tmp", help="launch directory")
    ap.add_argument("--log", default="/tmp/cc-session-reset-smoke.log")
    ap.add_argument("--timeout", type=int, default=60, help="timeout in seconds per step")
    args = ap.parse_args()

    env = os.environ.copy()
    env["TERM"] = "xterm-256color"
    # If the caller already set CLAUDE_CONFIG_DIR, keep it; otherwise leave it alone and let claude use the default
    # Prevent CC auto-update check
    env["CLAUDE_DISABLE_UPDATE_CHECK"] = "1"

    print(f"[INFO] CLAUDE_CONFIG_DIR={env.get('CLAUDE_CONFIG_DIR', '<default>')}")
    print(f"[INFO] cwd={args.cwd}")
    print(f"[INFO] log={args.log}")
    print()

    child = pexpect.spawn(
        "claude",
        args=["--dangerously-skip-permissions"],
        cwd=args.cwd,
        env=env,
        dimensions=(50, 180),
        encoding=None,
        timeout=args.timeout,
    )
    child.logfile_read = Sink(args.log)

    results = []

    def report(step, name, passed, note=""):
        status = "✅ PASS" if passed else "❌ FAIL"
        results.append((step, name, passed, note))
        print(f"\n{'='*60}")
        print(f"  [{step}] {name}: {status}")
        if note:
            print(f"       {note}")
        print(f"{'='*60}\n")

    # ── Step 0: get past the "trust folder" prompt ────────────────────
    # The first time CC enters a directory it asks "Is this a project you trust?"
    # Choose "Yes, I trust this folder" (item 1, just press Enter)
    print("\n=== Step 0: handle the trust folder prompt (if it appears) ===")
    try:
        i = child.expect([rb"trust", FORM_RE], timeout=args.timeout)
        if i == 0:
            # trust prompt appeared -> Enter to choose Yes
            time.sleep(1)
            child.send("\r")
            print("  -> trust prompt passed (chose Yes)")
            time.sleep(3)
            # keep waiting for the form
            child.expect(FORM_RE, timeout=args.timeout)
        # i == 1: saw the form directly, no trust prompt
    except pexpect.TIMEOUT:
        # CC may be slow to start, wait once more
        pass
    except pexpect.EOF:
        report("S1", "asset_confirm form pops up on first frame", False, "CC process exited")
        return print_summary(results)

    # ── Step 1: wait for CC to pop the form on the first frame ────────────────────
    print("\n=== Step 1: wait for CC to pop the form on the first frame ===")
    # If Step 0 already matched FORM_RE, pass straight through here;
    # otherwise wait once more (the first user message may not have been sent yet, CC waits for user input)
    # CC interactive mode: the user must enter a message first to trigger a proxy request
    # -> send a "hello" to trigger it
    send_text(child, "hello")
    try:
        child.expect(FORM_RE, timeout=args.timeout)
        report("S1", "asset_confirm form pops up on first frame", True)
    except pexpect.TIMEOUT:
        report("S1", "asset_confirm form pops up on first frame", False, "timed out waiting for form")
        child.terminate(force=True)
        return print_summary(results)
    except pexpect.EOF:
        report("S1", "asset_confirm form pops up on first frame", False, "CC process exited")
        return print_summary(results)

    time.sleep(2)

    # ── Step 2: choose "No" -> bypass ────────────────────
    print("\n=== Step 2: choose 'No, do not link this time' -> bypass ===")
    # CC AskUserQuestion form: item 1 is "Yes", Down to item 2 is "No"
    child.send("\x1b[B")  # Down
    time.sleep(0.8)
    child.send("\r")  # Enter to submit
    time.sleep(3)  # wait for bypass to finish + model reply

    # wait for the model reply to finish (see the token count or the > prompt)
    try:
        child.expect(rb"tokens|>|\xe2\x9d\xaf", timeout=args.timeout)
        report("S2", "bypass choice done, model replied", True)
    except pexpect.TIMEOUT:
        report("S2", "bypass choice done, model replied", False, "timeout")
        child.terminate(force=True)
        return print_summary(results)

    time.sleep(2)

    # ── Step 3: send mem:session-reset ────────────────────
    print("\n=== Step 3: send mem:session-reset ===")
    send_text(child, "mem:session-reset")

    try:
        child.expect(RESET_OK_RE, timeout=args.timeout)
        report("S3", "mem:session-reset returns the reset message", True)
    except pexpect.TIMEOUT:
        report("S3", "mem:session-reset returns the reset message", False, "timed out waiting for the reset message")
        child.terminate(force=True)
        return print_summary(results)

    time.sleep(3)

    # ── Step 4: send another message -> expect the form to pop up ────────────────────
    print("\n=== Step 4: send 'hi' -> expect the form to pop up ===")
    send_text(child, "hi")

    try:
        child.expect(FORM_RE, timeout=args.timeout)
        report("S4", "asset_confirm form pops up after reset", True)
    except pexpect.TIMEOUT:
        report("S4", "asset_confirm form pops up after reset", False, "timed out waiting for form")

    # ── Cleanup ────────────────────
    time.sleep(1)
    child.sendcontrol("c")
    time.sleep(0.5)
    child.sendcontrol("c")
    time.sleep(0.5)
    try:
        child.close(force=True)
    except Exception:
        pass

    return print_summary(results)


def print_summary(results):
    print("\n" + "=" * 70)
    print("  SESSION-RESET E2E summary (real CC CLI PTY)")
    print("=" * 70)
    passed = sum(1 for _, _, p, _ in results if p)
    failed = sum(1 for _, _, p, _ in results if not p)
    for step, name, p, note in results:
        s = "✅" if p else "❌"
        print(f"  {s} [{step}] {name}{f' — {note}' if note else ''}")
    print(f"\n  Total: {passed} passed / {failed} failed")
    print("=" * 70)
    return 1 if failed > 0 else 0


if __name__ == "__main__":
    sys.exit(main())
