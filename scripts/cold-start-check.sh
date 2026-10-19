#!/usr/bin/env bash
#
# Cold-start check for RemitWise.
#
# What it does, on a clean clone of this repo's current branch:
#   1. clones the repo (current branch) into a temp directory
#   2. copies .env.example to .env and forces LLM_API_KEY empty (offline mode)
#   3. starts its own docker compose project (own name, own API port)
#   4. waits for /api/health
#   5. runs the smoke test, prints PASS/FAIL
#   6. tears the project down, including volumes
#
# It never reads or prints .env or any key. It uses a separate compose project
# name so it cannot touch your running stack's containers or volume.
#
# IMPORTANT: the mongodb container binds host port 27017 (hardcoded in
# docker-compose.yml), so stop any other RemitWise stack before running this:
#     docker compose down
# The API port is overridden (4099) so it does not clash with a dev API on 4000.
#
# Usage:  bash scripts/cold-start-check.sh

set -uo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
BRANCH="$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo HEAD)"
PROJECT="coldstart-rw"
API_PORT="${COLDSTART_API_PORT:-4099}"
WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/coldstart.XXXXXX")"
CLONE="$WORKDIR/repo"

cleanup() {
  if [ -d "$CLONE" ]; then
    ( cd "$CLONE" && COMPOSE_PROJECT_NAME="$PROJECT" docker compose down -v >/dev/null 2>&1 )
  fi
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

echo "== RemitWise cold-start check =="
echo "repo:    $REPO_ROOT"
echo "branch:  $BRANCH"
echo "project: $PROJECT (api port $API_PORT)"
echo

if command -v lsof >/dev/null 2>&1 && lsof -iTCP:27017 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "FAIL: host port 27017 is already in use. Stop the other stack first: docker compose down"
  exit 1
fi

echo "1) cloning $BRANCH into $CLONE"
if ! git clone --quiet --branch "$BRANCH" --single-branch "$REPO_ROOT" "$CLONE"; then
  echo "FAIL: git clone failed"
  exit 1
fi

cd "$CLONE" || { echo "FAIL: cannot enter clone"; exit 1; }

echo "2) writing .env from .env.example (offline mode)"
cp .env.example .env
# Force offline mode. This edits the file; it is never printed.
sed -i 's/^LLM_API_KEY=.*/LLM_API_KEY=/' .env
# Own API port so we do not clash with a dev API on 4000.
sed -i "s/^API_PORT=.*/API_PORT=$API_PORT/" .env
if ! grep -q "^API_PORT=$API_PORT\$" .env; then
  printf 'API_PORT=%s\n' "$API_PORT" >> .env
fi
if ! grep -q '^LLM_API_KEY=[[:space:]]*$' .env; then
  echo "FAIL: LLM_API_KEY is not empty after setup; refusing to start a live provider"
  exit 1
fi

export COMPOSE_PROJECT_NAME="$PROJECT"

echo "3) docker compose up -d --build"
if ! docker compose up -d --build; then
  echo "FAIL: docker compose up failed"
  docker compose logs --no-color seed 2>&1 | tail -30
  exit 1
fi

echo "4) waiting for http://localhost:$API_PORT/api/health"
HEALTH=""
for _ in $(seq 1 60); do
  HEALTH="$(curl -s "http://localhost:$API_PORT/api/health" || true)"
  case "$HEALTH" in
    *'"ok":true'*) break ;;
  esac
  sleep 3
done
if ! printf '%s' "$HEALTH" | grep -q '"ok":true'; then
  echo "FAIL: health check did not become ready"
  echo "last health response: ${HEALTH:-<empty>}"
  echo "--- api logs (tail) ---"
  docker compose logs --no-color api 2>&1 | tail -30
  echo "--- seed logs (tail) ---"
  docker compose logs --no-color seed 2>&1 | tail -30
  exit 1
fi
echo "   health: $HEALTH"

echo "5) running smoke test"
if API_PORT="$API_PORT" bash remitwise-seed/remitwise/apps/api/test/smoke.sh > "$WORKDIR/smoke.log" 2>&1; then
  SUMMARY="$(tail -5 "$WORKDIR/smoke.log" | grep -E 'PASS=' | tail -1)"
else
  SUMMARY="$(tail -5 "$WORKDIR/smoke.log" | grep -E 'PASS=' | tail -1)"
fi

echo
echo "--- smoke summary ---"
grep -E '^PASS=|^FAIL=' "$WORKDIR/smoke.log" | tail -1
echo "--- end ---"

if printf '%s' "$SUMMARY" | grep -q 'FAIL=0'; then
  echo
  echo "COLD START: PASS ($SUMMARY)"
  exit 0
else
  echo
  echo "COLD START: FAIL ($SUMMARY)"
  echo "--- smoke output (tail) ---"
  tail -30 "$WORKDIR/smoke.log"
  exit 1
fi
