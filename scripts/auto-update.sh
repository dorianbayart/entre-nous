#!/bin/sh
# Keeps a relay installed from a git clone at the latest release of the apps. Meant to run once a
# day (cron), e.g. at 4 am:
#   0 4 * * * /path/to/entre-nous/scripts/auto-update.sh >> /path/to/update.log 2>&1
# It follows the releases, not every commit: the relay, the web app and the apps offered for
# download change together. A new release is built at once, but the relay only restarts when
# that loses nothing: no pairing under way, no activity for 10 minutes, and no content held (the
# relay keeps everything in RAM), unless it runs with PERSIST=true (contents saved to disk). It checks every minute, for up to WAIT seconds (23 h), and
# tries again the next day otherwise. While it waits, a newer release replaces the one it built.
#   COMPOSE_DIR   folder of the docker-compose.yml, when it is not the clone itself
#   FORCE=1       restart without waiting; if an update is already waiting, it is told to
#                 restart within a minute
set -eu
PATH=/usr/local/bin:/usr/bin:/bin:$PATH
cd "$(dirname "$0")/.."
CLONE=$(pwd)
STATE=$CLONE/.git/entrenous-deployed # release the running relay was built from
NOW=$CLONE/.git/entrenous-force      # asks the update that is waiting to restart now
WAIT=${WAIT:-82800}
TICK=${TICK:-60} # seconds between two checks of the relay
say() { echo "$(date '+%F %T') $*"; }

if command -v flock >/dev/null; then
  exec 9>"$CLONE/.git/entrenous-update.lock"
  if ! flock -n 9; then
    # an update started earlier is still waiting for the relay to be idle
    if [ -n "${FORCE:-}" ]; then
      touch "$NOW"
      say "an update is already waiting: it restarts the relay within a minute"
    fi
    exit 0
  fi
fi
[ -n "${FORCE:-}" ] || rm -f "$NOW" # left by an update that is no longer running

cd "${COMPOSE_DIR:-$CLONE}"
idle() {
  [ -z "$(docker compose ps -q entrenous)" ] && return 0 # not running: nothing to lose
  docker compose exec -T entrenous wget -qO- http://127.0.0.1:8080/idle >/dev/null 2>&1
}

built=
start=$(date +%s)
ticks=0
while :; do
  # the latest release: at once, then every 10 checks
  if [ $((ticks % 10)) -eq 0 ]; then
    git -C "$CLONE" fetch -q --prune --prune-tags --force origin
    tag=$(git -C "$CLONE" tag -l 'v*' --sort=-v:refname | head -1)
    [ -n "$tag" ] || exit 0
    [ "$(cat "$STATE" 2>/dev/null)" = "$tag" ] && exit 0
    if [ "$tag" != "$built" ]; then
      git -C "$CLONE" checkout -q --detach "$tag"
      # its version, shown in the apps' settings (the image has no git history)
      docker compose build -q --build-arg APP_VERSION="${tag#v}"
      built=$tag
      say "$tag built"
    fi
  fi
  if [ -n "${FORCE:-}" ] || [ -e "$NOW" ] || idle; then break; fi
  if [ $(($(date +%s) - start)) -ge "$WAIT" ]; then
    say "$built waits: the relay was never idle"
    exit 0
  fi
  ticks=$((ticks + 1))
  sleep "$TICK" 9>&- # the lock stays with this script only
done

docker compose up -d
docker image prune -f >/dev/null
echo "$built" > "$STATE"
rm -f "$NOW"
say "$built running"
