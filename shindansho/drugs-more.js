// 薬剤マスタの追加分（外来でよく使う内服薬・貼付剤）。drugs.js の DRUG_MASTER に足す。
// 項目の意味は drugs.js と同じ。max（1日上限）・ind（適応）は作成者が確かだと判断したものだけ入れ、
// 分からないものは max: null・ind: [] にしてある（その薬は名前・規格の照合だけ行い、上限・適応のチェックはしない）。
// ※ 参考値です。最終確認は最新の添付文書・薬剤部の回答で行ってください。
(() => {
  const G = (cat, list) => list.map((d) => ({ cat, ind: [], ...d }));
  const HTN = ["高血圧"];
  const DM = ["2型糖尿病", "糖尿病"];
  const INF = ["感染症", "咽頭炎", "扁桃炎", "中耳炎", "副鼻腔炎", "気管支炎", "肺炎", "膀胱炎", "腎盂腎炎", "皮膚感染症", "尿路感染症"];
  const ALLERGY = ["アレルギー性鼻炎", "花粉症", "蕁麻疹", "湿疹", "皮膚炎", "皮膚そう痒症", "痒疹", "アトピー"];
  const PD = ["パーキンソン病", "パーキンソン症候群"];
  const EPI = ["てんかん"];
  const SCZ = ["統合失調症"];
  const RA = ["関節リウマチ"];
  const OAB = ["過活動膀胱", "神経因性膀胱", "頻尿", "尿失禁"];
  const OP = ["骨粗鬆症"];
  const kampo = (name, no, max = 7.5, pack = 2.5) => ({ name: `${name}エキス顆粒`, brand: `ツムラ${no}番`, form: "散・顆粒", strengths: [pack], unit: "g", max });
  const combo = (name, brand, ind, max = 1) => ({ name, brand, strengths: [], unit: "錠", max, ind });

  window.DRUG_MASTER.push(
    ...G("抗菌薬", [
      { name: "セフカペンピボキシル塩酸塩錠", brand: "フロモックス", strengths: [75, 100], unit: "mg", max: 450, ind: INF },
      { name: "セフジトレンピボキシル錠", brand: "メイアクト", strengths: [100], unit: "mg", max: 600, ind: INF },
      { name: "セファクロルカプセル", brand: "ケフラール", strengths: [250], unit: "mg", max: 1500, ind: INF },
      { name: "セファレキシンカプセル", brand: "ケフレックス", strengths: [250], unit: "mg", max: null, ind: INF },
      { name: "アモキシシリン・クラブラン酸カリウム配合錠", brand: "オーグメンチン", strengths: [], unit: "錠", max: null, ind: INF },
      { name: "ミノサイクリン塩酸塩錠", brand: "ミノマイシン", strengths: [50, 100], unit: "mg", max: 200, ind: [...INF, "ざ瘡"] },
      { name: "ドキシサイクリン塩酸塩錠", brand: "ビブラマイシン", strengths: [50, 100], unit: "mg", max: 200, ind: INF, note: "マラリアなどの予防目的は購送できない（予防薬）" },
      { name: "ファロペネムナトリウム錠", brand: "ファロム", strengths: [150, 200], unit: "mg", max: 900, ind: INF },
      { name: "シタフロキサシン錠", brand: "グレースビット", strengths: [50], unit: "mg", max: 200, ind: INF },
      { name: "モキシフロキサシン錠", brand: "アベロックス", strengths: [400], unit: "mg", max: 400, ind: INF },
      { name: "シプロフロキサシン錠", brand: "シプロキサン", strengths: [100, 200], unit: "mg", max: 600, ind: INF },
      { name: "エリスロマイシン錠", brand: "エリスロシン", strengths: [100, 200], unit: "mg", max: 1200, ind: INF },
      { name: "スルファメトキサゾール・トリメトプリム配合錠", brand: "バクタ／ダイフェン", strengths: [], unit: "錠", max: null, ind: [...INF, "ニューモシスチス肺炎"] },
      { name: "メトロニダゾール錠", brand: "フラジール", strengths: [250], unit: "mg", max: null, ind: ["トリコモナス", "ヘリコバクター", "嫌気性菌感染症", "感染性腸炎", "細菌性腟症"] },
      { name: "ホスホマイシンカルシウム錠", brand: "ホスミシン", strengths: [250, 500], unit: "mg", max: 3000, ind: INF },
    ]),
    ...G("抗ウイルス薬・抗真菌薬", [
      { name: "アシクロビル錠", brand: "ゾビラックス", strengths: [200, 400], unit: "mg", max: 4000, ind: ["帯状疱疹", "単純疱疹", "水痘", "性器ヘルペス"], note: "単純疱疹は1000mg/日" },
      { name: "ファムシクロビル錠", brand: "ファムビル", strengths: [250], unit: "mg", max: 1500, ind: ["帯状疱疹", "単純疱疹"] },
      { name: "アメナメビル錠", brand: "アメナリーフ", strengths: [200], unit: "mg", max: 400, ind: ["帯状疱疹", "単純疱疹"] },
      { name: "オセルタミビルリン酸塩カプセル", brand: "タミフル", strengths: [75], unit: "mg", max: 150, ind: ["インフルエンザ"], note: "予防投与は保険適応外" },
      { name: "バロキサビル マルボキシル錠", brand: "ゾフルーザ", strengths: [10, 20], unit: "mg", max: null, ind: ["インフルエンザ"], note: "体重で決める1回だけの服用" },
      { name: "テルビナフィン塩酸塩錠", brand: "ラミシール", strengths: [125], unit: "mg", max: 125, ind: ["白癬", "爪白癬", "カンジダ症"] },
      { name: "イトラコナゾールカプセル", brand: "イトリゾール", strengths: [50], unit: "mg", max: 400, ind: ["白癬", "爪白癬", "カンジダ症", "真菌症"] },
      { name: "フルコナゾールカプセル", brand: "ジフルカン", strengths: [50, 100], unit: "mg", max: 400, ind: ["カンジダ症", "クリプトコッカス症", "真菌症"] },
    ]),
    ...G("アレルギー（追加）", [
      { name: "ケトチフェンフマル酸塩カプセル", brand: "ザジテン", strengths: [1], unit: "mg", max: 2, ind: [...ALLERGY, "気管支喘息"] },
      { name: "メキタジン錠", brand: "ゼスラン／ニポラジン", strengths: [3], unit: "mg", max: 6, ind: [...ALLERGY, "気管支喘息"] },
      { name: "クレマスチンフマル酸塩錠", brand: "タベジール", strengths: [1], unit: "mg", max: 2, ind: ALLERGY },
      { name: "オキサトミド錠", brand: "セルテクト", strengths: [30], unit: "mg", max: 60, ind: [...ALLERGY, "気管支喘息"] },
      { name: "アゼラスチン塩酸塩錠", brand: "アゼプチン", strengths: [0.5, 1], unit: "mg", max: 4, ind: [...ALLERGY, "気管支喘息"] },
      combo("フェキソフェナジン・プソイドエフェドリン配合錠", "ディレグラ", ["アレルギー性鼻炎", "花粉症"], 4),
    ]),
    ...G("呼吸器（追加）", [
      { name: "ツロブテロールテープ", brand: "ホクナリンテープ", form: "貼付剤", strengths: [0.5, 1, 2], unit: "mg", max: 2, ind: ["気管支喘息", "喘息", "気管支炎", "COPD", "肺気腫"] },
      { name: "プロカテロール塩酸塩錠", brand: "メプチン", strengths: [25, 50], unit: "μg", max: 100, ind: ["気管支喘息", "喘息", "気管支炎", "COPD", "肺気腫"] },
      { name: "クレンブテロール塩酸塩錠", brand: "スピロペント", strengths: [10], unit: "μg", max: 40, ind: ["気管支喘息", "喘息", "気管支炎", "COPD", "肺気腫", "腹圧性尿失禁"] },
      { name: "チペピジンヒベンズ酸塩錠", brand: "アスベリン", strengths: [10, 20], unit: "mg", max: 120, ind: ["感冒", "上気道炎", "気管支炎", "咳"] },
      { name: "ブロムヘキシン塩酸塩錠", brand: "ビソルボン", strengths: [4], unit: "mg", max: 12, ind: ["気管支炎", "気管支喘息", "COPD", "肺結核"] },
    ]),
    ...G("消化器（追加）", [
      { name: "テプレノンカプセル", brand: "セルベックス", strengths: [50], unit: "mg", max: 150, ind: ["胃潰瘍", "胃炎"] },
      { name: "ポラプレジンク錠", brand: "プロマック", strengths: [75], unit: "mg", max: 150, ind: ["胃潰瘍"] },
      { name: "イトプリド塩酸塩錠", brand: "ガナトン", strengths: [50], unit: "mg", max: 150, ind: ["慢性胃炎", "胃炎"] },
      { name: "ラフチジン錠", brand: "プロテカジン", strengths: [5, 10], unit: "mg", max: 20, ind: ["胃潰瘍", "十二指腸潰瘍", "逆流性食道炎", "胃炎"] },
      { name: "ロキサチジン酢酸エステル徐放カプセル", brand: "アルタット", strengths: [37.5, 75], unit: "mg", max: 150, ind: ["胃潰瘍", "十二指腸潰瘍", "逆流性食道炎", "胃炎"] },
      { name: "ロペラミド塩酸塩カプセル", brand: "ロペミン", strengths: [1], unit: "mg", max: 2, ind: ["下痢"] },
      { name: "酪酸菌製剤錠", brand: "ミヤBM", strengths: [], unit: "錠", max: 6, ind: ["腸内菌叢の異常", "下痢", "便秘", "腸炎"] },
      { name: "ナルデメジントシル酸塩錠", brand: "スインプロイク", strengths: [0.2], unit: "mg", max: 0.2, ind: ["オピオイド誘発性便秘症", "便秘"] },
      { name: "オンダンセトロンOD錠", brand: "ゾフラン", strengths: [2, 4], unit: "mg", max: 8, ind: ["悪心", "嘔吐"] },
      { name: "グラニセトロン錠", brand: "カイトリル", strengths: [1, 2], unit: "mg", max: 2, ind: ["悪心", "嘔吐"] },
    ]),
    ...G("循環器（追加）", [
      { name: "ジルチアゼム塩酸塩錠", brand: "ヘルベッサー", strengths: [30, 60], unit: "mg", max: 180, ind: [...HTN, "狭心症"] },
      { name: "ジルチアゼム塩酸塩徐放カプセル", brand: "ヘルベッサーR", strengths: [100, 200], unit: "mg", max: 200, ind: [...HTN, "狭心症"] },
      { name: "ベラパミル塩酸塩錠", brand: "ワソラン", strengths: [40], unit: "mg", max: 240, ind: ["狭心症", "頻脈性不整脈", "心房細動"] },
      { name: "メトプロロール酒石酸塩錠", brand: "セロケン／ロプレソール", strengths: [20, 40], unit: "mg", max: 240, ind: [...HTN, "狭心症", "頻脈性不整脈"] },
      { name: "プロプラノロール塩酸塩錠", brand: "インデラル", strengths: [10], unit: "mg", max: 120, ind: [...HTN, "狭心症", "頻脈性不整脈", "片頭痛"] },
      { name: "アロチノロール塩酸塩錠", brand: "アロチノロール", strengths: [5, 10], unit: "mg", max: 30, ind: [...HTN, "狭心症", "頻脈性不整脈", "本態性振戦"] },
      { name: "アゾセミド錠", brand: "ダイアート", strengths: [30, 60], unit: "mg", max: 60, ind: ["浮腫", "心不全", "腎性浮腫", "肝性浮腫"] },
      { name: "インダパミド錠", brand: "ナトリックス", strengths: [1, 2], unit: "mg", max: 2, ind: HTN },
      { name: "エサキセレノン錠", brand: "ミネブロ", strengths: [1.25, 2.5, 5], unit: "mg", max: 5, ind: HTN },
      { name: "アミオダロン塩酸塩錠", brand: "アンカロン", strengths: [100], unit: "mg", max: 400, ind: ["心室性不整脈", "心房細動", "肥大型心筋症", "不整脈"], note: "維持量は200mg/日" },
      { name: "ピルシカイニド塩酸塩カプセル", brand: "サンリズム", strengths: [25, 50], unit: "mg", max: 225, ind: ["頻脈性不整脈", "心房細動", "不整脈"] },
      { name: "シベンゾリンコハク酸塩錠", brand: "シベノール", strengths: [50, 100], unit: "mg", max: 450, ind: ["頻脈性不整脈", "心房細動", "不整脈"] },
      { name: "フレカイニド酢酸塩錠", brand: "タンボコール", strengths: [50, 100], unit: "mg", max: 200, ind: ["頻脈性不整脈", "心房細動", "不整脈"] },
      { name: "メキシレチン塩酸塩カプセル", brand: "メキシチール", strengths: [50, 100], unit: "mg", max: 450, ind: ["頻脈性不整脈", "心室性不整脈", "糖尿病性神経障害", "不整脈"] },
      { name: "ジゴキシン錠", brand: "ジゴシン", strengths: [0.125, 0.25], unit: "mg", max: null, ind: ["心不全", "心房細動", "頻脈性不整脈"], note: "血中濃度で量を決める" },
      { name: "シロスタゾール錠", brand: "プレタール", strengths: [50, 100], unit: "mg", max: 200, ind: ["慢性動脈閉塞症", "脳梗塞", "閉塞性動脈硬化症"] },
      { name: "チクロピジン塩酸塩錠", brand: "パナルジン", strengths: [100], unit: "mg", max: 600, ind: ["脳梗塞", "一過性脳虚血発作", "慢性動脈閉塞症"] },
      { name: "プラスグレル塩酸塩錠", brand: "エフィエント", strengths: [2.5, 3.75], unit: "mg", max: 3.75, ind: ["急性冠症候群", "狭心症", "心筋梗塞", "脳梗塞"], note: "初回負荷は20mg" },
      { name: "チカグレロル錠", brand: "ブリリンタ", strengths: [60, 90], unit: "mg", max: 180, ind: ["急性冠症候群", "心筋梗塞"] },
      { name: "ベラプロストナトリウム錠", brand: "ドルナー／プロサイリン", strengths: [20], unit: "μg", max: 120, ind: ["慢性動脈閉塞症", "肺動脈性肺高血圧症"] },
      { name: "リマプロスト アルファデクス錠", brand: "オパルモン", strengths: [5], unit: "μg", max: 30, ind: ["閉塞性血栓血管炎", "腰部脊柱管狭窄症"], note: "腰部脊柱管狭窄症は15μg/日" },
      { name: "サルポグレラート塩酸塩錠", brand: "アンプラーグ", strengths: [50, 100], unit: "mg", max: 300, ind: ["慢性動脈閉塞症"] },
      { name: "硝酸イソソルビド徐放錠", brand: "フランドル", strengths: [20], unit: "mg", max: 40, ind: ["狭心症", "心筋梗塞"] },
      { name: "ニトログリセリン舌下錠", brand: "ニトロペン", strengths: [0.3], unit: "mg", max: null, ind: ["狭心症", "心筋梗塞"] },
      { name: "イバブラジン塩酸塩錠", brand: "コララン", strengths: [2.5, 5, 7.5], unit: "mg", max: 15, ind: ["心不全"] },
      { name: "ベルイシグアト錠", brand: "ベリキューボ", strengths: [2.5, 5, 10], unit: "mg", max: 10, ind: ["心不全"] },
      { name: "ミドドリン塩酸塩錠", brand: "メトリジン", strengths: [2], unit: "mg", max: 8, ind: ["本態性低血圧", "起立性低血圧", "低血圧"] },
      { name: "アメジニウムメチル硫酸塩錠", brand: "リズミック", strengths: [10], unit: "mg", max: 20, ind: ["本態性低血圧", "起立性低血圧", "低血圧", "透析施行時の血圧低下"] },
      combo("テルミサルタン・アムロジピン配合錠", "ミカムロAP／BP", HTN),
      combo("バルサルタン・アムロジピン配合錠", "エックスフォージ", HTN),
      combo("イルベサルタン・アムロジピン配合錠", "アイミクスLD／HD", HTN),
      combo("カンデサルタン・アムロジピン配合錠", "ユニシアLD／HD", HTN),
      combo("オルメサルタン・アゼルニジピン配合錠", "レザルタスLD／HD", HTN),
      combo("アジルサルタン・アムロジピン配合錠", "ザクラスLD／HD", HTN),
      combo("テルミサルタン・ヒドロクロロチアジド配合錠", "ミコンビAP／BP", HTN),
      combo("ロサルタン・ヒドロクロロチアジド配合錠", "プレミネントLD／HD", HTN),
      combo("カンデサルタン・ヒドロクロロチアジド配合錠", "エカードLD／HD", HTN),
      combo("バルサルタン・ヒドロクロロチアジド配合錠", "コディオMD／EX", HTN),
      combo("アムロジピン・アトルバスタチン配合錠", "カデュエット", [...HTN, "狭心症", "高コレステロール血症", "脂質異常症"]),
    ]),
    ...G("糖尿病（追加）", [
      { name: "グリクラジド錠", brand: "グリミクロン", strengths: [20, 40], unit: "mg", max: 160, ind: DM },
      { name: "グリベンクラミド錠", brand: "オイグルコン／ダオニール", strengths: [1.25, 2.5], unit: "mg", max: 10, ind: DM },
      { name: "レパグリニド錠", brand: "シュアポスト", strengths: [0.25, 0.5], unit: "mg", max: 3, ind: DM },
      { name: "ナテグリニド錠", brand: "スターシス／ファスティック", strengths: [30, 90], unit: "mg", max: 360, ind: DM },
      { name: "アカルボース錠", brand: "グルコバイ", strengths: [50, 100], unit: "mg", max: 300, ind: DM },
      { name: "サキサグリプチン錠", brand: "オングリザ", strengths: [2.5, 5], unit: "mg", max: 5, ind: DM },
      { name: "アナグリプチン錠", brand: "スイニー", strengths: [100], unit: "mg", max: 400, ind: DM },
      { name: "ルセオグリフロジン錠", brand: "ルセフィ", strengths: [2.5, 5], unit: "mg", max: 5, ind: DM },
      { name: "イメグリミン塩酸塩錠", brand: "ツイミーグ", strengths: [500], unit: "mg", max: 2000, ind: DM },
      combo("ビルダグリプチン・メトホルミン配合錠", "エクメットLD／HD", DM, 2),
      combo("アログリプチン・メトホルミン配合錠", "イニシンク", DM),
      combo("シタグリプチン・イプラグリフロジン配合錠", "スージャヌ", DM),
      combo("エンパグリフロジン・リナグリプチン配合錠", "トラディアンスAP／BP", DM),
      combo("テネリグリプチン・カナグリフロジン配合錠", "カナリア", DM),
      combo("ピオグリタゾン・メトホルミン配合錠", "メタクトLD／HD", DM),
      combo("アログリプチン・ピオグリタゾン配合錠", "リオベルLD／HD", DM),
      combo("ピオグリタゾン・グリメピリド配合錠", "ソニアスLD／HD", DM),
    ]),
    ...G("脂質（追加）", [
      combo("エゼチミブ・ロスバスタチン配合錠", "ロスーゼットLD／HD", ["高コレステロール血症", "脂質異常症", "家族性高コレステロール血症"]),
      combo("エゼチミブ・アトルバスタチン配合錠", "アトーゼットLD／HD", ["高コレステロール血症", "脂質異常症", "家族性高コレステロール血症"]),
    ]),
    ...G("内分泌・ステロイド（追加）", [
      { name: "リオチロニンナトリウム錠", brand: "チロナミン", strengths: [5, 25], unit: "μg", max: 75, ind: ["甲状腺機能低下症", "粘液水腫", "クレチン病"] },
      { name: "デキサメタゾン錠", brand: "デカドロン", strengths: [0.5, 4], unit: "mg", max: null, note: "疾患により用量が大きく異なる" },
      { name: "メチルプレドニゾロン錠", brand: "メドロール", strengths: [2, 4], unit: "mg", max: null, note: "疾患により用量が大きく異なる" },
      { name: "ヒドロコルチゾン錠", brand: "コートリル", strengths: [10], unit: "mg", max: null, note: "疾患により用量が大きく異なる" },
      { name: "フルドロコルチゾン酢酸エステル錠", brand: "フロリネフ", strengths: [0.1], unit: "mg", max: null, ind: ["アジソン病", "副腎皮質機能不全", "塩喪失型先天性副腎皮質過形成症"] },
      { name: "カベルゴリン錠", brand: "カバサール", strengths: [0.25, 1], unit: "mg", max: null, ind: ["パーキンソン病", "高プロラクチン血症", "乳汁漏出症", "産褥性乳汁分泌抑制"] },
    ]),
    ...G("骨粗鬆症（追加）", [
      { name: "アレンドロン酸ナトリウム錠", brand: "フォサマック／ボナロン", strengths: [5, 35], unit: "mg", max: null, ind: OP, note: "5mgは毎日、35mgは週1回" },
      { name: "リセドロン酸ナトリウム錠", brand: "アクトネル／ベネット", strengths: [2.5, 17.5, 75], unit: "mg", max: null, ind: [...OP, "骨ページェット病"], note: "2.5mgは毎日、17.5mgは週1回、75mgは月1回" },
      { name: "ミノドロン酸錠", brand: "リカルボン／ボノテオ", strengths: [1, 50], unit: "mg", max: null, ind: OP, note: "1mgは毎日、50mgは4週に1回" },
      { name: "イバンドロン酸ナトリウム錠", brand: "ボンビバ", strengths: [100], unit: "mg", max: null, ind: OP, note: "月1回" },
      { name: "アルファカルシドール錠", brand: "アルファロール／ワンアルファ", strengths: [0.25, 0.5, 1], unit: "μg", max: null, ind: [...OP, "慢性腎不全", "副甲状腺機能低下症", "くる病"] },
      { name: "カルシトリオールカプセル", brand: "ロカルトロール", strengths: [0.25, 0.5], unit: "μg", max: null, ind: [...OP, "慢性腎不全", "副甲状腺機能低下症"] },
      { name: "メナテトレノンカプセル", brand: "グラケー", strengths: [15], unit: "mg", max: 45, ind: OP },
    ]),
    ...G("泌尿器・婦人科（追加）", [
      { name: "ウラピジル徐放カプセル", brand: "エブランチル", strengths: [15, 30], unit: "mg", max: 90, ind: ["前立腺肥大症", "神経因性膀胱", "高血圧"] },
      { name: "プロピベリン塩酸塩錠", brand: "バップフォー", strengths: [10, 20], unit: "mg", max: 40, ind: OAB },
      { name: "オキシブチニン塩酸塩錠", brand: "ポラキス", strengths: [1, 2, 3], unit: "mg", max: 9, ind: OAB },
      { name: "トルテロジン酒石酸塩徐放カプセル", brand: "デトルシトール", strengths: [2, 4], unit: "mg", max: 4, ind: OAB },
      { name: "クロミフェンクエン酸塩錠", brand: "クロミッド", strengths: [50], unit: "mg", max: 150, ind: ["排卵障害", "不妊症"] },
    ]),
    ...G("精神・神経（追加）", [
      { name: "ブロナンセリン錠", brand: "ロナセン", strengths: [2, 4, 8], unit: "mg", max: 24, ind: SCZ },
      { name: "ルラシドン塩酸塩錠", brand: "ラツーダ", strengths: [20, 40, 60, 80], unit: "mg", max: 80, ind: [...SCZ, "双極性障害"] },
      { name: "ブレクスピプラゾール錠", brand: "レキサルティ", strengths: [1, 2], unit: "mg", max: 2, ind: [...SCZ, "うつ病", "うつ状態"] },
      { name: "パリペリドン徐放錠", brand: "インヴェガ", strengths: [3, 6, 9], unit: "mg", max: 12, ind: SCZ },
      { name: "ペロスピロン塩酸塩錠", brand: "ルーラン", strengths: [4, 8, 16], unit: "mg", max: 48, ind: SCZ },
      { name: "ハロペリドール錠", brand: "セレネース", strengths: [0.75, 1, 1.5, 3], unit: "mg", max: null, ind: [...SCZ, "躁病"] },
      { name: "ミルナシプラン塩酸塩錠", brand: "トレドミン", strengths: [15, 25, 50], unit: "mg", max: 100, ind: ["うつ病", "うつ状態"] },
      { name: "アミトリプチリン塩酸塩錠", brand: "トリプタノール", strengths: [10, 25], unit: "mg", max: null, ind: ["うつ病", "うつ状態", "夜尿症", "末梢性神経障害性疼痛"] },
      { name: "ノルトリプチリン塩酸塩錠", brand: "ノリトレン", strengths: [10, 25], unit: "mg", max: 150, ind: ["うつ病", "うつ状態"] },
      { name: "アモキサピンカプセル", brand: "アモキサン", strengths: [10, 25, 50], unit: "mg", max: 300, ind: ["うつ病", "うつ状態"] },
      { name: "ミアンセリン塩酸塩錠", brand: "テトラミド", strengths: [10, 30], unit: "mg", max: 60, ind: ["うつ病", "うつ状態"] },
      { name: "アトモキセチン塩酸塩カプセル", brand: "ストラテラ", strengths: [5, 10, 25, 40], unit: "mg", max: 120, ind: ["注意欠陥・多動性障害", "ADHD"] },
      { name: "グアンファシン塩酸塩徐放錠", brand: "インチュニブ", strengths: [1, 3], unit: "mg", max: 6, ind: ["注意欠陥・多動性障害", "ADHD"] },
      { name: "ガランタミン臭化水素酸塩錠", brand: "レミニール", strengths: [4, 8, 12], unit: "mg", max: 24, ind: ["アルツハイマー型認知症", "認知症"] },
      { name: "リバスチグミンテープ", brand: "イクセロンパッチ／リバスタッチ", form: "貼付剤", strengths: [4.5, 9, 13.5, 18], unit: "mg", max: 18, ind: ["アルツハイマー型認知症", "認知症"] },
      { name: "クロチアゼパム錠", brand: "リーゼ", strengths: [5, 10], unit: "mg", max: 30, psych: true, ind: ["心身症", "不安", "緊張", "抑うつ", "睡眠障害", "めまい"] },
      { name: "ブロマゼパム錠", brand: "レキソタン", strengths: [1, 2, 5], unit: "mg", max: 15, psych: true, ind: ["神経症", "うつ病", "心身症", "不安", "緊張"] },
      { name: "エスタゾラム錠", brand: "ユーロジン", strengths: [1, 2], unit: "mg", max: 4, psych: true, ind: ["不眠症"] },
      { name: "クアゼパム錠", brand: "ドラール", strengths: [15, 20], unit: "mg", max: 30, psych: true, ind: ["不眠症"] },
      { name: "クロバザム錠", brand: "マイスタン", strengths: [5, 10], unit: "mg", max: 40, psych: true, ind: EPI },
      { name: "フェノバルビタール錠", brand: "フェノバール", strengths: [30], unit: "mg", max: null, psych: true, ind: [...EPI, "不眠症", "不安", "緊張"] },
    ]),
    ...G("パーキンソン病・てんかん（追加）", [
      { name: "レボドパ・カルビドパ配合錠", brand: "ネオドパストン／メネシット", strengths: [], unit: "錠", max: null, ind: PD },
      { name: "レボドパ・ベンセラジド配合錠", brand: "マドパー／イーシー・ドパール", strengths: [], unit: "錠", max: null, ind: PD },
      { name: "プラミペキソール塩酸塩錠", brand: "ビ・シフロール", strengths: [0.125, 0.5], unit: "mg", max: 4.5, ind: [...PD, "レストレスレッグス症候群"], note: "レストレスレッグス症候群は0.75mg/日" },
      { name: "プラミペキソール徐放錠", brand: "ミラペックスLA", strengths: [0.375, 1.5], unit: "mg", max: 4.5, ind: PD },
      { name: "ロピニロール塩酸塩錠", brand: "レキップ", strengths: [0.25, 1, 2], unit: "mg", max: 15, ind: PD },
      { name: "ロピニロール徐放錠", brand: "レキップCR", strengths: [2, 8], unit: "mg", max: 16, ind: PD },
      { name: "ロチゴチンテープ", brand: "ニュープロパッチ", form: "貼付剤", strengths: [2.25, 4.5, 9, 13.5], unit: "mg", max: 36, ind: [...PD, "レストレスレッグス症候群"], note: "レストレスレッグス症候群は6.75mg/日" },
      { name: "ラサギリンメシル酸塩錠", brand: "アジレクト", strengths: [0.5, 1], unit: "mg", max: 1, ind: PD },
      { name: "エンタカポン錠", brand: "コムタン", strengths: [100], unit: "mg", max: 1600, ind: PD },
      { name: "イストラデフィリン錠", brand: "ノウリアスト", strengths: [20], unit: "mg", max: 40, ind: PD },
      { name: "アマンタジン塩酸塩錠", brand: "シンメトレル", strengths: [50, 100], unit: "mg", max: 300, ind: [...PD, "脳梗塞後遺症", "インフルエンザ"] },
      { name: "トリヘキシフェニジル塩酸塩錠", brand: "アーテン", strengths: [2], unit: "mg", max: 10, ind: PD },
      { name: "ラコサミド錠", brand: "ビムパット", strengths: [50, 100], unit: "mg", max: 400, ind: EPI },
      { name: "ペランパネル錠", brand: "フィコンパ", strengths: [2, 4], unit: "mg", max: 12, ind: EPI },
      { name: "トピラマート錠", brand: "トピナ", strengths: [25, 50, 100], unit: "mg", max: 600, ind: EPI },
      { name: "ゾニサミド錠", brand: "エクセグラン", strengths: [100], unit: "mg", max: 600, ind: EPI },
      { name: "フェニトイン錠", brand: "アレビアチン", strengths: [25, 100], unit: "mg", max: 300, ind: EPI },
      { name: "ガバペンチン錠", brand: "ガバペン", strengths: [200, 300, 400], unit: "mg", max: 2400, ind: EPI },
      { name: "バクロフェン錠", brand: "リオレサール／ギャバロン", strengths: [5, 10], unit: "mg", max: 30, ind: ["痙性麻痺", "脳脊髄疾患"] },
      { name: "ダントロレンナトリウムカプセル", brand: "ダントリウム", strengths: [25], unit: "mg", max: 150, ind: ["痙性麻痺", "脳脊髄疾患"] },
    ]),
    ...G("鎮痛（追加）", [
      { name: "ジクロフェナクナトリウム徐放カプセル", brand: "ボルタレンSR", strengths: [37.5], unit: "mg", max: 75, ind: ["関節リウマチ", "変形性関節症", "腰痛", "肩関節周囲炎", "頸肩腕症候群", "疼痛"] },
      { name: "ナプロキセン錠", brand: "ナイキサン", strengths: [100], unit: "mg", max: 600, ind: ["関節リウマチ", "変形性関節症", "腰痛", "疼痛", "月経困難症"] },
      { name: "ザルトプロフェン錠", brand: "ソレトン／ペオン", strengths: [80], unit: "mg", max: 240, ind: ["関節リウマチ", "変形性関節症", "腰痛", "肩関節周囲炎", "頸肩腕症候群", "疼痛"] },
      { name: "ロルノキシカム錠", brand: "ロルカム", strengths: [2, 4], unit: "mg", max: 18, ind: ["関節リウマチ", "変形性関節症", "腰痛", "肩関節周囲炎", "頸肩腕症候群", "疼痛"], note: "関節リウマチ・変形性関節症などは12mg/日" },
      { name: "トラマドール塩酸塩徐放錠", brand: "ワントラム", strengths: [100], unit: "mg", max: 400, ind: ["慢性疼痛", "がん疼痛", "疼痛"] },
      { name: "ワクシニアウイルス接種家兎炎症皮膚抽出液錠", brand: "ノイロトロピン", strengths: [], unit: "錠", max: 4, ind: ["帯状疱疹後神経痛", "腰痛", "頸肩腕症候群", "肩関節周囲炎", "変形性関節症", "神経痛"] },
      { name: "ペンタゾシン錠", brand: "ソセゴン／ペンタジン", strengths: [25], unit: "mg", max: null, psych: true, ind: ["がん疼痛", "疼痛"] },
    ]),
    ...G("関節リウマチ・免疫（追加）", [
      { name: "メトトレキサートカプセル", brand: "リウマトレックス", strengths: [2], unit: "mg", max: null, weekly: true, ind: ["関節リウマチ", "若年性特発性関節炎", "乾癬"], note: "週に1〜2日だけ飲む薬（毎日飲むと重い副作用）" },
      { name: "サラゾスルファピリジン腸溶錠", brand: "アザルフィジンEN", strengths: [250, 500], unit: "mg", max: 1000, ind: RA },
      { name: "ブシラミン錠", brand: "リマチル", strengths: [50, 100], unit: "mg", max: 300, ind: RA },
      { name: "イグラチモド錠", brand: "ケアラム", strengths: [25], unit: "mg", max: 50, ind: RA },
      { name: "トファシチニブ錠", brand: "ゼルヤンツ", strengths: [5], unit: "mg", max: 10, ind: [...RA, "潰瘍性大腸炎", "関節症性乾癬"] },
      { name: "バリシチニブ錠", brand: "オルミエント", strengths: [2, 4], unit: "mg", max: 4, ind: [...RA, "アトピー性皮膚炎", "円形脱毛症"] },
      { name: "タクロリムスカプセル", brand: "プログラフ", strengths: [0.5, 1, 5], unit: "mg", max: null, note: "血中濃度で量を決める" },
      { name: "シクロスポリンカプセル", brand: "ネオーラル", strengths: [10, 25, 50], unit: "mg", max: null, note: "血中濃度で量を決める" },
      { name: "アザチオプリン錠", brand: "イムラン／アザニン", strengths: [50], unit: "mg", max: null },
    ]),
    ...G("皮膚・その他（追加）", [
      { name: "トラニラストカプセル", brand: "リザベン", strengths: [100], unit: "mg", max: 300, ind: ["気管支喘息", "アレルギー性鼻炎", "アトピー性皮膚炎", "ケロイド", "肥厚性瘢痕"] },
      { name: "グリチルリチン酸配合錠", brand: "グリチロン", strengths: [], unit: "錠", max: 9, ind: ["湿疹", "皮膚炎", "蕁麻疹", "肝機能障害", "口内炎", "円形脱毛症"] },
      { name: "アスコルビン酸・パントテン酸カルシウム配合錠", brand: "シナール", strengths: [], unit: "錠", max: null, note: "雀卵斑は保険適応外とされる（薬剤部の回答）" },
      { name: "カルバゾクロムスルホン酸ナトリウム錠", brand: "アドナ", strengths: [10, 30], unit: "mg", max: 90, ind: ["出血", "紫斑"] },
      { name: "アセタゾラミド錠", brand: "ダイアモックス", strengths: [250], unit: "mg", max: 1000, ind: ["緑内障", "てんかん", "浮腫", "メニエール病", "睡眠時無呼吸症候群"], note: "高山病の予防は保険適応外" },
      { name: "イベルメクチン錠", brand: "ストロメクトール", strengths: [3], unit: "mg", max: null, ind: ["疥癬", "糞線虫症"], note: "体重で決める" },
      { name: "炭酸ランタンチュアブル錠", brand: "ホスレノール", strengths: [250, 500], unit: "mg", max: 2250, ind: ["高リン血症"] },
      { name: "バレニクリン酒石酸塩錠", brand: "チャンピックス", strengths: [0.5, 1], unit: "mg", max: 2, ind: ["ニコチン依存症", "禁煙"] },
    ]),
    ...G("漢方（ツムラ・追加）", [
      kampo("葛根湯加川芎辛夷", 2), kampo("十味敗毒湯", 6), kampo("八味地黄丸", 7), kampo("小柴胡湯", 9), kampo("柴胡桂枝湯", 10),
      kampo("柴胡加竜骨牡蛎湯", 12), kampo("半夏瀉心湯", 14), kampo("黄連解毒湯", 15), kampo("小青竜湯", 19, 9, 3), kampo("防已黄耆湯", 20),
      kampo("消風散", 22), kampo("麻黄湯", 27), kampo("呉茱萸湯", 31), kampo("当帰四逆加呉茱萸生姜湯", 38), kampo("苓桂朮甘湯", 39),
      kampo("猪苓湯", 40), kampo("釣藤散", 47), kampo("十全大補湯", 48), kampo("荊芥連翹湯", 50), kampo("潤腸湯", 51),
      kampo("桃核承気湯", 61), kampo("防風通聖散", 62), kampo("香蘇散", 70), kampo("抑肝散加陳皮半夏", 83), kampo("大黄甘草湯", 84),
      kampo("清肺湯", 90, 9, 3), kampo("酸棗仁湯", 103), kampo("辛夷清肺湯", 104), kampo("温経湯", 106), kampo("牛車腎気丸", 107),
      kampo("人参養栄湯", 108, 9, 3), kampo("麻子仁丸", 126), kampo("加味帰脾湯", 137), kampo("桔梗湯", 138),
    ]),
  );
})();

