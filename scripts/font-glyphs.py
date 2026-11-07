#!/usr/bin/env python3
"""Adds the accented Latin letters pt-BR and es need to the launcher's pixel font.

The font (src/fonts/weft.woff2) is drawn on a grid of 100-unit pixels: lowercase is 5 rows tall,
capitals 7, and Cyrillic Ё is the font's own model for an accented capital (the letter one row
shorter, the mark above it). The marks here follow the same grid, two rows tall:

- lowercase: letter rows 0-4, a free row, the mark in rows 6-7;
- capitals: the letter squashed to 6 rows (one of its repeated rows dropped), a free row, the
  mark in rows 7-8;
- ç and Ç: the cedilla hangs in the two rows under the baseline;
- ¿ and ¡: ? and ! turned upside down, hanging one row lower, as Spanish sets them.

Glyphs the font already has are left alone, so running it twice changes nothing.

    python3 -m venv /tmp/ft && /tmp/ft/bin/pip install fonttools brotli
    /tmp/ft/bin/python scripts/font-glyphs.py
"""

import sys
from pathlib import Path

from fontTools.pens.pointInsidePen import PointInsidePen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import TTFont

PX = 100
FONT = Path(__file__).resolve().parent.parent / "src" / "fonts" / "weft.woff2"

# Marks, top row first, five pixels wide.
MARKS = {
    "acute": ["...#.", "..#.."],
    "grave": [".#...", "..#.."],
    "circumflex": ["..#..", ".#.#."],
    "tilde": [".##.#", "#.##."],
    "diaeresis": [".....", ".#.#."],
}
CEDILLA = ["..#..", ".#..."]

# (character, base, mark)
LETTERS = [
    ("á", "a", "acute"), ("à", "a", "grave"), ("â", "a", "circumflex"), ("ã", "a", "tilde"), ("ä", "a", "diaeresis"),
    ("é", "e", "acute"), ("è", "e", "grave"), ("ê", "e", "circumflex"),
    ("í", "ı", "acute"),
    ("ó", "o", "acute"), ("ò", "o", "grave"), ("ô", "o", "circumflex"), ("õ", "o", "tilde"), ("ö", "o", "diaeresis"),
    ("ú", "u", "acute"), ("ù", "u", "grave"), ("û", "u", "circumflex"), ("ü", "u", "diaeresis"),
    ("ñ", "n", "tilde"),
    ("Á", "A", "acute"), ("À", "A", "grave"), ("Â", "A", "circumflex"), ("Ã", "A", "tilde"), ("Ä", "A", "diaeresis"),
    ("É", "E", "acute"), ("Ê", "E", "circumflex"),
    ("Í", "I", "acute"),
    ("Ó", "O", "acute"), ("Ô", "O", "circumflex"), ("Õ", "O", "tilde"), ("Ö", "O", "diaeresis"),
    ("Ú", "U", "acute"), ("Ü", "U", "diaeresis"),
    ("Ñ", "N", "tilde"),
]


def bitmap(font: TTFont, char: str) -> dict[tuple[int, int], bool]:
    """The glyph's pixels, as (column, row) with row 0 on the baseline."""
    glyphs = font.getGlyphSet()
    name = font.getBestCmap()[ord(char)]
    width = font["hmtx"][name][0] // PX
    out = {}
    for row in range(-3, 10):
        for col in range(width):
            pen = PointInsidePen(glyphs, (col * PX + PX / 2, row * PX + PX / 2))
            glyphs[name].draw(pen)
            if pen.getResult():
                out[(col, row)] = True
    return out


def squash(pixels: dict[tuple[int, int], bool]) -> dict[tuple[int, int], bool]:
    """A 7-row capital as 6 rows: drops the repeated row nearest the middle, as Ё does."""
    rows = {r: frozenset(c for (c, rr) in pixels if rr == r) for r in range(7)}
    repeats = [r for r in range(1, 7) if rows[r] == rows[r - 1]]
    if not repeats:
        sys.exit("no repeated row to drop")
    drop = min(repeats, key=lambda r: abs(r - 3))
    return {(c, r if r < drop else r - 1): True for (c, r) in pixels if r != drop}


