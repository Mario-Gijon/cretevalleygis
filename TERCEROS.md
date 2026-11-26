# Software y datos de terceros

- **QWC2** — QGIS Web Client, rama LTS 2026, versión `2026.0.31-lts`, commit `8a1eb791181fe1891e446c8dd968faad83b71e91`. Código y licencia BSD-2-Clause conservados en [`upstream/qwc2`](upstream/qwc2). Proyecto: <https://github.com/qgis/qwc2>.
- **QGIS Server** — imagen oficial `qgis/qgis-server:3.44.16-noble`, con sus licencias y avisos conservados en la imagen. QGIS se distribuye bajo GPL versión 2 o posterior; consulta la [licencia oficial](https://github.com/qgis/QGIS/blob/master/COPYING) y el [repositorio de imágenes oficiales](https://github.com/qgis/qgis-docker).
- **OpenLayers** — biblioteca de mapas web con licencia BSD-2-Clause; paquete `ol` incluido en `Frontend/package-lock.json`.
- **OpenStreetMap** — capa base del frontend y teselas de fondo configuradas por la demo QWC2. Atribución visible en el mapa: © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright); datos bajo ODbL. El uso del servidor público de teselas sigue su [política de uso](https://operations.osmfoundation.org/policies/tiles/).
- **Natural Earth** — capas de tierra, países y límites a escala 1:110m descargadas durante la inicialización desde los archivos oficiales de Natural Earth. Los datos son de dominio público; la atribución no es obligatoria. La aplicación muestra “Made with Natural Earth”. [Descargas](https://www.naturalearthdata.com/downloads/) y [términos](https://www.naturalearthdata.com/about/terms-of-use/).
- **Inter** — tipografía variable distribuida por Fontsource bajo SIL Open Font License 1.1.
- **NASA GIBS Blue Marble** — capa WMTS opcional configurada por la demo oficial: <https://gibs.earthdata.nasa.gov/>.
- **WMS de demostración QWC2** — proyecto remoto de muestra: <http://qwc2.sourcepole.ch/ows/qwc_demo>. Este servicio no forma parte del repositorio ni del despliegue local.
