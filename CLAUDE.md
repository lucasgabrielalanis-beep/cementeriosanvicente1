# Contexto del proyecto

- Software de gestión operativa del Cementerio San Vicente Parque (Dirección de Cementerios, Municipalidad de Córdoba).
- Roles: Director y Capataz (para ingresar solo se ofrecen el Director y el Capataz A; se sacaron el operario y el Capataz B). Los tableros (resumen, zonas, alertas, registro firmado) los ven todos y todos arrancan en el mismo Resumen; los Ajustes, solo directivos. Registrar tareas y descargas es de capataces/operarios.
- Organización (pedida por el dueño): en las zonas 1 a 30 cada fosa se ubica por **zona, cuadro (1 a 40) y fosa**. **Fosas** = Parque (zonas 1 a 28), zonas COVID (29 y 30), Sección Vieja (fosas) y Sección Nueva. **Nichos** = Pabellón Amarillo, Central, Lateral y Sección Vieja (se muestra solo como "Sección Vieja", sin la palabra nichos; código SV_NICHOS). La **Sección Vieja** de nichos tiene su plano (calles, pasajes, sectores, cuadros con letra, bloques y "Prop.") en `plano-seccion-vieja.js` y en la tabla `bloques_seccion`; sus nichos se ubican por cuadro/bloque + número, sin la palabra "Nicho" (p. ej. "Cuadro O · Bloq. 19 · N° 12"). No hay "sectores especiales" (se sacaron Horno Crematorio, Cementerio Israelita, Memorial y Osario).
- El dueño del proyecto no tiene conocimientos técnicos: hablarle en español rioplatense, sin jerga técnica.
- Archivos actuales:
  - `index.html` + `app.js` + `estilos.css` (+ `manifest.webmanifest`, `icono.svg`): la app web, sin dependencias externas. Hoy funciona en **modo demostración**: datos de ejemplo guardados en el navegador (localStorage); la capa `Datos` de `app.js` es la que se reemplaza por la API cuando haya servidor y base. Usuarios demo (Director y Capataz A) con PIN 1234.
  - `esquema.sql`: base de datos PostgreSQL + PostGIS.
  - `openapi.yaml`: contratos de la API.
  - `README.md`: arquitectura, alertas y diagramas (Mermaid).
  - `documento.html`: el README como página (generada, no editar a mano). Después de cambiar el README: `cd herramientas && npm install && npm run pagina`. Mermaid va en `vendor/`.
- Se publica en Vercel como sitio estático (proyecto `cementeriosanvicente1`, toma la rama `main`).
- Los plazos de mantenimiento y los umbrales de stock son provisorios hasta confirmarlos con el plano y la Dirección.
- Nunca escribir contraseñas ni cadenas de conexión con contraseña en el repositorio.
