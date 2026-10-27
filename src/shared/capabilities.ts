import type { SlideElement, TimelineEntry } from './deck.js';
import { MORPH_NAME } from './featureNames.js';

/**
 * What this editor can do, as copy-pasteable JSON.
 *
 * An agent that does not know a feature exists reimplements it badly — it
 * hardcodes an equation as text because it never learned that `$…$` renders
 * through KaTeX, or it re-encodes a video to crop it because it never learned
 * about `sourceBox`. This is the antidote: every capability with a minimal,
 * valid example element beside it.
 *
 * `scripts/build-agent-reference.mts` builds a real deck out of these entries,
 * so the reference deck an agent can render and the cookbook it reads are the
 * same source and cannot drift apart.
 */

export interface Capability {
  id: string;
  /** One line: what this is. */
  what: string;
  /** One line: when to reach for it. */
  when: string;
  /** Gotchas worth knowing before using it. */
  notes?: string[];
  /** Valid elements demonstrating the feature, on a 1920×1080 canvas. */
  elements: SlideElement[];
  timeline?: TimelineEntry[];
  /** Slide-level fields the feature needs, e.g. a background or Morph. */
  slide?: {
    background?: { color: string | null; image: string | null };
    morphFromPrevious?: boolean;
    morphDuration?: number;
  };
}

const text = (
  id: string,
  html: string,
  box: { x: number; y: number; w: number; h: number },
  over: Partial<Extract<SlideElement, { type: 'text' }>> = {},
): SlideElement => ({
  id, type: 'text', ...box, rot: 0, z: 1, opacity: 1,
  class: ['role-body'], style: {}, html, align: 'left', valign: 'top', ...over,
});

const CAPTION = { x: 160, y: 900, w: 1600, h: 90 };
const TITLE = { x: 160, y: 90, w: 1600, h: 150 };

