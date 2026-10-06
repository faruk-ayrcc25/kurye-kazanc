/* =========================================================
   Kurye Kazanç Takip — Service Worker (çevrimdışı çalışma)
   ---------------------------------------------------------
   - İlk açılışta uygulama dosyalarını önbelleğe (cache) alır.
   - Sonraki açılışlarda dosyaları önce önbellekten verir (internet
     olmasa da açılır), arka planda internetten yenisini indirip
     önbelleği günceller ("stale-while-revalidate").
   - Kodda büyük bir değişiklik yaptığında CACHE_NAME sürümünü
     artır (v1 → v2); eski önbellek otomatik silinir.
   ========================================================= */
const CACHE_NAME = 'kurye-kazanc-v1';

// Önbelleğe alınacak dosyalar — göreli yollar (GitHub Pages alt klasörü için)
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

// Kurulum: dosyaları önbelleğe al
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS)));
  self.skipWaiting(); // yeni sürüm beklemeden devreye girsin
});

// Etkinleştirme: eski sürüm önbellekleri temizle
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// İstekler: önce önbellek, arka planda ağdan güncelle
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;

  event.respondWith(
    caches.open(CACHE_NAME).then(async cache => {
      // Sayfa açılışlarında (?utm=... gibi eklerle gelse bile) index.html'i kullan
      const isPage = req.mode === 'navigate';
      const cached = await cache.match(isPage ? './index.html' : req, { ignoreSearch: true });

      const network = fetch(req)
        .then(res => {
          if (res && res.ok) cache.put(isPage ? './index.html' : req, res.clone());
          return res;
        })
        .catch(() => null);

      if (cached) {
        event.waitUntil(network); // arka planda güncelle
        return cached;
      }
      const res = await network;
      return res || new Response('Çevrimdışı', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    })
  );
});
