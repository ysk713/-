/* ハイライト・ツアーで流す「その国らしい音楽」
 *
 * 録音した音源は使わず（著作権・容量・オフラインのため）、Web Audio でその場で演奏する。
 * - 地域ごとの音階（都節・五音音階・ペロッグ・ラーガ・マカーム・アンデスの五音音階 など）
 * - 楽器らしい音色（撥弦＝箏・古箏・シタール・ウード・コラ・バンジョー／打鍵＝ラナート・ガムラン・マリンバ・スチールパン／
 *   笛＝ケーナ／弓奏＝馬頭琴・フィドル／蛇腹＝アコーディオン・バンドネオン／太鼓＝ジャンベ・タブラ・ダルブッカ など）
 * - 地域のリズム型（マクスーム・ティーンタール・クラーベ・タンゴ・サンバ など）
 * で国ごとに短い曲を組み立てる（同じ国ならいつも同じ旋律）。
 * いくつかの国は、よく知られたパブリックドメインの民謡・古典の旋律を使う。
 */
(() => {
  // ----------------------------------------------------------------- 音色
  const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
  const ksCache = new Map();
  // カープラス・ストロング法の撥弦音（bright: 明るさ 0〜1、rho: 1周期あたりの減衰）
  function ks(ctx, f, dur, bright, rho) {
    const key = `${ctx.sampleRate}|${f.toFixed(1)}|${dur}|${bright}|${rho}`;
    if (ksCache.has(key)) return ksCache.get(key);
    const sr = ctx.sampleRate, n = Math.floor(sr * dur), N = Math.max(2, Math.round(sr / f));
    const buf = ctx.createBuffer(1, n, sr), y = buf.getChannelData(0);
    let lp = 0;
    for (let i = 0; i < Math.min(N, n); i++) { lp += bright * ((Math.random() * 2 - 1) - lp); y[i] = lp; }
    for (let i = N; i < n; i++) y[i] = rho * 0.5 * (y[i - N] + (i - N - 1 >= 0 ? y[i - N - 1] : 0));
    let pk = 0;
    for (let i = 0; i < Math.min(N * 4, n); i++) pk = Math.max(pk, Math.abs(y[i]));
    if (pk > 0) for (let i = 0; i < n; i++) y[i] /= pk;
    if (ksCache.size > 400) ksCache.clear();
    ksCache.set(key, buf);
    return buf;
  }
  const env = (ctx, g, t, a, peak, d, sustain = 0.0001) => {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + a);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0001, sustain), t + a + d);
  };
  function pluck(o) {
    return (ctx, out, t, f, d, v) => {
      const s = ctx.createBufferSource();
      s.buffer = ks(ctx, f, o.len || 1.6, o.bright, o.rho);
      const g = ctx.createGain();
      g.gain.value = v * (o.gain || 0.5);
      let node = s;
      if (o.tone) { const bq = ctx.createBiquadFilter(); bq.type = "peaking"; bq.frequency.value = o.tone; bq.Q.value = 2; bq.gain.value = 8; node.connect(bq); node = bq; }
      node.connect(g).connect(out);
      if (o.bend) { s.playbackRate.setValueAtTime(Math.pow(2, o.bend / 12), t); s.playbackRate.exponentialRampToValueAtTime(1, t + 0.12); }
      s.start(t); s.stop(t + (o.len || 1.6));
      // トレモロ奏法（マンドリン・バラライカ・チャランゴ）
      if (o.trem && d > 0.3) for (let k = t + o.trem; k < t + d - 0.03; k += o.trem) {
        const s2 = ctx.createBufferSource(); s2.buffer = s.buffer; const g2 = ctx.createGain(); g2.gain.value = v * (o.gain || 0.5) * 0.7;
        s2.connect(g2).connect(out); s2.start(k); s2.stop(k + 0.5);
      }
    };
  }
  // 打鍵楽器：部分音の比と減衰で木琴・金属打楽器・スチールパン・カリンバを作る
  function mallet(o) {
    return (ctx, out, t, f, d, v) => {
      o.partials.forEach(([ratio, amp, dec]) => {
        const fr = f * ratio;
        if (fr > 12000) return;
        for (const det of o.shimmer ? [-o.shimmer, o.shimmer] : [0]) {
          const os = ctx.createOscillator(), g = ctx.createGain();
          os.type = "sine"; os.frequency.value = fr + det;
          env(ctx, g, t, 0.004, v * amp * (o.gain || 0.35) / (o.shimmer ? 1.6 : 1), dec);
          os.connect(g).connect(out); os.start(t); os.stop(t + dec + 0.05);
        }
      });
    };
  }
  // 持続音（笛・弓奏・蛇腹・ドゥドゥク）
  function sustained(o) {
    return (ctx, out, t, f, d, v) => {
      const g = ctx.createGain(), lp = ctx.createBiquadFilter();
      lp.type = "lowpass"; lp.frequency.value = o.cutoff || 2000; lp.Q.value = 0.7;
      const peak = v * (o.gain || 0.18), a = Math.min(o.attack || 0.06, d * 0.4), rel = o.release || 0.12;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(peak, t + a);
      g.gain.setValueAtTime(peak * 0.85, t + Math.max(a, d - rel));
      g.gain.exponentialRampToValueAtTime(0.0001, t + d + rel);
      lp.connect(g).connect(out);
      const vib = ctx.createOscillator(), vg = ctx.createGain();
      vib.frequency.value = o.vibRate || 5.5; vg.gain.value = f * (o.vib || 0.006);
      vib.connect(vg);
      vg.gain.setValueAtTime(0, t); vg.gain.linearRampToValueAtTime(f * (o.vib || 0.006), t + Math.min(0.35, d));
      (o.waves || [["sawtooth", 1, 0]]).forEach(([type, amp, cents]) => {
        const os = ctx.createOscillator(), og = ctx.createGain();
        os.type = type; os.frequency.value = f; os.detune.value = cents || 0; og.gain.value = amp;
        vg.connect(os.frequency); os.connect(og).connect(lp); os.start(t); os.stop(t + d + rel + 0.05);
      });
      if (o.breath) {  // 笛の息の音
        const nb = noiseBuf(ctx), ns = ctx.createBufferSource(), bp = ctx.createBiquadFilter(), ng = ctx.createGain();
        ns.buffer = nb; bp.type = "bandpass"; bp.frequency.value = f * 2; bp.Q.value = 3; ng.gain.value = o.breath;
        ns.connect(bp).connect(ng).connect(g); ns.start(t); ns.stop(t + d + rel);
      }
      vib.start(t); vib.stop(t + d + rel + 0.05);
    };
  }
  let NOISE = null;
  const noiseBuf = (ctx) => {
    if (NOISE && NOISE.sampleRate === ctx.sampleRate) return NOISE;
    NOISE = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = NOISE.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return NOISE;
  };
  // 太鼓・小物
  const DRUMS = {
    D: { f: 95, f2: 55, dec: 0.32, tone: 0.9, noise: 0.15, nf: 900 },      // 低い「ドゥム」（ジャンベ・ダルブッカ・タブラのバヤ）
    T: { f: 420, f2: 330, dec: 0.09, tone: 0.35, noise: 0.5, nf: 3500 },  // 高い「テク」
    K: { f: 600, f2: 500, dec: 0.05, tone: 0.15, noise: 0.35, nf: 5000 }, // 軽い「カ」
    N: { f: 520, f2: 505, dec: 0.35, tone: 0.55, noise: 0.1, nf: 4000 },  // タブラの「ナ」（響く高音）
    B: { f: 70, f2: 45, dec: 0.45, tone: 1.0, noise: 0.05, nf: 400 },     // 大太鼓（スルド・ボンボ）
    S: { noise: 0.28, nf: 7000, dec: 0.06, q: 1.2 },                       // シェイカー
    H: { noise: 0.22, nf: 9000, dec: 0.04, q: 0.8, hp: true },             // ハイハット・チン
    C: { f: 2500, f2: 2500, dec: 0.03, tone: 0.5, noise: 0.25, nf: 2500 }, // クラーベ・拍子木
    W: { f: 900, f2: 880, dec: 0.06, tone: 0.5, noise: 0.05, nf: 1500 },  // 木魚・ウッドブロック
    G: { f: 110, f2: 104, dec: 2.2, tone: 0.6, noise: 0, metal: [1, 1.48, 2.06] }, // ゴング
  };
  function drum(ctx, out, t, k, v) {
    const p = DRUMS[k];
    if (!p) return;
    if (p.tone) {
      for (const r of p.metal || [1]) {
        const os = ctx.createOscillator(), g = ctx.createGain();
        os.frequency.setValueAtTime(p.f * r, t); os.frequency.exponentialRampToValueAtTime(p.f2 * r, t + Math.min(0.12, p.dec));
        env(ctx, g, t, 0.002, v * p.tone * 0.6 / (p.metal ? 2 : 1), p.dec);
        os.connect(g).connect(out); os.start(t); os.stop(t + p.dec + 0.05);
      }
    }
    if (p.noise) {
      const ns = ctx.createBufferSource(), bp = ctx.createBiquadFilter(), g = ctx.createGain();
      ns.buffer = noiseBuf(ctx); bp.type = p.hp ? "highpass" : "bandpass"; bp.frequency.value = p.nf; bp.Q.value = p.q || 1;
      env(ctx, g, t, 0.001, v * p.noise, p.dec);
      ns.connect(bp).connect(g).connect(out); ns.start(t, Math.random()); ns.stop(t + p.dec + 0.05);
    }
  }

  const INST = {
    koto: pluck({ bright: 0.75, rho: 0.996, gain: 0.55, len: 2.2, bend: 0.6, tone: 1800 }),
    guzheng: pluck({ bright: 0.7, rho: 0.997, gain: 0.5, len: 2.4, bend: 0.4, tone: 2200 }),
    gayageum: pluck({ bright: 0.55, rho: 0.995, gain: 0.55, len: 2.0, bend: 1.0 }),
    sitar: pluck({ bright: 0.9, rho: 0.998, gain: 0.45, len: 2.6, bend: 0.8, tone: 3000 }),
    oud: pluck({ bright: 0.45, rho: 0.994, gain: 0.75, len: 1.6, tone: 900 }),
    kora: pluck({ bright: 0.6, rho: 0.997, gain: 0.5, len: 1.8, tone: 2500 }),
    krar: pluck({ bright: 0.7, rho: 0.995, gain: 0.7, len: 1.6, tone: 2000 }),
    banjo: pluck({ bright: 0.95, rho: 0.990, gain: 0.7, len: 0.9, tone: 3000 }),
    guitar: pluck({ bright: 0.5, rho: 0.996, gain: 0.6, len: 1.8 }),
    tres: pluck({ bright: 0.8, rho: 0.994, gain: 0.65, len: 1.2, tone: 2400 }),
    lute: pluck({ bright: 0.45, rho: 0.996, gain: 0.7, len: 1.8, tone: 1200 }),
    harp: pluck({ bright: 0.65, rho: 0.998, gain: 0.45, len: 2.2 }),
    mandolin: pluck({ bright: 0.85, rho: 0.993, gain: 0.5, len: 0.8, trem: 0.075, tone: 2600 }),
    balalaika: pluck({ bright: 0.85, rho: 0.993, gain: 0.5, len: 0.8, trem: 0.085, tone: 2400 }),
    charango: pluck({ bright: 0.9, rho: 0.993, gain: 0.35, len: 0.9, tone: 3000 }),
    ukulele: pluck({ bright: 0.6, rho: 0.994, gain: 0.6, len: 1.2, tone: 1600 }),
    dombra: pluck({ bright: 0.6, rho: 0.994, gain: 0.45, len: 1.2, tone: 1400 }),
    bass: pluck({ bright: 0.3, rho: 0.997, gain: 0.36, len: 1.4 }),
    ranat: mallet({ partials: [[1, 1, 0.45], [3.95, 0.35, 0.12], [10.1, 0.12, 0.04]], gain: 0.5 }),
    marimba: mallet({ partials: [[1, 1, 0.6], [3.93, 0.3, 0.15], [9.2, 0.08, 0.05]], gain: 0.55 }),
    gamelan: mallet({ partials: [[1, 1, 1.8], [2.76, 0.4, 0.9], [5.4, 0.2, 0.5], [8.93, 0.08, 0.3]], shimmer: 2.5, gain: 0.32 }),
    steelpan: mallet({ partials: [[1, 1, 0.9], [2, 0.55, 0.6], [3, 0.25, 0.35], [4.02, 0.1, 0.2]], gain: 0.42 }),
    kalimba: mallet({ partials: [[1, 1, 0.9], [5.95, 0.25, 0.08], [2.01, 0.08, 0.3]], gain: 0.42 }),
    quena: sustained({ waves: [["sine", 1], ["triangle", 0.35]], cutoff: 3200, vib: 0.008, breath: 0.06, attack: 0.07, gain: 0.26 }),
    shakuhachi: sustained({ waves: [["sine", 1], ["triangle", 0.2]], cutoff: 2600, vib: 0.01, breath: 0.12, attack: 0.12, gain: 0.26 }),
    bowed: sustained({ waves: [["sawtooth", 1], ["sawtooth", 0.5, 7]], cutoff: 2200, vib: 0.009, attack: 0.12, gain: 0.2 }),
    erhu: sustained({ waves: [["sawtooth", 1]], cutoff: 2600, vib: 0.014, vibRate: 6, attack: 0.08, gain: 0.18 }),
    fiddle: sustained({ waves: [["sawtooth", 1], ["sawtooth", 0.4, -6]], cutoff: 3000, vib: 0.006, attack: 0.04, release: 0.06, gain: 0.22 }),
    morinkhuur: sustained({ waves: [["sawtooth", 1], ["square", 0.3, 5]], cutoff: 1500, vib: 0.012, attack: 0.15, gain: 0.24 }),
    duduk: sustained({ waves: [["square", 0.6], ["sawtooth", 0.5]], cutoff: 1100, vib: 0.01, attack: 0.15, gain: 0.16 }),
    accordion: sustained({ waves: [["sawtooth", 0.6, -8], ["sawtooth", 0.6, 8], ["square", 0.3]], cutoff: 2600, vib: 0.0, attack: 0.03, release: 0.06, gain: 0.2 }),
    bandoneon: sustained({ waves: [["sawtooth", 0.6, -5], ["sawtooth", 0.6, 5], ["square", 0.4, 1200]], cutoff: 1900, vib: 0.0, attack: 0.02, release: 0.05, gain: 0.2 }),
    trumpet: sustained({ waves: [["sawtooth", 1], ["square", 0.3]], cutoff: 2800, vib: 0.007, attack: 0.03, release: 0.05, gain: 0.19 }),
    pad: sustained({ waves: [["sawtooth", 0.5, -10], ["sawtooth", 0.5, 10]], cutoff: 900, vib: 0, attack: 0.4, release: 0.6, gain: 0.07 }),
    didgeridoo: sustained({ waves: [["sawtooth", 1]], cutoff: 500, vib: 0.004, vibRate: 1.2, attack: 0.2, release: 0.3, gain: 0.15 }),
  };

  // ----------------------------------------------------------------- 曲の組み立て
  const SCALES = {
    miyako: [0, 1, 5, 7, 8], major_penta: [0, 2, 4, 7, 9], minor_penta: [0, 3, 5, 7, 10], korean: [0, 2, 5, 7, 9],
    pelog: [0, 1, 3, 7, 8], bhairav: [0, 1, 4, 5, 7, 8, 11], hijaz: [0, 1, 4, 5, 7, 8, 10], ambassel: [0, 1, 5, 7, 8],
    major: [0, 2, 4, 5, 7, 9, 11], minor: [0, 2, 3, 5, 7, 8, 10], harmonic: [0, 2, 3, 5, 7, 8, 11], dorian: [0, 2, 3, 5, 7, 9, 10],
    ukrainian: [0, 2, 3, 6, 7, 9, 10], hexa: [0, 2, 4, 5, 7, 9],
  };
  // 拍の割り（1小節分、単位は拍）
  const RHY = {
    even: [[1, 1, 1, 1], [0.5, 0.5, 1, 1, 1], [1, 0.5, 0.5, 1, 1], [1.5, 0.5, 1, 1]],
    flowing: [[2, 1, 1], [1, 1, 2], [1.5, 0.5, 2], [3, 1]],
    busy: [[0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 1], [0.5, 0.5, 1, 0.5, 0.5, 1], [0.25, 0.25, 0.5, 0.5, 0.5, 1, 1]],
    dotted: [[0.75, 0.25, 0.75, 0.25, 1, 1], [1, 0.75, 0.25, 2], [0.75, 0.25, 1, 2]],
    waltz: [[1, 1, 1], [2, 1], [1.5, 0.5, 1]],
    six8: [[1, 0.5, 1, 0.5], [1.5, 1.5], [0.5, 0.5, 0.5, 1.5]],
    syncop: [[0.75, 0.75, 0.5, 1, 1], [0.5, 1, 0.5, 1, 1], [1, 0.75, 0.75, 0.5, 1]],
    slow: [[2, 2], [3, 1], [4]],
  };
  // 太鼓の型（16分音符ごと。"." は休み）
  const DRUM_PAT = {
    maqsum: "D...T...T.D.T...", teental: "D.N.N.D.D.N.N.D.", djembe: "D..TT.D.D..TT.TK", shaker: "S.S.S.S.S.S.S.S.",
    clave: "C..C..C...C.C...", tango: "B..B..B.B.......", samba: "B..K.TK.B..KT.K.", bombo: "B.....K.B..K....",
    gallop: "D..K..D..K..D..K", ching: "H...H...H...H...", kendang: "D...K.T.D.K...T.", janggu: "D..T..K.T...", // 3/4（12刻み）
    eskista: "D..T..D..TK.", polska: "D...K...K...", cumbia: "S.SKS.SKS.SKS.SK", calypso: "B..KT.K.B..KT.K.", sticks: "C...C...C...C...",
    log: "D...K.D.T...K.T.", waltz3: "D...K...K...", tarantella: "D..K..D..K..", march: "D...K...D...K...",
  };
  // 地域の様式
  const STYLES = {
    japan: { scale: "miyako", root: 64, lead: "koto", acc: "sparse", rhy: "flowing", bpm: 72, drums: null },
    china: { scale: "major_penta", root: 62, lead: "guzheng", acc: "arp", rhy: "flowing", bpm: 84, drums: null },
    korea: { scale: "korean", root: 62, lead: "gayageum", acc: "sparse", rhy: "waltz", meter: 3, bpm: 84, drums: "janggu" },
    steppe: { scale: "major_penta", root: 57, lead: "morinkhuur", acc: "strum", accInst: "dombra", rhy: "dotted", bpm: 112, drums: "gallop" },
    seasia: { scale: "major_penta", root: 67, lead: "ranat", acc: "gong", rhy: "busy", bpm: 112, drums: "ching" },
    gamelan: { scale: "pelog", root: 64, lead: "gamelan", acc: "gong", rhy: "even", bpm: 96, drums: "kendang" },
    india: { scale: "bhairav", root: 61, lead: "sitar", acc: "drone", rhy: "flowing", bpm: 80, drums: "teental" },
    arab: { scale: "hijaz", root: 62, lead: "oud", acc: "bass", rhy: "syncop", bpm: 100, drums: "maqsum" },
    ethiopia: { scale: "ambassel", root: 62, lead: "krar", acc: "bass", rhy: "six8", meter: 3, bpm: 92, drums: "eskista" },
    westafrica: { scale: "major_penta", root: 62, lead: "kora", acc: "arp", rhy: "busy", bpm: 104, drums: "djembe" },
    eastafrica: { scale: "hexa", root: 64, lead: "kalimba", acc: "interlock", rhy: "busy", bpm: 108, drums: "shaker" },
    caucasus: { scale: "minor", root: 57, lead: "duduk", acc: "drone", rhy: "slow", bpm: 70, drums: null },
    neapolitan: { scale: "major", root: 64, lead: "mandolin", acc: "strum", accInst: "guitar", rhy: "six8", meter: 3, bpm: 132, drums: "tarantella" },
    nordic: { scale: "dorian", root: 62, lead: "fiddle", acc: "bass", rhy: "waltz", meter: 3, bpm: 104, drums: "polska" },
    eastern_eu: { scale: "harmonic", root: 62, lead: "accordion", acc: "bass", rhy: "dotted", bpm: 112, drums: "march" },
    ukraine: { scale: "ukrainian", root: 62, lead: "harp", acc: "arp", rhy: "flowing", bpm: 88, drums: null },
    fiddle: { scale: "major", root: 62, lead: "fiddle", acc: "strum", accInst: "guitar", rhy: "busy", bpm: 120, drums: "march" },
    centralam: { scale: "major", root: 67, lead: "marimba", acc: "bass", rhy: "waltz", meter: 3, bpm: 120, drums: "waltz3" },
    cuba: { scale: "major", root: 62, lead: "tres", acc: "bass", rhy: "syncop", bpm: 108, drums: "clave" },
    caribbean: { scale: "major", root: 67, lead: "steelpan", acc: "bass", rhy: "syncop", bpm: 112, drums: "calypso" },
    cumbia: { scale: "minor", root: 62, lead: "accordion", acc: "bass", rhy: "syncop", bpm: 96, drums: "cumbia" },
    andes: { scale: "minor_penta", root: 69, lead: "quena", acc: "strum", accInst: "charango", rhy: "dotted", bpm: 96, drums: "bombo" },
    tango: { scale: "harmonic", root: 62, lead: "bandoneon", acc: "bass", rhy: "dotted", bpm: 112, drums: "tango" },
    paraguay: { scale: "major", root: 62, lead: "harp", acc: "arp", rhy: "six8", meter: 3, bpm: 120, drums: null },
    brazil: { scale: "major", root: 64, lead: "guitar", acc: "strum", accInst: "guitar", chord7: true, rhy: "syncop", bpm: 100, drums: "samba" },
    australia: { scale: "major_penta", root: 62, lead: "marimba", acc: "didge", rhy: "even", bpm: 96, drums: "sticks" },
    pacific: { scale: "major_penta", root: 64, lead: "ukulele", acc: "strum", accInst: "ukulele", rhy: "syncop", bpm: 104, drums: "log" },
  };
  const ISO_STYLE = {
    JPN: "japan", CHN: "china", KOR: "korea", MNG: "steppe", KAZ: "steppe", KGZ: "steppe", UZB: "steppe", TJK: "steppe", TKM: "steppe",
    THA: "seasia", KHM: "seasia", LAO: "seasia", MMR: "seasia", VNM: "seasia",
    IDN: "gamelan", MYS: "gamelan", BRN: "gamelan", PHL: "gamelan", TLS: "gamelan", SGP: "gamelan",
    IND: "india", NPL: "india", BGD: "india", LKA: "india", PAK: "india", AFG: "india", BTN: "india", MDV: "india",
    ETH: "ethiopia", ERI: "ethiopia",
    GEO: "caucasus", ARM: "caucasus", AZE: "arab",
    ITA: "neapolitan", SWE: "nordic", POL: "eastern_eu", SRB: "eastern_eu", ROU: "eastern_eu", MDA: "eastern_eu", BLR: "eastern_eu", AUT: "eastern_eu",
    UKR: "ukraine", CAN: "fiddle",
    GTM: "centralam", HND: "centralam", SLV: "centralam", NIC: "centralam", CRI: "centralam", PAN: "centralam", BLZ: "centralam",
    CUB: "cuba", DOM: "cuba", JAM: "caribbean", TTO: "caribbean", BHS: "caribbean", HTI: "caribbean", GUY: "caribbean", SUR: "caribbean",
    COL: "cumbia", VEN: "cumbia", PER: "andes", BOL: "andes", ECU: "andes", CHL: "andes", ARG: "tango", URY: "tango", PRY: "paraguay", BRA: "brazil",
    AUS: "australia", NZL: "pacific",
  };
  const ARAB = ["EGY", "DZA", "MAR", "TUN", "LBY", "SDN", "MRT", "DJI", "SOM", "COM"];
  const WEST_AF = ["GHA", "NGA", "CIV", "SEN", "MLI", "BFA", "GIN", "BEN", "TGO", "SLE", "LBR", "GMB", "GNB", "NER", "TCD", "CMR", "GAB", "CAF", "COG", "GNQ", "CPV"];
  function styleOf(iso, region) {
    if (ISO_STYLE[iso]) return ISO_STYLE[iso];
    if (ARAB.includes(iso) || region === "中東") return "arab";
    if (WEST_AF.includes(iso)) return "westafrica";
    if (region === "アフリカ") return "eastafrica";
    if (region === "アジア・大洋州") return "pacific";
    if (region === "米州") return "cuba";
    if (region === "ヨーロッパ") return "eastern_eu";
    return "pacific";
  }
  // よく知られたパブリックドメインの旋律（音名:拍）
  const SONGS = {
    // さくらさくら（日本古謡）
    JPN: { style: "japan", key: 57, bpm: 66, notes: "A4:1 A4:1 B4:2 A4:1 A4:1 B4:2 A4:1 B4:1 C5:1 B4:1 A4:1 B4:0.5 A4:0.5 F4:2" },
    // 茉莉花（中国民謡）
    CHN: { style: "china", key: 60, chords: [0, 7, 0, 7], bpm: 76, notes: "E5:1 E5:0.5 G5:0.5 A5:0.5 C6:0.5 C6:0.5 A5:0.5 G5:1 G5:0.5 A5:0.5 G5:2 E5:1 E5:0.5 G5:0.5 A5:0.5 C6:0.5 C6:0.5 A5:0.5 G5:1 G5:0.5 A5:0.5 G5:2" },
    // フレール・ジャック（フランス民謡）
    FRA: { style: "eastern_eu", lead: "accordion", scale: "major", key: 65, chords: [0, 0, 0, 0], bpm: 112, notes: "F4:1 G4:1 A4:1 F4:1 F4:1 G4:1 A4:1 F4:1 A4:1 Bb4:1 C5:2 A4:1 Bb4:1 C5:2" },
    // 歓喜の歌（ベートーヴェン）
    DEU: { style: "eastern_eu", lead: "bowed", scale: "major", key: 60, chords: [0, 7, 0, 7], drums: null, bpm: 100, notes: "E5:1 E5:1 F5:1 G5:1 G5:1 F5:1 E5:1 D5:1 C5:1 C5:1 D5:1 E5:1 E5:1.5 D5:0.5 D5:2" },
    // グリーンスリーブス（イングランド民謡）
    GBR: { style: "neapolitan", lead: "lute", scale: "minor", acc: "bass", accInst: "bass", key: 69, chords: [0, 3, -2, 7, 0, 7, 7, 0], drums: null, meter: 3, bpm: 108,
      notes: "C5:2 D5:1 E5:1.5 F5:0.5 E5:1 D5:2 B4:1 G4:1.5 A4:0.5 B4:1 C5:2 A4:1 A4:1.5 G#4:0.5 A4:1 B4:2 G#4:1 E4:2 A4:1" },
    // コロブチカ（ロシア民謡）
    RUS: { style: "eastern_eu", lead: "balalaika", scale: "minor", key: 69, chords: [7, 0, 7, 0], bpm: 132, notes: "E5:1 B4:0.5 C5:0.5 D5:1 C5:0.5 B4:0.5 A4:1 A4:0.5 C5:0.5 E5:1 D5:0.5 C5:0.5 B4:1.5 C5:0.5 D5:1 E5:1 C5:1 A4:1 A4:2" },
    // おお スザンナ（フォスター）
    USA: { style: "fiddle", lead: "banjo", key: 72, chords: [0, 0, 0, 7], bpm: 120, notes: "C5:0.5 D5:0.5 E5:1 G5:1 G5:0.75 A5:0.25 G5:1 E5:1 C5:1.5 D5:0.5 E5:1 E5:1 D5:1 C5:1 D5:3 r:1" },
    // ラ・クカラチャ（メキシコ民謡）
    MEX: { style: "cuba", lead: "trumpet", key: 65, chords: [0, 0, 7, 7], drums: "march", bpm: 150,
      notes: "C5:0.5 C5:0.5 C5:0.5 F5:1.5 A5:1 C5:0.5 C5:0.5 C5:0.5 F5:1.5 A5:1 F5:1 F5:0.5 E5:0.5 E5:0.5 D5:0.5 D5:0.5 C5:0.5 C5:3 r:1" },
  };
  const NOTE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  const parseNote = (s) => { const m = s.match(/^([A-G])([#b]?)(\d)$/); return m ? 12 * (+m[3] + 1) + NOTE[m[1]] + (m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0) : null; };

  function rng(seed) {
    let a = 0;
    for (const ch of String(seed)) a = (a * 31 + ch.charCodeAt(0)) | 0;
    return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  const pick = (r, arr) => arr[Math.floor(r() * arr.length)];
  // 音階の上を歩いて旋律を作る（AABA'、最後は主音に戻る）
  function compose(st, r) {
    const sc = SCALES[st.scale], meter = st.meter || 4;
    const deg = (i) => st.root + 12 * Math.floor(i / sc.length) + sc[((i % sc.length) + sc.length) % sc.length];
    const bar = (start, endOnTonic) => {
      const rh = pick(r, RHY[st.rhy]).slice();
      const tot = rh.reduce((a, b) => a + b, 0);
      if (tot !== meter) rh[rh.length - 1] += meter - tot;
      let i = start;
      const out = rh.map((d, k) => {
        if (k > 0) i += pick(r, [-2, -1, -1, 0, 1, 1, 1, 2]);
        i = Math.max(-2, Math.min(sc.length + 4, i));
        return { m: deg(i), d };
      });
      if (endOnTonic) { out[out.length - 1].m = deg(0); }
      return { notes: out, last: i };
    };
    const a = bar(r() < 0.5 ? 0 : 2, false), b = bar(a.last, false), c = bar(sc.length - 1, false), e = bar(a.last, true);
    return [a.notes, b.notes, a.notes, c.notes, a.notes, b.notes, a.notes, e.notes].flat();
  }

  // ----------------------------------------------------------------- 演奏
  let REVERB = null;
  function reverb(ctx) {
    if (REVERB && REVERB.context === ctx) return REVERB;
    const sr = ctx.sampleRate, len = Math.floor(sr * 2.2), ir = ctx.createBuffer(2, len, sr);
    for (let ch = 0; ch < 2; ch++) { const d = ir.getChannelData(ch); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3); }
    const c = ctx.createConvolver(); c.buffer = ir;
    const wet = ctx.createGain(); wet.gain.value = 0.32;
    c.connect(wet).connect(ctx.destination);
    REVERB = c;
    return c;
  }

  /**
   * 国の音楽を鳴らす。iso: ISO3、region: 地域名、seconds: 長さ（最後はフェードアウト）
   * 戻り値 { stop() }
   */
  function play(ctx, iso, region, seconds = 8, volume = 0.55, parts = { lead: true, acc: true, drums: true }) {
    const song = SONGS[iso];
    const st = Object.assign({}, STYLES[song ? song.style : styleOf(iso, region)], song || {});
    const r = rng(iso || region || "x");
    const meter = st.meter || 4, bpm = st.bpm, beat = 60 / bpm;
    const master = ctx.createGain(), comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16; comp.ratio.value = 4;
    master.connect(comp).connect(ctx.destination);
    comp.connect(reverb(ctx));
    const t0 = ctx.currentTime + 0.08, tEnd = t0 + seconds;
    master.gain.setValueAtTime(0.0001, t0);
    master.gain.exponentialRampToValueAtTime(volume, t0 + 0.25);
    master.gain.setValueAtTime(volume, Math.max(t0 + 0.3, tEnd - 1.6));
    master.gain.exponentialRampToValueAtTime(0.0001, tEnd);

    // 旋律
    let mel;
    if (song) mel = song.notes.split(/\s+/).map((x) => { const [n, d] = x.split(":"); return { m: n === "r" ? null : parseNote(n), d: +d }; });
    else mel = compose(st, r);
    const lead = INST[st.lead];
    const loopBeats = mel.reduce((a, n) => a + n.d, 0);
    const bars = Math.ceil(loopBeats / meter);
    const sc = SCALES[st.scale] || SCALES.major;
    const tonic = st.key || st.root;
    // 小節ごとの和音の根音（曲に指定があればそれ、なければ I–IV–V–I。音階に4度がなければ5度）
    const prog = st.chords || [0, sc.includes(5) ? 5 : 7, 7, 0];
    const chordOf = (barIdx) => prog[barIdx % prog.length];
    const accInst = INST[st.accInst || "bass"];
    for (let L = 0; t0 + L * loopBeats * beat < tEnd; L++) {
      const base = t0 + L * loopBeats * beat;
      let t = base;
      for (const n of mel) {
        if (t >= tEnd - 0.2) break;
        if (n.m != null && parts.lead) lead(ctx, master, t, mtof(n.m), n.d * beat, 0.9 + 0.1 * r());
        t += n.d * beat;
      }
      // 伴奏
      for (let b = 0; b < bars && parts.acc; b++) {
        const tb = base + b * meter * beat;
        if (tb >= tEnd - 0.3) break;
        const root = tonic - 24 + chordOf(b), fifth = root + 7;
        switch (st.acc) {
          case "drone":
            if (b === 0 && L === 0) INST.pad(ctx, master, tb, mtof(tonic - 24), seconds - 0.5, 0.8), INST.pad(ctx, master, tb, mtof(tonic - 17), seconds - 0.5, 0.6);
            if (st.lead === "sitar") for (let k = 0; k < meter; k++) INST.sitar(ctx, master, tb + k * beat, mtof([tonic - 17, tonic - 12, tonic - 12, tonic - 24][k % 4]), beat, 0.25);
            break;
          case "bass":
            accInst(ctx, master, tb, mtof(root), beat, 0.9);
            accInst(ctx, master, tb + 2 * beat, mtof(fifth), beat, 0.7);
            break;
          case "arp": {
            const inst = INST[st.lead];
            for (let k = 0; k < meter * 2; k++) inst(ctx, master, tb + k * beat / 2, mtof(tonic - 12 + chordOf(b) + [0, 7, 12, 7][k % 4]), beat / 2, 0.24);
            break;
          }
          case "interlock": {
            const inst = INST[st.lead];
            for (let k = 0; k < meter * 2; k++) inst(ctx, master, tb + k * beat / 2 + beat / 4, mtof(tonic - 12 + sc[(k * 2) % sc.length]), beat / 2, 0.28);
            break;
          }
          case "strum": {
            const ch = st.chord7 ? [0, 4, 7, 11] : [0, 7, 12, 16];
            const hits = meter === 3 ? [0, 1, 2] : [0, 1.5, 2, 3];
            for (const h of hits) ch.forEach((iv, j) => accInst(ctx, master, tb + h * beat + j * 0.018, mtof(tonic - 12 + chordOf(b) + iv), beat, 0.12));
            if (accInst !== INST.bass) INST.bass(ctx, master, tb, mtof(root), beat, 0.7);
            break;
          }
          case "gong":
            if (b % 2 === 0) drum(ctx, master, tb, "G", 0.8);
            if (st.lead !== "gamelan") INST.bass(ctx, master, tb, mtof(root), beat, 0.6);
            break;
          case "sparse":
            INST[st.lead](ctx, master, tb, mtof(tonic - 12), beat * 2, 0.35);
            if (b % 2 === 1) INST[st.lead](ctx, master, tb + 2 * beat, mtof(tonic - 5), beat * 2, 0.25);
            break;
          case "didge":
            if (b === 0 && L === 0) INST.didgeridoo(ctx, master, tb, mtof(tonic - 26), seconds - 0.5, 1);
            break;
        }
      }
      // 太鼓
      const pat = DRUM_PAT[st.drums];
      if (pat && parts.drums) {
        const step = (meter * beat) / pat.length;
        for (let b = 0; b < bars; b++) for (let k = 0; k < pat.length; k++) {
          const t = base + b * meter * beat + k * step;
          if (t >= tEnd - 0.2) break;
          if (pat[k] !== ".") drum(ctx, master, t, pat[k], (k === 0 ? 0.9 : 0.6) * (0.85 + 0.3 * r()));
        }
      }
    }
    return {
      stop() {
        try {
          const now = ctx.currentTime;
          master.gain.cancelScheduledValues(now);
          master.gain.setValueAtTime(Math.max(0.0001, master.gain.value), now);
          master.gain.exponentialRampToValueAtTime(0.0001, now + 0.35);
          setTimeout(() => { try { master.disconnect(); comp.disconnect(); } catch {} }, 600);
        } catch {}
      },
    };
  }
  window.WorldMusic = { play, styleOf: (iso, region) => (SONGS[iso] ? SONGS[iso].style : styleOf(iso, region)) };
})();
