"""使い方:
  python -m kousou 20260929113409.pdf -o 出力フォルダ
  python -m kousou 20260929113409.pdf -o 出力フォルダ --offline   # work/ のJSONを手直しした後の再判定（API不使用）
"""
import argparse
import sys
from pathlib import Path

from .pipeline import Pipeline


def main(argv=None):
    ap = argparse.ArgumentParser(prog="kousou", description="個人用医薬品購送 三点セットの下判定と1人1PDF出力")
    ap.add_argument("scans", nargs="+", type=Path, help="日次スキャンPDF（複数可、指定順に処理）")
    ap.add_argument("-o", "--out", type=Path, required=True, help="出力フォルダ")
    ap.add_argument("--date", help="出力ファイル名の日付 YYYYMMDD（既定：今日）")
    ap.add_argument("--history", type=Path, default=Path("kousou_history.json"),
                    help="過去バッチとの突き合わせ用の履歴ファイル（既定：./kousou_history.json）")
    ap.add_argument("--no-history", action="store_true", help="履歴の参照・記録をしない")
    ap.add_argument("--offline", action="store_true", help="APIを呼ばず、work/ に保存済みのJSONだけで判定する")
    ap.add_argument("--model", help="Claudeのモデル（既定：claude-opus-5-5）")
    a = ap.parse_args(argv)

    for s in a.scans:
        if not s.exists():
            sys.exit(f"ファイルがありません: {s}")
    p = Pipeline(a.out, offline=a.offline, history_path=None if a.no_history else a.history,
                 out_date=a.date, model=a.model)
    try:
        res = p.run(a.scans)
    except RuntimeError as e:
        sys.exit(f"中断しました: {e}")
    n = len(res["cases"])
    print(f"\n完了：{n}件 → {a.out}/判定結果.md, 判定一覧.csv, pdf/, ZIP")
    print("※ 下判定です。最終判断は人が行ってください。")


if __name__ == "__main__":
    main()
