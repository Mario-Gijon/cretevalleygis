# Decisiones visuales

- La interfaz en español mantiene un panel plegable, compacto y redimensionable que prioriza el mapa. El panel tiene dos pestañas: **Capas** y **Áreas**.
- **Áreas** abre primero la lista. Al elegir un elemento o seleccionarlo en el mapa, la misma pestaña muestra sus propiedades, medidas y estado de preparación; un botón visible permite volver a la lista.
- Los elementos dibujados conservan un estilo común y transparente. Preparar datos para una geometría no cambia su apariencia, el mapa base ni las preferencias cartográficas.
- La pestaña **Capas** reúne los seis mapas base, las capas geográficas y una única sección de topografía para todo el mapa. El mapa base Topográfico reutiliza los mismos controles de relieve sombreado y elevación.
- La topografía se controla con dos interruptores globales. Los ajustes de intensidad, escala de color y leyenda están agrupados para mantener despejado el panel.
- Inter, iconografía Lucide y superficies neutras con bordes discretos mantienen la identidad definida en los tokens CSS. El lima se reserva para acentos puntuales.
- El modo claro y oscuro conserva el mismo contraste. En pantallas pequeñas, el panel se superpone al mapa y reduce el espacio que ocupa.
- Las herramientas forman una barra flotante compacta; los estados activos y las instrucciones tienen que ser claros sin cubrir la cartografía.
- La atribución cartográfica permanece junto al mapa. No se duplica en el panel.
- La escala gráfica, las coordenadas y las mediciones permanecen compactas en los bordes del mapa, también en pantallas pequeñas.
- Las teselas de relieve sirven solo como contexto visual. Los datos preparados por área quedan asociados a su geometría y se reservan para análisis posteriores.
