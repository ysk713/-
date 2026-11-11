/* レポートを Word（.docx）にする（ブラウザ内のみ・外部に送信しない）
 *
 * PDF と同じブロック（見出し h1〜h3・文 p・箇条書き .rp-li・図 .rp-fig・表 table.rp-table・表紙 .rp-coverbox・目次 .rp-toc・改ページ）を
 * WordprocessingML に置き換え、JSZip でまとめる。見出しは Word の「見出し1〜3」なので、ナビゲーションウィンドウや目次の挿入に使える。
 */
(() => {
  const PAGE_W = 11906, PAGE_H = 16838, MARGIN = 1134;            // A4・余白2cm（twip）
  const CONTENT_TW = PAGE_W - MARGIN * 2;                          // 本文の幅（twip）
  const EMU_PER_TW = 635, CONTENT_EMU = CONTENT_TW * EMU_PER_TW;
  const PDF_BODY_PX = 682;                                         // PDF のページ（794px − 左右の余白）の本文の幅
  const xml = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
  const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';

  // ---- 文字（太字・改行を保つ）
  function runs(node, opt = {}) {
    let out = "";
    const rpr = (b) => {
      const p = [];
      if (b || opt.bold) p.push("<w:b/>");
      if (opt.color) p.push(`<w:color w:val="${opt.color}"/>`);
      if (opt.size) p.push(`<w:sz w:val="${opt.size}"/><w:szCs w:val="${opt.size}"/>`);
      return p.length ? `<w:rPr>${p.join("")}</w:rPr>` : "";
    };
    const walk = (n, bold) => {
      if (n.nodeType === 3) { const t = n.nodeValue.replace(/\s+/g, " "); if (t) out += `<w:r>${rpr(bold)}<w:t xml:space="preserve">${xml(t)}</w:t></w:r>`; return; }
      if (n.nodeType !== 1) return;
      const tag = n.tagName;
      if (tag === "BR") { out += "<w:r><w:br/></w:r>"; return; }
      if (tag === "IMG" || tag === "SCRIPT" || tag === "STYLE") return;
      if (n.classList && (n.classList.contains("dots") || n.classList.contains("pg"))) return;
      const b = bold || tag === "B" || tag === "STRONG" || tag === "TH";
      for (const c of n.childNodes) walk(c, b);
    };
    walk(node, false);
    return out;
  }
  const para = (inner, { style, align, keepNext, spacingAfter, indent } = {}) => {
    const p = [];
    if (style) p.push(`<w:pStyle w:val="${style}"/>`);
    if (keepNext) p.push("<w:keepNext/>");
    if (spacingAfter !== undefined) p.push(`<w:spacing w:after="${spacingAfter}"/>`);
    if (indent) p.push(`<w:ind w:left="${indent}" w:hanging="${Math.min(indent, 240)}"/>`);
    if (align) p.push(`<w:jc w:val="${align}"/>`);
    return `<w:p>${p.length ? `<w:pPr>${p.join("")}</w:pPr>` : ""}${inner}</w:p>`;
  };
  const PAGE_BREAK = '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';

  // ---- 図
  async function loadImage(src) {
    const img = new Image();
    img.src = src;
    await img.decode();
    let bytes, ext;
    if (/^data:image\/(png|jpe?g)/i.test(src) || /^blob:/.test(src)) {
      const r = await fetch(src); const ct = r.headers.get("content-type") || src.slice(5, 20);
      bytes = new Uint8Array(await r.arrayBuffer()); ext = /jpe?g/i.test(ct) ? "jpeg" : "png";
    } else {
      // SVG などは PNG に描き直す
      const c = document.createElement("canvas"); c.width = img.naturalWidth || 800; c.height = img.naturalHeight || 600;
      const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height);
      bytes = new Uint8Array(await (await new Promise((res) => c.toBlob(res, "image/png"))).arrayBuffer()); ext = "png";
    }
    return { bytes, ext, w: img.naturalWidth || 800, h: img.naturalHeight || 600 };
  }

  async function buildDocx(blocks, { title = "", header = "", footer = "" } = {}) {
    const media = [];          // { name, bytes, rid }
    let docPrId = 1;
    const drawing = async (imgEl) => {
      const im = await loadImage(imgEl.src);
      const k = media.length + 1, name = `image${k}.${im.ext}`, rid = `rIdImg${k}`;
      media.push({ name, bytes: im.bytes, rid, ext: im.ext });
      const wantPx = parseFloat(imgEl.style.width) || im.w;
      let cx = Math.round(Math.min(CONTENT_EMU, (wantPx / PDF_BODY_PX) * CONTENT_EMU));
      let cy = Math.round(cx * im.h / im.w);
      const maxH = (PAGE_H - MARGIN * 2 - 1400) * EMU_PER_TW;
      if (cy > maxH) { cx = Math.round(cx * maxH / cy); cy = maxH; }
      const id = docPrId++;
      return `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${id}" name="図${id}"/>` +
        `<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
        `<pic:pic><pic:nvPicPr><pic:cNvPr id="${id}" name="${name}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
        `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
    };

    // ---- 表
    const table = (t) => {
      const head = t.tHead ? [...t.tHead.rows] : [], body = t.tBodies[0] ? [...t.tBodies[0].rows] : [...t.rows].filter((r) => !head.includes(r));
      const ncol = Math.max(1, ...[...head, ...body].map((r) => [...r.cells].reduce((a, c) => a + (c.colSpan || 1), 0)));
      const cols = [...t.querySelectorAll("col")].map((c) => parseFloat(c.style.width) || 0);
      const tot = cols.reduce((a, b) => a + b, 0);
      const ws = cols.length === ncol && tot > 0 ? cols.map((w) => Math.round((CONTENT_TW * w) / tot)) : Array(ncol).fill(Math.floor(CONTENT_TW / ncol));
      const row = (tr, isHead) => {
        const bold = isHead || tr.classList.contains("b"), full = tr.classList.contains("rp-full");
        let ci = 0;
        const cells = [...tr.cells].map((td) => {
          const span = td.colSpan || 1, w = ws.slice(ci, ci + span).reduce((a, b) => a + b, 0); ci += span;
          const num = td.classList.contains("num");
          const shade = isHead ? '<w:shd w:val="clear" w:color="auto" w:fill="DCE3EE"/>' : full ? '<w:shd w:val="clear" w:color="auto" w:fill="F4F6F9"/>' : "";
          return `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/>${span > 1 ? `<w:gridSpan w:val="${span}"/>` : ""}${shade}</w:tcPr>` +
            para(runs(td, { bold, size: 17 }) || "", { style: "TableText", align: num ? "right" : isHead ? "center" : undefined }) + "</w:tc>";
        });
        return `<w:tr><w:trPr><w:cantSplit/>${isHead ? "<w:tblHeader/>" : ""}</w:trPr>${cells.join("")}</w:tr>`;
      };
      return `<w:tbl><w:tblPr><w:tblStyle w:val="ReportTable"/><w:tblW w:w="${CONTENT_TW}" w:type="dxa"/><w:tblLayout w:type="fixed"/></w:tblPr>` +
        `<w:tblGrid>${ws.map((w) => `<w:gridCol w:w="${w}"/>`).join("")}</w:tblGrid>${head.map((r) => row(r, true)).join("")}${body.map((r) => row(r, false)).join("")}</w:tbl>` +
        para("", { spacingAfter: 60 });
    };

    // ---- ブロック → 段落
    const conv = async (el) => {
      if (el === "break") return PAGE_BREAK;
      if (!el || el.nodeType !== 1) return "";
      const tag = el.tagName, cl = el.classList;
      if (/^H[1-3]$/.test(tag)) return para(runs(el), { style: "Heading" + tag[1], keepNext: true });
      if (tag === "TABLE") return table(el);
      if (cl.contains("rp-fig")) {
        const imgs = [...el.querySelectorAll("img")];
        let out = "";
        for (const i of imgs) out += para(await drawing(i), { align: "center", spacingAfter: 60 });
        return out;
      }
      if (cl.contains("rp-li")) return para(`<w:r><w:t xml:space="preserve">・</w:t></w:r>${runs(el)}`, { indent: 240 });
      if (cl.contains("rp-toc")) return para(runs(el), { style: "TocLine" });
      if (cl.contains("rp-coverbox")) {
        let out = para("", { spacingAfter: 2400 });
        for (const c of el.children) {
          const k = c.tagName === "H1" ? "CoverTitle" : c.classList.contains("rp-cm") ? "CoverSub" : c.classList.contains("rp-cn") ? "CoverNote" : "CoverText";
          out += para(runs(c), { style: k, align: "center" });
        }
        return out;
      }
      if (tag === "P") return para(runs(el), { style: cl.contains("rp-note") ? "Note" : undefined });
      // そのほかの入れ物：中の見出し・表・図・文を順に
      if ([...el.children].some((c) => /^(H[1-6]|P|DIV|TABLE|UL|OL|LI|SECTION)$/.test(c.tagName))) {
        let out = "";
        for (const c of el.childNodes) {
          if (c.nodeType === 3) { if (c.nodeValue.trim()) out += para(runs(c)); continue; }
          if (c.nodeType !== 1) continue;
          if (c.tagName === "UL" || c.tagName === "OL") { for (const li of c.children) out += para(`<w:r><w:t xml:space="preserve">・</w:t></w:r>${runs(li)}`, { indent: 240 }); continue; }
          if (c.tagName === "IMG") { out += para(await drawing(c), { align: "center" }); continue; }
          if (/^H[4-6]$/.test(c.tagName)) { out += para(runs(c), { style: "Heading3", keepNext: true }); continue; }
          out += await conv(c);
        }
        return out;
      }
      if (el.querySelector("img")) { let out = ""; for (const i of el.querySelectorAll("img")) out += para(await drawing(i), { align: "center" }); return out; }
      const t = runs(el);
      return t ? para(t) : "";
    };

    let body = "";
    let prevBreak = true;
    for (const b of blocks) {
      if (b === "break") { if (!prevBreak) body += PAGE_BREAK; prevBreak = true; continue; }
      const x = await conv(b);
      if (x) { body += x; prevBreak = false; }
    }

    const sect = `<w:sectPr><w:headerReference w:type="default" r:id="rIdHdr"/><w:footerReference w:type="default" r:id="rIdFtr"/>` +
      `<w:pgSz w:w="${PAGE_W}" w:h="${PAGE_H}"/><w:pgMar w:top="${MARGIN}" w:right="${MARGIN}" w:bottom="${MARGIN}" w:left="${MARGIN}" w:header="567" w:footer="567" w:gutter="0"/><w:titlePg/></w:sectPr>`;
    const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document ${NS}><w:body>${body}${sect}</w:body></w:document>`;
    const headerXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:hdr ${NS}>${para(`<w:r><w:t xml:space="preserve">${xml(header)}</w:t></w:r>`, { style: "Header" })}</w:hdr>`;
    const footerXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:ftr ${NS}>${para(
      `${footer ? `<w:r><w:t xml:space="preserve">${xml(footer)}　</w:t></w:r>` : ""}<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>`,
      { style: "Footer", align: "right" })}</w:ftr>`;
    const font = '<w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="游ゴシック" w:cs="Arial"/>';
    const st = (id, name, ppr, rpr, extra = "") => `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:basedOn w:val="Normal"/>${extra}<w:qFormat/><w:pPr>${ppr}</w:pPr><w:rPr>${rpr}</w:rPr></w:style>`;
    const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr>${font}<w:sz w:val="20"/><w:szCs w:val="20"/><w:lang w:val="en-US" w:eastAsia="ja-JP"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="80" w:line="300" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/><w:rPr><w:color w:val="1C2430"/></w:rPr></w:style>
${st("Heading1", "heading 1", '<w:keepNext/><w:spacing w:before="240" w:after="160"/><w:pBdr><w:bottom w:val="single" w:sz="12" w:space="2" w:color="1F3864"/></w:pBdr><w:outlineLvl w:val="0"/>', '<w:b/><w:color w:val="1F3864"/><w:sz w:val="32"/><w:szCs w:val="32"/>', '<w:next w:val="Normal"/>')}
${st("Heading2", "heading 2", '<w:keepNext/><w:spacing w:before="200" w:after="80"/><w:outlineLvl w:val="1"/>', '<w:b/><w:color w:val="1F3864"/><w:sz w:val="26"/><w:szCs w:val="26"/>', '<w:next w:val="Normal"/>')}
${st("Heading3", "heading 3", '<w:keepNext/><w:spacing w:before="160" w:after="40"/><w:outlineLvl w:val="2"/>', '<w:b/><w:color w:val="1F3864"/><w:sz w:val="22"/><w:szCs w:val="22"/>', '<w:next w:val="Normal"/>')}
${st("Note", "注記", '<w:spacing w:after="80"/>', '<w:color w:val="5A6474"/><w:sz w:val="17"/><w:szCs w:val="17"/>')}
${st("TableText", "表の文字", '<w:spacing w:before="20" w:after="20" w:line="240" w:lineRule="auto"/>', '<w:sz w:val="17"/><w:szCs w:val="17"/>')}
${st("TocLine", "目次の行", '<w:spacing w:after="100"/><w:ind w:left="360"/>', '<w:sz w:val="22"/><w:szCs w:val="22"/>')}
${st("CoverTitle", "表紙の題", '<w:jc w:val="center"/><w:spacing w:after="360"/>', '<w:b/><w:color w:val="1F3864"/><w:sz w:val="56"/><w:szCs w:val="56"/>')}
${st("CoverSub", "表紙の期間", '<w:jc w:val="center"/><w:spacing w:after="240"/>', '<w:sz w:val="32"/><w:szCs w:val="32"/>')}
${st("CoverText", "表紙の文", '<w:jc w:val="center"/><w:spacing w:after="160"/>', '<w:sz w:val="22"/><w:szCs w:val="22"/>')}
${st("CoverNote", "表紙の注意", '<w:jc w:val="center"/><w:spacing w:before="720" w:after="240"/>', '<w:color w:val="B03030"/><w:sz w:val="18"/><w:szCs w:val="18"/>')}
${st("Header", "header", "", '<w:color w:val="6B7280"/><w:sz w:val="16"/><w:szCs w:val="16"/>')}
${st("Footer", "footer", "", '<w:color w:val="6B7280"/><w:sz w:val="16"/><w:szCs w:val="16"/>')}
<w:style w:type="table" w:styleId="ReportTable"><w:name w:val="Report Table"/><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:color="B8C2D0"/><w:left w:val="single" w:sz="4" w:color="B8C2D0"/><w:bottom w:val="single" w:sz="4" w:color="B8C2D0"/><w:right w:val="single" w:sz="4" w:color="B8C2D0"/><w:insideH w:val="single" w:sz="4" w:color="B8C2D0"/><w:insideV w:val="single" w:sz="4" w:color="B8C2D0"/></w:tblBorders><w:tblCellMar><w:left w:w="70" w:type="dxa"/><w:right w:w="70" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>
</w:styles>`;
    const exts = [...new Set(media.map((x) => x.ext))];
    const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${exts.map((e) => `<Default Extension="${e}" ContentType="image/${e}"/>`).join("")}
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/><Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`;
    const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`;
    const docRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rIdHdr" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/><Relationship Id="rIdFtr" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>${
      media.map((x) => `<Relationship Id="${x.rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${x.name}"/>`).join("")}</Relationships>`;
    const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
    const core = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xml(title)}</dc:title><dc:creator>医務官月報 取りまとめ</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`;

    const zip = new JSZip();
    zip.file("[Content_Types].xml", contentTypes);
    zip.file("_rels/.rels", rels);
    zip.file("docProps/core.xml", core);
    zip.file("word/document.xml", documentXml);
    zip.file("word/styles.xml", stylesXml);
    zip.file("word/header1.xml", headerXml);
    zip.file("word/footer1.xml", footerXml);
    zip.file("word/_rels/document.xml.rels", docRels);
    for (const x of media) zip.file("word/media/" + x.name, x.bytes);
    return zip.generateAsync({ type: "blob", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", compression: "DEFLATE" });
  }

  window.DocxReport = { buildDocx };
})();
