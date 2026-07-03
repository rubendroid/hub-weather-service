# Parámetros del clima — Flujo de datos

Documento explicando de dónde viene y cómo se procesa cada parámetro meteorológico que ve el piloto en la app.

## Arquitectura general

```
┌──────────────┐     ┌──────────────────┐     ┌────────────────────┐
│   Hub App    │ ──▶ │ hub-weather-svc  │ ──▶ │ APIs externas      │
│  (Expo RN)   │ ◀── │  (Node/Express)  │ ◀── │ Open-Meteo + NOAA  │
└──────────────┘     └──────────────────┘     └────────────────────┘
      │                      │
      │ GET /weather         │ combina, transforma, calcula
      │ ?lat=&lon=           │ y devuelve un único JSON
      │ &windAlt=&gustAlt=   │
      ▼                      ▼
```

El backend actúa como **agregador y procesador**: hace 2 llamadas en paralelo (pronóstico meteorológico + clima espacial), combina los datos, calcula estado de vuelo y devuelve una única respuesta lista para renderizar.

---

## APIs externas

### 1. Open-Meteo — pronóstico meteorológico

- **URL**: `https://api.open-meteo.com/v1/forecast`
- **Modelo**: `ecmwf_ifs025` (ECMWF Integrated Forecast System, resolución 0.25°)
- **Por qué este modelo**: es el mismo que usan Windy y UAV Forecast como fuente principal; es el estándar de la industria aeronáutica.
- **Actualización**: 4 veces al día (00, 06, 12, 18 UTC).
- **Gratis, sin API key, sin límite práctico** para uso personal.

### 2. NOAA SWPC — clima espacial (Kp)

- **URL**: `https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json`
- **Qué mide**: el índice Kp planetario, un número 0-9 que mide perturbaciones del campo magnético terrestre.
- **Por qué importa para drones**: Kp alto → GPS degradado → drone puede desviarse o perder señal.
- **Actualización**: cada 3 horas.
- **Formato**: array de objetos `{ time_tag, kp, observed, noaa_scale }`. Cada entrada representa una ventana de 3 horas que arranca en `time_tag`.

---

## Parámetros uno por uno

### Ubicación (`location`)

| Paso | Qué pasa |
|------|----------|
| Frontend | `expo-location` pide GPS al celu (timeout 3s). Si el usuario niega o no hay GPS, `lat`/`lon` quedan sin definir. |
| Request | Si tiene coords, las manda como `?lat=&lon=`. Si no, el backend usa default (Buenos Aires: -34.6, -58.38). |
| Backend | Arma `name`: si son las default → "Buenos Aires"; si no → `"{lat}, {lon}"` redondeado a 2 decimales. |
| Response | `{ location: { lat, lon, name } }` |

### Viento (`windSpeed`)

| Paso | Qué pasa |
|------|----------|
| Fuente | Open-Meteo ECMWF — hourly `wind_speed_10m` y `wind_speed_100m` (solo estas 2 alturas están disponibles en ECMWF). |
| Altitud | El usuario elige altitud en config (0-500m). Se manda como `?windAlt=`. |
| Procesamiento | Interpolación lineal entre 10m y 100m. Por debajo de 10m → viento a 10m. Por arriba de 100m → viento a 100m (no extrapola). |
| Unidades | Open-Meteo devuelve en **km/h** por default. Redondeo a 1 decimal. |
| Frontend | `fmtSpeed()` convierte a la unidad elegida (km/h, m/s, kt) según `settings.speedUnit`. |
| UI | `WeatherMetricCard` con barra de progreso contra `settings.windMax`. |

### Ráfagas (`gusts`)

| Paso | Qué pasa |
|------|----------|
| Fuente | Open-Meteo ECMWF — hourly `wind_gusts_10m`. **Los modelos solo calculan ráfagas a 10m** (son un fenómeno de capa límite). |
| Altitud | El usuario elige por separado (`?gustAlt=`). Si no la manda, usa la misma que `windAlt`. |
| Procesamiento | Se escalan proporcionalmente al viento: `gust_alt = gust_10m × (wind_alt / wind_10m)`. Es una aproximación razonable (las ráfagas siguen aproximadamente el perfil vertical del viento). |
| Nota | Es una **estimación**, no un dato nativo del modelo. Físicamente correcto como orden de magnitud. |
| Frontend | Igual que viento: `fmtSpeed()` + card con umbral `gustsMax`. |

### Temperatura (`temperature`)

| Paso | Qué pasa |
|------|----------|
| Fuente | Open-Meteo `current_weather.temperature` — medición a 2m (estándar meteorológico). |
| Unidades | Open-Meteo devuelve en **°C**. |
| Frontend | `fmtTemp()` convierte a °C o °F según `settings.tempUnit`. |
| UI | Card con rango `tempMin` / `tempMax`. |

### Humedad (`humidity`)

| Paso | Qué pasa |
|------|----------|
| Fuente | Open-Meteo hourly `relative_humidity_2m` — humedad relativa a 2m. |
| Unidades | Porcentaje (0-100). |
| Frontend | Se muestra directo en `%`. Sin umbral configurable (es informativo). |

### Visibilidad (`visibility`)

