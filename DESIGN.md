# Decisiones visuales

- Interfaz en español, compacta y orientada al mapa; el panel plegable separa Capas, Áreas y Análisis, con secciones de capas plegables y ancho ajustable en escritorio.
- Inter, iconografía Lucide y superficies neutras con bordes discretos. El azul `#134F8A`, el marino `#05294C`, el turquesa `#45C5C5` y el lima `#C2E812` se definen como tokens CSS reutilizables; el lima queda reservado para acentos.
- Modo claro y oscuro con el mismo mapa y controles de alto contraste. El panel pasa a superposición en pantallas pequeñas para conservar espacio cartográfico.
- Las herramientas cartográficas forman una barra flotante compacta con icono y etiqueta; en móvil se ordena en tres columnas. El estado activo es claro y las instrucciones se muestran junto al mapa sin tapar la atribución.
- Los elementos dibujados usan azul y turquesa, aparecen en la pestaña Áreas y se pueden seleccionar, renombrar, centrar y eliminar desde la lista.
- La pestaña Análisis muestra la ficha y mediciones geodésicas del elemento seleccionado. Las mediciones temporales permanecen separadas y ofrecen acciones visibles para terminar o cancelar el trazo.
- La escala gráfica métrica y la lectura de medición se mantienen compactas en el borde inferior del mapa, también en pantallas pequeñas.
- El selector compacto distingue mapas base de capas de análisis: Positron es la opción inicial, con Dark, Liberty, OpenStreetMap y QGIS como alternativas. Los estilos vectoriales se cargan bajo demanda sobre OpenLayers y sus atribuciones permanecen visibles.
- Las capas de terreno y los elementos dibujados permanecen por encima del mapa base; las teselas renderizadas sirven solo para contexto visual, nunca como dato de cálculo.
