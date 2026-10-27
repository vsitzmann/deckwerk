"""Write Keynote packages from Python, starting from a deck Keynote saved.

`make_reference.py` uses this to build reference.key. The base is
`example-keynote-decks/empty_deck.key`, a real Keynote save, so the theme,
stylesheet, templates and package metadata are Keynote's own; what this module
adds are slides whose archives copy the shapes Keynote writes, field for
field, with neutral content.

Objects are written in keynote_parser's dict form (`_pbtype` plus the
protobuf's JSON field names) and encoded with its codec, the same library the
importer reads them with.
"""

from __future__ import annotations

import base64
import copy
import hashlib
import io
import math
import zipfile
from pathlib import Path
from typing import Any, Iterable

from keynote_parser.codec import IWAFile, LATEST_VERSION, import_version

ROOT = Path(__file__).resolve().parents[3]
BASE_DECK = ROOT / "example-keynote-decks" / "empty_deck.key"

# Archive version every Keynote 14 save stamps on the objects it writes.
ARCHIVE_VERSION = [1, 0, 5]

# TSD.GeometryArchive.flags: 1 size valid, 2 angle valid, 4 / 8 the Flip
# Horizontally / Vertically commands. A text box sized to its content stores 0.
FLAGS = 3
FLIP_H = 4
FLIP_V = 8


def ref(identifier: int) -> dict[str, str]:
    return {"identifier": str(identifier)}


def point(x: float, y: float) -> dict[str, float]:
    return {"x": float(x), "y": float(y)}


def size(w: float, h: float) -> dict[str, float]:
    return {"width": float(w), "height": float(h)}


def rgb(hex_colour: str, alpha: float = 1.0) -> dict[str, Any]:
    """TSP.Color in sRGB, from '#rrggbb'."""
    value = hex_colour.lstrip("#")
    r, g, b = (int(value[i : i + 2], 16) / 255 for i in (0, 2, 4))
    return {"model": "rgb", "r": r, "g": g, "b": b, "a": float(alpha), "rgbspace": "srgb"}


def geometry(
    x: float, y: float, w: float, h: float, angle: float = 0.0, flags: int = FLAGS
) -> dict[str, Any]:
    """TSD.GeometryArchive. `angle` is Keynote's: degrees, anticlockwise."""
    return {"position": point(x, y), "size": size(w, h), "flags": flags, "angle": float(angle)}


# --- paths --------------------------------------------------------------------


def path(*elements: tuple) -> dict[str, Any]:
    """TSP.Path from ('M', x, y), ('L', x, y), ('Q', cx, cy, x, y),
    ('C', x1, y1, x2, y2, x, y) and ('Z',) steps."""
    kinds = {"M": "moveTo", "L": "lineTo", "Q": "quadCurveTo", "C": "curveTo", "Z": "closeSubpath"}
    out = []
    for step in elements:
        kind, coords = step[0], step[1:]
        element: dict[str, Any] = {"type": kinds[kind]}
        if coords:
            element["points"] = [point(coords[i], coords[i + 1]) for i in range(0, len(coords), 2)]
        out.append(element)
    return {"elements": out}


def rect_path(w: float, h: float) -> dict[str, Any]:
    """The closed four-line path Keynote stores for a sharp rectangle,
    trailing move back to the start included."""
    return path(("M", 0, 0), ("L", w, 0), ("L", w, h), ("L", 0, h), ("Z",), ("M", 0, 0))


def circle_path(w: float, h: float) -> dict[str, Any]:
    """Keynote's ellipse: a move and four cubic quarter arcs, then close."""
    k = 0.5522847498
    rx, ry, cx, cy = w / 2, h / 2, w / 2, h / 2
    return path(
        ("M", cx + rx, cy),
        ("C", cx + rx, cy + k * ry, cx + k * rx, cy + ry, cx, cy + ry),
        ("C", cx - k * rx, cy + ry, cx - rx, cy + k * ry, cx - rx, cy),
        ("C", cx - rx, cy - k * ry, cx - k * rx, cy - ry, cx, cy - ry),
        ("C", cx + k * rx, cy - ry, cx + rx, cy - k * ry, cx + rx, cy),
        ("Z",),
    )


def bezier_source(natural: tuple[float, float], elements: dict[str, Any], **flips: bool) -> dict[str, Any]:
    return {
        "horizontalFlip": bool(flips.get("h", False)),
        "verticalFlip": bool(flips.get("v", False)),
        "bezierPathSource": {"naturalSize": size(*natural), "path": elements},
    }


def rect_source(w: float, h: float) -> dict[str, Any]:
    return bezier_source((w, h), rect_path(w, h))


