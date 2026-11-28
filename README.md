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

El contenedor Vite ejecuta con el UID/GID del host para que los archivos de `Frontend/dist` sigan siendo editables. El valor predeterminado es `1000:1000`; si tu usuario usa otros identificadores, define `HOST_UID` y `HOST_GID` en `.env` antes de arrancar Compose.

## Mapas base y datos de análisis

El selector incluye **Minimalista** (OpenFreeMap Positron, inicial), **Oscuro** (Dark), **Detallado** (Liberty), OpenStreetMap y Crete Valley GIS (QGIS). OpenFreeMap usa `ol-mapbox-style` sobre la instancia OpenLayers existente; los estilos y sus recursos vectoriales se cargan al elegir cada estilo, sin clave de API. Si falla la carga, el visor vuelve a OpenStreetMap y muestra un aviso sin bloquear las herramientas.

Las atribuciones de los mapas se muestran en el control del mapa y en el panel: [OpenFreeMap](https://openfreemap.org/), [OpenMapTiles](https://openmaptiles.org/) y [OpenStreetMap](https://www.openstreetmap.org/copyright) para los estilos vectoriales; OpenStreetMap para su mapa base; Natural Earth para QGIS. Consulta [OpenFreeMap Quick Start](https://openfreemap.org/quick_start/) y la [documentación de `ol-mapbox-style`](https://openlayers.org/ol-mapbox-style/). Los mapas base son únicamente para visualización: los futuros criterios deberán calcularse con los datos geográficos originales, nunca leyendo los colores de teselas renderizadas.

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

El script `QGIS/scripts/prepare-terrain.py` es reutilizable: recibe `--bbox oeste,sur,este,norte` y `--name`, o las variables `TERRAIN_BBOX` y `TERRAIN_AREA_NAME`. Limita cada preparación a 4° por lado, 16 teselas y 30 millones de píxeles proyectados a 30 m; comprueba los tres límites antes de descargar. Los límites se pueden ajustar con `TERRAIN_MAX_SPAN_DEGREES`, `TERRAIN_MAX_TILES` y `TERRAIN_MAX_RASTER_PIXELS`. El trabajo tiene un límite predeterminado de 30 minutos (`TERRAIN_JOB_TIMEOUT_SECONDS`); al expirar o fallar libera el único espacio de trabajo activo. Conserva originales, registra ETag y SHA-256, reusa archivos válidos, recorta/reproyecta a un CRS métrico local, genera hillshade con GDAL y actualiza el proyecto QGIS de forma separada a los vectores. El ráster de elevación mantiene metros, datum vertical EGM2008 y NoData `-9999`. Como el COG público no declara NoData, se enmascaran las zonas de mar con Natural Earth 1:10m; los píxeles sin datos son transparentes y no representan 0 m. El producto es un DSM, por lo que vegetación y edificios pueden influir en la cota.

Para preparar otra zona, copia `.env.example` a `.env`, cambia el nombre y la caja, y ejecuta:

```bash
docker compose run --rm --no-deps qgis-world-data
docker compose restart qgis-server
```

La etapa de elevación reutiliza la tesela y los derivados si sus checksums y metadatos siguen válidos. Un fallo en la descarga o procesamiento topográfico no impide que se sirvan Natural Earth y el frontend. En el visor, las dos capas aparecen apagadas por defecto y tienen controles de opacidad. ETOPO conserva la escala absoluta mundial; cada terreno Copernicus usa una escala adaptativa regional con paleta interpolada y leyenda recibida del backend. Las escalas regionales no son comparables directamente entre zonas. Los valores NoData permanecen transparentes.

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

### Relieve de exploración Mapzen

La topografía de exploración de todo el mapa utiliza las teselas [Mapzen Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) en AWS Open Data, servidas en formato Terrarium (`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png`). Cada tesela PNG de 256 × 256 píxeles codifica elevaciones en metros mediante `256 × R + G + B/256 − 32768`. Es un mosaico de fuentes abiertas con resoluciones y coberturas variables; la disponibilidad hasta zoom 15 no implica que todos los lugares tengan el mismo detalle. La aplicación conserva como atribución visible el enlace de [fuentes y créditos de Tilezen/Mapzen](https://github.com/tilezen/joerd/blob/master/docs/attribution.md), con las condiciones de los proveedores incluidos.

### Visor interactivo 3D

El selector **2D | 3D** abre un visor MapLibre GL JS `6.20.0` cargado de forma diferida. OpenLayers sigue siendo el motor principal y conserva su instancia, herramientas, geometrías y análisis: al activar 3D se desacopla temporalmente su destino de renderizado y se vuelve a conectar al regresar. Cada transición lee la cámara del visor que está activo; el centro y la escala aproximada pasan entre motores con la conversión de zoom correspondiente (MapLibre usa teselas mundiales de 512 px y OpenLayers de 256 px). Al entrar en 3D se usa siempre el centro y zoom actuales de 2D, conservando el rumbo e inclinación 3D previos. Al salir, el centro y la escala 3D se aplican a OpenLayers; rumbo e inclinación quedan guardados para la siguiente entrada. **Volver a Creta** restablece además centro, zoom, rumbo norte e inclinación.

El visor ofrece los estilos vectoriales OpenFreeMap **Minimalista**, **Detallado** y **Oscuro**, navegación, zoom, giro, inclinación, restablecimiento de norte/perspectiva y exageración vertical ajustable (1× por defecto). La exageración cambia solo la presentación. MapLibre comparte la fuente y la caché de decodificación de Terrarium ya usada por el mapa 2D. Como MapLibre interpreta el RGB y no usa alfa como máscara DEM, el adaptador solicita como máximo z15, detecta los píxeles negros RGB `0,0,0` como NoData y completa huecos con hasta tres niveles de teselas padre geográficamente correspondientes. Solo entrega teselas opacas completamente válidas; si aún hay huecos, omite la tesela sin inventar cotas y comunica la cobertura en el visor. Las cancelaciones de solicitudes que MapLibre descarta al mover o cambiar el estilo no se presentan como errores. La cobertura y resolución de Mapzen varían por región; estas superficies son de exploración visual y no sustituyen los datos preparados para análisis.

En la vista 3D se ocultan temporalmente las herramientas 2D que no están implementadas sobre el terreno. Los dibujos y análisis se mantienen en memoria y reaparecen al volver a OpenLayers. La interfaz indica fallos de WebGL o falta de elevación; sigue siendo posible regresar al modo 2D.

Las geometrías de sesión se derivan de `useDrawingTools` como GeoJSON WGS84 hacia una única fuente GeoJSON de MapLibre. Capas nativas de relleno, contorno, línea y punto se dibujan sobre el terreno; Polygon, MultiPolygon y sus huecos conservan las coordenadas originales. Actualizar, seleccionar o renombrar elementos solo actualiza esa fuente; al cambiar estilo, MapLibre restaura una vez las capas y recibe los datos más recientes. Un clic selecciona el ID compartido y abre su ficha sin mover la cámara; localizar desde la lista encuadra toda la extensión y conserva rumbo e inclinación. Si hay geometrías superpuestas, se prioriza punto, línea y después superficie; entre superficies gana la creada más recientemente. Las vistas previas de buffers, perfiles y operaciones geométricas requieren volver a 2D. La elevación 3D es solo una visualización exploratoria: no cambia ni recalcula las mediciones o análisis derivados de Copernicus.

El selector conserva cinco mapas base convencionales y agrupa bajo **Mapas topográficos** tres opciones directas: **Elevación**, **Pendientes** y **Orientación de laderas**. Cada una combina el estilo vectorial Positron con esta misma fuente y capa WebGL, de modo que carreteras y nombres siguen visibles. La sección de topografía aparece únicamente con una de esas tres vistas. Las preferencias de relieve sombreado y modo de elevación se conservan al cambiar de mapa; la selección temática guardada por versiones anteriores se migra a la vista equivalente. ETOPO se pausa para evitar duplicar el relieve.

El sombreado (30 %) se mantiene independiente de la representación temática, que empieza en elevación (70 %); ambos pueden combinarse. Al elegir otro mapa base, la capa WebGL se desactiva sin perder la selección. OpenLayers procesa la fuente en una única capa `WebGLTile`; cuando hay una representación temática, la iluminación modula suavemente sus colores. El sombreado usa exageración vertical 1,1×, con iluminación a 45° de elevación y 315° de azimut. Los valores y el relieve se estiman al representar; los valores numéricos originales no se alteran.

La escala predeterminada es **absoluta**: mantiene una correspondencia fija entre altitud y color, independiente del zoom y la región. La rampa terrestre continua usa 0 m `#367d53`, 250 m `#7fa65e`, 500 m `#b6bc75`, 1.000 m `#d4b87b`, 1.500 m `#b28a64`, 2.500 m `#906b64`, 4.000 m `#765470` y 9.000 m `#523a69`. La escala oceánica independiente pasa de `#092e53` a −11.000 m por `#145d8b` a −8.000 m, `#3d91af` a −4.000 m y `#79b2ad` a −2.000 m, y enlaza suavemente con el verde terrestre a 0 m. La leyenda reutiliza esos puntos y posiciones no lineales. Las teselas Terrarium codifican solo una cota, no una máscara de costa: las depresiones terrestres bajo el nivel del mar pueden tomar tonos de la rampa oceánica (por ejemplo, alrededor del mar Muerto), y no se pueden clasificar con certeza sin datos adicionales de tierra/agua. Las teselas transparentes permanecen transparentes.

El modo **adaptativo regional** sigue disponible como opción. Al activarlo o solicitar «Recalcular», muestrea una cuadrícula de 12 × 12 puntos de las teselas visibles ya cargadas, calcula los percentiles 5 y 95 de las cotas no negativas y fija ese rango hasta que se solicite otro cálculo. Requiere al menos 180 muestras y aplica un rango mínimo de 400 m para zonas llanas; si los datos son insuficientes, vuelve a la paleta absoluta y permite reintentar después de cargar más teselas. La leyenda identifica valores inferiores o superiores al rango. La caché de muestreo se limita a 96 teselas y 12 × 12 valores por tesela.

Las tres vistas topográficas se representan desde el zoom mínimo del visor (2) hasta el nivel de datos disponible (15). Las vistas mundiales se calculan con las teselas de baja resolución correspondientes y se indican como generalizadas; no se fuerza contraste artificial. Al acercar, se solicitan niveles progresivamente más detallados. No hay precarga: se reutiliza una única fuente y capa WebGL, y la caché queda limitada a 96 teselas. Los umbrales, las clases, la paleta, la escala y los parámetros de sombreado están centralizados en `Frontend/src/lib/exploration-terrain.ts`.

Las derivadas usan clases fijas: pendiente = 100 × módulo del gradiente central, en rangos 0–5, >5–15, >15–30, >30–60 y >60 %, con los colores compartidos con QGIS. La orientación es el azimut de descenso, en grados desde el norte en sentido horario, con ocho categorías cardinales; las superficies de hasta 0,1 % se marcan «plana / sin orientación». Ambas se calculan también desde zoom 2 con la resolución efectiva de la tesela seleccionada, limitada a z15, y se convierten a distancia terrestre con el coseno de la latitud de la vista. El sobremuestreo por encima de z15 no aumenta artificialmente la pendiente. Como Terrarium no contiene máscara tierra/agua, la derivada solo se muestra cuando el centro y sus cuatro vecinos tienen elevación positiva: esto oculta batimetría, pero también puede ocultar depresiones terrestres bajo el nivel del mar y algunos píxeles costeros. Las muestras próximas a bordes de tesela pueden producir pequeñas discontinuidades. Los resultados son visuales, varían con la resolución de origen y no sustituyen rásteres numéricos validados para criterios del DSS.

Esta capa sirve para explorar, no para mediciones ni análisis objetivos. Cuando el relieve está visible, el sombreado general ETOPO se oculta para no duplicar sombras. En los modos de capas independientes, un hillshade preparado pausa Mapzen; con cualquiera de las tres vistas topográficas, Mapzen permanece debajo del terreno preparado y visible fuera de su polígono. Al cerrar el terreno, la preferencia independiente se reactiva automáticamente. Los terrenos Copernicus y sus derivados analíticos conservan su estado independiente. Si falla WebGL o el acceso a teselas, permanecen disponibles el mapa base vectorial (con OpenStreetMap como respaldo) y las herramientas.

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

## Inspector de puntos

La herramienta **Inspeccionar** consulta elevación al pulsar el mapa y mantiene un único marcador temporal, independiente del mapa base. Reutiliza la fuente, decodificación numérica, máscara de validez y caché Terrarium del relieve; empieza por z15 sin depender del zoom visible y busca hasta tres niveles padre (como mínimo z12) cuando falten muestras. La elevación se interpola solo con píxeles válidos. Pendiente y azimut de descenso usan diferencias centrales entre vecinos y el espaciado terrestre del píxel, corregido por latitud. Si no hay vecinos válidos, se muestra la elevación sin inventar derivadas; los píxeles NoData, los errores del servicio y las coordenadas fuera de Web Mercator se distinguen. El espaciado mostrado es nominal para la tesela consultada y no garantiza la resolución nativa de sus fuentes. El resultado es exploratorio: no crea geometrías permanentes ni trabajos zonales y no sustituye el análisis Copernicus de áreas.

## Perfiles de elevación

En la ficha de una línea dibujada se puede generar y volver a abrir su perfil. El muestreo geodésico recorre cada segmento e incluye todos los vértices; limita cada perfil a 500 muestras, 64 solicitudes nuevas de teselas y cuatro consultas simultáneas. Reutiliza la caché Terrarium compartida con el relieve y el inspector. La gráfica muestra recorrido, cotas inicial y final, mínimo, máximo, media ponderada por distancia, relieve máximo, ascenso, descenso y cobertura. Los tramos sin datos quedan como interrupciones: no se interpolan ni se suman a través de huecos. Al señalar una muestra en la gráfica, un marcador temporal señala su posición en el mapa.

Estos perfiles son exploratorios y dependen de la separación de muestreo y de las teselas [Mapzen Terrain Tiles](https://registry.opendata.aws/terrain-tiles/). El tamaño nominal de píxel de una tesela no garantiza la resolución nativa de sus fuentes. Los resultados se mantienen en memoria durante la sesión, asociados al identificador y revisión geométrica de la línea; modificar o eliminar esa línea invalida solo su perfil. No se crean trabajos en el backend ni se modifican los datos de terreno preparados para análisis zonales.

## Buscador geográfico

El endpoint local `GET /api/search/places?q=Jaén` busca en los shapefiles Natural Earth 1:10m que ya existen en el volumen `qgis_world_data`: `admin_0_countries` (258 países y territorios) y `populated_places` (7.342 localidades en la copia preparada). El backend crea una sola vez por proceso un índice en memoria mediante GDAL/OGR y reutiliza los nombres normalizados en las peticiones. Considera los campos `NAME`, `NAMEASCII`, `NAMEPAR`, `NAMEALT`, `NAME_EN`, `NAME_ES` y, cuando existen, las traducciones griegas y francesas; países y localidades tienen identificadores Natural Earth estables. Los resultados incluyen tipo, país, región, coordenadas WGS84, extensión de países y fuente. La consulta admite de 2 a 80 caracteres y devuelve como máximo diez coincidencias, ordenadas por coincidencia exacta, prefijo y fragmento.

El campo del frontend también acepta coordenadas decimales `latitud, longitud` o `latitud longitud`, por ejemplo `37.7796, -3.7849`. Las coordenadas se validan y navegan localmente, no llaman a la API. El servicio no consulta proveedores externos ni crea marcadores permanentes.

Natural Earth es una cartografía generalizada: este catálogo no contiene calles, direcciones ni todas las poblaciones pequeñas, y no garantiza que exista una localidad concreta. El buscador no sustituye a un geocodificador detallado; muestra solo los países y lugares incluidos en la versión local de los datos.

## Licencias

QWC2 conserva su licencia BSD-2-Clause y atribuciones originales en [`upstream/qwc2/LICENSE`](upstream/qwc2/LICENSE). QGIS Server conserva los avisos de licencia de su imagen oficial. Consulta [TERCEROS.md](TERCEROS.md) para las licencias y fuentes de software y datos.

## Backend local y preparación bajo demanda

El backend FastAPI se ejecuta en `http://localhost:7200`, enlazado solo a loopback. Usa la misma imagen fijada de QGIS Server 3.44.16 para llamar a `QGIS/scripts/prepare-terrain.py`; no duplica la descarga Copernicus ni el procesamiento GDAL. Las teselas originales y los derivados siguen en el volumen Docker persistente `qgis_world_data`. Cada extensión y nombre normalizados generan un proyecto independiente en `/io/data/terrain/regions/<id>/terrain.qgs`; `world.qgs` y las regiones anteriores se conservan.

Endpoints:

- `GET /health`: estado del servicio y acceso al volumen.
- `POST /api/terrain/jobs`: acepta `{"area_name":"Jaén","bbox_wgs84":[-3.8,37.7,-3.5,37.9]}` y devuelve `202` con el identificador y las rutas de consulta.
- `GET /api/terrain/jobs/{job_id}`: estado `queued`, `running`, `completed` o `failed`.
- `GET /api/terrain/jobs/{job_id}/result`: cobertura WGS84, resolución, rango de elevación, archivos y referencias WMS (`terrain_hillshade` y `terrain_elevation`) con el parámetro `MAP` del proyecto regional.

Las peticiones comparten la validación del script: extensión WGS84 creciente, máximo 4° por lado, no más de 16 teselas y 30 millones de píxeles proyectados a 30 m. El límite de trabajo predeterminado es de 30 minutos. Solo se ejecuta un trabajo a la vez; otra región mientras haya un trabajo activo recibe `409`. Una solicitud equivalente devuelve el resultado guardado con `reused: true`; la preparación también reutiliza teselas y rásteres verificados. Si un resultado guardado tiene un proyecto anterior a la escala adaptativa, FastAPI actualiza solo el estilo del proyecto QGIS: no vuelve a descargar teselas ni a generar rásteres.

Arranque y parada del backend:

```bash
docker compose up -d --build backend
docker compose stop backend
```

## Pendientes y orientación de laderas

Desde un terreno regional ya preparado, el panel **Topografía** permite generar pendientes y orientación con `POST /api/terrain/jobs/{job_id}/derivatives`. El backend reutiliza el GeoTIFF de elevación almacenado; no descarga ni reprocesa el DEM. El trabajo utiliza la cola de un único proceso existente y respeta el timeout y el límite de 768 MiB del backend. GDAL procesa las dos salidas de forma secuencial con Horn, bloques y compresión DEFLATE.

Las pendientes se guardan como valores Float32 en porcentaje de ascenso; su leyenda QGIS mantiene clases fijas de 0–5, 5–15, 15–30, 30–60 y más de 60 %. La orientación se guarda como azimut Float32 en grados, en sentido horario desde el **norte de cuadrícula** del CRS métrico proyectado. Los bordes sin vecindad suficiente y las superficies planas conservan NoData (`-9999`) en el ráster numérico. Para mostrar las superficies planas como «sin orientación», un ráster de visualización separado usa el código `-1`; ese código no se mezcla con el producto numérico de análisis. La capa de orientación se remuestrea por vecino más cercano para mantener las ocho clases cardinales e intercardinales discretas.

Ambas salidas conservan la resolución de la elevación preparada (30 m), su proyección y NoData. Sus metadatos registran fuente Copernicus DEM GLO-30 Public, huella SHA-256 de la elevación, CRS y unidades horizontales/verticales, algoritmo, unidades del producto y referencia norte. Los rásteres se almacenan junto al terreno regional en el volumen persistente `qgis_world_data`; el producto de orientación para visualización se identifica como tal y la API conserva las rutas de los productos numéricos para futuros análisis zonales. QGIS Server expone `terrain_slope` y `terrain_aspect` dentro del proyecto regional. En el visor solo se muestra una capa temática a la vez, opcionalmente combinada con el relieve sombreado, recortada visualmente por el polígono seleccionado; ambas capas empiezan desactivadas.

La derivación de estos productos está disponible mediante el endpoint existente `POST /api/terrain/jobs/{job_id}/derivatives`; el backend reutiliza la elevación y no descarga datos. Dibujar o seleccionar un área no inicia procesamiento. Los rásteres existentes se reutilizan si coinciden la elevación, la cuadrícula, los archivos y sus checksums.

GDAL documenta el algoritmo Horn y las unidades de salida en [gdaldem](https://gdal.org/en/stable/programs/gdaldem.html). Estos valores numéricos alimentan el motor local de estadísticas zonales descrito a continuación; todavía no se generan criterios del DSS.

El estado de trabajos en curso vive en memoria y se pierde si se reinicia el backend. Los trabajos completados se reconstruyen desde sus resultados persistidos en el volumen y siguen disponibles por identificador. Es una cola de un único proceso para desarrollo local, no un servicio de procesamiento distribuido.

## Estadísticas zonales del terreno

`Backend/app/zonal_statistics.py` expone `calculate_zonal_terrain_statistics(geometry_geojson, elevation_raster, slope_raster, aspect_raster)`, independiente de FastAPI y del visor. Recibe una geometría GeoJSON `Polygon` o `MultiPolygon` en longitud/latitud WGS84 y los tres GeoTIFF numéricos de un mismo terreno preparado. Use `aspect-degrees.tif`, nunca `aspect-display.tif`. Los rásteres deben compartir CRS proyectado, resolución, alineación y dimensiones; la geometría se reproyecta antes de calcular.

El motor rasteriza la geometría real, incluidos sus huecos, e incluye un píxel solo si su centro cae dentro del polígono. Lee la ventana correspondiente en bloques de hasta 256 filas y rechaza ventanas mayores que el límite configurado de 30 millones de píxeles. La superficie del polígono se estima en EPSG:6933; la cobertura del ráster y los porcentajes de superficie se aproximan con el área de los píxeles seleccionados por centro y se limitan a 100 %. La cobertura válida por variable relaciona el área aproximada de píxeles válidos con la superficie del polígono; el resultado incluye también la fracción válida de los píxeles rasterizados. Elevación devuelve mínimo, máximo, media, desviación estándar poblacional y `maximum_relief_m` (máximo menos mínimo). Pendiente devuelve los mismos estadísticos y distribución por clase. Los porcentajes de pendiente y orientación usan como denominador los píxeles válidos de esa variable; NoData e inválidos quedan excluidos. Las clases de pendiente reutilizan `terrain_derivative_config.py`.

La orientación sigue el norte de cuadrícula y no calcula media angular. GDAL deja las celdas planas como NoData en el ráster numérico; el motor las reconoce como planas únicamente cuando pendiente válida es ≤0,000001 % y orientación es NoData. Otros píxeles NoData no se confunden con superficie plana. Si falta cobertura válida, el estado de esa variable es `no_data` y sus estadísticas son nulas. El resultado JSON incluye área aproximada, píxeles incluidos y válidos, cobertura, CRS, resolución, unidades, fuente disponible y advertencias; no modifica ningún GeoTIFF.

Para ejecutar el análisis, copie un archivo que contenga la geometría GeoJSON al contenedor y use las rutas numéricas del campo `storage` del resultado del trabajo ya preparado:

```bash
docker compose cp /tmp/area.geojson backend:/tmp/area.geojson
docker compose exec backend /opt/backend-venv/bin/python -m app.zonal_statistics \
  --geometry-file /tmp/area.geojson \
  --elevation /io/data/terrain/derived/ID_DEL_TERRENO/ID_DEL_PRODUCTO/elevation.tif \
  --slope /io/data/terrain/derived/ID_DEL_TERRENO/ID_DEL_PRODUCTO/slope-percent.tif \
  --aspect /io/data/terrain/derived/ID_DEL_TERRENO/ID_DEL_PRODUCTO/aspect-degrees.tif
```

El JSON se escribe en stdout y puede guardarse redirigiendo la salida. Este motor es una primera utilidad local de análisis: no crea endpoints, no prepara datos automáticamente y no sustituye la validación de criterios posteriores.

## API de análisis automático de áreas

El backend expone `POST /api/analysis/jobs`, `GET /api/analysis/jobs/{id}` y `GET /api/analysis/jobs/{id}/result`. El POST recibe el nombre del área y una geometría GeoJSON `Polygon` o `MultiPolygon` en WGS84; no acepta rutas de archivos ni identificadores de terrenos. Antes de encolar, valida la geometría y aplica los límites actuales de extensión, teselas Copernicus y píxeles. El trabajo comprueba primero regiones compatibles ya preparadas; si faltan elevaciones las prepara con el proceso existente y genera derivados numéricos cuando sea necesario. Finalmente calcula las estadísticas sobre la geometría original, no sobre su rectángulo delimitador.

Los trabajos comparten el ejecutor único del backend con las tareas existentes de preparación y derivados. Los estados son `queued`, `checking_data`, `preparing_elevation`, `generating_derivatives`, `calculating_statistics`, `completed` y `failed`; el campo `stage` contiene una etiqueta legible y no se inventa un porcentaje de progreso. Un resultado sin píxeles válidos se completa con estados `no_data` y valores estadísticos nulos. Los errores técnicos usan mensajes públicos genéricos y no exponen rutas ni trazas.

La API responde `422` para solicitudes geométricas inválidas o límites excedidos y para consultar el resultado de un trabajo fallido, `409` si el trabajador está ocupado y `404` para identificadores inexistentes o resultados cuyos datos ya no están disponibles.

Ejemplo de solicitud:

```http
POST /api/analysis/jobs
Content-Type: application/json

{
  "area_name": "Jaén auto derivatives",
  "geometry": {
    "type": "Polygon",
    "coordinates": [[
      [-4.235, 37.762], [-4.19, 37.762], [-4.19, 37.799],
      [-4.235, 37.799], [-4.235, 37.762]
    ]]
  }
}
```

Respuesta inicial (`202 Accepted`):

```json
{
  "analysis_id": "725bfdc2d4d33eca",
  "status": "queued",
  "stage": "Pendiente",
  "area_name": "Jaén auto derivatives",
  "status_url": "/api/analysis/jobs/725bfdc2d4d33eca",
  "result_url": null
}
```

Consulta `status_url` hasta `completed` y después solicita `result_url` (`200 OK`):

Fragmento abreviado de una respuesta real:

```json
{
  "analysis_id": "725bfdc2d4d33eca",
  "status": "completed",
  "data_status": "available",
  "area_name": "Jaén auto derivatives",
  "geometry": {
    "type": "Polygon",
    "coordinates": [[[-4.235, 37.762], [-4.19, 37.762], [-4.19, 37.799], [-4.235, 37.799], [-4.235, 37.762]]]
  },
  "source": "Copernicus DEM GLO-30 Public",
  "resolution_m": 30,
  "terrain_reused": true,
  "derivatives_reused": false,
  "result": {
    "schema_version": "1.0",
    "elevation": {
      "status": "available", "unit": "m",
      "statistics": { "minimum": 266.354492, "mean": 342.04315 },
      "warnings": []
    },
    "slope": {
      "status": "available", "unit": "%",
      "statistics": { "minimum": 0.024456, "mean": 12.558063 },
      "distribution": { "denominator_pixel_count": 18079 }, "warnings": []
    },
    "aspect": {
      "status": "available", "unit": "degrees", "statistics": null,
      "distribution": { "denominator_pixel_count": 18079 }, "warnings": []
    }
  }
}
```

El resultado incluye la geometría original, versión del esquema, cobertura, unidades, distribuciones, advertencias y estadísticas completas. Una solicitud equivalente completada se reutiliza cuando coinciden la versión analítica, los productos numéricos y sus huellas de archivo; dos geometrías distintas mantienen identidades y resultados separados aunque compartan el mismo bbox. Los resultados completados se guardan atómicamente bajo `/io/data/terrain/analyses` en el volumen persistente; las rutas internas de los rásteres se conservan solo en ese archivo y no se devuelven por la API.

### Cuadrícula de elevación para el futuro visor 3D aislado

`GET /api/analysis/jobs/{analysis_id}/terrain-model` expone una cuadrícula numérica acotada para una alternativa cuyo análisis zonal ya terminó y conserva referencias vigentes. Reutiliza exclusivamente el GeoTIFF Copernicus DEM GLO-30 numérico enlazado al análisis: no consulta WMS, no usa las teselas Terrarium, no inicia trabajos ni descarga datos. El ráster sigue siendo un DSM; la respuesta incluye su procedencia, CRS horizontal, unidades y referencia vertical disponible (EGM2008 en los terrenos preparados actuales). Los valores de esta cuadrícula son para representación y no reemplazan las estadísticas zonales.

El parámetro opcional `max_dimension` admite enteros de 16 a 256 y usa 128 por defecto. Cuando la ventana proyectada cabe en ese límite, se leen valores de píxel nativos. En ventanas mayores, GDAL genera una rejilla de hasta `256 × 256` con remuestreo bilineal y un límite de 32 MiB para su área de trabajo; las separaciones de salida nunca se reducen por debajo del tamaño de celda fuente. El remuestreo no modifica el GeoTIFF. La geometría determina la extensión rectangular y se añade un margen de contexto de 90 m a 300 m; si el ráster no lo cubre, se conserva la extensión completa de la geometría, se limita el contexto y se informa en `context` y `warnings`.

La geometría de entrada es GeoJSON `Polygon` o `MultiPolygon` WGS84. El backend transforma una copia al CRS proyectado métrico del ráster y devuelve `geometry_local_m` conservando componentes y huecos. El origen local `(east=0, north=0)` es la esquina suroeste de `extent_projected_m`; X apunta al este e Y al norte. `grid.values_m` usa filas norte-sur y columnas oeste-este. `first_sample_local_m` identifica el centro de la primera celda y `sample_spacing_m` permite derivar las demás posiciones. La cuadrícula es rectangular: puede incluir elevación de contexto bajo los huecos del polígono y todavía no genera paredes ni recorta la malla a sus límites.

Los valores NoData, enmascarados y no finitos se devuelven como `null`; cero y elevaciones negativas permanecen válidos. `coverage.availability` distingue `available`, `partial`, `no_data` e `insufficient_data`. Conteos y rango solo consideran muestras válidas. El futuro visor deberá omitir triángulos que atraviesen `null`. La cobertura describe esta cuadrícula visual, no la cobertura zonal del análisis. La respuesta tiene `schema_version: "1.0"`, filas y columnas, método de muestreo, geometría local, cobertura, rango visual y advertencias. El máximo es 65.536 muestras y se limita la geometría de salida a 50.000 vértices.

Ejemplo abreviado (JSONC; se omiten partes de las coordenadas y la matriz):

```http
GET /api/analysis/jobs/725bfdc2d4d33eca/terrain-model?max_dimension=128
```

```jsonc
{
  "schema_version": "1.0",
  "analysis_id": "725bfdc2d4d33eca",
  "source": "Copernicus DEM GLO-30 Public",
  "model_type": "DSM",
  "horizontal_crs": "EPSG:32630",
  "vertical_reference": "EGM2008",
  "units": {"horizontal": "m", "vertical": "m"},
  "local_origin": {"projected_m": {"east": 400000, "north": 4179000}, "local_m": {"east": 0, "north": 0}},
  "geometry_local_m": {"type": "Polygon", "coordinates": [[/* vertices in local metres */]]},
  "grid": {"columns": 128, "rows": 96, "row_order": "north_to_south", "column_order": "west_to_east", "sampling_method": "bilinear_at_cell_centres", "values_m": [[/* metres or null */], /* remaining rows */]},
  "coverage": {"availability": "partial", "valid_samples": 11820, "missing_samples": 468, "valid_sample_fraction": 0.961914},
  "sampled_elevation_range_m": {"minimum": 21.2, "maximum": 1012.4}
}
```

El análisis debe estar completado y vigente. El endpoint no acepta rutas de archivo. Devuelve `404` si el análisis o sus datos no existen, `409` si sigue en curso o hay otro procesamiento/extracción activa, `422` para límites inválidos o un análisis fallido y `409` ante un ráster incompatible. Solo se admite una extracción simultánea; durante la lectura reserva el indicador de trabajo existente para evitar competir con una regeneración interna de terreno.

## Análisis desde la interfaz GIS

Selecciona un área en la pestaña **Áreas** y pulsa **Analizar área** en su ficha. Se admiten geometrías `Polygon` y `MultiPolygon`; la segunda se conserva como una sola área con una identidad y un análisis zonal conjunto. La interfaz consulta el estado del trabajo mediante el proxy `/api`, muestra la fase del backend y presenta las estadísticas en esa misma ficha. Elevación media, pendiente media, desnivel y superficie con pendiente de hasta el 5 % aparecen primero; el resto de estadísticas, las distribuciones y la información de fuente y cobertura quedan agrupadas en secciones plegables. Cada resultado queda asociado a la revisión geométrica de su área durante la sesión: editar cualquier componente invalida solo ese resultado, mientras que renombrar conserva las estadísticas. No se inicia procesamiento al dibujar o seleccionar y el análisis no cambia la vista del mapa.

Con dos o más áreas, incluidas áreas compuestas, **Comparar áreas** abre una matriz para elegir áreas y criterios geométricos, de elevación, pendiente y orientación. Cada `MultiPolygon` ocupa una sola columna. Las medidas geométricas suman los componentes y excluyen los huecos; los criterios topográficos reutilizan el análisis zonal conjunto y no lanzan trabajos automáticamente. Los porcentajes de clases se calculan con sus recuentos y el denominador de píxeles válidos. La matriz muestra cobertura y estado por valor; los datos pendientes o insuficientes permanecen nulos y nunca se presentan como cero. La selección de áreas y criterios se conserva durante la sesión.

La acción **Calcular criterios** inicia explícitamente los análisis que falten para las áreas y criterios seleccionados. Las medidas geométricas no envían solicitudes al backend; una ejecución topográfica devuelve todas las variables y se reutiliza para los criterios que dependan de ellas. Los trabajos se coordinan de uno en uno y el estado persiste en la interfaz aunque se cierre la matriz. **Detener siguientes** permite que el trabajo actual termine y evita iniciar los restantes; se puede continuar después. Los resultados quedan asociados a la revisión de cada geometría, y los trabajos con seguimiento incierto bloquean de forma segura el inicio de otras áreas.

### Modelo aislado de terreno 3D

En la ficha de un área `Polygon` o `MultiPolygon`, **Ver terreno en 3D** se habilita cuando hay un análisis completado para la revisión geométrica actual. La vista consulta una vez `GET /api/analysis/jobs/{analysis_id}/terrain-model?max_dimension=128`; no recalcula el análisis ni descarga o cambia los datos Copernicus. La respuesta `schema_version: "1.0"` se valida antes de construir la malla; la API y sus límites se describen en la sección de cuadrícula anterior.

El componente `IsolatedTerrainView` se importa con `React.lazy`, y Three.js 0.187.0 con `OrbitControls` se incluye solo en el chunk cargado al abrir el modelo. El renderer WebGL dibuja bajo demanda cuando cambia la cámara, el tamaño, el tema o la exageración; no ejecuta un ciclo continuo de animación. El visor se superpone al espacio GIS, que permanece montado para conservar mapa, selección, análisis y cámara; no se detiene explícitamente el renderizado que administra OpenLayers o MapLibre. Escape o el botón de cierre devuelven el foco al botón de apertura.

La malla usa X = este, Y = elevación y Z = norte negativo. Para fila `r` y columna `c`, este y norte se obtienen con los centros de celda que da la API: `east = first.east + c × spacing.east`, `north = first.north − r × spacing.north`. Se resta al terreno una cota de referencia visual (el punto medio del rango) para centrar la precisión gráfica; no se cambian las cotas absolutas informadas. A 1× las distancias horizontales y verticales comparten escala métrica; el control 0,5×–3× solo escala el eje vertical.

El selector **Superficie / Volumen** cambia la forma del mismo modelo, sin volver a pedir la cuadrícula ni mover la cámara. **Superficie** conserva la malla abierta existente. **Volumen** añade, una sola vez, paredes en los bordes que pertenecen a un único triángulo y una base plana formada únicamente por la proyección de los triángulos válidos. La base queda un 12 % de la menor dimensión horizontal de la cuadrícula por debajo de la muestra mínima; incluso el terreno plano tiene grosor. Es una convención visual, no una profundidad geológica ni un cálculo de volumen real. La exageración vertical escala conjuntamente superficie, paredes y base.

Cada celda completa usa dos triángulos con normales hacia arriba; si falta una sola de sus cuatro muestras, se usa el triángulo de las otras tres. Con dos o menos muestras no se crea triángulo. NoData no se interpola ni se convierte en cota cero: no se crean caras a través de huecos, y los componentes válidos separados mantienen bases independientes. En una cuadrícula completa el perímetro queda cerrado; con cobertura parcial solo se generan soportes a partir de las caras disponibles. Las paredes y la base usan tonos neutros de la misma paleta y no cambian el color temático de la superficie ni el contorno del área.

La geometría local en metros devuelta por la API se proyecta sobre una textura independiente de hasta 512 × 512 píxeles para dibujar el relleno y el contorno. Las coordenadas de textura van de centro de muestra a centro de muestra, con el norte arriba. Cada polígono se pinta por separado; `evenodd` mantiene huecos interiores y `MultiPolygon` conserva componentes separados. El contorno se rasteriza y su precisión visual depende de la resolución de esa textura. La malla conserva el rectángulo con contexto: no se recorta físicamente al polígono y la parte bajo huecos permanece visible.

### Temas y superposiciones

El control **Representación temática** ofrece **Relieve natural**, **Elevación absoluta** y **Relieve sombreado** sobre la misma malla. El relieve natural adapta una paleta vegetal, terrosa y de cotas altas al rango válido de la cuadrícula local; esos colores son una convención visual, no indican vegetación ni cobertura del suelo, y un mismo color puede corresponder a cotas distintas entre alternativas. Los rangos planos usan el tono intermedio de forma segura.

Elevación absoluta utiliza una paleta de tierra fija entre −11.000 y 9.000 m, interpolada entre las paradas de `ABSOLUTE_ELEVATION_STOPS`; extiende el extremo bajo con un verde apagado para no clasificar automáticamente como agua las cotas negativas del DSM Copernicus. Cero es válido y los valores fuera del intervalo se limitan al color del extremo. La leyenda muestra la misma rampa, sus cotas fijas en metros y el rango de la cuadrícula actual. **Relieve sombreado** usa materiales neutros y la iluminación de Three.js para resaltar las normales de la superficie; es una ayuda de percepción, no un hillshade solar ni una simulación de fecha u hora. Por eso no presenta una leyenda numérica.

Los colores se obtienen de `grid.values_m` en metros absolutos, no de las alturas exageradas ni de las normales. La geometría sigue usando X = este, Y = elevación y Z = norte negativo: la fila 0 de la cuadrícula está al norte, se le asigna directamente el color de su vértice y sus UV tienen `v = 1`. Se comprobó que Three.js 0.187.0 hereda `CanvasTexture.flipY = true` de `Texture`; el overlay de límites establece ese valor explícitamente para mantener Canvas y UV alineados. Fixtures norte-sur y oeste-este verifican esa orientación sin invertir la malla.

Las muestras `null` quedan sin color temático y no participan en triángulos; el coloreado por vértice solo se interpola dentro de las caras realmente válidas. La ausencia de datos no se presenta como cota cero ni se rellenan huecos. **Límites de la alternativa** permite mantener relleno y contorno, mostrar solo el contorno o esconder ambos. **Mostrar malla triangular** dibuja una sola colección de segmentos a partir de las aristas únicas de los triángulos válidos, desplazada ligeramente sobre sus normales y sometida a la prueba de profundidad para evitar z-fighting y líneas a través del terreno.

Cambiar tema, límites o malla actualiza atributos, iluminación, textura o visibilidad en la misma escena; no reconstruye el renderer ni consulta el backend. La exageración solo transforma verticalmente el grupo del modelo y no cambia las cotas ni las clasificaciones. Forma, tema, límites, malla y exageración se guardan en `sessionStorage`. El botón de restablecer calcula el encuadre con la forma y exageración actuales y el aspecto del viewport. Se conserva un solo renderer, la geometría de superficie y el renderizado bajo demanda; la capa de Three.js sigue cargándose de forma diferida.

La ficha muestra superficie de la alternativa, fuente Copernicus DEM GLO-30 Public, tipo DSM, resolución del ráster original, separación de las muestras, cobertura y rango de elevación de la cuadrícula, y referencia vertical si existe. El rango y la paleta de color corresponden a la cuadrícula rectangular de visualización, no a las estadísticas zonales. Resultados, criterios objetivos y cotas analíticas no cambian al abrir el modelo.

La petición solicita hasta 128 × 128 muestras; el backend puede devolver una cuadrícula menor para respetar la resolución efectiva disponible. El visor limita el pixel ratio a 1,5 y libera renderer, textura del límite, geometrías de superficie y soportes, controles y observadores al cerrar. Los cambios exclusivamente visuales no generan nuevas peticiones: si el área no tiene un análisis vigente, primero se debe ejecutar el flujo **Analizar área**. Un resultado parcial muestra únicamente triángulos con cobertura y advierte de los huecos; NoData completo o muestras insuficientes explican por qué no hay superficie. El visor requiere WebGL; el volumen solo representa visualmente las muestras del DEM y no es una malla geológica ni sustituye mediciones o análisis.

## Zonas de influencia

`POST /api/geometry/buffer` acepta `{"geometry": <GeoJSON Point|LineString|Polygon|MultiPolygon WGS84>, "distance_m": 500}` y devuelve la geometría WGS84 calculada, el CRS local usado y posibles advertencias. El módulo independiente `Backend/app/geometry_operations.py` valida topología y coordenadas, y limita la distancia a `0 < distancia ≤ 50 km`, la geometría a 10.000 vértices y su extensión a 4° por lado (el resultado proyectado se limita a 500 km). Rechaza explícitamente regiones polares y cruces del antimeridiano.

El backend elige el CRS UTM local con `QGIS/scripts/terrain_request.py`, transforma la geometría desde WGS84 y calcula un buffer GEOS de extremos redondeados (32 segmentos por cuadrante), antes de transformar el resultado a WGS84. GEOS mantiene los huecos que sobreviven a la operación. No se calculan distancias en grados ni en EPSG:3857, y la operación no descarga datos ni utiliza la cola de preparación del terreno.

La ficha de puntos, líneas y áreas permite solicitar una vista previa desde el backend, introducir metros o kilómetros y asignar nombre al área. Confirmar incorpora un nuevo `Polygon` o `MultiPolygon` como un elemento independiente en la capa de dibujos; conserva todos sus componentes y anillos, y el resultado puede analizarse y compararse como una sola área. Cambiar o eliminar la geometría de origen invalida una solicitud o vista previa pendiente.

## Operaciones geométricas entre áreas

`POST /api/geometry/overlay` recibe `{"operation":"union|intersection|difference","geometry_a":<Polygon|MultiPolygon WGS84>,"geometry_b":<Polygon|MultiPolygon WGS84>}`. El backend valida ambas entradas y las proyecta juntas a un único CRS UTM métrico elegido por la extensión combinada antes de ejecutar OGR/GEOS. La extensión conjunta se limita a 4° por lado; cada entrada mantiene el límite de 10.000 vértices y los resultados se limitan a 50.000 vértices y 500 km de extensión métrica. No se reparan ni simplifican silenciosamente las geometrías.

La unión conserva la superficie de ambas áreas, la intersección conserva la superficie compartida y la diferencia calcula A menos B, respetando ese orden. Se devuelven todos los `Polygon`/`MultiPolygon` y sus huecos. Una intersección que solo toca un borde o vértice, o una diferencia sin superficie restante, devuelve `result_status: "empty"` y `geometry: null`; los componentes lineales o puntuales de una colección se informan como advertencias y nunca se convierten en áreas.

En la lista **Áreas**, **Operaciones geométricas** abre un panel no modal que deja el mapa navegable. Elegir los operandos u operación no hace peticiones: el backend se consulta al pedir la vista previa. Confirmarla añade un área independiente sin copiar análisis; editar o eliminar cualquiera de las áreas de origen invalida el resultado pendiente.

## Áreas compuestas

`Polygon` y `MultiPolygon` son geometrías de superficie bajo el mismo concepto funcional de área. La interfaz conserva el tipo GeoJSON real y representa una geometría compuesta con una sola identidad, nombre, selección, ficha y columna de criterios. Sus medidas geodésicas suman todos los componentes, descuentan los anillos interiores de la superficie y cuentan los vértices sin duplicar los cierres de anillo.

El análisis existente envía el `MultiPolygon` completo a `POST /api/analysis/jobs`. GDAL rasteriza la geometría completa con inclusión por centro de píxel; las zonas vacías entre componentes no participan en las estadísticas. La extensión conjunta sigue sujeta a los límites actuales de teselas y píxeles; si los componentes están demasiado separados, el backend rechaza la solicitud en vez de analizarlos como una superficie continua.
