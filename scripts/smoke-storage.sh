#!/usr/bin/env bash
# End-to-end check of bundled storage, as a fresh install sees it:
#   1. without the storage profile nothing changes (no Garage, no connection);
#   2. with it, "My storage" appears after sign-in and upload / list / download work;
#   3. a full restart duplicates nothing and loses nothing.
# Uses its own compose project and env file, so it never touches a real installation.
#
#   scripts/smoke-storage.sh            # JVINU_PORT to move off 3000; KEEP=1 to leave it running
set -euo pipefail
cd "$(dirname "$0")/.."

export COMPOSE_PROJECT_NAME=jvinu-smoke
export JVINU_PORT="${JVINU_PORT:-3000}"
URL="http://localhost:$JVINU_PORT"
PASSWORD="smoke-test-password-$RANDOM"
work="$(mktemp -d)"
export JVINU_ENV_FILE="$work/smoke.env"
printf 'JVINU_SECRET=%s\nJVINU_ADMIN_PASSWORD=%s\n' "$(openssl rand -hex 32)" "$PASSWORD" > "$JVINU_ENV_FILE"
jar="$work/cookies"

cleanup() {
  if [ "${KEEP:-}" != 1 ]; then docker compose --profile storage down -v --remove-orphans >/dev/null 2>&1 || true; fi
  rm -rf "$work"
}
trap cleanup EXIT

fail() { echo "FAIL: $*" >&2; docker compose --profile storage logs --tail 40 >&2 || true; exit 1; }
wait_healthy() {
  for _ in $(seq 1 60); do curl -sf "$URL/api/health" >/dev/null && return 0; sleep 1; done
  fail "jvinu didn't come up"
}
sign_in() {
  curl -sf -c "$jar" -H "Origin: $URL" -H "content-type: application/json" \
    -d "{\"password\":\"$PASSWORD\"}" "$URL/api/auth/login" >/dev/null || fail "sign-in"
}
connections() { curl -sf -b "$jar" "$URL/api/connections"; }
mine() { connections | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const c=JSON.parse(s).connections.filter(c=>c.managed);console.log(c.length+" "+(c[0]?.id??"")+" "+(c[0]?.name??""))})'; }
csrf() { curl -sf -b "$jar" "$URL/api/session" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).csrf))'; }

echo "== 1. Without the storage profile"
docker compose up -d --build >/dev/null
wait_healthy
sign_in
[ "$(mine)" = "0  " ] || fail "a managed connection appeared without the profile: $(mine)"
docker compose ps --services | grep -qx garage && fail "garage is running without the profile"
echo "   no Garage, no My storage — as before"

echo "== 2. With --profile storage"
docker compose --profile storage up -d >/dev/null
wait_healthy
read -r count id name < <(for _ in $(seq 1 30); do m="$(mine)"; [ "${m%% *}" = 1 ] && { echo "$m"; break; }; sleep 2; done)
[ "${count:-0}" = 1 ] || fail "My storage didn't appear"
echo "   connected: $name ($id)"
token="$(csrf)"
echo "hello from the smoke test" > "$work/hello.txt"
curl -sf -b "$jar" -H "Origin: $URL" -H "x-csrf-token: $token" -X PUT --data-binary @"$work/hello.txt" \
  "$URL/api/connections/$id/upload?key=smoke/hello.txt" >/dev/null || fail "upload"
curl -sf -b "$jar" "$URL/api/connections/$id/objects?prefix=smoke/" | grep -q '"smoke/hello.txt"' || fail "listing"
curl -sf -b "$jar" "$URL/api/connections/$id/object?key=smoke/hello.txt&download=1" -o "$work/back.txt" || fail "download"
cmp -s "$work/hello.txt" "$work/back.txt" || fail "downloaded bytes differ"
curl -sf -b "$jar" "$URL/api/connections/$id/url?key=smoke/hello.txt" | grep -q '"shareable":false' || fail "share link should be app-served"
curl -sf -b "$jar" "$URL/api/connections/$id/disk" | grep -q '"total"' || fail "disk status"
status="$(curl -s -o /dev/null -w '%{http_code}' -b "$jar" -H "Origin: $URL" -H "x-csrf-token: $token" -X DELETE "$URL/api/connections/$id")"
[ "$status" = 403 ] || fail "deleting My storage returned $status, not 403"
echo "   upload, list, download, app-served link, disk status: ok; disconnect refused"

echo "== 3. Restart everything"
docker compose --profile storage down >/dev/null
docker compose --profile storage up -d >/dev/null
wait_healthy
sign_in
sleep 3
read -r count id2 _ < <(mine)
[ "$count" = 1 ] && [ "$id2" = "$id" ] || fail "after restart: $count managed connection(s), id $id2"
keys="$(docker compose exec -T garage /garage key list 2>/dev/null | grep -c ' jvinu' || true)"
[ "$keys" = 1 ] || fail "$keys Garage keys named jvinu"
buckets="$(docker compose exec -T garage /garage bucket list 2>/dev/null | grep -c 'my-files' || true)"
[ "$buckets" = 1 ] || fail "$buckets my-files buckets"
curl -sf -b "$jar" "$URL/api/connections/$id/object?key=smoke/hello.txt" -o "$work/again.txt" || fail "file gone after restart"
cmp -s "$work/hello.txt" "$work/again.txt" || fail "file changed after restart"
echo "   same connection, one key, one bucket, file intact"

echo "PASS"
