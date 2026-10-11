#!/bin/zsh
# Frame numbers from the real phone (docs/phone-ui-prompt.md §10): tails ARES's JankStats lines (Perf.kt) from logcat while you
# use the launcher; Ctrl-C prints how many frames were over budget, per state. Usage: scripts/phone-jank.sh [serial]
ADB=${ADB:-$HOME/Library/Android/sdk/platform-tools/adb}
[ -n "$1" ] && ADB="$ADB -s $1"
tmp=$(mktemp)
trap 'echo; echo "--- summary ---"; grep -c "jank " $tmp | sed "s/^/jank frames: /"; grep -c "^.*over " $tmp | sed "s/^/over-budget frames: /"; grep -o "[A-Za-z]*=[A-Za-z]*" $tmp | sort | uniq -c | sort -rn | head; grep "summary" $tmp | tail -1; rm -f $tmp' INT
$ADB logcat -c
echo "Use the phone now (flick pages, pull the drawer, throw the bubble, summon). Ctrl-C for the summary."
$ADB logcat -v brief -s ARES.jank | tee $tmp
