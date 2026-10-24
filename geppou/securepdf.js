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
   * 戻り値: Blob（application/pdf）
   */
  async function buildEncryptedPdf(pages, { userPassword, title } = {}) {
    const ownerPassword = hex(rand(24));
    const { fileKey, dict } = await encryptDict(userPassword, ownerPassword, P_PRINT_ONLY);
    const encStream = async (data) => { const iv = rand(16); return cat(iv, await aesCbc(fileKey, iv, data, true)); };
    // 文字列は UTF-16BE（BOM付き）にしてから暗号化する
  const utf16 = (s) => { const b = new Uint8Array(2 + s.length * 2); b[0] = 0xfe; b[1] = 0xff; for (let i = 0; i < s.length; i++) { b[2 + i * 2] = s.charCodeAt(i) >> 8; b[3 + i * 2] = s.charCodeAt(i) & 255; } return b; };
  const encString = async (s) => `<${hex(await encStream(utf16(s)))}>`;
    const W = 595.28, H = 841.89;
    const chunks = [], offsets = [];
    let len = 0;
    const put = (x) => { const b = typeof x === "string" ? enc.encode(x) : x; chunks.push(b); len += b.length; };
    const obj = (n, body) => { offsets[n] = len; put(`${n} 0 obj\n`); for (const b of [].concat(body)) put(b); put("\nendobj\n"); };
    const stream = async (n, head, data) => {
      const e = await encStream(data);
      obj(n, [`<< ${head} /Length ${e.length} >>\nstream\n`, e, "\nendstream"]);
    };

    put("%PDF-2.0\n%\xe2\xe3\xcf\xd3\n");
    // 1: Catalog, 2: Pages, 3: Encrypt, 4: Info, 5〜: ページごとに Page / Contents / Image の3つ
    const kids = pages.map((_, i) => `${5 + i * 3} 0 R`).join(" ");
    obj(1, "<< /Type /Catalog /Pages 2 0 R /ViewerPreferences << /DisplayDocTitle true >> >>");
    obj(2, `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
    obj(3, dict);
    obj(4, `<< /Title ${await encString(title || "")} /Producer ${await encString("医務官月報 取りまとめ")} >>`);
    for (let i = 0; i < pages.length; i++) {
      const p = pages[i], n = 5 + i * 3;
      obj(n, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Contents ${n + 1} 0 R /Resources << /XObject << /Im${i} ${n + 2} 0 R >> >> >>`);
      await stream(n + 1, "", enc.encode(`q ${W} 0 0 ${H} 0 0 cm /Im${i} Do Q`));
      await stream(n + 2, `/Type /XObject /Subtype /Image /Width ${p.width} /Height ${p.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode`, p.jpeg);
    }
    const size = 5 + pages.length * 3, xref = len, id = hex(rand(16));
    put(`xref\n0 ${size}\n0000000000 65535 f \n`);
    for (let n = 1; n < size; n++) put(`${String(offsets[n]).padStart(10, "0")} 00000 n \n`);
    put(`trailer\n<< /Size ${size} /Root 1 0 R /Info 4 0 R /Encrypt 3 0 R /ID [<${id}> <${id}>] >>\nstartxref\n${xref}\n%%EOF\n`);
    return new Blob(chunks, { type: "application/pdf" });
  }

  window.SecurePdf = { buildEncryptedPdf };
})();
