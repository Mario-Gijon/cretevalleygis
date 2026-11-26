# Crete Valley GIS

Entorno local de desarrollo con el frontend OpenLayers, QGIS Server y la demo de referencia QWC2. La imagen oficial de QGIS Server está fijada en `qgis/qgis-server:3.44.16-noble`.

## Arranque

Requiere Git, Docker y Docker Compose.

```bash
git clone --recurse-submodules https://github.com/Mario-Gijon/cretevalleygis.git CreteValleyGIS
cd CreteValleyGIS
docker compose up --build -d
```

Abre el frontend propio en <http://localhost:5177>. QGIS Server se publica localmente en <http://localhost:8085>; el frontend le consulta mediante el proxy del mismo origen `/qgis`. Si QGIS Server no responde, el mapa vuelve a OpenStreetMap y muestra un aviso no bloqueante.

La demo QWC2 permanece disponible en <http://localhost:5176/?t=qwc_demo>. Si solo quieres iniciar el frontend propio y QGIS Server, usa `docker compose up --build -d frontend qgis-server`. Vite conserva hot reload. Para ver los registros de este hito: `docker compose logs -f frontend qgis-server qgis-world-data`. Para detener el entorno: `docker compose down`.

## Mapa mundial propio

El servicio ejecuta QGIS Server `3.44.16` desde la imagen oficial de QGIS, fijada por versión y digest, con límites de 1 CPU y 1 GiB de memoria. Al iniciar, el servicio auxiliar `qgis-world-data` descarga los tres shapefiles ligeros de Natural Earth a un volumen Docker, valida sus SHA-256 fijados y genera el proyecto QGIS con estilos propios. No se versionan los datasets ni archivos de proyecto generados.

Las capas WMS son `land`, `countries` y `boundaries`, basadas en Natural Earth 1:110m. Para preparar el proyecto manualmente se puede ejecutar el script `QGIS/scripts/prepare-world.sh` dentro de la imagen oficial. El origen, las URLs de descarga y el procedimiento de preparación están declarados en `QGIS/scripts/prepare-world.py`.

Pruebas directas del servicio:

```bash
curl 'http://localhost:8085/ogc/world?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetCapabilities'
curl -o /tmp/crete-world.png 'http://localhost:8085/ogc/world?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&CRS=EPSG:3857&BBOX=-20037508,-10018754,20037508,10018754&WIDTH=1024&HEIGHT=512&LAYERS=land,countries,boundaries&STYLES=&FORMAT=image/png'
```

Natural Earth publica los datos en dominio público; la atribución es opcional y la interfaz incluye “Made with Natural Earth”. OpenStreetMap se mantiene como mapa base alternativo y requiere atribución visible. El servidor público de teselas OSM y la descarga inicial de Natural Earth requieren Internet. Esta configuración es para desarrollo local, no para producción.

## Licencias

QWC2 conserva su licencia BSD-2-Clause y atribuciones originales en [`upstream/qwc2/LICENSE`](upstream/qwc2/LICENSE). QGIS Server conserva los avisos de licencia de su imagen oficial. Consulta [TERCEROS.md](TERCEROS.md) para las licencias y fuentes de software y datos.
