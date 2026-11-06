# Excel版 毎日の使用テストの記録

毎日、架空の医務官になりきって Excel版（`shindansho-shijisho.xlsx`）に入力し、診断書・指示書の表示と印刷（A4・US Letter）を確かめた記録です。

- テストの道具：`python3 shindansho-excel/tests/excel_test.py`（決まったテスト）、`--cases <json>`（その日の入力例）、`--png <フォルダ>`（印刷イメージ）。
- 計算は LibreOffice で行うので、文字の幅などが Excel と少し違うことがあります。印刷の見た目の問題は「Excelで要確認」として書きます。
- 直すのは、計算の誤り・エラー表示（#VALUE! など）のような明らかな不具合だけ。見た目・仕様に関わることは「提案」に書き、ユーザーの判断を待ちます。