// ---- 追加分（2026-11-05 その2）：まだ入っていなかった、よく使う内服薬・貼り薬
(() => {
  const G = (cat, list) => list.map((d) => ({ cat, ind: [], ...d }));
  const HTN = ["高血圧"];
  const DM = ["2型糖尿病", "糖尿病"];
  const INF = ["感染症", "咽頭炎", "扁桃炎", "中耳炎", "副鼻腔炎", "気管支炎", "肺炎", "膀胱炎", "腎盂腎炎", "皮膚感染症", "尿路感染症"];
  const ALLERGY = ["アレルギー性鼻炎", "花粉症", "蕁麻疹", "湿疹", "皮膚炎", "皮膚そう痒症", "痒疹", "アトピー"];
  const HBV = ["B型肝炎", "B型慢性肝炎", "慢性B型肝炎", "B型肝硬変"];
  const HCV = ["C型肝炎", "C型慢性肝炎", "慢性C型肝炎", "C型肝硬変"];
  const HIV = ["HIV感染症", "HIV-1感染症", "HIV"];
  const TB = ["結核", "肺結核", "非結核性抗酸菌症", "抗酸菌症"];
  const PAIN = ["関節リウマチ", "変形性関節症", "腰痛", "肩関節周囲炎", "頸肩腕症候群", "腱鞘炎", "疼痛", "筋肉痛", "捻挫", "打撲", "外傷"];
  const HP = ["高リン血症"];
  const patch = (name, brand, max = null, ind = PAIN, note) => ({ name, brand, form: "貼付剤", strengths: [], unit: "枚", max, ind, ...(note ? { note } : {}) });
  const combo = (name, brand, ind, max = 1) => ({ name, brand, strengths: [], unit: "錠", max, ind });
  const kampo = (name, no, max = 7.5, pack = 2.5) => ({ name: `${name}エキス顆粒`, brand: `ツムラ${no}番`, form: "散・顆粒", strengths: [pack], unit: "g", max });

  window.DRUG_MASTER.push(
    ...G("貼り薬（鎮痛・その他）", [
      patch("ロキソプロフェンナトリウムテープ", "ロキソニンテープ／ロキソニンパップ", null, PAIN, "1日1回貼付"),
      patch("ケトプロフェンテープ", "モーラステープ／モーラスパップ", null, PAIN, "1日1〜2回。貼った部位を日光に当てない（光線過敏症）"),
      patch("ジクロフェナクナトリウムテープ", "ボルタレンテープ", null, PAIN),
      patch("フェルビナクテープ", "セルタッチ", null, PAIN),
      patch("エスフルルビプロフェン・ハッカ油テープ", "ロコアテープ", 2, ["変形性関節症"], "1日1回。同時に2枚まで（全身性の副作用に注意）"),
      patch("ジクロフェナクナトリウム経皮吸収型製剤", "ジクトルテープ", 3, [], "全身作用型。がん疼痛は1日2〜3枚、腰痛症などは1日1〜2枚"),
      { name: "ビソプロロール経皮吸収型製剤", brand: "ビソノテープ", form: "貼付剤", strengths: [2, 4, 8], unit: "mg", max: 8, ind: [...HTN, "心房細動", "頻脈"] },
      { name: "エストラジオール経皮吸収型製剤", brand: "エストラーナテープ", form: "貼付剤", strengths: [0.09, 0.18, 0.36, 0.72], unit: "mg", max: null, ind: ["更年期障害", "卵巣欠落症状", "閉経後骨粗鬆症", "性腺機能低下症"], note: "2日ごとに貼り替え" },
    ]),
    ...G("抗菌薬・抗結核薬（追加）", [
      { name: "セフジニルカプセル", brand: "セフゾン", strengths: [50, 100], unit: "mg", max: 300, ind: INF },
      { name: "セフポドキシム プロキセチル錠", brand: "バナン", strengths: [100], unit: "mg", max: 400, ind: INF },
      { name: "セフテラム ピボキシル錠", brand: "トミロン", strengths: [50, 100], unit: "mg", max: 600, ind: INF },
      { name: "トスフロキサシントシル酸塩錠", brand: "オゼックス", strengths: [75, 150], unit: "mg", max: 600, ind: INF },
      { name: "ガレノキサシンメシル酸塩錠", brand: "ジェニナック", strengths: [200], unit: "mg", max: 400, ind: INF },
      { name: "ラスクフロキサシン塩酸塩錠", brand: "ラスビック", strengths: [75], unit: "mg", max: 75, ind: INF },
      { name: "ロキシスロマイシン錠", brand: "ルリッド", strengths: [150], unit: "mg", max: 300, ind: INF },
      { name: "ノルフロキサシン錠", brand: "バクシダール", strengths: [100, 200], unit: "mg", max: 600, ind: [...INF, "感染性腸炎"] },
      { name: "リファンピシンカプセル", brand: "リファジン", strengths: [150], unit: "mg", max: null, ind: [...TB, "ハンセン病"] },
      { name: "イソニアジド錠", brand: "イスコチン", strengths: [100], unit: "mg", max: null, ind: TB, note: "潜在性結核感染症の治療も含む" },
      { name: "エタンブトール塩酸塩錠", brand: "エサンブトール／エブトール", strengths: [125, 250], unit: "mg", max: null, ind: TB },
    ]),
    ...G("抗ウイルス薬（B型・C型肝炎・HIV）", [
      { name: "エンテカビル錠", brand: "バラクルード", strengths: [0.5], unit: "mg", max: 1, ind: HBV, note: "ラミブジン不応例は1mg/日" },
      { name: "テノホビル アラフェナミドフマル酸塩錠", brand: "ベムリディ", strengths: [25], unit: "mg", max: 25, ind: HBV },
      { name: "テノホビル ジソプロキシルフマル酸塩錠", brand: "テノゼット", strengths: [300], unit: "mg", max: 300, ind: HBV },
      combo("ソホスブビル・ベルパタスビル配合錠", "エプクルーサ", HCV, 1),
      combo("グレカプレビル・ピブレンタスビル配合錠", "マヴィレット", HCV, 3),
      { name: "ドルテグラビルナトリウム錠", brand: "テビケイ", strengths: [50], unit: "mg", max: 100, ind: HIV },
      combo("ビクテグラビル・エムトリシタビン・テノホビル アラフェナミド配合錠", "ビクタルビ", HIV, 1),
      { ...combo("エムトリシタビン・テノホビル アラフェナミド配合錠", "デシコビHT／LT", HIV, 1), note: "HIVの予防内服（PrEP）は保険適応外" },
      combo("ドルテグラビル・アバカビル・ラミブジン配合錠", "トリーメク", HIV, 1),
      combo("ドルテグラビル・ラミブジン配合錠", "ドウベイト", HIV, 1),
    ]),
    ...G("循環器（追加2）", [
      { name: "ヒドロクロロチアジド錠", brand: "ヒドロクロロチアジド", strengths: [12.5, 25], unit: "mg", max: 100, ind: [...HTN, "浮腫"] },
      { name: "トラセミド錠", brand: "ルプラック", strengths: [4, 8], unit: "mg", max: 8, ind: ["浮腫", "心性浮腫", "腎性浮腫", "肝性浮腫"] },
      { name: "トルバプタン錠", brand: "サムスカ", strengths: [7.5, 15, 30], unit: "mg", max: null, ind: ["心不全", "浮腫", "肝硬変", "多発性嚢胞腎"], note: "心不全は15mg/日まで。開始は入院で" },
      { name: "ペリンドプリルエルブミン錠", brand: "コバシル", strengths: [2, 4], unit: "mg", max: 8, ind: HTN },
      { name: "リシノプリル錠", brand: "ロンゲス／ゼストリル", strengths: [5, 10, 20], unit: "mg", max: 20, ind: [...HTN, "心不全"] },
      { name: "テモカプリル塩酸塩錠", brand: "エースコール", strengths: [1, 2, 4], unit: "mg", max: 4, ind: HTN },
      { name: "エホニジピン塩酸塩錠", brand: "ランデル", strengths: [10, 20, 40], unit: "mg", max: 60, ind: [...HTN, "狭心症"] },
      { name: "ラベタロール塩酸塩錠", brand: "トランデート", strengths: [50, 100], unit: "mg", max: 450, ind: HTN },
    ]),
    ...G("糖尿病・脂質（追加2）", [
      { name: "トレラグリプチンコハク酸塩錠", brand: "ザファテック", strengths: [25, 50, 100], unit: "mg", max: 100, ind: DM, weekly: "週1回飲む薬です" },
      { name: "オマリグリプチン錠", brand: "マリゼブ", strengths: [12.5, 25], unit: "mg", max: 25, ind: DM, weekly: "週1回飲む薬です" },
      combo("ミチグリニドカルシウム・ボグリボース配合錠", "グルベス", DM, 3),
      { name: "フルバスタチンナトリウム錠", brand: "ローコール", strengths: [10, 20, 30], unit: "mg", max: 60, ind: ["高コレステロール血症", "脂質異常症", "高脂血症", "家族性高コレステロール血症"] },
      { name: "プロブコール錠", brand: "シンレスタール／ロレルコ", strengths: [250], unit: "mg", max: 1000, ind: ["高コレステロール血症", "脂質異常症", "高脂血症", "家族性高コレステロール血症"] },
    ]),
    ...G("消化器（追加2）", [
      { name: "ニザチジンカプセル", brand: "アシノン", strengths: [75, 150], unit: "mg", max: 300, ind: ["胃潰瘍", "十二指腸潰瘍", "逆流性食道炎", "胃炎"] },
      { name: "シメチジン錠", brand: "タガメット", strengths: [200, 400], unit: "mg", max: 800, ind: ["胃潰瘍", "十二指腸潰瘍", "逆流性食道炎", "胃炎", "上部消化管出血"] },
      { name: "ピコスルファートナトリウム錠", brand: "ラキソベロン錠", strengths: [2.5], unit: "mg", max: null, ind: ["便秘症"] },
      { name: "マクロゴール4000・塩化ナトリウム・炭酸水素ナトリウム・塩化カリウム配合内用剤", brand: "モビコール", form: "散・顆粒", strengths: [], unit: "包", max: null, ind: ["便秘症", "慢性便秘症"], note: "LDは1日6包まで（HDはLDの2包分）" },
      { name: "ビフィズス菌製剤", brand: "ビオフェルミン錠剤／ラックビー", strengths: [], unit: "錠", max: null },
      { name: "耐性乳酸菌製剤", brand: "ビオフェルミンR／エンテロノン-R", strengths: [], unit: "錠", max: null, note: "抗菌薬と一緒に飲むときに使う" },
      { name: "メペンゾラート臭化物錠", brand: "トランコロン", strengths: [7.5], unit: "mg", max: 45, ind: ["過敏性腸症候群"] },
      { name: "チキジウム臭化物カプセル", brand: "チアトン", strengths: [5, 10], unit: "mg", max: 30, ind: ["胃炎", "胃潰瘍", "十二指腸潰瘍", "腸炎", "過敏性腸症候群", "胆のう", "胆道", "尿路結石"] },
      { name: "リファキシミン錠", brand: "リフキシマ", strengths: [200], unit: "mg", max: 1200, ind: ["肝性脳症"] },
      { name: "ブデソニド腸溶性カプセル", brand: "ゼンタコート", strengths: [3], unit: "mg", max: 9, ind: ["クローン病"] },
      { name: "プロクロルペラジンマレイン酸塩錠", brand: "ノバミン", strengths: [5], unit: "mg", max: null, ind: ["悪心", "嘔吐", "統合失調症"] },
    ]),
    ...G("呼吸器・アレルギー（追加2）", [
      { name: "ジメモルファンリン酸塩錠", brand: "アストミン", strengths: [10], unit: "mg", max: 60, ind: ["感冒", "上気道炎", "気管支炎", "咳", "肺炎", "肺結核"] },
      { name: "ベンプロペリンリン酸塩錠", brand: "フラベリック", strengths: [20], unit: "mg", max: null, ind: ["感冒", "上気道炎", "気管支炎", "咳"] },
      { name: "フドステイン錠", brand: "クリアナール／スペリア", strengths: [200], unit: "mg", max: 1200, ind: ["気管支喘息", "慢性気管支炎", "気管支拡張症", "肺結核", "塵肺", "肺気腫", "COPD", "びまん性汎細気管支炎", "非結核性抗酸菌症"] },
      { name: "シプロヘプタジン塩酸塩錠", brand: "ペリアクチン", strengths: [4], unit: "mg", max: null, ind: [...ALLERGY, "感冒"] },
      { name: "ホモクロルシクリジン塩酸塩錠", brand: "ホモクロミン", strengths: [10], unit: "mg", max: null, ind: ALLERGY },
    ]),
    ...G("ビタミン・腎臓・電解質（追加）", [
      { name: "フルスルチアミン錠", brand: "アリナミンF", strengths: [25, 50], unit: "mg", max: null, ind: ["ビタミンB1欠乏症", "脚気", "ウェルニッケ", "神経痛", "筋肉痛", "関節痛", "末梢神経炎", "末梢神経障害"] },
      { name: "ピリドキサールリン酸エステル錠", brand: "ピドキサール", strengths: [10, 20, 30], unit: "mg", max: null, ind: ["ビタミンB6欠乏症", "口内炎", "口角炎", "皮膚炎", "末梢神経炎"] },
      { name: "トコフェロール酢酸エステル錠", brand: "ユベラ", strengths: [50], unit: "mg", max: 300, ind: ["ビタミンE欠乏症", "末梢循環障害", "凍瘡", "しもやけ"] },
      { name: "トコフェロールニコチン酸エステルカプセル", brand: "ユベラN", strengths: [100, 200], unit: "mg", max: 600, ind: [...HTN, "脂質異常症", "高脂血症", "閉塞性動脈硬化症"] },
      { name: "アデノシン三リン酸二ナトリウム腸溶錠", brand: "アデホスコーワ", strengths: [20], unit: "mg", max: 300, ind: ["めまい", "メニエール", "頭部外傷後遺症", "心不全", "眼精疲労", "消化管機能低下"], note: "めまいは1回100mg・1日3回まで" },
      { name: "球形吸着炭カプセル", brand: "クレメジン", strengths: [200], unit: "mg", max: 6000, ind: ["慢性腎不全", "慢性腎臓病", "尿毒症"] },
      { name: "沈降炭酸カルシウム錠", brand: "カルタン", strengths: [250, 500], unit: "mg", max: 3000, ind: HP },
      { name: "セベラマー塩酸塩錠", brand: "レナジェル／フォスブロック", strengths: [250], unit: "mg", max: 9000, ind: HP },
      { name: "クエン酸第二鉄水和物錠", brand: "リオナ", strengths: [250], unit: "mg", max: 6000, ind: [...HP, "鉄欠乏性貧血"], note: "鉄欠乏性貧血は500mg/日まで" },
      combo("クエン酸カリウム・クエン酸ナトリウム配合錠", "ウラリット", ["痛風", "高尿酸血症", "アシドーシス", "酸性尿"], null),
    ]),
    ...G("内分泌・婦人科・膠原病（追加2）", [
      { name: "クロルマジノン酢酸エステル錠", brand: "プロスタール", strengths: [25, 50], unit: "mg", max: 100, ind: ["前立腺肥大症", "前立腺癌"], note: "前立腺肥大症は50mg/日" },
      { name: "エストラジオール錠", brand: "ジュリナ", strengths: [0.5], unit: "mg", max: null, ind: ["更年期障害", "卵巣欠落症状", "閉経後骨粗鬆症"] },
      { name: "結合型エストロゲン錠", brand: "プレマリン", strengths: [0.625], unit: "mg", max: null, ind: ["卵巣欠落症状", "卵巣機能不全", "更年期障害", "腟炎", "機能性子宮出血"] },
      { name: "リトドリン塩酸塩錠", brand: "ウテメリン", strengths: [5], unit: "mg", max: null, ind: ["切迫流産", "切迫早産"] },
      { name: "ブロモクリプチンメシル酸塩錠", brand: "パーロデル", strengths: [2.5], unit: "mg", max: null, ind: ["高プロラクチン血症", "乳汁漏出", "末端肥大症", "パーキンソン"] },
      { name: "ヒドロキシクロロキン硫酸塩錠", brand: "プラケニル", strengths: [200], unit: "mg", max: 400, ind: ["全身性エリテマトーデス", "皮膚エリテマトーデス", "SLE"], note: "量は理想体重で決める" },
      { name: "ミコフェノール酸モフェチルカプセル", brand: "セルセプト", strengths: [250], unit: "mg", max: 3000 },
      { name: "ミゾリビン錠", brand: "ブレディニン", strengths: [25, 50], unit: "mg", max: null },
    ]),
    ...G("精神・神経（追加2）", [
      { name: "タンドスピロンクエン酸塩錠", brand: "セディール", strengths: [5, 10, 20], unit: "mg", max: 60, ind: ["心身症", "神経症", "不安", "抑うつ"] },
      { name: "クロミプラミン塩酸塩錠", brand: "アナフラニール", strengths: [10, 25], unit: "mg", max: 225, ind: ["うつ病", "うつ状態", "遺尿症", "ナルコレプシー"] },
      { name: "イミプラミン塩酸塩錠", brand: "トフラニール", strengths: [10, 25], unit: "mg", max: 300, ind: ["うつ病", "うつ状態", "遺尿症"] },
      { name: "ダリドレキサント塩酸塩錠", brand: "クービビック", strengths: [25, 50], unit: "mg", max: 50, ind: ["不眠症"] },
      { name: "メチルフェニデート塩酸塩徐放錠", brand: "コンサータ", strengths: [18, 27, 36], unit: "mg", max: 72, ind: ["注意欠陥多動性障害", "注意欠如・多動症", "ADHD"], psych: true, note: "登録された医師・薬局だけが扱える薬" },
      { name: "ラスミジタンコハク酸塩錠", brand: "レイボー", strengths: [50, 100], unit: "mg", max: 200, ind: ["片頭痛"] },
    ]),
    ...G("漢方（ツムラ・追加2）", [
      kampo("乙字湯", 3), kampo("安中散", 5), kampo("大柴胡湯", 8), kampo("桂枝加朮附湯", 18), kampo("越婢加朮湯", 28),
      kampo("真武湯", 30), kampo("人参湯", 32), kampo("白虎加人参湯", 34, 9, 3), kampo("半夏白朮天麻湯", 37), kampo("疎経活血湯", 53),
      kampo("麻杏甘石湯", 55), kampo("五淋散", 56), kampo("桂枝加芍薬湯", 60), kampo("帰脾湯", 65), kampo("女神散", 67),
      kampo("四物湯", 71), kampo("甘麦大棗湯", 72), kampo("竜胆瀉肝湯", 76), kampo("当帰飲子", 86), kampo("六味丸", 87),
      kampo("治打撲一方", 89), kampo("竹茹温胆湯", 91), kampo("柴朴湯", 96), kampo("小建中湯", 99, 15, 5), kampo("清心蓮子飲", 111),
      kampo("柴苓湯", 114, 9, 3), kampo("排膿散及湯", 122), kampo("川芎茶調散", 124), kampo("桂枝茯苓丸加薏苡仁", 125), kampo("麻黄附子細辛湯", 127),
      kampo("啓脾湯", 128), kampo("茵蔯蒿湯", 135),
    ]),
  );
})();

