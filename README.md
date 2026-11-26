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

El servicio ejecuta QGIS Server `3.44.16` desde la imagen oficial de QGIS, fijada por versión y digest, con límites de 1 CPU y 1 GiB de memoria. El servicio auxiliar `qgis-world-data` prepara únicamente los 18 conjuntos necesarios de Natural Earth: tierra, países, límites, localidades, ríos y lagos para 1:110m, 1:50m y 1:10m. Cada archivo comprimido se valida con SHA-256 antes de extraerse a un volumen Docker; no se versionan los datasets ni el proyecto generado.

El proyecto cambia de escala entre 1:110m, 1:50m y 1:10m, y QGIS gestiona los límites de visibilidad. Las etiquetas de países, ciudades, ríos y lagos usan la colocación anticolisión de QGIS. El WMS expone grupos de nombres por tema, por ejemplo `boundaries_110m,boundaries_50m,boundaries_10m` y `rivers_110m,rivers_50m,rivers_10m`.

La preparación es incremental: reutiliza los shapefiles íntegros que ya existen, valida sus componentes y actualiza `world.qgs` de forma atómica sin borrar el volumen ni sustituir datasets previos. Para volver a ejecutar la preparación sobre el volumen actual:

```bash
docker compose run --rm --no-deps qgis-world-data
docker compose restart qgis-server
```

El origen, las descargas seleccionadas, sus huellas SHA-256, estilos y procedimiento están declarados en `QGIS/scripts/prepare-world.py`.

## Relieve local

La topografía usa una tesela del **Copernicus DEM GLO-30 Public**, un modelo digital de superficie de 30 m. El producto público está disponible sin cuenta AWS en el bucket `copernicus-dem-30m`, con cobertura incompleta en algunos países. Se almacena el COG original en `terrain/source/tiles` y los GeoTIFF derivados en `terrain/derived` del volumen Docker persistente `qgis_world_data`; ningún ráster se versiona en Git. El recorte de prueba cubre el macizo del Ida en Creta, caja WGS84 `24.60,35.10,24.96,35.35`. Se descargó una tesela de 1° × 1° (14.584.365 bytes); los dos derivados ocupan aproximadamente 4,67 MB.

El script `QGIS/scripts/prepare-terrain.py` es reutilizable: recibe `--bbox oeste,sur,este,norte` y `--name`, o las variables `TERRAIN_BBOX` y `TERRAIN_AREA_NAME`. Limita cada preparación a 2° × 2° y un máximo de cuatro teselas. Conserva originales, registra ETag y SHA-256, reusa archivos válidos, recorta/reproyecta a un CRS métrico local, genera hillshade con GDAL y actualiza el proyecto QGIS de forma separada a los vectores. El ráster de elevación mantiene metros, datum vertical EGM2008 y NoData `-9999`. Como el COG público no declara NoData, se enmascaran las zonas de mar con Natural Earth 1:10m; los píxeles sin datos son transparentes y no representan 0 m. El producto es un DSM, por lo que vegetación y edificios pueden influir en la cota.

Para preparar otra zona, copia `.env.example` a `.env`, cambia el nombre y la caja, y ejecuta:

```bash
docker compose run --rm --no-deps qgis-world-data
docker compose restart qgis-server
```

La etapa de elevación reutiliza la tesela y los derivados si sus checksums y metadatos siguen válidos. Un fallo en la descarga o procesamiento topográfico no impide que se sirvan Natural Earth y el frontend. En el visor, las dos capas aparecen apagadas por defecto y tienen controles de opacidad. La leyenda usa una escala común de altitudes y profundidades.

### Copernicus DEM: licencia y atribución

GLO-30 Public se ofrece gratuitamente para el público conforme a la licencia Copernicus WorldDEM-30. La licencia permite reproducir, adaptar y comunicar el producto bajo sus condiciones; la aplicación muestra los avisos requeridos para el original y el producto derivado, así como el descargo de responsabilidad. La disponibilidad de teselas públicas no cubre todos los países.

Aviso para el original: “© DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved.”

Aviso para productos modificados: “produced using Copernicus WorldDEM-30 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved.”

Aviso de responsabilidad: “The organisations in charge of the Copernicus programme by law or by delegation do not incur any liability for any use of the Copernicus WorldDEM-30”. El servicio local de desarrollo está enlazado solo a loopback; no publica el DEM en una URL externa.

