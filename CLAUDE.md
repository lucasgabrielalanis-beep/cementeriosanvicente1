# Contexto del proyecto

- Software de gestión operativa del Cementerio San Vicente Parque (Dirección de Cementerios, Municipalidad de Córdoba).
- Roles: Directivos y Capataces/Operarios. Los tableros (resumen, zonas, alertas, registro firmado) los ven todos; los Ajustes, solo directivos. Registrar tareas y descargas es de capataces/operarios.
- Sectores especiales: Pabellón Amarillo, Memorial y Osario (el dueño pidió sacar Horno Crematorio y Cementerio Israelita).
- El dueño del proyecto no tiene conocimientos técnicos: hablarle en español rioplatense, sin jerga técnica.
- Archivos actuales:
  - `index.html` + `app.js` + `estilos.css` (+ `manifest.webmanifest`, `icono.svg`): la app web, sin dependencias externas. Hoy funciona en **modo demostración**: datos de ejemplo guardados en el navegador (localStorage); la capa `Datos` de `app.js` es la que se reemplaza por la API cuando haya servidor y base. Usuarios demo con PIN 1234.
  - `esquema.sql`: base de datos PostgreSQL + PostGIS.
  - `openapi.yaml`: contratos de la API.
  - `README.md`: arquitectura, alertas y diagramas (Mermaid).
  - `documento.html`: el README como página (generada, no editar a mano). Después de cambiar el README: `cd herramientas && npm install && npm run pagina`. Mermaid va en `vendor/`.
- Se publica en Vercel como sitio estático (proyecto `cementeriosanvicente1`, toma la rama `main`).
- Las zonas 1 a 28 tienen solo fosas (no nichos); los nichos están en el Pabellón Amarillo.
- Los plazos de mantenimiento y los umbrales de stock son provisorios hasta confirmarlos con el plano y la Dirección.
- Nunca escribir contraseñas ni cadenas de conexión con contraseña en el repositorio.
