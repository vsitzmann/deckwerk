#!/usr/bin/env python3
"""Generate reference.key: one slide per behaviour the Keynote importer fixed.

Every slide is named after the case it exercises (`slide.name` in the import),
and test/keynoteReference.test.ts asserts on each one by that name. The
archives copy the shapes Keynote itself writes for these cases; geometry that
reproduced a bug in a real talk is kept to Keynote's own numbers (the rotated
word-vector rows, the flipped noise strip and its crops), because those are
positions verified against Keynote's rendering. Content is neutral: labels,
coloured blocks and generated pictures, nothing from a real presentation.

Regenerate with the importer venv (ffmpeg is needed for the two clips):

    ./.venv-import/bin/python test/fixtures/keynote/make_reference.py

The output is byte-stable, so an unchanged generator leaves git clean.
"""

from __future__ import annotations

import io
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parent))

from keynote_builder import (  # noqa: E402
    FLIP_H,
    FLIP_V,
    KeynoteBuilder,
    Storage,
    bezier_source,
    editable_source,
    geometry,
    path,
    point_source,
    rect_source,
    rgb,
    scalar_source,
    shadow,
    stroke,
)

OUT = Path(__file__).with_name("reference.key")

# Colours the tests look for. Each block on a slide gets its own, so the
# importer's output can be matched back to what was drawn.
RED, GREEN, BLUE, YELLOW = "#e02020", "#20a040", "#2060e0", "#f0c020"
PALETTE = ["#ee7b86", "#ffe0a0", "#eef2f9", "#76ace1", "#c1baaf", "#282c33", "#ffe59f"]


# --- generated media --------------------------------------------------------------


def png(image: Image.Image) -> bytes:
    out = io.BytesIO()
    image.save(out, "PNG", optimize=True)
    return out.getvalue()


