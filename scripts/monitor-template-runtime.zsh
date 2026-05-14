#!/bin/zsh
set -euo pipefail

if (( $# < 3 )); then
  echo "Usage: $0 <session-name> -- <command...>" >&2
  echo "Example: $0 dashrunner-cert-01 -- npm run build" >&2
  exit 1
fi

session_name="$1"
shift

if [[ "$1" != "--" ]]; then
  echo "Usage: $0 <session-name> -- <command...>" >&2
  exit 1
fi
shift

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
monitor_root="$repo_root/handoffs/runtime-monitor/$session_name"
raw_log="$monitor_root/raw.log"
critical_log="$monitor_root/critical.log"
summary_file="$monitor_root/summary.md"
meta_file="$monitor_root/meta.env"
timestamp="$(date '+%Y-%m-%d %H:%M:%S %z')"

mkdir -p "$monitor_root"
: > "$raw_log"
: > "$critical_log"

cat > "$summary_file" <<EOF
# Runtime Monitor Summary

- Session: \`$session_name\`
- Started: \`$timestamp\`
- Working directory: \`$(pwd)\`
- Command: \`$*\`
- Raw log: \`$raw_log\`
- Critical log: \`$critical_log\`
- Status: \`running\`

## Critical Patterns

- auth
- avatar
- leaderboard
- matchmaking
- room lifecycle
- build failures
- publish failures
- uncaught exceptions
- syntax/type/reference errors

## Last Critical Lines

\`\`\`
\`\`\`
EOF

cat > "$meta_file" <<EOF
SESSION_NAME=$session_name
STARTED_AT=$timestamp
RAW_LOG=$raw_log
CRITICAL_LOG=$critical_log
SUMMARY_FILE=$summary_file
EOF

echo "Runtime monitor session: $session_name"
echo "Raw log: $raw_log"
echo "Critical log: $critical_log"
echo "Summary: $summary_file"

set +e
"$@" 2>&1 | tee -a "$raw_log" | while IFS= read -r line; do
  line_ts="$(date '+%Y-%m-%d %H:%M:%S')"
  lower_line="$(printf '%s' "$line" | tr '[:upper:]' '[:lower:]')"
  if printf '%s\n' "$lower_line" | grep -Eq '(auth|avatar|leaderboard|matchmaking|room|publish|build failed|error|uncaught|exception|typeerror|syntaxerror|referenceerror|falling back|timeout|failed|warning)'; then
    printf '[%s] %s\n' "$line_ts" "$line" >> "$critical_log"
  fi
done
cmd_exit=$?
set -e

last_critical="$(tail -n 20 "$critical_log" 2>/dev/null || true)"

cat > "$summary_file" <<EOF
# Runtime Monitor Summary

- Session: \`$session_name\`
- Started: \`$timestamp\`
- Finished: \`$(date '+%Y-%m-%d %H:%M:%S %z')\`
- Working directory: \`$(pwd)\`
- Command: \`$*\`
- Exit code: \`$cmd_exit\`
- Raw log: \`$raw_log\`
- Critical log: \`$critical_log\`
- Status: \`$([[ "$cmd_exit" -eq 0 ]] && echo success || echo failed)\`

## Critical Patterns

- auth
- avatar
- leaderboard
- matchmaking
- room lifecycle
- build failures
- publish failures
- uncaught exceptions
- syntax/type/reference errors

## Last Critical Lines

\`\`\`
$last_critical
\`\`\`
EOF

echo
echo "Exit code: $cmd_exit"
echo "Summary updated: $summary_file"
exit "$cmd_exit"
