/* PUSULA HABER — arayüz mantığı */
(() => {
  'use strict';

  const $ = (sel, el = document) => el.querySelector(sel);
  const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

  const state = {
    news: [],
    filtered: [],
    category: 'all',
    source: 'all',
    query: '',
    shown: 0,
    pageSize: 24,
    sources: [],
    live: null,
  };

  /* ---------- Yardımcılar ---------- */
  const SOURCE_META = {};
  const favicon = (domain) => `https://www.google.com/s2/favicons?domain=${domain}&sz=64`;

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function relTime(iso) {
    const d = new Date(iso);
    const diff = (Date.now() - d.getTime()) / 1000;
    if (diff < 90) return 'az önce';
    if (diff < 3600) return `${Math.round(diff / 60)} dk önce`;
    if (diff < 86400) return `${Math.round(diff / 3600)} sa önce`;
    if (diff < 172800) return 'dün';
    const dd = String(d.getDate()).padStart(2, '0');
    const months = ['Oca', 'Şub', 'Mar', 'Nis', 'May', 'Haz', 'Tem', 'Ağu', 'Eyl', 'Eki', 'Kas', 'Ara'];
    return `${dd} ${months[d.getMonth()]}`;
  }

  function fullTime(iso) {
    return new Date(iso).toLocaleString('tr-TR', {
      day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  }

  function fmtNum(n, decimals = 2) {
    return Number(n).toLocaleString('tr-TR', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  }

  // Görsel yoksa kaynak renkli SVG yer tutucu
  function placeholderSVG(title, sourceId) {
    const meta = SOURCE_META[sourceId] || { name: 'Pusula', color: '#6f675e' };
    const label = esc((meta.short || meta.name || 'Haber').slice(0, 14));
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='800' height='450'>
      <defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'>
        <stop offset='0' stop-color='${meta.color}' stop-opacity='0.92'/>
        <stop offset='1' stop-color='#1a1611' stop-opacity='0.95'/></linearGradient></defs>
      <rect width='800' height='450' fill='url(#g)'/>
      <circle cx='700' cy='80' r='160' fill='#ffffff' opacity='0.07'/>
      <circle cx='90' cy='400' r='120' fill='#ffffff' opacity='0.06'/>
      <text x='50%' y='49%' text-anchor='middle' font-family='Georgia,serif' font-size='42' fill='#ffffff' opacity='0.95' font-weight='bold' letter-spacing='6'>${label}</text>
      <text x='50%' y='58%' text-anchor='middle' font-family='Helvetica,Arial' font-size='17' fill='#ffffff' opacity='0.65' letter-spacing='3'>PUSULA · HABER</text>
    </svg>`;
    // Tek tırnaklar onerror özniteliğini kırmasın diye kodlanır
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg).replace(/'/g, '%27')}`;
  }

  function imgTag(item, cls = '') {
    const src = item.image || placeholderSVG(item.title, item.source);
    return `<img class="${cls}" src="${esc(src)}" alt="${esc(item.title)}" loading="lazy"
      onerror="this.onerror=null;this.src='${placeholderSVG(item.title, item.source)}'" />`;
  }

  function srcBadge(sourceId) {
    const meta = SOURCE_META[sourceId] || { name: sourceId, color: '#6f675e', domain: '' };
    return `<span class="src-badge" style="background:${meta.color}">
      ${meta.domain ? `<img src="${favicon(meta.domain)}" alt="" onerror="this.style.display='none'" />` : ''}
      ${esc(meta.short || meta.name)}</span>`;
  }

  function catTag(cat) {
    const label = cat === 'tech' ? 'Teknoloji' : 'Dünya';
    return `<span class="cat-tag cat-${cat}">${label}</span>`;
  }

  /* ---------- Hava ikonları (inline SVG) ---------- */
  function weatherIcon(type, size = 48) {
    const sun = `<circle cx='12' cy='12' r='5' fill='#f59e0b'/>`;
    const cloud = `<path d='M7 18h10a4 4 0 0 0 .6-7.96A6 6 0 0 0 6.1 11.2 3.5 3.5 0 0 0 7 18z' fill='#94a3b8'/>`;
    const icons = {
      sun: `<svg viewBox='0 0 24 24' width='${size}' height='${size}'>${sun}</svg>`,
      'sun-cloud': `<svg viewBox='0 0 24 24' width='${size}' height='${size}'><circle cx='8.5' cy='8' r='3.6' fill='#f59e0b'/><path d='M8 19h9.5a3.7 3.7 0 0 0 .5-7.36A5.6 5.6 0 0 0 7.4 12.6 3.3 3.3 0 0 0 8 19z' fill='#94a3b8'/></svg>`,
      cloud: `<svg viewBox='0 0 24 24' width='${size}' height='${size}'>${cloud}</svg>`,
      rain: `<svg viewBox='0 0 24 24' width='${size}' height='${size}'>${cloud}<path d='M9 20l-1 2M13 20l-1 2M17 20l-1 2' stroke='#60a5fa' stroke-width='1.8' stroke-linecap='round'/></svg>`,
      showers: `<svg viewBox='0 0 24 24' width='${size}' height='${size}'>${cloud}<path d='M8 20l-1.2 2.5M12.5 20l-1.2 2.5M17 20l-1.2 2.5' stroke='#3b82f6' stroke-width='1.8' stroke-linecap='round'/></svg>`,
      storm: `<svg viewBox='0 0 24 24' width='${size}' height='${size}'>${cloud}<path d='M13 18l-3 4h3l-1 3 5-5h-3l2-2z' fill='#fbbf24'/></svg>`,
      snow: `<svg viewBox='0 0 24 24' width='${size}' height='${size}'>${cloud}<circle cx='9' cy='21' r='1' fill='#93c5fd'/><circle cx='13' cy='22' r='1' fill='#93c5fd'/><circle cx='17' cy='21' r='1' fill='#93c5fd'/></svg>`,
      fog: `<svg viewBox='0 0 24 24' width='${size}' height='${size}'>${cloud}<path d='M5 20h14M7 22h10' stroke='#94a3b8' stroke-width='1.6' stroke-linecap='round'/></svg>`,
      drizzle: `<svg viewBox='0 0 24 24' width='${size}' height='${size}'>${cloud}<path d='M10 20l-.7 1.6M15 20l-.7 1.6' stroke='#60a5fa' stroke-width='1.6' stroke-linecap='round'/></svg>`,
    };
    return icons[type] || icons.cloud;
  }

  /* ---------- Ticker ---------- */
  function renderTicker(market) {
    const track = $('#tickerTrack');
    track.innerHTML = market.items.map((m) => {
      const up = m.changePercent >= 0;
      return `<span class="ticker-item">
        <span class="ticker-name">${esc(m.name)}</span>
        <span class="ticker-price">${fmtNum(m.price, m.decimals)}</span>
        <span class="ticker-chg ${up ? 'up' : 'down'}">${up ? '▲' : '▼'} %${fmtNum(Math.abs(m.changePercent), 2)}</span>
      </span>`;
    }).join('') + `<span class="ticker-item"><span class="ticker-name">${market.live ? 'Canlı veri' : 'Örnek veri'}</span>
      <span class="ticker-price" style="color:${market.live ? '#34d399' : '#b7ab99'}">${market.live ? '●' : '○'}</span></span>`;
  }

  function renderMarketPanel(market) {
    $('#marketPanel').innerHTML = market.items.map((m) => {
      const up = m.changePercent >= 0;
      return `<div class="market-row">
        <span class="market-name">${esc(m.name)}</span>
        <span class="market-price">${fmtNum(m.price, m.decimals)} ${m.currency === 'TRY' ? '₺' : m.currency === 'USD' ? '$' : ''}</span>
        <span class="market-chg ${up ? 'up' : 'down'}">${up ? '▲' : '▼'} %${fmtNum(Math.abs(m.changePercent), 2)}</span>
      </div>`;
    }).join('');
    $('#marketNote').textContent = market.live
      ? `Canlı veri · ${new Date(market.fetchedAt).toLocaleTimeString('tr-TR')} · Yatırım tavsiyesi değildir.`
      : 'Örnek gösterim verisi (canlı piyasa bağlantısı kurulamadı). Yatırım tavsiyesi değildir.';
  }

  /* ---------- Hava ---------- */
  function renderWeather(w) {
    const c = w.current;
    $('#headerWeatherMini').textContent = `İstanbul ${c.temp}° · ${c.desc}`;
    $('#weatherPanel').innerHTML = `
      <div class="weather-now">
        <div class="weather-icon">${weatherIcon(c.icon, 58)}</div>
        <div>
          <div class="weather-temp">${c.temp}°</div>
          <div class="weather-desc">${esc(c.desc)} · Hissedilen ${c.feels}°</div>
        </div>
      </div>
      <div class="weather-details">
        <div class="wd-item"><div class="wd-label">Nem</div><div class="wd-value">%${c.humidity}</div></div>
        <div class="wd-item"><div class="wd-label">Rüzgar</div><div class="wd-value">${c.wind} km/s</div></div>
        <div class="wd-item"><div class="wd-label">Hissedilen</div><div class="wd-value">${c.feels}°</div></div>
      </div>
      <div class="weather-days">
        ${w.daily.slice(0, 5).map((d) => `
          <div class="wd-day" title="${esc(d.desc)}">
            <div class="wd-day-name">${esc(d.dayLabel)}</div>
            ${weatherIcon(d.icon, 26)}
            <div class="wd-day-temps">${d.tempMax}° <span class="lo">${d.tempMin}°</span></div>
          </div>`).join('')}
      </div>`;
  }

  // Sunucu canlı veri veremezse tarayıcıdan dene (Open-Meteo CORS destekler)
  async function liveWeatherFallback() {
    try {
      const url = 'https://api.open-meteo.com/v1/forecast?latitude=41.0082&longitude=28.9784&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m&daily=weather_code,temperature_2m_max,temperature_2m_min&timezone=Europe%2FIstanbul&forecast_days=5';
      const res = await fetch(url);
      if (!res.ok) return;
      const j = await res.json();
      const codes = { 0: ['Açık', 'sun'], 1: ['Az bulutlu', 'sun-cloud'], 2: ['Parçalı bulutlu', 'sun-cloud'], 3: ['Çok bulutlu', 'cloud'], 45: ['Sisli', 'fog'], 48: ['Sisli', 'fog'], 51: ['Çisenti', 'drizzle'], 53: ['Çisenti', 'drizzle'], 55: ['Çisenti', 'drizzle'], 61: ['Hafif yağmur', 'rain'], 63: ['Yağmurlu', 'rain'], 65: ['Kuvvetli yağmur', 'rain'], 66: ['Yağmurlu', 'rain'], 67: ['Kuvvetli yağmur', 'rain'], 71: ['Hafif kar', 'snow'], 73: ['Kar yağışlı', 'snow'], 75: ['Yoğun kar', 'snow'], 80: ['Sağanak', 'showers'], 81: ['Kuvvetli sağanak', 'showers'], 82: ['Şiddetli sağanak', 'showers'], 85: ['Kar sağanağı', 'snow'], 86: ['Yoğun kar sağanağı', 'snow'], 95: ['Gök gürültülü sağanak', 'storm'], 96: ['Dolulu sağanak', 'storm'], 99: ['Fırtına', 'storm'] };
      const days = ['Paz', 'Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt'];
      const c = j.current;
      renderWeather({
        live: true,
        current: {
          temp: Math.round(c.temperature_2m), feels: Math.round(c.apparent_temperature),
          humidity: c.relative_humidity_2m, wind: Math.round(c.wind_speed_10m),
          code: c.weather_code, desc: (codes[c.weather_code] || ['Değişken', 'cloud'])[0],
          icon: (codes[c.weather_code] || ['', 'cloud'])[1],
        },
        daily: j.daily.time.map((date, i) => ({
          date,
          dayLabel: days[new Date(date + 'T12:00:00').getDay()],
          icon: (codes[j.daily.weather_code[i]] || ['', 'cloud'])[1],
          desc: (codes[j.daily.weather_code[i]] || ['Değişken'])[0],
          tempMax: Math.round(j.daily.temperature_2m_max[i]),
          tempMin: Math.round(j.daily.temperature_2m_min[i]),
        })),
      });
    } catch { /* sessiz */ }
  }

  // Sunucu canlı piyasa veremezse tarayıcıdan dene (CORS proxy üzerinden Yahoo Finance)
  async function liveMarketFallback() {
    const SYMBOLS = [
      { symbol: 'XU100.IS', key: 'bist100', name: 'BIST 100', currency: 'TRY', decimals: 2 },
      { symbol: 'TRY=X', key: 'usdtry', name: 'Dolar/TL', currency: 'TRY', decimals: 4 },
      { symbol: 'EURTRY=X', key: 'eurtry', name: 'Euro/TL', currency: 'TRY', decimals: 4 },
      { symbol: 'GC=F', key: 'gold', name: 'Ons Altın', currency: 'USD', decimals: 2 },
      { symbol: 'BZ=F', key: 'brent', name: 'Brent Petrol', currency: 'USD', decimals: 2 },
      { symbol: 'BTC-USD', key: 'btc', name: 'Bitcoin', currency: 'USD', decimals: 0 },
    ];
    const proxies = [
      (u) => `https://corsproxy.io/?url=${encodeURIComponent(u)}`,
      (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
    ];
    try {
      const items = [];
      for (const s of SYMBOLS) {
        const target = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(s.symbol)}?interval=1d&range=2d`;
        let json = null;
        for (const proxify of proxies) {
          try {
            const res = await fetch(proxify(target));
            if (!res.ok) continue;
            json = await res.json();
            if (json?.chart?.result?.[0]) break;
          } catch { /* sonraki proxy */ }
        }
        const result = json?.chart?.result?.[0];
        if (!result) return; // toplu güncelleme yerine hiç dokunma
        const meta = result.meta;
        const price = meta.regularMarketPrice ?? meta.chartPreviousClose;
        const prev = meta.chartPreviousClose ?? price;
        items.push({ ...s, price, change: price - prev, changePercent: prev ? ((price - prev) / prev) * 100 : 0 });
      }
      const gold = items.find((i) => i.key === 'gold');
      const usd = items.find((i) => i.key === 'usdtry');
      if (gold && usd) {
        const gram = (gold.price * usd.price) / 31.1035;
        items.push({ key: 'gramgold', name: 'Gram Altın', currency: 'TRY', decimals: 2, price: gram, change: 0, changePercent: 0 });
      }
      renderTicker({ items, live: true });
      renderMarketPanel({ items, live: true, fetchedAt: new Date().toISOString() });
    } catch { /* sessiz: örnek veri kalır */ }
  }

  /* ---------- Kartlar ---------- */
  function cardHTML(item) {
    return `<article class="news-card" data-id="${item.id}" tabindex="0">
      <div class="card-media">${imgTag(item)}</div>
      <div class="card-body">
        <div class="meta-row">${catTag(item.category)} ${srcBadge(item.source)} <time datetime="${item.published}" title="${fullTime(item.published)}">${relTime(item.published)}</time></div>
        <h3 class="card-title">${esc(item.title)}</h3>
        ${item.summary ? `<p class="card-summary">${esc(item.summary)}</p>` : ''}
      </div>
    </article>`;
  }

  function applyFilters(resetShown = true) {
    let list = state.news;
    if (state.category !== 'all') list = list.filter((i) => i.category === state.category);
    if (state.source !== 'all') list = list.filter((i) => i.source === state.source);
    if (state.query) {
      const n = state.query.toLocaleLowerCase('tr');
      list = list.filter((i) => i.title.toLocaleLowerCase('tr').includes(n) || (i.summary || '').toLocaleLowerCase('tr').includes(n));
    }
    state.filtered = list;
    if (resetShown) state.shown = 0;
    renderGrid();
  }

  function renderGrid() {
    const grid = $('#cardGrid');
    const slice = state.filtered.slice(0, state.shown + state.pageSize);
    state.shown = slice.length;
    grid.innerHTML = slice.map(cardHTML).join('') || `<p style="color:var(--muted)">Bu filtreyle eşleşen haber bulunamadı.</p>`;
    $('#feedCount').textContent = `${state.filtered.length} haber`;
    const btn = $('#loadMoreBtn');
    btn.disabled = state.shown >= state.filtered.length;
    btn.textContent = state.shown >= state.filtered.length ? 'Tüm haberler yüklendi' : 'Daha fazla haber yükle';
  }

  /* ---------- Hero ---------- */
  function renderHero(items) {
    const [lead, ...rest] = items;
    if (!lead) return;
    $('#heroLead').innerHTML = `
      <a class="lead-card" href="${esc(lead.link)}" data-id="${lead.id}" target="_blank" rel="noopener noreferrer">
        <div class="lead-media">${imgTag(lead)}</div>
        <div class="lead-body">
          <div class="meta-row">${catTag(lead.category)} ${srcBadge(lead.source)} <time title="${fullTime(lead.published)}">${relTime(lead.published)}</time></div>
          <h2 class="lead-title">${esc(lead.title)}</h2>
          ${lead.summary ? `<p class="lead-summary">${esc(lead.summary)}</p>` : ''}
        </div>
      </a>`;

    $('#heroSide').innerHTML = rest.slice(0, 3).map((item) => `
      <a class="side-card" href="${esc(item.link)}" data-id="${item.id}" target="_blank" rel="noopener noreferrer">
        <div class="side-media">${imgTag(item)}</div>
        <div>
          <div class="meta-row">${srcBadge(item.source)} <time title="${fullTime(item.published)}">${relTime(item.published)}</time></div>
          <h3 class="side-title">${esc(item.title)}</h3>
        </div>
      </a>`).join('');

    $('#latestList').innerHTML = items.slice(4, 12).map((item, idx) => `
      <li class="latest-item" data-id="${item.id}" tabindex="0">
        <span class="latest-num">${String(idx + 1).padStart(2, '0')}</span>
        <div>
          <p class="latest-title">${esc(item.title)}</p>
          <div class="meta-row">${srcBadge(item.source)} <time title="${fullTime(item.published)}">${relTime(item.published)}</time></div>
        </div>
      </li>`).join('');
  }

  function renderBreaking(items) {
    const top = items.slice(0, 10);
    const html = top.map((i) => `<a href="${esc(i.link)}" data-id="${i.id}" target="_blank" rel="noopener">${esc(i.title)}</a>`).join('<span style="opacity:.35">◆</span>');
    $('#breakingTrack').innerHTML = html + `<span style="opacity:.35">◆</span>` + html; // marquee döngüsü
  }

  function renderTrending(items) {
    // Sağdaki "Çok Okunanlar": ilk 5 + kaynak çeşitliliği
    const picks = [];
    const used = new Set();
    for (const it of items) {
      if (used.has(it.source)) continue;
      used.add(it.source);
      picks.push(it);
      if (picks.length === 5) break;
    }
    $('#trendList').innerHTML = picks.map((item, idx) => `
      <li class="trend-item" data-id="${item.id}" tabindex="0">
        <span class="trend-num">${idx + 1}</span>
        <div>
          <p class="trend-title">${esc(item.title)}</p>
          <div class="meta-row">${srcBadge(item.source)}</div>
        </div>
      </li>`).join('');
  }

  /* ---------- Kaynaklar ---------- */
  function renderSources() {
    $('#sourcesGrid').innerHTML = state.sources.map((s) => `
      <a class="source-card" href="${esc(s.home)}" target="_blank" rel="noopener">
        <img class="source-favicon" src="${favicon(s.domain)}" alt="" onerror="this.style.visibility='hidden'" />
        <div class="source-info">
          <span class="source-name">${esc(s.name)}</span>
          <span class="source-kind">${s.categories.includes('tech') && s.categories.includes('world') ? 'Teknoloji · Dünya' : s.categories.includes('tech') ? 'Teknoloji' : 'Dünya'}</span>
        </div>
      </a>`).join('');

    $('#sourceChips').innerHTML = `<button class="chip active" data-source="all">Tüm kaynaklar</button>` +
      state.sources.map((s) => `
        <button class="chip" data-source="${s.id}">
          <img src="${favicon(s.domain)}" alt="" onerror="this.style.display='none'" />${esc(s.name)}
        </button>`).join('');
  }

  /* ---------- Modal ---------- */
  function openModal(id) {
    const item = state.news.find((i) => i.id === id);
    if (!item) return;
    const meta = SOURCE_META[item.source] || {};
    $('#modalMedia').innerHTML = imgTag(item);
    $('#modalSource').innerHTML = `${srcBadge(item.source)} ${catTag(item.category)}`;
    $('#modalTime').textContent = fullTime(item.published);
    $('#modalTitle').textContent = item.title;
    $('#modalSummary').textContent = item.summary || '';
    $('#modalSummary').hidden = !item.summary;
    $('#modalContent').innerHTML = '';
    $('#modalAuthor').textContent = `Kaynak: ${meta.name || item.source}${item.author ? ' · ' + item.author : ''}`;
    $('#modalReadTime').textContent = '';
    $('#modalLink').href = item.link;
    $('#articleModal').hidden = false;
    document.body.style.overflow = 'hidden';

    // Tam metni getir (haberi sitede oku)
    const loading = $('#modalLoading');
    loading.hidden = false;
    fetch(`/api/news/${item.id}/full`)
      .then((r) => {
        if (!r.ok) throw new Error('content unavailable');
        return r.json();
      })
      .then((data) => {
        if ($('#articleModal').hidden) return; // modal kapanmışsa atla
        loading.hidden = true;
        const a = data.article;
        if (a && a.content) {
          $('#modalContent').innerHTML = a.content;
          $('#modalSummary').hidden = true;
          if (a.image) $('#modalMedia').innerHTML = `<img src="${esc(a.image)}" alt="${esc(a.title)}"
            onerror="this.onerror=null;this.src='${placeholderSVG(item.title, item.source)}'" />`;
          $('#modalReadTime').textContent = `· ~${a.readingMinutes} dk okuma`;
          $('#modalAuthor').textContent = `Kaynak: ${meta.name || item.source}${a.author ? ' · ' + a.author : ''}${item.author && a.author !== item.author ? ' · ' + item.author : ''}`;
          // Gerçek makale linki (Google News yönlendirmesi çözülmüş olabilir)
          if (a.resolvedUrl && !a.resolvedUrl.includes('news.google.com')) $('#modalLink').href = a.resolvedUrl;
        } else {
          loading.hidden = true;
          $('#modalSummary').hidden = false;
          if (!$('#modalSummary').textContent) {
            $('#modalSummary').textContent = 'Bu haber için tam metin getirilemedi. Devamını kaynak yayının sayfasında okuyabilirsiniz.';
          }
        }
      })
      .catch(() => {
        if ($('#articleModal').hidden) return;
        loading.hidden = true;
        $('#modalSummary').hidden = false;
        if (!$('#modalSummary').textContent) {
          $('#modalSummary').textContent = 'Bu haber için tam metin getirilemedi. Devamını kaynak yayının sayfasında okuyabilirsiniz.';
        }
      });
  }
  function closeModal() {
    $('#articleModal').hidden = true;
    document.body.style.overflow = '';
  }

  /* ---------- Tema ---------- */
  function initTheme() {
    const saved = localStorage.getItem('pusula-theme');
    const theme = saved || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    document.documentElement.dataset.theme = theme;
    $('#themeBtn').addEventListener('click', () => {
      const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      localStorage.setItem('pusula-theme', next);
    });
  }

  /* ---------- Olaylar ---------- */
  function initEvents() {
    document.addEventListener('click', (e) => {
      // Manşet / yan kart / son dakika: normal tık sitede okuma görünümünü açar
      // (Ctrl/Cmd+tık ve orta tık orijinal haberi yeni sekmede açar)
      const heroLink = e.target.closest('.lead-card[data-id], .side-card[data-id], .breaking-track a[data-id]');
      if (heroLink && e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
        e.preventDefault();
        openModal(heroLink.dataset.id);
        return;
      }
      const card = e.target.closest('.news-card, .latest-item, .trend-item');
      if (card && card.dataset.id) { openModal(card.dataset.id); return; }
      if (e.target.closest('[data-close]')) { closeModal(); return; }
      const navCat = e.target.closest('.nav-link[data-cat]');
      if (navCat) {
        e.preventDefault();
        state.category = navCat.dataset.cat;
        $$('.nav-link[data-cat]').forEach((b) => b.classList.toggle('active', b === navCat));
        $('#feedTitle').textContent = state.category === 'tech' ? 'Teknoloji Gündemi' : state.category === 'world' ? 'Dünya Gündemi' : 'Gündem';
        applyFilters();
        $('#cardGrid').scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      }
      const footerCat = e.target.closest('a[data-cat]');
      if (footerCat) {
        e.preventDefault();
        const btn = $(`.nav-link[data-cat="${footerCat.dataset.cat}"]`);
        if (btn) btn.click();
        return;
      }
      const chip = e.target.closest('.chip');
      if (chip) {
        state.source = chip.dataset.source;
        $$('.chip').forEach((c) => c.classList.toggle('active', c === chip));
        applyFilters();
        return;
      }
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeModal();
      if (e.key === 'Enter') {
        const el = document.activeElement;
        if (el && el.dataset && el.dataset.id) openModal(el.dataset.id);
      }
    });

    $('#loadMoreBtn').addEventListener('click', () => renderGrid());

    // Kaydırdıkça otomatik yükle (sonsuz akış)
    if ('IntersectionObserver' in window) {
      const io = new IntersectionObserver((entries) => {
        if (entries.some((en) => en.isIntersecting) && state.shown < state.filtered.length) {
          renderGrid();
        }
      }, { rootMargin: '600px 0px' });
      io.observe($('#loadMoreBtn'));
    }

    let searchTimer;
    $('#searchInput').addEventListener('input', (e) => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        state.query = e.target.value.trim();
        applyFilters();
      }, 220);
    });
    $('#searchForm').addEventListener('submit', (e) => e.preventDefault());

    $('#menuBtn').addEventListener('click', () => {
      $('#mainNav').scrollIntoView({ behavior: 'smooth' });
    });
  }

  /* ---------- Veri yükleme ---------- */
  async function loadAll() {
    const [newsRes, marketRes, weatherRes, sourcesRes] = await Promise.allSettled([
      fetch('/api/news').then((r) => r.json()),
      fetch('/api/market').then((r) => r.json()),
      fetch('/api/weather').then((r) => r.json()),
      fetch('/api/sources').then((r) => r.json()),
    ]);

    if (sourcesRes.status === 'fulfilled') {
      state.sources = sourcesRes.value.sources;
      state.sources.forEach((s) => { SOURCE_META[s.id] = s; });
      renderSources();
    }

    if (newsRes.status === 'fulfilled' && newsRes.value.items) {
      state.news = newsRes.value.items;
      state.live = newsRes.value.live;
      renderHero(state.news);
      renderBreaking(state.news);
      renderTrending(state.news);
      applyFilters();

      const dot = $('.live-dot');
      const txt = $('#navLiveText');
      if (newsRes.value.live) {
        txt.textContent = `canlı · son güncelleme ${new Date(newsRes.value.fetchedAt).toLocaleTimeString('tr-TR')}`;
      } else {
        dot.classList.add('offline');
        txt.textContent = 'çevrimdışı mod · tohum veri';
      }
    }

    if (marketRes.status === 'fulfilled' && marketRes.value.items) {
      renderTicker(marketRes.value);
      renderMarketPanel(marketRes.value);
      if (!marketRes.value.live) liveMarketFallback();
    }

    if (weatherRes.status === 'fulfilled' && weatherRes.value.current) {
      renderWeather(weatherRes.value);
      if (!weatherRes.value.live) liveWeatherFallback();
    }
  }

  /* ---------- Başlat ---------- */
  function init() {
    initTheme();
    initEvents();
    const now = new Date();
    $('#headerDate').textContent = now.toLocaleDateString('tr-TR', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    });
    $('#year').textContent = now.getFullYear();
    loadAll();
    // 5 dakikada bir tazele
    setInterval(loadAll, 5 * 60 * 1000);
  }

  document.addEventListener('DOMContentLoaded', init);
})();
