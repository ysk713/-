/* パスワード付きPDFの書き出し（ブラウザ内のみ・外部ライブラリなし）
 *
 * ページごとの JPEG 画像を A4 の PDF にまとめ、PDF 2.0 の標準セキュリティ（AES-256, R6）で暗号化する。
 * 開くにはユーザーパスワードが必要。所有者パスワードは乱数なので、印刷以外（編集・コピー等）は許可しない。
 * 暗号処理は Web Crypto（SHA-256/384/512, AES-CBC）を使う。
 */
(() => {
  const enc = new TextEncoder();
  const subtle = crypto.subtle;
  const rand = (n) => crypto.getRandomValues(new Uint8Array(n));
  const cat = (...a) => {
    const out = new Uint8Array(a.reduce((s, x) => s + x.length, 0));
    let o = 0;
    for (const x of a) { out.set(x, o); o += x.length; }
    return out;
  };
  const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

  // AES-CBC（Web Crypto は PKCS#7 で詰め物をするので、16の倍数の入力なら最後の1ブロックを捨てれば「詰め物なし」と同じ）
  async function aesCbc(key, iv, data, pad) {
    const k = await subtle.importKey("raw", key, "AES-CBC", false, ["encrypt"]);
    const out = new Uint8Array(await subtle.encrypt({ name: "AES-CBC", iv }, k, data));
    return pad ? out : out.slice(0, data.length);
  }

  // ISO 32000-2 アルゴリズム 2.B（R6 のパスワードハッシュ）
  async function hash2B(pw, salt, udata) {
    let K = new Uint8Array(await subtle.digest("SHA-256", cat(pw, salt, udata)));
    let E;
    for (let i = 0; ; ) {
      const unit = cat(pw, K, udata), K1 = new Uint8Array(unit.length * 64);
      for (let j = 0; j < 64; j++) K1.set(unit, j * unit.length);
      E = await aesCbc(K.slice(0, 16), K.slice(16, 32), K1, false);
      let s = 0;
      for (let j = 0; j < 16; j++) s += E[j];
      K = new Uint8Array(await subtle.digest(["SHA-256", "SHA-384", "SHA-512"][s % 3], E));
      i++;
      if (i >= 64 && E[E.length - 1] <= i - 32) break;
    }
    return K.slice(0, 32);
  }

  async function encryptDict(userPw, ownerPw, P) {
    const upw = enc.encode(userPw).slice(0, 127), opw = enc.encode(ownerPw).slice(0, 127);
    const fileKey = rand(32), zero = new Uint8Array(16);
    const uv = rand(8), uk = rand(8);
    const U = cat(await hash2B(upw, uv, new Uint8Array(0)), uv, uk);
    const UE = await aesCbc(await hash2B(upw, uk, new Uint8Array(0)), zero, fileKey, false);
    const ov = rand(8), ok = rand(8);
    const O = cat(await hash2B(opw, ov, U), ov, ok);
    const OE = await aesCbc(await hash2B(opw, ok, U), zero, fileKey, false);
    const perms = new Uint8Array(16);
    new DataView(perms.buffer).setInt32(0, P, true);
    perms.set([0xff, 0xff, 0xff, 0xff, 0x54, 0x61, 0x64, 0x62], 4);  // FFFFFFFF "T" "adb"
    perms.set(rand(4), 12);
    const Perms = await aesCbc(fileKey, zero, perms, false);
    return {
      fileKey,
      dict: `<< /Filter /Standard /V 5 /R 6 /Length 256 /P ${P} /EncryptMetadata true` +
        ` /CF << /StdCF << /AuthEvent /DocOpen /CFM /AESV3 /Length 32 >> >> /StmF /StdCF /StrF /StdCF` +
        ` /O <${hex(O)}> /U <${hex(U)}> /OE <${hex(OE)}> /UE <${hex(UE)}> /Perms <${hex(Perms)}> >>`,
    };
  }

  // 印刷（高品質）とアクセシビリティ用抽出のみ許可。編集・コピー・注釈・ページ構成の変更は不可
  const P_PRINT_ONLY = (0xfffff000 | 0x800 | 0x200 | 0xc0 | 0x4) | 0;

  /**
   * pages: [{ jpeg: Uint8Array, width: px, height: px }]（A4 縦に引き伸ばして貼る）
   * opts.links:    [{ page, rect: [x, y, w, h]（ページ画像の割合 0〜1、左上原点）, dest: 飛び先のページ番号 }]（目次のリンク）
   * opts.outlines: [{ title, dest }]（しおり。ビューアの左側に出る目次）
   * opts.overlay:  { rgba: Uint8ClampedArray, width, height }（印刷するときだけ出る層。全ページ共通の透かしなど）
   * 戻り値: Blob（application/pdf）
   */
  async function buildEncryptedPdf(pages, { userPassword, ownerPassword = null, title, links = [], outlines = [], overlay = null } = {}) {
    // 所有者パスワード：指定があればそれ（開くパスワードと同じにすれば、同じパスワードで解除・権限の変更ができる）。なければ乱数（誰も解除できない）
    ownerPassword = ownerPassword || hex(rand(24));
    const { fileKey, dict } = await encryptDict(userPassword, ownerPassword, P_PRINT_ONLY);
    const encStream = async (data) => { const iv = rand(16); return cat(iv, await aesCbc(fileKey, iv, data, true)); };
    // 文字列は UTF-16BE（BOM付き）にしてから暗号化する
    const utf16 = (s) => { const b = new Uint8Array(2 + s.length * 2); b[0] = 0xfe; b[1] = 0xff; for (let i = 0; i < s.length; i++) { b[2 + i * 2] = s.charCodeAt(i) >> 8; b[3 + i * 2] = s.charCodeAt(i) & 255; } return b; };
    const encString = async (s) => `<${hex(await encStream(utf16(s)))}>`;
    const deflate = async (u8) => new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(new CompressionStream("deflate"))).arrayBuffer());
    const W = 595.28, H = 841.89;
    const chunks = [], offsets = [];
    let len = 0, next = 1;
    const alloc = () => next++;
    const put = (x) => { const b = typeof x === "string" ? enc.encode(x) : x; chunks.push(b); len += b.length; };
    const obj = (n, body) => { offsets[n] = len; put(`${n} 0 obj\n`); for (const b of [].concat(body)) put(b); put("\nendobj\n"); };
    const stream = async (n, head, data) => {
      const e = await encStream(data);
      obj(n, [`<< ${head} /Length ${e.length} >>\nstream\n`, e, "\nendstream"]);
    };

    // 番号の割り当て
    const CAT = alloc(), PAGES = alloc(), ENC = alloc(), INFO = alloc();
    const pg = pages.map(() => ({ page: alloc(), content: alloc(), image: alloc() }));
    const OCG = overlay ? alloc() : 0, OV = overlay ? alloc() : 0, OVM = overlay ? alloc() : 0;
    const linkNums = links.map(() => alloc());
    const OUT = outlines.length ? alloc() : 0, outNums = outlines.map(() => alloc());
    const dest = (i) => `[${pg[Math.max(0, Math.min(pages.length - 1, i))].page} 0 R /XYZ null null null]`;

    put("%PDF-2.0\n%\xe2\xe3\xcf\xd3\n");
    // 印刷するときだけ表示する層（任意コンテンツ）：画面では非表示、印刷では表示。
    // 対応していないビューアでは表示されたままになる（＝印刷にも必ず出る）よう、既定は表示にしておく
    const ocProps = overlay ? ` /OCProperties << /OCGs [${OCG} 0 R] /D << /ON [${OCG} 0 R] /AS [<< /Event /View /OCGs [${OCG} 0 R] /Category [/View] >> << /Event /Print /OCGs [${OCG} 0 R] /Category [/Print] >>] >> >>` : "";
    obj(CAT, `<< /Type /Catalog /Pages ${PAGES} 0 R /ViewerPreferences << /DisplayDocTitle true >>${OUT ? ` /Outlines ${OUT} 0 R /PageMode /UseOutlines` : ""}${ocProps} >>`);
    obj(PAGES, `<< /Type /Pages /Kids [${pg.map((x) => `${x.page} 0 R`).join(" ")}] /Count ${pages.length} >>`);
    obj(ENC, dict);
    obj(INFO, `<< /Title ${await encString(title || "")} /Producer ${await encString("医務官月報 取りまとめ")} >>`);
    if (overlay) {
      obj(OCG, `<< /Type /OCG /Name ${await encString("取扱注意（印刷時のみ）")} /Usage << /View << /ViewState /OFF >> /Print << /PrintState /ON >> >> >>`);
      const n = overlay.width * overlay.height, rgb = new Uint8Array(n * 3), al = new Uint8Array(n), src = overlay.rgba;
      for (let i = 0; i < n; i++) { rgb[i * 3] = src[i * 4]; rgb[i * 3 + 1] = src[i * 4 + 1]; rgb[i * 3 + 2] = src[i * 4 + 2]; al[i] = src[i * 4 + 3]; }
      await stream(OVM, `/Type /XObject /Subtype /Image /Width ${overlay.width} /Height ${overlay.height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode`, await deflate(al));
      await stream(OV, `/Type /XObject /Subtype /Image /Width ${overlay.width} /Height ${overlay.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /SMask ${OVM} 0 R`, await deflate(rgb));
    }
    for (let i = 0; i < pages.length; i++) {
      const p = pages[i], o = pg[i];
      const annots = links.map((l, k) => (l.page === i ? `${linkNums[k]} 0 R` : "")).filter(Boolean);
      const res = `/XObject << /Im${i} ${o.image} 0 R${overlay ? ` /Wm ${OV} 0 R` : ""} >>${overlay ? ` /Properties << /oc1 ${OCG} 0 R >>` : ""}`;
      obj(o.page, `<< /Type /Page /Parent ${PAGES} 0 R /MediaBox [0 0 ${W} ${H}] /Contents ${o.content} 0 R /Resources << ${res} >>${annots.length ? ` /Annots [${annots.join(" ")}]` : ""} >>`);
      await stream(o.content, "", enc.encode(`q ${W} 0 0 ${H} 0 0 cm /Im${i} Do Q` + (overlay ? ` /OC /oc1 BDC q ${W} 0 0 ${H} 0 0 cm /Wm Do Q EMC` : "")));
      await stream(o.image, `/Type /XObject /Subtype /Image /Width ${p.width} /Height ${p.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode`, p.jpeg);
    }
    // 目次のリンク（ページ画像の割合 → PDF の座標。PDF は左下が原点）
    links.forEach((l, k) => {
      const [x, y, w, h] = l.rect, r = [x * W, (1 - y - h) * H, (x + w) * W, (1 - y) * H].map((v) => v.toFixed(2));
      obj(linkNums[k], `<< /Type /Annot /Subtype /Link /Rect [${r.join(" ")}] /Border [0 0 0] /F 4 /Dest ${dest(l.dest)} >>`);
    });
    // しおり
    if (OUT) {
      obj(OUT, `<< /Type /Outlines /First ${outNums[0]} 0 R /Last ${outNums[outNums.length - 1]} 0 R /Count ${outlines.length} >>`);
      for (let k = 0; k < outlines.length; k++) {
        obj(outNums[k], `<< /Title ${await encString(outlines[k].title)} /Parent ${OUT} 0 R${k > 0 ? ` /Prev ${outNums[k - 1]} 0 R` : ""}${k < outlines.length - 1 ? ` /Next ${outNums[k + 1]} 0 R` : ""} /Dest ${dest(outlines[k].dest)} >>`);
      }
    }
    const size = next, xref = len, id = hex(rand(16));
    put(`xref\n0 ${size}\n0000000000 65535 f \n`);
    for (let n = 1; n < size; n++) put(`${String(offsets[n]).padStart(10, "0")} 00000 n \n`);
    put(`trailer\n<< /Size ${size} /Root ${CAT} 0 R /Info ${INFO} 0 R /Encrypt ${ENC} 0 R /ID [<${id}> <${id}>] >>\nstartxref\n${xref}\n%%EOF\n`);
    return new Blob(chunks, { type: "application/pdf" });
  }

  window.SecurePdf = { buildEncryptedPdf };
})();
