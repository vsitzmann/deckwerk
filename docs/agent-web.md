# Web elements

Use a web element only for content that needs JavaScript. Keep the slide title,
caption, source, and legend as ordinary slide objects outside the web box.

## Existing web element: fastest path

From the deck folder:

    slide-agent context . --around 9
    slide-agent render . --slide 8,9,10 --output /tmp/before
    slide-agent web inspect . 9
    slide-agent web check source.html --replace 9 --screenshot /tmp/check.png
    slide-agent web replace . 9 source.html
    slide-agent render . --slide 9 --output /tmp/final
    slide-agent validate . --slide 9

`web inspect` reports the element id, staged source, poster, exact box size, and
statically detectable missing local assets. `web check --replace` uses that box
size without changing the deck. `web replace` also checks and captures its new
poster at the existing box size; it replaces the page rather than adding a
second slide.

## New web element

For an interactive region inside an ordinary slide:

    slide-agent web check chart.html --size 1680x620
    slide-agent web add . chart.html --size 1680x620 --title "Training curves"

Put the returned `<div data-element="web" …>` into authoring HTML beside native
title and caption elements. Use `web import` only when the page is intentionally
the entire slide.

## Local assets and offline behavior

The staged HTML document must be self-contained. Remote requests are blocked by
`web check` and cannot be relied on while presenting. `web add`, `web import`,
and `web replace` currently stage the HTML document itself; they do not
recursively discover and copy relative dependencies.

For small images, fonts, and data files, embed optimized data URIs. Otherwise,
stage dependencies under `assets/web/` and reference the final staged path.
Do not assume a relative path beside the source HTML will be present beside its
content-hashed staged copy. Run `web inspect` after staging and `web check`
before replacement.

Pages run in `sandbox="allow-scripts"`: scripts work, but navigation, popups,
deck access, and arbitrary local files do not. The injected `window.deckwerk`
bridge provides `onActive`, `onInactive`, `onStep`, `next`, and `prev`.


A page that draws the slide's builds itself must handle `onActive({ step })`
at any step, not only 0: the deck sends it when the slide comes on screen,
which is the last step when presenting backwards — and it is the only message
a PDF page gets. PDF export prints one copy of the page per build stage (or
just the last, by default), each told its step that way and given 5 seconds
to draw it before the page is captured. So on `onActive`, jump straight to
the settled end of that step rather than animating up to it, and keep any
opening animation shorter than that. A looping animation prints at whatever
moment it has reached.
