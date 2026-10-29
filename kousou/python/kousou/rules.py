"""判定層：AIが読み取ったJSONにチェック①〜⑬と既知ルールを機械的に適用する。"""
from __future__ import annotations

import calendar
import json
import re
import unicodedata
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path

HERE = Path(__file__).parent
ERROR, CHECK, MINOR, INFO = "エラー相当", "要確認", "要確認（軽微）", "参考"
SEV_ORDER = {ERROR: 0, CHECK: 1, MINOR: 2, INFO: 3}
SOURCE_MASTER, SOURCE_AI = "マスタ", "AI判断"
NG_FORMS = {"液剤", "軟膏・クリーム", "スプレー・吸入", "坐剤", "注射"}


def load_json(p: Path) -> dict:
    return json.loads(Path(p).read_text(encoding="utf-8"))


def norm(s) -> str:
    return re.sub(r"\s+", "", unicodedata.normalize("NFKC", str(s or ""))).lower()


def norm_code(s) -> str:
    """職員コードの数字部分。先頭A・小文字・先頭ゼロの差は無視する。"""
    t = re.sub(r"[^0-9a-z]", "", norm(s))
    return t.lstrip("a").lstrip("0")


def tri(v):
    """はい/いいえ/不明（または bool/None）を True/False/None に。"""
    if isinstance(v, bool) or v is None:
        return v
    return {"はい": True, "いいえ": False}.get(str(v))


def num(v):
    try:
        return None if v in (None, "") else float(v)
    except (TypeError, ValueError):
        return None


def pdate(s) -> date | None:
    try:
        return date.fromisoformat(str(s)[:10]) if s else None
    except ValueError:
        return None


def add_months(d: date, m: int) -> date:
    y, mo = divmod(d.month - 1 + m, 12)
    y, mo = d.year + y, mo + 1
    return date(y, mo, min(d.day, calendar.monthrange(y, mo)[1]))


def fmt(v) -> str:
    return ("%g" % v) if isinstance(v, float) else str(v)


@dataclass
class Finding:
    sev: str
    item: str
    msg: str


@dataclass
class Drug:
    """薬品マスタ1件。"""
    names: list
    unit: str = ""
    strengths: list = field(default_factory=list)
    max_daily: float | None = None
    psych: bool | None = None
    old_limit: int | None = None
    new_drug_until: str | None = None
    hormone28: bool = False
    ok_days: list = field(default_factory=list)
    indications: list = field(default_factory=list)
    not_indicated: list = field(default_factory=list)

    @property
    def generic(self):
        return self.names[0]


class Master:
    def __init__(self, path: Path = HERE / "drug_master.json"):
        self.drugs = [Drug(**d) for d in load_json(path)["drugs"]]

    def find(self, *names) -> Drug | None:
        best, best_len = None, 0
        for name in names:
            n = norm(name)
            if not n:
                continue
            for d in self.drugs:
                for a in d.names:
                    an = norm(a)
                    if an and an in n and len(an) > best_len:
                        best, best_len = d, len(an)
        return best


def _same_drug(name_a: str, name_b: str, master: Master) -> bool:
    ma, mb = master.find(name_a), master.find(name_b)
    if ma and mb:
        return ma is mb
    return norm(name_a) in norm(name_b) or norm(name_b) in norm(name_a)


