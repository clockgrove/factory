# exec: one Work Item end to end with a crash at each delivery/step point
# (from exec-drill.sh): crash, restart cleanly, finish with every PR merged
# once and one report.
exec_needs() { echo "drill repo + Project; default provider; CI on the drill repo"; }
exec_cost() { echo "~10-15 min per point (7 by default, ~1.5 h); one small Objective per point, each to completion"; }
exec_minutes() { echo 60; }
EXEC_POINTS=${EXEC_POINTS:-deliver:push:before deliver:push:after deliver:pr-create:before deliver:pr-create:after deliver:merge:before deliver:merge:after engine:item:*:work:applied}
EXEC_NAMES=(swapCase countVowels reverseString isPalindrome firstWord lastWord repeatWord dropVowels padLeft joinWords)
EXEC_SPECS=(
'`%s(s)` upper-cases lower-case letters and lower-cases upper-case letters, leaving other characters: `%s("aB-c")` is `"Ab-C"`.'
'`%s(s)` returns how many of the characters a, e, i, o, u (either case) `s` contains: `%s("Hello World")` is `3`.'
'`%s(s)` returns the characters of `s` in reverse order: `%s("abc")` is `"cba"`.'
'`%s(s)` is `true` when `s`, lower-cased with everything except a-z and 0-9 removed, reads the same backwards: `%s("Never odd or even")` is `true`.'
'`%s(s)` returns the first non-empty space-separated word of `s`, or `""` when there is none: `%s("  hi there")` is `"hi"`.'
'`%s(s)` returns the last non-empty space-separated word of `s`, or `""` when there is none: `%s("hi there  ")` is `"there"`.'
'`%s(s, n)` returns `s` repeated `n` times joined by single spaces, and `""` when `n` is 0 or less: `%s("ha", 3)` is `"ha ha ha"`.'
'`%s(s)` returns `s` with every a, e, i, o and u removed, in either case, and every other character kept: `%s("Hello World")` is `"Hll Wrld"`.'
'`%s(s, width)` puts spaces before `s` until it is `width` characters long, and returns `s` unchanged when it is already that long or longer: `%s("ab", 4)` is `"  ab"`.'
'`%s(list)` joins an array of strings with ", " except the last pair, joined with " and ": `%s(["a","b","c"])` is `"a, b and c"`, one item is itself, and an empty array is `""`.'
)
exec_plan() {
  local pt; for pt in $EXEC_POINTS; do
    echo "exec.crash@$pt  one-function Objective; crash, restart, done with PRs merged once, report x1, no duplicates [site: $(node "$SUITE/lib/crashpoints.mjs" "$BUILD" check "$pt" | cut -f2)]"
  done
}

exec_run() {
  # A planner question (say, what "characters" means) takes its recommended answer.
  local g=exec t0 n pt i=0 fn spec p HOLD_POLICY="$HOLD_POLICY decide"
  for pt in $EXEC_POINTS; do
    t0=$(now)
    if [ "$(node "$SUITE/lib/crashpoints.mjs" "$BUILD" check "$pt" | cut -f2)" != yes ]; then
      record "exec.crash@$pt" $g UNREACHABLE "no crashPoint site for $pt in this build" "$t0"; continue; fi
    fn="${EXEC_NAMES[$((i % 10))]}$(uid)"; spec=$(printf "${EXEC_SPECS[$((i % 10))]}" "$fn" "$fn"); i=$((i + 1))
    n=$(new_objective $g exec "exec $fn ($pt)" FN="$fn" SPEC="$spec") || continue
    crash_at "$n" "$pt" 1800
    if [ "$CRASH_R" != 137 ]; then record "exec.crash@$pt" $g FAIL "#$n never crashed ($CRASH_R)" "$t0"; settle_group $g; continue; fi
    serve_start || return
    p=$(wait_phase "$n" 'done|cancelled|failed' 2400)
    sleep 20; serve_stop
    if end_done "$n"; then record "exec.crash@$pt" $g PASS "crashed 137; $EVID" "$t0"
    else record "exec.crash@$pt" $g FAIL "phase=$p; $EVID" "$t0"; fi
  done
}
