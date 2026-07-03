# Hub Weather Service 🛸🌦️

Microservicio de clima para la aplicación **Hub Education**, diseñado específicamente para pilotos de drones.

> Esta versión es la base del **Día 2** del roadmap de Hub Education.

---

## 📦 Instalación

```bash
npm install
```

---

## 🚀 Cómo correr el backend

### Producción — Cloudflare Worker (recomendado)

El servicio corre hosteado como **Cloudflare Worker** (`src/worker.js`, port 1:1
del server Express): gratis, sin cold starts y sin depender de una PC prendida
ni del túnel efímero de trycloudflare.

```bash
npx wrangler login    # una sola vez (abre el navegador)
npx wrangler deploy   # publica https://hub-weather.<subdominio>.workers.dev
```

Probar local sin deploy: `npx wrangler dev --port 8787 --local` y
`curl http://localhost:8787/weather`.

La app móvil apunta a la URL del Worker (`DEFAULT_API_BASE_URL` en
`hub-app/src/constants/api.ts`, o en runtime desde Preferencias → Ajustes
avanzados).

> `server.js` (Express) y `src/worker.js` (Worker) implementan el MISMO
> contrato. Si tocás la lógica de uno, replicala en el otro.

### Desarrollo local — server Express

```bash
npm start     # producción local
npm run dev   # con hot-reload
```

El servidor escucha en el puerto **3000**, enlazado a `0.0.0.0` para que sea accesible tanto desde `localhost` como desde otros dispositivos en la misma red local.

---

## 🔌 Endpoint

### `GET /weather`

Devuelve el estado del clima actual y una evaluación de vuelo para la ubicación configurada (Buenos Aires por defecto).

**URL:**
```
http://localhost:3000/weather
http://<IP-local>:3000/weather
```

**Respuesta exitosa (200):**
```json
{
  "location": {
    "lat": -34.6,
    "lon": -58.38,
    "name": "Buenos Aires"
  },
  "current": {
    "windSpeed": 12.5,
    "gusts": 18.0,
    "visibility": 24140,
    "cloudCover": 45,
    "precipitationProbability": 20,
    "temperature": 22.3
  },
  "flightAssessment": {
    "status": "SAFE",
    "reasons": []
  }
}
```

**Campos del contrato:**

| Campo | Tipo | Fuente | Notas |
|---|---|---|---|
| `location.lat` | number | fijo | -34.6 (Buenos Aires) |
| `location.lon` | number | fijo | -58.38 (Buenos Aires) |
| `location.name` | string | fijo | "Buenos Aires" |
| `current.windSpeed` | number (km/h) | Open-Meteo `current_weather.windspeed` | Tiempo real |
| `current.gusts` | number (km/h) | Open-Meteo `hourly.wind_gusts_10m` | Valor de la hora actual |
| `current.visibility` | number (metros) | Open-Meteo `hourly.visibility` | Valor de la hora actual |
| `current.cloudCover` | number (%) | Open-Meteo `hourly.cloudcover` | Valor de la hora actual |
| `current.precipitationProbability` | number (%) | Open-Meteo `hourly.precipitation_probability` | Valor de la hora actual |
| `current.temperature` | number (°C) | Open-Meteo `current_weather.temperature` | Tiempo real |

**`flightAssessment.status`** puede ser:
- `"SAFE"` — condiciones aptas para volar
- `"CAUTION"` — alguna métrica se acerca al límite
- `"DO NOT FLY"` — condiciones peligrosas

**Umbrales de evaluación:**

| Métrica | CAUTION | DO NOT FLY |
|---|---|---|
| Velocidad de viento | ≥ 25 km/h | ≥ 40 km/h |
| Ráfagas | ≥ 30 km/h | ≥ 50 km/h |
| Prob. de precipitación | ≥ 40 % | ≥ 70 % |

**Respuesta de error (500):**
```json
{
  "error": "No se pudo obtener el clima"
}
```

---

## 🛠️ Stack

- **Runtime:** Node.js
- **Framework:** Express
- **HTTP client:** Axios
- **API de clima:** [Open-Meteo](https://open-meteo.com/) (gratuita, sin API key)