def scalar_source(w: float, h: float, scalar: float = 0.0, kind: str = "kTSDRoundedRectangle") -> dict[str, Any]:
    return {
        "horizontalFlip": False,
        "verticalFlip": False,
        "scalarPathSource": {"type": kind, "scalar": float(scalar), "naturalSize": size(w, h)},
    }


def point_source(kind: str, head: float, stem: float, w: float, h: float) -> dict[str, Any]:
    """A parametric arrow, star or plus: no path, only a control point."""
    return {
        "horizontalFlip": False,
        "verticalFlip": False,
        "pointPathSource": {"type": kind, "point": point(head, stem), "naturalSize": size(w, h)},
    }


def editable_source(nodes: Iterable[tuple[float, float]], w: float, h: float, closed: bool = True) -> dict[str, Any]:
    """Pen-tool path: corner nodes whose control points sit on the node."""
    return {
        "horizontalFlip": False,
        "verticalFlip": False,
        "editableBezierPathSource": {
            "subpaths": [
                {
                    "nodes": [
                        {"inControlPoint": point(x, y), "nodePoint": point(x, y), "outControlPoint": point(x, y), "type": "sharp"}
                        for x, y in nodes
                    ],
                    "closed": closed,
                }
            ],
            "naturalSize": size(w, h),
        },
    }


def line_end(draws: bool) -> dict[str, Any]:
    """TSD.LineEndArchive: Keynote's arrowhead, or the theme's empty slot."""
    if not draws:
        return {"path": {}, "lineJoin": "MiterJoin", "endPoint": point(0, 0), "isFilled": False, "identifier": ""}
    head = path(("M", -6, -4), ("L", 0, 0), ("L", -6, 4), ("Z",))
    return {"path": head, "lineJoin": "MiterJoin", "endPoint": point(0, 0), "isFilled": True, "identifier": "simple arrow"}


def stroke(colour: str | None, width: float = 1.0, pattern: str = "TSDSolidPattern") -> dict[str, Any]:
    out: dict[str, Any] = {
        "width": float(width),
        "cap": "ButtCap",
        "join": "MiterJoin",
        "miterLimit": 4.0,
        "pattern": {"type": pattern, "phase": 0.0, "count": 0},
    }
    if colour is not None:
        out["color"] = rgb(colour)
    return out


def shadow(colour: str = "#000000", angle: float = 90, offset: float = 5, radius: float = 10, opacity: float = 0.5) -> dict[str, Any]:
    return {
        "color": rgb(colour),
        "angle": float(angle),
        "offset": float(offset),
        "radius": float(radius),
        "opacity": float(opacity),
        "isEnabled": True,
        "type": "TSDDropShadow",
    }


def equation_fields(
    drawable: dict[str, Any], source: str, data: int, font_size: float, colour: str
) -> dict[str, Any]:
    """TSD.ImageArchive fields of a Keynote equation: the rendered PDF as its
    data, and the LaTeX or MathML source, font and depth in the
    TSWP.EquationInfoArchive extensions, as Keynote 14 writes them."""
    w, h = drawable["geometry"]["size"]["width"], drawable["geometry"]["size"]["height"]
    return {
        "super": drawable,
        "originalSize": size(w, h),
        "naturalSize": size(w, h),
        "flags": 0,
        "data": {"identifier": str(data)},
        "interpretsUntaggedImageDataAsGeneric": False,
        "[TSWP.EquationInfoArchive.equation_source_old]": source,
        "[TSWP.EquationInfoArchive.equation_text_properties]": {
            "fontSize": float(font_size),
            "fontName": "HelveticaNeue-Light",
            "fontColor": rgb(colour),
        },
        "[TSWP.EquationInfoArchive.equation_depth]": 10.0,
        "[TSWP.EquationInfoArchive.equation_source_text]": source,
    }


# --- the package ----------------------------------------------------------------


