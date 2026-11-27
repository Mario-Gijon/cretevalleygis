# Decisiones visuales

- Interfaz en español, compacta y orientada al mapa; el panel plegable separa Capas, Áreas y Análisis, con secciones de capas plegables y ancho ajustable en escritorio.
- Inter, iconografía Lucide y superficies neutras con bordes discretos. El azul `#134F8A`, el marino `#05294C`, el turquesa `#45C5C5` y el lima `#C2E812` se definen como tokens CSS reutilizables; el lima queda reservado para acentos.
- Modo claro y oscuro con el mismo mapa y controles de alto contraste. El panel pasa a superposición en pantallas pequeñas para conservar espacio cartográfico.
- Las herramientas cartográficas forman una barra flotante compacta con icono y etiqueta; en móvil se ordena en tres columnas. El estado activo es claro y las instrucciones se muestran junto al mapa sin tapar la atribución.
- Los elementos dibujados usan azul y turquesa, aparecen en la pestaña Áreas y se pueden seleccionar, renombrar, centrar y eliminar desde la lista.
- La pestaña Áreas prioriza nombre, tipo, una medida resumida y el estado del terreno. Sus acciones secundarias se agrupan en un menú; la pestaña Análisis presenta medidas geodésicas compactas y las acciones de terreno disponibles.
- Los controles principales se mantienen visibles y los ajustes de opacidad, leyendas, escalas de color y fuentes se muestran bajo detalles cuando hacen falta. La topografía general y el terreno preparado por área se distinguen con claridad.
- Las instrucciones flotantes solo aparecen al utilizar una herramienta; en modo Explorar no tapan el mapa. La atribución cartográfica permanece junto al mapa y no se duplica en el panel.
- La escala gráfica métrica y la lectura de medición se mantienen compactas en el borde inferior del mapa, también en pantallas pequeñas.
- El selector de seis mapas base usa tarjetas compactas con miniaturas en tres columnas: Positron es la opción inicial, junto con Dark, Liberty, OpenStreetMap, QGIS y Topográfico. Los estilos vectoriales se cargan bajo demanda sobre OpenLayers y sus atribuciones permanecen visibles.
- Las capas geográficas se presentan como filas compactas. La topografía mundial, la incluida en el mapa base y los terrenos preparados se explican por separado; las fuentes y licencias permanecen en un apartado avanzado plegable.
- Los terrenos preparados se configuran por área y conservan su visibilidad, tema y opacidad al cambiar de selección. Hillshade acompaña una sola representación temática; la elevación usa una leyenda local y pendientes/orientación conservan escalas comparables.
- La topografía queda por debajo de las capas geográficas, los dibujos y las mediciones. Cada terreno se recorta con la geometría real y solo solicita WMS mientras esté visible y dentro de su extensión.
- La topografía Mapzen del mapa se controla por separado como relieve sombreado y elevación coloreada, con opacidades propias y una leyenda en metros. La escala adaptativa usa un rango común de la vista; se indica que sus colores no comparan altitudes entre regiones. Hillshade de área preparada tiene prioridad y pausa temporalmente la topografía general para evitar su duplicación; la preferencia del usuario se conserva.
- Las teselas renderizadas sirven solo para contexto visual, nunca como dato de cálculo.
