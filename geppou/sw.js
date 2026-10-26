// オフライン用サービスワーカー（geppou-app/sample/build_sw.py が sw_template.js から生成。直接編集しない）
//
// 初めて開いたときにアプリ一式（ライブラリ・地図・国旗・デモ）をブラウザに保存し、以後はネットがなくても動く。
// アプリ本体（HTML・JS・CSS）はネットにつながっていれば最新を取りに行き（つながらなければ保存分）、
// ライブラリ・地図・国旗は保存分を使う。月報のデータはこれとは別に IndexedDB に保存されている。
const VERSION = "2cf825b9c0b9";
const CACHE = "geppou-" + VERSION;
const FILES = [
 "./",
 "app.js",
 "countries.geo.json",
 "data.js",
 "demo.json",
 "icons/icon-180.png",
 "icons/icon-192.png",
 "icons/icon-512.png",
 "index.html",
 "lib/airports.json",
 "lib/anthems/AD.json",
 "lib/anthems/AL.json",
 "lib/anthems/AT.json",
 "lib/anthems/AU.json",
 "lib/anthems/BE.json",
 "lib/anthems/CA.json",
 "lib/anthems/CH.json",
 "lib/anthems/CN.json",
 "lib/anthems/CREDITS.md",
 "lib/anthems/CZ.json",
 "lib/anthems/DE.json",
 "lib/anthems/DK.json",
 "lib/anthems/ES.json",
 "lib/anthems/FI.json",
 "lib/anthems/FR.json",
 "lib/anthems/GB.json",
 "lib/anthems/GR.json",
 "lib/anthems/HR.json",
 "lib/anthems/HU.json",
 "lib/anthems/ID.json",
 "lib/anthems/IL.json",
 "lib/anthems/IM.json",
 "lib/anthems/IN.json",
 "lib/anthems/IT.json",
 "lib/anthems/JP.json",
 "lib/anthems/MX.json",
 "lib/anthems/NL.json",
 "lib/anthems/PK.json",
 "lib/anthems/PL.json",
 "lib/anthems/README.txt",
 "lib/anthems/RU.json",
 "lib/anthems/SE.json",
 "lib/anthems/SK.json",
 "lib/anthems/SM.json",
 "lib/anthems/UA.json",
 "lib/anthems/US.json",
 "lib/anthems/VA.json",
 "lib/anthems/ZA.json",
 "lib/anthems/audio/JPN.mp3",
 "lib/anthems/audio/README.txt",
 "lib/anthems/index.json",
 "lib/flags/ae.svg",
 "lib/flags/af.svg",
 "lib/flags/am.svg",
 "lib/flags/ao.svg",
 "lib/flags/ar.svg",
 "lib/flags/at.svg",
 "lib/flags/au.svg",
 "lib/flags/az.svg",
 "lib/flags/bd.svg",
 "lib/flags/bf.svg",
 "lib/flags/bh.svg",
 "lib/flags/bi.svg",
 "lib/flags/bj.svg",
 "lib/flags/bn.svg",
 "lib/flags/bo.svg",
 "lib/flags/br.svg",
 "lib/flags/bs.svg",
 "lib/flags/bt.svg",
 "lib/flags/bw.svg",
 "lib/flags/by.svg",
 "lib/flags/bz.svg",
 "lib/flags/ca.svg",
 "lib/flags/cd.svg",
 "lib/flags/cf.svg",
 "lib/flags/cg.svg",
 "lib/flags/ci.svg",
 "lib/flags/cl.svg",
 "lib/flags/cm.svg",
 "lib/flags/cn.svg",
 "lib/flags/co.svg",
 "lib/flags/cr.svg",
 "lib/flags/cu.svg",
 "lib/flags/cv.svg",
 "lib/flags/de.svg",
 "lib/flags/dj.svg",
 "lib/flags/do.svg",
 "lib/flags/dz.svg",
 "lib/flags/ec.svg",
 "lib/flags/eg.svg",
 "lib/flags/er.svg",
 "lib/flags/et.svg",
 "lib/flags/fj.svg",
 "lib/flags/fm.svg",
 "lib/flags/fr.svg",
 "lib/flags/ga.svg",
 "lib/flags/gb.svg",
 "lib/flags/ge.svg",
 "lib/flags/gh.svg",
 "lib/flags/gm.svg",
 "lib/flags/gn.svg",
 "lib/flags/gq.svg",
 "lib/flags/gt.svg",
 "lib/flags/gw.svg",
 "lib/flags/gy.svg",
 "lib/flags/hn.svg",
 "lib/flags/ht.svg",
 "lib/flags/id.svg",
 "lib/flags/il.svg",
 "lib/flags/in.svg",
 "lib/flags/iq.svg",
 "lib/flags/ir.svg",
 "lib/flags/it.svg",
 "lib/flags/jm.svg",
 "lib/flags/jo.svg",
 "lib/flags/jp.svg",
 "lib/flags/ke.svg",
 "lib/flags/kg.svg",
 "lib/flags/kh.svg",
 "lib/flags/ki.svg",
 "lib/flags/km.svg",
 "lib/flags/kr.svg",
 "lib/flags/kw.svg",
 "lib/flags/kz.svg",
 "lib/flags/la.svg",
 "lib/flags/lb.svg",
 "lib/flags/lk.svg",
 "lib/flags/lr.svg",
 "lib/flags/ls.svg",
 "lib/flags/ly.svg",
 "lib/flags/ma.svg",
 "lib/flags/md.svg",
 "lib/flags/mg.svg",
 "lib/flags/mh.svg",
 "lib/flags/ml.svg",
 "lib/flags/mm.svg",
 "lib/flags/mn.svg",
 "lib/flags/mr.svg",
 "lib/flags/mu.svg",
 "lib/flags/mv.svg",
 "lib/flags/mw.svg",
 "lib/flags/mx.svg",
 "lib/flags/my.svg",
 "lib/flags/mz.svg",
 "lib/flags/na.svg",
 "lib/flags/ne.svg",
 "lib/flags/ng.svg",
 "lib/flags/ni.svg",
 "lib/flags/np.svg",
 "lib/flags/nr.svg",
 "lib/flags/nz.svg",
 "lib/flags/om.svg",
 "lib/flags/pa.svg",
 "lib/flags/pe.svg",
 "lib/flags/pg.svg",
 "lib/flags/ph.svg",
 "lib/flags/pk.svg",
 "lib/flags/pl.svg",
 "lib/flags/ps.svg",
 "lib/flags/pw.svg",
 "lib/flags/py.svg",
 "lib/flags/qa.svg",
 "lib/flags/ro.svg",
 "lib/flags/rs.svg",
 "lib/flags/ru.svg",
 "lib/flags/rw.svg",
 "lib/flags/sa.svg",
 "lib/flags/sb.svg",
 "lib/flags/sc.svg",
 "lib/flags/sd.svg",
 "lib/flags/se.svg",
 "lib/flags/sg.svg",
 "lib/flags/sl.svg",
 "lib/flags/sn.svg",
 "lib/flags/so.svg",
 "lib/flags/sr.svg",
 "lib/flags/ss.svg",
 "lib/flags/sv.svg",
 "lib/flags/sy.svg",
 "lib/flags/sz.svg",
 "lib/flags/td.svg",
 "lib/flags/tg.svg",
 "lib/flags/th.svg",
 "lib/flags/tj.svg",
 "lib/flags/tl.svg",
 "lib/flags/tm.svg",
 "lib/flags/tn.svg",
 "lib/flags/to.svg",
 "lib/flags/tr.svg",
 "lib/flags/tt.svg",
 "lib/flags/tv.svg",
 "lib/flags/tz.svg",
 "lib/flags/ua.svg",
 "lib/flags/ug.svg",
 "lib/flags/us.svg",
 "lib/flags/uy.svg",
 "lib/flags/uz.svg",
 "lib/flags/ve.svg",
 "lib/flags/vn.svg",
 "lib/flags/vu.svg",
 "lib/flags/ws.svg",
 "lib/flags/ye.svg",
 "lib/flags/za.svg",
 "lib/flags/zm.svg",
 "lib/flags/zw.svg",
 "lib/html2canvas.min.js",
 "lib/jszip.min.js",
 "lib/pdf.min.js",
 "lib/pdf.worker.min.js",
 "lib/places.json",
 "lib/plotly.min.js",
 "lib/topojson/world_110m.json",
 "lib/xlsx.full.min.js",
 "manifest.webmanifest",
 "music.js",
 "securepdf.js",
 "style.css"
];
const CORE = /(\/|\.html|app\.js|data\.js|style\.css|securepdf\.js|manifest\.webmanifest)$/;

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: "reload" })))));
});
self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith("geppou-") && k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});
self.addEventListener("message", (e) => {
  if (e.data === "skipWaiting") self.skipWaiting();
  if (e.data === "version" && e.source) e.source.postMessage({ version: VERSION });
});

async function networkFirst(req) {
  const c = await caches.open(CACHE);
  const cached = async () => (await c.match(req, { ignoreSearch: true })) || (req.mode === "navigate" && (await c.match("./")));
  if (!navigator.onLine) { const hit = await cached(); if (hit) return hit; }
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 4000);  // 回線が極端に遅いときは保存分を使う
    const res = await fetch(req, { signal: ctl.signal, cache: "no-cache" });
    clearTimeout(timer);
    if (res.ok) c.put(req, res.clone());
    return res;
  } catch {
    const hit = await cached();
    if (hit) return hit;
    throw new Error("offline");
  }
}
async function cacheFirst(req) {
  const c = await caches.open(CACHE);
  const hit = await c.match(req, { ignoreSearch: true });
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) c.put(req, res.clone());
  return res;
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;  // UpToDate など外部へのリンクには関与しない
  const scope = new URL(self.registration.scope);
  if (!url.pathname.startsWith(scope.pathname)) return;
  e.respondWith(req.mode === "navigate" || CORE.test(url.pathname) ? networkFirst(req) : cacheFirst(req));
});
