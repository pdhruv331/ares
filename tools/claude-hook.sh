#!/bin/sh
# Claude Code hook -> ARES. Installed by ARES next to its settings (claude-control.js) and run by the user's
# global Claude Code hooks (Stop, StopFailure, Notification) with the event's JSON on stdin.
# Never blocks or fails a Claude session: async in settings, a 2 s timeout here, and always exit 0.
# ARES writes claude-hook.url / claude-hook.headers (mode 600) while it runs and removes them when it quits.
dir=$(dirname "$0")
[ -r "$dir/claude-hook.url" ] && [ -r "$dir/claude-hook.headers" ] || exit 0
curl -s -m 2 -o /dev/null -X POST -H @"$dir/claude-hook.headers" -H 'Content-Type: application/json' \
  --data-binary @- "$(cat "$dir/claude-hook.url")" 2>/dev/null
exit 0
