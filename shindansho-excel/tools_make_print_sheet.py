"""「印刷用」シート（診断書と指示書を縦に並べて、このシートを印刷するだけで2枚出る）を作り直す。
診断書・指示書シートを直したら、このスクリプトを実行して印刷用シートにも反映する：
    python3 shindansho-excel/tools_make_print_sheet.py
"""
import copy
from pathlib import Path
import openpyxl
from openpyxl.utils import get_column_letter as L
from openpyxl.worksheet.pagebreak import Break, RowBreak
from openpyxl.worksheet.properties import PageSetupProperties

P = Path(__file__).resolve().parent / "shindansho-shijisho.xlsx"
TOTAL = 87.0   # 印刷用シートの幅（指示書の列幅の合計に合わせる）


def col_widths(ws):
    w = []
    for c in range(1, 7):
        d = None
        for dim in ws.column_dimensions.values():
            if dim.min and dim.max and dim.min <= c <= dim.max:
                d = dim
        w.append(d.width if d and d.width else ws.sheet_format.defaultColWidth or 8.43)
    return w


def grid(wb):
    """診断書・指示書の列の境目を合わせた共通の列と、それぞれの列が何列目から何列目になるかを返す。"""
    edges, per = set(), {}
    for name in ("診断書", "指示書"):
        w = col_widths(wb[name])
        k = TOTAL / sum(w)
        acc, b = 0, []
        for x in w:
            acc += x * k
            b.append(round(acc, 1))
        per[name] = b
        edges |= set(b)
    merged = []
    for e in sorted(edges):
        if merged and e - merged[-1] < 1.0:
            continue
        merged.append(e)
    merged[-1] = TOTAL
    widths = [merged[0]] + [merged[i] - merged[i - 1] for i in range(1, len(merged))]

    def idx(e):
        return min(range(len(merged)), key=lambda i: abs(merged[i] - e)) + 1
    maps = {}
    for name, b in per.items():
        m, start = {}, 1
        for c, e in enumerate(b, 1):
            end = idx(e)
            m[c] = (start, end)
            start = end + 1
        maps[name] = m
    return widths, maps


def build(wb):
    if "印刷用" in wb.sheetnames:
        del wb["印刷用"]
    WIDTHS, MAP = grid(wb)
    dst = wb.create_sheet("印刷用", index=wb.sheetnames.index("指示書") + 1)
    for i, w in enumerate(WIDTHS, 1):
        dst.column_dimensions[L(i)].width = w
    offset = 0
    breaks = []
    for name in ("診断書", "指示書"):
        src = wb[name]
        last = src.max_row
        m = MAP[name]
        merged = {}
        for rng in src.merged_cells.ranges:
            merged[(rng.min_row, rng.min_col)] = rng
        covered = {(r, c) for rng in src.merged_cells.ranges for r in range(rng.min_row, rng.max_row + 1) for c in range(rng.min_col, rng.max_col + 1)}
        for r in range(1, last + 1):
            h = src.row_dimensions[r].height
            if h:
                dst.row_dimensions[offset + r].height = h
            for c in range(1, 7):
                if (r, c) in covered and (r, c) not in merged:
                    continue
                cell = src.cell(r, c)
                if (r, c) in merged:
                    rng = merged[(r, c)]
                    r2, c1, c2 = rng.max_row, m[rng.min_col][0], m[rng.max_col][1]
                else:
                    r2, c1, c2 = r, m[c][0], m[c][1]
                tl = dst.cell(offset + r, c1)
                tl.value = cell.value
                for rr in range(offset + r, offset + r2 + 1):
                    for cc in range(c1, c2 + 1):
                        dst.cell(rr, cc)._style = copy.copy(cell._style)
                if r2 > r or c2 > c1:
                    dst.merge_cells(start_row=offset + r, start_column=c1, end_row=offset + r2, end_column=c2)
        offset += last + 1
        breaks.append(offset)
    dst.row_breaks = RowBreak()
    dst.row_breaks.append(Break(id=breaks[0]))
    ps, sp = dst.page_setup, wb["診断書"].page_setup
    ps.paperSize, ps.orientation = sp.paperSize, "portrait"
    # 「1ページに合わせる」は手動の改ページを無視するので使わず、倍率で決める（US Letter の高さに診断書が収まる 74%）
    dst.sheet_properties.pageSetUpPr = PageSetupProperties(fitToPage=False)
    ps.scale = 74
    dst.page_margins = copy.copy(wb["診断書"].page_margins)
    dst.print_options.horizontalCentered = True
    dst.print_area = f"A1:{L(len(WIDTHS))}{offset - 1}"
    dst.protection.sheet = True
    dst.protection.selectLockedCells = False
    dst.sheet_view.showGridLines = False
    return dst


if __name__ == "__main__":
    wb = openpyxl.load_workbook(P)
    build(wb)
    wb.save(P)
    print("印刷用シートを作り直しました")
