# Releasing DeckWerk

Cutting a release is `npm version` plus a tag push. Everything else —
building, signing, notarizing, and updating the Homebrew and Flathub
channels — is [`.github/workflows/release.yml`](../.github/workflows/release.yml).

```bash
npm version minor          # updates package.json and creates the v<x.y.z> tag
git push origin main --follow-tags
```

The workflow refuses to run if the tag and `package.json` disagree, so the
`npm version` step is not optional.

To rehearse without publishing anything, run the workflow manually from the
Actions tab with **dry run** left checked: it builds and signs on all four
runners and uploads the installers as workflow artifacts, but creates no
release and touches no channel.

## Why four runners for three operating systems

Nothing here can be cross-built:

- `ffmpeg-static` and `ffprobe-static` fetch a binary for the *install* host
  during `npm ci`, and `src/main/ffmpeg.ts` ships whatever it finds.
- The Keynote and PowerPoint importers are PyInstaller freezes, and
  PyInstaller cannot cross-compile — not even between macOS architectures.
  Hence a `macos-15` (arm64) job and a `macos-15-intel` (x64) job rather than
  one universal build. GitHub retires runner images regularly (`macos-13` is
  gone, `macos-14` deprecated); the current table is at
  github.com/actions/runner-images.
- Notarization only runs on macOS; Azure Trusted Signing only runs on Windows,
  because electron-builder drives it through a PowerShell module.

Linux builds on `ubuntu-22.04` deliberately. A binary linked against a newer
glibc will not start on an older distribution, while the reverse is fine, so
the oldest supported base wins. `ubuntu-22.04` is deprecated from
2026-09-17 and removed 2027-04-17; move to `ubuntu-24.04` before then.

If `TAP_GITHUB_TOKEN` is not set, the Homebrew job logs a warning and skips
rather than failing the release.

## One-time setup

### 1. Apple Developer ID (macOS)

Without this, macOS refuses to open the app at all — including when it was
installed through Homebrew, which applies the same quarantine attribute a
browser download would. Signing without notarization is not a partial win;
Gatekeeper treats it exactly like unsigned.

Export the *Developer ID Application* certificate as a `.p12`, then:

```bash
base64 -i DeveloperID.p12 | pbcopy    # -> CSC_LINK
```

| Secret | Value |
| --- | --- |
| `CSC_LINK` | base64 of the `.p12` |
| `CSC_KEY_PASSWORD` | password used when exporting the `.p12` |
| `APPLE_ID` | Apple ID email |
| `APPLE_APP_SPECIFIC_PASSWORD` | app-specific password from appleid.apple.com |
| `APPLE_TEAM_ID` | 10-character team ID |

`electron-builder.config.cjs` turns signing *and* notarization off together
when any of these is absent, so pull requests, forks and dry runs without the
secrets still produce a (unsigned, ad-hoc) build. A tag push or a non-dry-run
dispatch is different: the **Check Apple signing credentials** step fails the
release rather than publish a macOS build people cannot open.

With the secrets present, each macOS runner:

1. signs every executable in the bundle with the Developer ID, the hardened
   runtime and a secure timestamp — Electron and its helpers, but also the
   frozen importers and ffmpeg/ffprobe, which notarization checks just as
   strictly ([`packaging/entitlements.mac.plist`](../packaging/entitlements.mac.plist)
   says why each entitlement is there);
2. submits the app to Apple with `notarytool`, waits for the verdict, and
   staples the ticket to the app, so it opens offline;
3. builds the dmg and zip around that stapled app;
4. runs [`scripts/verify-mac-release.sh`](../scripts/verify-mac-release.sh),
   which opens the dmg and the zip and checks the app in each with
   `codesign --verify --deep --strict`, `spctl` (must say *Notarized Developer
   ID*), `xcrun stapler validate`, a per-file check of every nested Mach-O,
   and by actually running the importers, ffmpeg and Electron under the
   hardened runtime. Any failure stops the job before anything is published.

