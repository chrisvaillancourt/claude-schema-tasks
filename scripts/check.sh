#!/usr/bin/env bash
# Runs every gate a commit must pass: validate, test, typecheck.
#
#   scripts/check.sh            all three
#   scripts/check.sh --no-tsc   skip the typecheck (no TypeScript available)
#
# The typecheck needs Claude Code's API declarations. When the engine has
# loaded this folder it lays them in .claude-plugin/types/ (gitignored) and
# that copy is used, with its tools module, when both are there. Otherwise
# the script uses $CLAUDE_CODE_TYPES, or the
# newest copy the plugin-authoring skill wrote under the temp directory, and
# writes a throwaway tsconfig outside the repo. TypeScript comes from
# a `tsc` on PATH, else a pinned `bunx --package typescript@5.9.3 tsc`
# (TS_VERSION to change the pin, TSC to override the command).
set -euo pipefail

root="$(CDPATH= cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
run_tsc=1
[[ "${1:-}" == "--no-tsc" ]] && run_tsc=0

echo "== claude plugin validate"
claude plugin validate "$root"

echo "== claude plugin test"
claude plugin test "$root"

[[ $run_tsc == 0 ]] && { echo "== typecheck skipped"; exit 0; }

types=""
extra_types=()
laid="$root/.claude-plugin/types"
# The engine's copy splits the built-in tools into their own module; without it
# a tool's input types as `unknown`, so use that copy only when it is complete.
if [[ -f "$laid/claude-code/index.d.ts" && -f "$laid/claude-code-tools/index.d.ts" ]]; then
  types="$laid/claude-code/index.d.ts"
  extra_types=("$laid/claude-code-tools/index.d.ts")
  [[ -f "$laid/claude-code-mcp/index.d.ts" ]] && extra_types+=("$laid/claude-code-mcp/index.d.ts")
elif [[ -n "${CLAUDE_CODE_TYPES:-}" ]]; then
  types="$CLAUDE_CODE_TYPES"
else
  # The skill writes claude-code.d.ts per process under the temp dir; take the newest.
  types="$(ls -t /private/tmp/claude-*/bundled-skills/*/*/plugin-authoring/types/claude-code.d.ts \
    "${TMPDIR:-/tmp}"/claude-*/bundled-skills/*/*/plugin-authoring/types/claude-code.d.ts 2>/dev/null | head -1 || true)"
fi
if [[ -z "$types" || ! -f "$types" ]]; then
  echo "typecheck: no Claude Code types found. Load the plugin-authoring skill once, or set CLAUDE_CODE_TYPES." >&2
  exit 1
fi
echo "== typecheck against $(head -1 "$types")"

if [[ -n "${TSC:-}" ]]; then tsc_cmd=($TSC)
elif command -v tsc >/dev/null; then tsc_cmd=(tsc)
elif command -v bunx >/dev/null; then tsc_cmd=(bunx --package "typescript@${TS_VERSION:-5.9.3}" tsc)
else tsc_cmd=(npx --no-install --package "typescript@${TS_VERSION:-5.9.3}" tsc)
fi

tmp="$(mktemp -d)"
include=("\"$types\"" "\"$root/hooks\"" "\"$root/types\"")
for t in ${extra_types[@]+"${extra_types[@]}"}; do include+=("\"$t\""); done
[[ -d "$root/tests" ]] && include+=("\"$root/tests\"")
cat >"$tmp/tsconfig.json" <<EOF
{
  "compilerOptions": {
    "target": "es2023", "lib": ["es2023"], "types": [],
    "module": "esnext", "moduleResolution": "bundler",
    "strict": true, "noUncheckedIndexedAccess": true,
    "noEmit": true, "skipLibCheck": true,
    "jsx": "react", "jsxFactory": "h", "jsxFragmentFactory": "Fragment"
  },
  "include": [$(IFS=,; echo "${include[*]}")]
}
EOF
"${tsc_cmd[@]}" -p "$tmp/tsconfig.json"
echo "typecheck ok"
