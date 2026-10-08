#!/usr/bin/env python3
"""Generate embedded.pptx: reference.pptx plus a slide of OLE-era content.

The slide holds the two things the importer used to flatten or drop:

* a bent arrow (`bentArrow`), which had no path and became a rectangle;
* an Acrobat document embedded as an OLE object, wrapped in
  `mc:AlternateContent` exactly as PowerPoint writes it, whose only preview
  is an EMF. Outside Windows that EMF needs Inkscape, so the object imported
  as an "Embedded object: not imported" placeholder.

The PDF is a single 200pt page filled with PDF_FILL. It sits in the compound
file's CONTENTS stream with its sectors deliberately out of order, so reading
it has to follow the FAT rather than scan for `%PDF`. The preview "EMF" is
not a valid metafile, so nothing but the PDF can produce the picture.

python-pptx is not needed; the slide is added to reference.pptx's zip
directly. Regenerate with the project venv (PyMuPDF writes the PDF):

    ./.venv-import/bin/python test/fixtures/pptx/make_embedded.py
"""

from __future__ import annotations

import re
import struct
import zipfile
from pathlib import Path

import pymupdf

HERE = Path(__file__).parent
SOURCE = HERE / "reference.pptx"
OUT = HERE / "embedded.pptx"

EMU_PER_INCH = 914400
PDF_FILL = (0x20, 0x80, 0xE0)

FREE, END, FATSECT, NOSTREAM = 0xFFFFFFFF, 0xFFFFFFFE, 0xFFFFFFFD, 0xFFFFFFFF


def make_pdf() -> bytes:
    doc = pymupdf.open()
    page = doc.new_page(width=200, height=200)
    page.draw_rect(page.rect, color=None, fill=[c / 255 for c in PDF_FILL])
    # Uncompressed filler keeps CONTENTS over the 4096-byte mini-stream
    # cutoff, so it is stored in (shuffled) regular sectors.
    for i in range(60):
        page.insert_text((4, 4 + i * 3), f"filler line {i:03d} " * 3, fontsize=1, color=[c / 255 for c in PDF_FILL])
    return doc.tobytes(garbage=0, deflate=False)


