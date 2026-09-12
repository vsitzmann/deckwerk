# DeckWerk

**DeckWerk is an opinionated cross-platform what-you-see-is-what-you-get slide editor by Vincent Sitzmann.**

*Deck* as in slide deck, and *Werk* as in the German word that means "a work (of art, literature, etc)", a factory, or a structure.

Website and manual: **[deckwerk.org](https://deckwerk.org)**

I designed DeckWerk to bring the ability to create and present polished talks to Linux. It is optimized for presentations centered on video and image content, with animation, tables, plotting, templating, and similar features reduced to the minimum.

DeckWerk is intended for research talks, lectures, demos, and other presentations in which the visual material is the substance.

## Why DeckWerk?

Most presentation software doesn't run on Linux. Web solutions such as Google Slides have minimal video support.

DeckWerk starts from a different set of assumptions:

- Linux should be a first-class platform for authoring and presenting.
- Videos and images should be easy to work with, supporting cropping, trimming, effects, and more.
- An AI agent should be able to edit the same presentation as a person.
- Starting a collaborative session should not require creating accounts or uploading a talk to a third-party service.

These assumptions make DeckWerk opinionated. It is not trying to reproduce every feature of PowerPoint or Keynote. It is trying to make a particular kind of visual, media-rich presentation easy to create and collaborate on in trusted networks and tailnets such as labs or companies.

## Design principles

### Cross-platform

It has to work on Linux :)

### Video is a first-class object

Drag and drop video onto a slide. Crop it, trim it, adjust its appearance, and present it without leaving DeckWerk.

DeckWerk auto-transcodes videos and images into compatible formats.

### Native agent integration

DeckWerk is designed so that AI agents can create and edit presentations directly. The desktop app embeds Codex; on a shared server, every collaborator connects the agent CLI they already use on their own machine with one command from the browser's Agent panel, which mirrors the deck folder locally and keeps it in sync. Only Node is needed.

Agents author slides using the web-layout and front-end skills at which they already excel. They can work within an existing deck’s visual language, reuse its assets and typography, and make changes. When agents author HTML slides that aren't compatible with DeckWerk's editor, they don't break; they simply will not be as editable for the human.

### Effortless collaboration on trusted networks

A collaborative session can run from a laptop or a headless server. Anyone on the same trusted local network—or the same tailnet—can join and begin editing.

Participants see one another’s selections, cursors, and edits in real time.

This mode is intentionally designed for trusted networks. It is not a public document-sharing service and should not be exposed directly to the open internet.

## What DeckWerk is good at

DeckWerk is particularly suited to:

- Research talks and technical presentations
- Video-heavy project demos
- Lectures built around visual examples
- Talks containing many images, clips, diagrams, and animations
- Presentations collaboratively edited by people and AI agents

## Installing

Builds are not yet code-signed, so both macOS and Windows will warn about them.
A Flathub package is planned but not published yet.

**macOS** — via [Homebrew](https://brew.sh):

```bash
brew install --cask --no-quarantine vsitzmann/tap/deckwerk
```

`--no-quarantine` is required while the app is unsigned; without it Gatekeeper
refuses to open it. If you already installed without the flag, clear it with
`xattr -dr com.apple.quarantine /Applications/DeckWerk.app`.

**Windows** — download the installer from the
[latest release](https://github.com/vsitzmann/deckwerk/releases/latest).
SmartScreen will warn about the unsigned installer: choose *More info → Run
anyway*.

**Linux** — an `.AppImage` and a `.deb` are attached to every
[release](https://github.com/vsitzmann/deckwerk/releases).

**Any platform** — build it yourself. Three commands, no cross-compilation
tricks, and it works on distributions the packages above do not cover:

```bash
git clone https://github.com/vsitzmann/deckwerk.git
cd deckwerk && npm ci && npm run dist
```

See [docs/BUILDING.md](docs/BUILDING.md) for prerequisites and the
Python-free variant.

## File format

DeckWerk presentations are stored locally as folders containing the presentation and its media. Videos remain ordinary video files and images remain ordinary image files.

A talk does not need to be uploaded to a service before it can be edited, presented, shared, or archived.

DeckWerk can also export a presentation for playback in a web browser, providing a portable fallback when presenting from another machine.

## Project status

DeckWerk is in *alpha, under active development*. I already use it to author and deliver real presentations, but its interfaces and file format may continue to evolve.

## Development

DeckWerk is an open-source Electron application under the MIT license.

- [docs/BUILDING.md](docs/BUILDING.md) — building from source on any platform
- [docs/RELEASING.md](docs/RELEASING.md) — how signed releases are cut
- [AGENTS.md](AGENTS.md) — architecture, authoring model, and testing notes

## Name

*DeckWerk* combines “deck,” as in a slide deck, with the German word *Werk*: a work, creation, or craft.

## User manual

The user manual covers the workflows that make DeckWerk distinctive:

- [Morph](manual/01-morph.md)
- [Video and images](manual/02-video-and-images.md)
- [Layout](manual/03-layout.md)
- [Collaborating with humans](manual/04-collaborating-with-humans.md)
- [Collaborating with agents](manual/05-collaborating-with-agents.md)
- [Running a headless collaboration server](manual/06-headless-server.md)