def mark(rows: list[str], top: int, shift: int = 0) -> dict[tuple[int, int], bool]:
    out = {}
    for i, line in enumerate(rows):
        for col, ch in enumerate(line):
            if ch == "#":
                out[(col + shift, top - i)] = True
    return out


def draw(pixels: dict[tuple[int, int], bool]):
    """One rectangle per horizontal run of pixels."""
    pen = TTGlyphPen(None)
    for row in sorted({r for (_, r) in pixels}):
        cols = sorted(c for (c, r) in pixels if r == row)
        start = prev = cols[0]
        for c in cols[1:] + [None]:
            if c is not None and c == prev + 1:
                prev = c
                continue
            x0, x1, y0, y1 = start * PX, (prev + 1) * PX, row * PX, (row + 1) * PX
            pen.moveTo((x0, y0))
            pen.lineTo((x0, y1))
            pen.lineTo((x1, y1))
            pen.lineTo((x1, y0))
            pen.closePath()
            if c is not None:
                start = prev = c
    return pen.glyph()


def add(font: TTFont, char: str, pixels: dict[tuple[int, int], bool], advance: int):
    cmap = font.getBestCmap()
    if ord(char) in cmap:
        return False
    name = f"uni{ord(char):04X}"
    glyph = draw(pixels)
    font["glyf"][name] = glyph
    glyph.recalcBounds(font["glyf"])
    font["hmtx"][name] = (advance, glyph.xMin if hasattr(glyph, "xMin") else 0)
    for table in font["cmap"].tables:
        if table.isUnicode():
            table.cmap[ord(char)] = name
    return True


def main():
    font = TTFont(FONT)
    before = len(font.getGlyphOrder())
    added = []

    def advance(char: str) -> int:
        return font["hmtx"][font.getBestCmap()[ord(char)]][0]

    # Dotless i: the stem of i.
    if ord("ı") not in font.getBestCmap():
        stem = {k: v for k, v in bitmap(font, "i").items() if k[1] < 5}
        if add(font, "ı", stem, advance("i")):
            added.append("ı")

    for char, base, kind in LETTERS:
        if ord(char) in font.getBestCmap():
            continue
        pixels = bitmap(font, base)
        capital = base.isupper()
        if capital:
            pixels = squash(pixels)
        top = 8 if capital else 7
        if base == "ı":
            # A narrow letter: the mark is two pixels wide, and the letter makes room for it.
            pixels = {(c + 0, r): True for (c, r) in pixels}
            pixels.update(mark([".#", "#."] if kind == "acute" else ["#.", ".#"], top))
            width = advance("i") + PX
        else:
            # Marks centre on the letter's own width (5 pixels for nearly all of them).
            letter = max(c for (c, _) in pixels) + 1
            pixels.update(mark(MARKS[kind], top, shift=(letter - 5) // 2))
            width = advance(base)
        if add(font, char, pixels, width):
            added.append(char)

    for char, base in (("ç", "c"), ("Ç", "C")):
        pixels = bitmap(font, base)
        pixels.update(mark(CEDILLA, -1))
        if add(font, char, pixels, advance(base)):
            added.append(char)

    # Upside down, one row lower.
    for char, base in (("¿", "?"), ("¡", "!")):
        pixels = bitmap(font, base)
        width = max(c for (c, _) in pixels) + 1
        turned = {(width - 1 - c, 4 - r): True for (c, r) in pixels}
        if add(font, char, turned, advance(base)):
            added.append(char)

    if not added:
        print("nothing to add")
        return
    # `glyf` appends each new glyph to the glyph order; maxp counts them.
    font["maxp"].numGlyphs = len(font.getGlyphOrder())
    font.flavor = "woff2"
    font.save(FONT)
    print("added", "".join(added), len(font.getGlyphOrder()) - before, "glyphs")


if __name__ == "__main__":
    main()