The dmg itself is not signed: Gatekeeper judges the app inside it, which is
notarized and stapled. When notarization fails, the Package step's error
carries Apple's per-file diagnostics; `xcrun notarytool log <submission id>
--apple-id … --team-id … --password …` fetches them again.

### 2. Azure Trusted Signing (Windows)

Create a Trusted Signing account and certificate profile, then an Entra ID
app registration with the **Trusted Signing Certificate Profile Signer** role
on that account.

| Repository secret | Value |
| --- | --- |
| `AZURE_TENANT_ID` | directory (tenant) ID |
| `AZURE_CLIENT_ID` | application (client) ID |
| `AZURE_CLIENT_SECRET` | client secret |

| Repository variable | Example |
| --- | --- |
| `AZURE_CODE_SIGNING_ENDPOINT` | `https://eus.codesigning.azure.net` |
| `AZURE_CODE_SIGNING_ACCOUNT` | Trusted Signing account name |
| `AZURE_CODE_SIGNING_PROFILE` | certificate profile name |

The identifiers are not secret and live in variables so they are visible in
logs when a signing run goes wrong.

### 3. Homebrew tap (macOS)

Create a public repository `vsitzmann/homebrew-tap`, then add a fine-grained
PAT with **contents: read and write** on it as the secret
`TAP_GITHUB_TOKEN` — the default `GITHUB_TOKEN` is scoped to this repository
and cannot push to the tap.

```bash
brew install --cask vsitzmann/tap/deckwerk
```

Moving into homebrew-cask proper needs the project to clear their notability
bar; the tap has no such requirement and works from the first release.

### 4. Flathub (Linux)

A one-time manual submission, because Flathub builds from its own repository
rather than from this one.

1. Add real screenshots at `docs/assets/screenshots/editor.png` and
   `presenter.png` on the default branch. Flathub rejects submissions whose
   screenshot URLs 404, and at least one screenshot is required.
2. Prove control of `deckwerk.org`, since the app ID is `org.deckwerk.DeckWerk`.
   A live site at that domain is sufficient.
3. Open a pull request against `flathub/flathub` adding
   [`flatpak/org.deckwerk.DeckWerk.yml`](../flatpak/org.deckwerk.DeckWerk.yml).

Verify locally first:

```bash
flatpak install -y flathub org.flatpak.Builder
flatpak run org.flatpak.Builder --force-clean --sandbox --user --install \
  builddir flatpak/org.deckwerk.DeckWerk.yml
flatpak run --command=flatpak-builder-lint org.flatpak.Builder manifest \
  flatpak/org.deckwerk.DeckWerk.yml
```

After acceptance, each release opens a pull request here regenerating the
manifest's `url` and `sha256`; copy that two-line diff into a pull request
against `flathub/org.deckwerk.DeckWerk`.

`runtime-version` must name a runtime Flathub still supports. Check with
`flatpak remote-ls flathub --system | grep org.freedesktop.Platform` and bump
it when the current one reaches end of life.

## What ships where

| Platform | Channel | Artifact |
| --- | --- | --- |
| macOS | `brew install --cask vsitzmann/tap/deckwerk` | `deckwerk-<v>-mac-{arm64,x64}.dmg` |
| Linux | Flathub | `deckwerk-<v>-linux-x64.tar.gz` |
| Linux | direct download | `deckwerk-<v>-linux-x64.AppImage`, `deckwerk_<v>_amd64.deb` |
| Windows | GitHub Release | `deckwerk-<v>-win-x64-setup.exe` |
| Any | build from source | [BUILDING.md](BUILDING.md) |

The `.deb` is still built and attached to each release, so Debian and Ubuntu
users can `sudo apt install ./deckwerk_<v>_amd64.deb`. There is no apt
repository, so it does not update itself — Flathub is the auto-updating Linux
channel.

## In-app updates

The desktop app updates itself from GitHub Releases with `electron-updater`
([`src/main/updates.ts`](../src/main/updates.ts)). **DeckWerk menu → Check for
Updates…** (also under About in the macOS app menu) asks the feed; the app
never checks by itself. A newer release is offered with its notes, and is
downloaded only after **Update** is confirmed, with progress in the status
bar. **Restart Now** first has every window save its deck, refusing while
anything is unsaved, a presentation is on screen, or people are connected to
a shared deck. **Later** installs nothing — not even on quit; the next Check
for Updates offers the restart again.

