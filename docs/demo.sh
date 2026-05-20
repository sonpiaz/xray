#!/usr/bin/env bash
# XRay v1.0 launch demo — asciinema-compatible shell script.
#
# Record with:
#   asciinema rec docs/demo.cast -c "bash docs/demo.sh"
#
# Renders the same 5 scenes as docs/demo.tape (VHS) but in a form asciinema
# users can drop straight into a terminal recorder. Pacing matches the tape
# so the two assets stay visually consistent.
#
# Designed to be SAFE to run without any cache hits — every command is
# scripted echo + sleep, no real network. Swap the `echo` lines for live
# `xray ...` calls when recording against a primed cache.

set -e

prompt() { printf '\033[1;36m$\033[0m %s\n' "$1"; }
comment() { printf '\033[1;30m%s\033[0m\n' "$1"; }
pause() { sleep "${1:-1}"; }

clear

# Scene 1 — version sanity check
prompt "xray --version"
echo "xray/1.0.0"
pause 1

echo
comment "# 1. Research a thread end-to-end (cookie tier, no login prompt)"
prompt "xray thread https://x.com/karpathy/status/1234567890"
pause 8

echo
comment "# 2. Same thread, now with embedded video transcript + key moments"
prompt "xray thread https://x.com/AnatoliKopadze/status/2056362875195686927 --video"
pause 12

echo
comment "# 3. Semantic search across everything you've ever researched (zero API cost)"
prompt 'xray search "claude code prompts"'
pause 4

echo
comment "# 4. Topic + stance + expertise profile from the cache"
prompt "xray profile @karpathy"
pause 4
