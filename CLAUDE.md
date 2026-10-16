# Contexto del proyecto

- Software de gestión operativa del Cementerio San Vicente Parque (Dirección de Cementerios, Municipalidad de Córdoba).
- Roles: Director y Capataces (para ingresar solo se ofrecen esos; se sacó el operario). Los tableros (resumen, zonas, alertas, registro firmado) los ven todos y todos arrancan en el mismo Resumen; los Ajustes, solo directivos. Registrar tareas y descargas es de capataces/operarios.
- Organización (pedida por el dueño): **Fosas** = Parque (zonas 1 a 28), zonas COVID (29 y 30), Sección Vieja (fosas) y Sección Nueva. **Nichos** = Pabellón Amarillo, Central, Lateral y Sección Vieja (nichos). No hay "sectores especiales" (se sacaron Horno Crematorio, Cementerio Israelita, Memorial y Osario).
- El dueño del proyecto no tiene conocimientos técnicos: hablarle en español rioplatense, sin jerga técnica.
- Archivos actuales:
  - `index.html` + `app.js` + `estilos.css` (+ `manifest.webmanifest`, `icono.svg`): la app web, sin dependencias externas. Hoy funciona en **modo demostración**: datos de ejemplo guardados en el navegador (localStorage); la capa `Datos` de `app.js` es la que se reemplaza por la API cuando haya servidor y base. Usuarios demo (Director, Capataz A y Capataz B) con PIN 1234.
  - `esquema.sql`: base de datos PostgreSQL + PostGIS.
  - `openapi.yaml`: contratos de la API.
  - `README.md`: arquitectura, alertas y diagramas (Mermaid).
  - `documento.html`: el README como página (generada, no editar a mano). Después de cambiar el README: `cd herramientas && npm install && npm run pagina`. Mermaid va en `vendor/`.
- Se publica en Vercel como sitio estático (proyecto `cementeriosanvicente1`, toma la rama `main`).
- Los plazos de mantenimiento y los umbrales de stock son provisorios hasta confirmarlos con el plano y la Dirección.
- Nunca escribir contraseñas ni cadenas de conexión con contraseña en el repositorio.