| Install | How it updates | What the app reads from the release |
| --- | --- | --- |
| macOS (dmg or Homebrew) | Squirrel.Mac, from the zip | `latest-mac.yml`, `deckwerk-<v>-mac-{arm64,x64}.zip` (+ `.blockmap`) |
| Windows | NSIS, silent reinstall | `latest.yml`, `deckwerk-<v>-win-x64-setup.exe` (+ `.blockmap`) |
| Linux AppImage (`$APPIMAGE` set) | replaces the AppImage | `latest-linux.yml`, `deckwerk-<v>-linux-x86_64.AppImage` |
| Linux `.deb` / tar.gz | no self-update: the menu opens the release page | — |
| Flatpak (`$FLATPAK_ID` set) | no self-update: the menu opens the release page (`flatpak update` once on Flathub) | — |
| `npm run dev`, unpackaged | nothing; the menu says so | — |

The workflow keeps the two macOS runners' manifests apart
(`latest-mac-<arch>.yml`) and merges them into one `latest-mac.yml` naming
both zips — electron-updater picks the one with `arm64` in its name on Apple
silicon. `scripts/update-manifests.mjs check` then fails the release job,
dry runs included, if any of the three manifests is missing or lists a file
that is not attached with the sha512 it claims.

The Homebrew cask declares `auto_updates true`, so `brew upgrade` leaves a
self-updating install alone (`brew upgrade --greedy` still upgrades it).

### Trying an update end to end

`DECKWERK_UPDATE_FEED=<url>` points the updater at a generic feed — a folder
of `latest*.yml` and installers served over HTTP — instead of GitHub, so an
update can be tried from two dry-run builds without publishing anything.

1. Run the workflow as a dry run (see the top of this file) at version *N*.
   Download your platform's `installers-*` artifact and install that app. On
   macOS move it to `/Applications` first: Squirrel.Mac cannot replace an app
   that macOS is running from a translocated quarantine copy.
2. On a scratch branch, bump `package.json` to a higher version (say
   `npm version patch --no-git-tag-version`), push it, and run a second dry
   run from that branch. Download its artifact into an empty folder `feed/`.
   On macOS, the artifact's manifest is `latest-mac-<arch>.yml`: rename it
   to `latest-mac.yml` (or merge both arches with
   `node scripts/update-manifests.mjs merge-mac`).
3. Serve it: `python3 -m http.server 8000 --directory feed`.
4. Start the installed version-*N* app with the feed:
   - macOS: `DECKWERK_UPDATE_FEED=http://127.0.0.1:8000/ /Applications/DeckWerk.app/Contents/MacOS/DeckWerk`
   - Linux: `DECKWERK_UPDATE_FEED=http://127.0.0.1:8000/ ./deckwerk-<N>-linux-x86_64.AppImage`
   - Windows (PowerShell): `$env:DECKWERK_UPDATE_FEED='http://127.0.0.1:8000/'; & "$env:LOCALAPPDATA\Programs\deckwerk\DeckWerk.exe"`
5. **DeckWerk menu → Check for Updates…** → Update → Restart Now. The app
   reopens; **About DeckWerk** shows the new version.

The Linux leg of every release run does this for the AppImage by itself
(**Check the AppImage updates itself**): it repackages the build as the next
patch version into `update-smoke/` (never uploaded), serves it as the feed,
and runs [`scripts/smoke-test-appimage-update.mjs`](../scripts/smoke-test-appimage-update.mjs)
under Xvfb — Check for Updates…, Update, Restart Now — then checks the new AppImage
replaced the old one and relaunched as the new version. A release whose
AppImage cannot update itself fails there.

Squirrel.Mac only installs an update signed by the same Developer ID as the
running app, so on macOS both dry runs must have had the signing secrets.
`test/updateCheckDesktopBrowser.test.ts` drives the same feed override against
the unpackaged app for the check and its dialogs; the download and install
are only exercised this way.

## Known gaps

- **No Linux arm64.** Adding it means another matrix entry on an arm runner;
  nothing in the configuration assumes x64. Until then, arm64 Linux users
  build from source ([BUILDING.md](BUILDING.md)).
- **Windows updates are unsigned.** Until Azure Trusted Signing is live the
  installer electron-updater downloads is unsigned, and it checks no
  publisher. Once signing lands, check that the generated `app-update.yml`
  carries the certificate's `publisherName`, or updates will be accepted from
  any signer.
- **No self-update for the `.deb`.** It belongs to dpkg; the menu opens the
  release page instead. An apt repository would make `apt upgrade` the
  update path.
