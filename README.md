# Crete Valley GIS

Entorno local para evaluar QWC2 como visor GIS. Usa la versión LTS oficial `2026.0.31-lts`, fijada en [`upstream/qwc2`](upstream/qwc2), y conserva su configuración de demostración.

## Arranque

Requiere Git, Docker y Docker Compose.

```bash
git clone --recurse-submodules https://github.com/Mario-Gijon/cretevalleygis.git CreteValleyGIS
cd CreteValleyGIS
docker compose up --build -d
```

Abre <http://localhost:5176/?t=qwc_demo> para cargar directamente el tema de muestra. En este entorno el puerto 5175 ya está ocupado. Para ver los registros: `docker compose logs -f`. Para detenerlo: `docker compose down`.

El visor consume el WMS de demostración publicado por QWC2 y las capas base OpenStreetMap y NASA GIBS; necesita conexión a Internet para mostrar esos datos. No se inicia una base de datos ni se requieren servicios propios para esta demo.

## Licencias

QWC2 se distribuye bajo BSD-2-Clause; su licencia y atribuciones originales permanecen en [`upstream/qwc2/LICENSE`](upstream/qwc2/LICENSE). Consulta [TERCEROS.md](TERCEROS.md) para las fuentes de datos de la demo.
