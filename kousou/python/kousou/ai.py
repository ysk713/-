"""Claude（画像入力）による読み取り層。判定はしない：読み取った事実と、薬剤の添付文書上の知識だけを返す。"""
from __future__ import annotations

import base64
import json

import anthropic

MODEL = "claude-opus-5-5"


def _s():
    return {"type": "string"}


def _n():  # 数値または不明
    return {"anyOf": [{"type": "number"}, {"type": "null"}]}


def _b():  # 真偽または不明（union型を減らすため文字列enumにする）
    return {"type": "string", "enum": ["はい", "いいえ", "不明"]}


def _obj(props: dict) -> dict:
    return {"type": "object", "properties": props, "required": list(props), "additionalProperties": False}


DOC_TYPES = ["申込書", "診断書", "指示書", "委任状", "白紙", "その他"]

PAGE_SCHEMA = _obj({
    "pages": {"type": "array", "items": _obj({
        "page": {"type": "integer"},
        "doc_type": {"type": "string", "enum": DOC_TYPES},
        "is_first_page_of_doc": {"type": "boolean"},
        "patient_name": _s(),
        "applicant_name": _s(),
        "staff_code": _s(),
        "date": _s(),
        "note": _s(),
    })},
})

SIGN = {"type": "string", "enum": ["自筆署名", "記名", "なし", "判読不能"]}

CASE_SCHEMA = _obj({
    "application": _obj({
        "present": {"type": "boolean"},
        "apply_date": _s(),
        "applicant_name": _s(),
        "patient_name": _s(),
        "patient_relation": _s(),
        "staff_code": _s(),
        "mission_name": _s(),
        "mission_code": _s(),
        "consent_item_count": {"type": "integer"},
        "consent_wording_current": _b(),
        "consent_unchecked_items": {"type": "array", "items": {"type": "integer"}},
        "consent9_old_wording": {"type": "boolean"},
        "old_form_features": _s(),
        "written_by_other": _b(),
        "proxy_letter_present": {"type": "boolean"},
        "proxy_letter_signed": _b(),
        "proxy_name": _s(),
    }),
    "diagnosis": _obj({
        "present": {"type": "boolean"},
        "issue_date": _s(),
        "patient_name": _s(),
        "staff_code": _s(),
        "name_code_swapped": {"type": "boolean"},
        "disease": _s(),
        "has_dosage": {"type": "boolean"},
        "doctor_name": _s(),
        "doctor_mission": _s(),
        "signature": SIGN,
        "seal": _b(),
        "original_sent_later": {"type": "boolean"},
    }),
    "instruction": _obj({
        "present": {"type": "boolean"},
        "issue_date": _s(),
        "patient_name": _s(),
        "doctor_name": _s(),
        "doctor_mission": _s(),
        "signature": SIGN,
        "seal": _b(),
        "no_generic_checked": {"type": "boolean"},
    }),
    "drugs": {"type": "array", "items": _obj({
        "name_as_written": _s(),
        "generic_name": _s(),
        "corrected_name": _s(),
        "name_exists": {"type": "boolean"},
        "strength_value": _n(),
        "strength_unit": _s(),
        "strength_exists": _b(),
        "dosage_form": {"type": "string", "enum": ["錠剤", "カプセル", "顆粒", "散剤", "貼付剤", "液剤", "軟膏・クリーム", "スプレー・吸入", "坐剤", "注射", "その他"]},
        "cold_storage": {"type": "boolean"},
        "in_diagnosis": {"type": "boolean"},
        "in_instruction": {"type": "boolean"},
        "diag_daily_units": _n(),
        "inst_daily_units": _n(),
        "adjustable_max_units": _n(),
        "quantity_indeterminate": {"type": "boolean"},
        "days": _n(),
        "quantity": _n(),
        "generic_prescription": {"type": "boolean"},
        "is_psychotropic": _b(),
        "is_new_drug": _b(),
        "is_female_hormone_cycle": {"type": "boolean"},
        "approved_max_daily": _n(),
        "approved_max_unit": _s(),
        "indication": {"type": "string", "enum": ["適応内", "適応外", "不明"]},
        "indication_note": _s(),
    })},
    "reading_uncertainties": {"type": "array", "items": _s()},
})

