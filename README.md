# Crete Valley GIS

Entorno local para evaluar QWC2 como visor GIS. Usa la versión LTS oficial `2026.0.31-lts`, fijada en [`upstream/qwc2`](upstream/qwc2), y conserva su configuración de demostración.

## Arranque

Requiere Git, Docker y Docker Compose.

```bash
git clone --recurse-submodules https://github.com/Mario-Gijon/cretevalleygis.git CreteValleyGIS
cd CreteValleyGIS
docker compose up --build -d
```

Abre <http://localhost:5176/?t=qwc_demo> para cargar directamente el tema de muestra. En este entorno el puerto 5175 ya está ocupado.

El frontend GIS propio está en `Frontend/` y se sirve en <http://localhost:5177>. Se inicia junto con QWC2 con el mismo comando; Vite mantiene hot reload. Para ver los registros: `docker compose logs -f`. Para detener ambos servicios: `docker compose down`.

El frontend propio usa OpenStreetMap como capa base y muestra su atribución en el mapa. Requiere Internet; el servidor público de teselas es de disponibilidad best-effort y esta configuración es para desarrollo local, no para producción.

El visor QWC2 consume su WMS de demostración y las capas OpenStreetMap y NASA GIBS; también requiere Internet. No se inicia una base de datos ni un servidor cartográfico propio en este hito.

## Licencias

QWC2 se distribuye bajo BSD-2-Clause; su licencia y atribuciones originales permanecen en [`upstream/qwc2/LICENSE`](upstream/qwc2/LICENSE). Consulta [TERCEROS.md](TERCEROS.md) para las fuentes de datos de la demo.