class Reviewer:
    def __init__(self, rules: dict | None = None, master: Master | None = None, today: date | None = None):
        self.r = rules or load_json(HERE / "rules.json")
        self.m = master or Master()
        self.today = today or date.today()

    # ------------------------------------------------------------------ 案件単位
    def review(self, case: dict) -> list[Finding]:
        F: list[Finding] = []
        add = lambda sev, item, msg: F.append(Finding(sev, item, msg))
        x = case["extraction"]
        app, dg, ins = x["application"], x["diagnosis"], x["instruction"]
        r = self.r

        for w in case.get("group_warnings", []):
            add(CHECK, "書類構成", w)
        for label, doc in (("申込書", app), ("診断書", dg), ("指示書", ins)):
            if not doc.get("present"):
                add(CHECK, "書類構成", f"{label}が見当たりません。断定する前に、スキャンの重複・欠落・ページ境界のまたぎを再確認してください。")

        ad, dd, idt = pdate(app.get("apply_date")), pdate(dg.get("issue_date")), pdate(ins.get("issue_date"))

        # ① 日付
        if app.get("present") and not ad:
            add(CHECK, "①日付", "申込日が読み取れません。")
        for label, doc, d in (("診断書", dg, dd), ("指示書", ins, idt)):
            if not doc.get("present"):
                continue
            if not d:
                add(CHECK, "①日付", f"{label}の発行日が読み取れません。")
                continue
            if d > self.today:
                add(ERROR, "①日付", f"{label}の発行日 {d} が未来の日付です（テンプレート初期値の残りに注意）。")
            if ad:
                if ad < d:
                    add(ERROR, "①日付", f"申込日 {ad} が{label}の発行日 {d} より前です。")
                else:
                    limit = add_months(d, int(r["validity_months"]))
                    if ad > limit:
                        add(ERROR, "①有効期限", f"{label}の発行日 {d} から申込日 {ad} まで{r['validity_months']}ヶ月を超えています（期限 {limit}）。")

        # ② 職員コード
        ca, cd = app.get("staff_code", ""), dg.get("staff_code", "")
        if dg.get("name_code_swapped"):
            add(ERROR, "②職員コード", "診断書の氏名欄と職員コード欄が取り違えられています。")
        if ca and cd:
            if norm_code(ca) != norm_code(cd):
                add(ERROR, "②職員コード", f"申込書「{ca}」と診断書「{cd}」の数字部分が一致しません。")
        elif app.get("present") and dg.get("present"):
            add(CHECK, "②職員コード", "申込書または診断書の職員コードが読み取れません。")
        if r.get("staff_code_digits"):
            for label, v in (("申込書", ca), ("診断書", cd)):
                digits = re.sub(r"\D", "", norm(v))
                if v and len(digits) != r["staff_code_digits"] and len(digits.lstrip("0")) != r["staff_code_digits"]:
                    add(CHECK, "②職員コード", f"{label}の職員コード「{v}」の桁数（{len(digits)}桁）が想定と異なります。")

        # ③ 公館コード（桁数の多数決は batch_checks で）
        mc = app.get("mission_code", "")
        if mc and re.search(r"[^0-9A-Za-z\-]", norm(mc)):
            add(CHECK, "③公館コード", f"公館コード「{mc}」に想定外の文字が含まれています。")
        if mc and r.get("mission_code_digits") and len(re.sub(r"\D", "", mc)) != r["mission_code_digits"]:
            add(CHECK, "③公館コード", f"公館コード「{mc}」の桁数が想定（{r['mission_code_digits']}桁）と異なります。")

        # 申込書の様式・同意チェック
        if app.get("present"):
            cnt, cur = app.get("consent_item_count"), tri(app.get("consent_wording_current"))
            if cnt != len(r["consent_items"]) or cur is False:
                feat = app.get("old_form_features") or ""
                add(ERROR, "申込書様式", f"旧版の申込書が使用されています（同意チェック{cnt}項目{('・' + feat) if feat else ''}）。")
            unchecked = [i for i in app.get("consent_unchecked_items", []) if 1 <= i <= len(r["consent_items"])]
            if unchecked:
                add(ERROR, "同意チェック", "レ点がない項目：" + "、".join(f"({i})" for i in unchecked))
            if app.get("consent9_old_wording") and cnt == len(r["consent_items"]) and not r.get("consent9_old_wording_ok"):
                add(CHECK, "同意チェック", "同意チェック(9)が旧文言（「領収書」なし）です。")

        # ⑪ 委任状
        doctor = ins.get("doctor_name") or dg.get("doctor_name") or ""
        letter = app.get("proxy_letter_present")
        if tri(app.get("written_by_other")) and not letter:
            add(ERROR, "⑪委任状", "申込者本人以外の記入と見られますが、委任状が添付されていません。")
        if letter:
            if tri(app.get("proxy_letter_signed")) is False:
                add(ERROR, "⑪委任状", "委任状に委任者の自筆署名がありません。")
            if 1 not in app.get("consent_unchecked_items", []) and app.get("present"):
                add(ERROR, "⑪委任状", "委任状が添付されているのに、同意チェック(1)「申込者本人が記入」にレ点があります（矛盾）。")
            if app.get("proxy_name") and doctor and norm(app["proxy_name"]) == norm(doctor):
                add(CHECK, "⑪委任状", f"委任状の受任者「{app['proxy_name']}」が発行医と同一です。")
        rel = app.get("patient_relation", "")
        if doctor and norm(app.get("applicant_name")) == norm(doctor) and (not rel or "本人" in rel):
            add(CHECK, "申込者", f"申込者が発行医（{doctor}）本人で、療養者も本人です。")

        # ④ 診断書の用法・用量
        if dg.get("present") and not dg.get("has_dosage"):
            add(ERROR, "④診断書", "診断書に用法・用量の記載がなく、指示書との1日使用量照合ができません。")

        # 診断書原本の別送
        mission = app.get("mission_name", "")
        if dg.get("original_sent_later"):
            if any(norm(p) in norm(mission) for p in r.get("patrol_missions", []) if p):
                add(INFO, "原本別送", f"診断書原本は後日送付（{mission}は巡回公館・健康相談公館のため可）。")
            else:
                add(CHECK, "原本別送", f"診断書原本が後日送付です。{mission or '所属公館'}が巡回公館・健康相談公館か確認してください。")

        # 署名・押印
        for label, doc, d in (("診断書", dg, dd), ("指示書", ins, idt)):
            if doc.get("present"):
                self._sign(label, doc, d, ad, mission, add)

        # ⑩ 兼轄（既定では指摘しない）
        dm = ins.get("doctor_mission") or dg.get("doctor_mission")
        if r.get("flag_kankatsu") and dm and mission and norm(dm) not in norm(mission) and norm(mission) not in norm(dm):
            add(CHECK, "⑩兼轄", f"発行医所属「{dm}」と療養者所属「{mission}」が異なります。")

        # 薬剤ごと
        drugs = x.get("drugs", [])
        if not drugs and (dg.get("present") or ins.get("present")):
            add(CHECK, "薬剤", "処方薬剤が読み取れません。")
        for i, d in enumerate(drugs, 1):
            self._drug(i, d, case, ad, dd, idt, ins, dg, add)

        for u in x.get("reading_uncertainties", []):
            add(INFO, "読取注意", u)

        F.sort(key=lambda f: SEV_ORDER[f.sev])
        return F

    def _sign(self, label, doc, d, ad, mission, add):
        r = self.r
        if not d:
            return
        sig, seal = doc.get("signature"), tri(doc.get("seal"))
        new_form = pdate(r["new_form_date"])
        strict_from = pdate(r["strict_sign_from_apply_date"])
        if d >= new_form and (ad is None or ad >= strict_from):
            # 令和8年9月4日以降発行かつ10月以降の申込み：自筆署名＋押印が必須
            if sig == "判読不能":
                add(CHECK, "署名・押印", f"{label}：医師氏名欄の署名/記名が判別できません。")
            elif sig != "自筆署名":
                add(ERROR, "署名・押印", f"{label}：自筆署名がありません（{sig}）。{r['new_form_date']}以降の発行は自筆署名と押印が必須です。")
            if seal is False:
                if any(m in (mission or "") for m in r["no_seal_missions"]):
                    add(INFO, "署名・押印", f"{label}：押印なし（{mission}は印鑑未調達のため可）。")
                else:
                    add(ERROR, "署名・押印", f"{label}：押印がありません。")
            elif seal is None:
                add(CHECK, "署名・押印", f"{label}：押印の有無が判別できません。")
        elif d < new_form:
            # 旧基準：記名押印または署名
            if not (sig == "自筆署名" or (sig == "記名" and seal)):
                add(ERROR, "署名・押印", f"{label}：旧基準「記名押印または署名」を満たしていません（{sig}／押印{'あり' if seal else 'なし'}）。")
        # 9月中の日付の書類は書式要件を指摘しない

    def _drug(self, i, d, case, ad, dd, idt, ins, dg, add):
        r = self.r
        name = d.get("corrected_name") or d.get("name_as_written") or "?"
        st, unit = num(d.get("strength_value")), d.get("strength_unit") or ""
        written = d.get("name_as_written") or "?"
        st_txt = fmt(st) + unit if st is not None else ""
        tag = f"薬剤{i}「{written}{'' if not st_txt or norm(st_txt) in norm(written) else ' ' + st_txt}」"
        m = self.m.find(d.get("corrected_name"), d.get("name_as_written"), d.get("generic_name"))
        generic = m.generic if m else (d.get("generic_name") or name)
        src = SOURCE_MASTER if m else SOURCE_AI
        patient = case["extraction"]["application"].get("patient_name") or case["extraction"]["diagnosis"].get("patient_name") or ""

        # ⑩ 薬品名・規格の実在性
        if d.get("corrected_name") or d.get("name_exists") is False:
            add(ERROR, "⑩薬品名", f"{tag}：薬品名の誤記の可能性（正：{d.get('corrected_name') or '不明'}）。")
        if m and m.strengths and st is not None:
            s = _convert(st, unit, m.unit)
            if s is not None and not any(abs(s - v) < 1e-9 for v in m.strengths):
                add(ERROR, "⑩規格", f"{tag}：{m.generic}に {fmt(st)}{unit} の規格はありません（実在：{'／'.join(fmt(v) for v in m.strengths)}{m.unit}）。[{src}]")
        elif not m and tri(d.get("strength_exists")) is False:
            add(ERROR, "⑩規格", f"{tag}：この含有量の規格は存在しない可能性があります。[{src}]")

        # 剤形
        if d.get("dosage_form") in NG_FORMS or d.get("cold_storage"):
            add(ERROR, "剤形", f"{tag}：購送できない剤形です（{d.get('dosage_form')}{'・冷所保存' if d.get('cold_storage') else ''}）。")

        # ⑤ 1日使用量クロスチェック
        dd_u, di_u, adj = num(d.get("diag_daily_units")), num(d.get("inst_daily_units")), num(d.get("adjustable_max_units"))
        if d.get("in_diagnosis") is False:
            add(CHECK, "⑤1日使用量", f"{tag}：指示書にあるが診断書に記載がありません。")
        if d.get("in_instruction") is False:
            add(CHECK, "⑤1日使用量", f"{tag}：診断書にあるが指示書に記載がありません。")
        if dd_u is not None and di_u is not None and dd_u != di_u:
            add(ERROR, "⑤1日使用量", f"{tag}：1日使用量が診断書（{fmt(dd_u)}）と指示書（{fmt(di_u)}）で一致しません。")

        # ⑨ 数量
        days, qty = num(d.get("days")), num(d.get("quantity"))
        per_day = di_u if di_u is not None else dd_u
        if d.get("quantity_indeterminate"):
            add(CHECK, "⑨数量", f"{tag}：半錠指示などで数量が確定しません。")
        if per_day is not None and days is not None and qty is not None:
            expect = (adj if adj is not None else per_day) * days
            if abs(expect - qty) > 1e-9:
                add(ERROR, "⑨数量", f"{tag}：数量 {fmt(qty)} ≠ 1日量×日数（{fmt(adj if adj is not None else per_day)}×{fmt(days)}＝{fmt(expect)}）。")
        elif case["extraction"]["instruction"].get("present"):
            add(CHECK, "⑨数量", f"{tag}：1日量・日数・数量のいずれかが読み取れません。")

        # ⑫ 1日用量の承認上限
        units = max([u for u in (dd_u, di_u, adj) if u is not None], default=None)
        if units is not None:
            if m and m.max_daily is not None:
                lim, lim_unit = m.max_daily, m.unit
            else:
                lim, lim_unit = num(d.get("approved_max_daily")), d.get("approved_max_unit") or unit
            if m and m.unit == "錠":
                total, tunit = units, "錠"
            elif st is not None:
                conv = _convert(st, unit, lim_unit)
                total, tunit = (round(conv * units, 6), lim_unit) if conv is not None else (None, "")
            else:
                total, tunit = None, ""
            if total is not None and lim is not None and total > lim + 1e-9:
                ok = next((v for v in r.get("verified_dose_ok", []) if self._is(v["drug"], generic) and abs(v["daily_total"] - total) < 1e-9), None)
                if ok:
                    add(INFO, "⑫用量上限", f"{tag}：1日{fmt(total)}{tunit}は上限{fmt(lim)}{lim_unit}超だが確認済み（{ok.get('note', '')}）。")
                else:
                    add(ERROR, "⑫用量上限", f"{tag}：1日総量 {fmt(total)}{tunit}（{fmt(st) + unit + '×' if st is not None and tunit != '錠' else ''}{fmt(units)}）が承認上限 {fmt(lim)}{lim_unit}/日を超えています。[{src}]")
            elif lim is None and st is not None:
                add(CHECK, "⑫用量上限", f"{tag}：承認上限が不明です。添付文書で確認してください。")

        # ⑬ 保険適応
        disease = dg.get("disease", "")
        if disease:
            if any(self._is(v["drug"], generic) and norm(v["disease"]) in norm(disease) for v in r.get("verified_indication_ok", [])):
                pass
            elif m and any(norm(k) in norm(disease) for k in m.not_indicated) and not any(norm(k) in norm(disease) for k in m.indications):
                add(ERROR, "⑬保険適応", f"{tag}：病名「{disease}」は保険適応外です。薬剤部へ確認してください。[{SOURCE_MASTER}]")
            elif d.get("indication") == "適応外":
                sev = ERROR if r.get("offlabel_severity") == "error" else CHECK
                add(sev, "⑬保険適応", f"{tag}：病名「{disease}」に対し保険適応外の可能性（{d.get('indication_note') or 'AI判断'}）。医師の意図を確認してください。[{SOURCE_AI}]")

        # ⑦ 処方日数制限・向精神薬
        psych = m.psych if m and m.psych is not None else tri(d.get("is_psychotropic"))
        ban = pdate(r["psych_ban_date"])
        dates = [x for x in (ad, dd, idt) if x]
        after_ban = any(x >= ban for x in dates)
        if psych and after_ban:
            permit = next((p for p in r.get("psych_permits", []) if norm(p["patient"]) and norm(p["patient"]) in norm(patient) and self._is(p["drug"], generic)), None)
            if permit:
                add(INFO, "⑦向精神薬", f"{tag}：向精神薬だが特別許可あり（{permit.get('note', '')}）。許可の有無を確認してください。")
            else:
                add(ERROR, "⑦向精神薬", f"{tag}：向精神薬です。{r['psych_ban_date']}以降は購送できません。")
        elif psych is None:
            add(CHECK, "⑦向精神薬", f"{tag}：向精神薬に該当するか未照合です。")
        if days is not None:
            new_until = pdate(m.new_drug_until) if m and m.new_drug_until else None
            is_new = (ad is not None and new_until is not None and ad < new_until) if m else tri(d.get("is_new_drug"))
            if is_new and days > 14:
                add(ERROR, "⑦日数制限", f"{tag}：新薬は14日分までですが {fmt(days)}日分です。")
            if not after_ban and m and m.old_limit and days > m.old_limit:
                add(ERROR, "⑦日数制限", f"{tag}：{fmt(days)}日分は投薬期間上限 {m.old_limit}日を超えています（9月までの旧運用）。")
            # 女性ホルモン系 28日周期
            hormone = m.hormone28 if m else bool(d.get("is_female_hormone_cycle"))
            if hormone and days % 28 and int(days) not in (m.ok_days if m else []):
                add(CHECK, "28日周期", f"{tag}：28日周期製剤ですが {fmt(days)}日分です（28の倍数でない）。")

        # 後発品
        if ins.get("no_generic_checked") and d.get("generic_prescription"):
            add(MINOR, "後発品", f"{tag}：「後発医薬品への変更不可」にチェックがあるのに一般名処方です。")

    def _is(self, a: str, b: str) -> bool:
        return _same_drug(a, b, self.m)

    # ------------------------------------------------------------------ バッチ横断
    def batch_checks(self, cases: list[dict], history: list[dict]) -> dict[str, list[Finding]]:
        out: dict[str, list[Finding]] = {c["id"]: [] for c in cases}
        info = [(c, _summary(c, self.m)) for c in cases]

        # ③ 公館コード桁数の多数決
        if not self.r.get("mission_code_digits"):
            lens = [len(re.sub(r"\D", "", s["mission_code"])) for _, s in info if s["mission_code"]]
            if len(lens) >= 3:
                common = max(set(lens), key=lens.count)
                for c, s in info:
                    n = len(re.sub(r"\D", "", s["mission_code"]))
                    if s["mission_code"] and n != common:
                        out[c["id"]].append(Finding(CHECK, "③公館コード", f"公館コード「{s['mission_code']}」は{n}桁です（他案件は{common}桁）。"))

        for a_i, (ca, sa) in enumerate(info):
            for cb, sb in info[a_i + 1:]:
                # ⑥ 原本の使い回し（同一療養者・同一発行日・同一医師）
                if sa["code"] and sa["code"] == sb["code"] and norm(sa["patient"]) == norm(sb["patient"]):
                    for k, label in (("diag_date", "診断書"), ("inst_date", "指示書")):
                        if sa[k] and sa[k] == sb[k] and norm(sa["doctor"]) == norm(sb["doctor"]):
                            for c, o in ((ca, sb), (cb, sa)):
                                out[c["id"]].append(Finding(ERROR, "⑥原本流用", f"同じ{label}（{sa[k]}発行）が「{o['patient']}」の別の申込にも使われています。"))
                # 同一世帯・同日・同一医師・完全同一処方
                if (sa["code"] and sa["code"] == sb["code"] and norm(sa["patient"]) != norm(sb["patient"])
                        and sa["apply_date"] == sb["apply_date"] and norm(sa["doctor"]) == norm(sb["doctor"])
                        and sa["drugs_key"] and sa["drugs_key"] == sb["drugs_key"]):
                    for c, o in ((ca, sb), (cb, sa)):
                        out[c["id"]].append(Finding(MINOR, "取り違え", f"同一世帯の「{o['patient']}」と同日・同一医師・完全同一処方です。取り違えがないか確認してください。"))

        # 過去バッチとの突き合わせ
        for c, s in info:
            for h in history:
                if h.get("case_id") == c["id"] or not s["code"] or h.get("code") != s["code"] or norm(h.get("patient")) != norm(s["patient"]):
                    continue
                if s["diag_date"] and h.get("diag_date") == s["diag_date"] and norm(h.get("doctor")) == norm(s["doctor"]) and h.get("apply_date") != s["apply_date"]:
                    out[c["id"]].append(Finding(ERROR, "⑥原本流用", f"同じ診断書（{s['diag_date']}発行）が過去の申込（{h.get('apply_date')}、{h.get('batch')}）で使用済みです。"))
                if h.get("apply_date") == s["apply_date"]:
                    continue
                out[c["id"]].extend(_compare_prev(s, h, self.m))
        return out