class KeynoteBuilder:
    """A Keynote package being assembled from the base deck."""

    def __init__(self, base: Path = BASE_DECK) -> None:
        id_name, _, _ = import_version(LATEST_VERSION)
        self._type_id: dict[str, int] = {}
        for type_id, klass in sorted(id_name.items()):
            self._type_id.setdefault(klass.DESCRIPTOR.full_name, type_id)
        self._members: dict[str, bytes] = {}
        self._streams: dict[str, dict[str, Any]] = {}
        with zipfile.ZipFile(base) as archive:
            for info in archive.infolist():
                data = archive.read(info)
                if info.filename.endswith(".iwa"):
                    self._streams[info.filename] = IWAFile.from_buffer(data, info.filename).to_dict()
                else:
                    self._members[info.filename] = data
        self._index: dict[int, dict[str, Any]] = {}
        for archive in self._archives():
            self._index[int(archive["header"]["identifier"])] = archive["objects"][0]
        self.metadata = self._find("TSP.PackageMetadata")
        self.show = self._find("KN.ShowArchive")
        self._next_id = int(self.metadata["lastObjectIdentifier"]) + 1
        # The base deck's one slide supplies the slide style, the master and
        # the note style that new slides inherit.
        node_id = int(self.show["slideTree"]["slides"][0]["identifier"])
        self.base_node = self.object(node_id)
        self.base_slide = self.object(int(self.base_node["slide"]["identifier"]))
        self.stylesheet = int(self.show["stylesheet"]["identifier"])

    # --- object table -------------------------------------------------------

    def _archives(self):
        for stream in self._streams.values():
            for chunk in stream["chunks"]:
                yield from chunk["archives"]

    def _find(self, pbtype: str) -> dict[str, Any]:
        for archive in self._archives():
            if archive["objects"] and archive["objects"][0].get("_pbtype") == pbtype:
                return archive["objects"][0]
        raise KeyError(pbtype)

    def object(self, identifier: int) -> dict[str, Any]:
        return self._index[int(identifier)]

    def new_id(self) -> int:
        identifier = self._next_id
        self._next_id += 1
        return identifier

    def add(self, stream: str, pbtype: str, fields: dict[str, Any], identifier: int | None = None) -> int:
        """Append one object to a stream (created on first use); returns its id."""
        identifier = self.new_id() if identifier is None else identifier
        message = dict(fields)
        message["_pbtype"] = pbtype
        header = {
            "identifier": str(identifier),
            "messageInfos": [{"type": self._type_id[pbtype], "version": ARCHIVE_VERSION}],
            "_pbtype": "TSP.ArchiveInfo",
        }
        target = self._streams.setdefault(stream, {"chunks": [{"archives": []}]})
        target["chunks"][0]["archives"].append({"header": header, "objects": [message]})
        self._index[identifier] = message
        return identifier

    # --- styles ---------------------------------------------------------------

    def style_by_name(self, pbtype: str, name: str) -> int:
        """A named style of the base deck's theme ('Body', 'Title', 'None' …)."""
        for identifier, message in self._index.items():
            if message.get("_pbtype") != pbtype:
                continue
            base = message.get("super", {})
            if base.get("name") == name and not base.get("isVariation"):
                return identifier
        raise KeyError(f"{pbtype} {name!r}")

    def add_style(self, pbtype: str, fields: dict[str, Any]) -> int:
        """Add a style to the document stylesheet, where Keynote keeps them."""
        stylesheet = self.object(self.stylesheet)
        fields = copy.deepcopy(fields)
        inner = fields.setdefault("super", {})
        while "super" in inner:
            inner = inner["super"]
        inner.setdefault("stylesheet", ref(self.stylesheet))
        inner.setdefault("isVariation", "parent" in inner)
        identifier = self.add("Index/DocumentStylesheet.iwa", pbtype, fields)
        stylesheet["styles"].append(ref(identifier))
        return identifier

    def shape_style(
        self,
        *,
        fill: str | dict | None = None,
        stroke: dict | None = None,
        opacity: float | None = None,
        shadow: dict | None = None,
        head: bool | None = None,
        tail: bool | None = None,
        valign: str | None = None,
        padding: tuple[float, float, float, float] | None = None,
        parent: int | None = None,
    ) -> int:
        """TSWP.ShapeStyleArchive. `fill` is '#rrggbb', a FillArchive dict, or
        {} for Keynote's explicit "no fill"; omitted properties inherit."""
        props: dict[str, Any] = {}
        if fill is not None:
            props["fill"] = {"color": rgb(fill)} if isinstance(fill, str) else fill
        if stroke is not None:
            props["stroke"] = stroke
        if opacity is not None:
            props["opacity"] = float(opacity)
        if shadow is not None:
            props["shadow"] = shadow
        if head is not None:
            props["headLineEnd"] = line_end(head)
        if tail is not None:
            props["tailLineEnd"] = line_end(tail)
        text_props: dict[str, Any] = {}
        if valign is not None:
            text_props["verticalAlignment"] = valign
        if padding is not None:
            text_props["padding"] = dict(zip(("left", "top", "right", "bottom"), map(float, padding)))
        base: dict[str, Any] = {}
        if parent is not None:
            base["parent"] = ref(parent)
        return self.add_style(
            "TSWP.ShapeStyleArchive",
            {"super": {"super": base, "shapeProperties": props}, "shapeProperties": text_props},
        )

    def para_style(
        self,
        size: float | None = None,
        font: str | None = None,
        *,
        parent: int | None = None,
        bold: bool | None = None,
        italic: bool | None = None,
        colour: str | None = None,
        tracking: float | None = None,
        underline: str | None = None,
        align: str | None = None,
        line_spacing: tuple[str, float] | None = None,
        space_before: float | None = None,
        space_after: float | None = None,
        gradient: dict | None = None,
    ) -> int:
        """TSWP.ParagraphStyleArchive. `align` is TATvalue0..4 (left, right,
        center, justify, natural); `line_spacing` is (mode, amount)."""
        char: dict[str, Any] = {}
        if size is not None:
            char["fontSize"] = float(size)
        if font is not None:
            char["fontName"] = font
        if bold is not None:
            char["bold"] = bold
        if italic is not None:
            char["italic"] = italic
        if colour is not None:
            char["fontColor"] = rgb(colour)
        if tracking is not None:
            char["tracking"] = float(tracking)
        if underline is not None:
            char["underline"] = underline
        if gradient is not None:
            char["tsdFill"] = {"gradient": gradient}
        para: dict[str, Any] = {}
        if align is not None:
            para["alignment"] = align
        if line_spacing is not None:
            mode, amount = line_spacing
            para["lineSpacing"] = {"amount": float(amount)} if mode == "kRelativeLineSpacing" else {"mode": mode, "amount": float(amount)}
        if space_before is not None:
            para["spaceBefore"] = float(space_before)
        if space_after is not None:
            para["spaceAfter"] = float(space_after)
        base: dict[str, Any] = {}
        if parent is not None:
            base["parent"] = ref(parent)
        return self.add_style(
            "TSWP.ParagraphStyleArchive",
            {"super": base, "charProperties": char, "paraProperties": para},
        )

    def char_style(self, **char: Any) -> int:
        """TSWP.CharacterStyleArchive with char_properties given verbatim."""
        if "fontColor" in char and isinstance(char["fontColor"], str):
            char["fontColor"] = rgb(char["fontColor"])
        return self.add_style("TSWP.CharacterStyleArchive", {"super": {}, "charProperties": char})

    def list_style(
        self,
        labels: Iterable[str],
        *,
        numbers: Iterable[str] = (),
        indents: Iterable[float] = (),
        strings: Iterable[str] = (),
        parent: int | None = None,
    ) -> int:
        """TSWP.ListStyleArchive, one label type per level."""
        fields: dict[str, Any] = {"super": {"parent": ref(parent)} if parent is not None else {}, "labelTypes": list(labels)}
        if numbers:
            fields["numberTypes"] = list(numbers)
        if indents:
            fields["indents"] = [float(i) for i in indents]
        if strings:
            fields["strings"] = list(strings)
        return self.add_style("TSWP.ListStyleArchive", fields)

    def media_style(self, *, opacity: float | None = None, shadow: dict | None = None) -> int:
        props: dict[str, Any] = {}
        if opacity is not None:
            props["opacity"] = float(opacity)
        if shadow is not None:
            props["shadow"] = shadow
        return self.add_style("TSD.MediaStyleArchive", {"super": {}, "mediaProperties": props})

    def slide_style(self, fill: dict) -> int:
        """A variation of the base slide style that sets the background fill."""
        return self.add_style(
            "KN.SlideStyleArchive",
            {"super": {"parent": self.base_slide["style"]}, "overrideCount": 1, "slideProperties": {"fill": fill}},
        )

    # --- data files -------------------------------------------------------------

    def add_data(self, file_name: str, payload: bytes, pixel_size: tuple[int, int] | None = None, *, store: bool = True) -> int:
        """Register a file in PackageMetadata and store it under Data/.

        `store=False` registers it without the bytes, which is what a linked
        image whose original never made it into the package looks like.
        """
        identifier = self.new_id()
        stem, dot, ext = file_name.rpartition(".")
        stored = f"{stem}-{identifier}{dot}{ext}"
        if store:
            self._members[f"Data/{stored}"] = payload
        entry: dict[str, Any] = {
            "identifier": str(identifier),
            "digest": base64.b64encode(hashlib.sha1(payload).digest()).decode(),
            "preferredFileName": file_name,
            "fileName": stored,
        }
        if pixel_size is not None:
            entry["attributes"] = {
                "[TSD.ImageDataAttributes.image_data_attributes]": {
                    "pixelSize": size(*pixel_size),
                    "shouldBeInterpretedAsGenericIfUntagged": False,
                }
            }
        self.metadata["datas"].append(entry)
        return identifier

    # --- slides -----------------------------------------------------------------

    def new_slide(self, name: str, *, skipped: bool = False) -> "SlideBuilder":
        return SlideBuilder(self, name, skipped=skipped)

    def drop_base_slide(self) -> None:
        """Remove the base deck's blank slide from the show (it stays archived)."""
        del self.show["slideTree"]["slides"][0]

    # --- output -----------------------------------------------------------------

    def write(self, out: Path) -> None:
        self.metadata["lastObjectIdentifier"] = str(self._next_id - 1)
        members = dict(self._members)
        for name, stream in self._streams.items():
            members[name] = IWAFile.from_dict(copy.deepcopy(stream)).to_buffer()
        out.parent.mkdir(parents=True, exist_ok=True)
        buffer = io.BytesIO()
        # Fixed timestamps and member order make the output byte-stable, so a
        # regenerated deck only shows up in git when its content changed.
        with zipfile.ZipFile(buffer, "w", zipfile.ZIP_STORED) as archive:
            for name in sorted(members):
                info = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
                archive.writestr(info, members[name])
        out.write_bytes(buffer.getvalue())


