"""Keynote text structures, built in protobuf and run through the importer.

The regressions these pin down came from a real talk (MilliVid, Oct 2026)
that cannot be checked in, so each case rebuilds the exact archive shapes it
used, with the same style values, and prints what the importer made of them
as one JSON object for test/keynoteImport.test.ts to assert on.

Run from the repository root with the importer venv's Python.
"""

import importlib
import json
import pkgutil
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path.cwd()))

import keynote_parser.versions as versions  # noqa: E402
from google.protobuf import text_format  # noqa: E402

import importers.keynote.import_keynote as k  # noqa: E402

NEWEST = max(module.name for module in pkgutil.iter_modules(versions.__path__))
TSWP = importlib.import_module(f"keynote_parser.versions.{NEWEST}.generated.TSWPArchives_pb2")


def message(cls, text):
    return text_format.Parse(text, cls())


def para_style(size, font, bold=None, extra=""):
    bold_field = f"bold: {str(bold).lower()}" if bold is not None else ""
    return message(TSWP.ParagraphStyleArchive, f"""
        char_properties {{ font_size: {size} font_name: "{font}" {bold_field} }} {extra}
    """)


def char_style(fields):
    return message(TSWP.CharacterStyleArchive, f"char_properties {{ {fields} }}")


def numbered(levels):
    labels = " ".join("label_types: kNumber" if n < levels else "label_types: kNone" for n in range(9))
    return message(TSWP.ListStyleArchive, f"super {{ parent {{ identifier: 31 }} }} {labels}")


def entries(pairs):
    out = []
    for index, ident in pairs:
        target = f"object {{ identifier: {ident} }}" if ident else ""
        out.append(f"entries {{ character_index: {index} {target} }}")
    return " ".join(out)


def storage(text, paras, chars=(), lists=(), levels=(), starts=()):
    data = " ".join(f"entries {{ character_index: {i} first: {v} second: 0 }}" for i, v in levels)
    begun = " ".join(f"entries {{ character_index: {i} first: {v} second: 0 }}" for i, v in starts)
    return message(TSWP.StorageArchive, f"""
        text: {json.dumps(text)}
        table_para_style {{ {entries(paras)} }}
        table_char_style {{ {entries(chars)} }}
        table_list_style {{ {entries(lists)} }}
        table_para_data {{ {data} }}
        table_para_starts {{ {begun} }}
    """)


def text_shape(storage_id, x, y, w, h):
    return message(TSWP.ShapeInfoArchive, f"""
        super {{ super {{ geometry {{
            position {{ x: {x} y: {y} }} size {{ width: {w} height: {h} }} angle: 0.0
        }} }} }}
        owned_storage {{ identifier: {storage_id} }}
        is_text_box: true
    """)


def title_slide_objects():
    """Slide 1: an 80pt bold title over 48pt light author lines.

    Paragraph-style entries without an object (author lines 2 and 3, the
    blank line) continue the style before them; affiliation numbers are a
    superscript character style; the title's second half un-bolds the bold
    face with `bold: false`. The title styles track -2%; the affiliations
    have 24pt of space after them, which sets the footnote apart.
    """
    text = ("MilliVid: Hierarchical Latents\n\nAlice*1, Bob*1\nCarol2\n\n"
            "1MIT          2TRI\n*Equal contribution")
    authors = text.index("Alice")
    blank = text.index("\n\n1MIT") + 1
    affiliations = text.index("1MIT")
    objects = {
        10: storage(
            text,
            paras=[(0, 20), (text.index("\n\nAlice") + 1, 21), (authors, 22),
                   (text.index("Carol"), None), (blank, None), (affiliations, 23),
                   (text.index("*Equal"), None)],
            chars=[(0, None), (9, 30), (authors, None),
                   (text.index("1,"), 31), (text.index("1,") + 1, None),
                   (affiliations, 31), (affiliations + 1, None)],
        ),
        20: para_style(80, "HelveticaNeue-Bold", bold=True),
        21: para_style(48, "HelveticaNeue-Bold", bold=True),
        22: para_style(48, "HelveticaNeue-Light"),
        23: para_style(40, "HelveticaNeue-Light", extra="para_properties { space_after: 24 }"),
        30: char_style("bold: false"),
        31: char_style("superscript: kSuperscript"),
        40: text_shape(10, 95, 72, 1730, 779),
    }
    objects[20].char_properties.tracking = -0.02
    objects[21].char_properties.tracking = -0.02
    return objects


def title_slide():
    objects = title_slide_objects()
    base = k.resolve_text_style(objects, objects[40])
    return k.styled_text_to_html(objects, objects[40], base)


def title_slide_element():
    """The same box as the importer writes it: the element's own style."""
    objects = title_slide_objects()
    with tempfile.TemporaryDirectory() as tmp:
        importer = k.Importer(objects, {}, None, Path(tmp), k.Report(), canvas=(1920, 1080))
        [element] = importer._convert_shape(objects[40], importer._box(k.find_geometry(objects[40]), (0, 0)), 0)
    return {"html": element["html"], "style": element["style"]}


