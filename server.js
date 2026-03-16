const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
const PORT = 3000;

// Coordenadas fijas de Buenos Aires
const LOCATION = {
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
        const { lat, lon } = LOCATION;

        // Consultamos Open-Meteo con datos actuales y horarios adicionales.
        // current_weather provee: temperatura y velocidad de viento.
        // hourly provee: ráfagas, visibilidad, nubosidad y prob. de precipitación.
        // Nota: precipitation_probability no siempre tiene valores en tiempo real;
        //       se toma el valor de la hora más cercana al momento actual.
        const url = [
            `https://api.open-meteo.com/v1/forecast`,
            `?latitude=${lat}&longitude=${lon}`,
            `&current_weather=true`,
            `&hourly=wind_gusts_10m,visibility,cloudcover,precipitation_probability`,
            `&timezone=America%2FSao_Paulo`,
            `&forecast_days=1`
        ].join('');

        const response = await axios.get(url);
        const data = response.data;

        const cw = data.current_weather;
        const hourly = data.hourly;

        // Encontrar el índice de la hora actual en el array horario
        const currentTime = cw.time; // Ej: "2026-03-16T00:00"
        let hourIndex = hourly.time.indexOf(currentTime);
        // Si no coincide exactamente, tomamos el índice más cercano disponible
        if (hourIndex === -1) {
            hourIndex = 0;
        }

        const windSpeed   = cw.windspeed;                              // km/h
        const temperature = cw.temperature;                            // °C
        const gusts       = hourly.wind_gusts_10m[hourIndex] ?? 0;    // km/h
        const visibility  = hourly.visibility[hourIndex] ?? 0;         // metros
        const cloudCover  = hourly.cloudcover[hourIndex] ?? 0;         // %
        const precipitationProbability = hourly.precipitation_probability[hourIndex] ?? 0; // %

        const flightAssessment = calcFlightAssessment(windSpeed, gusts, precipitationProbability);

        res.json({
            location: LOCATION,
            current: {
                windSpeed,
                gusts,
                visibility,
                cloudCover,
                precipitationProbability,
                temperature
            },
            flightAssessment
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