Fuentes oficiales: [producto, especificaciones y licencia](https://dataspace.copernicus.eu/explore-data/data-collections/copernicus-contributing-missions/collections-description/COP-DEM), [bucket público y acceso sin cuenta AWS](https://registry.opendata.aws/copernicus-dem/), [estructura COG](https://copernicus-dem-30m.s3.amazonaws.com/readme.html) y [licencia del GLO-30](https://dataspace.copernicus.eu/sites/default/files/media/files/2025-06/copernicus_contributing_mission_data_access_v2_cop_dem_licenses.pdf).

## Relieve mundial y resolución automática

El fallback mundial utiliza **ETOPO 2022 surface, 60 arc-seconds** de NOAA NCEI: un solo GeoTIFF de cobertura global que integra elevación terrestre y batimetría oceánica, con celdas de aproximadamente 1,85 km en el ecuador. Su CRS horizontal es WGS84 (EPSG:4326) y las alturas están referidas a EGM2008. NOAA publica el producto bajo CC0 1.0 y recomienda citarlo mediante el [DOI 10.25921/fd45-gt74](https://doi.org/10.25921/fd45-gt74); no es apto para navegación.

El GeoTIFF original se guarda separado en `terrain/global/source`; GDAL crea productos `terrain/global/derived` comprimidos, en bloques y con pirámides internas. La caché GDAL está limitada a 192 MiB y las estadísticas se procesan por bloques. En la preparación actual, el original ocupa 465.969.062 bytes y los dos derivados 746.076.156 bytes en el volumen Docker. Los rásteres no se guardan en Git. El frontend decide qué fuente pedir según `TERRAIN_VISIBILITY_THRESHOLDS` en `Frontend/src/lib/topographic-layers.ts`: ETOPO se muestra desde 800 m por píxel; Copernicus se muestra hasta 60 m por píxel si cubre al menos el 80 % de la vista. En las escalas intermedias, con cobertura insuficiente o muy cerca fuera de la zona preparada, conserva solo el mapa base. Cada casilla solicita como máximo una fuente WMS; la preferencia permanece marcada mientras la capa está temporalmente oculta. QGIS usa remuestreo bilineal solo al representar los rásteres; los GeoTIFF originales y sus valores no cambian. Las opacidades iniciales, contrastadas visualmente sobre OpenStreetMap, son 15 % para el sombreado y 10 % para la elevación.

ETOPO 60″ sirve para visualización general, no para navegación ni como dato local validado para análisis detallados. Copernicus de 30 m ofrece mayor detalle visual en el macizo del Ida, pero sigue siendo un DSM y requiere validación específica antes de un uso analítico. Los valores negativos representan batimetría; NoData permanece transparente y no se confunde con 0 m. La interfaz muestra el rango mundial de elevación y la resolución disponible. Fuentes: [NOAA ETOPO Global Relief Model](https://www.ncei.noaa.gov/products/etopo-global-relief-model) y [guía del producto](https://www.ngdc.noaa.gov/mgg/global/relief/ETOPO2022/docs/1.2%20ETOPO%202022%20User%20Guide.pdf).

Para preparar o actualizar las capas sin volver a descargar datos válidos:

```bash
docker compose run --rm --no-deps qgis-world-data
docker compose restart qgis-server
```

Pruebas directas del servicio:

```bash
curl 'http://localhost:8085/ogc/world?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetCapabilities'
curl -o /tmp/crete-world.png 'http://localhost:8085/ogc/world?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&CRS=EPSG:3857&BBOX=-20037508,-10018754,20037508,10018754&WIDTH=1024&HEIGHT=512&LAYERS=land_110m,land_50m,land_10m,countries_110m,countries_50m,countries_10m&STYLES=&FORMAT=image/png'
curl -o /tmp/crete-hillshade.png 'http://localhost:8085/ogc/world?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&CRS=EPSG:3857&BBOX=2730000,4140000,2840000,4260000&WIDTH=900&HEIGHT=700&LAYERS=terrain_hillshade&STYLES=&FORMAT=image/png&TRANSPARENT=TRUE'
curl -o /tmp/crete-elevation.png 'http://localhost:8085/ogc/world?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&CRS=EPSG:3857&BBOX=2730000,4140000,2840000,4260000&WIDTH=900&HEIGHT=700&LAYERS=terrain_elevation&STYLES=&FORMAT=image/png&TRANSPARENT=TRUE'
curl -o /tmp/world-elevation.png 'http://localhost:8085/ogc/world?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&CRS=EPSG:3857&BBOX=-20037508,-10018754,20037508,10018754&WIDTH=1024&HEIGHT=512&LAYERS=terrain_elevation_global&STYLES=&FORMAT=image/png&TRANSPARENT=TRUE'
curl -o /tmp/world-hillshade.png 'http://localhost:8085/ogc/world?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&CRS=EPSG:3857&BBOX=-20037508,-10018754,20037508,10018754&WIDTH=1024&HEIGHT=512&LAYERS=terrain_hillshade_global&STYLES=&FORMAT=image/png&TRANSPARENT=TRUE'
```

Natural Earth publica los datos en dominio público; la atribución es opcional y la interfaz incluye “Made with Natural Earth”. OpenStreetMap se mantiene como mapa base alternativo y requiere atribución visible. Las descargas iniciales de vectores y elevación requieren Internet. Esta configuración es para desarrollo local, no para producción.

## Licencias

QWC2 conserva su licencia BSD-2-Clause y atribuciones originales en [`upstream/qwc2/LICENSE`](upstream/qwc2/LICENSE). QGIS Server conserva los avisos de licencia de su imagen oficial. Consulta [TERCEROS.md](TERCEROS.md) para las licencias y fuentes de software y datos.
