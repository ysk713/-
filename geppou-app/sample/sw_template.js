// オフライン用サービスワーカー（geppou-app/sample/build_sw.py が sw_template.js から生成。直接編集しない）
//
// 初めて開いたときにアプリ一式（ライブラリ・地図・国旗・デモ）をブラウザに保存し、以後はネットがなくても動く。
// アプリ本体（HTML・JS・CSS）はネットにつながっていれば最新を取りに行き（つながらなければ保存分）、
// ライブラリ・地図・国旗は保存分を使う。月報のデータはこれとは別に IndexedDB に保存されている。
const VERSION = "__VERSION__";
const CACHE = "geppou-" + VERSION;
const FILES = __FILES__;
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

// 作ったPDFレポートを、ファイル名の入ったアドレス（pdfview/医務官月報統合レポート_202609.pdf）で表示する。
// ビューアの「ダウンロード」でも、このファイル名で保存される（PDFはアプリが geppou-pdfview に置いたもの。外部には送らない）
async function pdfView(req) {
  const hit = await (await caches.open("geppou-pdfview")).match(req, { ignoreSearch: true });
  return hit || new Response("このPDFはもう表示できません。PDFレポートのタブで作り直してください。", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;  // UpToDate など外部へのリンクには関与しない
  if (url.pathname.includes("/pdfview/")) { e.respondWith(pdfView(req)); return; }
  const scope = new URL(self.registration.scope);
  if (!url.pathname.startsWith(scope.pathname)) return;
  e.respondWith(req.mode === "navigate" || CORE.test(url.pathname) ? networkFirst(req) : cacheFirst(req));
});
