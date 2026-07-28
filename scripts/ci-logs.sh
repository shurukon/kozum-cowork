#!/usr/bin/env bash
# Fetch the verify-logs artifact for a run and print the diagnostics.
set -uo pipefail
REPO="${REPO:-shurukon/kozum-cowork}"
RID="${1:?run id required}"
A=(-H "Authorization: Bearer ${GH_TOKEN}" -H "Accept: application/vnd.github+json")
D=$(mktemp -d)
curl -s "${A[@]}" "https://api.github.com/repos/${REPO}/actions/runs/${RID}/artifacts" -o "$D/a.json"
LID=$(node -e 'const a=require(process.argv[1]);const x=(a.artifacts||[]).find(y=>y.name==="verify-logs");console.log(x?x.id:"")' "$D/a.json")
[ -z "$LID" ] && { echo "no verify-logs artifact"; exit 1; }
curl -sL "${A[@]}" "https://api.github.com/repos/${REPO}/actions/artifacts/${LID}/zip" -o "$D/l.zip"
python3 -c "import zipfile,sys;zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])" "$D/l.zip" "$D"
echo "=== TYPECHECK ($(grep -c 'error TS' "$D/typecheck.log" 2>/dev/null || echo 0) errors) ==="
grep 'error TS' "$D/typecheck.log" 2>/dev/null | sed 's/^/  /' || echo "  clean"
echo "=== TESTS ==="
grep -E '^# (tests|pass|fail)' "$D/tests.log" 2>/dev/null
grep -E '^not ok [0-9]+ - ' "$D/tests.log" 2>/dev/null | sed 's/^/  /' | head -20
echo "=== failure details ==="
grep -E "error: |failureType" "$D/tests.log" 2>/dev/null | grep -v subtestsFailed | sed 's/^/  /' | head -20
echo "=== CAPS ==="; tail -2 "$D/caps.log" 2>/dev/null
