const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
const PORT = 3000;

// Permite que la app móvil se conecte
app.use(cors());

// Nuestro endpoint de clima
app.get('/weather', async (req, res) => {
    try {
        // Coordenadas de ejemplo (Lat/Lon)
        const lat = -34.60; 
        const lon = -58.38;

        // Llamada a la API externa de Open Meteo
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true`;
        const response = await axios.get(url);

        // Extraemos solo los datos que nos pidió el proyecto
        const { windspeed, temperature } = response.data.current_weather;

        // Respondemos al cliente con el formato simplificado
        res.json({
            wind_speed: windspeed,
            temperature: temperature
        });

    } catch (error) {
        console.error("Error:", error.message);
        res.status(500).json({ error: "No se pudo obtener el clima" });
    }
});

// Iniciar el servidor
app.listen(PORT, () => {
    console.log(`Servidor de Hub Weather corriendo en http://localhost:${PORT}`);
});