#!/usr/bin/env python3
"""Import a PowerPoint .pptx file into a slide-editor deck folder.

This runs entirely in Python against the on-disk format. It never asks
PowerPoint, LibreOffice or any platform framework for anything, which is what
lets the same importer run unchanged on macOS, Linux and Windows.

A .pptx file is an Open Packaging Convention zip of OOXML parts: DrawingML for
the shapes, PresentationML for slides, layouts and masters. Everything needed
to decode it is in the standard library (zipfile and ElementTree); Pillow is
used opportunistically to re-encode raster formats a browser cannot display.

The overriding design rule — shared with the Keynote importer — is that
**import must never fail outright**. Every shape is converted inside a guard:
anything unrecognised or malformed becomes an `unsupported` placeholder that
keeps its original geometry, so the slide still lays out correctly and the gap
is visible instead of silent. `--report` prints what was skipped, which is how
coverage gets measured against real decks.

The process contract is identical to the Keynote sidecar: stdout carries one
JSON document (`{dir, report, deck}`), stderr carries diagnostics plus
`@progress <ratio|-> <message>` phase lines that the host lifts into its UI.

Usage:
    import_pptx.py deck.pptx --out /path/to/output-deck
    import_pptx.py deck.pptx --report
"""

from __future__ import annotations

import argparse
import html
import io
import json
import math
import os
import posixpath
import re
import shutil
import subprocess
import sys
import traceback
import warnings
import zipfile
from collections import Counter
from contextlib import redirect_stdout
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Iterable
from xml.etree import ElementTree as ET

warnings.simplefilter("ignore")

# How the reported 0..1 completion is divided between the import's phases.
OPEN_SPAN = (0.0, 0.04)
LOAD_SPAN = (0.04, 0.30)
SLIDE_SPAN = (0.30, 0.94)

# Chromium cannot decode these, so they are converted to PNG on the way in.
RASTER_CONVERT = {".tiff", ".tif", ".bmp", ".tga", ".heic", ".heif", ".emf", ".wmf"}
WEB_SAFE_IMAGE = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".avif"}
VIDEO_EXTS = {".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi", ".wmv", ".mpg", ".mpeg", ".m4a", ".asf"}
AUDIO_EXTS = {".mp3", ".wav", ".aac", ".flac", ".ogg", ".wma"}
ANIMATED_IMAGE_EXTS = {".gif", ".apng", ".webp"}
# Codecs Chromium can decode on both macOS and Linux. Anything else is
# transcoded on import, or it renders as a black rectangle.
WEB_SAFE_VIDEO_CODECS = {"h264", "vp8", "vp9", "av1", "theora"}

# The deck canvas is always 1920 wide; the height follows the slide's aspect.
CANVAS_WIDTH = 1920.0
EMU_PER_INCH = 914400
EMU_PER_PT = 12700
# PowerPoint's single line spacing is roughly 1.2 times the font size.
SINGLE_LINE_HEIGHT = 1.2
DEFAULT_FONT_SIZE_PT = 18.0
# Shown in an empty imported placeholder, mirroring what PowerPoint displays.
PLACEHOLDER_TEXT = "Text"

NS = {
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    "p": "http://schemas.openxmlformats.org/presentationml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "mc": "http://schemas.openxmlformats.org/markup-compatibility/2006",
    "p14": "http://schemas.microsoft.com/office/powerpoint/2010/main",
    "asvg": "http://schemas.microsoft.com/office/drawing/2016/SVG/main",
    "rel": "http://schemas.openxmlformats.org/package/2006/relationships",
    "ct": "http://schemas.openxmlformats.org/package/2006/content-types",
}
R_ID = f"{{{NS['r']}}}id"
R_EMBED = f"{{{NS['r']}}}embed"
R_LINK = f"{{{NS['r']}}}link"

REL_SLIDE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide"
REL_LAYOUT = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout"
REL_MASTER = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster"
REL_THEME = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme"
REL_NOTES = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide"


def q(name: str) -> str:
    """`a:off` -> `{namespace}off`, the form ElementTree wants."""
    prefix, _, local = name.partition(":")
    return f"{{{NS[prefix]}}}{local}"


def child(elem: ET.Element | None, *path: str) -> ET.Element | None:
    """The first element along a `a:x`/`a:y` path, or None."""
    current = elem
    for step in path:
        if current is None:
            return None
        current = current.find(q(step))
    return current


def first_child(elem: ET.Element | None, *paths: tuple[str, ...]) -> ET.Element | None:
    """The first path that resolves. ElementTree elements without children are
    falsy, so `a or b` on `<p:ph/>` silently picks the wrong branch."""
    for path in paths:
        found = child(elem, *path)
        if found is not None:
            return found
    return None


def children(elem: ET.Element | None, name: str) -> list[ET.Element]:
    return [] if elem is None else elem.findall(q(name))


def local(elem: ET.Element) -> str:
    return elem.tag.rsplit("}", 1)[-1]


def attr_int(elem: ET.Element | None, name: str, default: int | None = None) -> int | None:
    if elem is None:
        return default
    raw = elem.get(name)
    if raw is None:
        return default
    try:
        return int(raw)
    except ValueError:
        try:
            return int(float(raw))
        except ValueError:
            return default


def attr_bool(elem: ET.Element | None, name: str, default: bool = False) -> bool:
    if elem is None:
        return default
    raw = elem.get(name)
    if raw is None:
        return default
    return raw in ("1", "true")


@dataclass
class Report:
    """What the importer managed to do, and what it didn't."""

    slides: int = 0
    elements: int = 0
    unsupported: Counter = field(default_factory=Counter)
    converted_images: int = 0
    cropped_images: int = 0
    transcoded_videos: int = 0
    autosized_boxes: int = 0
    warnings: list[str] = field(default_factory=list)
    _seen_warnings: set[str] = field(default_factory=set)

    def warn(self, message: str) -> None:
        self.warnings.append(message)

    def warn_once(self, message: str) -> None:
        """A per-deck warning: one line, however many shapes trip it."""
        if message in self._seen_warnings:
            return
        self._seen_warnings.add(message)
        self.warnings.append(message)

    def to_dict(self) -> dict[str, Any]:
        return {
            "slides": self.slides,
            "elements": self.elements,
            "unsupported": dict(self.unsupported),
            "converted_images": self.converted_images,
            "cropped_images": self.cropped_images,
            "transcoded_videos": self.transcoded_videos,
            "autosized_boxes": self.autosized_boxes,
            "warnings": self.warnings[:200],
        }


