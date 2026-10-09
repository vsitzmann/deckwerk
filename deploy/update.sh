#!/usr/bin/env bash
# Deploy the current commit of this checkout to /srv/deckwerk/app and restart.
#
#   systemctl start deckwerk-update    # no sudo (see deckwerk-update.service)
#   sudo ./deploy/update.sh --force    # the same, by hand
#   sudo ./deploy/update.sh            # refuses while someone is connected
#
# Deploys what is committed (HEAD) on whatever branch is checked out, never
# uncommitted work — the same model as TeXWerk's deploy/update.sh. The new
# server checks itself before it listens (importers, ffmpeg, headless
# browser; scripts/collab-server.mts) and refuses to start if anything is
# missing; if it does not come up, the previous version is put back.
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "run with sudo"; exit 1; }
HERE=$(cd "$(dirname "$0")" && pwd)
SRC=${DECKWERK_SRC:-$(cd "$HERE/.." && pwd)}
APP=/srv/deckwerk/app
PREVIOUS=/srv/deckwerk/app.previous
UNIT=deckwerk-collab.service
PORT=5800
HEALTH_TIMEOUT=120
force=0
for a in "$@"; do [[ $a == --force ]] && force=1; done
as_dw() { sudo -u deckwerk env HOME=/srv/deckwerk PATH=/opt/deckwerk-node/bin:/usr/bin "$@"; }
# Built or installed on the server, never in git; the copy leaves them alone.
KEEP=(--exclude /.git --exclude /node_modules --exclude /.venv-import --exclude /dist
      --exclude /out --exclude /build --exclude /REVISION)

if [[ $force == 0 ]] && ss -H -tn state established "( sport = :$PORT )" | grep -q .; then
  echo "someone is connected to DeckWerk right now; re-run later or with --force"; exit 1
fi

# Read the checkout as its owner: as root, git refuses a repository someone
# else owns, and could run hooks configured in it.
owner=$(stat -c %U "$SRC")
as_owner() { runuser -u "$owner" -- "$@"; }
rev=$(as_owner git -C "$SRC" rev-parse HEAD)
branch=$(as_owner git -C "$SRC" rev-parse --abbrev-ref HEAD)
previous_rev=$(cat "$APP/REVISION" 2>/dev/null || echo unknown)
echo "== deploying ${rev:0:7} ($branch) from $SRC, replacing ${previous_rev:0:7}"
if [[ -n $(as_owner git -C "$SRC" status --porcelain --untracked-files=no) ]]; then
  echo "   note: the checkout has uncommitted changes; they are NOT deployed"
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
as_owner git -C "$SRC" archive --format=tar HEAD | tar -x -C "$tmp"
lock_changed=1
cmp -s "$tmp/package-lock.json" "$APP/package-lock.json" 2>/dev/null && lock_changed=0

install -d -o deckwerk -g deckwerk -m 0755 "$PREVIOUS"
rsync -a --delete "${KEEP[@]}" "$APP/" "$PREVIOUS/"
cp -p "$APP/REVISION" "$PREVIOUS/REVISION" 2>/dev/null || true

rsync -a --delete "${KEEP[@]}" "$tmp/" "$APP/"
echo "$rev" > "$APP/REVISION"
chown -R deckwerk:deckwerk "$APP"
cd "$APP"
# npm ci also sets up the importer venv (postinstall); setup:importers keeps
# it in step with importers/requirements.txt when only that changed.
if [[ $lock_changed == 1 || ! -d node_modules ]]; then as_dw npm ci --no-audit --no-fund; fi
as_dw npm run --silent setup:importers

wait_healthy() {
  local deadline=$((SECONDS + HEALTH_TIMEOUT))
  while (( SECONDS < deadline )); do
    [[ $(curl -s -m 3 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/" || true) == 200 ]] && return 0
    sleep 2
  done
  return 1
}

systemctl restart "$UNIT"
if wait_healthy; then
  echo "serving ${rev:0:7} ($branch)"
  exit 0
fi

journalctl -u "$UNIT" -n 40 --no-pager
echo "ERROR: ${rev:0:7} did not come up within ${HEALTH_TIMEOUT}s; putting ${previous_rev:0:7} back"
rsync -a --delete "${KEEP[@]}" "$PREVIOUS/" "$APP/"
cp -p "$PREVIOUS/REVISION" "$APP/REVISION" 2>/dev/null || true
chown -R deckwerk:deckwerk "$APP"
if [[ $lock_changed == 1 ]]; then as_dw npm ci --no-audit --no-fund; fi
systemctl restart "$UNIT"
wait_healthy && echo "rolled back; serving ${previous_rev:0:7} again" || echo "ROLLBACK DID NOT COME UP EITHER"
exit 1