SYSTEM = """あなたは在外公館の「個人用医薬品購送」書類（申込書＝様式A、診断書、指示書＝様式B、委任状）のスキャン画像を読み取る担当です。
読み取った事実をJSONで正確に返してください。最終判定は別のプログラムと人間が行うので、あなたは事実の読み取りと薬剤知識の提供に徹してください。

共通ルール:
- 日付は必ず西暦 YYYY-MM-DD に変換（令和8年＝2026年）。読めない・記載なしは空文字。
- 推測で埋めない。判読できない箇所は空文字/null にし、reading_uncertainties に具体的に書く。
- 手書き・印影・チェック欄（レ点）を注意深く見る。スキャンの傾き・横向きは問題にしない。
- 書式見本の【例】行（例: ○○○○○ 5mg/T …）は薬剤として数えない。

申込書（様式A）:
- consent_item_count: 同意チェック欄の項目数（現行版は11項目、旧版は9項目）。consent_wording_current: 文言が現行11項目版と一致するか。
- consent_unchecked_items: レ点が入っていない項目番号（1始まり）。
- consent9_old_wording: 項目9の文言に「領収書」が含まれない旧文言なら true。
- old_form_features: 旧版の特徴（9項目、「送付先公館名」欄、ピンク背景、見出し「公館名」等）があれば記述。なければ空文字。
- written_by_other: 筆跡や委任状から申込者本人以外の記入と判断できれば true。
- patient_relation: 療養者の申込者との続柄（本人/配偶者/子 等）。

診断書:
- has_dosage: 処方に用法・用量（1日量や回数）まで書かれているか。薬品名だけなら false。
- name_code_swapped: 氏名欄と職員コード欄が取り違えて記入されていれば true。
- signature: 医師氏名欄が手書きの自筆署名か、印字/ゴム印の記名か。seal: 押印の有無。
- original_sent_later: 「原本は後日送付」等の付箋・記載があれば true。

指示書（様式B）:
- 指示書に病名欄はない。no_generic_checked: 「後発医薬品への変更不可」にチェックがあるか。

drugs（診断書と指示書の薬を同一薬剤ごとに1行にまとめる）:
- diag_daily_units / inst_daily_units: それぞれの書類での1日使用量（錠数・包数・枚数）。例「2錠 2×朝夕食後」は1日2錠。
- adjustable_max_units: 「1〜2錠で調節可」なら上限側の2。なければ null。quantity_indeterminate: 半錠指示などで総数量が確定しない場合 true。
- days: ◯日分。quantity: 申込数量（総錠数）。
- name_exists: 書かれた薬品名が実在するか。誤記なら corrected_name に正しい名称（例: オルメティック→オルメテック、プロチゾラム→ブロチゾラム、チラージン→チラーヂン）。正しければ corrected_name は空文字。
- strength_exists: その製剤にその含有量規格が実在するか（例: チラーヂンS錠は25/50/75/100μgのみで12.5μgは存在しない）。
- is_psychotropic: 麻薬及び向精神薬取締法上の向精神薬か。is_new_drug: 薬価収載から1年以内の新薬か（パルモディアXRは新薬ではない）。
- approved_max_daily / approved_max_unit: 添付文書上の1日最大用量（含有量の単位で。配合剤は錠数で）。
- indication: 診断書の病名に対しその薬剤が日本の保険適応内か。病名に完全対応する薬が無いこと自体は問題にしない。
"""


class Reader:
    def __init__(self, model: str = MODEL):
        self.client = anthropic.Anthropic()
        self.model = model

    def _ask(self, images: list[bytes], labels: list[str], instruction: str, schema: dict) -> dict:
        content = []
        for img, label in zip(images, labels):
            content.append({"type": "text", "text": label})
            content.append({"type": "image", "source": {
                "type": "base64", "media_type": "image/jpeg",
                "data": base64.standard_b64encode(img).decode()}})
        content.append({"type": "text", "text": instruction})
        with self.client.beta.messages.stream(
            model=self.model,
            max_tokens=64000,
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
            thinking={"type": "adaptive"},
            output_config={"effort": "high", "format": {"type": "json_schema", "schema": schema}},
            system=[{"type": "text", "text": SYSTEM, "cache_control": {"type": "ephemeral"}}],
            messages=[{"role": "user", "content": content}],
        ) as stream:
            resp = stream.get_final_message()
        if resp.stop_reason == "refusal":
            raise RuntimeError("モデルが応答を拒否しました: " + str(getattr(resp, "stop_details", "")))
        if resp.stop_reason == "max_tokens":
            raise RuntimeError("出力が上限で切れました（ページ数を減らして再実行してください）")
        text = next(b.text for b in resp.content if b.type == "text")
        return json.loads(text)

    def classify_pages(self, images: list[bytes], page_numbers: list[int]) -> list[dict]:
        labels = [f"【ページ {n}】" for n in page_numbers]
        out = self._ask(images, labels,
                        "各ページの書類種別を判定し、ページごとに1件返してください。"
                        "is_first_page_of_doc は、その書類の1枚目なら true（2枚目以降・続紙なら false）。"
                        "patient_name は療養者（患者）氏名、applicant_name は申込書の申込者氏名（申込書以外は空文字）。",
                        PAGE_SCHEMA)
        return out["pages"]

    def read_case(self, images: list[bytes], labels: list[str]) -> dict:
        return self._ask(images, labels,
                         "これは1人の療養者分の書類一式です。スキーマに沿って全項目を読み取ってください。"
                         "書類が見当たらない場合は present を false にしてください。",
                         CASE_SCHEMA)
