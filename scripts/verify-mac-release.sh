#!/usr/bin/env bash
# Verify the macOS artifacts of a signed release the way a Mac that downloads
# them will: every .dmg and .zip in the release directory is opened, and the
# DeckWerk.app inside must
#
#   * carry a valid Developer ID signature over the whole bundle,
#   * be accepted by Gatekeeper as notarized,
#   * have its notarization ticket stapled (so it opens offline),
#   * sign every nested executable with the hardened runtime — the frozen
#     importers and ffmpeg included, which notarization also requires,
#   * and still run those executables under the hardened runtime: a missing
#     entitlement does not show up in any signature check, only as a binary
#     the kernel kills the first time someone imports a Keynote file.
#
# Any failure exits non-zero, so the release job stops before publishing.
#
#   scripts/verify-mac-release.sh [release-dir]
#
# APPLE_TEAM_ID, when set, must also be the team every signature names.
set -euo pipefail

RELEASE_DIR=${1:-release}
APP_NAME=DeckWerk.app
WORK=$(mktemp -d)
MOUNTS=()

cleanup() {
  for mount in "${MOUNTS[@]+"${MOUNTS[@]}"}"; do
    hdiutil detach -quiet "$mount" || hdiutil detach -quiet -force "$mount" || true
  done
  rm -rf "$WORK"
}
trap cleanup EXIT

fail() {
  echo "::error::$*" >&2
  exit 1
}

check_app() {
  local app=$1
  echo "--- $app"
  [ -d "$app" ] || fail "$app is missing"

  codesign --verify --deep --strict --verbose=2 "$app"

  local assessment
  assessment=$(spctl --assess --type execute -vv "$app" 2>&1) || {
    echo "$assessment"
    fail "Gatekeeper rejects $app"
  }
  echo "$assessment"
  grep -q 'source=Notarized Developer ID' <<<"$assessment" ||
    fail "$app is accepted, but not as a notarized Developer ID app"

  # stapler compares the stapled ticket with Apple's copy over the network,
  # and a dropped connection fails it with the same exit code as a missing
  # ticket. Retry before calling it a broken release.
  local attempt
  for attempt in 1 2 3 4; do
    xcrun stapler validate "$app" && break
    [ "$attempt" -lt 4 ] || fail "$app has no valid stapled notarization ticket"
    echo "stapler validate failed (attempt $attempt); retrying in $((attempt * 15))s"
    sleep $((attempt * 15))
  done

  # Every Mach-O in the bundle, not just the ones codesign --deep treats as
  # nested code: notarization rejects any executable without a Developer ID
  # signature, the hardened runtime or a secure timestamp, and naming the file
  # here beats decoding the notary log.
  local count=0 file kind details
  while IFS= read -r -d '' file; do
    kind=$(file -b "$file")
    [[ $kind == Mach-O* ]] || continue
    count=$((count + 1))
    details=$(codesign --display --verbose=4 "$file" 2>&1) || fail "$file is not signed"
    grep -q '^Authority=Developer ID Application' <<<"$details" ||
      fail "$file is not signed with a Developer ID"
    grep -Eq '^CodeDirectory .*flags=0x[0-9a-f]*\(.*runtime' <<<"$details" ||
      fail "$file is signed without the hardened runtime"
    grep -q '^Timestamp=' <<<"$details" || fail "$file has no secure timestamp"
    if [ -n "${APPLE_TEAM_ID:-}" ]; then
      grep -qx "TeamIdentifier=$APPLE_TEAM_ID" <<<"$details" ||
        fail "$file is signed by another team: $(grep '^TeamIdentifier=' <<<"$details")"
    fi
  done < <(find "$app" -type f -print0)
  echo "$count Mach-O files: Developer ID, hardened runtime, timestamped"

  # The importers are PyInstaller freezes that unpack and load their own
  # Python at startup; --self-check imports everything an import can reach.
  local resources="$app/Contents/Resources"
  local importer
  for importer in keynote-import pptx-import; do
    "$resources/importers/$importer" --self-check >/dev/null ||
      fail "$importer does not run under the hardened runtime"
  done
  "$resources/app.asar.unpacked/node_modules/ffmpeg-static/ffmpeg" -hide_banner -version >/dev/null ||
    fail "ffmpeg does not run under the hardened runtime"
  # V8 itself: without allow-jit the main binary dies before running any JS.
  ELECTRON_RUN_AS_NODE=1 "$app/Contents/MacOS/DeckWerk" -e 'process.exit(0)' ||
    fail "the DeckWerk binary does not start under the hardened runtime"
  echo "importers, ffmpeg and Electron start under the hardened runtime"
}

shopt -s nullglob
dmgs=("$RELEASE_DIR"/*.dmg)
zips=("$RELEASE_DIR"/*-mac-*.zip)
[ ${#dmgs[@]} -gt 0 ] || fail "no .dmg in $RELEASE_DIR"
[ ${#zips[@]} -gt 0 ] || fail "no mac .zip in $RELEASE_DIR"

for dmg in "${dmgs[@]}"; do
  echo "=== $dmg"
  mount="$WORK/mount-$(basename "$dmg" .dmg)"
  mkdir -p "$mount"
  hdiutil attach -quiet -nobrowse -readonly -mountpoint "$mount" "$dmg"
  MOUNTS+=("$mount")
  check_app "$mount/$APP_NAME"
done

for zip in "${zips[@]}"; do
  echo "=== $zip"
  out="$WORK/unzip-$(basename "$zip" .zip)"
  mkdir -p "$out"
  # ditto, not unzip: it restores the symlinks and extended attributes the
  # framework signatures depend on, as Archive Utility does for a download.
  ditto -x -k "$zip" "$out"
  check_app "$out/$APP_NAME"
done

echo "All macOS artifacts are signed, notarized and stapled."
