# DeckWerk

**DeckWerk is an opinionated cross-platform what-you-see-is-what-you-get slide editor by Vincent Sitzmann.**

*Deck* as in slide deck, and *Werk* as in the German word that means "a work (of art, literature, etc)", a factory, or a structure.

Website: **[deckwerk.org](https://deckwerk.org)**

I designed DeckWerk to bring the ability to create and present polished talks to Linux. It is optimized for presentations centered on video and image content, with animation, tables, plotting, templating, and similar features reduced to the minimum.

DeckWerk is intended for research talks, lectures, demos, and other presentations in which the visual material is the substance.

[![DeckWerk demo video](https://img.youtube.com/vi/qBjTRFZvtbA/maxresdefault.jpg)](https://www.youtube.com/watch?v=qBjTRFZvtbA)

*Watch the [demo on YouTube](https://www.youtube.com/watch?v=qBjTRFZvtbA).*

## Installing

**macOS** — via [Homebrew](https://brew.sh):

```bash
brew install --cask vsitzmann/tap/deckwerk
```

**Linux (x64)** — download the `.AppImage`, `.deb`, or `.tar.gz` from the
[latest release](https://github.com/vsitzmann/deckwerk/releases/latest). On
Debian and Ubuntu:

```bash
sudo apt install ./deckwerk_*_amd64.deb
```

**Windows** — download the `setup.exe` from the
[latest release](https://github.com/vsitzmann/deckwerk/releases/latest).

**From source** — you will need [Node.js](https://nodejs.org/) 22 or newer,
Python 3.10 or newer, and Git:

```bash
git clone https://github.com/vsitzmann/deckwerk.git
cd deckwerk
npm ci
npm run dist
```

The platform-specific installer lands in `release/`. See
[docs/BUILDING.md](docs/BUILDING.md) for platform-specific details and for
running DeckWerk directly without packaging it first.

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

DeckWerk is designed so that AI agents can create and edit presentations directly. It does not run or own an agent account: for a local presentation, the **Agent…** button gives you its real deck folder and no server is involved. In a browser collaboration session, the same button gives you one command that mirrors the remote live deck folder onto your machine and keeps it in sync. Only Node is needed for that remote bridge.

In both cases the authoring loop is the same: run `slide-agent context`, export or create an HTML file under `edit/`, then edit and save it. DeckWerk compiles that HTML into ordinary editable slide objects, applies the save as one named undoable change, and shows it in History. JavaScript-driven content is explicitly staged as a web element; titles, captions, and other non-interactive content remain normal editable objects.

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
