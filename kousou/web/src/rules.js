/* 判定ロジック（python/kousou/rules.py の移植）。ブラウザでもNode（テスト）でも動く。
   入力の案件データは Python 版の読み取りJSONと同じ形：{application, diagnosis, instruction, drugs, reading_uncertainties} */
(function (root) {
  "use strict";
  const ERROR = "エラー相当", CHECK = "要確認", MINOR = "要確認（軽微）", INFO = "参考";
  const SEV_ORDER = { [ERROR]: 0, [CHECK]: 1, [MINOR]: 2, [INFO]: 3 };
  const NG_FORMS = ["液剤", "軟膏・クリーム", "スプレー・吸入", "坐剤", "注射"];

  const norm = s => String(s ?? "").normalize("NFKC").replace(/\s+/g, "").toLowerCase();
  const normCode = s => norm(s).replace(/[^0-9a-z]/g, "").replace(/^a+/, "").replace(/^0+/, "");
  const tri = v => (v === true || v === false || v == null) ? (v ?? null) : ({ "はい": true, "いいえ": false }[v] ?? null);
  const num = v => (v === "" || v == null || isNaN(parseFloat(String(v).normalize("NFKC")))) ? null : parseFloat(String(v).normalize("NFKC"));
  const pdate = s => (s && /^\d{4}-\d{2}-\d{2}/.test(s)) ? String(s).slice(0, 10) : null;   // ISO文字列のまま比較する
  const fmt = v => (typeof v === "number") ? String(+v.toFixed(6)) : String(v);
  function addMonths(iso, m) {
    let [y, mo, d] = iso.split("-").map(Number);
    mo += m; y += Math.floor((mo - 1) / 12); mo = ((mo - 1) % 12) + 1;
    const last = new Date(y, mo, 0).getDate();
    return `${y}-${String(mo).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
  }
  function convert(v, frm, to) {
    frm = norm(frm).replace("µ", "μ"); to = norm(to).replace("µ", "μ");
    if (frm === to || !frm || !to) return v;
    const k = { "mg>μg": 1000, "μg>mg": 0.001, "g>mg": 1000, "mg>g": 0.001 }[frm + ">" + to];
    return k ? v * k : null;
  }

  class Master {
    constructor(drugs) { this.drugs = drugs; }
    find(...names) {
      let best = null, bestLen = 0;
      for (const name of names) {
        const n = norm(name); if (!n) continue;
        for (const d of this.drugs) for (const a of d.names) {
          const an = norm(a);
          if (an && n.includes(an) && an.length > bestLen) { best = d; bestLen = an.length; }
        }
      }
      return best;
    }
    same(a, b) {
      const ma = this.find(a), mb = this.find(b);
      if (ma && mb) return ma === mb;
      return norm(a).includes(norm(b)) || norm(b).includes(norm(a));
    }
  }

  class Reviewer {
    constructor(rules, masterDrugs, today, legal) {
      this.r = rules; this.m = new Master(masterDrugs); this.legal = legal || [];
      this.today = today || new Date().toISOString().slice(0, 10);
    }

    review(c) {
      const F = [], add = (sev, item, msg) => F.push({ sev, item, msg });
      const x = c.extraction, app = x.application, dg = x.diagnosis, ins = x.instruction, r = this.r;

      (c.group_warnings || []).forEach(w => add(CHECK, "書類構成", w));
      for (const [label, doc] of [["申込書", app], ["診断書", dg], ["指示書", ins]])
        if (!doc.present) add(CHECK, "書類構成", `${label}が見当たりません。断定する前に、スキャンの重複・欠落・ページ境界のまたぎを再確認してください。`);

      const ad = pdate(app.apply_date), dd = pdate(dg.issue_date), idt = pdate(ins.issue_date);

      // ① 日付
      if (app.present && !ad) add(CHECK, "①日付", "申込日が未入力です。");
      for (const [label, doc, d] of [["診断書", dg, dd], ["指示書", ins, idt]]) {
        if (!doc.present) continue;
        if (!d) { add(CHECK, "①日付", `${label}の発行日が未入力です。`); continue; }
        if (d > this.today) add(ERROR, "①日付", `${label}の発行日 ${d} が未来の日付です（テンプレート初期値の残りに注意）。`);
        if (ad) {
          if (ad < d) add(ERROR, "①日付", `申込日 ${ad} が${label}の発行日 ${d} より前です。`);
          else {
            const lim = addMonths(d, +r.validity_months);
            if (ad > lim) add(ERROR, "①有効期限", `${label}の発行日 ${d} から申込日 ${ad} まで${r.validity_months}ヶ月を超えています（期限 ${lim}）。`);
          }
        }
      }

      // ② 職員コード
      const ca = app.staff_code || "", cd = dg.staff_code || "";
      if (dg.name_code_swapped) add(ERROR, "②職員コード", "診断書の氏名欄と職員コード欄が取り違えられています。");
      if (ca && cd) { if (normCode(ca) !== normCode(cd)) add(ERROR, "②職員コード", `申込書「${ca}」と診断書「${cd}」の数字部分が一致しません。`); }
      else if (app.present && dg.present) add(CHECK, "②職員コード", "申込書または診断書の職員コードが未入力です。");
      if (r.staff_code_digits) for (const [label, v] of [["申込書", ca], ["診断書", cd]]) {
        const digits = norm(v).replace(/\D/g, "");
        if (v && digits.length !== +r.staff_code_digits && digits.replace(/^0+/, "").length !== +r.staff_code_digits)
          add(CHECK, "②職員コード", `${label}の職員コード「${v}」の桁数（${digits.length}桁）が想定と異なります。`);
      }

      // ③ 公館コード（多数決は batchChecks）
      const mc = app.mission_code || "";
      if (mc && /[^0-9A-Za-z\-]/.test(norm(mc))) add(CHECK, "③公館コード", `公館コード「${mc}」に想定外の文字が含まれています。`);
      if (mc && r.mission_code_digits && mc.replace(/\D/g, "").length !== +r.mission_code_digits)
        add(CHECK, "③公館コード", `公館コード「${mc}」の桁数が想定（${r.mission_code_digits}桁）と異なります。`);

      // 申込書の様式・同意チェック
      const nItems = r.consent_items.length, unchecked = (app.consent_unchecked_items || []).filter(i => i >= 1 && i <= nItems);
      if (app.present) {
        const cnt = app.consent_item_count;
        if (cnt !== nItems || tri(app.consent_wording_current) === false) {
          const feat = app.old_form_features || "";
          add(ERROR, "申込書様式", `旧版の申込書が使用されています（同意チェック${cnt}項目${feat ? "・" + feat : ""}）。`);
        }
        if (unchecked.length) add(ERROR, "同意チェック", "レ点がない項目：" + unchecked.map(i => `(${i})`).join("、"));
        if (app.consent9_old_wording && cnt === nItems && !r.consent9_old_wording_ok) add(CHECK, "同意チェック", "同意チェック(9)が旧文言（「領収書」なし）です。");
      }

      // ⑪ 委任状
      const doctor = ins.doctor_name || dg.doctor_name || "";
      const letter = app.proxy_letter_present;
      if (tri(app.written_by_other) && !letter) add(ERROR, "⑪委任状", "申込者本人以外の記入と見られますが、委任状が添付されていません。");
      if (letter) {
        if (tri(app.proxy_letter_signed) === false) add(ERROR, "⑪委任状", "委任状に委任者の自筆署名がありません。");
        if (app.present && !(app.consent_unchecked_items || []).includes(1)) add(ERROR, "⑪委任状", "委任状が添付されているのに、同意チェック(1)「申込者本人が記入」にレ点があります（矛盾）。");
        if (app.proxy_name && doctor && norm(app.proxy_name) === norm(doctor)) add(CHECK, "⑪委任状", `委任状の受任者「${app.proxy_name}」が発行医と同一です。`);
      }
      const rel = app.patient_relation || "";
      if (doctor && norm(app.applicant_name) === norm(doctor) && (!rel || rel.includes("本人")))
        add(CHECK, "申込者", `申込者が発行医（${doctor}）本人で、療養者も本人です。`);

      // ④ 診断書の用法・用量
      if (dg.present && !dg.has_dosage) add(ERROR, "④診断書", "診断書に用法・用量の記載がなく、指示書との1日使用量照合ができません。");

      // 診断書原本の別送
      const mission = app.mission_name || "";
      if (dg.original_sent_later) {
        if ((r.patrol_missions || []).some(p => p && norm(mission).includes(norm(p)))) add(INFO, "原本別送", `診断書原本は後日送付（${mission}は巡回公館・健康相談公館のため可）。`);
        else add(CHECK, "原本別送", `診断書原本が後日送付です。${mission || "所属公館"}が巡回公館・健康相談公館か確認してください。`);
      }

      // 署名・押印
      for (const [label, doc, d] of [["診断書", dg, dd], ["指示書", ins, idt]]) if (doc.present) this.sign(label, doc, d, ad, mission, add);

      // ⑩ 兼轄（既定では指摘しない）
      const dm = ins.doctor_mission || dg.doctor_mission;
      if (r.flag_kankatsu && dm && mission && !norm(mission).includes(norm(dm)) && !norm(dm).includes(norm(mission)))
        add(CHECK, "⑩兼轄", `発行医所属「${dm}」と療養者所属「${mission}」が異なります。`);

      const drugs = x.drugs || [];
      if (!drugs.length && (dg.present || ins.present)) add(CHECK, "薬剤", "処方薬剤が未入力です。");
      drugs.forEach((d, i) => this.drug(i + 1, d, c, ad, dd, idt, ins, dg, add));
      (x.reading_uncertainties || []).forEach(u => add(INFO, "読取注意", u));

      return F.sort((a, b) => SEV_ORDER[a.sev] - SEV_ORDER[b.sev]);
    }

    sign(label, doc, d, ad, mission, add) {
      const r = this.r; if (!d) return;
      const sig = doc.signature, seal = tri(doc.seal);
      if (d >= r.new_form_date && (!ad || ad >= r.strict_sign_from_apply_date)) {
        if (sig === "判読不能" || !sig) add(CHECK, "署名・押印", `${label}：医師氏名欄の署名/記名が未確認です。`);
        else if (sig !== "自筆署名") add(ERROR, "署名・押印", `${label}：自筆署名がありません（${sig}）。${r.new_form_date}以降の発行は自筆署名と押印が必須です。`);
        if (seal === false) {
          if ((r.no_seal_missions || []).some(m => mission.includes(m))) add(INFO, "署名・押印", `${label}：押印なし（${mission}は印鑑未調達のため可）。`);
          else add(ERROR, "署名・押印", `${label}：押印がありません。`);
        } else if (seal === null) add(CHECK, "署名・押印", `${label}：押印の有無が未確認です。`);
      } else if (d < r.new_form_date) {
        if (!(sig === "自筆署名" || (sig === "記名" && seal)))
          add(ERROR, "署名・押印", `${label}：旧基準「記名押印または署名」を満たしていません（${sig || "未選択"}／押印${seal ? "あり" : "なし"}）。`);
      }
      // 9月中の日付の書類は書式要件を指摘しない
    }

    drug(i, d, c, ad, dd, idt, ins, dg, add) {
      const r = this.r;
      const written = d.name_as_written || "?";
      const st = num(d.strength_value), unit = d.strength_unit || "";
      const stTxt = st !== null ? fmt(st) + unit : "";
      const tag = `薬剤${i}「${written}${!stTxt || norm(written).includes(norm(stTxt)) ? "" : " " + stTxt}」`;
      const m = this.m.find(d.corrected_name, d.name_as_written, d.generic_name);
      const generic = m ? m.names[0] : (d.generic_name || d.corrected_name || written);
      const app = c.extraction.application;
      const patient = app.patient_name || c.extraction.diagnosis.patient_name || "";

      // 法規制（診断書アプリの規制薬リスト）：麻薬・覚醒剤原料等は購送不可、向精神薬はマスタ未登録でも判定する
      const allNames = norm([written, d.corrected_name, d.generic_name].join(" "));
      const legal = this.legal.find(l => l.stems.some(x => allNames.includes(norm(x))) && !l.except.some(x => allNames.includes(norm(x))));
      if (legal && !legal.psych) add(ERROR, "法規制", `${tag}：${legal.law}に該当し、購送できません。`);

      if (!m) add(CHECK, "薬品マスタ", `${tag}：薬品マスタ未登録です。薬品名の実在・規格・1日最大用量・向精神薬/新薬の該当・保険適応を添付文書で確認してください。`);

      // ⑩ 薬品名・規格
      if (d.corrected_name || d.name_exists === false) add(ERROR, "⑩薬品名", `${tag}：薬品名の誤記の可能性（正：${d.corrected_name || "不明"}）。`);
      if (m && m.strengths && m.strengths.length && st !== null) {
        const s = convert(st, unit, m.unit);
        if (s !== null && !m.strengths.some(v => Math.abs(s - v) < 1e-9))
          add(ERROR, "⑩規格", `${tag}：${m.names[0]}に ${fmt(st)}${unit} の規格はありません（実在：${m.strengths.map(fmt).join("／")}${m.unit}）。`);
      } else if (!m && tri(d.strength_exists) === false) add(ERROR, "⑩規格", `${tag}：この含有量の規格は存在しない可能性があります。`);

      // 剤形
      if (NG_FORMS.includes(d.dosage_form) || d.cold_storage)
        add(ERROR, "剤形", `${tag}：購送できない剤形です（${d.dosage_form || ""}${d.cold_storage ? "・冷所保存" : ""}）。`);

      // ⑤ 1日使用量クロスチェック
      const ddu = num(d.diag_daily_units), diu = num(d.inst_daily_units), adj = num(d.adjustable_max_units);
      if (d.in_diagnosis === false) add(CHECK, "⑤1日使用量", `${tag}：指示書にあるが診断書に記載がありません。`);
      if (d.in_instruction === false) add(CHECK, "⑤1日使用量", `${tag}：診断書にあるが指示書に記載がありません。`);
      if (ddu !== null && diu !== null && ddu !== diu) add(ERROR, "⑤1日使用量", `${tag}：1日使用量が診断書（${fmt(ddu)}）と指示書（${fmt(diu)}）で一致しません。`);

      // ⑨ 数量
      const days = num(d.days), qty = num(d.quantity), perDay = diu !== null ? diu : ddu;
      if (d.quantity_indeterminate) add(CHECK, "⑨数量", `${tag}：半錠指示などで数量が確定しません。`);
      if (perDay !== null && days !== null && qty !== null) {
        const u = adj !== null ? adj : perDay, expect = u * days;
        if (Math.abs(expect - qty) > 1e-9) add(ERROR, "⑨数量", `${tag}：数量 ${fmt(qty)} ≠ 1日量×日数（${fmt(u)}×${fmt(days)}＝${fmt(expect)}）。`);
      } else if (c.extraction.instruction.present) add(CHECK, "⑨数量", `${tag}：1日量・日数・数量のいずれかが未入力です。`);

      // ⑫ 1日用量の承認上限
      const unitsList = [ddu, diu, adj].filter(v => v !== null);
      if (unitsList.length) {
        const units = Math.max(...unitsList);
        let lim, limUnit;
        if (m && m.max_daily != null) { lim = m.max_daily; limUnit = m.unit; }
        else { lim = num(d.approved_max_daily); limUnit = d.approved_max_unit || unit; }
        let total = null, tunit = "";
        if (m && m.unit === "錠") { total = units; tunit = "錠"; }
        else if (st !== null) { const conv = convert(st, unit, limUnit); if (conv !== null) { total = +(conv * units).toFixed(6); tunit = limUnit; } }
        if (total !== null && lim != null && total > lim + 1e-9) {
          const ok = (r.verified_dose_ok || []).find(v => this.m.same(v.drug, generic) && Math.abs(v.daily_total - total) < 1e-9);
          if (ok) add(INFO, "⑫用量上限", `${tag}：1日${fmt(total)}${tunit}は上限${fmt(lim)}${limUnit}超だが確認済み（${ok.note || ""}）。`);
          else add(ERROR, "⑫用量上限", `${tag}：1日総量 ${fmt(total)}${tunit}（${st !== null && tunit !== "錠" ? fmt(st) + unit + "×" : ""}${fmt(units)}）が承認上限 ${fmt(lim)}${limUnit}/日を超えています。`);
        }
      }

      // ⑬ 保険適応
      const disease = dg.disease || "";
      if (disease && m) {
        const verified = (r.verified_indication_ok || []).some(v => this.m.same(v.drug, generic) && norm(disease).includes(norm(v.disease)));
        const hitInd = (m.indications || []).some(k => norm(disease).includes(norm(k)));
        const hitNot = (m.not_indicated || []).find(k => norm(disease).includes(norm(k)));
        if (!verified && hitNot && !hitInd) add(ERROR, "⑬保険適応", `${tag}：病名「${disease}」は保険適応外です。薬剤部へ確認してください。`);
        else if (!verified && !hitInd && (m.indications || []).length) {
          const sev = r.offlabel_severity === "error" ? ERROR : CHECK;
          add(sev, "⑬保険適応", `${tag}：病名「${disease}」が適応（${m.indications.slice(0, 4).join("・")}…）に見当たりません。保険適応と医師の意図を確認してください。`);
        }
      } else if (disease && d.indication === "適応外") {
        add(r.offlabel_severity === "error" ? ERROR : CHECK, "⑬保険適応", `${tag}：病名「${disease}」に対し保険適応外の可能性。医師の意図を確認してください。`);
      }

      // ⑦ 向精神薬・処方日数
      const psych = (m && m.psych != null) ? m.psych : (legal && legal.psych) ? true : tri(d.is_psychotropic);
      const afterBan = [ad, dd, idt].filter(Boolean).some(x => x >= r.psych_ban_date);
      if (psych && afterBan) {
        const permit = (r.psych_permits || []).find(p => norm(p.patient) && norm(patient).includes(norm(p.patient)) && this.m.same(p.drug, generic));
        if (permit) add(INFO, "⑦向精神薬", `${tag}：向精神薬だが特別許可あり（${permit.note || ""}）。許可の有無を確認してください。`);
        else add(ERROR, "⑦向精神薬", `${tag}：向精神薬です。${r.psych_ban_date}以降は購送できません。`);
      } else if (psych === null && m) add(CHECK, "⑦向精神薬", `${tag}：向精神薬に該当するか未照合です。`);
      if (days !== null) {
        const isNew = m ? !!(ad && m.new_drug_until && ad < m.new_drug_until) : tri(d.is_new_drug);
        if (isNew && days > 14) add(ERROR, "⑦日数制限", `${tag}：新薬は14日分までですが ${fmt(days)}日分です。`);
        if (!afterBan && m && m.old_limit && days > m.old_limit) add(ERROR, "⑦日数制限", `${tag}：${fmt(days)}日分は投薬期間上限 ${m.old_limit}日を超えています（9月までの旧運用）。`);
        const hormone = m ? !!m.hormone28 : !!d.is_female_hormone_cycle;
        if (hormone && days % 28 && !((m && m.ok_days) || []).includes(days)) add(CHECK, "28日周期", `${tag}：28日周期製剤ですが ${fmt(days)}日分です（28の倍数でない）。`);
      }

      // 後発品
      if (ins.no_generic_checked && d.generic_prescription) add(MINOR, "後発品", `${tag}：「後発医薬品への変更不可」にチェックがあるのに一般名処方です。`);
    }

    summary(c) {
      const x = c.extraction, app = x.application, dg = x.diagnosis, ins = x.instruction;
      const drugs = (x.drugs || []).map(d => {
        const m = this.m.find(d.corrected_name, d.name_as_written, d.generic_name);
        return { key: m ? m.names[0] : norm(d.corrected_name || d.name_as_written), name: d.name_as_written, strength: d.strength_value,
                 unit: d.strength_unit, per_day: d.inst_daily_units !== "" && d.inst_daily_units != null ? d.inst_daily_units : d.diag_daily_units, days: d.days };
      });
      return {
        code: normCode(dg.staff_code || app.staff_code),
        patient: app.patient_name || dg.patient_name || ins.patient_name || app.applicant_name || "",
        apply_date: app.apply_date || "", diag_date: dg.issue_date || "", inst_date: ins.issue_date || "",
        doctor: ins.doctor_name || dg.doctor_name || "", mission_code: app.mission_code || "", drugs,
        drugs_key: JSON.stringify(drugs.map(d => [d.key, String(d.strength), String(d.per_day), String(d.days)]).sort()),
      };
    }

    batchChecks(cases, history) {
      const out = {}; cases.forEach(c => out[c.id] = []);
      const info = cases.map(c => [c, this.summary(c)]);
      if (!this.r.mission_code_digits) {
        const lens = info.map(([, s]) => s.mission_code.replace(/\D/g, "").length).filter(Boolean);
        if (lens.length >= 3) {
          const cnt = {}; lens.forEach(l => cnt[l] = (cnt[l] || 0) + 1);
          const common = +Object.entries(cnt).sort((a, b) => b[1] - a[1])[0][0];
          info.forEach(([c, s]) => { const n = s.mission_code.replace(/\D/g, "").length;
            if (s.mission_code && n !== common) out[c.id].push({ sev: CHECK, item: "③公館コード", msg: `公館コード「${s.mission_code}」は${n}桁です（他案件は${common}桁）。` }); });
        }
      }
      for (let a = 0; a < info.length; a++) for (let b = a + 1; b < info.length; b++) {
        const [ca, sa] = info[a], [cb, sb] = info[b];
        if (sa.code && sa.code === sb.code && norm(sa.patient) === norm(sb.patient)) {
          for (const [k, label] of [["diag_date", "診断書"], ["inst_date", "指示書"]])
            if (sa[k] && sa[k] === sb[k] && norm(sa.doctor) === norm(sb.doctor))
              for (const [c, o] of [[ca, sb], [cb, sa]]) out[c.id].push({ sev: ERROR, item: "⑥原本流用", msg: `同じ${label}（${sa[k]}発行）が「${o.patient}」の別の申込にも使われています。` });
        }
        if (sa.code && sa.code === sb.code && norm(sa.patient) !== norm(sb.patient) && sa.apply_date === sb.apply_date
            && norm(sa.doctor) === norm(sb.doctor) && sa.drugs.length && sa.drugs_key === sb.drugs_key)
          for (const [c, o] of [[ca, sb], [cb, sa]]) out[c.id].push({ sev: MINOR, item: "取り違え", msg: `同一世帯の「${o.patient}」と同日・同一医師・完全同一処方です。取り違えがないか確認してください。` });
      }
      for (const [c, s] of info) for (const h of history || []) {
        if (h.case_id === c.id || !s.code || h.code !== s.code || norm(h.patient) !== norm(s.patient)) continue;
        if (s.diag_date && h.diag_date === s.diag_date && norm(h.doctor) === norm(s.doctor) && h.apply_date !== s.apply_date)
          out[c.id].push({ sev: ERROR, item: "⑥原本流用", msg: `同じ診断書（${s.diag_date}発行）が過去の申込（${h.apply_date}）で使用済みです。` });
        if (h.apply_date === s.apply_date) continue;
        out[c.id].push(...comparePrev(s, h));
      }
      return out;
    }

    historyEntries(cases, batch) {
      return cases.map(c => [c, this.summary(c)]).filter(([, s]) => s.code && s.apply_date)
        .map(([c, s]) => ({ case_id: c.id, batch, code: s.code, patient: s.patient, apply_date: s.apply_date, diag_date: s.diag_date, doctor: s.doctor, drugs: s.drugs }));
    }
  }

  function comparePrev(s, h) {
    const F = [], prev = {}, cur = {};
    (h.drugs || []).forEach(d => prev[d.key] = d); s.drugs.forEach(d => cur[d.key] = d);
    for (const [k, d] of Object.entries(cur)) {
      const p = prev[k];
      if (!p) { F.push({ sev: INFO, item: "前回比較", msg: `「${d.name}」は前回（${h.apply_date}）に無い新規薬剤です。` }); continue; }
      if (String(p.strength) !== String(d.strength) || String(p.per_day) !== String(d.per_day))
        F.push({ sev: CHECK, item: "前回比較", msg: `「${d.name}」の用量が変更：前回 ${p.strength}${p.unit || ""}×${p.per_day}/日 → 今回 ${d.strength}${d.unit || ""}×${d.per_day}/日。` });
      if (h.apply_date < s.apply_date && p.days) {
        const gap = Math.round((new Date(s.apply_date) - new Date(h.apply_date)) / 864e5);
        if (gap < +p.days * 0.5) F.push({ sev: CHECK, item: "前回比較", msg: `「${d.name}」：前回申込（${h.apply_date}、${p.days}日分）から${gap}日で再申込みです。` });
      }
    }
    for (const [k, p] of Object.entries(prev)) if (!(k in cur)) F.push({ sev: INFO, item: "前回比較", msg: `前回（${h.apply_date}）の「${p.name}」が今回はありません。` });
    return F;
  }

  const api = { ERROR, CHECK, MINOR, INFO, SEV_ORDER, Reviewer, Master, norm, normCode };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.KousouRules = api;
})(typeof window !== "undefined" ? window : globalThis);