| Paso | Qué pasa |
|------|----------|
| Fuente | Open-Meteo hourly `visibility` — en **metros**. |
| Frontend | `fmtDist()` convierte a km o millas según `settings.distUnit`. |
| UI | Card con umbral mínimo `visMin`. |

### Cobertura de nubes (`cloudCover`)

| Paso | Qué pasa |
|------|----------|
| Fuente | Open-Meteo hourly `cloud_cover` — fracción del cielo cubierto. |
| Unidades | Porcentaje (0-100). |
| Frontend | Se muestra directo. Card con umbral máximo `cloudsMax`. |

### Probabilidad de precipitación (`precipitationProbability`)

| Paso | Qué pasa |
|------|----------|
| Fuente | Open-Meteo hourly `precipitation_probability`. |
| Unidades | Porcentaje (0-100). |
| Frontend | Card con umbral máximo `rainMax`. |

### Índice Kp (`kpIndex`)

| Paso | Qué pasa |
|------|----------|
| Fuente | NOAA SWPC planetary K-index forecast. |
| Filtrado | Se descartan entradas `predicted`. Solo se usan `observed` / `estimated`. |
| Selección temporal | Se toma la entrada cuya ventana de 3h contiene el momento actual. Es decir, la entrada más reciente con `time_tag <= now`. Esto **coincide con UAV Forecast** (antes tomábamos la última entrada absoluta → salía 0.33 más alto). |
| Fallback | Si la llamada a NOAA falla o da timeout (3s), `kpIndex` sale `undefined` y el frontend oculta la tarjeta. |
| Response | `{ value: number, updatedAt: string(ISO UTC) }`. |
| Frontend | `KpIndexCard` con barra de 10 segmentos + tag de color: verde (≤ `kpMax`), amarillo (> `kpMax`), rojo (> `kpMax × 1.5` o ≥ 5). |

---

## Evaluación de vuelo (calculada en el frontend)

Se calcula en `src/utils/units.ts → assessFlight(...)` usando los **umbrales del usuario** (`PilotSettings`):

| Parámetro | CAUTION | DO NOT FLY |
|-----------|---------|------------|
| Viento | > `windMax` | > `windMax × 1.5` |
| Ráfagas | > `gustsMax` | > `gustsMax × 1.5` |
| Precipitación | > `rainMax` | > `rainMax × 1.5` |
| Kp | > `kpMax` | ≥ 5 (fijo, corresponde a tormenta geomagnética) |

Se toma el **peor de los cuatro**. Devuelve `{ status, reasons }` con los mensajes formateados en las unidades elegidas (km/h, m/s o kt).

El resultado se recalcula en memoria cada vez que cambian los datos o las settings (via `useMemo` en `WeatherScreen`), sin nuevas llamadas al backend.

---

## Ventanas de vuelo horarias

El backend devuelve `hourly: [{ hour, windSpeed, gusts, precipitationProbability }]` con viento y ráfagas **ya ajustados** a `windAlt` y `gustAlt`. El frontend mapea cada entrada llamando a `assessFlight(...)` con los umbrales del usuario y el Kp actual, produciendo la barra de colores por hora.

Ventaja: al cambiar un umbral (o las unidades) la barra se repinta al instante sin hacer fetch.

---

## Validación en el frontend

`weatherService.ts` valida la forma de la respuesta con type guards antes de usarla. Si la respuesta no cumple:

- Obligatorios → `location.{lat,lon,name}`, `current.*`, `flightAssessment.{status,reasons}`.
- Opcionales (validados solo si vienen) → `kpIndex.{value,updatedAt}`, `flightWindows[]`.

Si algo falla, el hook `useWeather` captura el error y lo expone como `error` string; la UI muestra mensaje genérico.

---

## Flujo de recarga

Se llama a `GET /weather` cuando:

1. **Monta la app** (primera carga).
2. **Pull-to-refresh** en la pantalla principal.
3. **El usuario cambia `windAlt` o `gustAlt`** (el hook los tiene en sus dependencias → recarga automática).

Los cambios en otros settings (unidades, umbrales) **no disparan fetch** — se aplican solo al render.

---

## Resumen: qué API da qué

| Parámetro | API | Campo original |
|-----------|-----|----------------|
| Ubicación | GPS del celular (Expo) | — |
| Viento | Open-Meteo ECMWF | `wind_speed_10m`, `wind_speed_100m` |
| Ráfagas | Open-Meteo ECMWF | `wind_gusts_10m` (solo 10m) |
| Temperatura | Open-Meteo ECMWF | `current_weather.temperature` |
| Humedad | Open-Meteo ECMWF | `relative_humidity_2m` |
| Visibilidad | Open-Meteo ECMWF | `visibility` |
| Nubes | Open-Meteo ECMWF | `cloud_cover` |
| Precipitación | Open-Meteo ECMWF | `precipitation_probability` |
| Kp | NOAA SWPC | `kp` (entrada `observed`/`estimated` actual) |
| Flight assessment | Calculado en frontend | viento + ráfagas + precipitación + Kp, umbrales del usuario |
| Flight windows | Calculado en frontend a partir de `hourly` del backend | idem, por hora |
