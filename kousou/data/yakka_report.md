# 薬価基準収載品目リストの取り込み（2026-10-29）

- ページ https://www.mhlw.go.jp/topics/2026/04/tp20260401-01.html：内用薬→https://www.mhlw.go.jp/topics/2026/04/xls/tp20261014-01_01.xlsx、外用薬→https://www.mhlw.go.jp/topics/2026/04/xls/tp20261014-01_03.xlsx
## 内用薬：https://www.mhlw.go.jp/topics/2026/04/xls/tp20261014-01_01.xlsx
- シート「ＨＰ用」：見出し 1行目、列 = kubun:1、code:2、ingredient:3、spec:4、name:8、maker:9、senpatsu:11、kouhatsu:10、price:13
## 外用薬：https://www.mhlw.go.jp/topics/2026/04/xls/tp20261014-01_03.xlsx
- シート「ＨＰ用」：見出し 1行目、列 = kubun:1、code:2、ingredient:3、spec:4、name:8、maker:9、senpatsu:11、kouhatsu:10、price:13

**取り込み成功**：8935品目（内用 7073・外用 1862）
- 収載日の列：なし（成分名が初めて現れた月で新薬を判定）
- 新しく現れた成分：0件
- 先頭5品目：
  - 0.02%グルコジンW水／クロルヘキシジングルコン酸塩／0.02%10mL
  - 0.02%ヘキザック水W／クロルヘキシジングルコン酸塩／0.02%10mL
  - 0.02w/v%マスキン水／クロルヘキシジングルコン酸塩／0.02%10mL
  - 0.05%グルコジンR水／クロルヘキシジングルコン酸塩／0.05%10mL
  - 0.05%グルコジンW水／クロルヘキシジングルコン酸塩／0.05%10mL
