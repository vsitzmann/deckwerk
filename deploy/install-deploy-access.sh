#!/usr/bin/env bash
# Once, as root: install the no-sudo deploy path (deckwerk-update.service).
# Re-run after changing deploy/update.sh so the root-owned copy matches.
#
# Replaces the old nightly pull from GitHub: DeckWerk now deploys from this
# checkout, like TeXWerk, so the nightly timer is switched off. The polkit
# rule that lets vsitzmann start the unit ships with TeXWerk
# (texwerk/deploy/50-werk-deploy.rules) and already names deckwerk-update.
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "run with sudo"; exit 1; }
HERE=$(cd "$(dirname "$0")" && pwd)
systemctl disable --now deckwerk-update.timer 2>/dev/null || true
install -o root -g root -m 0755 "$HERE/update.sh" /usr/local/bin/deckwerk-update
install -o root -g root -m 0644 "$HERE/deckwerk-update.service" /etc/systemd/system/deckwerk-update.service
systemctl daemon-reload
echo "installed; deploy with: systemctl start deckwerk-update"
