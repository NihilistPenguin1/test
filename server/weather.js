// İstanbul hava durumu — Open-Meteo (anahtarsız, CORS destekli). Ağ kapalıysa seed'e düşer.
import { WEATHER_TTL_MS } from './config.js';
import { fetchText } from './rss.js';

export const WEATHER_CODES = {
  0: ['Açık', 'sun'],
  1: ['Az bulutlu', 'sun-cloud'],
  2: ['Parçalı bulutlu', 'sun-cloud'],
  3: ['Çok bulutlu', 'cloud'],
  45: ['Sisli', 'fog'],
  48: ['Kırağılı sis', 'fog'],
  51: ['Hafif çisenti', 'drizzle'],
  53: ['Çisenti', 'drizzle'],
  55: ['Yoğun çisenti', 'drizzle'],
  56: ['Donan çisenti', 'drizzle'],
  57: ['Yoğun donan çisenti', 'drizzle'],
  61: ['Hafif yağmur', 'rain'],
  63: ['Yağmurlu', 'rain'],
  65: ['Kuvvetli yağmur', 'rain'],
  66: ['Donan yağmur', 'rain'],
  67: ['Kuvvetli donan yağmur', 'rain'],
  71: ['Hafif kar', 'snow'],
  73: ['Kar yağışlı', 'snow'],
  75: ['Yoğun kar', 'snow'],
  77: ['Kar taneli', 'snow'],
  80: ['Sağanak', 'showers'],
  81: ['Kuvvetli sağanak', 'showers'],
  82: ['Şiddetli sağanak', 'showers'],
  85: ['Kar sağanağı', 'snow'],
  86: ['Yoğun kar sağanağı', 'snow'],
  95: ['Gök gürültülü sağanak', 'storm'],
  96: ['Dolulu sağanak', 'storm'],
  99: ['Şiddetli dolulu fırtına', 'storm'],
};

export const WEATHER_CODE_TR = Object.fromEntries(
  Object.entries(WEATHER_CODES).map(([k, v]) => [k, v[0]])
);

const DAY_TR = ['Paz', 'Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt'];

let cache = { at: 0, data: null };

const URL =
  'https://api.open-meteo.com/v1/forecast?latitude=41.0082&longitude=28.9784' +
  '&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m,wind_direction_10m' +
  '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max' +
  '&timezone=Europe%2FIstanbul&forecast_days=5';

export async function getWeather(seedFallback) {
  const now = Date.now();
  if (cache.data && now - cache.at < WEATHER_TTL_MS) return cache.data;

  let data;
  try {
    const txt = await fetchText(URL, 10000);
    const j = JSON.parse(txt);
    const c = j.current;
    const d = j.daily;
    const daily = d.time.map((date, i) => ({
      date,
      dayLabel: DAY_TR[new Date(date + 'T12:00:00').getDay()],
      code: d.weather_code[i],
      desc: WEATHER_CODE_TR[d.weather_code[i]] ?? 'Değişken',
      icon: (WEATHER_CODES[d.weather_code[i]] ?? ['', 'cloud'])[1],
      tempMax: Math.round(d.temperature_2m_max[i]),
      tempMin: Math.round(d.temperature_2m_min[i]),
      precipProb: d.precipitation_probability_max?.[i] ?? null,
    }));
    data = {
      city: 'İstanbul',
      live: true,
      fetchedAt: new Date().toISOString(),
      current: {
        temp: Math.round(c.temperature_2m),
        feels: Math.round(c.apparent_temperature),
        humidity: c.relative_humidity_2m,
        wind: Math.round(c.wind_speed_10m),
        windDir: c.wind_direction_10m,
        code: c.weather_code,
        desc: WEATHER_CODE_TR[c.weather_code] ?? 'Değişken',
        icon: (WEATHER_CODES[c.weather_code] ?? ['', 'cloud'])[1],
      },
      daily,
    };
  } catch {
    data = { ...seedFallback.weather, live: false, fetchedAt: new Date().toISOString() };
  }
  cache = { at: now, data };
  return data;
}

export function seedWeatherFromJson(w) {
  return {
    city: 'İstanbul',
    live: false,
    current: w.current,
    daily: w.daily.map((d) => ({
      ...d,
      dayLabel: d.dayLabel ?? DAY_TR[new Date(d.date + 'T12:00:00').getDay()],
      icon: d.icon ?? (WEATHER_CODES[d.code] ?? ['', 'cloud'])[1],
      desc: d.desc ?? WEATHER_CODE_TR[d.code] ?? 'Değişken',
    })),
  };
}
