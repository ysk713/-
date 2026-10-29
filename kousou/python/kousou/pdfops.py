"""PDFの決定的処理：ページ画像化・白紙判定・結合・命名・ZIP。AIは使わない。"""
from __future__ import annotations

import io
import re
import unicodedata
import zipfile
from pathlib import Path

import numpy as np
import pymupdf

BLANK_INK_RATIO = 0.005  # インク密度 0.5% 未満を白紙とみなす
INK_THRESHOLD = 160      # 0-255 のグレースケールでこれより暗い画素を「インク」とする


def ink_ratio(page: pymupdf.Page) -> float:
    """ページのインク密度（暗い画素の割合）。端のスキャン影を避けるため外周3%は除外する。"""
    pix = page.get_pixmap(dpi=50, colorspace=pymupdf.csGRAY)
    a = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width)
    mh, mw = max(1, int(pix.height * 0.03)), max(1, int(pix.width * 0.03))
    a = a[mh:-mh, mw:-mw]
    return float((a < INK_THRESHOLD).mean())


def find_blank_pages(doc: pymupdf.Document) -> list[int]:
    return [i for i in range(doc.page_count) if ink_ratio(doc[i]) < BLANK_INK_RATIO]


def page_jpeg(page: pymupdf.Page, long_edge: int = 2000) -> bytes:
    """AIに渡すページ画像。手書き文字が読める解像度で、JPEGにして容量を抑える。"""
    r = page.rect
    zoom = long_edge / max(r.width, r.height)
    pix = page.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom), colorspace=pymupdf.csGRAY)
    return pix.tobytes("jpeg", jpg_quality=80)


def merge_pages(src: pymupdf.Document, pages: list[int], out_path: Path) -> None:
    out = pymupdf.open()
    for p in pages:
        out.insert_pdf(src, from_page=p, to_page=p)
    out.save(out_path, garbage=3, deflate=True)
    out.close()


_BAD = re.compile(r'[\\/:*?"<>|\s　]+')


def safe_name(name: str) -> str:
    name = unicodedata.normalize("NFKC", name or "").strip()
    name = _BAD.sub("", name)
    return name or "氏名不明"


def unique_path(folder: Path, stem: str, suffix: str = ".pdf") -> Path:
    p = folder / f"{stem}{suffix}"
    n = 2
    while p.exists():
        p = folder / f"{stem}_{n}{suffix}"
        n += 1
    return p


def make_zip(files: list[Path], zip_path: Path) -> None:
    """日本語ファイル名が化けないよう、各エントリにUTF-8フラグ(0x800)を立てる。"""
    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for f in files:
            info = zipfile.ZipInfo(f.name)
            info.flag_bits |= 0x800
            info.compress_type = zipfile.ZIP_DEFLATED
            zf.writestr(info, f.read_bytes())
