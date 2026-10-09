#!/usr/bin/env bash
# Once, as root: install the no-sudo deploy path (deckwerk-update.service) and
# the nightly pull-and-deploy (deckwerk-nightly.timer, 04:00 ET). Re-run after
# changing anything in deploy/ so the root-owned copies match.
#
# DeckWerk deploys from this checkout, like TeXWerk. The nightly timer
# fast-forwards it to origin/main first (update.sh --pull). The polkit rule
# that lets vsitzmann start deckwerk-update ships with TeXWerk
# (texwerk/deploy/50-werk-deploy.rules) and already names it.
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "run with sudo"; exit 1; }
HERE=$(cd "$(dirname "$0")" && pwd)
# The old nightly timer deployed a fresh clone from GitHub; the nightly one
# below replaces it.
systemctl disable --now deckwerk-update.timer 2>/dev/null || true
rm -f /etc/systemd/system/deckwerk-update.timer
install -o root -g root -m 0755 "$HERE/update.sh" /usr/local/bin/deckwerk-update
install -o root -g root -m 0644 "$HERE/deckwerk-update.service" /etc/systemd/system/deckwerk-update.service
install -o root -g root -m 0644 "$HERE/deckwerk-nightly.service" /etc/systemd/system/deckwerk-nightly.service
install -o root -g root -m 0644 "$HERE/deckwerk-nightly.timer" /etc/systemd/system/deckwerk-nightly.timer
systemctl daemon-reload
systemctl enable --now deckwerk-nightly.timer
echo "installed; deploy with: systemctl start deckwerk-update"
echo "nightly: $(systemctl list-timers deckwerk-nightly.timer --no-pager | sed -n 2p)"
