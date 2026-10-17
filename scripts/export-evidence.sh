#!/usr/bin/env bash
# Collect submission evidence into ./evidence (timestamped):
#   - full smoke test output
#   - audit_log export
#   - transfers export
#   - compliance rules: enforced vs not_enforced for a sample decision
#
# No secrets or password hashes are written. Reads database credentials from the
# gitignored .env but never prints them.
#
# Usage: bash scripts/export-evidence.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

TS="$(date +%Y%m%d-%H%M%S)"
OUT="evidence"
mkdir -p "$OUT"

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

BASE="http://localhost:${API_PORT:-4000}"

echo "== evidence -> $OUT (run $TS) =="

# 1) Smoke test (resets and reseeds the stack, then runs every assertion).
if [ -f remitwise-seed/remitwise/apps/api/test/smoke.sh ]; then
  echo "Running smoke test ..."
  bash remitwise-seed/remitwise/apps/api/test/smoke.sh 2>&1 | tee "$OUT/smoke-$TS.log"
else
  echo "smoke.sh not found" >&2
fi

# 2/3. Force-export mongo collections (never include password hashes).
mongo_export() { # <collection> <file>
  docker compose exec -T mongo mongosh \
    "mongodb://${MONGO_APP_USER}:${MONGO_APP_PASSWORD}@localhost:27017/${MONGO_APP_DB}?authSource=${MONGO_APP_DB}" \
    --quiet --eval "JSON.stringify(db.$1.find({}, { passwordHash: 0 }).limit(1000).toArray())" 2>/dev/null \
    | tail -1 | jq '.' > "$2" 2>/dev/null || echo '[]' > "$2"
}
if command -v docker >/dev/null 2>&1; then
  echo "Exporting audit_log and transfers ..."
  mongo_export audit_log "$OUT/audit_log-$TS.json"
  mongo_export transfers "$OUT/transfers-$TS.json"
fi

# 4. Rule enforcement snapshot for a representative instruction.
TOKEN=$(curl -s -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' \
  -d "{\"email\":\"tier2@demo.remitwise\",\"password\":\"${DEMO_PASSWORD:-demo1234}\"}" | jq -r '.token')
if [ -n "$TOKEN" ] && [ "$TOKEN" != "null" ]; then
  RULES_JSON=$(curl -s -X POST "$BASE/api/compliance" -H 'Content-Type: application/json' \
    -H "Authorization: Bearer $TOKEN" \
    -d '{"corridor":"BD-MY","amountUSD":8000,"purpose":"tuition","beneficiaryType":"institution","coveragePeriodMonths":12,"isFirstRelease":true}')
  {
    echo "Compliance snapshot (corridor BD-MY, 8000 USD tuition)"
    echo
    printf '%-12s %-16s %s\n' RULE STATUS RESULT
    echo "$RULES_JSON" | jq -r '.ruleResults[] | [.ruleId, .status, (if .passed then "pass" else .outcome end)] | @tsv' \
      | awk -F'\t' '{printf "%-12s %-16s %s\n", $1, $2, $3}'
    echo
    echo "enforced:     $(echo "$RULES_JSON" | jq -r '[.ruleResults[]|select(.status=="enforced")|.ruleId]|join(", ")')"
    echo "not_enforced: $(echo "$RULES_JSON" | jq -r '[.ruleResults[]|select(.status=="not_enforced")|.ruleId]|join(", ")')"
    echo "not_applicable: $(echo "$RULES_JSON" | jq -r '[.ruleResults[]|select(.status=="not_applicable")|.ruleId]|join(", ")')"
  } | tee "$OUT/rules-$TS.txt"
else
  echo "Could not log in for rule snapshot" >&2
fi

echo
echo "Evidence written to $OUT/ :"
ls -1 "$OUT" | sed 's/^/  /'
