# Decisiones visuales

- La interfaz en español mantiene un panel plegable, compacto y redimensionable que prioriza el mapa. El panel tiene dos pestañas: **Capas** y **Áreas**.
- **Áreas** abre primero la lista. Al elegir un elemento o seleccionarlo en el mapa, la misma pestaña muestra sus propiedades y medidas; un botón visible permite volver a la lista.
- Los elementos dibujados conservan un estilo común y transparente. La ficha se limita a propiedades, medidas y acciones disponibles; no ofrece preparación manual de datos topográficos.
- La pestaña **Capas** reúne los seis mapas base y las capas geográficas. La sección de topografía solo aparece con el mapa base Topográfico, que reutiliza los mismos controles de relieve sombreado y elevación.
- La topografía combina un selector de representación temática (ninguna, elevación, pendientes u orientación) y un interruptor independiente de relieve sombreado. Los ajustes de intensidad, escala de color y leyenda están agrupados para mantener despejado el panel.
- Pendientes y orientación son modos de exploración visual, con clases y colores fijos y una leyenda compacta; se habilitan desde zoom 8 para evitar falsa precisión a escala mundial.
- Inter, iconografía Lucide y superficies neutras con bordes discretos mantienen la identidad definida en los tokens CSS. El lima se reserva para acentos puntuales.
- El modo claro y oscuro conserva el mismo contraste. En pantallas pequeñas, el panel se superpone al mapa y reduce el espacio que ocupa.
- Las herramientas forman una barra flotante compacta; los estados activos y las instrucciones tienen que ser claros sin cubrir la cartografía.
- La atribución cartográfica permanece junto al mapa. No se duplica en el panel.
- La escala gráfica, las coordenadas y las mediciones permanecen compactas en los bordes del mapa, también en pantallas pequeñas.
- Las teselas de relieve sirven solo como contexto visual. Los datos preparados por área se conservan para análisis posteriores y no se activan al dibujar o seleccionar geometrías.