def _convert(v, frm, to):
    frm, to = norm(frm).replace("µ", "μ"), norm(to).replace("µ", "μ")
    if frm == to or not frm or not to:
        return v
    table = {("mg", "μg"): 1000, ("μg", "mg"): 0.001, ("g", "mg"): 1000, ("mg", "g"): 0.001}
    k = table.get((frm, to))
    return v * k if k else None


def _summary(c: dict, master: Master) -> dict:
    x = c["extraction"]
    app, dg, ins = x["application"], x["diagnosis"], x["instruction"]
    drugs = []
    for d in x.get("drugs", []):
        m = master.find(d.get("corrected_name"), d.get("name_as_written"), d.get("generic_name"))
        drugs.append({"key": m.generic if m else norm(d.get("corrected_name") or d.get("name_as_written")),
                      "name": d.get("name_as_written"), "strength": d.get("strength_value"), "unit": d.get("strength_unit"),
                      "per_day": d.get("inst_daily_units") if d.get("inst_daily_units") is not None else d.get("diag_daily_units"),
                      "days": d.get("days")})
    return {
        "code": norm_code(dg.get("staff_code") or app.get("staff_code")),
        "patient": app.get("patient_name") or dg.get("patient_name") or ins.get("patient_name") or app.get("applicant_name") or "",
        "applicant": app.get("applicant_name", ""),
        "apply_date": app.get("apply_date", ""), "diag_date": dg.get("issue_date", ""), "inst_date": ins.get("issue_date", ""),
        "doctor": ins.get("doctor_name") or dg.get("doctor_name") or "",
        "mission_code": app.get("mission_code", ""),
        "drugs": drugs,
        "drugs_key": json.dumps(sorted((d["key"], str(d["strength"]), str(d["per_day"]), str(d["days"])) for d in drugs), ensure_ascii=False),
    }


