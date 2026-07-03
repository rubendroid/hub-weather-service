const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
const PORT = 3000;

// Timeout para las llamadas salientes (Open-Meteo). Sin esto, un upstream
// colgado deja el request abierto indefinidamente y agota los sockets.
const UPSTREAM_TIMEOUT_MS = 8000;

// Caché en memoria: la respuesta de clima cambia poco minuto a minuto y
// Open-Meteo tiene límites de uso. Guardamos por coordenada redondeada (~1 km)
// + altitudes pedidas, con TTL de 5 min. Es un Map simple (proceso único);
// si algún día hay varias instancias, migrar a Redis.
const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map(); // key -> { expires: number, payload: object }

const cacheKey = (lat, lon, windAlt, gustAlt) =>
    `${lat.toFixed(2)},${lon.toFixed(2)},${windAlt},${gustAlt}`;

// Coordenadas por defecto (Buenos Aires)
const DEFAULT_LOCATION = {
    lat: -34.6,
    lon: -58.38,
    name: 'Buenos Aires'
};

// Permite que la app móvil se conecte
app.use(cors());

// Endpoint principal de clima
app.get('/weather', async (req, res) => {
    try {
        // Validar coordenadas del query string. Si vienen pero no son números
        // finitos → 400 (no caer al default en silencio, que confundiría al
        // usuario mostrándole el clima de Buenos Aires). Si no vienen, default.
        let lat, lon;
        if (req.query.lat != null || req.query.lon != null) {
            lat = parseFloat(req.query.lat);
            lon = parseFloat(req.query.lon);
            if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
                return res.status(400).json({
                    error: 'Coordenadas inválidas: lat y lon deben ser números.'
                });
            }
            if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
                return res.status(400).json({
                    error: 'Coordenadas fuera de rango: lat ∈ [-90, 90], lon ∈ [-180, 180].'
                });
            }
        } else {
            lat = DEFAULT_LOCATION.lat;
            lon = DEFAULT_LOCATION.lon;
        }
        const locationName = (lat === DEFAULT_LOCATION.lat && lon === DEFAULT_LOCATION.lon)
            ? DEFAULT_LOCATION.name
            : `${lat.toFixed(2)}, ${lon.toFixed(2)}`;

        // Altitudes independientes para viento y ráfagas (en m). Clamp [0, 500].
        const clampAlt = (raw, def = 10) => {
            const v = parseFloat(raw);
            return Math.min(500, Math.max(0, Number.isFinite(v) ? v : def));
        };
        const windAlt = req.query.windAlt != null ? clampAlt(req.query.windAlt) : 10;
        const gustAlt = req.query.gustAlt != null ? clampAlt(req.query.gustAlt) : windAlt;

        // Cache hit: si hay una respuesta fresca para esta coordenada+altitudes,
        // devolverla sin pegarle a los upstreams.
        const key = cacheKey(lat, lon, windAlt, gustAlt);
        const cached = cache.get(key);
        if (cached && cached.expires > Date.now()) {
            return res.json(cached.payload);
        }

        const url = [
            `https://api.open-meteo.com/v1/forecast`,
            `?latitude=${lat}&longitude=${lon}`,
            `&current_weather=true`,
            `&hourly=wind_speed_10m,wind_speed_100m,wind_gusts_10m,visibility,cloud_cover,precipitation_probability,relative_humidity_2m`,
            `&daily=sunrise,sunset`,
            `&timezone=auto`,
            `&forecast_days=1`,
            `&models=ecmwf_ifs025`
        ].join('');

        // Hacer ambas llamadas en paralelo para mayor velocidad
        const kpPromise = axios.get(
            'https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json',
            { timeout: 3000 }
        ).catch(() => null);

        const [response, kpRes] = await Promise.all([
            axios.get(url, { timeout: UPSTREAM_TIMEOUT_MS }),
            kpPromise
        ]);

        const data = response.data;
        const cw = data.current_weather;
        const hourly = data.hourly;
        const daily = data.daily;

        // Sunrise/sunset del primer día devuelto (son strings ISO en hora local del lugar)
        let daylight;
        if (daily && Array.isArray(daily.sunrise) && Array.isArray(daily.sunset)) {
            const sunrise = daily.sunrise[0];
            const sunset  = daily.sunset[0];
            // cw.time está en la misma hora local → comparación directa string funciona
            // porque ambos siguen ISO "YYYY-MM-DDTHH:MM" y lexicográficamente ordenan bien.
            const nowLocal = cw.time;
            const isDaylight = sunrise && sunset && nowLocal >= sunrise && nowLocal < sunset;
            daylight = { sunrise, sunset, isDaylight };
        }

        const currentTime = cw.time;
        let hourIndex = hourly.time.indexOf(currentTime);
        if (hourIndex === -1) {
            hourIndex = 0;
        }

        // Viento a distintas alturas (modelo ECMWF: 10m y 100m)
        const wind10  = hourly.wind_speed_10m[hourIndex] ?? cw.windspeed;        // km/h
        const wind100 = hourly.wind_speed_100m[hourIndex] ?? wind10;             // km/h
        // Interpolación LINEAL entre 10 m y 100 m, con clamp en los extremos.
        // Es una aproximación: el perfil real de viento es logarítmico/potencial
        // (crece rápido cerca del suelo y se aplana arriba), así que la lineal
        // subestima un poco entre 10 y 100 m. Suficiente para el rango de vuelo
        // de drones (0–122 m) y evita pedir más niveles al modelo. Por debajo de
        // 10 m se asume el valor de 10 m (no extrapolamos hacia el suelo).
        const interp  = (alt) => {
            if (alt <= 10) return wind10;
            if (alt >= 100) return wind100;
            const t = (alt - 10) / 90;
            return wind10 + (wind100 - wind10) * t;
        };
        const windSpeed   = Math.round(interp(windAlt) * 10) / 10;               // km/h a la altura pedida
        const temperature = cw.temperature;                                      // °C
        const gust10      = hourly.wind_gusts_10m[hourIndex] ?? 0;              // km/h (base)
        // Escalar ráfagas proporcionalmente al viento a la altura propia de ráfagas
        const gustScale   = wind10 > 0 ? interp(gustAlt) / wind10 : 1;
        const gusts       = Math.round(gust10 * gustScale * 10) / 10;           // km/h
        const visibility  = hourly.visibility[hourIndex] ?? 0;                   // metros
        const cloudCover  = hourly.cloud_cover[hourIndex] ?? 0;                  // %
        const precipitationProbability = hourly.precipitation_probability[hourIndex] ?? 0; // %
        const humidity    = hourly.relative_humidity_2m[hourIndex] ?? 0;          // %

        // Datos crudos horarios con viento y ráfagas ya escalados a las altitudes pedidas.
        // Evaluación de vuelo se calcula en el frontend para respetar los umbrales del usuario.
        const hourlyData = hourly.time.map((hour, i) => {
            const w10  = hourly.wind_speed_10m[i] ?? 0;
            const w100 = hourly.wind_speed_100m[i] ?? w10;
            const interpH = (alt) => {
                if (alt <= 10) return w10;
                if (alt >= 100) return w100;
                const t = (alt - 10) / 90;
                return w10 + (w100 - w10) * t;
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

        // Procesar resultado de Kp. Formato NOAA: arreglo de objetos
        // { time_tag, kp, observed, noaa_scale }. Cada entrada describe una
        // ventana de 3 h que arranca en time_tag. Elegimos la entrada
        // observed/estimated cuya ventana contenga el momento actual (o la
        // más reciente previa a "ahora").
        let kpIndex;
        if (kpRes && Array.isArray(kpRes.data) && kpRes.data.length > 0) {
            const nowMs = Date.now();
            let latest;
            for (let i = kpRes.data.length - 1; i >= 0; i--) {
                const entry = kpRes.data[i];
                if (!entry || typeof entry !== 'object') continue;
                const status = entry.observed;
                if (status !== 'observed' && status !== 'estimated') continue;
                // Interpretar time_tag como UTC (NOAA siempre lo publica en UTC)
                const tMs = Date.parse(`${entry.time_tag}Z`);
                if (!Number.isFinite(tMs)) continue;
                if (tMs <= nowMs) {
                    latest = entry;
                    break;
                }
            }
            if (latest) {
                kpIndex = {
                    value: parseFloat(latest.kp),
                    updatedAt: latest.time_tag
                };
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
                humidity
            },
            kpIndex,
            daylight,
            hourly: hourlyData
        };

        // Guardar en caché (TTL 5 min) y purgar entradas vencidas para que el
        // Map no crezca sin techo con coordenadas de un solo uso.
        cache.set(key, { expires: Date.now() + CACHE_TTL_MS, payload });
        if (cache.size > 500) {
            const now = Date.now();
            for (const [k, v] of cache) {
                if (v.expires <= now) cache.delete(k);
            }
        }

        res.json(payload);

    } catch (error) {
        console.error('Error al obtener el clima:', error.message);
        // Un timeout/red caída del upstream es un 502 (gateway), no un 500 genérico.
        const isUpstream = error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT'
            || error.response != null;
        res.status(isUpstream ? 502 : 500).json({ error: 'No se pudo obtener el clima' });
    }
});

// Escuchar en 0.0.0.0 para ser accesible en red local
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Hub Weather Service corriendo en http://0.0.0.0:${PORT}`);
    console.log(`Accede localmente en  http://localhost:${PORT}/weather`);
});
