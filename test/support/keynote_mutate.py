"""Damaged and altered copies of reference.key, for the importer's robustness
cases. Run with the importer venv's Python from the repository root:

    keynote_mutate.py <kind> <reference.key> <out.key>

kind is one of:
  corrupt-stream    one slide's .iwa stream replaced by garbage
  missing-slide     one slide's stream deleted, so its archive is missing
  no-metadata       Index/Metadata.iwa (the data file table) removed
  canvas-4x3        the show resized to 1024x768
"""

import sys
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path.cwd() / "test" / "fixtures" / "keynote"))

from keynote_builder import KeynoteBuilder  # noqa: E402


def slide_stream(slide_name: str, source: Path) -> str:
    """The Index/Slide-<id>.iwa holding the slide called `slide_name`."""
    deck = KeynoteBuilder(source)
    for node_ref in deck.show["slideTree"]["slides"]:
        node = deck.object(int(node_ref["identifier"]))
        slide_id = node["slide"]["identifier"]
        if deck.object(int(slide_id)).get("name") == slide_name:
            return f"Index/Slide-{slide_id}.iwa"
    raise SystemExit(f"no slide named {slide_name}")


def rewrite(source: Path, target: Path, change) -> None:
    with zipfile.ZipFile(source) as zin, zipfile.ZipFile(target, "w", zipfile.ZIP_STORED) as zout:
        for info in zin.infolist():
            data = change(info.filename, zin.read(info))
            if data is not None:
                zout.writestr(info, data)


def main(kind: str, source: Path, target: Path) -> None:
    if kind == "canvas-4x3":
        deck = KeynoteBuilder(source)
        deck.show["size"] = {"width": 1024.0, "height": 768.0}
        deck.write(target)
        return
    if kind == "no-metadata":
        rewrite(source, target, lambda name, data: None if name == "Index/Metadata.iwa" else data)
        return
    victim = slide_stream("z-order", source)
    if kind == "corrupt-stream":
        rewrite(source, target, lambda name, data: b"\x00not snappy\xff" * 8 if name == victim else data)
    elif kind == "missing-slide":
        rewrite(source, target, lambda name, data: None if name == victim else data)
    else:
        raise SystemExit(f"unknown kind {kind}")


if __name__ == "__main__":
    main(sys.argv[1], Path(sys.argv[2]), Path(sys.argv[3]))
