# Hub Weather Service 🛸🌦️

Este es el microservicio de clima para la aplicación **Hub Education**, diseñado específicamente para pilotos de drones.

## 🚀 Funcionalidad
El servidor expone un endpoint que consulta la API de Open Meteo y devuelve datos climáticos simplificados y críticos para el vuelo.

### Endpoint: `/weather`
**Respuesta ejemplo:**
```json
{
  "wind_speed": 12,
  "temperature": 21
}