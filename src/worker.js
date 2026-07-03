/**
 * hub-weather — Cloudflare Worker del servicio de clima de Hub Education.
 *
 * Port 1:1 de server.js (Express) para correr hosteado sin depender de la PC
 * de Erick ni del túnel efímero de trycloudflare. Misma API:
 *   GET /weather?lat&lon&windAlt&gustAlt  → mismo JSON que el server local
 *   GET /health                           → { ok: true }
 *
 * Fuentes: Open-Meteo (sin key) + índice Kp de NOAA SWPC (best-effort).
 * Caché: en memoria del isolate, TTL 5 min por coordenada redondeada (~1 km)
 * + altitudes. Los isolates se reciclan, pero para este tráfico alcanza y
 * evita golpear a Open-Meteo en ráfagas.
 *
 * Deploy:  npx wrangler deploy   (config en wrangler.toml)
 */

const UPSTREAM_TIMEOUT_MS = 8000;
const KP_TIMEOUT_MS = 3000;
const CACHE_TTL_MS = 5 * 60 * 1000;

const DEFAULT_LOCATION = { lat: -34.6, lon: -58.38, name: 'Buenos Aires' };

// Caché por isolate: key -> { expires, payload }
const cache = new Map();
const cacheKey = (lat, lon, windAlt, gustAlt) =>
  `${lat.toFixed(2)},${lon.toFixed(2)},${windAlt},${gustAlt}`;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept, bypass-tunnel-reminder',
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }
    if (url.pathname === '/health') {
      return json({ ok: true });
    }
    if (url.pathname !== '/weather') {
      return json({ error: 'No encontrado' }, 404);
    }

    try {
      // Validar coordenadas (mismas reglas que server.js): si vienen pero no
      // son números finitos o están fuera de rango → 400, no default silencioso.
      let lat, lon;
      const qLat = url.searchParams.get('lat');
      const qLon = url.searchParams.get('lon');
      if (qLat != null || qLon != null) {
        lat = parseFloat(qLat);
        lon = parseFloat(qLon);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
          return json({ error: 'Coordenadas inválidas: lat y lon deben ser números.' }, 400);
        }
        if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
          return json({ error: 'Coordenadas fuera de rango: lat ∈ [-90, 90], lon ∈ [-180, 180].' }, 400);
        }
      } else {
        lat = DEFAULT_LOCATION.lat;
        lon = DEFAULT_LOCATION.lon;
      }
      const locationName =
        lat === DEFAULT_LOCATION.lat && lon === DEFAULT_LOCATION.lon
          ? DEFAULT_LOCATION.name
          : `${lat.toFixed(2)}, ${lon.toFixed(2)}`;

      // Altitudes independientes para viento y ráfagas (m). Clamp [0, 500].
      const clampAlt = (raw, def = 10) => {
        const v = parseFloat(raw);
        return Math.min(500, Math.max(0, Number.isFinite(v) ? v : def));
      };
      const qWind = url.searchParams.get('windAlt');
      const qGust = url.searchParams.get('gustAlt');
      const windAlt = qWind != null ? clampAlt(qWind) : 10;
      const gustAlt = qGust != null ? clampAlt(qGust) : windAlt;

      // Cache hit
      const key = cacheKey(lat, lon, windAlt, gustAlt);
      const hit = cache.get(key);
      if (hit && hit.expires > Date.now()) {
        return json(hit.payload);
      }

      const meteoUrl = [
        'https://api.open-meteo.com/v1/forecast',
        `?latitude=${lat}&longitude=${lon}`,
        '&current_weather=true',
        '&hourly=wind_speed_10m,wind_speed_100m,wind_gusts_10m,visibility,cloud_cover,precipitation_probability,relative_humidity_2m',
        '&daily=sunrise,sunset',
        '&timezone=auto',
        '&forecast_days=1',
        '&models=ecmwf_ifs025',
      ].join('');

      // Kp en paralelo, best-effort (si falla o tarda, se omite).
      const kpPromise = fetch(
        'https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json',
        { signal: AbortSignal.timeout(KP_TIMEOUT_MS) },
      )
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);

      const meteoRes = await fetch(meteoUrl, {
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        headers: { Accept: 'application/json' },
      });
      if (!meteoRes.ok) {
        return json({ error: 'No se pudo obtener el clima' }, 502);
      }
      const data = await meteoRes.json();
      const kpData = await kpPromise;

      const cw = data.current_weather;
      const hourly = data.hourly;
      const daily = data.daily;

      // Sunrise/sunset del primer día (strings ISO en hora local del lugar).
      let daylight;
      if (daily && Array.isArray(daily.sunrise) && Array.isArray(daily.sunset)) {
        const sunrise = daily.sunrise[0];
        const sunset = daily.sunset[0];
        const nowLocal = cw.time;
        const isDaylight = Boolean(sunrise && sunset && nowLocal >= sunrise && nowLocal < sunset);
        daylight = { sunrise, sunset, isDaylight };
      }

      const currentTime = cw.time;
      let hourIndex = hourly.time.indexOf(currentTime);
      if (hourIndex === -1) hourIndex = 0;

      // Viento a distintas alturas (ECMWF: 10 m y 100 m). Interpolación LINEAL
      // con clamp en los extremos — aproximación del perfil logarítmico real,
      // suficiente para el rango de vuelo de drones (0–122 m).
      const wind10 = hourly.wind_speed_10m[hourIndex] ?? cw.windspeed;
      const wind100 = hourly.wind_speed_100m[hourIndex] ?? wind10;
      const interp = (alt) => {
        if (alt <= 10) return wind10;
        if (alt >= 100) return wind100;
        return wind10 + ((wind100 - wind10) * (alt - 10)) / 90;
      };
      const windSpeed = Math.round(interp(windAlt) * 10) / 10;
      const temperature = cw.temperature;
      const gust10 = hourly.wind_gusts_10m[hourIndex] ?? 0;
      const gustScale = wind10 > 0 ? interp(gustAlt) / wind10 : 1;
      const gusts = Math.round(gust10 * gustScale * 10) / 10;
      const visibility = hourly.visibility[hourIndex] ?? 0;
      const cloudCover = hourly.cloud_cover[hourIndex] ?? 0;
      const precipitationProbability = hourly.precipitation_probability[hourIndex] ?? 0;
      const humidity = hourly.relative_humidity_2m[hourIndex] ?? 0;

      // Horario crudo con viento/ráfagas escalados a las altitudes pedidas.
      const hourlyData = hourly.time.map((hour, i) => {
        const w10 = hourly.wind_speed_10m[i] ?? 0;
        const w100 = hourly.wind_speed_100m[i] ?? w10;
        const interpH = (alt) => {
          if (alt <= 10) return w10;
          if (alt >= 100) return w100;
          return w10 + ((w100 - w10) * (alt - 10)) / 90;
        };
        const g10 = hourly.wind_gusts_10m[i] ?? 0;
        const scale = w10 > 0 ? interpH(gustAlt) / w10 : 1;
        return {
          hour: hour.slice(11, 16),
          windSpeed: Math.round(interpH(windAlt) * 10) / 10,
          gusts: Math.round(g10 * scale * 10) / 10,
          precipitationProbability: hourly.precipitation_probability[i] ?? 0,
        };
      });

      // Kp: entrada observed/estimated cuya ventana de 3 h contiene "ahora".
      let kpIndex;
      if (Array.isArray(kpData) && kpData.length > 0) {
        const nowMs = Date.now();
        let latest;
        for (let i = kpData.length - 1; i >= 0; i--) {
          const entry = kpData[i];
          if (!entry || typeof entry !== 'object') continue;
          const status = entry.observed;
          if (status !== 'observed' && status !== 'estimated') continue;
          const tMs = Date.parse(`${entry.time_tag}Z`);
          if (!Number.isFinite(tMs)) continue;
          if (tMs <= nowMs) {
            latest = entry;
            break;
          }
        }
        if (latest) {
          kpIndex = { value: parseFloat(latest.kp), updatedAt: latest.time_tag };
        }
      }

      const payload = {
        location: { lat, lon, name: locationName },
        windAlt,
        gustAlt,
        current: {
          windSpeed,
          gusts,
          visibility,
          cloudCover,
          precipitationProbability,
          temperature,
          humidity,
        },
        kpIndex,
        daylight,
        hourly: hourlyData,
      };

      // Guardar en caché y purgar vencidos para acotar el Map.
      cache.set(key, { expires: Date.now() + CACHE_TTL_MS, payload });
      if (cache.size > 500) {
        const now = Date.now();
        for (const [k, v] of cache) {
          if (v.expires <= now) cache.delete(k);
        }
      }

      return json(payload);
    } catch (err) {
      const isTimeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
      return json({ error: 'No se pudo obtener el clima' }, isTimeout ? 502 : 500);
    }
  },
};