class Container:
    """Something drawables can be put in: a slide or a group."""

    slide: "SlideBuilder"
    container_id: int

    def _attach(self, drawable_id: int) -> int:
        raise NotImplementedError

    def _drawable(self, geo: dict[str, Any], **extra: Any) -> dict[str, Any]:
        """TSD.DrawableArchive fields, parented to this container."""
        out = {"geometry": geo, "parent": ref(self.container_id)}
        out.update(extra)
        return out

    # Every factory returns the new drawable's id.

    def shape(
        self,
        geo: dict[str, Any],
        pathsource: dict[str, Any],
        style: int,
        *,
        text: "Storage | None" = None,
        text_box: bool = False,
        pbtype: str = "TSWP.ShapeInfoArchive",
    ) -> int:
        storage = text.build(self.slide) if text is not None else Storage("").build(self.slide)
        fields = {
            "super": {
                "super": self._drawable(geo),
                "style": ref(style),
                "pathsource": pathsource,
                "strokePatternOffsetDistance": 0.0,
            },
            "deprecatedStorage": ref(storage),
            "ownedStorage": ref(storage),
            "isTextBox": text_box,
        }
        return self._attach(self.slide.add(pbtype, fields))

    def text_box(
        self,
        geo: dict[str, Any],
        text: "Storage",
        style: int,
        *,
        natural: tuple[float, float] | None = None,
        rounded: bool = False,
    ) -> int:
        """A text box; `natural` is Keynote's cached layout size, which a box
        sized to its text (stored 0×0, flags 0) carries in its path source."""
        w, h = natural or (geo["size"]["width"], geo["size"]["height"])
        source = scalar_source(w, h) if rounded else rect_source(w, h)
        return self.shape(geo, source, style, text=text, text_box=True)

    def placeholder(self, kind: str, geo: dict[str, Any], text: "Storage", style: int) -> int:
        """KN.PlaceholderArchive wrapping a text box ('kKindTitlePlaceholder')."""
        storage = text.build(self.slide)
        w, h = geo["size"]["width"], geo["size"]["height"]
        fields = {
            "super": {
                "super": {
                    "super": self._drawable(geo),
                    "style": ref(style),
                    "pathsource": rect_source(w, h),
                    "strokePatternOffsetDistance": 0.0,
                },
                "deprecatedStorage": ref(storage),
                "ownedStorage": ref(storage),
                "isTextBox": True,
            },
            "kind": kind,
        }
        return self._attach(self.slide.add("KN.PlaceholderArchive", fields))

    def image(
        self,
        geo: dict[str, Any],
        data: int | None,
        *,
        natural: tuple[float, float] | None = None,
        mask: tuple[float, float, float, float] | None = None,
        circle: bool = False,
        style: int | None = None,
        thumbnail: int | None = None,
        alpha_path: dict[str, Any] | None = None,
        alt: str | None = None,
    ) -> int:
        """TSD.ImageArchive. `mask` is (x, y, w, h) relative to the image's
        own origin, measured on the unflipped picture."""
        w, h = geo["size"]["width"], geo["size"]["height"]
        drawable = self._drawable(geo)
        if alt is not None:
            drawable["accessibilityDescription"] = alt
        fields: dict[str, Any] = {
            "super": drawable,
            "originalSize": size(w, h),
            "naturalSize": size(*(natural or (w, h))),
            "flags": 0,
        }
        if data is not None:
            fields["data"] = {"identifier": str(data)}
        if thumbnail is not None:
            fields["thumbnailData"] = {"identifier": str(thumbnail)}
        if style is not None:
            fields["style"] = ref(style)
        if alpha_path is not None:
            fields["instantAlphaPath"] = alpha_path
        image_id = self.slide.deck.new_id()
        if mask is not None:
            mx, my, mw, mh = mask
            shape_path = circle_path(mw, mh) if circle else rect_path(mw, mh)
            mask_id = self.slide.add(
                "TSD.MaskArchive",
                {
                    "super": {"geometry": geometry(mx, my, mw, mh), "parent": ref(image_id)},
                    "pathsource": bezier_source((mw, mh), shape_path),
                },
            )
            fields["mask"] = ref(mask_id)
        self.slide.deck.add(self.slide.stream, "TSD.ImageArchive", fields, identifier=image_id)
        return self._attach(image_id)

    def equation(
        self,
        geo: dict[str, Any],
        source: str,
        data: int,
        *,
        font_size: float = 60.0,
        colour: str = "#000000",
    ) -> int:
        """A floating equation (Insert > Equation, outside any text): a
        TSD.ImageArchive of Keynote's rendered PDF, with the source in the
        TSWP.EquationInfoArchive extensions."""
        fields = equation_fields(self._drawable(geo), source, data, font_size, colour)
        return self._attach(self.slide.add("TSD.ImageArchive", fields))

    def movie(
        self,
        geo: dict[str, Any],
        data: int | None,
        *,
        start: float = 0.0,
        end: float = 0.0,
        natural: tuple[float, float] = (1920, 1080),
        style: int | None = None,
    ) -> int:
        w, h = geo["size"]["width"], geo["size"]["height"]
        fields: dict[str, Any] = {
            "super": self._drawable(geo),
            "startTime": float(start),
            "endTime": float(end),
            "posterTime": 0.0,
            "volume": 1.0,
            "audioOnly": False,
            "flags": 0,
            "streaming": False,
            "originalSize": size(w, h),
            "naturalSize": size(*natural),
            "loopOption": "None",
        }
        if data is not None:
            fields["movieData"] = {"identifier": str(data)}
        if style is not None:
            fields["style"] = ref(style)
        return self._attach(self.slide.add("TSD.MovieArchive", fields))

    def connection(
        self,
        geo: dict[str, Any],
        points: list[tuple[float, float]],
        style: int,
        natural: tuple[float, float],
        *,
        kind: str = "kTSDConnectionLineTypeQuadratic",
    ) -> int:
        """TSD.ConnectionLineArchive: a two- or three-point polyline whose
        middle point, if any, is the curve's control point."""
        steps = [("M", *points[0])] + [("L", *p) for p in points[1:]]
        fields = {
            "super": {
                "super": self._drawable(geo),
                "style": ref(style),
                "pathsource": {
                    "horizontalFlip": False,
                    "verticalFlip": False,
                    "connectionLinePathSource": {
                        "super": {"naturalSize": size(*natural), "path": path(*steps)},
                        "type": kind,
                        "outsetFrom": 0.0,
                        "outsetTo": 0.0,
                    },
                },
                "strokePatternOffsetDistance": 0.0,
            }
        }
        return self._attach(self.slide.add("TSD.ConnectionLineArchive", fields))

    def group(self, geo: dict[str, Any]) -> "GroupBuilder":
        return GroupBuilder(self, geo)