def compound_file(streams: list[tuple[str, bytes]]) -> bytes:
    """A version 3 (512-byte sector) compound file holding `streams` under the root."""
    sector, mini = 512, 64
    cutoff = 4096
    sectors: list[bytes] = []  # sector index -> contents
    fat: dict[int, int] = {}

    def allocate(count: int) -> list[int]:
        start = len(sectors)
        sectors.extend(b"" for _ in range(count))
        return list(range(start, start + count))

    def link(indices: list[int]) -> int:
        for a, b in zip(indices, indices[1:]):
            fat[a] = b
        if indices:
            fat[indices[-1]] = END
        return indices[0] if indices else END

    def pad(data: bytes, size: int) -> bytes:
        return data + b"\0" * (-len(data) % size)

    # Small streams go to the mini stream, large ones to regular sectors.
    mini_stream = b""
    mini_fat: list[int] = []
    placed: list[tuple[str, int, int]] = []
    large: list[tuple[str, bytes]] = []
    for name, data in streams:
        if len(data) < cutoff:
            first = len(mini_stream) // mini
            count = max(1, -(-len(data) // mini))
            mini_fat.extend(list(range(first + 1, first + count)) + [END])
            mini_stream += pad(data, mini)
            placed.append((name, first, len(data)))
        else:
            large.append((name, data))

    for name, data in large:
        chunks = [data[i:i + sector] for i in range(0, len(data), sector)]
        indices = allocate(len(chunks))
        # Store the chunks back to front: the chain, not the file order, is
        # what puts them together again.
        order = list(reversed(indices))
        for index, chunk in zip(order, chunks):
            sectors[index] = pad(chunk, sector)
        placed.append((name, link(order), len(data)))

    mini_indices = allocate(-(-len(mini_stream) // sector))
    for i, index in enumerate(mini_indices):
        sectors[index] = pad(mini_stream[i * sector:(i + 1) * sector], sector)
    root_start = link(mini_indices)

    mini_fat_bytes = pad(b"".join(struct.pack("<I", v) for v in mini_fat), sector)
    mini_fat_indices = allocate(len(mini_fat_bytes) // sector)
    for i, index in enumerate(mini_fat_indices):
        sectors[index] = mini_fat_bytes[i * sector:(i + 1) * sector]
    link(mini_fat_indices)

    def entry(name: str, kind: int, start: int, size: int, child: int = NOSTREAM, right: int = NOSTREAM) -> bytes:
        encoded = (name + "\0").encode("utf-16-le")
        return (encoded.ljust(64, b"\0") + struct.pack("<HBB", len(encoded), kind, 1)
                + struct.pack("<III", NOSTREAM, right, child) + b"\0" * 16 + struct.pack("<I", 0)
                + b"\0" * 16 + struct.pack("<IQ", start, size))

    names = [p[0] for p in placed]
    directory = entry("Root Entry", 5, root_start, len(mini_stream), child=1)
    for i, (name, start, size) in enumerate(placed):
        right = i + 2 if i + 1 < len(placed) else NOSTREAM
        directory += entry(name, 2, start, size, right=right)
    directory = pad(directory, sector)
    dir_indices = allocate(len(directory) // sector)
    for i, index in enumerate(dir_indices):
        sectors[index] = directory[i * sector:(i + 1) * sector]
    link(dir_indices)
    assert names, "no streams"

    # The FAT covers every sector, including its own.
    fat_count = 1
    while fat_count * (sector // 4) < len(sectors) + fat_count:
        fat_count += 1
    fat_indices = allocate(fat_count)
    for index in fat_indices:
        fat[index] = FATSECT
    table = [fat.get(i, FREE) for i in range(fat_count * (sector // 4))]
    fat_bytes = b"".join(struct.pack("<I", v) for v in table)
    for i, index in enumerate(fat_indices):
        sectors[index] = fat_bytes[i * sector:(i + 1) * sector]

    difat = fat_indices + [FREE] * (109 - len(fat_indices))
    header = (bytes.fromhex("d0cf11e0a1b11ae1") + b"\0" * 16
              + struct.pack("<HHHHH", 0x3E, 3, 0xFFFE, 9, 6) + b"\0" * 6
              + struct.pack("<IIIIIIIII", 0, fat_count, dir_indices[0], 0, cutoff,
                            mini_fat_indices[0], len(mini_fat_indices), END, 0)
              + b"".join(struct.pack("<I", v) for v in difat))
    assert len(header) == 512
    return header + b"".join(sectors)


def inches(value: float) -> int:
    return int(value * EMU_PER_INCH)


SLIDE = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006">
<p:cSld><p:spTree>
<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>
<p:sp><p:nvSpPr><p:cNvPr id="2" name="bent-arrow"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
<p:spPr><a:xfrm><a:off x="{arrow_x}" y="{arrow_y}"/><a:ext cx="{arrow_w}" cy="{arrow_h}"/></a:xfrm>
<a:prstGeom prst="bentArrow"><a:avLst/></a:prstGeom>
<a:solidFill><a:srgbClr val="156082"/></a:solidFill><a:ln><a:noFill/></a:ln></p:spPr></p:sp>
<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="3" name="pdf-object"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>
<p:xfrm><a:off x="{ole_x}" y="{ole_y}"/><a:ext cx="{ole_s}" cy="{ole_s}"/></p:xfrm>
<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/presentationml/2006/ole">
<mc:AlternateContent><mc:Choice xmlns:v="urn:schemas-microsoft-com:vml" Requires="v">
<p:oleObj name="Acrobat Document" r:id="rId2" imgW="{ole_s}" imgH="{ole_s}" progId="Acrobat.Document.DC"><p:embed/></p:oleObj>
</mc:Choice><mc:Fallback>
<p:oleObj name="Acrobat Document" r:id="rId2" imgW="{ole_s}" imgH="{ole_s}" progId="Acrobat.Document.DC"><p:embed/>
<p:pic><p:nvPicPr><p:cNvPr id="3" name="pdf-object"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>
<p:blipFill><a:blip r:embed="rId3"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>
<p:spPr><a:xfrm><a:off x="{ole_x}" y="{ole_y}"/><a:ext cx="{ole_s}" cy="{ole_s}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>
</p:oleObj></mc:Fallback></mc:AlternateContent>
</a:graphicData></a:graphic></p:graphicFrame>
</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>
"""

SLIDE_RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="{layout}"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/oleObject" Target="../embeddings/oleObject1.bin"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/oleObject1-preview.emf"/>
</Relationships>
"""


def main() -> None:
    with zipfile.ZipFile(SOURCE) as source:
        parts = {name: source.read(name) for name in source.namelist()}

    slide_numbers = [int(m.group(1)) for name in parts if (m := re.fullmatch(r"ppt/slides/slide(\d+)\.xml", name))]
    number = max(slide_numbers) + 1
    # Slide 2 of the reference deck uses the blank layout; so does this one.
    layout = re.search(rb'Target="([^"]*slideLayout\d+\.xml)"', parts["ppt/slides/_rels/slide2.xml.rels"]).group(1)

    parts[f"ppt/slides/slide{number}.xml"] = SLIDE.format(
        arrow_x=inches(1), arrow_y=inches(1), arrow_w=inches(2), arrow_h=inches(3),
        ole_x=inches(5), ole_y=inches(1), ole_s=inches(3),
    ).encode()
    parts[f"ppt/slides/_rels/slide{number}.xml.rels"] = SLIDE_RELS.format(layout=layout.decode()).encode()
    compobj = b"\x01\x00\xfe\xff\x03\x0a\x00\x00" + b"\xff" * 4 + b"\0" * 16 + b"Acrobat Document\0"
    parts["ppt/embeddings/oleObject1.bin"] = compound_file([("\x01CompObj", compobj), ("CONTENTS", make_pdf())])
    parts["ppt/media/oleObject1-preview.emf"] = b"not a metafile"

    types = parts["[Content_Types].xml"].decode()
    types = types.replace("</Types>", (
        '<Default Extension="bin" ContentType="application/vnd.openxmlformats-officedocument.oleObject"/>'
        '<Default Extension="emf" ContentType="image/x-emf"/>'
        f'<Override PartName="/ppt/slides/slide{number}.xml" '
        'ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>'))
    parts["[Content_Types].xml"] = types.encode()

    rels = parts["ppt/_rels/presentation.xml.rels"].decode()
    rel_ids = [int(i) for i in re.findall(r'Id="rId(\d+)"', rels)]
    rel_id = f"rId{max(rel_ids) + 1}"
    rels = rels.replace("</Relationships>", (
        f'<Relationship Id="{rel_id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" '
        f'Target="slides/slide{number}.xml"/></Relationships>'))
    parts["ppt/_rels/presentation.xml.rels"] = rels.encode()

    presentation = parts["ppt/presentation.xml"].decode()
    slide_id = max(int(i) for i in re.findall(r'<p:sldId id="(\d+)"', presentation)) + 1
    presentation = presentation.replace("</p:sldIdLst>", f'<p:sldId id="{slide_id}" r:id="{rel_id}"/></p:sldIdLst>')
    parts["ppt/presentation.xml"] = presentation.encode()

    with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as out:
        # [Content_Types].xml first, as Office writes it.
        out.writestr("[Content_Types].xml", parts.pop("[Content_Types].xml"))
        for name, data in parts.items():
            out.writestr(name, data)
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
