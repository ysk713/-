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
WIDTHS = [14.5, 14.5, 5, 9, 14, 14, 8, 8]          # 共通の列（合計87）
MAP = {"診断書": {1: (1, 1), 2: (2, 2), 3: (3, 4), 4: (5, 5), 5: (6, 6), 6: (7, 8)},
       "指示書": {1: (1, 3), 2: (4, 4), 3: (5, 5), 4: (6, 6), 5: (7, 7), 6: (8, 8)}}


def build(wb):
    if "印刷用" in wb.sheetnames:
        del wb["印刷用"]
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
    dst.print_area = f"A1:H{offset - 1}"
    dst.protection.sheet = True
    dst.protection.selectLockedCells = False
    dst.sheet_view.showGridLines = False
    return dst


if __name__ == "__main__":
    wb = openpyxl.load_workbook(P)
    build(wb)
    wb.save(P)
    print("印刷用シートを作り直しました")