class SlideBuilder(Container):
    """One slide: a KN.SlideArchive in its own Slide-<id>.iwa stream."""

    def __init__(self, deck: KeynoteBuilder, name: str, *, skipped: bool) -> None:
        self.deck = deck
        self.slide = self
        self.id = deck.new_id()
        self.container_id = self.id
        self.stream = f"Index/Slide-{self.id}.iwa"
        base = deck.base_slide
        fields: dict[str, Any] = {
            "style": base["style"],
            "templateSlide": base["templateSlide"],
            "inDocument": True,
            "ownedDrawables": [],
            "drawablesZOrder": [],
            "builds": [],
            "buildChunks": [],
            "transition": copy.deepcopy(base["transition"]),
            "name": name,
        }
        node_id = deck.new_id()
        node = copy.deepcopy(deck.base_node)
        node.pop("_pbtype", None)
        node.update({"slide": ref(self.id), "isSkipped": skipped, "hasBuilds": False, "thumbnailsAreDirty": True})
        deck.add("Index/Document.iwa", "KN.SlideNodeArchive", node, identifier=node_id)
        deck.show["slideTree"]["slides"].append(ref(node_id))
        self.node = deck.object(node_id)
        deck.add(self.stream, "KN.SlideArchive", fields, identifier=self.id)
        self.archive = deck.object(self.id)
        deck.metadata["components"].append(
            {
                "identifier": str(self.id),
                "preferredLocator": "Slide",
                "locator": f"Slide-{self.id}",
                "documentReadVersion": [2, 0, 0],
                "documentWriteVersion": [2, 0, 0],
                "externalReferences": [
                    {"componentIdentifier": str(deck.stylesheet), "isWeak": True},
                    {"componentIdentifier": base["templateSlide"]["identifier"]},
                ],
                "isStoredOutsideObjectArchive": False,
            }
        )

    def add(self, pbtype: str, fields: dict[str, Any]) -> int:
        """An object owned by this slide (not itself placed on it)."""
        return self.deck.add(self.stream, pbtype, fields)

    def inline_equation(
        self, source: str, data: int, size: tuple[float, float], *, font_size: float = 60.0
    ) -> int:
        """An equation typed into a text box. The text holds U+FFFC where it
        sits; the storage's attachment table points that index at a
        TSWP.DrawableAttachmentArchive, whose drawable is the equation image.
        Returns the attachment's id, for `Storage(attachments=…)`."""
        drawable = {"geometry": geometry(0, 0, *size)}
        image = self.add("TSD.ImageArchive", equation_fields(drawable, source, data, font_size, "#000000"))
        return self.add(
            "TSWP.DrawableAttachmentArchive",
            {"drawable": ref(image), "hOffsetType": 0, "hOffset": 0.0, "vOffsetType": 0, "vOffset": 0.0},
        )

    def number_field(self, kind: str = "kKindPageNumber", *, legacy: bool = False) -> int:
        """A number field typed into a text box (Insert > Slide Number): a
        U+FFFC in the text whose attachment is a TSWP.NumberAttachmentArchive
        (`kind` kKindPageNumber is the slide number), or with `legacy` the
        KN.SlideNumberAttachmentArchive older Keynote wrote. Returns the
        attachment's id, for `Storage(attachments=…)`."""
        textual = {"stringEquivalent": "", "kind": kind}
        if legacy:
            return self.add("KN.SlideNumberAttachmentArchive", {"super": textual})
        return self.add(
            "TSWP.NumberAttachmentArchive",
            {"super": textual, "numberFormat": 0, "numberFormatName": "decimal"},
        )

    def _attach(self, drawable_id: int) -> int:
        self.archive["ownedDrawables"].append(ref(drawable_id))
        self.archive["drawablesZOrder"].append(ref(drawable_id))
        return drawable_id

    def z_order(self, drawable_ids: list[int]) -> None:
        self.archive["drawablesZOrder"] = [ref(i) for i in drawable_ids]

    def set_title(self, drawable_id: int) -> None:
        self.archive["titlePlaceholder"] = ref(drawable_id)

    def set_body(self, drawable_id: int) -> None:
        self.archive["bodyPlaceholder"] = ref(drawable_id)

    def background(self, fill: dict) -> None:
        self.archive["style"] = ref(self.deck.slide_style(fill))

    def notes(self, text: str) -> None:
        notes_style = self.deck.style_by_name("TSWP.ParagraphStyleArchive", "Presenter Notes")
        storage = Storage(text, paras=[(0, notes_style)], kind="NOTE").build(self)
        self.archive["note"] = ref(self.add("KN.NoteArchive", {"containedStorage": ref(storage)}))
        self.node["hasNote"] = True

    def build(
        self,
        drawable_id: int,
        kind: str,
        *,
        automatic: bool = False,
        delay: float = 0.0,
        duration: float = 0.5,
        motion: tuple[float, float] | None = None,
        legacy: bool = False,
    ) -> None:
        """A build: kind 'In', 'Out', or 'Action' with a motion (dx, dy).

        `legacy=True` lists the build without a chunk, the way decks from
        before build chunks store them.
        """
        effect = {"In": "apple:dissolve", "Out": "apple:dissolve", "Action": "apple:action-motion-path"}[kind]
        attributes: dict[str, Any] = {
            "eventTrigger": 1,
            "animationAttributes": {
                "animationType": kind,
                "effect": effect,
                "duration": float(duration),
                "delay": 0.0,
                "randomNumberSeed": 1,
                "writingDirectionIsRtl": False,
            },
        }
        if motion is not None:
            dx, dy = motion
            attributes["actionMotionPathSource"] = {
                "horizontalFlip": False,
                "verticalFlip": False,
                "editableBezierPathSource": {
                    "subpaths": [
                        {
                            "nodes": [
                                {"inControlPoint": point(0, 0), "nodePoint": point(0, 0), "outControlPoint": point(0, 0), "type": "sharp"},
                                {"inControlPoint": point(dx, dy), "nodePoint": point(dx, dy), "outControlPoint": point(dx, dy), "type": "sharp"},
                            ],
                            "closed": False,
                        }
                    ],
                    "naturalSize": size(abs(dx) or 1, abs(dy) or 1),
                },
            }
        build_id = self.add(
            "KN.BuildArchive",
            {"drawable": ref(drawable_id), "delivery": "All at Once", "duration": float(duration), "attributes": attributes, "chunkIdSeed": 1},
        )
        self.archive["builds"].append(ref(build_id))
        self.node["hasBuilds"] = True
        if legacy:
            return
        chunk_id = self.add(
            "KN.BuildChunkArchive",
            {"build": ref(build_id), "delay": float(delay), "duration": float(duration), "automatic": automatic, "referent": True},
        )
        self.archive["buildChunks"].append(ref(chunk_id))


