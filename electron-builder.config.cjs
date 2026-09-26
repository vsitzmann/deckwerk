'use strict';

/**
 * electron-builder configuration.
 *
 * This lives in its own file rather than package.json's `build` field because
 * signing has to be conditional: the release workflow builds signed artifacts
 * from tags, but the same commands must still produce installable (unsigned)
 * output on a fork, a pull request, or a laptop with no credentials. Encoding
 * that as data in package.json is not possible; encoding it as `if` here is.
 *
 * Naming: the product is DeckWerk everywhere a human reads it, and `deckwerk`
 * everywhere a machine reads it (executable, deb package, artifact files).
 */

const YEAR = new Date().getFullYear();

/**
 * Apple Developer ID signing plus notarization. Both halves are required or
 * neither is useful: a signed-but-unnotarized app is refused by Gatekeeper
 * exactly like an unsigned one, so there is no partial mode worth supporting.
 */
const macSigned = Boolean(process.env.CSC_LINK && process.env.APPLE_ID && process.env.APPLE_TEAM_ID);

/**
 * Azure Trusted Signing. electron-builder drives it through the TrustedSigning
 * PowerShell module, which means it only works when packaging *on* Windows —
 * another reason the release matrix has a real windows runner rather than
 * cross-building.
 */
const winSigned = Boolean(
  process.env.AZURE_TENANT_ID && process.env.AZURE_CLIENT_ID && process.env.AZURE_CLIENT_SECRET,
);

module.exports = {
  appId: 'org.deckwerk.DeckWerk',
  productName: 'DeckWerk',
  copyright: `Copyright © ${YEAR} Vincent Sitzmann`,

  // Installers land in release/, not the default dist/ — dist/collab is an
  // *input* here (it is listed in `files` below), and writing packaged output
  // into a directory the packager is also reading from invites a build that
  // ships its own previous artifacts.
  directories: { output: 'release' },

  files: ['out/**/*', 'dist/collab/**/*', 'package.json'],
  // Every platform ships the frozen Keynote importer, which carries its own
  // Python. scripts/assert-importer-fresh.cjs fails the pack if it is missing
  // or stale, so this path is never allowed to be absent.
  extraResources: [{ from: 'build/importers', to: 'importers' }],
  beforePack: 'scripts/assert-importer-fresh.cjs',
  // Without a Developer ID the mac app is ad-hoc signed here instead, so it
  // still verifies and runs; see the script for why skipping signing broke it.
  afterPack: 'scripts/adhoc-sign-mac.cjs',

  // These ship real executables and .node binaries; they cannot be read from
  // inside an asar archive. src/main/ffmpeg.ts rewrites the path accordingly.
  asarUnpack: [
    '**/node_modules/ffmpeg-static/**',
    '**/node_modules/ffprobe-static/**',
    '**/node_modules/libheif-js/**',
  ],

  // Configured so electron-builder emits the latest*.yml update manifests
  // alongside the installers. The workflow still uploads with `gh release`
  // (`--publish never`), because one GitHub release has to collect artifacts
  // from three separate runners.
  publish: [{ provider: 'github', owner: 'vsitzmann', repo: 'deckwerk' }],

  mac: {
    category: 'public.app-category.productivity',
    icon: 'resources/deckwerk-icon.icns',
    artifactName: 'deckwerk-${version}-mac-${arch}.${ext}',
    // Architecture is chosen by the CLI (`--arm64` / `--x64`), never here: an
    // `arch` array in a target entry silently overrides those flags, and each
    // release runner must build exactly its own architecture so that the
    // natively-frozen Keynote importer matches the app it ships inside.
    // The zip is what electron-updater consumes; the dmg is what people
    // download. Dropping either breaks one of the two paths.
    target: ['dmg', 'zip'],
    hardenedRuntime: macSigned,
    gatekeeperAssess: false,
    entitlements: 'packaging/entitlements.mac.plist',
    entitlementsInherit: 'packaging/entitlements.mac.plist',
    notarize: macSigned,
    // `null` means "do not sign at all". Without it electron-builder hunts the
    // keychain for any Developer ID and fails the build when it finds none.
    ...(macSigned ? {} : { identity: null }),
  },

  dmg: {
    artifactName: 'deckwerk-${version}-mac-${arch}.${ext}',
    contents: [
      { x: 130, y: 220 },
      { x: 410, y: 220, type: 'link', path: '/Applications' },
    ],
  },

  win: {
    // A 1024x1024 png; electron-builder derives the multi-resolution .ico.
    icon: 'resources/deckwerk-icon.png',
    target: ['nsis'],
    ...(winSigned
      ? {
          azureSignOptions: {
            endpoint: process.env.AZURE_CODE_SIGNING_ENDPOINT,
            codeSigningAccountName: process.env.AZURE_CODE_SIGNING_ACCOUNT,
            certificateProfileName: process.env.AZURE_CODE_SIGNING_PROFILE,
          },
        }
      : {}),
  },

  nsis: {
    // A one-click installer would give the user no say in install location and
    // no visible progress; this is a desktop app people install deliberately.
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'DeckWerk',
    uninstallDisplayName: 'DeckWerk',
    artifactName: 'deckwerk-${version}-win-${arch}-setup.${ext}',
  },

  linux: {
    category: 'Office',
    icon: 'resources/deckwerk-icon.png',
    executableName: 'deckwerk',
    maintainer: 'Vincent Sitzmann <sitzmann@mit.edu>',
    vendor: 'Vincent Sitzmann',
    synopsis: 'WYSIWYG slide editor with first-class video support',
    description:
      'DeckWerk is an opinionated cross-platform WYSIWYG slide editor, optimized for ' +
      'presentations centered on video and image content, with native support for ' +
      'agent-assisted authoring and account-free collaboration on trusted networks.',
    desktop: {
      // Electron sets WM_CLASS from the product name, so this is what makes
      // the running window associate with the launcher icon instead of
      // showing up as a second, generic entry in the dock/alt-tab list.
      StartupWMClass: 'DeckWerk',
      Keywords: 'slides;presentation;deck;keynote;talk;',
    },
    artifactName: 'deckwerk-${version}-linux-${arch}.${ext}',
    // tar.gz is the source archive for the Flathub manifest, which installs a
    // prebuilt tree rather than rebuilding Electron inside the Flatpak sandbox.
    target: ['AppImage', 'deb', 'tar.gz'],
  },

  deb: {
    packageName: 'deckwerk',
    // Debian convention, and what the apt repo indexes by.
    artifactName: 'deckwerk_${version}_${arch}.${ext}',
    // electron-builder's defaults still list gconf2, gconf-service and
    // libappindicator1, none of which exist on Debian 12 or Ubuntu 22.04+.
    // Leaving them in produces a .deb that apt refuses to install.
    depends: [
      'libgtk-3-0',
      'libnotify4',
      'libnss3',
      'libxss1',
      'libxtst6',
      'xdg-utils',
      'libatspi2.0-0',
      'libuuid1',
      'libsecret-1-0',
    ],
  },

  appImage: {
    artifactName: 'deckwerk-${version}-linux-${arch}.${ext}',
  },
};
