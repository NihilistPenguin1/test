# TELGRAF 📡

Teknoloji ve dünya gündemini tek ekranda toplayan modern haber servisi. Dünyanın önde gelen
19 yayının resmi beslemelerinden haberleri **görselleriyle** birlikte çeker; **BIST 100 / döviz /
altın** piyasa verilerini ve **İstanbul hava durumu**nu gösterir; haberleri **sitede tam metin** okutur.

## Özellikler

- **RSS toplama** — 19 kaynak, 31 besleme (bölüm feed'leriyle geniş kapsama), 5 dk önbellek
- **Hızlı tam metin** — en yeni haberlerin tam metni önceden hazırlanır (TELGRAF_FULL_TEXT_LIMIT,
  varsayılan 300; 0 = tamamı); tarayıcı parmak izli HTTP (got-scraping) + linkedom/Readability
  ve paralel aşamalarla derleme ~30 sn altına iner
- **Orijinal görseller** — feed görseli korunur; og:image, oEmbed ve metin yedeği katmanları
- **Stealth tarayıcı + challenge geçme** — 403/429/güvenlik duvarında gerçek tarayıcı oturumu:
  turnstile/reCAPTCHA/hCaptcha onay tıklamaları, "Press & Hold" çözme, oturum ısıtma;
  Google News yönlendirmeleri tarayıcıyla çözülür
- **Challenge duyarlı okuma** — her katmanda yayıncı alan adı doğrulaması (Google Fonts tuzaklarına karşı)
- **Hızlı statik derleme** — statik yayın GitHub Pages'ten sunulur; derleme ~30 sn altında tamamlanır
- **Okuma araçları** — sesli dinleme (Web Speech), yazı boyutu A−/A+, paylaşma (X, WhatsApp,
  LinkedIn, kopyala), yazdırma, okuma ilerleme çubuğu, ilgili haberler
- **Kaydedilenler** — ★ ile favorilere ekleme (tarayıcıda saklanır)
- **Yeni haber bildirimi** — otomatik tazelemede "N yeni haber" balonu
- **Piyasa** — BIST 100, Dolar/Euro-TL, gram & ons altın, Brent, Bitcoin
- **Hava durumu** — İstanbul güncel + 5 günlük tahmin (Open-Meteo)
- **Tema** — karaydınlık, tam genişlik duyarlı tasarım, erişilebilirlik (odak halkaları, skip-link)

## Kaynaklar

**Teknoloji:** The Verge · TechCrunch · WIRED · Ars Technica · BBC Technology · Engadget ·
VentureBeat · The Register · MacRumors · Hacker News
**Dünya:** BBC News · Reuters · The Guardian · AP News · Al Jazeera · NYT · France 24 · DW ·
Sky News · NBC News

> Reuters ve AP resmi RSS'i kapattığı için Google News adaptörü kullanılır.

## Mimari

```
server/   Express API — news / market / weather / full-text (Readability)
public/   Vanilla JS frontend (bağımlılıksız, hızlı)
data/     Ağ kapalıyken kullanılan gerçek haber tohumu (94 haber)
```

## Ayarlar (ortam değişkenleri)

Hepsi opsiyoneldir; varsayılanlar GitHub Actions koşucusuna (4 vCPU) göre ayarlıdır.

| Değişken | Varsayılan | Ne yapar |
| --- | --- | --- |
| `TELGRAF_HTTP_HOST_TOTAL` | 6 | Bir yayıncıya toplam eşzamanlı istek (tüm şeritler birlikte) — duvar/429 davet etmeyen üst sınır |
| `TELGRAF_HTTP_LANE_PAGE` / `_PAGE_HOST` | 40 / 4 | Makale+oembed+jina şeridi: süreç ve host başına slot |
| `TELGRAF_HTTP_LANE_IMAGE` / `_IMAGE_HOST` | 56 / 4 | Görsel denetimi şeridi — makale şeridinden bağımsız, birbirini bekletmezler |
| `TELGRAF_HTTP_LANE_FEED` / `_FEED_HOST` | 16 / 2 | RSS/Atom şeridi |
| `TELGRAF_HTTP_HOST_MIN_GAP` | 150 (ms) | Aynı hosta iki istek arası nefes |
| `TELGRAF_HTTP_WALL_TTL` | 2 (dk) | Art arda 3 redden sonra doğrudan çekimin atlanma süresi (tarayıcı denenmeye devam eder) |
| `TELGRAF_FULL_TEXT_LIMIT` | 300 | Önceden hazırlanacak tam metin sayısı (`0` = tümü) |
| `TELGRAF_STEALTH` | 1 | Tarayıcı katmanı; `0` = kapalı |
| `TELGRAF_STEALTH_TIMEOUT` | 45000 (ms) | URL başına tarayıcı bütçesi |
| `TELGRAF_STEALTH_CHALLENGE_WAIT` | 12000 (ms) | Captcha geçmesi için bekleme turu süresi |
| `TELGRAF_STEALTH_CONCURRENCY` | min(6, vCPU) | Açık tarayıcı sayfası |
| `TELGRAF_STEALTH_HOST_CONCURRENCY` | min(4, vCPU) | Host başına paralel sayfa (ısınmış oturum paylaşılır) |
| `TELGRAF_STEALTH_WALL_MS` | 600000 (10 dk) | Duvar saati kesimi: derlemeyi bekletmemek için tarayıcı işini kapatır |
| `TELGRAF_RESCUE` / `_MS` / `_ITEM_MS` | `1` / `240000` / `30000` | Üçüncü geçiş (kurtarma): duvarlı yayıncının haberini Wayback kopyası, tel aynası (aynı haberin yeniden-yayını) ve beklemeli jina ile almaya çalışır. `_MS` turun tümünü, `_ITEM_MS` tek haberi sınırlar; `TELGRAF_RESCUE=0` ile kapanır. |
| `TELGRAF_RESCUE_OVERLAP` / `_HEADLINE` | `0.5` / `0.5` | Kabul eşiği: bulunan sayfanın başlığı haberin başlığıyla ne kadar örtüşmeli. Düşürmek yanlış haberi metin yapma riskini artırır. |
| `TELGRAF_RESCUE_WIRE_ONLY` | `1` | Ayna yolu yalnız tel ajansı etiketi taşıyan yeniden-yayınları kabul eder (`(Reuters)`, `(AP)`). |
| `TELGRAF_STEALTH_QUICK_COOLDOWN[_MAX]` | 240000 / 2700000 (ms) | Duvarlı hostta tam denemeye dönüşün seyrekleşme aralığı |

## Çalıştırma

```bash
npm install
npm start          # http://localhost:3000
```

Windows: `guncelle.bat` (çek + kur) ve `calistir.bat` (başlat) kısayolları.

## API

| Uç nokta | Açıklama |
|---|---|
| `GET /api/news?category=&source=&q=&limit=&offset=` | Haber akışı |
| `GET /api/news/:id/full` | Tam metin okuma |
| `GET /api/market` | Piyasa verileri |
| `GET /api/weather` | İstanbul hava durumu |
| `GET /api/sources` | Kaynak listesi |

---

Piyasa ve hava verileri bilgilendirme amaçlıdır, yatırım tavsiyesi değildir. Tüm içeriklerin telif
hakkı kaynak yayınlarına aittir; her kart orijinal makaleye bağlantı verir.