def _compare_prev(s: dict, h: dict, master: Master) -> list[Finding]:
    """前回分と1剤ずつ突き合わせる。日付が違えば二重供給とはしないが、変更点は明示する。"""
    F = []
    prev = {d["key"]: d for d in h.get("drugs", [])}
    cur = {d["key"]: d for d in s["drugs"]}
    hd, sd = pdate(h.get("apply_date")), pdate(s["apply_date"])
    for k, d in cur.items():
        p = prev.get(k)
        if not p:
            F.append(Finding(INFO, "前回比較", f"「{d['name']}」は前回（{h.get('apply_date')}）に無い新規薬剤です。"))
            continue
        if (str(p.get("strength")), str(p.get("per_day"))) != (str(d["strength"]), str(d["per_day"])):
            F.append(Finding(CHECK, "前回比較", f"「{d['name']}」の用量が変更：前回 {p.get('strength')}{p.get('unit') or ''}×{p.get('per_day')}/日 → 今回 {d['strength']}{d['unit'] or ''}×{d['per_day']}/日。"))
        if hd and sd and hd < sd and p.get("days") and (sd - hd).days < float(p["days"]) * 0.5:
            F.append(Finding(CHECK, "前回比較", f"「{d['name']}」：前回申込（{h.get('apply_date')}、{p.get('days')}日分）から{(sd - hd).days}日で再申込みです。"))
    for k, p in prev.items():
        if k not in cur:
            F.append(Finding(INFO, "前回比較", f"前回（{h.get('apply_date')}）の「{p['name']}」が今回はありません。"))
    return F


def history_entries(cases: list[dict], master: Master, batch: str) -> list[dict]:
    out = []
    for c in cases:
        s = _summary(c, master)
        if s["code"] and s["apply_date"]:
            out.append({"case_id": c["id"], "batch": batch, **{k: s[k] for k in ("code", "patient", "apply_date", "diag_date", "doctor", "drugs")}})
    return out