class GroupBuilder(Container):
    """TSD.GroupArchive; its children are stored in its own coordinates."""

    def __init__(self, parent: Container, geo: dict[str, Any]) -> None:
        self.slide = parent.slide
        self.container_id = self.slide.deck.new_id()
        self.fields = {"super": parent._drawable(geo), "children": []}
        self.slide.deck.add(self.slide.stream, "TSD.GroupArchive", self.fields, identifier=self.container_id)
        self.fields = self.slide.deck.object(self.container_id)
        self.id = parent._attach(self.container_id)

    def _attach(self, drawable_id: int) -> int:
        self.fields["children"].append(ref(drawable_id))
        return drawable_id


class Storage:
    """TSWP.StorageArchive contents: one text, and attribute tables keyed by
    character index. Entries are (index, object id or None), where None in the
    paragraph table continues the previous style."""

    def __init__(
        self,
        text: str,
        *,
        paras: list[tuple[int, int | None]] | None = None,
        chars: list[tuple[int, int | None]] = (),
        lists: list[tuple[int, int | None]] = (),
        levels: list[tuple[int, int]] = (),
        starts: list[tuple[int, int]] = (),
        chunks: list[str] | None = None,
        kind: str | None = None,
        attachments: list[tuple[int, int]] = (),
    ) -> None:
        """`attachments` are (index of a U+FFFC in `text`, attachment id)."""
        self.text = text
        self.paras = paras
        self.attachments = list(attachments)
        self.chars = list(chars)
        self.lists = list(lists)
        self.levels = list(levels) or [(0, 0)]
        self.starts = list(starts) or [(0, 0)]
        self.chunks = chunks
        self.kind = kind

    @staticmethod
    def _table(pairs: Iterable[tuple[int, int | None]]) -> dict[str, Any]:
        entries = []
        for index, identifier in pairs:
            entry: dict[str, Any] = {"characterIndex": index}
            if identifier is not None:
                entry["object"] = ref(identifier)
            entries.append(entry)
        return {"entries": entries}

    def build(self, slide: SlideBuilder) -> int:
        deck = slide.deck
        paras = self.paras or [(0, deck.style_by_name("TSWP.ParagraphStyleArchive", "Body"))]
        lists = self.lists or [(0, deck.style_by_name("TSWP.ListStyleArchive", "None"))]
        fields: dict[str, Any] = {
            "styleSheet": ref(deck.stylesheet),
            "tableParaStyle": self._table(paras),
            "tableListStyle": self._table(lists),
            "tableParaData": {"entries": [{"characterIndex": i, "first": v, "second": 0} for i, v in self.levels]},
            "tableParaStarts": {"entries": [{"characterIndex": i, "first": v, "second": 0} for i, v in self.starts]},
            "tableParaBidi": {"entries": [{"characterIndex": 0, "first": 0, "second": 0}]},
            "inDocument": True,
        }
        chunks = self.chunks if self.chunks is not None else ([self.text] if self.text else [])
        if chunks:
            fields["text"] = chunks
        if self.chars:
            fields["tableCharStyle"] = self._table(self.chars)
        if self.kind:
            fields["kind"] = self.kind
        if self.attachments:
            fields["tableAttachment"] = self._table(self.attachments)
        storage = slide.add("TSWP.StorageArchive", fields)
        # An inline drawable's parent is the storage it sits in.
        for _, attachment in self.attachments:
            if "drawable" not in deck.object(attachment):
                continue  # a field (a slide number), not a placed object
            drawable = deck.object(int(deck.object(attachment)["drawable"]["identifier"]))
            drawable["super"]["parent"] = ref(storage)
        return storage