def line_spacing_body():
    """Slide 53: 0.9-line body text with a 20pt gap before its second part."""
    text = "Existing datasets fall short\nWe generate our own"
    objects = {
        10: storage(text, paras=[(0, 20), (text.index("We"), 21)]),
        20: para_style(48, "HelveticaNeue", extra="para_properties { line_spacing { amount: 0.9 } }"),
        21: para_style(48, "HelveticaNeue",
                       extra="para_properties { line_spacing { amount: 0.9 } space_before: 24 }"),
        40: text_shape(10, 95, 216, 1730, 400),
    }
    with tempfile.TemporaryDirectory() as tmp:
        importer = k.Importer(objects, {}, None, Path(tmp), k.Report(), canvas=(1920, 1080))
        [element] = importer._convert_shape(objects[40], importer._box(k.find_geometry(objects[40]), (0, 0)), 0)
    return {"html": element["html"], "style": element["style"]}


def rollout_list():
    """Slide 41: an underlined heading over a numbered staircase.

    Levels 0, 1, 2, 2, 1 with explicit starts 2, 3 and 5; the list styles
    number one, two and three levels; the last two paragraphs carry the
    previous list style forward; keywords switch to the Medium face.
    """
    lines = ["MilliVid's Rollout Strategy", "Predict a long sequence",
             "Predict a medium sequence", "Predict a short sequence",
             "Repeat…", "Repeat…"]
    text = "\n".join(lines)
    at = [sum(len(line) + 1 for line in lines[:n]) for n in range(len(lines))]
    long_word = text.index("long")
    objects = {
        10: storage(
            text,
            paras=[(0, 20), (at[1], 21), (at[2], None), (at[3], None), (at[4], None), (at[5], None)],
            chars=[(0, None), (long_word, 30), (long_word + 4, None)],
            lists=[(0, 31), (at[1], 32), (at[2], 33), (at[3], 34)],
            levels=[(0, 0), (at[2], 1), (at[3], 2), (at[5], 1)],
            starts=[(0, 0), (at[2], 2), (at[3], 3), (at[4], 0), (at[5], 5)],
        ),
        20: para_style(60, "HelveticaNeue-Light"),
        21: para_style(60, "HelveticaNeue-Light"),
        30: char_style('font_name: "HelveticaNeue-Medium"'),
        31: message(TSWP.ListStyleArchive, " ".join(
            ["label_types: kNone"] * 9 + [f"indents: {36.0 * n}" for n in range(9)])),
        32: numbered(1),
        33: numbered(2),
        34: numbered(3),
        40: text_shape(10, 95, 216, 1730, 768),
    }
    objects[20].char_properties.underline = TSWP.CharacterStylePropertiesArchive.DESCRIPTOR \
        .fields_by_name["underline"].enum_type.values_by_name["kSingleUnderline"].number
    with tempfile.TemporaryDirectory() as tmp:
        importer = k.Importer(objects, {}, None, Path(tmp), k.Report(), canvas=(1920, 1080))
        [element] = importer._convert_shape(objects[40], importer._box(k.find_geometry(objects[40]), (0, 0)), 0)
    return {"html": element["html"], "paragraphSpacing": element.get("paragraphSpacing")}


def rotated_label(valign):
    """Slide 21's "Detail →": sized to its text both ways, turned 90° anticlockwise."""
    with tempfile.TemporaryDirectory() as tmp:
        importer = k.Importer({}, {}, None, Path(tmp), k.Report(), canvas=(1920, 1080))
        box = importer._size_text_box(
            {"x": 77.53, "y": 870.85, "w": 0.0, "h": 0.0, "rot": -90.0},
            "Detail →", 32.0, "left", valign, (134.66, 46.19), "HelveticaNeue-Medium", False, 8.0,
        )
    return {**box, "cx": box["x"] + box["w"] / 2, "cy": box["y"] + box["h"] / 2}


def empty_boxes():
    """Slide 21's three stray clicks: empty text boxes sized to (no) content."""
    objects = {
        10: storage("", paras=[(0, 20)]),
        20: para_style(12, "Times-Roman"),
        40: text_shape(10, 954, 540, 0, 0),
        41: text_shape(10, 300, 300, 400, 100),
    }
    out = {}
    with tempfile.TemporaryDirectory() as tmp:
        importer = k.Importer(objects, {}, None, Path(tmp), k.Report(), canvas=(1920, 1080))
        for name, ident in (("zeroSize", 40), ("sized", 41)):
            converted = importer._convert_shape(
                objects[ident], importer._box(k.find_geometry(objects[ident]), (0, 0)), 0)
            out[name] = [element["html"] for element in converted]
    return out


