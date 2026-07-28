#!/usr/bin/env bash
# Poll the latest GitHub Actions run and pull its logs back locally.
#
# Usage:  GH_TOKEN=... scripts/ci.sh [max_polls]
#
# The token is read from the environment only — never written to disk, never
# echoed, and never persisted in a git remote.
set -uo pipefail

REPO="${REPO:-shurukon/kozum-cowork}"
MAX="${1:-60}"
API="https://api.github.com/repos/${REPO}"
AUTH=(-H "Authorization: Bearer ${GH_TOKEN}" -H "Accept: application/vnd.github+json")

if [ -z "${GH_TOKEN:-}" ]; then
  echo "GH_TOKEN not set" >&2
  exit 2
fi

for i in $(seq 1 "$MAX"); do
  curl -s "${AUTH[@]}" "${API}/actions/runs?per_page=1" -o /tmp/ci_runs.json
  # Process substitution is unavailable in some sandboxes, so round-trip
  # through a plain file instead of `read < <(...)`.
  node -e '
    const r = require("/tmp/ci_runs.json");
    const x = (r.workflow_runs || [])[0];
    if (!x) { console.log("none - - -"); process.exit(0); }
    console.log([x.status, x.conclusion ?? "-", x.id, x.run_number].join(" "));
  ' > /tmp/ci_state.txt
  STATUS=$(cut -d' ' -f1 /tmp/ci_state.txt)
  CONCL=$(cut -d' ' -f2 /tmp/ci_state.txt)
  RID=$(cut -d' ' -f3 /tmp/ci_state.txt)
  NUM=$(cut -d' ' -f4 /tmp/ci_state.txt)
  printf "\r[%02d] run #%s  %s/%s        " "$i" "$NUM" "$STATUS" "$CONCL"
  [ "$STATUS" = "completed" ] && break
  sleep 15
done
echo

if [ "${RID:-}" = "-" ] || [ -z "${RID:-}" ]; then
  echo "no run found" >&2
  exit 1
fi

curl -s "${AUTH[@]}" "${API}/actions/runs/${RID}/jobs" -o /tmp/ci_jobs.json
node -e '
const j = require("/tmp/ci_jobs.json");
for (const job of j.jobs || []) {
  console.log(`\n[${job.name}] ${job.status}/${job.conclusion ?? "-"}`);
  for (const s of job.steps || []) {
    const mark = s.conclusion === "success" ? "ok  "
      : s.conclusion === "failure" ? "FAIL"
      : s.conclusion === "skipped" ? "--  " : "..  ";
    console.log(`  ${mark} ${s.name}`);
  }
}'

# Pull the log of every job that did not succeed; that is where the signal is.
node -e '
const j = require("/tmp/ci_jobs.json");
const bad = (j.jobs||[]).filter(x => x.conclusion && x.conclusion !== "success" && x.conclusion !== "skipped");
console.log(bad.map(x => x.id + ":" + x.name.replace(/\s+/g,"_")).join("\n"));
' > /tmp/ci_bad.txt

while IFS=: read -r jid jname; do
  [ -z "$jid" ] && continue
  echo
  echo "======== log: ${jname} ========"
  curl -sL "${AUTH[@]}" "${API}/actions/jobs/${jid}/logs" -o "/tmp/ci_${jid}.log"
  # Strip timestamps and grouping noise, keep the diagnostics.
  sed -E 's/^[0-9T:.\-]+Z //' "/tmp/ci_${jid}.log" \
    | grep -v -E '^##\[(group|endgroup)\]' \
    | tail -n "${TAIL:-120}"
done < /tmp/ci_bad.txt

echo
echo "run id: ${RID}  conclusion: ${CONCL}"
[ "$CONCL" = "success" ] || exit 1