def quadrants(w: int = 400, h: int = 300) -> Image.Image:
    """Red, green / blue, yellow quadrants: any flip or crop shows in a pixel."""
    image = Image.new("RGB", (w, h))
    draw = ImageDraw.Draw(image)
    for (x, y), colour in zip(((0, 0), (1, 0), (0, 1), (1, 1)), (RED, GREEN, BLUE, YELLOW)):
        draw.rectangle([x * w // 2, y * h // 2, (x + 1) * w // 2 - 1, (y + 1) * h // 2 - 1], fill=colour)
    return image


def bands(w: int = 800, h: int = 120, count: int = 8) -> Image.Image:
    """Vertical bands light to dark, left to right: the noise-strip stand-in."""
    image = Image.new("RGB", (w, h))
    draw = ImageDraw.Draw(image)
    for i in range(count):
        level = 255 - i * 255 // (count - 1)
        draw.rectangle([i * w // count, 0, (i + 1) * w // count - 1, h - 1], fill=(level, 64, 255 - level))
    return image


def pdf_figure() -> bytes:
    import pymupdf as fitz

    doc = fitz.open()
    page = doc.new_page(width=400, height=200)
    page.draw_rect(page.rect, color=None, fill=(1, 1, 1))
    page.draw_rect(fitz.Rect(20, 20, 180, 180), color=None, fill=(0.125, 0.5, 0.875))
    page.draw_circle(fitz.Point(300, 100), 70, color=None, fill=(0.875, 0.125, 0.125))
    # No dates and no fresh document id, so the bytes are the same every run.
    doc.set_metadata({})
    return doc.tobytes(no_new_id=True)


def tiff_figure() -> bytes:
    out = io.BytesIO()
    quadrants(200, 200).save(out, "TIFF")
    return out.getvalue()


def jpeg_photo() -> bytes:
    image = Image.new("RGB", (320, 240))
    for x in range(320):
        ImageDraw.Draw(image).line([(x, 0), (x, 239)], fill=(x * 255 // 319, 120, 200))
    out = io.BytesIO()
    image.save(out, "JPEG", quality=85)
    return out.getvalue()


def animated_gif() -> bytes:
    frames = [Image.new("RGB", (64, 64), colour) for colour in (RED, BLUE)]
    out = io.BytesIO()
    frames[0].save(out, "GIF", save_all=True, append_images=frames[1:], duration=300, loop=0)
    return out.getvalue()


def clip(codec: str, suffix: str) -> bytes:
    """Two seconds of a test pattern; mpeg4 is the codec browsers cannot play."""
    with tempfile.TemporaryDirectory() as tmp:
        target = Path(tmp) / f"clip{suffix}"
        args = ["ffmpeg", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=160x90:rate=10:duration=2",
                "-c:v", codec, "-pix_fmt", "yuv420p", "-fflags", "+bitexact", "-flags:v", "+bitexact",
                "-map_metadata", "-1"]
        if codec == "libx264":
            args += ["-preset", "veryfast", "-x264-params", "threads=1"]
        subprocess.run(args + [str(target)], check=True)
        return target.read_bytes()


# --- the deck --------------------------------------------------------------------


class Reference:
    def __init__(self) -> None:
        self.deck = KeynoteBuilder()
        self.deck.drop_base_slide()
        deck = self.deck
        self.label_style = deck.para_style(28, "HelveticaNeue", colour="#555555")
        self.plain = deck.shape_style(stroke=stroke("#000000", 1, "TSDEmptyPattern"), fill={})
        self.body = deck.para_style(40, "HelveticaNeue")
        self.fills = {colour: deck.shape_style(fill=colour) for colour in [RED, GREEN, BLUE, YELLOW, *PALETTE]}
        self.data: dict[str, int] = {}

    # helpers ---------------------------------------------------------------------

    def slide(self, name: str, caption: str, **kwargs):
        slide = self.deck.new_slide(name, **kwargs)
        # Every slide says what it checks, top left, so the deck reads as a
        # catalogue when opened in Keynote.
        slide.text_box(geometry(60, 30, 1800, 50), Storage(caption, paras=[(0, self.label_style)]), self.plain)
        return slide

    def text(self, value: str, style: int | None = None) -> Storage:
        return Storage(value, paras=[(0, style or self.body)])

    def block(self, parent, x, y, w, h, colour, angle=0.0):
        return parent.shape(geometry(x, y, w, h, angle), rect_source(w, h), self.fills[colour])

    def media(self, name: str, payload: bytes, pixels=None, store=True) -> int:
        if name not in self.data:
            self.data[name] = self.deck.add_data(name, payload, pixels, store=store)
        return self.data[name]

    # slides ----------------------------------------------------------------------

    def build(self) -> KeynoteBuilder:
        for method in (
            self.title_and_notes, self.background_colour, self.background_image, self.skipped_slide,
            self.z_order, self.group_offset, self.rotated_groups, self.rotated_group_connector,
            self.connectors_under_nodes, self.rotation_sign, self.flipped_crops, self.crops_and_circles,
            self.media_styles, self.image_formats, self.asset_reuse, self.missing_media, self.instant_alpha,
            self.movies, self.shape_paint, self.outlines, self.rounded_cards, self.lines, self.connectors, self.pen_paths,
            self.parametric_arrows, self.label_fills, self.autosize_anchors, self.rotated_labels,
            self.clamped_text, self.empty_text_boxes, self.paragraph_styles, self.line_spacing,
            self.run_styles, self.fonts, self.numbered_lists, self.list_counting, self.list_kinds,
            self.underline_italic, self.builds, self.legacy_builds, self.move_build, self.roles_by_size,
            self.unsupported_drawable, self.equations, self.long_media_names, self.movie_containers,
        ):
            method()
        return self.deck

    def title_and_notes(self):
        """Placeholder identity sets the roles; notes live in a NoteArchive."""
        deck = self.deck
        slide = deck.new_slide("title-and-notes")
        title = slide.placeholder(
            "kKindTitlePlaceholder", geometry(140, 181, 1640, 366),
            self.text("Keynote import reference", deck.para_style(80, "HelveticaNeue-Bold", bold=True)), self.plain)
        body = slide.placeholder(
            "kKindBodyPlaceholder", geometry(140, 600, 1640, 200),
            self.text("One slide per fixed import behaviour", deck.para_style(40, "HelveticaNeue")), self.plain)
        slide.set_title(title)
        slide.set_body(body)
        slide.notes("Speaker notes must survive the import.\nA second line of notes.")

    def background_colour(self):
        slide = self.slide("background-colour", "Background colour from the slide style")
        slide.background({"color": rgb("#123456")})

    def background_image(self):
        slide = self.slide("background-image", "Background image becomes a full-bleed picture")
        data = self.media("backdrop.png", png(quadrants(384, 216)), (384, 216))
        slide.background({"image": {"imagedata": {"identifier": str(data)}, "technique": "ScaleToFill"}})

    def skipped_slide(self):
        self.slide("skipped-slide", "Skipped slides stay, marked skipped", skipped=True)

    def z_order(self):
        """drawables_z_order, not ownership order, is the paint order."""
        slide = self.slide("z-order", "Paint order follows drawables_z_order")
        label = slide.archive["ownedDrawables"][0]["identifier"]
        a = self.block(slide, 300, 300, 300, 300, RED)
        b = self.block(slide, 450, 400, 300, 300, GREEN)
        c = self.block(slide, 600, 500, 300, 300, BLUE)
        slide.z_order([int(label), c, a, b])

    def group_offset(self):
        """Group children sit in the group's coordinates, and paint as one block."""
        slide = self.slide("group-offset", "Group children are placed relative to the group")
        group = slide.group(geometry(100, 200, 400, 100))
        for i, colour in enumerate((RED, GREEN, BLUE)):
            self.block(group, i * 150, 0, 100, 100, colour)
        self.block(slide, 600, 200, 100, 100, YELLOW)

    def rotated_groups(self):
        """The dictionary slide's word vectors: columns of squares grouped and
        turned a quarter. Keynote's own numbers, including two rows whose
        squares sit outside their group's frame (y = -29.9, -60.1): Keynote
        draws all four rows over the same span, x 1045.5 to 1244.9."""
        slide = self.slide("rotated-groups", "Rotated groups turn their children about the centre")
        outer = slide.group(geometry(766.1, 284.4, 530.4, 558.9))
        rows = [
            (365.7, 61.9, 270, [0.0, 28.8, 57.5, 86.3, 115.1, 143.8, 172.6]),
            (365.7, 118.6, 90, [0.0, 28.8, 57.5, 86.3, 115.1, 143.8, 172.6]),
            (395.0, 180.3, 90, [0.0, 29.9, 57.5, 86.3, 115.1, 143.8, -29.9]),
            (424.5, 392.9, 90, [0.0, 29.9, 57.5, 86.3, 115.1, -60.1, -29.9]),
        ]
        for x, y, angle, offsets in rows:
            row = outer.group(geometry(x, y, 26.8, 199.4, angle))
            for colour, offset in zip(PALETTE, offsets):
                self.block(row, 0, offset, 26.8, 26.8, colour)

    def rotated_group_connector(self):
        """A rotated group's curved connector: its control point is in canvas
        space, so it turns with the group too."""
        slide = self.slide("rotated-group-connector", "A curve's control point turns with its group")
        group = slide.group(geometry(800, 400, 200, 200, 90))
        line = self.deck.shape_style(stroke=stroke("#000000", 4))
        group.connection(geometry(0, 0, 200, 200), [(0, 0), (100, 50), (200, 200)], line, (200, 200))

    def connectors_under_nodes(self):
        """A line ending inside a filled node paints below it once the group
        is flattened, though Keynote stores it after the nodes."""
        slide = self.slide("connectors-under-nodes", "Connector lines paint below the nodes they join")
        group = slide.group(geometry(200, 300, 800, 100))
        self.block(group, 0, 0, 200, 100, BLUE)
        self.block(group, 600, 0, 200, 100, GREEN)
        line = self.deck.shape_style(stroke=stroke("#000000", 3), head=False, tail=False)
        group.shape(geometry(100, 50, 600, 1), bezier_source((600, 1), path(("M", 0, 0), ("L", 600, 0))), line)

    def rotation_sign(self):
        """Keynote measures angles anticlockwise; CSS turns clockwise."""
        slide = self.slide("rotation-sign", "Anticlockwise Keynote angles become clockwise rotations")
        self.block(slide, 300, 400, 300, 150, RED, angle=330)
        self.block(slide, 900, 400, 300, 150, BLUE, angle=90)

    def flipped_crops(self):
        """The denoising slide: a strip flipped horizontally, and two crops of
        it inside a group. Keynote shows the crops at x 855 and x 1244; read
        without the flip they landed off the slide's left edge."""
        slide = self.slide("flipped-crops", "Flipped images mirror their picture and their crop")
        strip = self.media("strip.png", png(bands()), (800, 120))
        slide.image(geometry(51.6, 170.0, 1809.6, 271.9, flags=3 | FLIP_H), strip, mask=(0.0, 46.7, 1809.6, 225.2))
        group = slide.group(geometry(620.6, 247.6, 1084.3, 723.0))
        group.image(geometry(-1091.4, 376.5, 1998.6, 300.3, flags=3 | FLIP_H), strip, mask=(450.8, 47.0, 222.0, 253.3))
        group.image(geometry(-921.2, 378.0, 1998.6, 300.3, flags=3 | FLIP_H), strip, mask=(231.7, 47.0, 222.1, 253.3))
        quad = self.media("quadrants.png", png(quadrants()), (400, 300))
        slide.image(geometry(1500, 800, 200, 150, flags=3 | FLIP_V), quad)

    def crops_and_circles(self):
        slide = self.slide("crops-and-circles", "A mask is the visible box; a round mask is a circle crop")
        quad = self.media("quadrants.png", png(quadrants()), (400, 300))
        slide.image(geometry(100, 300, 400, 300), quad, mask=(100, 50, 200, 200))
        slide.image(geometry(800, 300, 400, 300), quad, mask=(100, 50, 200, 200), circle=True)

    def media_styles(self):
        slide = self.slide("media-style", "Image opacity, shadow and alt text")
        photo = self.media("photo.jpg", jpeg_photo(), (320, 240))
        slide.image(geometry(100, 300, 320, 240), photo, style=self.deck.media_style(opacity=0.21))
        slide.image(geometry(600, 300, 320, 240), photo, style=self.deck.media_style(shadow=shadow(angle=90, offset=5, radius=10, opacity=0.5)))
        slide.image(geometry(1100, 300, 320, 240), photo, alt="A horizontal colour ramp")

    def image_formats(self):
        slide = self.slide("image-formats", "TIFF becomes PNG, PDF becomes WebP, odd names are made safe")
        slide.image(geometry(100, 300, 200, 200), self.media("scan.tiff", tiff_figure(), (200, 200)))
        slide.image(geometry(400, 300, 400, 200), self.media("figure.pdf", pdf_figure()))
        slide.image(geometry(900, 300, 320, 240), self.media("photo.jpg", jpeg_photo(), (320, 240)))
        slide.image(geometry(1300, 300, 200, 150), self.media("Bildschirmfoto café 12.12.40\u202fPM.png", png(quadrants(200, 150)), (200, 150)))

    def asset_reuse(self):
        """The same picture on the next slide is the same asset, so Morph
        sees an unchanged object."""
        slide = self.slide("asset-reuse", "A picture used twice is one asset")
        slide.image(geometry(900, 300, 320, 240), self.media("photo.jpg", jpeg_photo(), (320, 240)))

    def missing_media(self):
        slide = self.slide("missing-media", "A linked image falls back to its thumbnail; no data is a placeholder")
        original = self.media("Screenshot 2026-01-01 at 3.27.15\u202fPM.png", png(quadrants(800, 600)), (800, 600), store=False)
        thumb = self.media("linked-thumbnail.png", png(quadrants(100, 75)), (100, 75))
        slide.image(geometry(100, 300, 400, 300), original, thumbnail=thumb)
        slide.image(geometry(700, 300, 400, 300), None)
        slide.movie(geometry(1300, 300, 400, 225), None)

    def instant_alpha(self):
        """Background removal is a path on the image; it is baked into alpha,
        once for both copies."""
        slide = self.slide("instant-alpha", "Instant Alpha becomes transparent pixels")
        square = Image.new("RGB", (200, 200), "#ffffff")
        ImageDraw.Draw(square).ellipse([40, 40, 160, 160], fill=BLUE)
        data = self.media("cutout.png", png(square), (200, 200))
        keep = path(("M", 100, 20), ("L", 180, 180), ("L", 20, 180), ("Z",))
        for x in (100, 600):
            slide.image(geometry(x, 300, 400, 400), data, natural=(200, 200), alpha_path=keep)
        square_cut = path(("M", 40, 40), ("L", 160, 40), ("L", 160, 160), ("L", 40, 160), ("Z",))
        slide.image(geometry(1100, 300, 400, 400), data, natural=(200, 200), alpha_path=square_cut)

    def movies(self):
        slide = self.slide("movies", "Movies loop muted with their trim; GIFs are pictures; old codecs transcode")
        slide.movie(geometry(100, 300, 480, 270), self.media("clip.mp4", clip("libx264", ".mp4")), start=0.5, end=1.5, natural=(160, 90))
        slide.movie(geometry(700, 300, 256, 256), self.media("spinner.gif", animated_gif(), (64, 64)), natural=(64, 64))
        slide.movie(geometry(1100, 300, 480, 270), self.media("legacy.mov", clip("mpeg4", ".mov")), natural=(160, 90))

    def shape_paint(self):
        deck = self.deck
        slide = self.slide("shape-paint", "Theme hairlines, empty patterns and empty fills draw nothing")
        black_hairline = deck.shape_style(stroke=stroke("#000000", 1))
        # (a) the stroke is the theme's, inherited: a filled box does not draw it.
        a = deck.shape_style(fill=BLUE, parent=black_hairline)
        slide.shape(geometry(100, 250, 200, 150), rect_source(200, 150), a)
        # (b) a black hairline on the box itself is the same theme default.
        b = deck.shape_style(fill=BLUE, stroke=stroke("#000000", 1))
        slide.shape(geometry(400, 250, 200, 150), rect_source(200, 150), b)
        # (c) a deliberate outline stays.
        c = deck.shape_style(fill=BLUE, stroke=stroke("#ee220c", 7))
        slide.shape(geometry(700, 250, 200, 150), rect_source(200, 150), c)
        # (d) a text box whose stroke has the empty pattern, over a parent that
        # strokes red: no outline at all, only the words.
        red_outline = deck.shape_style(stroke=stroke("#ff0000", 2))
        d = deck.shape_style(stroke=stroke("#000000", 1, "TSDEmptyPattern"), parent=red_outline)
        slide.text_box(geometry(1000, 250, 400, 100), self.text("No phantom border"), d)
        # (e) `fill {}` on the leaf means no fill, whatever the parent says.
        red_fill = deck.shape_style(fill=RED)
        e = deck.shape_style(fill={}, stroke=stroke(GREEN, 4), parent=red_fill)
        slide.shape(geometry(100, 600, 200, 150), rect_source(200, 150), e)
        # (f) neither fill nor stroke: nothing to draw, nothing imported.
        slide.shape(geometry(400, 600, 200, 150), rect_source(200, 150), self.plain)
        # (g) opacity and a drop shadow, on the box and on its words.
        g = deck.shape_style(fill=YELLOW, opacity=0.75, shadow=shadow(angle=90, offset=5, radius=10, opacity=0.5))
        slide.shape(geometry(700, 600, 300, 150), rect_source(300, 150), g, text=self.text("Translucent"))

    def outlines(self):
        deck = self.deck
        slide = self.slide("outlines", "Outlines straddle the edge; rounded and curved paths keep their form")
        red = deck.shape_style(fill={}, stroke=stroke("#ee220c", 5))
        slide.shape(geometry(97, 767, 200, 200), rect_source(200, 200), red)
        rounded = deck.shape_style(fill=GREEN, stroke=stroke(BLUE, 4))
        slide.shape(geometry(400, 300, 300, 200), scalar_source(300, 200, 12), rounded)
        # Path bounds 300x150 differ from the naturalSize Keynote cached; the
        # shape is scaled from the path's own extent.
        curve = path(("M", 0, 150), ("C", 0, 0, 300, 0, 300, 150), ("L", 150, 100), ("Z",))
        slide.shape(geometry(900, 300, 600, 300), bezier_source((200, 100), curve), self.fills[BLUE])

    def rounded_cards(self):
        deck = self.deck
        slide = self.slide("rounded-cards", "Rounded cards keep their radius and drop shadow")
        card = deck.shape_style(fill="#ffffff", shadow=shadow(angle=90, offset=4, radius=12, opacity=0.3))
        for i in range(3):
            slide.shape(geometry(160 + i * 560, 300, 480, 400), scalar_source(480, 400, 24), card)

    def lines(self):
        deck = self.deck
        slide = self.slide("lines", "Two-point paths are native lines; arrowheads only where drawn")
        plain = deck.shape_style(stroke=stroke("#000000", 3), head=False, tail=False)
        slide.shape(geometry(100, 300, 345, 1), bezier_source((141, 1), path(("M", 0, 0), ("L", 141, 0))), plain)
        arrow = deck.shape_style(stroke=stroke("#000000", 3), head=True, tail=False)
        slide.shape(geometry(100, 500, 600, 1), bezier_source((600, 1), path(("M", 0, 0), ("L", 600, 0))), arrow)

    def connectors(self):
        deck = self.deck
        slide = self.slide("connectors", "Connection lines are native lines; a curve keeps its control point")
        line = deck.shape_style(stroke=stroke("#000000", 3), head=True, tail=False)
        slide.connection(geometry(200, 300, 300, 100), [(0, 0), (300, 100)], line, (300, 100))
        # Keynote's numbers for a curved connector: the middle point is the
        # control point, and the path is scaled from its natural size.
        slide.connection(geometry(604.76904, 426.2716, 332.5504, 282.67462),
                         [(0, 0), (248.2454, 150.64738), (355.231, 371.35474)], line, (355.231, 371.35474))

    def pen_paths(self):
        slide = self.slide("pen-paths", "Pen-tool paths draw; flipped paths are mirrored")
        import math

        star = []
        for i in range(24):
            radius = 150 if i % 2 == 0 else 70
            angle = math.pi * i / 12
            star.append((150 + radius * math.cos(angle), 150 + radius * math.sin(angle)))
        slide.shape(geometry(200, 300, 300, 300), editable_source(star, 300, 300), self.fills[YELLOW])
        triangle = path(("M", 0, 0), ("L", 200, 100), ("L", 0, 200), ("Z",))
        slide.shape(geometry(800, 300, 200, 200), bezier_source((200, 200), triangle, h=True), self.fills[RED])

    def parametric_arrows(self):
        slide = self.slide("parametric-arrows", "Keynote's arrow shapes store no path, only a head and a stem")
        black = self.fills[PALETTE[5]]
        slide.shape(geometry(100, 300, 95.27, 61.69), point_source("kTSDRightSingleArrow", 46.79, 0.34, 95.27, 61.69), black)
        # A head longer than the shape is wide: the solid triangle between figures.
        slide.shape(geometry(400, 300, 48.18, 100), point_source("kTSDRightSingleArrow", 100, 0.34, 48.18, 100), black)
        slide.shape(geometry(700, 300, 200, 100), point_source("kTSDLeftSingleArrow", 60, 0.5, 200, 100), black)
        slide.shape(geometry(1000, 300, 300, 100), point_source("kTSDDoubleArrow", 60, 0.5, 300, 100), black)
        slide.shape(geometry(1400, 300, 200, 200), point_source("kTSDStar", 0.5, 5, 200, 200), black)

    def label_fills(self):
        """The denoising arrow's white label, sized to its text, cuts the line."""
        deck = self.deck
        slide = self.slide("label-fills", "A filled label sized to its text paints behind the text")
        line = deck.shape_style(stroke=stroke("#000000", 4), head=True, tail=False)
        slide.shape(geometry(61.2, 195.0, 1797.6, 1), bezier_source((1797.6, 1), path(("M", 0, 0), ("L", 1797.6, 0))), line)
        white = deck.shape_style(fill="#ffffff", valign="kFrameAlignMiddle")
        centred = deck.para_style(42, "HelveticaNeue", align="TATvalue2")
        slide.text_box(geometry(960, 195, 0, 0, flags=0), self.text("Denoising", centred), white, natural=(199, 65), rounded=True)
        bordered = deck.shape_style(fill="#ffffff", stroke=stroke("#000000", 3))
        slide.shape(geometry(300, 600, 400, 200), rect_source(400, 200), bordered, text=self.text("Bordered caption"))

    def autosize_anchors(self):
        """A box sized to its text stores its alignment anchor, not its corner."""
        deck = self.deck
        slide = self.slide("autosize-anchors", "Text sized to fit grows from its alignment anchor")
        cases = [
            (400, 400, "TATvalue0", "kFrameAlignTop", "Left top"),
            (960, 400, "TATvalue2", "kFrameAlignMiddle", "Centre middle"),
            (1500, 400, "TATvalue1", "kFrameAlignBottom", "Right bottom"),
        ]
        for x, y, align, valign, words in cases:
            style = deck.shape_style(stroke=stroke("#000000", 1, "TSDEmptyPattern"), fill={}, valign=valign)
            slide.text_box(geometry(x, y, 0, 0, flags=0), self.text(words, deck.para_style(40, "HelveticaNeue", align=align)), style, natural=(260, 58))

    def rotated_labels(self):
        deck = self.deck
        slide = self.slide("rotated-labels", "Turned labels keep their anchor and are not clamped")
        middle = deck.shape_style(stroke=stroke("#000000", 1, "TSDEmptyPattern"), fill={}, valign="kFrameAlignMiddle")
        detail = deck.para_style(32, "HelveticaNeue-Medium")
        slide.text_box(geometry(77.53, 870.85, 0, 0, angle=90, flags=0), self.text("Detail →", detail), middle, natural=(134.66, 46.19))
        bottom = deck.shape_style(stroke=stroke("#000000", 1, "TSDEmptyPattern"), fill={}, valign="kFrameAlignBottom")
        slide.text_box(geometry(600, 500, 300, 0, angle=90, flags=1), self.text("Fixed width", detail), bottom, natural=(300, 40))
        slide.text_box(geometry(1700, 400, 400, 60, angle=330), self.text("Leaning past the edge", detail), middle)

    def clamped_text(self):
        deck = self.deck
        slide = self.slide("clamped-text", "Text frames past the slide edge are clipped about their anchor")
        middle = deck.shape_style(stroke=stroke("#000000", 1, "TSDEmptyPattern"), fill={}, valign="kFrameAlignMiddle")
        centred = deck.para_style(60, "HelveticaNeue", align="TATvalue2")
        slide.text_box(geometry(-100, 300, 2120, 120), self.text("A title wider than the slide", centred), middle)
        slide.text_box(geometry(400, 960, 1100, 200), self.text("A caption hanging below the slide", centred), middle)

    def empty_text_boxes(self):
        deck = self.deck
        slide = self.slide("empty-text-boxes", "An empty box keeps its slot; a stray click does not")
        style = deck.para_style(12, "Times-Roman")
        slide.text_box(geometry(954, 540, 0, 0, flags=0), Storage("", paras=[(0, style)]), self.plain)
        slide.text_box(geometry(300, 300, 400, 100), Storage("", paras=[(0, style)]), self.plain)

    def paragraph_styles(self):
        """A title over author lines: each paragraph carries its own size and
        face; entries without an object continue the one before; affiliation
        marks are superscript; the title's second half un-bolds a bold face."""
        deck = self.deck
        slide = self.slide("paragraph-styles", "Every paragraph keeps its own size, face and spacing")
        text = ("Layered Text: Reference Title\n\nAda*1, Ben*1\nCyd2\n\n"
                "1North Lab          2South Lab\n*Equal contribution")
        authors = text.index("Ada")
        blank = text.index("\n\n1North") + 1
        affiliations = text.index("1North")
        title = deck.para_style(80, "HelveticaNeue-Bold", bold=True, tracking=-0.02)
        subtitle = deck.para_style(48, "HelveticaNeue-Bold", bold=True, tracking=-0.02)
        names = deck.para_style(48, "HelveticaNeue-Light")
        places = deck.para_style(40, "HelveticaNeue-Light", space_after=24)
        unbold = deck.char_style(bold=False)
        sup = deck.char_style(superscript="kSuperscript")
        storage = Storage(
            text,
            paras=[(0, title), (text.index("\n\nAda") + 1, subtitle), (authors, names),
                   (text.index("Cyd"), None), (blank, None), (affiliations, places), (text.index("*Equal"), None)],
            chars=[(0, None), (len("Layered "), unbold), (authors, None),
                   (text.index("1,"), sup), (text.index("1,") + 1, None),
                   (affiliations, sup), (affiliations + 1, None)],
        )
        slide.text_box(geometry(95, 120, 1730, 779), storage, self.plain)

    def line_spacing(self):
        deck = self.deck
        slide = self.slide("line-spacing", "Line spacing is a unitless ratio in every Keynote mode")
        text = "Relative spacing first\nThen space before"
        first = deck.para_style(48, "HelveticaNeue", line_spacing=("kRelativeLineSpacing", 0.9))
        second = deck.para_style(48, "HelveticaNeue", line_spacing=("kRelativeLineSpacing", 0.9), space_before=24)
        slide.text_box(geometry(95, 150, 1730, 200), Storage(text, paras=[(0, first), (text.index("Then"), second)]), self.plain)
        modes = [("kExactLineSpacing", 50, "Exact"), ("kMinimumLineSpacing", 60, "Minimum"),
                 ("kMaximumLineSpacing", 40, "Maximum"), ("kSpaceBetweenLineSpacing", 20, "Between")]
        for i, (mode, amount, words) in enumerate(modes):
            style = deck.para_style(40, "HelveticaNeue", line_spacing=(mode, amount))
            slide.text_box(geometry(95 + i * 450, 500, 400, 200), self.text(f"{words} spacing", style), self.plain)

    def run_styles(self):
        deck = self.deck
        slide = self.slide("run-styles", "Character runs carry only what differs from the paragraph")
        text = "plain italic medium small spaced red low"
        para = deck.para_style(60, "HelveticaNeue")
        runs = [
            ("italic", deck.char_style(italic=True)),
            ("medium", deck.char_style(fontName="HelveticaNeue-Medium")),
            ("small", deck.char_style(fontSize=30.0)),
            ("spaced", deck.char_style(tracking=0.05)),
            ("red", deck.char_style(fontColor="#ff0000")),
            ("low", deck.char_style(superscript="kSubscript")),
        ]
        chars = [(0, None)]
        for word, style in runs:
            at = text.index(word)
            chars += [(at, style), (at + len(word), None)]
        slide.text_box(geometry(95, 150, 1730, 120), Storage(text, paras=[(0, para)], chars=chars[:-1]), self.plain)
        # The first run's colour wins over the paragraph's, but only the run
        # style itself counts, not its parent.
        blue_parent = deck.char_style(fontColor="#0000ff")
        red_leaf = deck.add_style(
            "TSWP.CharacterStyleArchive",
            {"super": {"parent": {"identifier": str(blue_parent)}}, "charProperties": {"fontColor": rgb("#ff0000")}})
        black = deck.para_style(48, "HelveticaNeue", colour="#000000")
        slide.text_box(geometry(95, 350, 800, 100), Storage("Recoloured label", paras=[(0, black)], chars=[(0, red_leaf)]), self.plain)
        gradient = {
            "type": "Linear",
            "stops": [{"color": rgb("#ff0000"), "fraction": 0.0}, {"color": rgb("#0000ff"), "fraction": 1.0}],
            "anglegradient": {"gradientangle": 0.5},
        }
        slide.text_box(geometry(1000, 350, 800, 100), self.text("Gradient words", deck.para_style(60, "HelveticaNeue", gradient=gradient)), self.plain)
        bold = deck.char_style(bold=True)
        slide.text_box(geometry(95, 600, 800, 100),
                       Storage("Part one", chunks=["Part one", "Part two"], paras=[(0, para)], chars=[(0, bold)]), self.plain)

    def fonts(self):
        deck = self.deck
        slide = self.slide("fonts", "PostScript faces get browser families and weights")
        for i, (font, bold, words) in enumerate([
            ("TimesNewRomanPSMT", None, "Times heading"),
            ("HelveticaNeue-Thin", None, "Thin face"),
            ("HelveticaNeue-Medium", None, "Medium face"),
            ("Avenir-Heavy", None, "Heavy face"),
            ("HelveticaNeue", True, "Bold flag"),
        ]):
            style = deck.para_style(70 if i == 0 else 48, font, bold=bold)
            slide.text_box(geometry(95, 150 + i * 150, 1200, 120), self.text(words, style), self.plain)

    def numbered_lists(self):
        """An underlined heading over a numbered staircase: levels 0, 1, 2, 2,
        1 with explicit starts 2, 3 and 5; list styles number one, two and
        three levels; the last paragraphs carry the list style forward."""
        deck = self.deck
        slide = self.slide("numbered-lists", "Numbered paragraphs nest at their level and number")
        lines = ["The Layered Plan", "Write a long section", "Write a medium section",
                 "Write a short section", "Repeat…", "Repeat…"]
        text = "\n".join(lines)
        at = [sum(len(line) + 1 for line in lines[:n]) for n in range(len(lines))]
        long_word = text.index("long")
        heading = deck.para_style(60, "HelveticaNeue-Light", underline="kSingleUnderline")
        items = deck.para_style(60, "HelveticaNeue-Light")
        medium = deck.char_style(fontName="HelveticaNeue-Medium")
        flat = deck.list_style(["kNone"] * 9, indents=[36.0 * n for n in range(9)])
        numbered = [deck.list_style(["kNumber" if n < depth else "kNone" for n in range(9)], parent=flat) for depth in (1, 2, 3)]
        storage = Storage(
            text,
            paras=[(0, heading), (at[1], items), (at[2], None), (at[3], None), (at[4], None), (at[5], None)],
            chars=[(0, None), (long_word, medium), (long_word + 4, None)],
            lists=[(0, flat), (at[1], numbered[0]), (at[2], numbered[1]), (at[3], numbered[2])],
            levels=[(0, 0), (at[2], 1), (at[3], 2), (at[5], 1)],
            starts=[(0, 0), (at[2], 2), (at[3], 3), (at[4], 0), (at[5], 5)],
        )
        slide.text_box(geometry(95, 150, 1730, 768), storage, self.plain)

    def list_counting(self):
        """Numbered items explained one level deeper: the count carries on
        past the unnumbered explanations, 1. then 2."""
        deck = self.deck
        slide = self.slide("list-counting", "Numbering counts on across unnumbered paragraphs")
        lines = ["Two parts:", "Reader", "Reads the input.", "", "Writer", "Writes the output."]
        text = "\n".join(lines)
        at = [sum(len(line) + 1 for line in lines[:n]) for n in range(len(lines))]
        none = deck.list_style(["kNone"] * 9)
        numbered = deck.list_style(["kNumber"] + ["kNone"] * 8)
        storage = Storage(
            text, paras=[(0, deck.para_style(60, "HelveticaNeue-Light"))],
            lists=[(0, none), (at[1], numbered), (at[2], none), (at[4], numbered), (at[5], none)],
            levels=[(0, 0), (at[2], 1), (at[4], 0), (at[5], 1)],
        )
        slide.text_box(geometry(95, 150, 1730, 768), storage, self.plain)

    def list_kinds(self):
        deck = self.deck
        slide = self.slide("list-kinds", "Roman numerals, character bullets and image bullets")
        style = deck.para_style(48, "HelveticaNeue")
        roman = deck.list_style(["kNumber"] * 9, numbers=["kRomanUpperDecimal"] * 9)
        slide.text_box(geometry(95, 150, 800, 300), Storage("First\nSecond", paras=[(0, style)], lists=[(0, roman)]), self.plain)
        bullets = deck.list_style(["kString"] * 9, strings=["•"] * 9)
        slide.text_box(geometry(95, 500, 800, 300), Storage("Apples\nPears", paras=[(0, style)], lists=[(0, bullets)]), self.plain)
        pictures = deck.list_style(["kImage"] * 9)
        slide.text_box(geometry(1000, 500, 800, 300), Storage("Plums\nCherries", paras=[(0, style)], lists=[(0, pictures)]), self.plain)

    def underline_italic(self):
        deck = self.deck
        slide = self.slide("underline-italic", "Paragraph underline and italic sit on the block or the runs")
        underlined = deck.para_style(60, "HelveticaNeue-Light", underline="kSingleUnderline")
        text = "Underlined Only At First"
        off = deck.char_style(underline="kNoUnderline")
        slide.text_box(geometry(95, 150, 1730, 100), Storage(text, paras=[(0, underlined)], chars=[(0, None), (len("Underlined"), off)]), self.plain)
        upright = deck.para_style(48, "HelveticaNeue")
        slanted = deck.para_style(48, "HelveticaNeue", italic=True)
        two = "Upright opening\nSlanted second paragraph"
        slide.text_box(geometry(95, 400, 1730, 200), Storage(two, paras=[(0, upright), (two.index("Slanted"), slanted)]), self.plain)
        slide.text_box(geometry(95, 700, 1730, 100), self.text("Slanted from the first word", slanted), self.plain)
        # An italic paragraph style whose run sets it upright again: Keynote
        # draws the words upright (a talk's title came out italic).
        upright_run = deck.char_style(italic=False)
        slide.text_box(geometry(95, 850, 1730, 100), Storage("Upright over an italic style", paras=[(0, slanted)], chars=[(0, upright_run)]), self.plain)

    def builds(self):
        slide = self.slide("builds", "Build In and Out become appear and disappear")
        a = self.block(slide, 200, 300, 300, 200, RED)
        b = self.block(slide, 700, 300, 300, 200, GREEN)
        c = slide.shape(geometry(1200, 300, 300, 200), rect_source(300, 200), self.fills[BLUE], text=self.text("Box with words"))
        quad = self.media("quadrants.png", png(quadrants()), (400, 300))
        arriving = slide.image(geometry(200, 650, 200, 150), quad)
        leaving = slide.image(geometry(700, 650, 200, 150), self.media("photo.jpg", jpeg_photo(), (320, 240)))
        slide.build(a, "In")
        slide.build(b, "Out", automatic=True, delay=0.5)
        slide.build(c, "In")
        slide.build(arriving, "In")
        slide.build(leaving, "Out")

    def legacy_builds(self):
        slide = self.slide("legacy-builds", "Builds without chunks still import, one click each")
        a = self.block(slide, 200, 300, 300, 200, RED)
        b = self.block(slide, 700, 300, 300, 200, GREEN)
        slide.build(a, "In", legacy=True)
        slide.build(b, "In", legacy=True)

    def move_build(self):
        """A Move build continues on a copy of the slide as a Morph."""
        slide = self.slide("move-build", "A Move build becomes a Morph to a copy of the slide")
        style = self.deck.para_style(40, "HelveticaNeue")
        ground = slide.text_box(geometry(440, 500, 180, 60), self.text("Ground", style), self.plain)
        mover = slide.text_box(geometry(447, 600, 180, 60), self.text("Mover", style), self.plain)
        follower = slide.text_box(geometry(440, 700, 180, 60), self.text("Follower", style), self.plain)
        late = slide.text_box(geometry(331, 800, 180, 60), self.text("Late", style), self.plain)
        slide.build(ground, "In")
        slide.build(mover, "In")
        slide.build(follower, "In")
        slide.build(mover, "Action", motion=(-346, 0), duration=1.0)
        slide.build(follower, "Action", automatic=True, motion=(-343, 0), duration=1.0)
        slide.build(late, "In")

    def roles_by_size(self):
        """Without placeholders, text is classed by size against the deck's
        body text (the 40pt body placeholder on the title slide)."""
        deck = self.deck
        slide = self.slide("roles-by-size", "Unplaced text gets a role from its size")
        for i, (pt, words) in enumerate([(60, "Results"), (48, "A heading"), (40, "Body sentence here"), (20, "Small caption"), (200, "+")]):
            slide.text_box(geometry(95 + (i % 3) * 600, 200 + (i // 3) * 400, 550, 300), self.text(words, deck.para_style(pt, "HelveticaNeue")), self.plain)

    def unsupported_drawable(self):
        """A chart: no editable equivalent yet, so its box stays as a placeholder."""
        slide = self.slide("unsupported-drawable", "Objects without an equivalent keep their box")
        slide._attach(slide.add("TSCH.ChartDrawableArchive", {"super": slide._drawable(geometry(300, 300, 800, 400))}))

    def equations(self):
        """Equations typed into text are attachments at a U+FFFC, and every
        one is a TSD.ImageArchive whose EquationInfoArchive extensions keep
        the LaTeX (or MathML) source. They imported as the bare U+FFFC."""
        deck = self.deck
        slide = self.slide("equations", "Equations become TeX: $…$ inline, $$…$$ on their own")
        inline = self.media("equation-inline.pdf", pdf_figure())
        body = deck.para_style(48, "HelveticaNeue")
        bold = deck.char_style(bold=True)

        def eq(source: str, w: float = 60, h: float = 50) -> int:
            return slide.inline_equation(source, inline, (w, h), font_size=48)

        # Styled runs around two LaTeX equations, beside a literal dollar.
        text = "Inputs \ufffc and \ufffc cost $5."
        first, second = (i for i, c in enumerate(text) if c == "\ufffc")
        slide.text_box(geometry(95, 150, 1730, 80), Storage(
            text, paras=[(0, body)], chars=[(0, bold), (len("Inputs"), None)],
            attachments=[(first, eq("\\mathbf{x}")),
                         (second, eq("\\epsilon \\sim \\mathcal{N}(\\mathbf{0},\\mathbf{I})", 300))]), self.plain)
        # MathML, the other source Keynote writes: math-italic letters.
        mathml = ('<math xmlns="http://www.w3.org/1998/Math/MathML">\n  <msup>\n    <mrow>\n'
                  '      <mi mathvariant="italic" mathcolor="#000000">\U0001d453</mi>\n    </mrow>\n    <mrow>\n'
                  '      <mi mathvariant="italic" mathcolor="#000000">\U0001d465</mi>\n    </mrow>\n  </msup>\n</math>')
        text = "Then \ufffc follows"
        slide.text_box(geometry(95, 260, 1730, 80), Storage(
            text, paras=[(0, body)], attachments=[(text.index("\ufffc"), eq(mathml))]), self.plain)
        # A matrix on a line of its own, its source spread over lines.
        text = "Stacked:\n\ufffc\nDone"
        matrix = "\\begin{bmatrix}\na \\\\\nb\n\\end{bmatrix}"
        slide.text_box(geometry(95, 370, 800, 300), Storage(
            text, paras=[(0, body)], attachments=[(text.index("\ufffc"), eq(matrix, 80, 120))]), self.plain)
        # MathML with an element there is no TeX for here stays a marked gap.
        odd = '<math xmlns="http://www.w3.org/1998/Math/MathML"><mmultiscripts><mi>R</mi><mi>i</mi><none/></mmultiscripts></math>'
        text = "Odd \ufffc one"
        slide.text_box(geometry(95, 700, 800, 80), Storage(
            text, paras=[(0, body)], attachments=[(text.index("\ufffc"), eq(odd))]), self.plain)
        # Equations placed on the slide by themselves; Keynote accepts an
        # accent on an unbraced `\mathbf`, which KaTeX does not.
        slide.equation(geometry(1000, 400, 520, 90), "p(\\dot\\mathbf{x}) = \\prod_i p(x_i \\mid x_{<i})",
                       self.media("equation-display.pdf", pdf_figure()), font_size=60, colour=BLUE)
        arrow = '<math xmlns="http://www.w3.org/1998/Math/MathML">\n  <mo mathcolor="#000000">\u27f6</mo>\n</math>'
        slide.equation(geometry(1000, 600, 158, 42), arrow, self.media("equation-arrow.pdf", pdf_figure()), font_size=108)
        slide.equation(geometry(1000, 800, 200, 100), odd, self.media("equation-fallback.pdf", pdf_figure()))

    def long_media_names(self):
        """A picture saved from a web page can carry its URL, hex-encoded, as
        its name: 248 characters, which with any suffix a tool adds passes
        the 255-byte limit on a file name."""
        slide = self.slide("long-media-names", "Overlong media names are shortened, and stay distinct")
        for i, tail in enumerate(("first", "second")):
            url = f"https://example.org/media/a-neutral-figure-used-to-test-long-names/in/a/deep/folder/{tail}.png?size=large"
            name = url.encode().hex() + ".png"
            slide.image(geometry(200 + i * 600, 300, 400, 300), self.media(name, png(quadrants()), (400, 300)))

    def movie_containers(self):
        """Screen recordings: H.264 in QuickTime, the index (moov) written
        after the media, and an old `.qt` name for the same container."""
        slide = self.slide("movie-containers", "QuickTime movies, .qt included, are remuxed to start fast")
        slide.movie(geometry(100, 300, 480, 270), self.media("recording.mov", clip("libx264", ".mov")), natural=(160, 90))
        slide.movie(geometry(700, 300, 480, 270), self.media("tape.qt", clip("libx264", ".mov")), natural=(160, 90))


def main() -> None:
    deck = Reference().build()
    deck.write(OUT)
    print(f"wrote {OUT.relative_to(Path.cwd()) if OUT.is_relative_to(Path.cwd()) else OUT} ({OUT.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