def components_list():
    """Slide 5: numbered items at level 0, each explained one level deeper.

    The explanations are unnumbered, so the count must carry on past them:
    Keynote shows 1. and 2., not 1. and 1. again.
    """
    lines = ["Two components:", "Encoder", "Packs history.", "", "Rollout", "Uses history."]
    text = "\n".join(lines)
    at = [sum(len(line) + 1 for line in lines[:n]) for n in range(len(lines))]
    objects = {
        10: storage(
            text,
            paras=[(0, 20)],
            lists=[(0, 31), (at[1], 32), (at[2], 31), (at[4], 32), (at[5], 31)],
            levels=[(0, 0), (at[2], 1), (at[4], 0), (at[5], 1)],
            starts=[(0, 0)],
        ),
        20: para_style(60, "HelveticaNeue-Light"),
        31: message(TSWP.ListStyleArchive, " ".join(["label_types: kNone"] * 9)),
        32: numbered(1),
        40: text_shape(10, 95, 216, 1730, 768),
    }
    return k.styled_text_to_html(objects, objects[40], k.resolve_text_style(objects, objects[40]))


def partial_underline():
    """Slide 57: the paragraph style underlines; the runs after the first
    word switch it off again, so only "Token-matched" is underlined."""
    text = "Token-matched Full-Resolution Rollout"
    objects = {
        10: storage(text, paras=[(0, 20)], chars=[(0, None), (13, 30)]),
        20: para_style(60, "HelveticaNeue-Light"),
        30: char_style("underline: kNoUnderline"),
        40: text_shape(10, 95, 216, 1730, 100),
    }
    objects[20].char_properties.underline = TSWP.CharacterStylePropertiesArchive.DESCRIPTOR \
        .fields_by_name["underline"].enum_type.values_by_name["kSingleUnderline"].number
    return k.styled_text_to_html(objects, objects[40], k.resolve_text_style(objects, objects[40]))


def outlined_frame():
    """Slide 13: a 5pt red frame drawn as a plain four-corner bezier path,
    sized exactly to the 200x200 reconstruction it highlights."""
    corners = " ".join(
        f"elements {{ type: {kind} points {{ x: {x} y: {y} }} }}"
        for kind, x, y in (("moveTo", 0, 0), ("lineTo", 200, 0),
                           ("lineTo", 200, 200), ("lineTo", 0, 200)))
    objects = {
        50: message(TSWP.ShapeStyleArchive, """
            super { shape_properties {
                fill { }
                stroke {
                    color { model: rgb r: 0.932 g: 0.135 b: 0.047 a: 1 }
                    width: 5 cap: ButtCap join: MiterJoin miter_limit: 4
                    pattern { type: TSDSolidPattern phase: 0 count: 0 }
                }
            } }
        """),
        60: message(TSWP.ShapeInfoArchive, f"""
            super {{
                super {{ geometry {{
                    position {{ x: 97 y: 767 }} size {{ width: 200 height: 200 }} angle: 0.0
                }} }}
                style {{ identifier: 50 }}
                pathsource {{ bezier_path_source {{
                    naturalSize {{ width: 200 height: 200 }}
                    path {{ {corners} elements {{ type: closeSubpath }} }}
                }} }}
            }}
            is_text_box: false
        """),
    }
    with tempfile.TemporaryDirectory() as tmp:
        importer = k.Importer(objects, {}, None, Path(tmp), k.Report(), canvas=(1920, 1080))
        [element] = importer._convert_shape(
            objects[60], importer._box(k.find_geometry(objects[60]), (0, 0)), 0)
    return {key: element[key] for key in ("shape", "x", "y", "w", "h", "stroke", "strokeWidth", "fill")}


def move_build():
    """Slide 11: "Latents 16x16" and its column move left on a click (two
    Keynote Move builds, the second automatic) to make room for 8x8."""
    def box(ident, x):
        return {"id": ident, "type": "text", "x": x, "y": 500.0, "w": 180.0, "h": 60.0,
                "rot": 0.0, "z": 0, "html": ident}

    def build(ident, on, kind, target):
        return {"id": ident, "trigger": {"on": on, "ref": None, "delay": 0},
                "action": {"type": kind, "target": target, "value": None}}

    def move(on, targets, dx):
        return {"id": k.MOVE_ACTION, "trigger": {"on": on, "ref": None, "delay": 0},
                "action": {"type": k.MOVE_ACTION, "targets": targets, "dx": dx, "dy": 0.0,
                           "duration": 1.0}}

    slide = {
        "id": "slide-11", "name": "Slide 11", "notes": "n",
        "background": {"color": "#ffffff", "image": None},
        "elements": [box("title", 95.0), box("gt", 440.0), box("label16", 447.0),
                     box("recon16", 440.0), box("label8", 331.0)],
        "timeline": [build("b1", "click", "appear", "gt"),
                     build("b2", "click", "appear", "label16"),
                     build("b3", "withPrev", "appear", "recon16"),
                     move("click", ["label16"], -346.0),
                     move("afterPrev", ["recon16"], -343.0),
                     build("b4", "click", "appear", "label8")],
    }
    return k.split_at_moves(slide)


print(json.dumps({
    "moveBuild": move_build(),
    "outlinedFrame": outlined_frame(),
    "titleSlide": title_slide(),
    "titleSlideElement": title_slide_element(),
    "lineSpacingBody": line_spacing_body(),
    "rolloutList": rollout_list(),
    "rotatedMiddle": rotated_label("middle"),
    "rotatedTop": rotated_label("top"),
    "emptyBoxes": empty_boxes(),
    "componentsList": components_list(),
    "partialUnderline": partial_underline(),
}))
