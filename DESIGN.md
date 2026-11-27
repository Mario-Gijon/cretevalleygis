# Decisiones visuales

- La interfaz en español mantiene un panel plegable, compacto y redimensionable que prioriza el mapa. El panel tiene dos pestañas: **Capas** y **Áreas**.
- **Áreas** abre primero la lista. Al elegir un elemento o seleccionarlo en el mapa, la misma pestaña muestra sus propiedades y medidas; un botón visible permite volver a la lista.
- La ficha de cada polígono ofrece un análisis del terreno bajo demanda. Los indicadores principales se muestran primero; distribuciones y metadatos quedan en secciones plegables, con advertencias de cobertura visibles y sin interferir con la navegación del mapa.
- Los análisis pertenecen al área y a la revisión de su geometría. Renombrar conserva el resultado; editar invalida solo ese resultado y eliminar el área retira solo su estado asociado.
- Los elementos dibujados conservan un estilo común y transparente. La ficha se limita a propiedades, medidas y acciones disponibles; no ofrece preparación manual de datos topográficos.
- La pestaña **Capas** conserva cinco mapas base convencionales y agrupa tres vistas topográficas seleccionables directamente: Elevación, Pendientes y Orientación de laderas. Todas reutilizan una fuente de terreno WebGL; los ajustes y leyenda solo aparecen en esas vistas.
- El relieve sombreado se activa por separado. Opacidad, intensidad y leyenda se agrupan en ajustes plegados para mantener despejado el panel; elevación ofrece escalas absoluta y adaptativa, con la absoluta como predeterminada.
- Pendientes y orientación usan clases y colores fijos desde el zoom mínimo del mapa. En vistas alejadas, un estado discreto indica que la representación está generalizada según la resolución de los datos.
- Inter, iconografía Lucide y superficies neutras con bordes discretos mantienen la identidad definida en los tokens CSS. El lima se reserva para acentos puntuales.
- El modo claro y oscuro conserva el mismo contraste. En pantallas pequeñas, el panel se superpone al mapa y reduce el espacio que ocupa.
- Las herramientas forman una barra flotante compacta; los estados activos y las instrucciones tienen que ser claros sin cubrir la cartografía.
- La atribución cartográfica permanece junto al mapa. No se duplica en el panel.
- La escala gráfica, las coordenadas y las mediciones permanecen compactas en los bordes del mapa, también en pantallas pequeñas.
- Las teselas de relieve sirven solo como contexto visual. Los datos preparados por área se conservan para análisis posteriores y no se activan al dibujar o seleccionar geometrías.
