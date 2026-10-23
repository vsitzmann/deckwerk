# HTML slide authoring

`inspect --html` creates a complete authoring page. Save it under `edit/`, edit
its slide `<section>` elements, and save/apply it. With DeckWerk open the watcher
compiles it; offline use `slide-agent apply . --html edit/work.html`.

## Compact inspection

Use these when you need to understand a slide without creating an editable page:

    slide-agent context . --around 9
    slide-agent inspect . --slide 9 --elements-only
    slide-agent inspect . --slide 9 --html-body

`--html-body` is read-only and intentionally has no scope marker. Do not apply
it. Use full `--html` only when you will change native slide objects.

## Structural editing

- Edit an id-bearing section to replace its slide.
- Add an id-less `<section class="slide">` to insert a slide.
- Remove an exported section to delete its slide.
- Reorder complete sections to reorder the governed slides.
- Use `slide-agent new` for an add-only page; never copy scoped authoring HTML.
- When duplicating, remove the copied `data-slide-id`, child element/lineage ids,
  and duplicated SVG marker ids.

Every apply reports `changes.replaced`, `inserted`, `deleted`, and `moved`.
Unexpected deletion means stop and undo before another save.

## Native objects

Use semantic HTML, flexbox/grid, role classes, and normal media tags. Real lists
use `<ul>/<ol>`, math uses `$…$` or `$$…$$`, overflow-prone text can use
`data-autofit="true"`, and tables use semantic table markup. Put reusable styles
in `theme.css`; file-local `<style>` rules do not remain as the deck stylesheet.

Import images/video with `slide-agent asset import` and use the exact returned
path. For builds, Morph, crops, masks, media frames, trim, shapes, and slide
backgrounds, request only the matching named recipe:

    slide-agent capabilities builds morph morph-target
    slide-agent capabilities image crop mask media-frame video shapes
    slide-agent capabilities video-compare
    slide-agent capabilities text-roles lists auto-fit latex background background-image
    slide-agent capabilities comments web-element html-element

Edit speaker notes in `notes.md`. Sections are separated by a line containing
only `---`; keep each generated slide-id anchor with its note.
