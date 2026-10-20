"""Write sample-paper.pdf: a one-page, letter-size stand-in for a paper.

A large bold title, an author line and an abstract in the top half, and the
rotated margin stamp arXiv adds — in a larger size than the title, which is
what the title guess in import_pptx.py's --pdf-first-page has to see past.
Run with the importer venv: .venv-import/bin/python test/fixtures/paper/make_sample_paper.py
"""
from pathlib import Path

import pymupdf

out = Path(__file__).with_name("sample-paper.pdf")
doc = pymupdf.open()
page = doc.new_page(width=612, height=792)
page.insert_text((72, 110), "Fixture Fields: A Paper", fontsize=20, fontname="hebo")
page.insert_text((72, 140), "Ada Example, Ben Sample, Cy Placeholder", fontsize=11)
abstract = ("Abstract. This page exists so the paper card tests can render a first page offline. "
            "Its title is the largest horizontal type in the top half of the page.")
page.insert_textbox(pymupdf.Rect(72, 170, 540, 260), abstract, fontsize=10)
page.insert_text((30, 600), "arXiv:2401.00001v1 [cs.CV] 1 Jan 2024", fontsize=24, rotate=90)
page.insert_text((72, 700), "Body text below the crop line.", fontsize=10)
doc.set_metadata({"title": "", "author": ""})
doc.save(out, garbage=4, deflate=True)
print(out, out.stat().st_size)
