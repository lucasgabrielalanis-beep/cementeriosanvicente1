# Contexto del proyecto

- Software de gestión operativa del Cementerio San Vicente Parque (Dirección de Cementerios, Municipalidad de Córdoba).
- Roles: Directivos (tablero, analíticas, alertas de capacidad) y Capataces/Operarios (trabajo en campo).
- El dueño del proyecto no tiene conocimientos técnicos: hablarle en español rioplatense, sin jerga técnica.
- Archivos actuales (etapa de diseño):
  - `esquema.sql`: base de datos PostgreSQL + PostGIS.
  - `openapi.yaml`: contratos de la API.
  - `README.md`: arquitectura, alertas y diagramas (Mermaid).
  - `index.html`: página generada desde el README (no editar a mano). Después de cambiar el README: `cd herramientas && npm install && npm run pagina`. No depende de sitios externos (mermaid va en `vendor/`).
- El tipo de cada zona (1 a 28), los plazos de mantenimiento y los umbrales de stock son provisorios hasta confirmarlos con el plano y la Dirección.
- Nunca escribir contraseñas ni cadenas de conexión con contraseña en el repositorio.