class Progress:
    """Reports the phase the import is currently in, for the host app's UI.

    stdout is the machine-readable JSON channel and stderr the diagnostic one,
    so progress claims a line protocol on stderr — the same one the Keynote
    sidecar speaks, so the Electron side needs no second reader.
    """

    MARKER = "@progress"

    def __init__(self, stream: Any = None) -> None:
        self._stream = stream
        self._ratio: float | None = None

    def phase(self, message: str, ratio: float | None = None) -> None:
        if ratio is not None:
            self._ratio = ratio
        self.emit(message)

    def step(self, message: str, done: int, total: int, span: tuple[float, float]) -> None:
        low, high = span
        self._ratio = low + (high - low) * (done / total) if total else low
        self.emit(message)

    def stride(self, total: int, updates: int = 120) -> int:
        return max(1, total // updates)

    def emit(self, message: str) -> None:
        ratio = "-" if self._ratio is None else f"{min(max(self._ratio, 0.0), 1.0):.4f}"
        stream = self._stream if self._stream is not None else sys.stderr
        stream.write(f"{self.MARKER} {ratio} {message}\n")
        stream.flush()


class SilentProgress(Progress):
    def emit(self, message: str) -> None:
        return


def _human_bytes(count: float) -> str:
    for unit in ("bytes", "KB", "MB", "GB"):
        if count < 1024 or unit == "GB":
            return f"{count:.0f} {unit}" if unit == "bytes" else f"{count:.1f} {unit}"
        count /= 1024
    raise AssertionError("unreachable: the loop returns on its last unit")


def _safe_name(name: str) -> str:
    keep = "".join(c if c.isalnum() or c in "._-" else "-" for c in name)
    return keep.strip("-") or "asset"


# --- the package ------------------------------------------------------------


class Package:
    """Read-only access to the OPC zip, with relationship resolution."""

    def __init__(self, path: Path):
        self.path = path
        self._zip = zipfile.ZipFile(path)
        self.names = set(self._zip.namelist())
        self._xml_cache: dict[str, ET.Element] = {}
        self._rels_cache: dict[str, dict[str, tuple[str, str, bool]]] = {}

    def close(self) -> None:
        self._zip.close()

    def read(self, name: str) -> bytes:
        return self._zip.read(name)

    def has(self, name: str) -> bool:
        return name in self.names

    def xml(self, name: str) -> ET.Element:
        cached = self._xml_cache.get(name)
        if cached is None:
            cached = ET.fromstring(self.read(name))
            self._xml_cache[name] = cached
        return cached

    def rels(self, part: str) -> dict[str, tuple[str, str, bool]]:
        """`rId -> (absolute target, relationship type, external)` for a part."""
        cached = self._rels_cache.get(part)
        if cached is not None:
            return cached
        directory, base = posixpath.split(part)
        rels_name = posixpath.join(directory, "_rels", base + ".rels")
        table: dict[str, tuple[str, str, bool]] = {}
        if rels_name in self.names:
            root = ET.fromstring(self.read(rels_name))
            for rel in root:
                rid = rel.get("Id")
                target = rel.get("Target")
                if not rid or not target:
                    continue
                external = rel.get("TargetMode") == "External"
                if not external:
                    if target.startswith("/"):
                        target = target[1:]
                    else:
                        target = posixpath.normpath(posixpath.join(directory, target))
                table[rid] = (target, rel.get("Type", ""), external)
        self._rels_cache[part] = table
        return table

    def related(self, part: str, rel_type: str) -> list[str]:
        return [target for target, kind, external in self.rels(part).values()
                if kind == rel_type and not external]

    def target(self, part: str, rid: str | None) -> tuple[str, bool] | None:
        if not rid:
            return None
        entry = self.rels(part).get(rid)
        if entry is None:
            return None
        return entry[0], entry[2]


# --- colour -----------------------------------------------------------------


def _clamp_byte(value: float) -> int:
    return max(0, min(255, int(round(value))))


def _rgb_to_hsl(r: float, g: float, b: float) -> tuple[float, float, float]:
    r, g, b = r / 255, g / 255, b / 255
    high, low = max(r, g, b), min(r, g, b)
    lum = (high + low) / 2
    if high == low:
        return 0.0, 0.0, lum
    delta = high - low
    sat = delta / (2 - high - low) if lum > 0.5 else delta / (high + low)
    if high == r:
        hue = (g - b) / delta + (6 if g < b else 0)
    elif high == g:
        hue = (b - r) / delta + 2
    else:
        hue = (r - g) / delta + 4
    return hue / 6, sat, lum


def _hsl_to_rgb(h: float, s: float, lum: float) -> tuple[float, float, float]:
    if s == 0:
        v = lum * 255
        return v, v, v

    def channel(p: float, qq: float, t: float) -> float:
        t %= 1
        if t < 1 / 6:
            return p + (qq - p) * 6 * t
        if t < 1 / 2:
            return qq
        if t < 2 / 3:
            return p + (qq - p) * (2 / 3 - t) * 6
        return p

    qq = lum * (1 + s) if lum < 0.5 else lum + s - lum * s
    p = 2 * lum - qq
    return channel(p, qq, h + 1 / 3) * 255, channel(p, qq, h) * 255, channel(p, qq, h - 1 / 3) * 255


PRESET_COLORS = {
    "black": "000000", "white": "FFFFFF", "red": "FF0000", "green": "008000",
    "blue": "0000FF", "yellow": "FFFF00", "gray": "808080", "grey": "808080",
    "silver": "C0C0C0", "orange": "FFA500", "purple": "800080", "navy": "000080",
    "teal": "008080", "maroon": "800000", "lime": "00FF00", "aqua": "00FFFF",
    "cyan": "00FFFF", "magenta": "FF00FF", "fuchsia": "FF00FF", "olive": "808000",
    "darkGray": "A9A9A9", "darkGrey": "A9A9A9", "lightGray": "D3D3D3",
    "lightGrey": "D3D3D3", "dimGray": "696969", "dimGrey": "696969",
    "darkBlue": "00008B", "darkRed": "8B0000", "darkGreen": "006400",
    "gold": "FFD700", "brown": "A52A2A", "pink": "FFC0CB", "violet": "EE82EE",
}


@dataclass
class ColorContext:
    """What a scheme colour name means on this slide."""

    theme_colors: dict[str, str]
    clr_map: dict[str, str]
    # The colour a theme style's `phClr` placeholder stands for.
    ph_color: tuple[str, float] | None = None


def resolve_color(elem: ET.Element | None, ctx: ColorContext) -> tuple[str, float] | None:
    """A DrawingML colour choice -> (`#rrggbb`, alpha 0..1), or None."""
    if elem is None:
        return None
    kind = local(elem)
    hex6: str | None = None
    alpha = 1.0
    if kind == "srgbClr":
        hex6 = (elem.get("val") or "").strip()
    elif kind == "schemeClr":
        name = elem.get("val") or ""
        if name == "phClr":
            if ctx.ph_color is None:
                return None
            hex6, alpha = ctx.ph_color[0].lstrip("#"), ctx.ph_color[1]
        else:
            mapped = ctx.clr_map.get(name, name)
            hex6 = ctx.theme_colors.get(mapped) or ctx.theme_colors.get(name)
    elif kind == "sysClr":
        hex6 = elem.get("lastClr") or ("000000" if elem.get("val") == "windowText" else "FFFFFF")
    elif kind == "prstClr":
        hex6 = PRESET_COLORS.get(elem.get("val") or "")
    elif kind == "scrgbClr":
        try:
            r = int(elem.get("r", "0")) / 100000 * 255
            g = int(elem.get("g", "0")) / 100000 * 255
            b = int(elem.get("b", "0")) / 100000 * 255
            hex6 = f"{_clamp_byte(r):02X}{_clamp_byte(g):02X}{_clamp_byte(b):02X}"
        except ValueError:
            return None
    elif kind == "hslClr":
        try:
            h = int(elem.get("hue", "0")) / 21600000
            s = int(elem.get("sat", "0")) / 100000
            lum = int(elem.get("lum", "0")) / 100000
            r, g, b = _hsl_to_rgb(h, s, lum)
            hex6 = f"{_clamp_byte(r):02X}{_clamp_byte(g):02X}{_clamp_byte(b):02X}"
        except ValueError:
            return None
    else:
        return None
    if not hex6 or len(hex6) < 6:
        return None
    hex6 = hex6[:6]
    try:
        r, g, b = (int(hex6[i:i + 2], 16) for i in (0, 2, 4))
    except ValueError:
        return None
    r, g, b, alpha = _apply_modifiers(elem, float(r), float(g), float(b), alpha)
    return f"#{_clamp_byte(r):02x}{_clamp_byte(g):02x}{_clamp_byte(b):02x}", alpha


def _apply_modifiers(
    elem: ET.Element, r: float, g: float, b: float, alpha: float
) -> tuple[float, float, float, float]:
    """Colour transforms in document order, as PowerPoint applies them."""
    for mod in elem:
        name = local(mod)
        raw = mod.get("val")
        try:
            value = int(raw) / 100000 if raw is not None else None
        except ValueError:
            value = None
        if name == "alpha" and value is not None:
            alpha = max(0.0, min(1.0, value))
        elif name == "tint" and value is not None:
            # Lighten towards white; PowerPoint works in linear light, which
            # this approximates well enough for fills and text.
            r, g, b = (255 - (255 - c) * value for c in (r, g, b))
        elif name == "shade" and value is not None:
            r, g, b = (c * value for c in (r, g, b))
        elif name in ("lumMod", "lumOff", "satMod", "satOff", "hueMod", "hueOff") and value is not None:
            h, s, lum = _rgb_to_hsl(r, g, b)
            if name == "lumMod":
                lum *= value
            elif name == "lumOff":
                lum += value
            elif name == "satMod":
                s *= value
            elif name == "satOff":
                s += value
            elif name == "hueMod":
                h = (h * value) % 1
            elif name == "hueOff":
                h = (h + int(raw or 0) / 21600000) % 1
            lum = max(0.0, min(1.0, lum))
            s = max(0.0, min(1.0, s))
            r, g, b = _hsl_to_rgb(h, s, lum)
        elif name == "comp":
            h, s, lum = _rgb_to_hsl(r, g, b)
            r, g, b = _hsl_to_rgb((h + 0.5) % 1, s, lum)
        elif name == "inv":
            r, g, b = 255 - r, 255 - g, 255 - b
        elif name == "gray":
            grey = 0.299 * r + 0.587 * g + 0.114 * b
            r, g, b = grey, grey, grey
    return r, g, b, alpha


def css_color(color: tuple[str, float] | None) -> str | None:
    """`(#hex, alpha)` as a CSS colour; hex when opaque, rgba otherwise."""
    if color is None:
        return None
    hex6, alpha = color
    if alpha >= 0.999:
        return hex6
    r, g, b = (int(hex6[i:i + 2], 16) for i in (1, 3, 5))
    return f"rgba({r}, {g}, {b}, {alpha:.3f})"


# --- fills and lines --------------------------------------------------------


@dataclass
class Fill:
    kind: str  # none | solid | gradient | image | pattern
    color: tuple[str, float] | None = None
    css: str | None = None
    blip: str | None = None  # rId of an image fill
    part: str | None = None  # the part that rId belongs to


FILL_TAGS = ("noFill", "solidFill", "gradFill", "blipFill", "pattFill", "grpFill")


def read_fill(parent: ET.Element | None, ctx: ColorContext, part: str | None = None) -> Fill | None:
    """The fill declared directly on `parent`, or None when it inherits."""
    if parent is None:
        return None
    for elem in parent:
        name = local(elem)
        if name not in FILL_TAGS:
            continue
        if name == "noFill":
            return Fill("none")
        if name == "solidFill":
            color = _first_color(elem, ctx)
            return Fill("solid", color) if color else Fill("none")
        if name == "gradFill":
            return _gradient_fill(elem, ctx)
        if name == "blipFill":
            blip = child(elem, "a:blip")
            return Fill("image", blip=blip.get(R_EMBED) if blip is not None else None, part=part)
        if name == "pattFill":
            fg = _first_color(child(elem, "a:fgClr"), ctx)
            bg = _first_color(child(elem, "a:bgClr"), ctx)
            return Fill("pattern", fg or bg)
        if name == "grpFill":
            return None
    return None


def _first_color(elem: ET.Element | None, ctx: ColorContext) -> tuple[str, float] | None:
    if elem is None:
        return None
    for candidate in elem:
        color = resolve_color(candidate, ctx)
        if color:
            return color
    return None


def _gradient_fill(elem: ET.Element, ctx: ColorContext) -> Fill:
    stops: list[tuple[float, tuple[str, float]]] = []
    for gs in children(child(elem, "a:gsLst"), "a:gs"):
        color = _first_color(gs, ctx)
        pos = attr_int(gs, "pos", 0) or 0
        if color:
            stops.append((pos / 100000, color))
    stops.sort(key=lambda s: s[0])
    if not stops:
        return Fill("none")
    angle = 90.0
    lin = child(elem, "a:lin")
    if lin is not None:
        ang = attr_int(lin, "ang", 0) or 0
        # DrawingML measures from the x axis clockwise; CSS from the top.
        angle = (ang / 60000 + 90) % 360
    parts = ", ".join(f"{css_color(c)} {p * 100:.1f}%" for p, c in stops)
    css = f"linear-gradient({angle:.0f}deg, {parts})"
    if child(elem, "a:path") is not None:
        css = f"radial-gradient(circle, {parts})"
    # The midpoint stop stands in wherever only one colour can be used.
    return Fill("gradient", stops[len(stops) // 2][1], css)


@dataclass
class Line:
    width_emu: int | None = None
    fill: Fill | None = None
    head: bool | None = None
    tail: bool | None = None
    dash: str | None = None

    def merge_from(self, other: "Line") -> None:
        if self.width_emu is None:
            self.width_emu = other.width_emu
        if self.fill is None:
            self.fill = other.fill
        if self.head is None:
            self.head = other.head
        if self.tail is None:
            self.tail = other.tail
        if self.dash is None:
            self.dash = other.dash


def read_line(ln: ET.Element | None, ctx: ColorContext) -> Line | None:
    if ln is None:
        return None
    line = Line(width_emu=attr_int(ln, "w"))
    line.fill = read_fill(ln, ctx)
    head = child(ln, "a:headEnd")
    tail = child(ln, "a:tailEnd")
    if head is not None:
        line.head = (head.get("type") or "none") != "none"
    if tail is not None:
        line.tail = (tail.get("type") or "none") != "none"
    dash = child(ln, "a:prstDash")
    if dash is not None:
        line.dash = dash.get("val")
    return line


# --- theme ------------------------------------------------------------------


@dataclass
class Theme:
    colors: dict[str, str]
    major_font: str
    minor_font: str
    fill_styles: list[ET.Element]
    line_styles: list[ET.Element]
    bg_fill_styles: list[ET.Element]

    @staticmethod
    def empty() -> "Theme":
        return Theme(
            colors={"dk1": "000000", "lt1": "FFFFFF", "dk2": "44546A", "lt2": "E7E6E6",
                    "accent1": "4472C4", "accent2": "ED7D31", "accent3": "A5A5A5",
                    "accent4": "FFC000", "accent5": "5B9BD5", "accent6": "70AD47",
                    "hlink": "0563C1", "folHlink": "954F72"},
            major_font="Calibri Light",
            minor_font="Calibri",
            fill_styles=[],
            line_styles=[],
            bg_fill_styles=[],
        )


def load_theme(pkg: Package, part: str | None) -> Theme:
    theme = Theme.empty()
    if part is None or not pkg.has(part):
        return theme
    root = pkg.xml(part)
    scheme = child(root, "a:themeElements", "a:clrScheme")
    if scheme is not None:
        for entry in scheme:
            name = local(entry)
            for candidate in entry:
                color = resolve_color(candidate, ColorContext(theme.colors, {}))
                if color:
                    theme.colors[name] = color[0].lstrip("#").upper()
                    break
    fonts = child(root, "a:themeElements", "a:fontScheme")
    major = child(fonts, "a:majorFont", "a:latin")
    minor = child(fonts, "a:minorFont", "a:latin")
    if major is not None and major.get("typeface"):
        theme.major_font = major.get("typeface") or theme.major_font
    if minor is not None and minor.get("typeface"):
        theme.minor_font = minor.get("typeface") or theme.minor_font
    fmt = child(root, "a:themeElements", "a:fmtScheme")
    theme.fill_styles = list(child(fmt, "a:fillStyleLst") or [])
    theme.line_styles = children(child(fmt, "a:lnStyleLst"), "a:ln")
    theme.bg_fill_styles = list(child(fmt, "a:bgFillStyleLst") or [])
    return theme


DEFAULT_CLR_MAP = {
    "bg1": "lt1", "tx1": "dk1", "bg2": "lt2", "tx2": "dk2",
    "accent1": "accent1", "accent2": "accent2", "accent3": "accent3",
    "accent4": "accent4", "accent5": "accent5", "accent6": "accent6",
    "hlink": "hlink", "folHlink": "folHlink",
}


def read_clr_map(elem: ET.Element | None, base: dict[str, str]) -> dict[str, str]:
    if elem is None:
        return dict(base)
    mapping = dict(base)
    for key, value in elem.attrib.items():
        mapping[key] = value
    return mapping


# --- text styling -----------------------------------------------------------


@dataclass
class RunStyle:
    size_pt: float | None = None
    bold: bool | None = None
    italic: bool | None = None
    underline: bool | None = None
    strike: bool | None = None
    font: str | None = None
    color: tuple[str, float] | None = None
    gradient: str | None = None
    baseline: int | None = None

    def fill_from(self, other: "RunStyle") -> None:
        for name in ("size_pt", "bold", "italic", "underline", "strike", "font", "color", "gradient", "baseline"):
            if getattr(self, name) is None and getattr(other, name) is not None:
                setattr(self, name, getattr(other, name))


def read_run_props(rpr: ET.Element | None, ctx: ColorContext) -> RunStyle:
    """Properties set on one `a:rPr`/`a:defRPr`/`a:endParaRPr`."""
    style = RunStyle()
    if rpr is None:
        return style
    sz = attr_int(rpr, "sz")
    if sz:
        style.size_pt = sz / 100
    if rpr.get("b") is not None:
        style.bold = attr_bool(rpr, "b")
    if rpr.get("i") is not None:
        style.italic = attr_bool(rpr, "i")
    if rpr.get("u") is not None:
        style.underline = rpr.get("u") not in ("none",)
    if rpr.get("strike") is not None:
        style.strike = rpr.get("strike") not in ("noStrike",)
    baseline = attr_int(rpr, "baseline")
    if baseline:
        style.baseline = baseline
    latin = child(rpr, "a:latin")
    if latin is not None and latin.get("typeface"):
        style.font = latin.get("typeface")
    fill = read_fill(rpr, ctx)
    if fill is not None:
        if fill.kind == "solid":
            style.color = fill.color
        elif fill.kind == "gradient":
            style.gradient = fill.css
            style.color = fill.color
    return style


@dataclass
class ParaStyle:
    align: str | None = None
    level: int = 0
    bullet: str | None = None  # None (inherit) | "none" | "char" | "num"
    margin_left_emu: int | None = None
    indent_emu: int | None = None
    line_spacing_pct: float | None = None
    line_spacing_pt: float | None = None
    space_before_pt: float | None = None
    space_after_pt: float | None = None
    # Spacing given as a fraction of the font size rather than in points.
    space_before_pct: float | None = None
    space_after_pct: float | None = None
    default_run: RunStyle = field(default_factory=RunStyle)

    def fill_from(self, other: "ParaStyle") -> None:
        for name in ("align", "bullet", "margin_left_emu", "indent_emu", "line_spacing_pct",
                     "line_spacing_pt", "space_before_pt", "space_after_pt",
                     "space_before_pct", "space_after_pct"):
            if getattr(self, name) is None and getattr(other, name) is not None:
                setattr(self, name, getattr(other, name))
        self.default_run.fill_from(other.default_run)


def read_para_props(ppr: ET.Element | None, ctx: ColorContext) -> ParaStyle:
    """Properties on one `a:pPr`/`a:lvlNpPr`/`a:defPPr`."""
    style = ParaStyle()
    if ppr is None:
        return style
    algn = ppr.get("algn")
    if algn:
        style.align = {"l": "left", "ctr": "center", "r": "right", "just": "justify",
                       "justLow": "justify", "dist": "justify", "thaiDist": "justify"}.get(algn)
    style.margin_left_emu = attr_int(ppr, "marL")
    style.indent_emu = attr_int(ppr, "indent")
    for elem in ppr:
        name = local(elem)
        if name == "buNone":
            style.bullet = "none"
        elif name in ("buChar", "buBlip"):
            style.bullet = "char"
        elif name == "buAutoNum":
            style.bullet = "num"
        elif name == "lnSpc":
            pct = child(elem, "a:spcPct")
            pts = child(elem, "a:spcPts")
            if pct is not None and attr_int(pct, "val") is not None:
                style.line_spacing_pct = (attr_int(pct, "val") or 100000) / 100000
            elif pts is not None and attr_int(pts, "val") is not None:
                style.line_spacing_pt = (attr_int(pts, "val") or 0) / 100
        elif name in ("spcBef", "spcAft"):
            pts = child(elem, "a:spcPts")
            pct = child(elem, "a:spcPct")
            prefix = "space_before" if name == "spcBef" else "space_after"
            if pts is not None:
                setattr(style, f"{prefix}_pt", (attr_int(pts, "val") or 0) / 100)
                setattr(style, f"{prefix}_pct", 0.0)
            elif pct is not None:
                setattr(style, f"{prefix}_pct", (attr_int(pct, "val") or 0) / 100000)
                setattr(style, f"{prefix}_pt", 0.0)
        elif name == "defRPr":
            style.default_run = read_run_props(elem, ctx)
    return style


class TextInheritance:
    """The chain of list styles a paragraph resolves through.

    A run's own `rPr` wins, then its paragraph's `pPr`, then the shape's
    `lstStyle`, then the layout placeholder's, the master placeholder's, the
    master's `txStyles` (or the presentation's `defaultTextStyle` for text that
    is not in a placeholder), and finally the hard defaults PowerPoint itself
    falls back to. Each source is asked for its `lvlNpPr` for the paragraph's
    level; missing levels fall back to level 1 the way PowerPoint renders them.
    """

    def __init__(self, sources: list[ET.Element | None], ctx: ColorContext) -> None:
        self.sources = [s for s in sources if s is not None]
        self.ctx = ctx
        self._cache: dict[tuple[int, int], ParaStyle] = {}

    def level_style(self, source_index: int, level: int) -> ParaStyle:
        key = (source_index, level)
        cached = self._cache.get(key)
        if cached is not None:
            return cached
        source = self.sources[source_index]
        ppr = child(source, f"a:lvl{level + 1}pPr")
        if ppr is None and level > 0:
            # Undefined deeper levels inherit level 1 rather than nothing.
            ppr = child(source, "a:lvl1pPr")
        if ppr is None:
            ppr = child(source, "a:defPPr")
        style = read_para_props(ppr, self.ctx)
        self._cache[key] = style
        return style

    def resolve(self, para: ParaStyle) -> ParaStyle:
        """Fill every unset property of a paragraph's own style from the chain."""
        out = ParaStyle(level=para.level)
        out.fill_from(para)
        for index in range(len(self.sources)):
            out.fill_from(self.level_style(index, para.level))
        return out


# --- geometry ---------------------------------------------------------------


@dataclass
class Box:
    x: float
    y: float
    w: float
    h: float
    rot: float = 0.0
    flip_h: bool = False
    flip_v: bool = False

    def as_dict(self) -> dict[str, float]:
        return {"x": self.x, "y": self.y, "w": max(1.0, self.w), "h": max(1.0, self.h), "rot": self.rot}


@dataclass
class GroupTransform:
    """Maps a group's child coordinate space into its parent's."""

    off_x: float
    off_y: float
    ch_off_x: float
    ch_off_y: float
    scale_x: float
    scale_y: float
    rot: float
    flip_h: bool
    flip_v: bool
    # Group extent in parent space, for rotating children about its centre.
    ext_w: float
    ext_h: float

    def apply(self, box: Box) -> Box:
        x = self.off_x + (box.x - self.ch_off_x) * self.scale_x
        y = self.off_y + (box.y - self.ch_off_y) * self.scale_y
        w = box.w * self.scale_x
        h = box.h * self.scale_y
        rot = box.rot
        flip_h = box.flip_h
        flip_v = box.flip_v
        if self.flip_h:
            x = self.off_x + (self.off_x + self.ext_w - (x + w))
            rot = -rot
            flip_h = not flip_h
        if self.flip_v:
            y = self.off_y + (self.off_y + self.ext_h - (y + h))
            rot = -rot
            flip_v = not flip_v
        if abs(self.rot) > 0.001:
            # Rotate the child's centre about the group's centre, then turn the
            # child itself by the same amount.
            gcx = self.off_x + self.ext_w / 2
            gcy = self.off_y + self.ext_h / 2
            ccx = x + w / 2
            ccy = y + h / 2
            theta = math.radians(self.rot)
            dx, dy = ccx - gcx, ccy - gcy
            ncx = gcx + dx * math.cos(theta) - dy * math.sin(theta)
            ncy = gcy + dx * math.sin(theta) + dy * math.cos(theta)
            x = ncx - w / 2
            y = ncy - h / 2
            rot += self.rot
        return Box(x, y, w, h, _normalise_angle(rot), flip_h, flip_v)


def _normalise_angle(degrees: float) -> float:
    wrapped = degrees % 360.0
    if wrapped > 180.0:
        wrapped -= 360.0
    return round(wrapped, 2)


def read_xfrm(xfrm: ET.Element | None, scale: float) -> Box | None:
    """`a:xfrm` -> canvas box. Rotation is clockwise in both systems."""
    if xfrm is None:
        return None
    off = child(xfrm, "a:off")
    ext = child(xfrm, "a:ext")
    if off is None or ext is None:
        return None
    x = (attr_int(off, "x", 0) or 0) * scale
    y = (attr_int(off, "y", 0) or 0) * scale
    w = (attr_int(ext, "cx", 0) or 0) * scale
    h = (attr_int(ext, "cy", 0) or 0) * scale
    rot = (attr_int(xfrm, "rot", 0) or 0) / 60000
    return Box(x, y, w, h, _normalise_angle(rot), attr_bool(xfrm, "flipH"), attr_bool(xfrm, "flipV"))


# --- preset geometry --------------------------------------------------------

Point = tuple[float, float]


def _fmt(points: Iterable[Point], close: bool = True) -> str:
    coords = list(points)
    if not coords:
        return ""
    out = [f"M {coords[0][0]:.2f} {coords[0][1]:.2f}"]
    out.extend(f"L {x:.2f} {y:.2f}" for x, y in coords[1:])
    if close:
        out.append("Z")
    return " ".join(out)


def _adj(adjustments: dict[str, float], name: str, default: float) -> float:
    return adjustments.get(name, default)


def _arc_path(
    cx: float, cy: float, rx: float, ry: float, start_deg: float, sweep_deg: float,
    move: bool = True,
) -> str:
    """An elliptical arc as cubic Béziers, so path data stays M/L/C/Z only.

    DrawingML angles grow clockwise in screen space, the same direction the
    y-down canvas turns, so no sign flip is needed here.
    """
    segments = max(1, int(math.ceil(abs(sweep_deg) / 90.0)))
    step = math.radians(sweep_deg / segments)
    theta = math.radians(start_deg)
    k = 4 / 3 * math.tan(step / 4)
    parts: list[str] = []
    x0 = cx + rx * math.cos(theta)
    y0 = cy + ry * math.sin(theta)
    if move:
        parts.append(f"M {x0:.2f} {y0:.2f}")
    for _ in range(segments):
        cos1, sin1 = math.cos(theta), math.sin(theta)
        theta2 = theta + step
        cos2, sin2 = math.cos(theta2), math.sin(theta2)
        c1 = (cx + rx * (cos1 - k * sin1), cy + ry * (sin1 + k * cos1))
        c2 = (cx + rx * (cos2 + k * sin2), cy + ry * (sin2 - k * cos2))
        end = (cx + rx * cos2, cy + ry * sin2)
        parts.append(f"C {c1[0]:.2f} {c1[1]:.2f} {c2[0]:.2f} {c2[1]:.2f} {end[0]:.2f} {end[1]:.2f}")
        theta = theta2
    return " ".join(parts)


def preset_path(prst: str, w: float, h: float, adj: dict[str, float]) -> str | None:
    """SVG path data for a preset geometry, drawn in a `w` x `h` box.

    Only the presets that appear in real decks are drawn exactly; a preset
    this table does not know returns None and the caller approximates it.
    Adjustment values are in DrawingML's 1/100000 units of the shorter side.
    """
    ss = min(w, h)
    if prst in ("triangle", "flowChartExtract"):
        top = _adj(adj, "adj", 50000) / 100000 * w
        return _fmt([(top, 0), (w, h), (0, h)])
    if prst == "rtTriangle":
        return _fmt([(0, 0), (w, h), (0, h)])
    if prst in ("diamond", "flowChartDecision"):
        return _fmt([(w / 2, 0), (w, h / 2), (w / 2, h), (0, h / 2)])
    if prst == "parallelogram":
        d = _adj(adj, "adj", 25000) / 100000 * ss
        return _fmt([(d, 0), (w, 0), (w - d, h), (0, h)])
    if prst == "trapezoid":
        d = _adj(adj, "adj", 25000) / 100000 * ss
        return _fmt([(d, 0), (w - d, 0), (w, h), (0, h)])
    if prst == "pentagon":
        return _fmt([(w / 2, 0), (w, 0.38 * h), (0.81 * w, h), (0.19 * w, h), (0, 0.38 * h)])
    if prst == "hexagon":
        d = _adj(adj, "adj", 25000) / 100000 * ss
        return _fmt([(d, 0), (w - d, 0), (w, h / 2), (w - d, h), (d, h), (0, h / 2)])
    if prst == "octagon":
        d = _adj(adj, "adj", 29289) / 100000 * ss
        return _fmt([(d, 0), (w - d, 0), (w, d), (w, h - d), (w - d, h), (d, h), (0, h - d), (0, d)])
    if prst in ("homePlate", "flowChartOffpageConnector"):
        d = _adj(adj, "adj", 50000) / 100000 * ss
        return _fmt([(0, 0), (w - d, 0), (w, h / 2), (w - d, h), (0, h)])
    if prst == "chevron":
        d = _adj(adj, "adj", 50000) / 100000 * ss
        return _fmt([(0, 0), (w - d, 0), (w, h / 2), (w - d, h), (0, h), (d, h / 2)])
    if prst in ("rightArrow", "leftArrow", "upArrow", "downArrow"):
        shaft = _adj(adj, "adj1", 50000) / 100000
        head = _adj(adj, "adj2", 50000) / 100000 * ss
        # Draw a right arrow in a normalised frame, then orient it.
        length, thick = (w, h) if prst in ("rightArrow", "leftArrow") else (h, w)
        head = min(head, length)
        half = thick * shaft / 2
        pts = [(0, thick / 2 - half), (length - head, thick / 2 - half), (length - head, 0),
               (length, thick / 2), (length - head, thick), (length - head, thick / 2 + half),
               (0, thick / 2 + half)]
        if prst == "leftArrow":
            pts = [(length - x, y) for x, y in pts]
        elif prst == "downArrow":
            pts = [(y, x) for x, y in pts]
        elif prst == "upArrow":
            pts = [(y, length - x) for x, y in pts]
        return _fmt(pts)
    if prst in ("leftRightArrow", "upDownArrow"):
        shaft = _adj(adj, "adj1", 50000) / 100000
        head = _adj(adj, "adj2", 50000) / 100000 * ss
        length, thick = (w, h) if prst == "leftRightArrow" else (h, w)
        head = min(head, length / 2)
        half = thick * shaft / 2
        pts = [(0, thick / 2), (head, 0), (head, thick / 2 - half), (length - head, thick / 2 - half),
               (length - head, 0), (length, thick / 2), (length - head, thick),
               (length - head, thick / 2 + half), (head, thick / 2 + half), (head, thick)]
        if prst == "upDownArrow":
            pts = [(y, x) for x, y in pts]
        return _fmt(pts)
    if prst in ("plus", "mathPlus"):
        d = _adj(adj, "adj", 25000 if prst == "plus" else 23520) / 100000 * ss
        if prst == "mathPlus":
            # mathPlus's adj is the arm thickness; centre the cross.
            arm = d
            return _fmt([((w - arm) / 2, 0), ((w + arm) / 2, 0), ((w + arm) / 2, (h - arm) / 2),
                         (w, (h - arm) / 2), (w, (h + arm) / 2), ((w + arm) / 2, (h + arm) / 2),
                         ((w + arm) / 2, h), ((w - arm) / 2, h), ((w - arm) / 2, (h + arm) / 2),
                         (0, (h + arm) / 2), (0, (h - arm) / 2), ((w - arm) / 2, (h - arm) / 2)])
        return _fmt([(d, 0), (w - d, 0), (w - d, d), (w, d), (w, h - d), (w - d, h - d), (w - d, h),
                     (d, h), (d, h - d), (0, h - d), (0, d), (d, d)])
    if prst == "mathMinus":
        arm = _adj(adj, "adj", 23520) / 100000 * h
        return _fmt([(0, (h - arm) / 2), (w, (h - arm) / 2), (w, (h + arm) / 2), (0, (h + arm) / 2)])
    if prst == "mathEqual":
        arm = _adj(adj, "adj1", 23520) / 100000 * h
        gap = _adj(adj, "adj2", 11760) / 100000 * h
        top = (h - gap) / 2 - arm
        return (_fmt([(0, top), (w, top), (w, top + arm), (0, top + arm)]) + " "
                + _fmt([(0, h - top - arm), (w, h - top - arm), (w, h - top), (0, h - top)]))
    if prst == "mathMultiply":
        arm = _adj(adj, "adj", 23520) / 100000 * ss
        # A rotated plus: two diagonal bars of thickness `arm`.
        t = arm / math.sqrt(2)
        return (_fmt([(0, t), (t, 0), (w, h - t), (w - t, h)]) + " "
                + _fmt([(w - t, 0), (w, t), (t, h), (0, h - t)]))
    if prst in ("star4", "star5", "star6", "star8", "star10", "star12", "star16", "star24", "star32"):
        n = int(prst[4:])
        inner = 0.38 if n == 5 else 0.5 if n <= 8 else 0.7
        pts: list[Point] = []
        for i in range(2 * n):
            radius = 1.0 if i % 2 == 0 else inner
            angle = -math.pi / 2 + i * math.pi / n
            pts.append((w / 2 + radius * w / 2 * math.cos(angle), h / 2 + radius * h / 2 * math.sin(angle)))
        return _fmt(pts)
    if prst == "arc":
        start = _adj(adj, "adj1", 16200000) / 60000
        end = _adj(adj, "adj2", 0) / 60000
        sweep = (end - start) % 360
        return _arc_path(w / 2, h / 2, w / 2, h / 2, start, sweep)
    if prst == "blockArc":
        start = _adj(adj, "adj1", 10800000) / 60000
        end = _adj(adj, "adj2", 0) / 60000
        thickness = _adj(adj, "adj3", 25000) / 100000 * ss
        sweep = (end - start) % 360
        outer = _arc_path(w / 2, h / 2, w / 2, h / 2, start, sweep)
        inner = _arc_path(w / 2, h / 2, w / 2 - thickness, h / 2 - thickness, start + sweep, -sweep, move=False)
        inner_start = (w / 2 + (w / 2 - thickness) * math.cos(math.radians(start + sweep)),
                       h / 2 + (h / 2 - thickness) * math.sin(math.radians(start + sweep)))
        return f"{outer} L {inner_start[0]:.2f} {inner_start[1]:.2f} {inner} Z"
    if prst == "donut":
        thickness = _adj(adj, "adj", 25000) / 100000 * ss
        outer = _arc_path(w / 2, h / 2, w / 2, h / 2, 0, 359.99) + " Z"
        inner = _arc_path(w / 2, h / 2, w / 2 - thickness, h / 2 - thickness, 0, -359.99) + " Z"
        return f"{outer} {inner}"
    if prst == "pie":
        start = _adj(adj, "adj1", 0) / 60000
        end = _adj(adj, "adj2", 16200000) / 60000
        sweep = (end - start) % 360
        return f"M {w / 2:.2f} {h / 2:.2f} L " + _arc_path(w / 2, h / 2, w / 2, h / 2, start, sweep)[2:] + " Z"
    if prst == "heart":
        return (f"M {w / 2:.2f} {h:.2f} C {-0.1 * w:.2f} {0.55 * h:.2f} {0.05 * w:.2f} {-0.15 * h:.2f} "
                f"{w / 2:.2f} {0.25 * h:.2f} C {0.95 * w:.2f} {-0.15 * h:.2f} {1.1 * w:.2f} {0.55 * h:.2f} "
                f"{w / 2:.2f} {h:.2f} Z")
    if prst in ("leftBracket", "rightBracket", "leftBrace", "rightBrace", "bracketPair", "bracePair"):
        r = min(_adj(adj, "adj", 8333 if "Bracket" in prst else 8333) / 100000 * ss, w / 2, h / 2)
        left = (f"M {r:.2f} 0 " + _arc_path(r, r, r, r, 270, -90, move=False)
                + f" L 0 {h - r:.2f} " + _arc_path(r, h - r, r, r, 180, -90, move=False))
        right = (f"M {w - r:.2f} 0 " + _arc_path(w - r, r, r, r, 270, 90, move=False)
                 + f" L {w:.2f} {h - r:.2f} " + _arc_path(w - r, h - r, r, r, 0, 90, move=False))
        if prst == "leftBracket":
            return left.replace(f"M {r:.2f} 0", f"M {w:.2f} 0 L {r:.2f} 0") + f" L {w:.2f} {h:.2f}"
        if prst == "rightBracket":
            return right.replace(f"M {w - r:.2f} 0", f"M 0 0 L {w - r:.2f} 0") + f" L 0 {h:.2f}"
        if prst == "bracketPair":
            return f"{left} {right}"
        # Braces: a bracket with a mid-point cusp.
        if prst == "leftBrace":
            return (f"M {w:.2f} 0 " + _arc_path(w, r, w / 2, r, 270, -90, move=False)
                    + f" L {w / 2:.2f} {h / 2 - r:.2f} " + _arc_path(0, h / 2 - r, w / 2, r, 0, 90, move=False)
                    + _arc_path(0, h / 2 + r, w / 2, r, 270, -90, move=False)
                    + f" L {w / 2:.2f} {h - r:.2f} " + _arc_path(w, h - r, w / 2, r, 180, -90, move=False))
        if prst == "rightBrace":
            return (f"M 0 0 " + _arc_path(0, r, w / 2, r, 270, 90, move=False)
                    + f" L {w / 2:.2f} {h / 2 - r:.2f} " + _arc_path(w, h / 2 - r, w / 2, r, 180, -90, move=False)
                    + _arc_path(w, h / 2 + r, w / 2, r, 270, 90, move=False)
                    + f" L {w / 2:.2f} {h - r:.2f} " + _arc_path(0, h - r, w / 2, r, 0, 90, move=False))
        return f"{left} {right}"
    if prst in ("wedgeRectCallout", "wedgeRoundRectCallout", "borderCallout1", "borderCallout2",
                "accentCallout1", "callout1", "callout2", "cloudCallout", "wedgeEllipseCallout"):
        # The callout body; its pointer tail is dropped.
        if prst in ("cloudCallout", "wedgeEllipseCallout"):
            return _arc_path(w / 2, h / 2, w / 2, h / 2, 0, 359.99) + " Z"
        return _fmt([(0, 0), (w, 0), (w, h), (0, h)])
    if prst in ("flowChartTerminator",):
        r = h / 2
        return (f"M {r:.2f} 0 L {w - r:.2f} 0 " + _arc_path(w - r, r, r, r, 270, 180, move=False)
                + f" L {r:.2f} {h:.2f} " + _arc_path(r, r, r, r, 90, 180, move=False) + " Z")
    if prst == "flowChartDocument":
        return (f"M 0 0 L {w:.2f} 0 L {w:.2f} {0.8 * h:.2f} C {0.75 * w:.2f} {0.65 * h:.2f} "
                f"{0.25 * w:.2f} {1.1 * h:.2f} 0 {0.85 * h:.2f} Z")
    if prst in ("cube",):
        d = _adj(adj, "adj", 25000) / 100000 * ss
        front = _fmt([(0, d), (w - d, d), (w - d, h), (0, h)])
        top = _fmt([(0, d), (d, 0), (w, 0), (w - d, d)])
        side = _fmt([(w - d, d), (w, 0), (w, h - d), (w - d, h)])
        return f"{front} {top} {side}"
    if prst in ("can",):
        d = _adj(adj, "adj", 25000) / 100000 * ss / 2
        body = (f"M 0 {d:.2f} L 0 {h - d:.2f} " + _arc_path(w / 2, h - d, w / 2, d, 180, -180, move=False)
                + f" L {w:.2f} {d:.2f} " + _arc_path(w / 2, d, w / 2, d, 0, -180, move=False) + " Z")
        lid = _arc_path(w / 2, d, w / 2, d, 0, 359.99) + " Z"
        return f"{body} {lid}"
    if prst in ("bentConnector3", "bentConnector2", "bentConnector4", "bentConnector5"):
        mid = _adj(adj, "adj1", 50000) / 100000 * w
        if prst == "bentConnector2":
            return _fmt([(0, 0), (w, 0), (w, h)], close=False)
        return _fmt([(0, 0), (mid, 0), (mid, h), (w, h)], close=False)
    if prst in ("curvedConnector3", "curvedConnector2", "curvedConnector4", "curvedConnector5"):
        mid = _adj(adj, "adj1", 50000) / 100000 * w
        if prst == "curvedConnector2":
            return f"M 0 0 C {w:.2f} 0 {w:.2f} 0 {w:.2f} {h:.2f}"
        return f"M 0 0 C {mid:.2f} 0 {mid:.2f} {h:.2f} {w:.2f} {h:.2f}"
    if prst in ("snip1Rect", "snip2SameRect", "snip2DiagRect", "snipRoundRect"):
        d = _adj(adj, "adj", 16667) / 100000 * ss
        if prst == "snip1Rect":
            return _fmt([(0, 0), (w - d, 0), (w, d), (w, h), (0, h)])
        if prst == "snip2SameRect":
            return _fmt([(d, 0), (w - d, 0), (w, d), (w, h), (0, h), (0, d)])
        if prst == "snip2DiagRect":
            return _fmt([(d, 0), (w, 0), (w, h - d), (w - d, h), (0, h), (0, d)])
        return _fmt([(d, 0), (w - d, 0), (w, d), (w, h), (0, h), (0, d)])
    if prst in ("noSmoking",):
        return _arc_path(w / 2, h / 2, w / 2, h / 2, 0, 359.99) + " Z"
    if prst == "frame":
        d = _adj(adj, "adj1", 12500) / 100000 * ss
        outer = _fmt([(0, 0), (w, 0), (w, h), (0, h)])
        inner = _fmt([(d, d), (d, h - d), (w - d, h - d), (w - d, d)])
        return f"{outer} {inner}"
    if prst == "corner":
        d = _adj(adj, "adj1", 50000) / 100000 * ss
        return _fmt([(0, 0), (d, 0), (d, h - d), (w, h - d), (w, h), (0, h)])
    if prst == "lightningBolt":
        return _fmt([(0.4 * w, 0), (0.7 * w, 0.35 * h), (0.55 * w, 0.4 * h), (w, h),
                     (0.35 * w, 0.55 * h), (0.5 * w, 0.5 * h), (0, 0.2 * h)])
    if prst in ("flowChartPreparation",):
        d = 0.2 * w
        return _fmt([(d, 0), (w - d, 0), (w, h / 2), (w - d, h), (d, h), (0, h / 2)])
    if prst in ("flowChartInputOutput", "flowChartData"):
        d = 0.2 * w
        return _fmt([(d, 0), (w, 0), (w - d, h), (0, h)])
    if prst in ("flowChartManualInput",):
        return _fmt([(0, 0.2 * h), (w, 0), (w, h), (0, h)])
    if prst in ("flowChartDelay",):
        return (f"M 0 0 L {w / 2:.2f} 0 " + _arc_path(w / 2, h / 2, w / 2, h / 2, 270, 180, move=False)
                + f" L 0 {h:.2f} Z")
    return None


# Presets that map onto native editor shapes rather than paths.
RECT_PRESETS = {"rect", "flowChartProcess", "flowChartPredefinedProcess", "flowChartInternalStorage",
                "actionButtonBlank", "plaque", "bevel", "flowChartPunchedCard"}
ROUND_RECT_PRESETS = {"roundRect", "round1Rect", "round2SameRect", "round2DiagRect", "flowChartAlternateProcess"}
ELLIPSE_PRESETS = {"ellipse", "flowChartConnector", "flowChartSummingJunction", "flowChartOr"}
LINE_PRESETS = {"line", "straightConnector1", "lineInv"}


def custom_geometry_path(cust: ET.Element, w: float, h: float) -> tuple[str, bool] | None:
    """`a:custGeom` -> (SVG path data in the `w` x `h` box, has_fill).

    Arcs are flattened to cubic curves so the data stays M/L/Q/C/Z, which the
    editor's own path handling understands.
    """
    paths = children(child(cust, "a:pathLst"), "a:path")
    if not paths:
        return None
    out: list[str] = []
    any_fill = False
    for path in paths:
        pw = attr_int(path, "w", 0) or 0
        ph = attr_int(path, "h", 0) or 0
        sx = w / pw if pw else 1.0
        sy = h / ph if ph else 1.0
        if path.get("fill") != "none":
            any_fill = True
        current: Point = (0.0, 0.0)

        def pt(elem: ET.Element) -> Point:
            return (attr_int(elem, "x", 0) or 0) * sx, (attr_int(elem, "y", 0) or 0) * sy

        for cmd in path:
            name = local(cmd)
            pts = [pt(p) for p in children(cmd, "a:pt")]
            if name == "moveTo" and pts:
                current = pts[0]
                out.append(f"M {current[0]:.2f} {current[1]:.2f}")
            elif name == "lnTo" and pts:
                current = pts[0]
                out.append(f"L {current[0]:.2f} {current[1]:.2f}")
            elif name == "cubicBezTo" and len(pts) >= 3:
                out.append(f"C {pts[0][0]:.2f} {pts[0][1]:.2f} {pts[1][0]:.2f} {pts[1][1]:.2f} "
                           f"{pts[2][0]:.2f} {pts[2][1]:.2f}")
                current = pts[2]
            elif name == "quadBezTo" and len(pts) >= 2:
                out.append(f"Q {pts[0][0]:.2f} {pts[0][1]:.2f} {pts[1][0]:.2f} {pts[1][1]:.2f}")
                current = pts[1]
            elif name == "arcTo":
                rx = (attr_int(cmd, "wR", 0) or 0) * sx
                ry = (attr_int(cmd, "hR", 0) or 0) * sy
                start = (attr_int(cmd, "stAng", 0) or 0) / 60000
                sweep = (attr_int(cmd, "swAng", 0) or 0) / 60000
                if rx <= 0 or ry <= 0 or sweep == 0:
                    continue
                theta = math.radians(start)
                cx = current[0] - rx * math.cos(theta)
                cy = current[1] - ry * math.sin(theta)
                out.append(_arc_path(cx, cy, rx, ry, start, sweep, move=False))
                end = math.radians(start + sweep)
                current = (cx + rx * math.cos(end), cy + ry * math.sin(end))
            elif name == "close":
                out.append("Z")
    data = " ".join(out)
    return (data, any_fill) if data else None


def mirror_path(data: str, w: float, h: float, flip_h: bool, flip_v: bool) -> str:
    """Reflect M/L/Q/C path data inside its own box."""
    if not (flip_h or flip_v):
        return data
    out: list[str] = []
    axis = 0
    for token in data.split(" "):
        if not token:
            continue
        try:
            value = float(token)
        except ValueError:
            out.append(token)
            axis = 0
            continue
        if axis == 0 and flip_h:
            value = w - value
        elif axis == 1 and flip_v:
            value = h - value
        out.append(f"{value:.2f}")
        axis ^= 1
    return " ".join(out)


# --- text to HTML -----------------------------------------------------------


def _font_family_css(font_name: str) -> str:
    """CSS fallback list for a PowerPoint typeface name."""
    escaped = font_name.replace("\\", "\\\\").replace('"', '\\"')
    lowered = font_name.lower()
    metric_twin = {
        "calibri": "Carlito",
        "calibri light": "Carlito",
        "cambria": "Caladea",
        "arial": "Liberation Sans",
        "helvetica": "Liberation Sans",
        "times new roman": "Liberation Serif",
        "courier new": "Liberation Mono",
        "georgia": "Gelasio",
    }.get(lowered)
    if any(word in lowered for word in ("mono", "courier", "consolas", "menlo", "code")):
        generic = "monospace"
    elif any(word in lowered for word in ("times", "georgia", "cambria", "garamond", "book", "serif", "palatino", "century")) \
            and "sans" not in lowered:
        generic = "serif"
    else:
        generic = "sans-serif"
    if metric_twin:
        return f'"{escaped}", "{metric_twin}", {generic}'
    return f'"{escaped}", {generic}'


def _wrap_paragraphs(paragraphs: list[str]) -> str:
    """Join paragraph markup into one text element's HTML (see Keynote importer)."""
    while paragraphs and not re.sub(r"<[^>]+>", "", paragraphs[-1]).strip() and "<ul" not in paragraphs[-1] \
            and "<ol" not in paragraphs[-1]:
        paragraphs.pop()
    if len(paragraphs) <= 1:
        return paragraphs[0] if paragraphs else ""
    return "".join(p if p.startswith("<ul") or p.startswith("<ol") or p.startswith("<p")
                   else f"<p>{p or '<br>'}</p>" for p in paragraphs)


@dataclass
class Paragraph:
    style: ParaStyle
    run: RunStyle  # the dominant run style, for the element's base style
    plain: str
    list_kind: str | None  # "ul" | "ol" | None
    level: int
    # (text, run style) per run; a None style marks an explicit line break.
    pieces: list[tuple[str, RunStyle | None]]


def _style_attr(css: dict[str, str]) -> str:
    if not css:
        return ""
    return ' style="' + "; ".join(f"{k}: {v}" for k, v in css.items()) + '"'


class TextConverter:
    """Turns an `a:txBody` (or table cell) into the editor's HTML and inline style."""

    def __init__(self, importer: "Importer", ctx: ColorContext, inheritance: TextInheritance,
                 theme: Theme, font_scale: float, slide_number: int, style_color: tuple[str, float] | None):
        self.importer = importer
        self.ctx = ctx
        self.inheritance = inheritance
        self.theme = theme
        self.font_scale = font_scale
        self.slide_number = slide_number
        # `p:style/a:fontRef` colour: the text colour a themed shape gives its label.
        self.style_color = style_color

    def resolve_font(self, name: str | None) -> str | None:
        if name is None:
            return None
        if name in ("+mj-lt", "+mj-ea", "+mj-cs"):
            return self.theme.major_font
        if name in ("+mn-lt", "+mn-ea", "+mn-cs"):
            return self.theme.minor_font
        return name

    def paragraphs(self, tx_body: ET.Element) -> list[Paragraph]:
        out: list[Paragraph] = []
        for p in children(tx_body, "a:p"):
            out.append(self.paragraph(p))
        return out

    def paragraph(self, p: ET.Element) -> Paragraph:
        ppr = child(p, "a:pPr")
        own = read_para_props(ppr, self.ctx)
        own.level = attr_int(ppr, "lvl", 0) or 0
        style = self.inheritance.resolve(own)
        base_run = RunStyle()
        base_run.fill_from(style.default_run)
        end_rpr = read_run_props(child(p, "a:endParaRPr"), self.ctx)

        pieces: list[tuple[str, RunStyle | None]] = []
        plain_parts: list[str] = []
        run_styles: list[tuple[int, RunStyle]] = []
        for node in p:
            name = local(node)
            if name in ("r", "fld"):
                text = (child(node, "a:t").text if child(node, "a:t") is not None else "") or ""
                if name == "fld" and node.get("type") == "slidenum":
                    text = str(self.slide_number)
                run = read_run_props(child(node, "a:rPr"), self.ctx)
                run.fill_from(base_run)
                pieces.append((text, run))
                plain_parts.append(text)
                run_styles.append((len(text), run))
            elif name == "br":
                pieces.append(("\n", None))
                plain_parts.append("\n")
        if not run_styles:
            # An empty paragraph: its end-of-paragraph properties set the line height.
            end_rpr.fill_from(base_run)
            dominant = end_rpr
        else:
            run_styles.sort(key=lambda entry: -entry[0])
            dominant = run_styles[0][1]
        list_kind = {"char": "ul", "num": "ol"}.get(style.bullet or "none")
        return Paragraph(style, dominant, "".join(plain_parts), list_kind, style.level, pieces)

    def convert(self, tx_body: ET.Element, box_w: float) -> dict[str, Any] | None:
        """HTML plus the element-level style/alignment for a text body."""
        paragraphs = self.paragraphs(tx_body)
        if not any(p.plain.strip() for p in paragraphs):
            return None

        # The element's base style is the first non-empty paragraph's dominant run.
        first = next(p for p in paragraphs if p.plain.strip())
        base = first.run
        base_size = self.px(base.size_pt or DEFAULT_FONT_SIZE_PT)
        base_font = self.resolve_font(base.font) or self.theme.minor_font
        base_color = base.color or self.style_color
        inline: dict[str, str] = {"font-size": f"{base_size:.0f}px"}
        if base_font:
            inline["font-family"] = _font_family_css(base_font)
        # The weight is always stated: theme.css gives .role-title a bold
        # default, and a PowerPoint title is regular unless the author chose
        # otherwise, so leaving it implicit would embolden every title.
        if base.bold:
            inline["font-weight"] = "700"
        elif base_font and "light" in base_font.lower():
            inline["font-weight"] = "300"
        else:
            inline["font-weight"] = "400"
        if base.italic:
            inline["font-style"] = "italic"
        if base.gradient:
            inline.update({
                "background-image": base.gradient,
                "background-clip": "text",
                "-webkit-background-clip": "text",
                "color": "transparent",
            })
        elif base_color:
            inline["color"] = css_color(base_color) or "#000000"
        line_height = self.line_height(first.style, base_size)
        if line_height is not None:
            inline["line-height"] = line_height
        align = first.style.align or "left"

        blocks: list[str] = []
        stack: list[tuple[str, int]] = []  # open list kinds by level

        def close_lists(to_level: int) -> None:
            while stack and (stack[-1][1] >= to_level):
                kind, _ = stack.pop()
                blocks[-1] += f"</li></{kind}>"

        for para in paragraphs:
            inner = self.render_pieces(para, base, base_size, base_font, base_color)
            para_css: dict[str, str] = {}
            if para.style.align and para.style.align != align:
                para_css["text-align"] = para.style.align
            if para.list_kind and para.plain.strip():
                # Open or continue a list at this paragraph's level.
                if stack and stack[-1][1] > para.level:
                    close_lists(para.level + 1)
                if stack and stack[-1][1] == para.level and stack[-1][0] != para.list_kind:
                    close_lists(para.level)
                if not stack or stack[-1][1] < para.level:
                    if stack:
                        blocks[-1] += f"<{para.list_kind}>"
                    else:
                        blocks.append(f"<{para.list_kind}>")
                    stack.append((para.list_kind, para.level))
                    blocks[-1] += f"<li{_style_attr(para_css)}>{inner}"
                else:
                    blocks[-1] += f"</li><li{_style_attr(para_css)}>{inner}"
                continue
            close_lists(0)
            if para.level > 0 and para.plain.strip():
                margin = para.style.margin_left_emu
                if margin:
                    para_css["margin-left"] = f"{self.importer.emu_to_px(margin):.0f}px"
            if para_css:
                blocks.append(f"<p{_style_attr(para_css)}>{inner or '<br>'}</p>")
            else:
                blocks.append(inner)
        close_lists(0)

        html_out = _wrap_paragraphs(blocks)
        spacing = self.paragraph_spacing(first.style, base_size)
        return {
            "html": html_out,
            "style": inline,
            "align": align,
            "paragraphSpacing": spacing,
            "size_px": base_size,
        }

    def render_pieces(self, para: Paragraph, base: RunStyle, base_size: float, base_font: str | None,
                      base_color: tuple[str, float] | None) -> str:
        out: list[str] = []
        for text, run in para.pieces:
            if run is None:
                out.append("<br>")
                continue
            escaped = html.escape(text)
            if not escaped:
                continue
            css: dict[str, str] = {}
            if run.bold is not None and bool(run.bold) != bool(base.bold):
                css["font-weight"] = "700" if run.bold else "400"
            if run.italic and not base.italic:
                css["font-style"] = "italic"
            elif base.italic and run.italic is False:
                css["font-style"] = "normal"
            decorations = []
            if run.underline:
                decorations.append("underline")
            if run.strike:
                decorations.append("line-through")
            if decorations:
                css["text-decoration"] = " ".join(decorations)
            font = self.resolve_font(run.font)
            if font and font != base_font:
                css["font-family"] = _font_family_css(font)
            size = self.px(run.size_pt) if run.size_pt else None
            if size is not None and abs(size - base_size) >= 0.5:
                css["font-size"] = f"{size:.0f}px"
            if base.gradient is None:
                color = run.color or self.style_color
                if color and color != base_color:
                    css["color"] = css_color(color) or ""
            if run.baseline:
                tag = "sup" if run.baseline > 0 else "sub"
                escaped = f"<{tag}>{escaped}</{tag}>"
            out.append(f"<span{_style_attr(css)}>{escaped}</span>" if css else escaped)
        return "".join(out)

    def px(self, size_pt: float) -> float:
        return self.importer.pt_to_px(size_pt) * self.font_scale

    def line_height(self, style: ParaStyle, base_size: float) -> str | None:
        if style.line_spacing_pt:
            return f"{self.px(style.line_spacing_pt):.0f}px"
        if style.line_spacing_pct is not None and abs(style.line_spacing_pct - 1.0) > 0.01:
            return f"{SINGLE_LINE_HEIGHT * style.line_spacing_pct:.2f}"
        return None

    def paragraph_spacing(self, style: ParaStyle, base_size: float) -> float | None:
        total = self.px((style.space_before_pt or 0) + (style.space_after_pt or 0))
        total += ((style.space_before_pct or 0) + (style.space_after_pct or 0)) * base_size
        if total < 0.5:
            return None
        return round(total, 1)


# --- the importer -----------------------------------------------------------


@dataclass
class SlideContext:
    part: str
    layout: str | None
    master: str | None
    theme: Theme
    ctx: ColorContext
    number: int


@dataclass
class Importer:
    pkg: Package
    out_dir: Path
    report: Report
    scale: float  # px per EMU
    canvas: tuple[float, float]
    default_text_style: ET.Element | None
    dry_run: bool = False
    progress: Progress = field(default_factory=SilentProgress)
    _asset_cache: dict[str, str | None] = field(default_factory=dict)
    _theme_cache: dict[str, Theme] = field(default_factory=dict)
    _counter: int = 0

    def next_id(self, prefix: str) -> str:
        self._counter += 1
        return f"{prefix}-{self._counter}"

    def emu_to_px(self, emu: float) -> float:
        return emu * self.scale

    def pt_to_px(self, pt: float) -> float:
        return pt * EMU_PER_PT * self.scale

    # --- assets -------------------------------------------------------------

    def copy_media(self, part: str) -> str | None:
        """Copy a media part into `assets/`, converting if a browser needs it to be."""
        if part in self._asset_cache:
            return self._asset_cache[part]
        self._asset_cache[part] = None
        if not self.pkg.has(part):
            self.report.warn(f"Missing from package: {part}")
            return None
        file_name = posixpath.basename(part)
        ext = Path(file_name).suffix.lower()

        if self.dry_run:
            name = _safe_name(file_name)
            if ext in RASTER_CONVERT:
                name = _safe_name(Path(file_name).stem) + ".png"
                self.report.converted_images += 1
            rel = f"assets/{name}"
            self._asset_cache[part] = rel
            return rel

        assets = self.out_dir / "assets"
        assets.mkdir(parents=True, exist_ok=True)
        try:
            raw = self.pkg.read(part)
        except Exception as exc:
            self.report.warn(f"Could not read {part}: {exc}")
            return None
        size = _human_bytes(len(raw))

        if ext in RASTER_CONVERT:
            self.progress.emit(f"Converting {file_name} to PNG ({size})")
            converted = self._convert_image(raw, file_name, assets)
            self._asset_cache[part] = converted
            return converted
        if ext in VIDEO_EXTS:
            playable = self._ensure_playable_video(raw, file_name, assets)
            self._asset_cache[part] = playable
            return playable
        if ext not in WEB_SAFE_IMAGE and ext not in AUDIO_EXTS:
            self.report.warn(f"Unrecognised media type kept as-is: {file_name}")

        self.progress.emit(f"Extracting {file_name} ({size})")
        dest = assets / _safe_name(file_name)
        if not dest.exists():
            dest.write_bytes(raw)
        rel = f"assets/{dest.name}"
        self._asset_cache[part] = rel
        return rel

    def _convert_image(self, raw: bytes, file_name: str, assets: Path) -> str | None:
        """Re-encode a format Chromium cannot display as PNG.

        EMF and WMF are vector metafiles Pillow only rasterises on Windows;
        elsewhere they become placeholders, and the report says so.
        """
        try:
            from PIL import Image
        except ImportError:
            self.report.warn(f"Pillow unavailable; {file_name} kept in an undisplayable format")
            dest = assets / _safe_name(file_name)
            dest.write_bytes(raw)
            return f"assets/{dest.name}"
        try:
            with Image.open(io.BytesIO(raw)) as img:
                img.load()
                if img.mode not in ("RGB", "RGBA"):
                    img = img.convert("RGBA")
                dest = assets / (_safe_name(Path(file_name).stem) + ".png")
                img.save(dest, "PNG")
        except Exception as exc:
            ext = Path(file_name).suffix.lower()
            if ext in (".emf", ".wmf"):
                # Pillow only rasterises Windows metafiles on Windows. ImageMagick
                # (with libwmf) can do it anywhere, so it is tried when present;
                # otherwise the equation or clip-art stays a visible placeholder.
                rendered = self._rasterise_metafile(raw, file_name, assets)
                if rendered is not None:
                    return rendered
                self.report.warn_once(
                    f"{ext[1:].upper()} vector images cannot be rasterised on this platform "
                    "(install Inkscape to convert them) and were left as placeholders"
                )
            else:
                self.report.warn(f"Could not convert {file_name}: {exc}")
            return None
        self.report.converted_images += 1
        return f"assets/{dest.name}"

    def _rasterise_metafile(self, raw: bytes, file_name: str, assets: Path) -> str | None:
        """Render an EMF/WMF to PNG with whichever vector tool is installed.

        Inkscape reads metafiles natively; ImageMagick usually delegates them
        to LibreOffice, so it is the second choice. Rendered at 4x the nominal
        72 dpi so a small equation stays sharp on a projector.
        """
        source = assets / _safe_name(file_name)
        dest = assets / (_safe_name(Path(file_name).stem) + ".png")
        commands: list[list[str]] = []
        inkscape = shutil.which("inkscape")
        if inkscape:
            commands.append([inkscape, str(source), "--export-type=png", "--export-dpi=288",
                             f"--export-filename={dest}"])
        magick = shutil.which("magick") or shutil.which("convert")
        if magick:
            commands.append([magick, "-density", "288", "-background", "none", str(source), str(dest)])
        if not commands:
            return None
        self.progress.emit(f"Rendering {file_name} ({_human_bytes(len(raw))})")
        try:
            source.write_bytes(raw)
            for command in commands:
                try:
                    subprocess.run(command, check=True, capture_output=True, timeout=120)
                except Exception:
                    dest.unlink(missing_ok=True)
                    continue
                if dest.exists() and dest.stat().st_size > 0:
                    break
        finally:
            source.unlink(missing_ok=True)
        if not dest.exists():
            return None
        self.report.converted_images += 1
        return f"assets/{dest.name}"

    def _ensure_playable_video(self, raw: bytes, file_name: str, assets: Path) -> str | None:
        """Write a video out, transcoding it if a browser cannot decode it.

        PowerPoint decks routinely carry WMV and MPEG-4 Part 2 clips; anything
        outside the web-safe set is re-encoded to H.264, which plays the same on
        macOS, Linux and Windows.
        """
        dest = assets / _safe_name(file_name)
        self.progress.emit(f"Extracting {file_name} ({_human_bytes(len(raw))})")
        if not dest.exists():
            dest.write_bytes(raw)
        codec = _video_codec(dest)
        container_ok = dest.suffix.lower() in (".mp4", ".m4v", ".webm", ".mov")
        if (codec is None or codec in WEB_SAFE_VIDEO_CODECS) and container_ok:
            return f"assets/{dest.name}"
        target = assets / (_safe_name(Path(file_name).stem) + ".h264.mp4")
        if target.exists():
            dest.unlink(missing_ok=True)
            return f"assets/{target.name}"
        if shutil.which("ffmpeg") is None:
            self.report.warn(
                f"{file_name} uses the '{codec or dest.suffix}' format, which browsers cannot play, "
                "and ffmpeg was not found to convert it."
            )
            self.report.unsupported[f"video codec {codec or dest.suffix}"] += 1
            return f"assets/{dest.name}"
        self.progress.emit(f"Transcoding {file_name} from {codec or dest.suffix} to H.264")
        try:
            subprocess.run(
                ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(dest),
                 "-c:v", "libx264", "-crf", "20", "-preset", "veryfast", "-pix_fmt", "yuv420p",
                 "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", str(target)],
                check=True, capture_output=True, timeout=600,
            )
        except Exception as exc:
            self.report.warn(f"Could not transcode {file_name}: {exc}")
            self.report.unsupported[f"video codec {codec or dest.suffix}"] += 1
            return f"assets/{dest.name}"
        dest.unlink(missing_ok=True)
        self.report.transcoded_videos += 1
        return f"assets/{target.name}"

    # --- theme / context ----------------------------------------------------

    def theme_for(self, master: str | None) -> Theme:
        if master is None:
            return Theme.empty()
        cached = self._theme_cache.get(master)
        if cached is None:
            themes = self.pkg.related(master, REL_THEME)
            cached = load_theme(self.pkg, themes[0] if themes else None)
            self._theme_cache[master] = cached
        return cached

    def slide_context(self, part: str, number: int) -> SlideContext:
        layouts = self.pkg.related(part, REL_LAYOUT)
        layout = layouts[0] if layouts and self.pkg.has(layouts[0]) else None
        masters = self.pkg.related(layout, REL_MASTER) if layout else []
        master = masters[0] if masters and self.pkg.has(masters[0]) else None
        theme = self.theme_for(master)
        clr_map = dict(DEFAULT_CLR_MAP)
        if master:
            clr_map = read_clr_map(child(self.pkg.xml(master), "p:clrMap"), clr_map)
        for override_part in (layout, part):
            if override_part is None:
                continue
            override = child(self.pkg.xml(override_part), "p:clrMapOvr", "a:overrideClrMapping")
            if override is not None:
                clr_map = read_clr_map(override, clr_map)
        return SlideContext(part, layout, master, theme, ColorContext(theme.colors, clr_map), number)

    # --- placeholders -------------------------------------------------------

    @staticmethod
    def placeholder_of(sp: ET.Element) -> ET.Element | None:
        return first_child(
            sp,
            ("p:nvSpPr", "p:nvPr", "p:ph"),
            ("p:nvPicPr", "p:nvPr", "p:ph"),
            ("p:nvGraphicFramePr", "p:nvPr", "p:ph"),
            ("p:nvCxnSpPr", "p:nvPr", "p:ph"),
        )

    def find_placeholder(self, part: str | None, ph: ET.Element, prefer_type: bool = False) -> ET.Element | None:
        """The layout/master shape a slide placeholder inherits from."""
        if part is None:
            return None
        ph_type = ph.get("type") or "body"
        ph_idx = ph.get("idx")
        tree = child(self.pkg.xml(part), "p:cSld", "p:spTree")
        candidates: list[tuple[ET.Element, ET.Element]] = []
        for sp in self.iter_shapes(tree):
            cand = self.placeholder_of(sp)
            if cand is not None:
                candidates.append((sp, cand))
        title_types = {"title", "ctrTitle"}
        body_types = {"body", "subTitle", "obj", "tbl", "chart", "dgm", "media", "clipArt", "pic", "sldImg"}

        def type_matches(candidate_type: str) -> bool:
            if ph_type == candidate_type:
                return True
            if ph_type in title_types and candidate_type in title_types:
                return True
            if ph_type in body_types and candidate_type in body_types:
                return True
            return False

        if ph_idx is not None and not prefer_type:
            for sp, cand in candidates:
                if cand.get("idx") == ph_idx and (cand.get("type") or "body") not in {"dt", "ftr", "sldNum"} - {ph_type}:
                    return sp
        for sp, cand in candidates:
            if type_matches(cand.get("type") or "body"):
                return sp
        return None

    def placeholder_chain(self, sp: ET.Element, slide: SlideContext) -> list[ET.Element]:
        """The slide shape's layout placeholder, then the master's, when they exist."""
        ph = self.placeholder_of(sp)
        if ph is None:
            return []
        chain: list[ET.Element] = []
        layout_sp = self.find_placeholder(slide.layout, ph)
        if layout_sp is not None:
            chain.append(layout_sp)
        # The master matches by type only: idx numbers are layout-local.
        master_ph = self.placeholder_of(layout_sp) if layout_sp is not None else None
        master_sp = self.find_placeholder(slide.master, master_ph if master_ph is not None else ph, prefer_type=True)
        if master_sp is not None:
            chain.append(master_sp)
        return chain

    def master_text_style(self, sp: ET.Element, slide: SlideContext) -> ET.Element | None:
        ph = self.placeholder_of(sp)
        if slide.master is None:
            return None
        styles = child(self.pkg.xml(slide.master), "p:txStyles")
        if styles is None:
            return None
        if ph is None:
            return child(styles, "p:otherStyle")
        kind = ph.get("type") or "body"
        if kind in ("title", "ctrTitle"):
            return child(styles, "p:titleStyle")
        return child(styles, "p:bodyStyle")

    # --- iteration ----------------------------------------------------------

    def iter_shapes(self, tree: ET.Element | None) -> list[ET.Element]:
        """Direct drawable children of a shape tree, unwrapping compatibility blocks.

        `mc:AlternateContent` carries a newer encoding in `mc:Choice` and a
        plain one in `mc:Fallback`; the fallback is the one every consumer
        understands (an equation, say, falls back to a picture of itself).
        """
        if tree is None:
            return []
        out: list[ET.Element] = []
        for node in tree:
            name = local(node)
            if name in ("sp", "pic", "grpSp", "cxnSp", "graphicFrame"):
                out.append(node)
            elif name == "AlternateContent":
                fallback = child(node, "mc:Fallback")
                choice = child(node, "mc:Choice")
                source = fallback if fallback is not None and len(fallback) else choice
                out.extend(self.iter_shapes(source))
        return out

    # --- conversion ---------------------------------------------------------

    def convert_shape_tree(self, tree: ET.Element | None, slide: SlideContext, part: str,
                           transform: list[GroupTransform], inherited: bool,
                           skip_placeholders: bool) -> list[dict[str, Any]]:
        elements: list[dict[str, Any]] = []
        for node in self.iter_shapes(tree):
            if skip_placeholders and self.placeholder_of(node) is not None:
                continue
            try:
                converted = self.convert_node(node, slide, part, transform)
            except Exception as exc:
                name = local(node)
                self.report.unsupported[f"p:{name}"] += 1
                self.report.warn(f"Slide {slide.number}: {name} failed: {exc}")
                box = self.node_box(node, slide, part, transform) or Box(0, 0, 200, 100)
                converted = [self._placeholder(box.as_dict(), f"p:{name}", str(exc)[:120])]
            if inherited:
                for element in converted:
                    element["class"] = [*element.get("class", []), "pp-layout"]
            elements.extend(converted)
        return elements

    def node_box(self, node: ET.Element, slide: SlideContext, part: str,
                 transform: list[GroupTransform]) -> Box | None:
        name = local(node)
        if name == "grpSp":
            xfrm = child(node, "p:grpSpPr", "a:xfrm")
        elif name == "graphicFrame":
            xfrm = child(node, "p:xfrm")
        else:
            xfrm = child(node, "p:spPr", "a:xfrm")
        box = read_xfrm(xfrm, self.scale)
        if box is None and name in ("sp", "pic"):
            for ancestor in self.placeholder_chain(node, slide):
                box = read_xfrm(child(ancestor, "p:spPr", "a:xfrm"), self.scale)
                if box is not None:
                    break
        if box is None:
            return None
        for group in reversed(transform):
            box = group.apply(box)
        return box

    def convert_node(self, node: ET.Element, slide: SlideContext, part: str,
                     transform: list[GroupTransform]) -> list[dict[str, Any]]:
        name = local(node)
        if name == "grpSp":
            return self.convert_group(node, slide, part, transform)
        box = self.node_box(node, slide, part, transform)
        if box is None:
            if name == "sp" and self.placeholder_of(node) is not None:
                # A placeholder with no geometry anywhere is not drawn by PowerPoint.
                return []
            box = Box(0, 0, 200, 100)
        if name == "pic":
            return self.convert_picture(node, slide, part, box)
        if name == "cxnSp":
            return self.convert_connector(node, slide, part, box)
        if name == "graphicFrame":
            return self.convert_graphic_frame(node, slide, part, box)
        return self.convert_sp(node, slide, part, box)

    def convert_group(self, node: ET.Element, slide: SlideContext, part: str,
                      transform: list[GroupTransform]) -> list[dict[str, Any]]:
        xfrm = child(node, "p:grpSpPr", "a:xfrm")
        off = child(xfrm, "a:off")
        ext = child(xfrm, "a:ext")
        ch_off = child(xfrm, "a:chOff")
        ch_ext = child(xfrm, "a:chExt")
        ext_w = (attr_int(ext, "cx", 0) or 0) * self.scale
        ext_h = (attr_int(ext, "cy", 0) or 0) * self.scale
        ch_w = (attr_int(ch_ext, "cx", 0) or 0) * self.scale
        ch_h = (attr_int(ch_ext, "cy", 0) or 0) * self.scale
        group = GroupTransform(
            off_x=(attr_int(off, "x", 0) or 0) * self.scale,
            off_y=(attr_int(off, "y", 0) or 0) * self.scale,
            ch_off_x=(attr_int(ch_off, "x", 0) or 0) * self.scale,
            ch_off_y=(attr_int(ch_off, "y", 0) or 0) * self.scale,
            scale_x=ext_w / ch_w if ch_w else 1.0,
            scale_y=ext_h / ch_h if ch_h else 1.0,
            rot=(attr_int(xfrm, "rot", 0) or 0) / 60000,
            flip_h=attr_bool(xfrm, "flipH"),
            flip_v=attr_bool(xfrm, "flipV"),
            ext_w=ext_w,
            ext_h=ext_h,
        )
        return self.convert_shape_tree(node, slide, part, [*transform, group], False, False)

    # --- shapes -------------------------------------------------------------

    def shape_paint(self, node: ET.Element, slide: SlideContext, part: str) -> tuple[Fill, Line, tuple[str, float] | None]:
        """Resolve a shape's fill, line and themed text colour through `p:style`."""
        sppr = child(node, "p:spPr")
        ctx = slide.ctx
        fill = read_fill(sppr, ctx, part)
        line = read_line(child(sppr, "a:ln"), ctx) or Line()
        style = child(node, "p:style")
        font_color: tuple[str, float] | None = None
        theme = slide.theme
        if style is not None:
            fill_ref = child(style, "a:fillRef")
            if fill is None and fill_ref is not None:
                idx = attr_int(fill_ref, "idx", 0) or 0
                ph_color = _first_color(fill_ref, ctx)
                styles = theme.fill_styles if idx < 1000 else theme.bg_fill_styles
                position = idx - 1 if idx < 1000 else idx - 1001
                if 0 <= position < len(styles):
                    wrapper = ET.Element("wrapper")
                    wrapper.append(styles[position])
                    fill = read_fill(wrapper, ColorContext(theme.colors, ctx.clr_map, ph_color), part)
                elif idx == 0:
                    fill = Fill("none")
            line_ref = child(style, "a:lnRef")
            if line_ref is not None:
                idx = attr_int(line_ref, "idx", 0) or 0
                ph_color = _first_color(line_ref, ctx)
                if 0 < idx <= len(theme.line_styles):
                    themed = read_line(theme.line_styles[idx - 1], ColorContext(theme.colors, ctx.clr_map, ph_color))
                    if themed is not None:
                        line.merge_from(themed)
                elif idx == 0 and line.fill is None:
                    line.fill = Fill("none")
            font_ref = child(style, "a:fontRef")
            if font_ref is not None:
                font_color = _first_color(font_ref, ctx)
        if fill is None:
            fill = Fill("none")
        if line.fill is None:
            line.fill = Fill("none")
        return fill, line, font_color

    def stroke_width_px(self, line: Line) -> float:
        width = line.width_emu if line.width_emu is not None else 9525
        return max(0.5, round(self.emu_to_px(width), 2))

    def convert_sp(self, node: ET.Element, slide: SlideContext, part: str, box: Box) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        sppr = child(node, "p:spPr")
        fill, line, font_color = self.shape_paint(node, slide, part)
        z = 0
        geometry = self.convert_geometry(node, sppr, fill, line, box, slide, part, z)
        if geometry is not None:
            out.append(geometry)

        tx_body = child(node, "p:txBody")
        if tx_body is not None:
            text = self.convert_text(node, tx_body, slide, box, font_color, geometry is not None)
            if text is not None:
                out.append(text)
        return out

    def convert_geometry(self, node: ET.Element, sppr: ET.Element | None, fill: Fill, line: Line,
                         box: Box, slide: SlideContext, part: str, z: int) -> dict[str, Any] | None:
        """The drawn part of a shape, or None if it paints nothing."""
        if fill.kind == "image" and fill.blip:
            return self.image_from_blip(fill.blip, part, box, z, None, None, sppr)
        prst_elem = child(sppr, "a:prstGeom")
        cust = child(sppr, "a:custGeom")
        prst = prst_elem.get("prst") if prst_elem is not None else ("custom" if cust is not None else "rect")
        adjustments = self.read_adjustments(prst_elem)

        fill_css = fill.css if fill.kind == "gradient" else css_color(fill.color) if fill.kind in ("solid", "pattern") else None
        stroke_css = css_color(line.fill.color) if line.fill and line.fill.kind in ("solid", "gradient", "pattern") else None
        stroke_width = self.stroke_width_px(line) if stroke_css else 0.0
        arrow_start = bool(line.head)
        arrow_end = bool(line.tail)

        if fill_css is None and stroke_css is None:
            return None

        if prst in LINE_PRESETS:
            if stroke_css is None:
                return None
            return self.native_line(box, stroke_css, stroke_width, arrow_start, arrow_end, z)

        if prst in RECT_PRESETS or prst in ROUND_RECT_PRESETS or prst in ELLIPSE_PRESETS:
            element = self._base(box.as_dict(), z, "shape")
            radius = 0.0
            if prst in ROUND_RECT_PRESETS:
                radius = _adj(adjustments, "adj", 16667) / 100000 * min(box.w, box.h)
            element.update({
                "shape": "ellipse" if prst in ELLIPSE_PRESETS else "rect",
                "path": None,
                "pathSize": None,
                "fill": fill_css,
                "stroke": stroke_css,
                "strokeWidth": stroke_width,
                "radius": round(radius, 2),
                "arrowStart": False,
                "arrowEnd": False,
            })
            return element

        path_data: str | None = None
        w, h = max(1.0, box.w), max(1.0, box.h)
        if cust is not None:
            custom = custom_geometry_path(cust, w, h)
            if custom is not None:
                path_data, has_fill = custom
                if not has_fill:
                    fill_css = None
        elif prst is not None:
            path_data = preset_path(prst, w, h, adjustments)
            if path_data is None:
                self.report.warn_once(f"Preset shape '{prst}' is approximated as a rectangle")
                element = self._base(box.as_dict(), z, "shape")
                element.update({
                    "shape": "rect", "path": None, "pathSize": None, "fill": fill_css,
                    "stroke": stroke_css, "strokeWidth": stroke_width, "radius": 0,
                    "arrowStart": False, "arrowEnd": False,
                })
                return element
        if not path_data:
            return None
        path_data = mirror_path(path_data, w, h, box.flip_h, box.flip_v)
        if fill_css is None and stroke_css is None:
            return None
        open_shape = prst in ("arc", "bentConnector2", "bentConnector3", "bentConnector4", "bentConnector5",
                              "curvedConnector2", "curvedConnector3", "curvedConnector4", "curvedConnector5",
                              "leftBracket", "rightBracket", "bracketPair", "leftBrace", "rightBrace", "bracePair")
        element = self._base(box.as_dict(), z, "shape")
        element.update({
            "shape": "path",
            "path": path_data,
            "pathSize": {"w": w, "h": h},
            "fill": None if open_shape else fill_css,
            "stroke": stroke_css,
            "strokeWidth": stroke_width,
            "radius": 0,
            "arrowStart": arrow_start,
            "arrowEnd": arrow_end,
        })
        return element

    @staticmethod
    def read_adjustments(prst_elem: ET.Element | None) -> dict[str, float]:
        out: dict[str, float] = {}
        for gd in children(child(prst_elem, "a:avLst"), "a:gd"):
            match = re.match(r"val\s+(-?\d+)", gd.get("fmla") or "")
            if match and gd.get("name"):
                out[gd.get("name") or ""] = float(match.group(1))
        return out

    def native_line(self, box: Box, stroke: str, width: float, arrow_start: bool, arrow_end: bool,
                    z: int) -> dict[str, Any]:
        """A `line` preset: from the box's top-left to bottom-right unless flipped."""
        x0, y0, x1, y1 = box.x, box.y, box.x + box.w, box.y + box.h
        if box.flip_h:
            x0, x1 = x1, x0
        if box.flip_v:
            y0, y1 = y1, y0
        if abs(box.rot) > 0.01:
            # Rotate both endpoints about the box centre.
            cx, cy = box.x + box.w / 2, box.y + box.h / 2
            theta = math.radians(box.rot)

            def turn(x: float, y: float) -> tuple[float, float]:
                dx, dy = x - cx, y - cy
                return cx + dx * math.cos(theta) - dy * math.sin(theta), cy + dx * math.sin(theta) + dy * math.cos(theta)

            (x0, y0), (x1, y1) = turn(x0, y0), turn(x1, y1)
        dx, dy = x1 - x0, y1 - y0
        length = max(1.0, math.hypot(dx, dy))
        centre_x, centre_y = (x0 + x1) / 2, (y0 + y1) / 2
        native = {"x": centre_x - length / 2, "y": centre_y - 0.5, "w": length, "h": 1.0,
                  "rot": _normalise_angle(math.degrees(math.atan2(dy, dx)))}
        element = self._base(native, z, "shape")
        element.update({
            "shape": "arrow" if (arrow_start or arrow_end) else "line",
            "path": None,
            "pathSize": None,
            "fill": None,
            "stroke": stroke,
            "strokeWidth": width,
            "radius": 0,
            "arrowStart": arrow_start,
            "arrowEnd": arrow_end,
            "control": None,
        })
        return element

    def convert_connector(self, node: ET.Element, slide: SlideContext, part: str, box: Box) -> list[dict[str, Any]]:
        _, line, _ = self.shape_paint(node, slide, part)
        sppr = child(node, "p:spPr")
        if line.fill is None or line.fill.kind == "none":
            # A connector always draws; without a resolvable stroke it takes
            # the slide's text colour, which is what PowerPoint shows.
            text_name = slide.ctx.clr_map.get("tx1", "dk1")
            line.fill = Fill("solid", (f"#{slide.theme.colors.get(text_name, '000000').lower()}", 1.0))
        element = self.convert_geometry(node, sppr, Fill("none"), line, box, slide, part, 0)
        return [element] if element is not None else []

    # --- pictures -----------------------------------------------------------

    def convert_picture(self, node: ET.Element, slide: SlideContext, part: str, box: Box) -> list[dict[str, Any]]:
        nv = child(node, "p:nvPicPr", "p:nvPr")
        video = child(nv, "a:videoFile")
        audio = first_child(nv, ("a:audioFile",), ("a:wavAudioFile",))
        blip_fill = child(node, "p:blipFill")
        blip = child(blip_fill, "a:blip")
        sppr = child(node, "p:spPr")
        description = (child(node, "p:nvPicPr", "p:cNvPr").get("descr") if child(node, "p:nvPicPr", "p:cNvPr") is not None else "") or ""

        if audio is not None:
            self.report.unsupported["audio"] += 1
            return [self._placeholder(box.as_dict(), "Audio", "audio clips are not imported")]

        if video is not None:
            target = self.pkg.target(part, video.get(R_LINK))
            if target is None or target[1]:
                self.report.warn(f"Slide {slide.number}: linked video is outside the package"
                                 + (f" ({target[0]})" if target else ""))
                self.report.unsupported["video (external link)"] += 1
                poster = self.image_from_blip(blip.get(R_EMBED) if blip is not None else None, part, box, 0, None, description, sppr)
                return [poster] if poster is not None else [self._placeholder(box.as_dict(), "Video", "linked video missing")]
            src = self.copy_media(target[0])
            if src is None:
                self.report.unsupported["video (no data)"] += 1
                return [self._placeholder(box.as_dict(), "Video", "video data missing")]
            if Path(src).suffix.lower() in ANIMATED_IMAGE_EXTS:
                element = self._base(box.as_dict(), 0, "image")
                element.update({"src": src, "fit": "fill", "alt": description, "sourceBox": None})
                return [element]
            element = self._base(box.as_dict(), 0, "video")
            element.update({
                "src": src,
                "fit": "contain",
                # Autoplay and loop regardless of what PowerPoint recorded: the
                # deck-wide default for any video in this tool. Both are
                # per-element toggles in the inspector.
                "autoplay": True,
                "loop": True,
                "muted": True,
                "controls": False,
                "start": 0,
                "end": None,
                "poster": None,
            })
            return [element]

        if blip is None:
            self.report.unsupported["p:pic (no image)"] += 1
            return [self._placeholder(box.as_dict(), "Picture", "no image data")]
        element = self.image_from_blip(blip.get(R_EMBED), part, box, 0, blip_fill, description, sppr, blip)
        if element is None:
            self.report.unsupported["p:pic (no data)"] += 1
            return [self._placeholder(box.as_dict(), "Picture", "image data missing")]
        return [element]

    def image_from_blip(self, rid: str | None, part: str, box: Box, z: int, blip_fill: ET.Element | None,
                        description: str | None, sppr: ET.Element | None,
                        blip: ET.Element | None = None) -> dict[str, Any] | None:
        target = self.pkg.target(part, rid)
        src: str | None = None
        # A picture may carry an SVG original alongside its PNG fallback; the
        # SVG stays sharp at any projector size, so it is preferred.
        if blip is not None:
            for ext in children(child(blip, "a:extLst"), "a:ext"):
                svg = child(ext, "asvg:svgBlip")
                if svg is not None:
                    svg_target = self.pkg.target(part, svg.get(R_EMBED))
                    if svg_target and not svg_target[1]:
                        src = self.copy_media(svg_target[0])
        if src is None:
            if target is None:
                return None
            if target[1]:
                self.report.warn(f"Linked image is outside the package: {target[0]}")
                return None
            src = self.copy_media(target[0])
        if src is None:
            return None

        element = self._base(box.as_dict(), z, "image")
        source_box = None
        src_rect = child(blip_fill, "a:srcRect")
        if src_rect is not None:
            left = (attr_int(src_rect, "l", 0) or 0) / 100000
            top = (attr_int(src_rect, "t", 0) or 0) / 100000
            right = (attr_int(src_rect, "r", 0) or 0) / 100000
            bottom = (attr_int(src_rect, "b", 0) or 0) / 100000
            span_x = 1 - left - right
            span_y = 1 - top - bottom
            if span_x > 0.01 and span_y > 0.01 and (left or top or right or bottom):
                full_w = box.w / span_x
                full_h = box.h / span_y
                source_box = {
                    "x": round(-left * full_w, 2),
                    "y": round(-top * full_h, 2),
                    "w": round(full_w, 2),
                    "h": round(full_h, 2),
                }
                self.report.cropped_images += 1
        element.update({"src": src, "fit": "fill", "alt": description or "", "sourceBox": source_box})

        prst = child(sppr, "a:prstGeom")
        if prst is not None and prst.get("prst") in ELLIPSE_PRESETS:
            element["maskShape"] = "circle"
        elif prst is not None and prst.get("prst") in ROUND_RECT_PRESETS:
            adjustments = self.read_adjustments(prst)
            element["borderRadius"] = round(_adj(adjustments, "adj", 16667) / 100000 * min(box.w, box.h), 2)
        ln = child(sppr, "a:ln")
        if ln is not None:
            line = read_line(ln, ColorContext({}, {}))
            # Picture borders are usually literal colours; scheme colours here
            # are resolved with the slide's own context by the caller's theme.
            if line and line.fill and line.fill.kind == "solid" and line.fill.color:
                element["borderColor"] = css_color(line.fill.color)
                element["borderWidth"] = self.stroke_width_px(line)
        if box.flip_h or box.flip_v:
            self.report.warn_once("Flipped pictures are imported unflipped")
        return element

    # --- text ---------------------------------------------------------------

    def body_properties(self, node: ET.Element, slide: SlideContext) -> tuple[ET.Element | None, list[ET.Element]]:
        """This shape's `a:bodyPr` and the placeholders it inherits from."""
        chain = self.placeholder_chain(node, slide)
        return child(node, "p:txBody", "a:bodyPr"), chain

    def convert_text(self, node: ET.Element, tx_body: ET.Element, slide: SlideContext, box: Box,
                     font_color: tuple[str, float] | None, has_geometry: bool) -> dict[str, Any] | None:
        chain = self.placeholder_chain(node, slide)
        placeholder = self.placeholder_of(node)
        sources: list[ET.Element | None] = [child(tx_body, "a:lstStyle")]
        for ancestor in chain:
            sources.append(child(ancestor, "p:txBody", "a:lstStyle"))
        sources.append(self.master_text_style(node, slide))
        if placeholder is None:
            sources.append(self.default_text_style)
        inheritance = TextInheritance(sources, slide.ctx)

        body_prs = [child(tx_body, "a:bodyPr")] + [child(a, "p:txBody", "a:bodyPr") for a in chain]

        def body_attr(name: str) -> str | None:
            for bp in body_prs:
                if bp is not None and bp.get(name) is not None:
                    return bp.get(name)
            return None

        font_scale = 1.0
        for bp in body_prs:
            auto = child(bp, "a:normAutofit")
            if auto is not None:
                font_scale = (attr_int(auto, "fontScale", 100000) or 100000) / 100000
                break
            if bp is not None and (child(bp, "a:spAutoFit") is not None or child(bp, "a:noAutofit") is not None):
                break

        converter = TextConverter(self, slide.ctx, inheritance, slide.theme, font_scale, slide.number, font_color)
        converted = converter.convert(tx_body, box.w)
        ph_type = placeholder.get("type") if placeholder is not None else None

        if converted is None:
            if placeholder is None or ph_type in ("dt", "ftr", "sldNum") or has_geometry:
                return None
            # An empty placeholder keeps its slot with prompt text, as in PowerPoint.
            style_probe = converter.paragraphs(tx_body)
            size = converter.px(style_probe[0].run.size_pt or DEFAULT_FONT_SIZE_PT) if style_probe else self.pt_to_px(DEFAULT_FONT_SIZE_PT)
            element = self._base(box.as_dict(), 0, "text")
            element.update({
                "html": PLACEHOLDER_TEXT,
                "autoFit": True,
                "align": (style_probe[0].style.align if style_probe else None) or "left",
                "valign": self.valign(body_attr("anchor")),
                "class": ["pp-text", "placeholder"],
                "style": {"font-size": f"{size:.0f}px", "font-family": _font_family_css(slide.theme.minor_font)},
            })
            self.tag_role(element, ph_type)
            return element

        element = self._base(box.as_dict(), 0, "text")
        element.update({
            "html": converted["html"],
            "autoFit": True,
            "align": converted["align"],
            "valign": self.valign(body_attr("anchor")),
            "class": ["pp-text"],
            "style": converted["style"],
        })
        if body_attr("wrap") == "none":
            element["noWrap"] = True
        if converted["paragraphSpacing"] is not None:
            element["paragraphSpacing"] = converted["paragraphSpacing"]
        insets = self.text_insets(body_attr)
        if insets:
            element["style"]["padding"] = insets
        if box.flip_h or box.flip_v:
            self.report.warn_once("Flipped text boxes are imported unflipped")
        self.tag_role(element, ph_type)
        return element

    def text_insets(self, body_attr: Callable[[str], str | None]) -> str | None:
        """PowerPoint's text-box padding, kept inline so wrapping matches."""
        defaults = {"lIns": 91440, "tIns": 45720, "rIns": 91440, "bIns": 45720}
        values = []
        for name in ("tIns", "rIns", "bIns", "lIns"):
            raw = body_attr(name)
            try:
                emu = int(raw) if raw is not None else defaults[name]
            except ValueError:
                emu = defaults[name]
            values.append(self.emu_to_px(emu))
        if all(v < 0.5 for v in values):
            return None
        return " ".join(f"{v:.1f}px" for v in values)

    @staticmethod
    def valign(anchor: str | None) -> str:
        return {"t": "top", "ctr": "middle", "b": "bottom", "just": "top", "dist": "top"}.get(anchor or "t", "top")

    @staticmethod
    def tag_role(element: dict[str, Any], ph_type: str | None) -> None:
        if ph_type in ("title", "ctrTitle"):
            element["_kn_role"] = "title"
        elif ph_type in ("body", "subTitle", "obj"):
            element["_kn_role"] = "body"

    # --- graphic frames -----------------------------------------------------

    def convert_graphic_frame(self, node: ET.Element, slide: SlideContext, part: str, box: Box) -> list[dict[str, Any]]:
        data = child(node, "a:graphic", "a:graphicData")
        uri = (data.get("uri") if data is not None else "") or ""
        if uri.endswith("/table"):
            table = child(data, "a:tbl")
            if table is not None:
                element = self.convert_table(table, slide, part, box)
                if element is not None:
                    return [element]
        kind = {
            "http://schemas.openxmlformats.org/drawingml/2006/chart": "Chart",
            "http://schemas.openxmlformats.org/drawingml/2006/diagram": "SmartArt",
            "http://schemas.openxmlformats.org/presentationml/2006/ole": "Embedded object",
        }.get(uri, uri.rsplit("/", 1)[-1] or "graphicFrame")
        # An OLE object often ships a picture of itself, either as a `p:pic`
        # inside the frame or — for legacy Equation Editor objects — as a VML
        # shape whose `imagedata` is the rendered equation.
        pic = data.find(f".//{q('p:pic')}") if data is not None else None
        if pic is not None:
            converted = self.convert_picture(pic, slide, part, box)
            if converted and converted[0]["type"] == "image":
                return converted
        ole = child(data, "p:oleObj")
        if ole is not None:
            preview = self.ole_preview(ole, part)
            if preview is not None:
                element = self._base(box.as_dict(), 0, "image")
                element.update({"src": preview, "fit": "fill", "alt": ole.get("name") or "", "sourceBox": None})
                return [element]
            kind = f"{kind} ({ole.get('progId') or 'unknown'})"
        self.report.unsupported[kind] += 1
        return [self._placeholder(box.as_dict(), kind, "not imported")]

    def ole_preview(self, ole: ET.Element, part: str) -> str | None:
        """The rendered picture of a legacy OLE object, via the slide's VML drawing."""
        spid = ole.get("spid")
        if not spid:
            return None
        for target, kind, external in self.pkg.rels(part).values():
            if external or not kind.endswith("/vmlDrawing") or not self.pkg.has(target):
                continue
            try:
                vml = self.pkg.read(target).decode("utf8", "replace")
            except Exception:
                continue
            match = re.search(
                r"<v:shape[^>]*\bid=\"" + re.escape(spid) + r"\"[^>]*>(.*?)</v:shape>", vml, re.S
            )
            if match is None:
                continue
            image = re.search(r"<v:imagedata[^>]*\bo:relid=\"([^\"]+)\"", match.group(1))
            if image is None:
                continue
            resolved = self.pkg.target(target, image.group(1))
            if resolved is None or resolved[1]:
                continue
            return self.copy_media(resolved[0])
        return None

    def convert_table(self, table: ET.Element, slide: SlideContext, part: str, box: Box) -> dict[str, Any] | None:
        grid = children(child(table, "a:tblGrid"), "a:gridCol")
        widths = [max(1.0, self.emu_to_px(attr_int(col, "w", 0) or 0)) for col in grid]
        if not widths:
            return None
        rows = children(table, "a:tr")
        if not rows:
            return None
        sources: list[ET.Element | None] = [self.default_text_style]
        inheritance = TextInheritance(sources, slide.ctx)
        converter = TextConverter(self, slide.ctx, inheritance, slide.theme, 1.0, slide.number, None)
        base_size: float | None = None
        row_html: list[str] = []
        for row in rows:
            cells: list[str] = []
            row_height = attr_int(row, "h")
            row_attr = f' style="height: {self.emu_to_px(row_height):.1f}px"' if row_height else ""
            for cell in children(row, "a:tc"):
                if attr_bool(cell, "hMerge") or attr_bool(cell, "vMerge"):
                    continue
                css: dict[str, str] = {}
                tcpr = child(cell, "a:tcPr")
                fill = read_fill(tcpr, slide.ctx, part)
                if fill is not None and fill.kind in ("solid", "gradient"):
                    css["background"] = fill.css if fill.kind == "gradient" else (css_color(fill.color) or "")
                for side in ("lnL", "lnR", "lnT", "lnB"):
                    ln = read_line(child(tcpr, f"a:{side}"), slide.ctx)
                    if ln and ln.fill and ln.fill.kind == "solid" and ln.fill.color:
                        edge = {"lnL": "left", "lnR": "right", "lnT": "top", "lnB": "bottom"}[side]
                        css[f"border-{edge}"] = f"{self.stroke_width_px(ln):.1f}px solid {css_color(ln.fill.color)}"
                attrs = ""
                span = attr_int(cell, "gridSpan")
                if span and span > 1:
                    attrs += f' colspan="{span}"'
                rspan = attr_int(cell, "rowSpan")
                if rspan and rspan > 1:
                    attrs += f' rowspan="{rspan}"'
                tx = child(cell, "a:txBody")
                converted = converter.convert(tx, box.w) if tx is not None else None
                inner = ""
                if converted is not None:
                    inner = converted["html"]
                    if base_size is None:
                        base_size = converted["size_px"]
                    elif abs(converted["size_px"] - base_size) >= 0.5:
                        css["font-size"] = f"{converted['size_px']:.0f}px"
                    if converted["align"] != "left":
                        css["text-align"] = converted["align"]
                    color = converted["style"].get("color")
                    if color:
                        css["color"] = color
                    if converted["style"].get("font-weight") == "700":
                        css["font-weight"] = "700"
                cells.append(f"<td{attrs}{_style_attr(css)}>{inner or '<br>'}</td>")
            row_html.append(f"<tr{row_attr}>{''.join(cells)}</tr>")
        element = self._base(box.as_dict(), 0, "text")
        element.update({
            "html": f"<table>{''.join(row_html)}</table>",
            "table": {"columnWidths": widths, "autoHeight": True},
            "autoFit": False,
            "align": "left",
            "valign": "top",
            "class": ["pp-text", "pp-table"],
            "style": {
                "font-size": f"{base_size or self.pt_to_px(DEFAULT_FONT_SIZE_PT):.0f}px",
                "font-family": _font_family_css(slide.theme.minor_font),
            },
        })
        return element

    # --- element scaffolding ------------------------------------------------

    def _placeholder(self, box: dict[str, float], original: str, note: str) -> dict[str, Any]:
        element = self._base(box, 0, "unsupported")
        element.update({"originalType": original, "note": f"{original}{': ' + note if note else ''}"})
        return element

    def _base(self, box: dict[str, float], z: int, kind: str) -> dict[str, Any]:
        return {
            "id": self.next_id(kind),
            "type": kind,
            "x": round(box["x"], 2),
            "y": round(box["y"], 2),
            "w": round(max(1.0, box["w"]), 2),
            "h": round(max(1.0, box["h"]), 2),
            "rot": round(box.get("rot", 0.0), 2),
            "z": z,
            "opacity": 1,
            "class": [],
            "style": {},
        }

    # --- slides -------------------------------------------------------------

    def slide_background(self, slide: SlideContext) -> dict[str, Any]:
        """Resolve the background from the slide, its layout, then its master."""
        for source in (slide.part, slide.layout, slide.master):
            if source is None:
                continue
            bg = child(self.pkg.xml(source), "p:cSld", "p:bg")
            if bg is None:
                continue
            props = child(bg, "p:bgPr")
            fill: Fill | None = None
            if props is not None:
                fill = read_fill(props, slide.ctx, source)
            ref = child(bg, "p:bgRef")
            if fill is None and ref is not None:
                idx = attr_int(ref, "idx", 0) or 0
                ph_color = _first_color(ref, slide.ctx)
                styles = slide.theme.bg_fill_styles if idx >= 1001 else slide.theme.fill_styles
                position = idx - 1001 if idx >= 1001 else idx - 1
                if 0 <= position < len(styles):
                    wrapper = ET.Element("wrapper")
                    wrapper.append(styles[position])
                    fill = read_fill(wrapper, ColorContext(slide.theme.colors, slide.ctx.clr_map, ph_color), source)
                elif ph_color is not None:
                    fill = Fill("solid", ph_color)
            if fill is None:
                continue
            if fill.kind == "image" and fill.blip:
                target = self.pkg.target(source, fill.blip)
                if target and not target[1]:
                    src = self.copy_media(target[0])
                    if src:
                        return {"color": None, "image": src}
                continue
            if fill.kind == "gradient" and fill.css:
                return {"color": fill.css, "image": None}
            if fill.kind in ("solid", "pattern") and fill.color:
                return {"color": css_color(fill.color), "image": None}
            if fill.kind == "none":
                continue
        return {"color": "#ffffff", "image": None}

    def convert_slide(self, part: str, index: int) -> dict[str, Any]:
        slide = self.slide_context(part, index + 1)
        root = self.pkg.xml(part)
        elements: list[dict[str, Any]] = []

        background = self.slide_background(slide)
        if background["image"]:
            width, height = self.canvas
            bg_element = self._base({"x": 0.0, "y": 0.0, "w": width, "h": height, "rot": 0.0}, 0, "image")
            bg_element.update({"src": background["image"], "fit": "fill", "alt": "", "sourceBox": None})
            elements.append(bg_element)
            background = {"color": "#ffffff", "image": None}

        # Decoration PowerPoint paints from the master and layout — logos,
        # footers' rules, coloured bands — is imported onto every slide as
        # ordinary objects, tagged `.pp-layout`, so the slide looks the same
        # and the objects can be removed in one selection if unwanted.
        show_master = attr_bool(root, "showMasterSp", True)
        if show_master:
            layout_root = self.pkg.xml(slide.layout) if slide.layout else None
            if slide.master and attr_bool(layout_root, "showMasterSp", True):
                tree = child(self.pkg.xml(slide.master), "p:cSld", "p:spTree")
                elements.extend(self.convert_shape_tree(tree, slide, slide.master, [], True, True))
            if slide.layout:
                tree = child(layout_root, "p:cSld", "p:spTree")
                elements.extend(self.convert_shape_tree(tree, slide, slide.layout, [], True, True))

        tree = child(root, "p:cSld", "p:spTree")
        elements.extend(self.convert_shape_tree(tree, slide, part, [], False, False))

        for paint_order, element in enumerate(elements):
            element["z"] = paint_order

        c_sld = child(root, "p:cSld")
        name = (c_sld.get("name") if c_sld is not None else "") or ""
        out: dict[str, Any] = {
            "id": f"slide-{index + 1}",
            "name": name or f"Slide {index + 1}",
            "background": background,
            "notes": self.slide_notes(part),
            "elements": elements,
            # Animations are not imported: PowerPoint's timing tree does not
            # map onto the step model without guessing. Everything lands visible.
            "timeline": [],
        }
        if root.get("show") == "0":
            out["skipped"] = True
        return out

    def slide_notes(self, part: str) -> str:
        notes = self.pkg.related(part, REL_NOTES)
        if not notes or not self.pkg.has(notes[0]):
            return ""
        try:
            tree = child(self.pkg.xml(notes[0]), "p:cSld", "p:spTree")
            for sp in self.iter_shapes(tree):
                ph = self.placeholder_of(sp)
                if ph is not None and ph.get("type") == "body":
                    return self.plain_text(child(sp, "p:txBody"))
        except Exception:
            return ""
        return ""

    @staticmethod
    def plain_text(tx_body: ET.Element | None) -> str:
        if tx_body is None:
            return ""
        paragraphs: list[str] = []
        for p in children(tx_body, "a:p"):
            parts: list[str] = []
            for node in p:
                name = local(node)
                if name in ("r", "fld"):
                    t = child(node, "a:t")
                    parts.append((t.text if t is not None else "") or "")
                elif name == "br":
                    parts.append("\n")
            paragraphs.append("".join(parts))
        return "\n".join(paragraphs).strip()


# --- role classification (shared logic with the Keynote importer) -----------


def _classify_text_roles(slides: list[dict[str, Any]]) -> None:
    """Tag every text element with a semantic role class.

    Placeholder identity is authoritative: title placeholders are `title`,
    body placeholders `body`. Everything else is classified by font size
    relative to the deck's typical body size, which the placeholders anchor.
    """
    def size_of(el: dict[str, Any]) -> float:
        try:
            return float(str(el["style"].get("font-size", "0")).rstrip("px"))
        except ValueError:
            return 0.0

    def text_len(el: dict[str, Any]) -> int:
        return len(re.sub(r"<[^>]+>", "", el.get("html", "")).strip())

    def set_role(el: dict[str, Any], role: str) -> None:
        el["class"] = [c for c in el["class"] if not c.startswith("role-")]
        if role != "base":
            el["class"].append(f"role-{role}")

    body_sizes: list[float] = []
    texts: list[dict[str, Any]] = []
    for slide in slides:
        for el in slide["elements"]:
            if el["type"] != "text":
                continue
            role = el.pop("_kn_role", None)
            if el.get("table"):
                continue
            if role is not None:
                set_role(el, role)
                if role == "body" and size_of(el) > 0:
                    body_sizes.append(size_of(el))
            else:
                texts.append(el)

    if body_sizes:
        body_sizes.sort()
        body_scale = body_sizes[len(body_sizes) // 2]
        for el in texts:
            size = size_of(el) or body_scale
            ratio = size / body_scale
            if ratio >= 1.15 and text_len(el) < 3:
                role = "base"
            elif ratio >= 1.45:
                role = "title"
            elif ratio >= 1.15:
                role = "heading"
            elif ratio >= 0.6:
                role = "body"
            else:
                role = "caption"
            set_role(el, role)
        return

    sizes = [size_of(el) for el in texts if text_len(el) >= 3]
    max_size = max(sizes, default=0.0)
    if max_size <= 0:
        return
    for el in texts:
        size = size_of(el)
        if text_len(el) < 3 and size > max_size:
            set_role(el, "base")
            continue
        ratio = (size or max_size * 0.5) / max_size
        if ratio >= 0.85:
            role = "title"
        elif ratio >= 0.6:
            role = "heading"
        elif ratio >= 0.38:
            role = "body"
        elif ratio <= 0.3:
            role = "caption"
        else:
            role = "base"
        set_role(el, role)


def _video_codec(path: Path) -> str | None:
    if shutil.which("ffprobe") is None:
        return None
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name",
             "-of", "csv=p=0", str(path)],
            check=True, capture_output=True, timeout=60,
        )
        return out.stdout.decode().strip().splitlines()[0].strip() or None
    except Exception:
        return None


THEME_CSS = """/*
 * Imported from PowerPoint. Layout-critical text face, size and paint are kept
 * as inline values; remove them from an element to style it entirely from here.
 *
 * Imported text carries the class .pp-text and an inline font-size matching
 * the point size it had in PowerPoint. Delete those inline sizes once you have
 * styled .pp-text the way you want. Objects that came from the slide master or
 * layout carry .pp-layout as well.
 */

.slide {
  background: #ffffff;
  color: #111111;
  font-family: Calibri, "Carlito", "Helvetica Neue", Inter, system-ui, sans-serif;
}

.pp-text {
  line-height: 1.2;
}

/* Semantic defaults for text boxes created after import. Imported PowerPoint
 * text keeps its own inline size, so these do not disturb the source slides. */
.role-title {
  font-size: 92px;
  font-weight: 700;
  line-height: 1.08;
  letter-spacing: -0.02em;
}

.role-heading {
  font-size: 58px;
  font-weight: 600;
  line-height: 1.15;
}

.role-body {
  font-size: 44px;
  line-height: 1.3;
}

.role-caption {
  font-size: 28px;
  line-height: 1.3;
}
"""


def import_pptx(
    path: Path,
    out_dir: Path,
    write: bool,
    progress: Progress | None = None,
) -> tuple[dict[str, Any], Report]:
    report = Report()
    progress = progress or SilentProgress()
    size = path.stat().st_size if path.is_file() else 0
    progress.phase(f"Opening {path.name}" + (f" ({_human_bytes(size)})" if size else ""), OPEN_SPAN[0])
    try:
        pkg = Package(path)
    except zipfile.BadZipFile:
        raise SystemExit(f"{path} is not a PowerPoint package (not a zip file)")
    try:
        progress.phase(f"Reading {path.name}", OPEN_SPAN[1])
        presentation_part = None
        for target, kind, _ in pkg.rels("").values() if pkg.has("_rels/.rels") else []:
            if kind.endswith("/officeDocument"):
                presentation_part = target
        if presentation_part is None or not pkg.has(presentation_part):
            presentation_part = "ppt/presentation.xml"
        if not pkg.has(presentation_part):
            raise SystemExit(f"No presentation part in {path}: this may not be a PowerPoint file")
        presentation = pkg.xml(presentation_part)

        sld_sz = child(presentation, "p:sldSz")
        cx = attr_int(sld_sz, "cx", 12192000) or 12192000
        cy = attr_int(sld_sz, "cy", 6858000) or 6858000
        scale = CANVAS_WIDTH / cx
        canvas = (CANVAS_WIDTH, round(cy * scale, 2))

        rels = pkg.rels(presentation_part)
        slide_parts: list[str] = []
        for sld in children(child(presentation, "p:sldIdLst"), "p:sldId"):
            entry = rels.get(sld.get(R_ID) or "")
            if entry and pkg.has(entry[0]):
                slide_parts.append(entry[0])
        if not slide_parts:
            report.warn("The presentation lists no slides")

        importer = Importer(
            pkg=pkg,
            out_dir=out_dir,
            report=report,
            scale=scale,
            canvas=canvas,
            default_text_style=child(presentation, "p:defaultTextStyle"),
            dry_run=not write,
            progress=progress,
        )

        progress.phase("Reading masters and layouts", LOAD_SPAN[1])
        slides: list[dict[str, Any]] = []
        stride = progress.stride(len(slide_parts))
        for index, part in enumerate(slide_parts):
            if index % stride == 0:
                progress.step(f"Converting slide {index + 1} of {len(slide_parts)}", index, len(slide_parts), SLIDE_SPAN)
            try:
                slides.append(importer.convert_slide(part, index))
            except Exception as exc:
                report.warn(f"Slide {index + 1} failed: {exc}")
                report.unsupported["<slide>"] += 1
                slides.append({
                    "id": f"slide-{index + 1}",
                    "name": f"Slide {index + 1} (failed to import)",
                    "background": {"color": "#ffffff", "image": None},
                    "notes": "",
                    "elements": [],
                    "timeline": [],
                })

        progress.phase("Classifying text roles", SLIDE_SPAN[1])
        _classify_text_roles(slides)

        report.slides = len(slides)
        report.elements = sum(len(s["elements"]) for s in slides)

        deck = {
            "version": 1,
            "title": path.stem,
            "canvas": {"w": canvas[0], "h": canvas[1]},
            "theme": "theme.css",
            "slides": slides,
        }

        if write:
            progress.phase(f"Writing {out_dir.name}/deck.json", 0.97)
            out_dir.mkdir(parents=True, exist_ok=True)
            (out_dir / "assets").mkdir(exist_ok=True)
            (out_dir / "edit").mkdir(exist_ok=True)
            (out_dir / "deck.json").write_text(json.dumps(deck, indent=2) + "\n", encoding="utf8")
            theme_path = out_dir / "theme.css"
            if not theme_path.exists():
                progress.phase(f"Writing {out_dir.name}/theme.css", 0.99)
                theme_path.write_text(THEME_CSS, encoding="utf8")
        return deck, report
    finally:
        pkg.close()


def self_check() -> int:
    """Import every module an import can reach, then exit.

    Several of them are imported lazily and only warn when missing, so a broken
    environment would otherwise surface as a failed or quietly degraded import
    of somebody's deck. The collab server, `npm install` and build:importer run
    this first and refuse to go on when it fails.
    """
    import importlib

    missing = []
    for module in ('PIL.Image',):
        try:
            importlib.import_module(module)
        except ImportError as exc:
            missing.append(f"{module} ({exc})")
    if missing:
        sys.stderr.write(
            "The PowerPoint importer cannot load: " + "; ".join(missing)
            + "\nRun: npm run setup:importers\n"
        )
        return 1
    sys.stdout.write("ok\n")
    return 0


def main(argv: list[str]) -> int:
    if argv == ["--self-check"]:
        return self_check()
    parser = argparse.ArgumentParser(description="Import a PowerPoint .pptx file.")
    parser.add_argument("input", type=Path, help="Path to a .pptx file")
    parser.add_argument("--out", type=Path, help="Deck folder to create")
    parser.add_argument("--report", action="store_true",
                        help="Analyse only: print a coverage report without writing anything")
    args = parser.parse_args(argv)

    if not args.input.exists():
        sys.stderr.write(f"No such file: {args.input}\n")
        return 2
    if not args.report and args.out is None:
        sys.stderr.write("--out is required unless --report is given\n")
        return 2

    out_dir = args.out or Path(os.devnull)
    try:
        with redirect_stdout(sys.stderr):
            deck, report = import_pptx(
                args.input, out_dir, write=not args.report,
                progress=SilentProgress() if args.report else Progress(),
            )
    except SystemExit as exc:
        sys.stderr.write(f"{exc}\n")
        return 1
    except Exception:
        traceback.print_exc()
        return 1

    json.dump({"dir": str(out_dir), "report": report.to_dict(), "deck": deck if not args.report else None}, sys.stdout)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
