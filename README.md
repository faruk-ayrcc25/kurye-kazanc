# Kurye Kazanç Takip

Kuryeler için paket kazancı ve gider takip uygulaması (PWA). Sunucu yok, üyelik yok;
veriler yalnızca telefonda (IndexedDB) saklanır ve internet olmadan da çalışır.

## Dosyalar
| Dosya | Görevi |
|---|---|
| `index.html` | Ekranlar (Bugün / Aylık / Ayarlar), formlar, alt menü |
| `style.css` | Koyu/açık tema, mobil yerleşim |
| `app.js` | Tüm uygulama mantığı (veritabanı, hesaplar, grafik, yedekleme) |
| `manifest.json` | "Ana ekrana ekle" için uygulama bilgileri |
| `service-worker.js` | Çevrimdışı çalışma (dosyaları önbelleğe alır) |
| `icons/` | 192x192 ve 512x512 uygulama ikonları |

## Bilgisayarda test (VS Code + Live Server)
1. VS Code'da **Dosya → Klasör Aç** ile `kurye-kazanc` klasörünü aç.
2. Soldaki Eklentiler (Extensions) bölümünde **Live Server** (Ritwick Dey) eklentisini kur.
3. `index.html` dosyasına sağ tıkla → **Open with Live Server**.
4. Tarayıcıda `http://127.0.0.1:5500/` açılır.
5. Telefon görünümü için: Chrome'da **F12** → üstteki telefon simgesi (Ctrl+Shift+M) → iPhone/Pixel seç.
6. Çevrimdışı testi: F12 → **Application → Service Workers** kayıtlı görünmeli; **Network** sekmesinde
   "Offline" seçip sayfayı yenile, uygulama yine açılmalı.

> Not: Service worker dosyaları önbellekten verir ve arka planda günceller. Kodu değiştirdiğinde
> değişikliği görmek için sayfayı **iki kez** yenile (ya da F12 → Application → "Update on reload" işaretle).
> Yayındaki sürümü güncellerken `service-worker.js` içindeki `CACHE_NAME`'i artır (v1 → v2).

## GitHub Pages'e yükleme
1. github.com'da hesap aç / giriş yap → sağ üst **+ → New repository**.
2. Ad: örn. `kurye-kazanc`, **Public** seç → **Create repository**.
3. Açılan sayfada **uploading an existing file** bağlantısına tıkla.
4. Klasördeki tüm dosyaları **ve `icons` klasörünü** sürükleyip bırak → **Commit changes**.
5. Depoda **Settings → Pages** → *Source*: **Deploy from a branch**, *Branch*: **main** / **(root)** → **Save**.
6. 1–2 dakika sonra adres hazır olur: `https://KULLANICI_ADIN.github.io/kurye-kazanc/`

(Git biliyorsan: `git init && git add . && git commit -m "ilk sürüm" && git branch -M main &&
git remote add origin https://github.com/KULLANICI_ADIN/kurye-kazanc.git && git push -u origin main`)

## Telefona kurma
**Android (Chrome):** adresi Chrome'da aç → sağ üst **⋮** → **Ana ekrana ekle** (veya "Uygulamayı yükle") → **Yükle**.

**iPhone (Safari):** adresi **Safari**'de aç (Chrome'da olmaz) → alttaki **Paylaş** (kare + yukarı ok) →
**Ana Ekrana Ekle** → **Ekle**.

Ana ekrandaki ikondan açınca tam ekran uygulama gibi çalışır. İlk açılıştan sonra internet gerekmez.

## Önemli: Yedek al
Veriler sadece o telefonda durur. Uygulamayı silersen, tarayıcı verilerini temizlersen veya telefon
değiştirirsen kaybolur. **Ayarlar → Yedeği dışa aktar** ile ara sıra JSON yedeği alıp Drive'a / kendine
WhatsApp'a gönder. Yeni telefonda **Yedeği içe aktar** ile geri yükle.
(iPhone'da ana ekrana eklenen uygulamanın verisi Safari'den ayrıdır; yedeği uygulamanın içinden al.)
