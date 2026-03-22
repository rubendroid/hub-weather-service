const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
const PORT = 3000;

// Coordenadas por defecto (Buenos Aires)
const DEFAULT_LOCATION = {
    lat: -34.6,
    lon: -58.38,
    name: 'Buenos Aires'
};

// Umbrales para evaluación de vuelo (en km/h y %)
const THRESHOLDS = {
    windSpeed: { caution: 25, doNotFly: 40 },
    gusts:     { caution: 30, doNotFly: 50 },
    precipitation: { caution: 40, doNotFly: 70 }
};

// Permite que la app móvil se conecte
app.use(cors());

/**
 * Calcula el estado de vuelo basado en viento, ráfagas y precipitación.
 * @param {number} windSpeed  - Velocidad de viento en km/h
 * @param {number} gusts      - Ráfagas en km/h
 * @param {number} precip     - Probabilidad de precipitación en %
 * @returns {{ status: string, reasons: string[] }}
 */
function calcFlightAssessment(windSpeed, gusts, precip) {
    const reasons = [];
    let worstLevel = 0; // 0=SAFE, 1=CAUTION, 2=DO NOT FLY

    if (windSpeed >= THRESHOLDS.windSpeed.doNotFly) {
        reasons.push(`Viento muy alto (${windSpeed} km/h)`);
        worstLevel = 2;
    } else if (windSpeed >= THRESHOLDS.windSpeed.caution) {
        reasons.push(`Viento elevado (${windSpeed} km/h)`);
        if (worstLevel < 1) worstLevel = 1;
    }

    if (gusts >= THRESHOLDS.gusts.doNotFly) {
        reasons.push(`Ráfagas muy peligrosas (${gusts} km/h)`);
        worstLevel = 2;
    } else if (gusts >= THRESHOLDS.gusts.caution) {
        reasons.push(`Ráfagas considerables (${gusts} km/h)`);
        if (worstLevel < 1) worstLevel = 1;
    }

    if (precip >= THRESHOLDS.precipitation.doNotFly) {
        reasons.push(`Alta probabilidad de precipitación (${precip}%)`);
        worstLevel = 2;
    } else if (precip >= THRESHOLDS.precipitation.caution) {
        reasons.push(`Probabilidad moderada de precipitación (${precip}%)`);
        if (worstLevel < 1) worstLevel = 1;
    }

    const statusMap = ['SAFE', 'CAUTION', 'DO NOT FLY'];
    return { status: statusMap[worstLevel], reasons };
}

// Endpoint principal de clima
app.get('/weather', async (req, res) => {
    try {
        // Usar coordenadas del query string si se envían, sino las por defecto
        const lat = req.query.lat != null ? parseFloat(req.query.lat) : DEFAULT_LOCATION.lat;
        const lon = req.query.lon != null ? parseFloat(req.query.lon) : DEFAULT_LOCATION.lon;
        const locationName = (lat === DEFAULT_LOCATION.lat && lon === DEFAULT_LOCATION.lon)
            ? DEFAULT_LOCATION.name
            : `${lat.toFixed(2)}, ${lon.toFixed(2)}`;

        const url = [
            `https://api.open-meteo.com/v1/forecast`,
            `?latitude=${lat}&longitude=${lon}`,
            `&current_weather=true`,
            `&hourly=wind_gusts_10m,visibility,cloud_cover,precipitation_probability,relative_humidity_2m`,
            `&timezone=auto`,
            `&forecast_days=1`
        ].join('');

        // Hacer ambas llamadas en paralelo para mayor velocidad
        const kpPromise = axios.get(
            'https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json',
            { timeout: 3000 }
        ).catch(() => null);

        const [response, kpRes] = await Promise.all([
            axios.get(url),
            kpPromise
        ]);

        const data = response.data;
        const cw = data.current_weather;
        const hourly = data.hourly;

        const currentTime = cw.time;
        let hourIndex = hourly.time.indexOf(currentTime);
        if (hourIndex === -1) {
            hourIndex = 0;
        }

        const windSpeed   = cw.windspeed;                                        // km/h
        const temperature = cw.temperature;                                      // °C
        const gusts       = hourly.wind_gusts_10m[hourIndex] ?? 0;              // km/h
        const visibility  = hourly.visibility[hourIndex] ?? 0;                   // metros
        const cloudCover  = hourly.cloud_cover[hourIndex] ?? 0;                  // %
        const precipitationProbability = hourly.precipitation_probability[hourIndex] ?? 0; // %
        const humidity    = hourly.relative_humidity_2m[hourIndex] ?? 0;          // %

        const flightAssessment = calcFlightAssessment(windSpeed, gusts, precipitationProbability);

        // Generar ventanas de vuelo horarias
        const flightWindows = hourly.time.map((hour, i) => {
            const g  = hourly.wind_gusts_10m[i] ?? 0;
            const pp = hourly.precipitation_probability[i] ?? 0;
            const assessment = calcFlightAssessment(g, g, pp);
            return { hour, status: assessment.status };
        });

        // Procesar resultado de Kp
        let kpIndex;
        if (kpRes && Array.isArray(kpRes.data) && kpRes.data.length > 1) {
            const latest = kpRes.data[kpRes.data.length - 1];
            kpIndex = {
                value: parseFloat(latest[1]),
                updatedAt: latest[0]
            };
        }

        res.json({
            location: { lat, lon, name: locationName },
            current: {
                windSpeed,
                gusts,
                visibility,
                cloudCover,
                precipitationProbability,
                temperature,
                humidity
            },
            flightAssessment,
            kpIndex,
            flightWindows
        });

    } catch (error) {
        console.error('Error al obtener el clima:', error.message);
        res.status(500).json({ error: 'No se pudo obtener el clima' });
    }
});

// Escuchar en 0.0.0.0 para ser accesible en red local
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Hub Weather Service corriendo en http://0.0.0.0:${PORT}`);
    console.log(`Accede localmente en  http://localhost:${PORT}/weather`);
});
