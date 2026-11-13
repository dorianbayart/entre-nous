#!/bin/sh
# Keeps a relay installed from a git clone at the latest release of the apps. Meant to run once a
# day (cron), e.g. at 4 am:
#   0 4 * * * /path/to/entre-nous/scripts/auto-update.sh >> /path/to/update.log 2>&1
# It follows the releases, not every commit: the relay, the web app and the apps offered for
# download change together. A new release is built at once, but the relay only restarts when
# that loses nothing: no content held, no pairing under way, no activity for 10 minutes (the
# relay keeps everything in RAM). It checks every minute, for up to WAIT seconds (23 h), and
# tries again the next day otherwise.
#   COMPOSE_DIR   folder of the docker-compose.yml, when it is not the clone itself
#   FORCE=1       restart without waiting
set -eu
PATH=/usr/local/bin:/usr/bin:/bin:$PATH
cd "$(dirname "$0")/.."
CLONE=$(pwd)
STATE=$CLONE/.git/entrenous-deployed # release the running relay was built from
WAIT=${WAIT:-82800}
say() { echo "$(date '+%F %T') $*"; }

if command -v flock >/dev/null; then
  exec 9>"$CLONE/.git/entrenous-update.lock"
  flock -n 9 || exit 0 # still waiting since the day before
fi

git fetch -q --prune --prune-tags --force origin
tag=$(git tag -l 'v*' --sort=-v:refname | head -1)
[ -n "$tag" ] || exit 0
[ "$(cat "$STATE" 2>/dev/null)" = "$tag" ] && exit 0

git checkout -q --detach "$tag"
cd "${COMPOSE_DIR:-$CLONE}"
docker compose build -q
say "$tag built"

idle() {
  [ -z "$(docker compose ps -q entrenous)" ] && return 0 # not running: nothing to lose
  docker compose exec -T entrenous wget -qO- http://127.0.0.1:8080/idle >/dev/null 2>&1
}
start=$(date +%s)
until [ -n "${FORCE:-}" ] || idle; do
  if [ $(($(date +%s) - start)) -ge "$WAIT" ]; then
    say "$tag waits: the relay was never idle"
    exit 0
  fi
  sleep 60
done

docker compose up -d
docker image prune -f >/dev/null
echo "$tag" > "$STATE"
say "$tag running"
