// オフライン対応（サービスワーカー）
// 一度インターネットにつながった状態で開くと、アプリ一式をこのPCのブラウザに保存し、以後は回線がなくても開けるようにする。
// 取得はネットワーク優先：つながっていれば最新版を使ってキャッシュも更新し、つながらなければ保存してある版を使う。
const CACHE = "shindansho-v1";
const FILES = ["./", "index.html", "style.css", "app.js", "drugs.js", "posts.js", "excel/shindansho-shijisho.xlsx"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith("shindansho-") && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const res = await fetch(req, { cache: "no-cache" });
      if (res.ok) cache.put(req, res.clone());
      return res;
    } catch {
      return (await cache.match(req, { ignoreSearch: true })) || (req.mode === "navigate" ? cache.match("index.html") : Response.error());
    }
  })());
});