// ---- 追加分（2026-11-07、ユーザーの判断「他全て直して」）
// 徐放錠・小児でよく使う薬と、小児の体重あたりの1日上限の目安（pedMax：mg/kg/日）。参考値。
(() => {
  window.DRUG_MASTER.push(
    { cat: "精神・神経（徐放錠）", name: "パロキセチン徐放錠", brand: "パキシルCR", strengths: [6.25, 12.5, 25], unit: "mg", max: 50, ind: ["うつ病", "うつ状態"] },
    { cat: "精神・神経（徐放錠）", name: "クエチアピン徐放錠", brand: "ビプレッソ徐放錠", strengths: [50, 150], unit: "mg", max: 300, ind: ["双極性障害", "躁うつ病"], note: "双極性障害のうつ症状に用いる" },
    { cat: "降圧薬（追加3）", name: "ニフェジピン徐放錠（12時間持続）", brand: "アダラートL", strengths: [10, 20], unit: "mg", max: 40, ind: ["高血圧", "狭心症"] },
    { cat: "小児・泌尿器", name: "デスモプレシン酢酸塩水和物口腔内崩壊錠", brand: "ミニリンメルト", form: "OD錠", strengths: [60, 120, 240], unit: "μg", max: 240, ind: ["夜尿症", "尿崩症", "夜間頻尿", "夜間多尿"], note: "夜尿症は120μgから開始し240μgまで。就寝前の水分を控える" },
  );
  const PED = {
    "アセトアミノフェン錠": 60, "アモキシシリンカプセル": 90, "クラリスロマイシン錠": 15, "セフジトレンピボキシル錠": 18,
    "セフカペンピボキシル塩酸塩錠": 9, "ファロペネムナトリウム錠": 30, "セフジニルカプセル": 18, "トスフロキサシントシル酸塩錠": 12,
    "ホスホマイシンカルシウム錠": 120, "オセルタミビルリン酸塩カプセル": 4, "カルボシステイン錠": 30, "アンブロキソール塩酸塩錠": 0.9,
    "ケトチフェンフマル酸塩カプセル": 0.06,
  };
  for (const d of window.DRUG_MASTER) if (PED[d.name]) d.pedMax = PED[d.name];
})();
