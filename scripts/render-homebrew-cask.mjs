#!/usr/bin/env node
/**
 * Emit the Homebrew cask for a release.
 *
 * Homebrew verifies a SHA256, not a signature, so the checksums here are the
 * only thing standing between a tap user and a tampered download — they are
 * computed from the exact files being uploaded to the release, never fetched
 * back from the network.
 *
 * Usage:
 *   node scripts/render-homebrew-cask.mjs <version> <x64.dmg> <arm64.dmg> > Casks/deckwerk.rb
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const [version, intelDmg, armDmg] = process.argv.slice(2);
if (!version || !intelDmg || !armDmg) {
  console.error('usage: render-homebrew-cask.mjs <version> <x64.dmg> <arm64.dmg>');
  process.exit(2);
}

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

process.stdout.write(`cask "deckwerk" do
  arch arm: "arm64", intel: "x64"

  version "${version}"
  sha256 arm:   "${sha256(armDmg)}",
         intel: "${sha256(intelDmg)}"

  url "https://github.com/vsitzmann/deckwerk/releases/download/v#{version}/deckwerk-#{version}-mac-#{arch}.dmg",
      verified: "github.com/vsitzmann/deckwerk/"
  name "DeckWerk"
  desc "Slide editor for video-heavy talks"
  homepage "https://deckwerk.org"

  livecheck do
    url :url
    strategy :github_latest
  end

  # The app updates itself (electron-updater, from the same GitHub release),
  # so "brew upgrade" leaves an installed copy alone rather than fighting it;
  # "brew upgrade --greedy" still upgrades it.
  auto_updates true

  depends_on macos: ">= :big_sur"

  app "DeckWerk.app"

  zap trash: [
    "~/Library/Application Support/DeckWerk",
    "~/Library/Caches/org.deckwerk.DeckWerk",
    "~/Library/Preferences/org.deckwerk.DeckWerk.plist",
    "~/Library/Saved Application State/org.deckwerk.DeckWerk.savedState",
    "~/.deckwerk",
  ]
end
`);