export function capabilities(): Capability[] {
  return [
    {
      id: 'text-roles',
      what: 'Text styled by theme class, never by inline font sizes.',
      when: 'Every piece of text. Pick the role; let theme.css size it.',
      notes: [
        'role-title, role-heading, role-body, role-caption are the vocabulary.',
        'An inline `style` overrides the theme and should be a deliberate one-off.',
        'contentStyle applies CSS to the inner text content rather than the positioned box; use it for glyph paint such as gradient text, text strokes and shadows.',
        'html may contain inline markup: <b>, <i>, <u>, <s> (strikethrough), <br>, <span>.',
        'paragraphSpacing (px) sets the gap between paragraphs and between bullets; unset keeps the theme default.',
        "align sets the horizontal setting of the type — 'left', 'center', 'right' or 'justify'.",
        "valign places the text inside its box — 'top', 'middle' or 'bottom' — which is what keeps a caption sitting against a figure rather than floating.",
      ],
      elements: [
        text('cap-roles-title', 'A title in the deck’s own type', TITLE, { class: ['role-title'] }),
        text('cap-roles-body', 'Body text carries <b>bold</b> and <i>italic</i> inline.', { x: 160, y: 300, w: 1600, h: 200 }),
        text('cap-roles-caption', 'A caption, for figure credits and asides.', CAPTION, { class: ['role-caption'] }),
      ],
    },
    {
      id: 'latex',
      what: 'LaTeX maths, rendered by KaTeX at present time.',
      when: 'Any equation. Never hand-build maths out of positioned text.',
      notes: [
        '$…$ is inline and stays in the sentence flow; $$…$$ is display.',
        'A literal dollar sign is written \\$.',
        'The equation is part of the text element’s html — not a separate element.',
        'Mark a term with \\step{label}{…} (or KaTeX’s \\htmlClass{step-label}{…}) so builds can reveal, colour or pulse it; see equation-builds.',
      ],
      elements: [
        text('cap-latex-title', 'Maths is text, not layout', TITLE, { class: ['role-title'] }),
        text(
          'cap-latex-inline',
          'A rendering is a function $f_\\theta(\\mathbf{x}) \\rightarrow (\\mathbf{c}, \\sigma)$ of position.',
          { x: 160, y: 320, w: 1600, h: 120 },
        ),
        text(
          'cap-latex-display',
          'Volume rendering integrates along the ray: $$C(\\mathbf{r}) = \\int_{t_n}^{t_f} T(t)\\,\\sigma(\\mathbf{r}(t))\\,\\mathbf{c}(t)\\,dt$$',
          { x: 160, y: 470, w: 1600, h: 300 },
        ),
      ],
    },
    {
      id: 'lists',
      what: 'Bulleted lists as real <ul><li> markup inside a text element.',
      when: 'Any list of points. Never type literal "•" or "-" characters — the theme styles real list markers, paragraphSpacing controls the gap between items, and by-paragraph builds reveal them one at a time.',
      notes: [
        'One <li> per point; inline markup (<b>, <i>) works inside items.',
        'The whole list is one text element; the editor’s "Bulleted list" checkbox toggles the same markup.',
        'paragraphSpacing (px) spaces the items; unset keeps the theme default.',
        'An item is indented a level by nesting a <ul>/<ol> inside the <li> above it. A paragraph outside a list is indented with data-indent="1" to "8" on its <p>, 1.4em a step, the same step as a list level.',
      ],
      elements: [
        text('cap-lists-title', 'Lists are markup, not characters', { x: 160, y: 90, w: 1600, h: 150 }, { class: ['role-title'] }),
        text(
          'cap-lists-body',
          '<ul><li>Real <b>list items</b>, styled by the theme</li><li>Spaced by paragraphSpacing</li><li>Revealed one at a time by a byParagraph build</li></ul>',
          { x: 160, y: 320, w: 1600, h: 500 },
          { paragraphSpacing: 24 },
        ),
      ],
    },
    {
      id: 'auto-fit',
      what: 'Text that shrinks to stay inside its box.',
      when: 'Titles and quotes whose length you cannot predict.',
      notes: [
        'autoFit never grows text past its authored size; it only shrinks.',
        'inspect reports the size it settled on as text.fittedFontSize.',
        'noWrap: true disables automatic line wrapping — lines break only where the author wrote one — and implies the auto-fit shrink for overlong lines.',
        "noWrapMode picks how a no-wrap line is compressed: 'shrink' (default) reduces the font size uniformly; 'condense' keeps the size and squeezes the type horizontally.",
        'autoSize: true makes the box hug its text: lines break only where the author wrote one, and the editor keeps w/h at the text’s laid-out size, anchored at the edge its align names and at the top — a label rather than a column of prose. Resizing the box by hand turns it back into an ordinary wrapping box. It implies no auto-fit.',
      ],
      elements: [
        text('cap-fit-title', 'Auto-fit', TITLE, { class: ['role-title'] }),
        text(
          'cap-fit-body',
          'This sentence is far longer than its box would normally allow, and is shrunk to fit rather than spilling over the edge of the slide.',
          { x: 160, y: 320, w: 1600, h: 200 },
          { autoFit: true, class: ['role-title'] },
        ),
        text(
          'cap-fit-condensed',
          'One line, never wrapped — squeezed horizontally instead.',
          { x: 160, y: 560, w: 1600, h: 160 },
          { noWrap: true, noWrapMode: 'condense', class: ['role-title'] },
        ),
      ],
    },
    {
      id: 'image',
      what: 'An image, fitted inside its box.',
      when: 'Figures, screenshots, diagrams. PDFs and SVGs stay vector.',
      notes: [
        'fit: contain preserves the whole figure; cover crops to the box; fill stretches to it, distorting the picture — reach for it only deliberately.',
        'Import media with `slide-agent asset import` — never reference a path outside the deck.',
      ],
      elements: [
        text('cap-image-title', 'Images', TITLE, { class: ['role-title'] }),
        {
          id: 'cap-image', type: 'image', x: 560, y: 300, w: 800, h: 500, rot: 0, z: 2,
          opacity: 1, class: [], style: {}, src: 'assets/swatch.png', fit: 'contain',
          alt: 'A figure', sourceBox: null,
        },
      ],
    },
    {
      id: 'crop',
      what: 'A non-destructive crop, on images and video alike.',
      when: 'Showing part of a figure. Never re-encode or re-export to crop.',
      notes: [
        'The element box is the window; sourceBox places the *whole* image relative to it.',
        'A sourceBox larger than the box, with negative x/y, is a zoom-in on the middle.',
        'Reversible and editable later: the original file is untouched.',
      ],
      elements: [
        text('cap-crop-title', 'Cropping with sourceBox', TITLE, { class: ['role-title'] }),
        {
          id: 'cap-crop', type: 'image', x: 660, y: 300, w: 600, h: 400, rot: 0, z: 2,
          opacity: 1, class: [], style: {}, src: 'assets/swatch.png', fit: 'cover',
          alt: 'A cropped figure',
          sourceBox: { x: -300, y: -200, w: 1200, h: 800 },
        },
        text('cap-crop-caption', 'The box is the window; the source is placed behind it.', CAPTION, { class: ['role-caption'] }),
      ],
    },
    {
      id: 'mask',
      what: 'Circular masks on images and video.',
      when: 'Headshots, logos, any figure that should read as a disc rather than a rectangle. Never fake it with a cropped image file.',
      notes: [
        "maskShape: 'circle' clips the element box to its inscribed ellipse, so pair it with a square box and a sourceBox to get a true circle rather than an oval.",
        "maskShape: 'rect', or leaving the field off, is the ordinary rectangular box.",
        'Images and video behave identically here.',
        'Combine with sourceBox to move and scale the picture behind the mask; the element box is the mask itself.',
        'For merely rounded corners, use borderRadius (px) instead.',
      ],
      elements: [
        text('cap-mask-title', 'Circular masks', TITLE, { class: ['role-title'] }),
        {
          id: 'cap-mask-image', type: 'image', x: 420, y: 320, w: 440, h: 440, rot: 0, z: 2,
          opacity: 1, class: [], style: {}, src: 'assets/swatch.png', fit: 'cover', alt: 'A masked figure',
          sourceBox: null, maskShape: 'circle',
        },
        {
          id: 'cap-mask-video', type: 'video', x: 1060, y: 320, w: 440, h: 440, rot: 0, z: 2,
          opacity: 1, class: [], style: {}, src: 'assets/testclip.mp4', fit: 'cover',
          autoplay: true, loop: true, muted: true, controls: false,
          start: 0, end: null, poster: null, sourceBox: null, maskShape: 'circle',
        },
        text('cap-mask-caption', 'An image and a video, same mask.', CAPTION, {
          class: ['role-caption'], align: 'center', valign: 'middle',
        }),
      ],
    },
    {
      id: 'media-frame',
      what: 'Borders, rounded corners and visual effects on images and video.',
      when: 'Setting a figure off from the background, or de-emphasising it.',
      notes: [
        'effects apply in array order: blur (radius px), posterize (levels), grayscale (amount 0–1), and gaussianNoise (amount 0–1, frequencyCutoff 0.001–1).',
        'effects are a media control: images and video only. Do not filter text — style type through theme.css instead.',
        'borderWidth/borderColor/borderRadius work on both images and video.',
      ],
      elements: [
        text('cap-frame-title', 'Framed and filtered media', TITLE, {
          class: ['role-title'],
        }),
        {
          id: 'cap-frame-plain', type: 'image', x: 200, y: 320, w: 700, h: 440, rot: 0, z: 2,
          opacity: 1, class: [], style: {}, src: 'assets/swatch.png', fit: 'cover', alt: '',
          sourceBox: null, borderColor: '#ff3366', borderWidth: 10, borderRadius: 18,
        },
        {
          id: 'cap-frame-effect', type: 'image', x: 1020, y: 320, w: 700, h: 440, rot: 0, z: 2,
          opacity: 1, class: [], style: {}, src: 'assets/swatch.png', fit: 'cover', alt: '',
          sourceBox: null,
          effects: [
            { type: 'blur', radius: 6 },
            { type: 'posterize', levels: 6 },
            { type: 'grayscale', amount: 0.8 },
            { type: 'gaussianNoise', amount: 0.3, frequencyCutoff: 0.18 },
          ],
        },
      ],
    },
    {
      id: 'video',
      what: 'Video as a first-class object, with a non-destructive trim.',
      when: 'Any result clip. This editor exists for this.',
      notes: [
        'start/end are seconds; end: null means the end of the file. Looping honours them.',
        'autoplay/loop/muted default to true — a slide video normally plays itself. Set autoplay: false when a build starts it on a click instead.',
        'controls: true hands the audience a scrubber; normally leave it off.',
        'poster is a still shown before playback begins; null lets the first frame stand in.',
        'Only H.264/VP8/VP9/AV1 decode; `asset import` transcodes anything else.',
        'A video can be cropped, masked and framed exactly like an image.',
      ],
      elements: [
        text('cap-video-title', 'Video, trimmed and framed', TITLE, { class: ['role-title'] }),
        {
          id: 'cap-video', type: 'video', x: 460, y: 300, w: 1000, h: 500, rot: 0, z: 2,
          opacity: 1, class: [], style: {}, src: 'assets/testclip.mp4', fit: 'contain',
          autoplay: false, loop: true, muted: true, controls: false,
          start: 1, end: 5, poster: null, sourceBox: null,
          borderColor: '#111111', borderWidth: 6, borderRadius: 12,
        },
        text('cap-video-caption', 'Seconds 1–5 of the source, looping, untouched on disk.', CAPTION, { class: ['role-caption'] }),
      ],
      timeline: [
        {
          id: 'cap-video-t1',
          trigger: { on: 'click', ref: null, delay: 0 },
          action: { type: 'play', target: 'cap-video', value: null },
        },
        {
          id: 'cap-video-t2',
          trigger: { on: 'mediaEnd', ref: 'cap-video', delay: 0 },
          action: { type: 'appear', target: 'cap-video-caption', value: null },
        },
      ],
    },
    {
      id: 'video-compare',
      what: 'Videos that play in sync, with a shared scrubber, and a before/after wipe.',
      when: 'Real vs. simulated, before vs. after: two clips (or stills) the audience must compare frame for frame.',
      notes: [
        'syncGroup (data-sync-group) on two or more videos plays them from one clock while presenting, each clip measured from its own in-point (its trim start).',
        'When the clips differ in length (each one’s trim window), syncLength (data-sync-length) on every member says how long the group runs: "shortest" (the default; leave it out) ends, or loops, with the shortest clip and cuts the rest; "hold" runs to the longest, shorter clips freezing on their last frame; "black" runs to the longest, shorter clips going black. The group loops at that length when the clip that sets it loops, so give every member the same loop flag. PDFs and thumbnails show the same frame (or black) the presentation would.',
        'While presenting, hovering a synced video shows one bar along the bottom of the group: play/pause for the group and a scrubber over the group’s length. It never shows in PDFs, thumbnails or posters.',
        'A wipe is two pictures stacked in the same box. The UPPER one (later in the HTML, higher z) carries compare: "wipe" (data-compare="wipe") and wipe: 0–1 (data-wipe, also accepts "40%"), the divider’s position across the box. It shows left of the divider; whatever is beneath shows right of it.',
        'The lower layer needs nothing. For video pairs give both the same syncGroup so they show the same moment. Images work as either layer.',
        'The presenter can drag the divider while presenting; that never edits the deck. The editor, thumbnails and PDF show it at the stored position.',
        'In the editor: select two videos or images and click the Wipe chip under them (or right-click → Arrange as wipe, or Props → Compare → Arrange as wipe). With a two-clip wipe selected the chip, and the Wipe section in Props, choose its length: Shortest / Hold last / Black. A synced pair that is not a wipe has the same choice beside Play in sync.',
      ],
      elements: [
        text('cap-compare-title', 'Real and simulated, one divider', TITLE, { class: ['role-title'] }),
        {
          id: 'cap-compare-sim', type: 'video', x: 460, y: 300, w: 1000, h: 563, rot: 0, z: 2,
          opacity: 1, class: [], style: {}, src: 'assets/testclip.mp4', fit: 'cover',
          autoplay: true, loop: true, muted: true, controls: false,
          start: 0, end: null, poster: null, sourceBox: null, syncGroup: 'cap-compare',
        },
        {
          id: 'cap-compare-real', type: 'video', x: 460, y: 300, w: 1000, h: 563, rot: 0, z: 3,
          opacity: 1, class: [], style: {}, src: 'assets/testclip.mp4', fit: 'cover',
          autoplay: true, loop: true, muted: true, controls: false,
          start: 0, end: null, poster: null, sourceBox: null, syncGroup: 'cap-compare',
          compare: 'wipe', wipe: 0.5, effects: [{ type: 'grayscale', amount: 1 }],
        },
        text('cap-compare-caption', 'Left of the divider is the upper clip, right is the one beneath; both run on one clock.', CAPTION, { class: ['role-caption'] }),
      ],
    },
    {
      id: 'shapes',
      what: 'Rectangles, ellipses, lines and arrows, including curved ones, and free-form paths.',
      when: 'Callouts, connectors, emphasis boxes.',
      notes: [
        'An arrow’s `control` is an absolute canvas-space point making it a quadratic curve.',
        'shape: "path" carries real SVG path data, scaled from pathSize to the element box — this is how imported vector art keeps its geometry.',
        'A free-form path (what the editor\'s pen draws): set pathSize equal to the box (w, h) and write the path in those pixels, e.g. path: "M 0 150 C 0 -50 300 -50 300 150 Z", pathSize: { w: 300, h: 150 }. Close it with Z and give it a fill for a filled shape; leave it open with fill: null and a stroke for a drawn line. With pathSize equal to the box, strokeWidth is in pixels and a resize redraws the path rather than stretching its stroke. Any SVG path command reads; the editor writes back M, L, C and Z when an author drags its points (double-click a path, or Edit points). In HTML: data-shape="path" data-path="…" data-path-size="300,150".',
        'A path\'s strokeStyle draws its stroke as "pen" (the default when absent: a clean even line), "brush" (swells in the middle and tapers to a point at each end; a closed one breathes around its loop), "pencil" (thin, grainy, a little translucent) or "marker" (a flat, see-through highlighter: give it a wide strokeWidth, say 24). Lines, arrows and paths take it, and only a visible stroke shows it. In HTML: data-stroke-style="brush". Line Draw traces every style.',
        'Every open line takes a cap on either end — a line, an arrow, a curve, a path drawn with the pen or the pencil: arrowStart/arrowEnd put arrowheads there, and startCap/endCap a "dot" or a "bar" where there is no arrowhead (an arrow is simply a line with arrowEnd). arrowSize sets the cap size in pixels (unset: six stroke widths; never less than the line width, which ends the line in a point), so a thick line can keep a modest head. strokeDash makes any stroke "dashed" or "dotted". In HTML: data-arrow-size, data-start-cap / data-end-cap, data-stroke-dash.',
        'A curly brace is shape: "brace", laid out like a line (endpoints at the box\'s left and right centre, rotated by rot). braceDepth is the signed distance from the chord to the point along the element\'s own +y (down when unrotated); half of it is the radius of every curl. In HTML: data-shape="brace" data-brace-depth="40".',
        'A drop shadow is CSS on the element: style: { filter: "drop-shadow(0px 8px 24px rgba(0, 0, 0, 0.3))" }. It follows the shape’s own paint (a line or an outline casts the shadow of its strokes), and Props → Shadow edits the same value.',
        'A gradient fill: fillGradient: { to: "#ec6b14", angle: 270, kind: "linear" } runs from fill to `to`; angle is degrees counter-clockwise from the right (270 = top to bottom); kind "radial" spreads from the centre. In HTML: data-fill-to, data-fill-angle, data-fill-gradient.',
        'A curved (paper) shadow, the object lifting at its bottom corners: style custom properties --curl-color, --curl-blur and --curl-lift (px). Props → Shadow → Style: Curved edits them.',
      ],
      elements: [
        text('cap-shape-title', 'Shapes and connectors', TITLE, { class: ['role-title'] }),
        {
          id: 'cap-shape-box', type: 'shape', x: 200, y: 330, w: 460, h: 240, rot: 0, z: 2,
          opacity: 1, class: [], style: {}, shape: 'rect', fill: null, stroke: '#2563eb',
          strokeWidth: 4, radius: 16, path: null, pathSize: null, arrowStart: false, arrowEnd: false,
        },
        {
          id: 'cap-shape-arrow', type: 'shape', x: 700, y: 330, w: 500, h: 240, rot: 0, z: 2,
          opacity: 1, class: [], style: {}, shape: 'arrow', fill: null, stroke: '#111111',
          strokeWidth: 6, radius: 0, path: null, pathSize: null, arrowStart: false, arrowEnd: true,
          control: { x: 950, y: 260 },
        },
        {
          id: 'cap-shape-ellipse', type: 'shape', x: 1260, y: 330, w: 460, h: 240, rot: 0, z: 2,
          opacity: 1, class: [], style: {}, shape: 'ellipse', fill: '#fde68a', stroke: null,
          strokeWidth: 2, radius: 0, path: null, pathSize: null, arrowStart: false, arrowEnd: false,
        },
        {
          id: 'cap-shape-line', type: 'shape', x: 200, y: 660, w: 700, h: 2, rot: 0, z: 2,
          opacity: 1, class: [], style: {}, shape: 'line', fill: null, stroke: '#94a3b8',
          strokeWidth: 2, radius: 0, path: null, pathSize: null, arrowStart: false, arrowEnd: false,
        },
        {
          id: 'cap-shape-path', type: 'shape', x: 1000, y: 620, w: 720, h: 160, rot: 0, z: 2,
          opacity: 1, class: [], style: {}, shape: 'path', fill: null, stroke: '#16a34a',
          strokeWidth: 5, radius: 0, arrowStart: false, arrowEnd: false,
          path: 'M0,140 C120,10 240,10 360,80 S600,150 720,20',
          pathSize: { w: 720, h: 160 },
        },
        text('cap-shape-caption', 'A rule, and real SVG path data scaled to its box.', CAPTION, { class: ['role-caption'] }),
      ],
    },
    {
      id: 'flip',
      what: 'Any object mirrored left to right or top to bottom, as Keynote\'s Flip does it.',
      when: 'A pointer or a photo that should face the other way, without redrawing or re-exporting it.',
      notes: [
        'flipX: true mirrors an object left to right and flipY: true top to bottom, in its own frame before rot turns it; the box (x, y, w, h) does not move. Absent means not flipped. Text stays live and editable, drawn mirrored.',
        'In HTML a flip is part of the transform: transform: rotate(30deg) scaleX(-1). A page cannot tell flipY from flipX turned half way round, so a mirror written on a page comes back as whichever needs the smaller rotation.',
        'Lines, arrows and braces carry no flags (any are ignored): reverse one with rot + 180 or by moving its ends. A mirror written on a page is folded into its endpoints, curve control point and brace depth.',
        'Props → Geometry → Flip mirrors along the slide\'s own axes whatever the rotation: the flag toggles and rot becomes −rot.',
      ],
      elements: [
        text('cap-flip-title', 'Flipped objects', TITLE, { class: ['role-title'] }),
        {
          id: 'cap-flip-plain', type: 'shape', x: 360, y: 360, w: 480, h: 300, rot: 0, z: 2,
          opacity: 1, class: [], style: {}, shape: 'path', fill: '#2563eb', stroke: null,
          strokeWidth: 0, radius: 0, arrowStart: false, arrowEnd: false,
          path: 'M0,90 L300,90 L300,0 L480,150 L300,300 L300,210 L0,210 Z', pathSize: { w: 480, h: 300 },
        },
        {
          id: 'cap-flip-mirrored', type: 'shape', x: 1080, y: 360, w: 480, h: 300, rot: 0, z: 2,
          flipX: true,
          opacity: 1, class: [], style: {}, shape: 'path', fill: '#ec6b14', stroke: null,
          strokeWidth: 0, radius: 0, arrowStart: false, arrowEnd: false,
          path: 'M0,90 L300,90 L300,0 L480,150 L300,300 L300,210 L0,210 Z', pathSize: { w: 480, h: 300 },
        },
        text('cap-flip-caption', 'The same path; the right one has flipX: true.', CAPTION, { class: ['role-caption'] }),
      ],
    },
    {
      id: 'builds',
      what: 'Timeline builds: reveal objects on click or after the previous step.',
      when: 'Walking an audience through a slide one point at a time.',
      notes: [
        'An entry is a trigger (click / afterPrev / withPrev / mediaEnd) plus an action.',
        'Every timeline entry must target an element id on the same slide.',
        'Objects with no build are visible from the start.',
        "An appear with value: 'byParagraph' on a text element reveals it one paragraph (or list item) at a time, in document order — one click each, or a cascade when triggered afterPrev/withPrev.",
        'withPrev fires together with the step before it; afterPrev fires on its own after that step, with an optional delay in ms.',
        'An appear or disappear with value: \'dissolve\' fades the element in or out; an appear with value: \'pop\' grows it in from smaller, overshoots a little and settles (default 500 ms; action.popFrom is the starting size, default 0.6, and action.popPeak the overshoot, default 1.06; in authoring HTML data-build-pop-from / data-build-pop-peak); an appear with value: \'draw\' on a shape is Line Draw: a line, an arrow or an open path grows from its start with its caps riding the tip, and a box, ellipse or closed path is traced along its outline (a path one run after another; a shape with no stroke in a hairline of its fill colour) and its fill fades in once the outline is complete. action.duration is the time in ms (defaults 1000 and 600), and an afterPrev build waits for an animated one before it to finish. In authoring HTML: data-build="click" data-build-effect="dissolve" data-build-duration="800". Animations play when a step is reached by advancing (including builds that run on arriving at a slide); jumping to a step shows its finished state.',
        "The other actions are disappear, play/pause (media), seek (value: seconds) and addClass/removeClass (value: the class name) — the last two are the hook for anything theme.css can animate.",
        'In authoring HTML, data-build states an object\'s first appearance, and builds run in document order. data-build-order="2" on an object makes its appearance the second step whatever the paint order (1 is first).',
        'When the attributes cannot say a slide\'s whole timeline — a disappear, a media step, a by-paragraph reveal, a second build of one object, builds in another order than paint order — an exported <section> also carries <script type="application/deckwerk-timeline">[…]</script>: the timeline as deck.json holds it, one entry per line, naming objects by data-element-id. It is the order of the steps and every step the attributes cannot state; what an attribute states wins. Move an entry to move that step; add or delete entries to add or remove steps. A section copied to another deck keeps the block and so its whole timeline (objects whose ids are taken there are renamed and their steps follow them).',
        "type: 'pulse' briefly enlarges any object about its own centre (scale, default 1.6; duration, default 800 ms), holds it there for a beat and settles back without moving anything, and with value: 'lift' (whole objects only; a term pulse ignores it) it also casts a drop shadow and rises over its neighbours while it is up; type: 'terms' steps through an equation's marked terms — see equation-builds. In authoring HTML: data-pulse=\"click\" data-pulse-scale=\"1.6\" (data-pulse-lift=\"true\" for the lift). Keynote's other two Actions sit beside it: type: 'jiggle' wobbles the object side to side about its centre, each swing smaller (duration, default 700 ms), and type: 'pop' is a smooth bump: it eases up to its size and back down, symmetric and never below its own size (scale, default 1.3; duration, default 700 ms); in HTML data-jiggle=\"click\" and data-pop=\"click\" data-pop-scale=\"1.3\". Like a pulse, both end exactly where they began. action.damping (0 to 1; data-pulse-damping, data-pop-damping, data-jiggle-damping) sets how softly each moves: on a pulse or a pop 0 is a sharp snap out of rest and back into it and 1 a fully smooth ease at both ends, like a critically damped spring (defaults 0.8 and 1); on a jiggle it is how fast the swings die out (default 0.5). All three move about what shows: text about the middle of its words, not of a bigger box (a text box with a fill or border about its box), anything else about its box.",
      ],
      elements: [
        text('cap-build-title', 'Builds', TITLE, { class: ['role-title'] }),
        text('cap-build-1', 'First this appears with the slide, then leaves.', { x: 160, y: 320, w: 1600, h: 100 }),
        text('cap-build-2', 'Then this, on a click.', { x: 160, y: 440, w: 1600, h: 100 }),
        text('cap-build-3', 'And this, half a second later.', { x: 160, y: 560, w: 1600, h: 100 }),
        text(
          'cap-build-list',
          '<ul><li>Then these list items,</li><li>one click at a time,</li><li>from a single build entry.</li></ul>',
          { x: 160, y: 680, w: 1600, h: 260 },
          { paragraphSpacing: 16 },
        ),
      ],
      timeline: [
        {
          id: 'cap-build-t1',
          trigger: { on: 'click', ref: null, delay: 0 },
          action: { type: 'appear', target: 'cap-build-2', value: null },
        },
        {
          id: 'cap-build-t2',
          trigger: { on: 'withPrev', ref: null, delay: 0 },
          action: { type: 'disappear', target: 'cap-build-1', value: null },
        },
        {
          id: 'cap-build-t3',
          trigger: { on: 'afterPrev', ref: null, delay: 500 },
          action: { type: 'appear', target: 'cap-build-3', value: null },
        },
        {
          id: 'cap-build-t4',
          trigger: { on: 'click', ref: null, delay: 0 },
          action: { type: 'appear', target: 'cap-build-list', value: 'byParagraph' },
        },
      ],
    },
    {
      id: 'morph',
      what: 'Animated transitions between slides, pairing objects by identity.',
      when: 'A derivation, a growing diagram, a figure that moves and scales.',
      notes: [
        'Give the same morphId to the objects that are "the same thing" on both slides.',
        'Set morphFromPrevious: true on the *later* slide.',
        'Unpaired objects cross-fade; morphDuration on the later slide sets the timing.',
        "deck.morphEasing picks the motion curve: 'ease-in-out' (default), 'ease-out' (snappy start, soft landing), or 'linear'.",
      ],
      elements: [
        text('cap-morph-title', MORPH_NAME, TITLE, { class: ['role-title'] }),
        text('cap-morph-term', '$E = mc^2$', { x: 260, y: 420, w: 700, h: 200 }, {
          class: ['role-title'], morphId: 'cap-morph-equation',
        }),
      ],
    },
    {
      id: 'morph-target',
      what: 'The second half of the pair: same identity, new position.',
      when: 'Always authored together with the slide before it.',
      notes: ['This slide carries morphFromPrevious: true and its own morphDuration.'],
      slide: { morphFromPrevious: true, morphDuration: 1000 },
      elements: [
        text('cap-morph2-title', 'The same object, moved', TITLE, { class: ['role-title'] }),
        text('cap-morph2-term', '$E = mc^2$', { x: 1000, y: 640, w: 700, h: 200 }, {
          class: ['role-title'], morphId: 'cap-morph-equation',
        }),
      ],
    },
    {
      id: 'equation-builds',
      what: 'Build an equation term by term: reveal or colour its marked terms one step at a time, and pulse one to point at it.',
      when: 'A derivation or a definition you talk through part by part, rather than showing the whole equation at once.',
      notes: [
        'Mark terms in the TeX: \\step{1}{…}, \\step{2}{…} (KaTeX’s \\htmlClass{step-2}{…} and MathJax’s \\class{step-2}{…} mean the same). Numbers set the order; a word label (\\step{force}{f}) names a term and comes after the numbers. A label used twice is one term.',
        "An action { type: 'terms', target, value: 'appear' } steps through every marked term in order, one click each (or a cascade when afterPrev/withPrev), like a by-paragraph build. The unmarked parts are on screen from the start; an unrevealed term keeps its place, so nothing reflows.",
        "value: 'color' paints the terms instead (action.color, a CSS colour) and they stay painted. action.term: '2' acts on that one term only. action.duration is the fade or colour change in ms (default 400; 0 is instant).",
        "{ type: 'pulse', target, term: '2' } enlarges that term for a moment (scale default 1.6, duration default 800 ms) and settles it back exactly; without term the whole object pulses. Any object can pulse. 'jiggle' (wobbles side to side, duration default 700 ms) and 'pop' (a smooth bump that eases up and back down, scale default 1.3, duration default 700 ms) take the same target and term. action.damping (0 to 1) sets how softly each moves — see builds.",
        'In authoring HTML, on the text element: data-term-build="click" (data-term-effect="color" data-term-color="#d9480f" data-term-duration="400" data-term="2" optional) and data-pulse="click" data-pulse-term="2" (data-pulse-scale="1.6" data-pulse-duration="800" data-pulse-damping="0.8" optional; data-pulse-lift="true" lifts a whole-object pulse); likewise data-jiggle="click" (data-jiggle-term, data-jiggle-duration, data-jiggle-damping) and data-pop="click" (data-pop-term, data-pop-scale, data-pop-duration, data-pop-damping). A page states the first build of each kind; the Build panel can add more.',
        'Jumping to a step, the presenter preview and PDF export show the finished state of each step; a pulse, a jiggle or a pop leaves no state behind.',
      ],
      elements: [
        text('cap-eqb-title', 'Momentum balance, term by term', TITLE, { class: ['role-title'] }),
        text(
          'cap-eqb-equation',
          '$$\\nabla \\cdot \\sigma \\step{1}{+ \\, f} = \\step{2}{\\rho \\, \\ddot{u}}$$',
          { x: 160, y: 360, w: 1600, h: 300 },
          { class: ['role-title'], align: 'center', valign: 'middle' },
        ),
      ],
      timeline: [
        {
          id: 'cap-eqb-terms',
          trigger: { on: 'click', ref: null, delay: 0 },
          action: { type: 'terms', target: 'cap-eqb-equation', value: 'appear' },
        },
        {
          id: 'cap-eqb-pulse',
          trigger: { on: 'click', ref: null, delay: 0 },
          action: { type: 'pulse', target: 'cap-eqb-equation', value: null, term: '2' },
        },
      ],
    },
    {
      id: 'equation-morph',
      what: `${MORPH_NAME} between two equations moves them glyph by glyph.`,
      when: 'An equation that grows or is rewritten from one slide to the next: f(x) = 0 → f(x) = y → f(x) = y + 1.',
      notes: [
        'Pair the two text elements with the same morphId (data-morph) and set morphFromPrevious on the later slide, exactly as for any Morph.',
        'When both sides hold maths and say different things, every KaTeX glyph they share (matched by symbol in reading order, position breaking ties) travels to its new place and grows or shrinks to its new size; glyphs only one side has fade out or in. Glyphs stay live type, so they stay crisp, and the last frame is the next slide exactly.',
        'Nothing shared — or a rotated element — falls back to the ordinary Morph of the whole object.',
      ],
      elements: [
        text('cap-eqm-title', 'Equilibrium', TITLE, { class: ['role-title'] }),
        text('cap-eqm-equation', '$$\\nabla \\cdot \\sigma = 0$$', { x: 160, y: 360, w: 1600, h: 300 }, {
          class: ['role-title'], align: 'center', valign: 'middle', morphId: 'cap-eqm',
        }),
      ],
    },
    {
      id: 'equation-morph-target',
      what: 'The second half of the equation pair: the same identity, a richer equation.',
      when: 'Always authored together with the slide before it.',
      notes: ['∇, ·, σ and = move to their new places; + f and ρü fade in, 0 fades out.'],
      slide: { morphFromPrevious: true, morphDuration: 1200 },
      elements: [
        text('cap-eqm2-title', 'Momentum balance', TITLE, { class: ['role-title'] }),
        text('cap-eqm2-equation', '$$\\nabla \\cdot \\sigma + f = \\rho \\, \\ddot{u}$$', { x: 160, y: 360, w: 1600, h: 300 }, {
          class: ['role-title'], align: 'center', valign: 'middle', morphId: 'cap-eqm',
        }),
      ],
    },
    {
      id: 'background',
      what: 'A slide background colour, and the other slide-level properties.',
      when: 'Section dividers; hiding a slide; picking a geometry preset.',
      notes: [
        'A background image covers the canvas; text on it needs contrast.',
        "layout is a geometry preset — 'freeform' (default), 'standard' (title + body) or 'title' — and themes may decorate it but never own its positions.",
        'layoutMasterId and layoutPlaceholder are editor-maintained links between fixed layout masters and their title/body placeholders; ordinary authored elements should leave them unset.',
        'skipped: true keeps a slide in the deck and editable but steps over it when presenting. Use it instead of deleting a slide you may want back. In authoring HTML: data-skipped="true" on the <section>; removing it from an exported section un-skips the slide.',
        'notes is the presenter-view script for the slide; name is the label in the slide rail. In authoring HTML the notes are an <aside class="notes">…</aside> inside the <section>, plain text, hidden on the page: edit its words to change them, empty it to clear them. A section with no aside leaves the slide\'s notes as they are.',
      ],
      slide: { background: { color: '#0f172a', image: null } },
      elements: [
        text('cap-bg-title', 'Section divider', TITLE, {
          class: ['role-title'], style: { color: '#f8fafc' },
        }),
      ],
    },
    {
      id: 'background-image',
      what: 'A full-bleed background photograph behind the whole slide.',
      when: 'Title slides and section openers with an image behind the type.',
      notes: [
        'background.image is deck-relative, covers the canvas, and sits behind every element.',
        'Type over a photograph needs its own contrast: set an explicit light colour, or lay a translucent shape between the picture and the text.',
      ],
      slide: { background: { color: null, image: 'assets/swatch.png' } },
      elements: [
        text('cap-bgimage-title', 'Full-bleed', TITLE, {
          class: ['role-title'], style: { color: '#ffffff' },
        }),
      ],
    },
    {
      id: 'comments',
      what: 'Review comments, on a slide or on a single object.',
      when: 'Humans leave you instructions here. Read them first, reply, resolve what you finish.',
      notes: [
        'comments: [{id, author, text, ts, resolved, parentId?}] lives on a slide and on any element. A thread is a root comment and the replies whose parentId names it; the root’s resolved is the thread’s.',
        'CLI: `slide-agent comments <deck>` lists every comment with its 1-based slide number; --resolve <id> marks its thread done; --add <text> --reply <id> answers in a thread; --add <text> --slide/--element <id> starts one.',
        'Comments change only through the updateComments operation, which merges by comment id; replaceElement, replaceSlide and setSlideProperties leave a target’s comments alone.',
        'In a live collaboration session: await window.agent.seeComments() and await window.agent.resolveComment(id); GET /api/comments serves the same rows.',
        'Resolve what you acted on. Never delete a human’s comment.',
      ],
      elements: [
        text('cap-comments-title', 'Comments are instructions', TITLE, { class: ['role-title'] }),
        text(
          'cap-comments-body',
          'This paragraph carries a comment asking for a rewrite.',
          { x: 160, y: 320, w: 1600, h: 200 },
          {
            comments: [{
              id: 'cap-comment-1',
              author: 'vincent',
              text: 'Tighten this to one line.',
              ts: '2026-01-01T09:00:00.000Z',
              resolved: false,
            }],
          },
        ),
      ],
    },
    {
      id: 'web-element',
      what: 'A sandboxed web page — an interactive chart, a demo, a Claude artifact — running live inside its box.',
      when: 'Content that needs JavaScript: hover states driven by script, sliders, live simulations, a page somebody already built. Static markup should be ordinary slide objects instead.',
      notes: [
        'Import a complete HTML document with `slide-agent web import <deck> page.html [--after <slideId>] [--title <text>]`; it lands in assets/web/, content-hashed, as a full-canvas slide. The JSON reply names the src.',
        'In an authoring page, `<div data-element="web" data-src="assets/web/page.a1b2c3d4.html" data-title="…" style="width:…;height:…"></div>` places one anywhere; its CSS box is its geometry like any element.',
        'The page runs in an iframe with sandbox="allow-scripts": scripts yes, but no access to the deck, the app, other slides, the network at presentation time (author with inlined data and assets), popups or navigation. Remote URLs are refused.',
        'The import writes a small runtime that exposes window.deckwerk — onActive(fn), onInactive(fn), onStep(fn), next(), prev(), ready(promise) — and forwards unhandled arrow/space keys so a focused page never traps the presenter.',
        'While presenting, the page is hidden behind its poster until it has loaded and painted. A page that lays itself out from script after load calls `deckwerk.ready(promise)` from its top-level script and the deck also waits for that promise (at most 5 s).',
        'Design for the element box (usually the 1920×1080 canvas) with no scrolling. Clicks inside the page go to the page while `interactive` is true; set it false to have them advance the deck.',
        'Nothing inside the page is a slide object: it cannot be restyled with the inspector, Morphed, or auto-fitted. Set `poster` to a still for PDF export and thumbnails.',
      ],
      elements: [
        text('cap-web-title', 'A live web page, sandboxed', TITLE, { class: ['role-title'] }),
        {
          id: 'cap-web', type: 'web', x: 160, y: 300, w: 1600, h: 640, rot: 0, z: 2,
          opacity: 1, class: [], style: {},
          src: 'assets/web/chart.a1b2c3d4.html', poster: null, interactive: true, title: 'Papers per year',
        },
      ],
    },
    {
      id: 'code-block',
      what: 'Source code, syntax-highlighted with Shiki in a bundled colour scheme, offline, the same in the editor, the player, web export and PDF.',
      when: 'Any listing on a slide: an algorithm, a kernel, a config. Never fake code with a monospace text box.',
      notes: [
        'Fields: code (verbatim; whitespace, tabs and blank lines are kept), language, scheme, fontSize (px; line height and padding scale with it), lineNumbers.',
        'language: python, javascript, typescript, c, cpp, cuda (highlighted as C++), rust, glsl, bash, json, yaml, latex, html, css, sql, go, java, julia, matlab, plaintext. Common aliases (py, ts, sh, yml, tex, cu…) are accepted.',
        "scheme: github-light, github-dark, one-dark-pro, solarized-light, dracula, nord, or deck — derived from the deck theme's text, muted, accent and palette colours, so the code matches the slides and follows a theme change.",
        'In authoring HTML: <pre data-element="code" data-language="python" data-scheme="github-dark" data-font-size="28" data-line-numbers="true"><code>…HTML-escaped code…</code></pre>. A bare <pre><code class="language-python"> is a code block too. One newline straight after <code> and one straight before </code> are formatting and dropped. Size the box with CSS like anything else; its height should be lines × 1.5 × fontSize + 1.5 × fontSize.',
        "Line builds, like paragraph builds on text: each is a timeline entry { action: { type: 'lines', target, value, lines? } }. value 'appear' reveals the lines (they start hidden; lines no appear names show from the start), 'highlight' tints them (action.color, default a soft yellow), 'dim' fades every other line. lines is '3', '3-5' or '3-5,8'; without it the entry steps through the whole block one line per click (\"Appear by line\"). A highlight or a dim holds until the block's next one replaces it; a reveal ends it.",
        "In authoring HTML, the block's line builds in order ride on the <pre>: data-build-lines=\"each; highlight:3-5; dim:7\" — each ';'-separated part one build on its own click: bare lines (or each) appear, highlight:<lines> tints, dim:<lines> fades the rest. The deck keeps each build's trigger, colour and place among the slide's other builds when the page is saved.",
        'Borders, a corner radius and a shadow on the element style apply to the block; the scheme owns its background, ink and type.',
      ],
      elements: [
        text('cap-code-title', 'Code, highlighted', TITLE, { class: ['role-title'] }),
        {
          id: 'cap-code', type: 'code', x: 160, y: 300, w: 1100, h: 210, rot: 0, z: 2,
          opacity: 1, class: [], style: { 'border-radius': '12px' },
          code: 'def stress(F, mu, lam):\n    J = np.linalg.det(F)\n    Finv_T = np.linalg.inv(F).T\n    return mu * (F - Finv_T) + lam * np.log(J) * Finv_T\n',
          language: 'python', scheme: 'github-dark', fontSize: 28, lineNumbers: true,
        },
        text('cap-code-caption', 'Neo-Hookean first Piola–Kirchhoff stress, revealed then highlighted line by line.', CAPTION, { class: ['role-caption'] }),
      ],
      timeline: [
        {
          id: 'cap-code-lines',
          trigger: { on: 'click', ref: null, delay: 0 },
          action: { type: 'lines', target: 'cap-code', value: 'appear', lines: '2-3' },
        },
        {
          id: 'cap-code-last',
          trigger: { on: 'click', ref: null, delay: 0 },
          action: { type: 'lines', target: 'cap-code', value: 'appear', lines: '4' },
        },
        {
          id: 'cap-code-focus',
          trigger: { on: 'click', ref: null, delay: 0 },
          action: { type: 'lines', target: 'cap-code', value: 'highlight', lines: '4' },
        },
      ],
    },
    {
      id: 'html-element',
      what: 'An escape hatch element holding arbitrary markup.',
      when: 'A small structure the object model has no vocabulary for — for example a tight two-column flow inside one box. Reach for real text, table, image, and shape elements first.',
      notes: [
        'The markup renders as-is inside the element box. Nothing measures it, so overflow is yours to catch — render or screenshot the slide.',
        'It is one opaque object to the editor: a human cannot select or restyle its parts with the inspector, and auto-fit does not apply.',
        'theme.css applies to it like any other element, so use the deck’s own classes inside the markup.',
        'Hybrid imports can set sandboxed, css, and fallbackReason. These fields isolate captured author styles and explain why the region stayed HTML.',
      ],
      elements: [
        text('cap-html-title', 'Raw markup, when nothing else fits', TITLE, { class: ['role-title'] }),
        {
          id: 'cap-html-table', type: 'html', x: 160, y: 320, w: 1600, h: 400, rot: 0, z: 2,
          opacity: 1, class: ['role-body'], style: {},
          html: '<table style="width:100%;border-collapse:collapse">'
            + '<tr><th style="text-align:left">Model</th><th style="text-align:left">FVD</th></tr>'
            + '<tr><td>Ours</td><td>112</td></tr>'
            + '<tr><td>Baseline</td><td>289</td></tr></table>',
        },
      ],
    },
  ];
}
