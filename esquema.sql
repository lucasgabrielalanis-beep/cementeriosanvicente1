-- =============================================================================
-- Cementerio San Vicente Parque — Dirección de Cementerios, Municipalidad de Córdoba
-- Esquema de base de datos (PostgreSQL 14+ / PostGIS 3+)
--
-- Contenido:
--   0. Extensiones y esquema
--   1. Tipos ENUM
--   2. Usuarios, roles y dispositivos de campo
--   3. Topología: zonas y puntos de referencia (PostGIS, SRID 4326)
--   4. Espacios de sepultura (nichos y fosas) + historial de estados
--   5. Firma digital y cadena de auditoría (append-only, encadenada por hash)
--   6. Mantenimiento: reglas de frecuencia, temporada de lluvias, tareas
--   7. Operaciones de sepultura (inhumación / descarga de nicho o fosa, etc.)
--   8. Alertas: umbrales de stock y registro de alertas
--   9. Vistas: semáforo de zonas y resumen de disponibilidad
--  10. Funciones transaccionales y triggers
--  11. Datos iniciales (Parque zonas 1–28, zonas COVID 29–30, sectores de fosas y nichos, puntos de referencia)
--
-- Convenciones:
--   * Toda marca de tiempo es TIMESTAMPTZ. La hora "oficial" de un registro es
--     la del servidor (registrado_en); la del dispositivo se guarda aparte.
--   * Las tablas de trazabilidad (firmas_digitales, auditoria_eventos,
--     operaciones_sepultura, historial_estados_espacio) son append-only:
--     un trigger impide UPDATE y DELETE. Las correcciones se hacen con un
--     nuevo registro que anula al anterior (campo anula_operacion_id).
-- =============================================================================

BEGIN;

-- 0. Extensiones y esquema ----------------------------------------------------
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;      -- gen_random_uuid(), digest()
CREATE EXTENSION IF NOT EXISTS citext;

CREATE SCHEMA IF NOT EXISTS cementerio;
SET search_path = cementerio, public;

-- 1. Tipos ENUM ---------------------------------------------------------------
CREATE TYPE rol_usuario        AS ENUM ('directivo', 'capataz', 'operario');
CREATE TYPE tipo_zona          AS ENUM ('parque_fosas', 'nichos', 'mixta', 'especial');
CREATE TYPE categoria_sector   AS ENUM (
  'parque',             -- zonas 1 a 28 (fosas)
  'covid',              -- zonas 29 y 30 (fosas)
  'seccion_vieja',      -- tiene un sector de fosas y otro de nichos
  'seccion_nueva',      -- fosas
  'pabellon_amarillo',  -- nichos
  'central',            -- nichos
  'lateral',            -- nichos
  'otro');
CREATE TYPE tipo_punto_ref     AS ENUM (
  'acceso', 'administracion', 'cruz_mayor', 'rotonda', 'osario', 'memorial',
  'banos', 'deposito_herramientas', 'canilla', 'calle', 'pasaje', 'otro');
CREATE TYPE tipo_espacio       AS ENUM ('nicho', 'fosa');
CREATE TYPE tipo_tamano        AS ENUM ('normal', 'extraordinario');
CREATE TYPE estado_espacio     AS ENUM (
  'disponible', 'ocupado', 'en_mantenimiento', 'reservado', 'inhabilitado');
CREATE TYPE tipo_tarea_mant    AS ENUM (
  'corte_cesped', 'limpieza_calles', 'recoleccion_residuos', 'relleno_fosas',
  'pintura', 'poda', 'limpieza_general', 'reparacion_nicho', 'otro');
CREATE TYPE estado_tarea       AS ENUM (
  'programada', 'asignada', 'en_curso', 'completada', 'cancelada');
CREATE TYPE tipo_operacion     AS ENUM (
  'inhumacion',          -- descarga en fosa o nicho
  'exhumacion',
  'reduccion',
  'traslado_interno',
  'traslado_osario',
  'cremacion',
  'reserva',
  'liberacion_reserva',
  'anulacion');          -- corrige una operación previa (append-only)
CREATE TYPE color_semaforo     AS ENUM ('verde', 'amarillo', 'rojo_critico');
CREATE TYPE metodo_firma       AS ENUM (
  'firma_dispositivo_ecdsa',   -- clave privada no exportable en el dispositivo (WebCrypto)
  'pin_reautenticacion',       -- el operario confirma con su PIN personal
  'firma_manuscrita',          -- trazo en pantalla (se guarda hash + imagen)
  'certificado_x509');         -- firma digital con certificado (Ley 25.506), si se incorpora
CREATE TYPE nivel_alerta       AS ENUM ('info', 'advertencia', 'critica');
CREATE TYPE tipo_alerta        AS ENUM (
  'stock_bajo', 'stock_critico', 'mantenimiento_vencido', 'mantenimiento_critico',
  'firma_invalida', 'sincronizacion_tardia');

-- 2. Usuarios, roles y dispositivos -------------------------------------------
CREATE TABLE usuarios (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  legajo           TEXT UNIQUE NOT NULL,               -- legajo municipal
  nombre_completo  TEXT NOT NULL,
  dni              TEXT UNIQUE,
  email            CITEXT UNIQUE,
  rol              rol_usuario NOT NULL,
  pin_hash         TEXT,                               -- bcrypt/argon2; nunca el PIN en claro
  password_hash    TEXT,
  activo           BOOLEAN NOT NULL DEFAULT TRUE,
  creado_en        TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_en   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Dispositivos enrolados (celulares/tablets de capataces). La clave pública
-- permite verificar en el servidor la firma generada en el dispositivo.
CREATE TABLE dispositivos (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id           UUID NOT NULL REFERENCES usuarios(id),
  descripcion          TEXT,
  clave_publica_jwk    JSONB NOT NULL,                 -- ECDSA P-256 en formato JWK
  huella_clave         TEXT NOT NULL UNIQUE,           -- SHA-256 de la clave pública
  enrolado_por         UUID NOT NULL REFERENCES usuarios(id),
  enrolado_en          TIMESTAMPTZ NOT NULL DEFAULT now(),
  revocado_en          TIMESTAMPTZ,
  motivo_revocacion    TEXT
);
CREATE INDEX idx_dispositivos_usuario ON dispositivos(usuario_id) WHERE revocado_en IS NULL;

-- 3. Topología ----------------------------------------------------------------
CREATE TABLE zonas (
  id               SMALLSERIAL PRIMARY KEY,
  codigo           TEXT NOT NULL UNIQUE,              -- 'Z01'..'Z28', 'SV_FOSAS', 'SN_FOSAS', 'PAB_AMARILLO', 'CENTRAL', 'LATERAL', 'SV_NICHOS'
  numero           SMALLINT UNIQUE CHECK (numero BETWEEN 1 AND 30),
  nombre           TEXT NOT NULL,
  categoria        categoria_sector NOT NULL,
  tipo             tipo_zona NOT NULL,
  geom             geometry(MultiPolygon, 4326),       -- se carga al digitalizar el plano
  superficie_m2    NUMERIC(12,2) GENERATED ALWAYS AS (ST_Area(geom::geography)) STORED,
  requiere_corte_cesped BOOLEAN NOT NULL DEFAULT TRUE,
  activa           BOOLEAN NOT NULL DEFAULT TRUE,
  observaciones    TEXT,
  CONSTRAINT zona_numerada_tiene_numero
    CHECK ((categoria IN ('parque', 'covid')) = (numero IS NOT NULL))
);
CREATE INDEX idx_zonas_geom ON zonas USING GIST (geom);

CREATE TABLE puntos_referencia (
  id               SERIAL PRIMARY KEY,
  tipo             tipo_punto_ref NOT NULL,
  nombre           TEXT NOT NULL,                     -- 'Ingreso Calle Soto', 'Cruz Mayor'...
  zona_id          SMALLINT REFERENCES zonas(id),     -- zona donde cae (si corresponde)
  geom             geometry(Point, 4326),
  descripcion      TEXT,
  UNIQUE (tipo, nombre)
);
CREATE INDEX idx_puntos_ref_geom ON puntos_referencia USING GIST (geom);

-- Asignación de capataces/operarios a zonas (vigencia por fechas).
CREATE TABLE asignaciones_zona (
  id               SERIAL PRIMARY KEY,
  usuario_id       UUID NOT NULL REFERENCES usuarios(id),
  zona_id          SMALLINT NOT NULL REFERENCES zonas(id),
  es_responsable   BOOLEAN NOT NULL DEFAULT FALSE,    -- capataz a cargo de la zona
  desde            DATE NOT NULL DEFAULT current_date,
  hasta            DATE,
  CHECK (hasta IS NULL OR hasta >= desde)
);
CREATE INDEX idx_asig_zona_vigente ON asignaciones_zona(zona_id, usuario_id) WHERE hasta IS NULL;

-- 4. Espacios de sepultura ----------------------------------------------------
-- Bloques de la Sección Vieja (nichos), según el plano: sector, cuadro (letra),
-- número de bloque y "Prop." tal como figura en el plano.
CREATE TABLE bloques_seccion (
  id               SERIAL PRIMARY KEY,
  zona_id          SMALLINT NOT NULL REFERENCES zonas(id),
  sector           TEXT NOT NULL,                     -- 'Fila 1', 'Sector superior (zona norte)'...
  cuadro           TEXT,                              -- letra: A, B, C... (puede repetirse en distintos bloques)
  nombre           TEXT,                              -- 'Pabellón Ferroviario Julio Juárez', 'Central', 'Osario'...
  bloque           SMALLINT CHECK (bloque > 0),
  prop             SMALLINT,
  nota             TEXT,
  tiene_nichos     BOOLEAN NOT NULL DEFAULT TRUE,
  orden            SMALLINT NOT NULL,
  CHECK (cuadro IS NOT NULL OR nombre IS NOT NULL)
);
CREATE INDEX idx_bloques_zona ON bloques_seccion(zona_id, orden);

CREATE TABLE espacios_sepultura (
  id               BIGSERIAL PRIMARY KEY,
  zona_id          SMALLINT NOT NULL REFERENCES zonas(id),
  tipo_espacio     tipo_espacio NOT NULL,
  tipo_tamano      tipo_tamano  NOT NULL DEFAULT 'normal',
  estado           estado_espacio NOT NULL DEFAULT 'disponible',
  -- Nichos: pabellón/bloque + nivel (fila vertical) + columna.
  -- En la Sección Vieja: bloque del plano (bloques_seccion) + número de nicho.
  bloque_id        INTEGER REFERENCES bloques_seccion(id),
  pabellon         TEXT,
  nivel            SMALLINT CHECK (nivel BETWEEN 1 AND 12),
  columna          SMALLINT CHECK (columna > 0),
  -- Fosas: en las zonas 1 a 30 se ubican por zona + cuadro (1 a 40) + fosa;
  -- en las secciones, por sección + fila + número.
  cuadro           SMALLINT CHECK (cuadro BETWEEN 1 AND 40),
  seccion          TEXT,
  fila             SMALLINT CHECK (fila > 0),
  numero           INTEGER CHECK (numero > 0),
  codigo           TEXT GENERATED ALWAYS AS (
                     CASE WHEN tipo_espacio = 'nicho' AND bloque_id IS NOT NULL
                          THEN 'N-' || zona_id || '-B' || bloque_id || '-' || numero
                          WHEN tipo_espacio = 'nicho'
                          THEN 'N-' || zona_id || '-' || coalesce(pabellon,'') || '-' || nivel || '-' || columna
                          WHEN cuadro IS NOT NULL
                          THEN 'F-' || zona_id || '-C' || cuadro || '-' || numero
                          ELSE 'F-' || zona_id || '-' || coalesce(seccion,'') || '-' || fila || '-' || numero END
                   ) STORED,
  geom             geometry(Point, 4326),
  reservado_hasta  TIMESTAMPTZ,
  motivo_inhabilitacion TEXT,
  version          INTEGER NOT NULL DEFAULT 1,        -- control de concurrencia optimista
  creado_en        TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_en   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT nicho_ubicacion CHECK (
    tipo_espacio <> 'nicho' OR (nivel IS NOT NULL AND columna IS NOT NULL)
                            OR (bloque_id IS NOT NULL AND numero IS NOT NULL)),
  CONSTRAINT bloque_solo_nichos CHECK (bloque_id IS NULL OR tipo_espacio = 'nicho'),
  CONSTRAINT fosa_ubicacion CHECK (
    tipo_espacio <> 'fosa' OR (numero IS NOT NULL AND (cuadro IS NOT NULL OR fila IS NOT NULL))),
  CONSTRAINT cuadro_solo_fosas CHECK (cuadro IS NULL OR tipo_espacio = 'fosa'),
  CONSTRAINT reserva_con_vencimiento CHECK (
    estado <> 'reservado' OR reservado_hasta IS NOT NULL),
  CONSTRAINT inhabilitado_con_motivo CHECK (
    estado <> 'inhabilitado' OR motivo_inhabilitacion IS NOT NULL),
  CONSTRAINT espacio_unico UNIQUE NULLS NOT DISTINCT
    (zona_id, tipo_espacio, bloque_id, pabellon, nivel, columna, cuadro, seccion, fila, numero)
);
-- Índice principal del filtro de disponibilidad y del resumen de stock
CREATE INDEX idx_espacios_filtro ON espacios_sepultura (tipo_espacio, tipo_tamano, zona_id, estado);
CREATE INDEX idx_espacios_disponibles ON espacios_sepultura (zona_id, tipo_espacio, tipo_tamano)
  WHERE estado = 'disponible';
CREATE INDEX idx_espacios_geom ON espacios_sepultura USING GIST (geom);

CREATE TABLE historial_estados_espacio (
  id               BIGSERIAL PRIMARY KEY,
  espacio_id       BIGINT NOT NULL REFERENCES espacios_sepultura(id),
  estado_anterior  estado_espacio,
  estado_nuevo     estado_espacio NOT NULL,
  operacion_id     UUID,                              -- operación que provocó el cambio (si hubo)
  cambiado_por     UUID REFERENCES usuarios(id),
  cambiado_en      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_hist_espacio ON historial_estados_espacio(espacio_id, cambiado_en DESC);

-- Persona fallecida (datos mínimos para trazabilidad de la operación).
CREATE TABLE difuntos (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  apellido_nombre  TEXT NOT NULL,
  dni              TEXT,
  fecha_defuncion  DATE NOT NULL,
  acta_defuncion   TEXT,                              -- nro. de acta del Registro Civil
  creado_en        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_difuntos_dni ON difuntos(dni);

-- 5. Firma digital y auditoría ------------------------------------------------
-- Cada acción de campo genera UNA firma. La firma prueba:
--   QUIÉN  -> usuario_id (sesión) + dispositivo_id (clave enrolada) + PIN
--   CUÁNDO -> firmado_en_cliente (dispositivo) y registrado_en (servidor, autoritativo)
--   QUÉ    -> payload_sha256 = SHA-256 del JSON canónico de la acción
--   DÓNDE  -> ubicacion (GPS del dispositivo) + precisión
-- Además se encadena con la firma anterior (hash_anterior -> hash_registro),
-- de modo que alterar cualquier registro rompe la cadena y se detecta.
CREATE TABLE firmas_digitales (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  secuencia           BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
  usuario_id          UUID NOT NULL REFERENCES usuarios(id),
  dispositivo_id      UUID REFERENCES dispositivos(id),
  metodos             metodo_firma[] NOT NULL CHECK (cardinality(metodos) >= 1),
  algoritmo           TEXT NOT NULL DEFAULT 'ES256',
  payload_canonico    JSONB NOT NULL,                  -- lo que se firmó, tal cual
  payload_sha256      TEXT NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  firma_base64        TEXT,                            -- firma ECDSA del payload_sha256
  firma_manuscrita_sha256 TEXT,                        -- hash de la imagen del trazo
  firma_manuscrita_url TEXT,                           -- objeto en storage (solo lectura)
  nonce               TEXT NOT NULL UNIQUE,            -- anti-replay
  firmado_en_cliente  TIMESTAMPTZ NOT NULL,
  registrado_en       TIMESTAMPTZ NOT NULL DEFAULT now(),
  sincronizado_offline BOOLEAN NOT NULL DEFAULT FALSE, -- se firmó sin señal y se subió después
  ubicacion           geometry(Point, 4326),
  precision_gps_m     NUMERIC(7,2),
  ip_origen           INET,
  user_agent          TEXT,
  verificada          BOOLEAN NOT NULL,                -- resultado de la verificación en servidor
  hash_anterior       TEXT,
  hash_registro       TEXT NOT NULL UNIQUE,
  CONSTRAINT firma_dispositivo_requiere_firma CHECK (
    NOT ('firma_dispositivo_ecdsa' = ANY(metodos)) OR (dispositivo_id IS NOT NULL AND firma_base64 IS NOT NULL)),
  CONSTRAINT firma_manuscrita_requiere_hash CHECK (
    NOT ('firma_manuscrita' = ANY(metodos)) OR firma_manuscrita_sha256 IS NOT NULL)
);
CREATE INDEX idx_firmas_usuario ON firmas_digitales(usuario_id, registrado_en DESC);

-- Bitácora general (quién cambió qué y cuándo), también encadenada por hash.
CREATE TABLE auditoria_eventos (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ocurrido_en      TIMESTAMPTZ NOT NULL DEFAULT now(),
  usuario_id       UUID,                               -- current_setting('app.usuario_id')
  tabla            TEXT NOT NULL,
  registro_id      TEXT NOT NULL,
  accion           TEXT NOT NULL CHECK (accion IN ('INSERT','UPDATE','DELETE')),
  datos_antes      JSONB,
  datos_despues    JSONB,
  hash_anterior    TEXT,
  hash_registro    TEXT NOT NULL
);
CREATE INDEX idx_auditoria_registro ON auditoria_eventos(tabla, registro_id);
CREATE INDEX idx_auditoria_fecha ON auditoria_eventos(ocurrido_en DESC);

-- 6. Mantenimiento ------------------------------------------------------------
-- Plazos por tipo de tarea (y opcionalmente por zona). Si hay regla para la
-- zona, gana sobre la regla general (zona_id NULL).
CREATE TABLE reglas_mantenimiento (
  id               SERIAL PRIMARY KEY,
  tipo_tarea       tipo_tarea_mant NOT NULL,
  zona_id          SMALLINT REFERENCES zonas(id),
  dias_verde       SMALLINT NOT NULL CHECK (dias_verde > 0),     -- hasta acá: verde
  dias_rojo        SMALLINT NOT NULL,                            -- más de esto: rojo crítico
  pondera_lluvia   BOOLEAN NOT NULL DEFAULT TRUE,                -- aplica factor de temporada
  CHECK (dias_rojo > dias_verde),
  UNIQUE NULLS NOT DISTINCT (tipo_tarea, zona_id)
);

-- Temporada de lluvias (en Córdoba, aprox. noviembre–marzo): el pasto crece
-- más rápido y los plazos se acortan multiplicándolos por "factor_plazos".
CREATE TABLE temporadas_climaticas (
  id               SERIAL PRIMARY KEY,
  nombre           TEXT NOT NULL,
  desde            DATE NOT NULL,
  hasta            DATE NOT NULL,
  factor_plazos    NUMERIC(3,2) NOT NULL CHECK (factor_plazos > 0 AND factor_plazos <= 1),
  CHECK (hasta >= desde)
);

CREATE TABLE mantenimiento_tareas (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  zona_id          SMALLINT NOT NULL REFERENCES zonas(id),
  espacio_id       BIGINT REFERENCES espacios_sepultura(id), -- si la tarea es sobre un nicho/fosa puntual
  tipo_tarea       tipo_tarea_mant NOT NULL,
  estado           estado_tarea NOT NULL DEFAULT 'programada',
  programada_para  DATE,
  asignada_a       UUID REFERENCES usuarios(id),
  asignada_por     UUID REFERENCES usuarios(id),
  iniciada_en      TIMESTAMPTZ,
  -- Trazabilidad obligatoria al completar:
  completada_en    TIMESTAMPTZ,                        -- hora del servidor al registrar
  ejecutada_por    UUID REFERENCES usuarios(id),       -- quién la hizo
  supervisada_por  UUID REFERENCES usuarios(id),       -- capataz que da conformidad (opcional)
  firma_id         UUID UNIQUE REFERENCES firmas_digitales(id),
  ubicacion_cierre geometry(Point, 4326),
  porcentaje_zona  SMALLINT CHECK (porcentaje_zona BETWEEN 1 AND 100), -- cobertura parcial
  observaciones    TEXT,
  fotos_urls       TEXT[] NOT NULL DEFAULT '{}',
  idempotency_key  TEXT UNIQUE,                        -- reintentos desde cola offline
  creado_en        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT completada_con_trazabilidad CHECK (
    estado <> 'completada'
    OR (completada_en IS NOT NULL AND ejecutada_por IS NOT NULL AND firma_id IS NOT NULL))
);
CREATE INDEX idx_tareas_semaforo ON mantenimiento_tareas (zona_id, tipo_tarea, completada_en DESC)
  WHERE estado = 'completada';
CREATE INDEX idx_tareas_pendientes ON mantenimiento_tareas (asignada_a, estado)
  WHERE estado IN ('programada','asignada','en_curso');

-- 7. Operaciones de sepultura -------------------------------------------------
CREATE TABLE operaciones_sepultura (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tipo_operacion   tipo_operacion NOT NULL,
  espacio_id       BIGINT NOT NULL REFERENCES espacios_sepultura(id),
  espacio_destino_id BIGINT REFERENCES espacios_sepultura(id),  -- traslados
  difunto_id       UUID REFERENCES difuntos(id),
  expediente       TEXT,                               -- nro. de expediente / orden municipal
  -- Trazabilidad obligatoria:
  ejecutada_por    UUID NOT NULL REFERENCES usuarios(id),
  supervisada_por  UUID REFERENCES usuarios(id),
  realizada_en     TIMESTAMPTZ NOT NULL,               -- hora informada por el dispositivo
  registrada_en    TIMESTAMPTZ NOT NULL DEFAULT now(), -- hora del servidor (autoritativa)
  firma_id         UUID NOT NULL UNIQUE REFERENCES firmas_digitales(id),
  ubicacion        geometry(Point, 4326),
  anula_operacion_id UUID REFERENCES operaciones_sepultura(id),
  observaciones    TEXT,
  idempotency_key  TEXT UNIQUE,
  CONSTRAINT inhumacion_con_difunto CHECK (
    tipo_operacion NOT IN ('inhumacion','exhumacion','reduccion','cremacion') OR difunto_id IS NOT NULL),
  CONSTRAINT anulacion_referencia CHECK (
    (tipo_operacion = 'anulacion') = (anula_operacion_id IS NOT NULL)),
  CONSTRAINT traslado_con_destino CHECK (
    tipo_operacion <> 'traslado_interno' OR espacio_destino_id IS NOT NULL)
);
CREATE INDEX idx_operaciones_espacio ON operaciones_sepultura(espacio_id, registrada_en DESC);
CREATE INDEX idx_operaciones_operario ON operaciones_sepultura(ejecutada_por, registrada_en DESC);
CREATE INDEX idx_operaciones_difunto ON operaciones_sepultura(difunto_id);

-- 8. Alertas ------------------------------------------------------------------
-- Umbrales de stock. zona_id NULL = umbral global para todo el predio.
CREATE TABLE umbrales_stock (
  id               SERIAL PRIMARY KEY,
  tipo_espacio     tipo_espacio NOT NULL,
  tipo_tamano      tipo_tamano  NOT NULL,
  zona_id          SMALLINT REFERENCES zonas(id),
  umbral_advertencia INTEGER NOT NULL CHECK (umbral_advertencia >= 0),
  umbral_critico   INTEGER NOT NULL CHECK (umbral_critico >= 0),
  -- Opcional: alerta por días de cobertura según consumo de los últimos 90 días
  dias_cobertura_critico SMALLINT CHECK (dias_cobertura_critico > 0),
  actualizado_por  UUID REFERENCES usuarios(id),
  actualizado_en   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (umbral_advertencia > umbral_critico),
  UNIQUE NULLS NOT DISTINCT (tipo_espacio, tipo_tamano, zona_id)
);

CREATE TABLE alertas (
  id               BIGSERIAL PRIMARY KEY,
  tipo             tipo_alerta NOT NULL,
  nivel            nivel_alerta NOT NULL,
  zona_id          SMALLINT REFERENCES zonas(id),
  tipo_espacio     tipo_espacio,
  tipo_tamano      tipo_tamano,
  titulo           TEXT NOT NULL,
  detalle          JSONB NOT NULL DEFAULT '{}',
  creada_en        TIMESTAMPTZ NOT NULL DEFAULT now(),
  reconocida_por   UUID REFERENCES usuarios(id),
  reconocida_en    TIMESTAMPTZ,
  resuelta_en      TIMESTAMPTZ,
  -- clave lógica para no duplicar alertas abiertas iguales
  clave            TEXT NOT NULL
);
CREATE UNIQUE INDEX uq_alerta_abierta ON alertas(clave) WHERE resuelta_en IS NULL;
CREATE INDEX idx_alertas_abiertas ON alertas(nivel, creada_en DESC) WHERE resuelta_en IS NULL;

-- 9. Vistas -------------------------------------------------------------------
-- Factor climático vigente hoy (1.00 si no hay temporada activa).
CREATE OR REPLACE FUNCTION factor_climatico(p_fecha DATE DEFAULT current_date)
RETURNS NUMERIC LANGUAGE sql STABLE AS $$
  SELECT coalesce(min(factor_plazos), 1.00)
  FROM temporadas_climaticas WHERE p_fecha BETWEEN desde AND hasta;
$$;

-- Semáforo por zona y tipo de tarea.
CREATE OR REPLACE VIEW v_semaforo_zona_tarea AS
WITH reglas AS (
  SELECT z.id AS zona_id, t.tipo_tarea,
         coalesce(rz.dias_verde, rg.dias_verde) AS dias_verde,
         coalesce(rz.dias_rojo,  rg.dias_rojo)  AS dias_rojo,
         coalesce(rz.pondera_lluvia, rg.pondera_lluvia) AS pondera_lluvia
  FROM zonas z
  CROSS JOIN (SELECT DISTINCT tipo_tarea FROM reglas_mantenimiento) t
  LEFT JOIN reglas_mantenimiento rz ON rz.zona_id = z.id AND rz.tipo_tarea = t.tipo_tarea
  LEFT JOIN reglas_mantenimiento rg ON rg.zona_id IS NULL AND rg.tipo_tarea = t.tipo_tarea
  WHERE z.activa
    AND (t.tipo_tarea <> 'corte_cesped' OR z.requiere_corte_cesped)
), ultima AS (
  SELECT zona_id, tipo_tarea, max(completada_en) AS ultima_ejecucion
  FROM mantenimiento_tareas WHERE estado = 'completada'
  GROUP BY zona_id, tipo_tarea
), calc AS (
  SELECT r.*, u.ultima_ejecucion,
         CASE WHEN r.pondera_lluvia THEN factor_climatico() ELSE 1.00 END AS factor,
         EXTRACT(EPOCH FROM (now() - u.ultima_ejecucion)) / 86400.0 AS dias_transcurridos
  FROM reglas r LEFT JOIN ultima u USING (zona_id, tipo_tarea)
  WHERE r.dias_verde IS NOT NULL
)
SELECT zona_id, tipo_tarea, ultima_ejecucion,
       round(dias_transcurridos::numeric, 1)          AS dias_transcurridos,
       round(dias_verde * factor, 1)                  AS limite_verde_dias,
       round(dias_rojo  * factor, 1)                  AS limite_rojo_dias,
       factor                                         AS factor_climatico,
       CASE
         WHEN ultima_ejecucion IS NULL                THEN 'rojo_critico'::color_semaforo
         WHEN dias_transcurridos <= dias_verde * factor THEN 'verde'::color_semaforo
         WHEN dias_transcurridos <= dias_rojo  * factor THEN 'amarillo'::color_semaforo
         ELSE 'rojo_critico'::color_semaforo
       END AS color
FROM calc;

-- Semáforo consolidado: el color de la zona es el peor de sus tareas.
CREATE OR REPLACE VIEW v_semaforo_zonas AS
SELECT z.id AS zona_id, z.codigo, z.numero, z.nombre, z.categoria, z.tipo,
       coalesce(max(s.color), 'verde'::color_semaforo) AS color,   -- orden del ENUM: verde < amarillo < rojo
       jsonb_agg(jsonb_build_object(
         'tipo_tarea', s.tipo_tarea, 'color', s.color,
         'ultima_ejecucion', s.ultima_ejecucion,
         'dias_transcurridos', s.dias_transcurridos,
         'limite_verde_dias', s.limite_verde_dias,
         'limite_rojo_dias', s.limite_rojo_dias)
         ORDER BY s.color DESC) FILTER (WHERE s.tipo_tarea IS NOT NULL) AS detalle
FROM zonas z
LEFT JOIN v_semaforo_zona_tarea s ON s.zona_id = z.id
WHERE z.activa
GROUP BY z.id;

-- Stock por tipo/tamaño (global) con nivel de alerta.
CREATE OR REPLACE VIEW v_disponibilidad_resumen AS
WITH conteo AS (
  SELECT tipo_espacio, tipo_tamano,
         count(*) FILTER (WHERE estado = 'disponible')       AS disponibles,
         count(*) FILTER (WHERE estado = 'ocupado')          AS ocupados,
         count(*) FILTER (WHERE estado = 'reservado')        AS reservados,
         count(*) FILTER (WHERE estado = 'en_mantenimiento') AS en_mantenimiento,
         count(*) FILTER (WHERE estado = 'inhabilitado')     AS inhabilitados,
         count(*)                                            AS total
  FROM espacios_sepultura GROUP BY tipo_espacio, tipo_tamano
), consumo AS (
  SELECT e.tipo_espacio, e.tipo_tamano, count(*) / 90.0 AS consumo_diario
  FROM operaciones_sepultura o JOIN espacios_sepultura e ON e.id = o.espacio_id
  WHERE o.tipo_operacion = 'inhumacion' AND o.registrada_en >= now() - interval '90 days'
  GROUP BY 1, 2
)
SELECT c.*, u.umbral_advertencia, u.umbral_critico,
       round(coalesce(k.consumo_diario, 0), 2) AS consumo_diario_90d,
       CASE WHEN coalesce(k.consumo_diario, 0) > 0
            THEN floor(c.disponibles / k.consumo_diario) END AS dias_cobertura_estimados,
       CASE
         WHEN u.id IS NULL                                  THEN 'info'::nivel_alerta
         WHEN c.disponibles <= u.umbral_critico
           OR (u.dias_cobertura_critico IS NOT NULL AND k.consumo_diario > 0
               AND c.disponibles / k.consumo_diario <= u.dias_cobertura_critico)
                                                            THEN 'critica'::nivel_alerta
         WHEN c.disponibles <= u.umbral_advertencia         THEN 'advertencia'::nivel_alerta
         ELSE 'info'::nivel_alerta
       END AS nivel_alerta
FROM conteo c
LEFT JOIN umbrales_stock u ON u.tipo_espacio = c.tipo_espacio AND u.tipo_tamano = c.tipo_tamano AND u.zona_id IS NULL
LEFT JOIN consumo k ON k.tipo_espacio = c.tipo_espacio AND k.tipo_tamano = c.tipo_tamano;

-- 10. Funciones y triggers ----------------------------------------------------

-- 10.1 Append-only: bloquea UPDATE/DELETE en tablas de trazabilidad.
CREATE OR REPLACE FUNCTION trg_inmutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'La tabla % es de solo agregado: no se permite %', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END $$;

CREATE TRIGGER firmas_inmutables      BEFORE UPDATE OR DELETE ON firmas_digitales
  FOR EACH ROW EXECUTE FUNCTION trg_inmutable();
CREATE TRIGGER auditoria_inmutable    BEFORE UPDATE OR DELETE ON auditoria_eventos
  FOR EACH ROW EXECUTE FUNCTION trg_inmutable();
CREATE TRIGGER operaciones_inmutables BEFORE UPDATE OR DELETE ON operaciones_sepultura
  FOR EACH ROW EXECUTE FUNCTION trg_inmutable();
CREATE TRIGGER historial_inmutable    BEFORE UPDATE OR DELETE ON historial_estados_espacio
  FOR EACH ROW EXECUTE FUNCTION trg_inmutable();

-- Una tarea completada no se puede volver a editar (sí se puede cargar otra).
CREATE OR REPLACE FUNCTION trg_tarea_cerrada() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.estado = 'completada' THEN
    RAISE EXCEPTION 'La tarea % ya fue completada y firmada; no se puede modificar', OLD.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER tarea_cerrada BEFORE UPDATE OR DELETE ON mantenimiento_tareas
  FOR EACH ROW EXECUTE FUNCTION trg_tarea_cerrada();

-- 10.2 Encadenamiento por hash de firmas (serializado con un advisory lock).
CREATE OR REPLACE FUNCTION trg_firma_encadenar() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('cementerio.firmas_digitales'));
  SELECT hash_registro INTO NEW.hash_anterior
    FROM firmas_digitales ORDER BY secuencia DESC LIMIT 1;
  NEW.registrado_en := now();
  NEW.hash_registro := encode(digest(
      coalesce(NEW.hash_anterior, 'GENESIS') || '|' || NEW.id::text || '|' ||
      NEW.usuario_id::text || '|' || NEW.payload_sha256 || '|' ||
      coalesce(NEW.firma_base64, '') || '|' || NEW.registrado_en::text, 'sha256'), 'hex');
  RETURN NEW;
END $$;
CREATE TRIGGER firma_encadenar BEFORE INSERT ON firmas_digitales
  FOR EACH ROW EXECUTE FUNCTION trg_firma_encadenar();

-- 10.3 Auditoría genérica encadenada.
CREATE OR REPLACE FUNCTION trg_auditar() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_prev TEXT; v_antes JSONB; v_despues JSONB; v_id TEXT; v_usuario UUID;
BEGIN
  v_antes   := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN to_jsonb(OLD) END;
  v_despues := CASE WHEN TG_OP IN ('UPDATE','INSERT') THEN to_jsonb(NEW) END;
  v_id      := coalesce(v_despues->>'id', v_antes->>'id');
  v_usuario := nullif(current_setting('app.usuario_id', true), '')::uuid;
  PERFORM pg_advisory_xact_lock(hashtext('cementerio.auditoria_eventos'));
  SELECT hash_registro INTO v_prev FROM auditoria_eventos ORDER BY id DESC LIMIT 1;
  INSERT INTO auditoria_eventos(usuario_id, tabla, registro_id, accion, datos_antes, datos_despues,
                                hash_anterior, hash_registro)
  VALUES (v_usuario, TG_TABLE_NAME, v_id, TG_OP, v_antes, v_despues, v_prev,
          encode(digest(coalesce(v_prev,'GENESIS') || '|' || TG_TABLE_NAME || '|' || v_id || '|' ||
                        TG_OP || '|' || coalesce(v_despues::text, v_antes::text) || '|' || now()::text,
                        'sha256'), 'hex'));
  RETURN NULL;
END $$;

CREATE TRIGGER auditar_espacios  AFTER INSERT OR UPDATE OR DELETE ON espacios_sepultura
  FOR EACH ROW EXECUTE FUNCTION trg_auditar();
CREATE TRIGGER auditar_tareas    AFTER INSERT OR UPDATE OR DELETE ON mantenimiento_tareas
  FOR EACH ROW EXECUTE FUNCTION trg_auditar();
CREATE TRIGGER auditar_umbrales  AFTER INSERT OR UPDATE OR DELETE ON umbrales_stock
  FOR EACH ROW EXECUTE FUNCTION trg_auditar();
CREATE TRIGGER auditar_usuarios  AFTER INSERT OR UPDATE OR DELETE ON usuarios
  FOR EACH ROW EXECUTE FUNCTION trg_auditar();

-- 10.4 Historial de estado de espacios + versión + reevaluación de stock.
CREATE OR REPLACE FUNCTION trg_espacio_estado() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.estado IS DISTINCT FROM OLD.estado THEN
    INSERT INTO historial_estados_espacio(espacio_id, estado_anterior, estado_nuevo, operacion_id, cambiado_por)
    VALUES (NEW.id, OLD.estado, NEW.estado,
            nullif(current_setting('app.operacion_id', true), '')::uuid,
            nullif(current_setting('app.usuario_id', true), '')::uuid);
  END IF;
  NEW.version := OLD.version + 1;
  NEW.actualizado_en := now();
  RETURN NEW;
END $$;
CREATE TRIGGER espacio_estado BEFORE UPDATE ON espacios_sepultura
  FOR EACH ROW EXECUTE FUNCTION trg_espacio_estado();

-- 10.4 bis Un nicho solo puede estar en una zona de nichos y una fosa en una de
-- parque/fosas (las zonas 1 a 30 tienen solo fosas; los nichos, los sectores de nichos).
CREATE OR REPLACE FUNCTION trg_espacio_zona_compatible() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_tipo tipo_zona;
BEGIN
  SELECT tipo INTO v_tipo FROM zonas WHERE id = NEW.zona_id;
  IF (NEW.tipo_espacio = 'nicho' AND v_tipo NOT IN ('nichos', 'mixta'))
     OR (NEW.tipo_espacio = 'fosa' AND v_tipo NOT IN ('parque_fosas', 'mixta')) THEN
    RAISE EXCEPTION 'Un % no puede ubicarse en una zona de tipo %', NEW.tipo_espacio, v_tipo
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER espacio_zona_compatible BEFORE INSERT OR UPDATE OF zona_id, tipo_espacio ON espacios_sepultura
  FOR EACH ROW EXECUTE FUNCTION trg_espacio_zona_compatible();

-- 10.5 Evaluación de stock: abre/actualiza/cierra alertas de faltante.
CREATE OR REPLACE FUNCTION evaluar_stock() RETURNS void LANGUAGE plpgsql AS $$
DECLARE r RECORD; v_clave TEXT;
BEGIN
  FOR r IN SELECT * FROM v_disponibilidad_resumen LOOP
    v_clave := 'stock:' || r.tipo_espacio || ':' || r.tipo_tamano;
    IF r.nivel_alerta IN ('advertencia','critica') THEN
      INSERT INTO alertas(tipo, nivel, tipo_espacio, tipo_tamano, titulo, detalle, clave)
      VALUES (CASE WHEN r.nivel_alerta = 'critica' THEN 'stock_critico' ELSE 'stock_bajo' END::tipo_alerta,
              r.nivel_alerta, r.tipo_espacio, r.tipo_tamano,
              CASE WHEN r.nivel_alerta = 'critica' THEN 'Faltante crítico: ' ELSE 'Stock bajo: ' END
                || CASE r.tipo_espacio WHEN 'nicho' THEN 'nichos ' ELSE 'fosas ' END
                || CASE r.tipo_tamano WHEN 'normal' THEN 'normales' ELSE 'extraordinarias' END
                || ' (' || r.disponibles || ' disponibles)',
              jsonb_build_object('disponibles', r.disponibles, 'umbral_critico', r.umbral_critico,
                                 'umbral_advertencia', r.umbral_advertencia,
                                 'dias_cobertura_estimados', r.dias_cobertura_estimados),
              v_clave)
      ON CONFLICT (clave) WHERE resuelta_en IS NULL DO UPDATE
        SET nivel = EXCLUDED.nivel, tipo = EXCLUDED.tipo, titulo = EXCLUDED.titulo,
            detalle = EXCLUDED.detalle;
    ELSE
      UPDATE alertas SET resuelta_en = now() WHERE clave = v_clave AND resuelta_en IS NULL;
    END IF;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION trg_stock_cambio() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM evaluar_stock();
  RETURN NULL;
END $$;
-- Una vez por sentencia (no por fila) para no penalizar cargas masivas.
CREATE TRIGGER stock_cambio AFTER INSERT OR UPDATE OF estado OR DELETE ON espacios_sepultura
  FOR EACH STATEMENT EXECUTE FUNCTION trg_stock_cambio();
CREATE TRIGGER stock_umbral AFTER INSERT OR UPDATE OR DELETE ON umbrales_stock
  FOR EACH STATEMENT EXECUTE FUNCTION trg_stock_cambio();

-- 10.6 Evaluación de semáforo: abre/cierra alertas de mantenimiento.
-- Se llama desde un job programado (p. ej. cada hora) y al completar tareas.
CREATE OR REPLACE FUNCTION evaluar_semaforo() RETURNS void LANGUAGE plpgsql AS $$
DECLARE r RECORD; v_clave TEXT;
BEGIN
  FOR r IN SELECT * FROM v_semaforo_zonas LOOP
    v_clave := 'mant:' || r.zona_id;
    IF r.color = 'rojo_critico' THEN
      INSERT INTO alertas(tipo, nivel, zona_id, titulo, detalle, clave)
      VALUES ('mantenimiento_critico', 'critica', r.zona_id,
              'Mantenimiento crítico en ' || r.nombre, coalesce(r.detalle, '[]'::jsonb), v_clave)
      ON CONFLICT (clave) WHERE resuelta_en IS NULL DO UPDATE
        SET nivel = 'critica', tipo = 'mantenimiento_critico', detalle = EXCLUDED.detalle;
    ELSIF r.color = 'amarillo' THEN
      INSERT INTO alertas(tipo, nivel, zona_id, titulo, detalle, clave)
      VALUES ('mantenimiento_vencido', 'advertencia', r.zona_id,
              'Mantenimiento por vencer en ' || r.nombre, coalesce(r.detalle, '[]'::jsonb), v_clave)
      ON CONFLICT (clave) WHERE resuelta_en IS NULL DO UPDATE
        SET nivel = 'advertencia', tipo = 'mantenimiento_vencido', detalle = EXCLUDED.detalle;
    ELSE
      UPDATE alertas SET resuelta_en = now() WHERE clave = v_clave AND resuelta_en IS NULL;
    END IF;
  END LOOP;
END $$;

-- 10.7 Registrar descarga (inhumación) de forma atómica.
-- La firma ya debe estar insertada y verificada por la API (verificación
-- criptográfica ECDSA en la capa de aplicación con la clave del dispositivo).
CREATE OR REPLACE FUNCTION registrar_descarga(
  p_espacio_id      BIGINT,
  p_difunto_id      UUID,
  p_ejecutada_por   UUID,
  p_supervisada_por UUID,
  p_realizada_en    TIMESTAMPTZ,
  p_firma_id        UUID,
  p_ubicacion       geometry,
  p_expediente      TEXT,
  p_observaciones   TEXT,
  p_idempotency_key TEXT
) RETURNS operaciones_sepultura LANGUAGE plpgsql AS $$
DECLARE
  v_esp  espacios_sepultura;
  v_op   operaciones_sepultura;
  v_firma firmas_digitales;
BEGIN
  -- Reintento idempotente: devuelve la operación ya registrada.
  SELECT * INTO v_op FROM operaciones_sepultura WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN RETURN v_op; END IF;

  SELECT * INTO v_firma FROM firmas_digitales WHERE id = p_firma_id;
  IF NOT FOUND OR NOT v_firma.verificada OR v_firma.usuario_id <> p_ejecutada_por THEN
    RAISE EXCEPTION 'Firma inexistente, no verificada o de otro usuario' USING ERRCODE = 'P0001';
  END IF;

  -- Bloqueo de fila: dos capataces no pueden ocupar el mismo nicho a la vez.
  SELECT * INTO v_esp FROM espacios_sepultura WHERE id = p_espacio_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Espacio % inexistente', p_espacio_id USING ERRCODE = 'P0002';
  END IF;
  IF v_esp.estado NOT IN ('disponible', 'reservado') THEN
    RAISE EXCEPTION 'El espacio % no está disponible (estado: %)', v_esp.codigo, v_esp.estado
      USING ERRCODE = 'P0003';
  END IF;

  INSERT INTO operaciones_sepultura(tipo_operacion, espacio_id, difunto_id, expediente,
         ejecutada_por, supervisada_por, realizada_en, firma_id, ubicacion, observaciones, idempotency_key)
  VALUES ('inhumacion', p_espacio_id, p_difunto_id, p_expediente,
          p_ejecutada_por, p_supervisada_por, p_realizada_en, p_firma_id, p_ubicacion,
          p_observaciones, p_idempotency_key)
  RETURNING * INTO v_op;

  PERFORM set_config('app.operacion_id', v_op.id::text, true);
  PERFORM set_config('app.usuario_id', p_ejecutada_por::text, true);
  UPDATE espacios_sepultura SET estado = 'ocupado', reservado_hasta = NULL
   WHERE id = p_espacio_id;   -- dispara historial + evaluar_stock()
  RETURN v_op;
END $$;

-- 10.8 Completar tarea de mantenimiento (crea la tarea si vino "suelta" del campo).
CREATE OR REPLACE FUNCTION completar_tarea(
  p_tarea_id        UUID,          -- NULL = tarea no programada registrada en campo
  p_zona_id         SMALLINT,
  p_tipo_tarea      tipo_tarea_mant,
  p_ejecutada_por   UUID,
  p_supervisada_por UUID,
  p_firma_id        UUID,
  p_ubicacion       geometry,
  p_porcentaje      SMALLINT,
  p_observaciones   TEXT,
  p_fotos           TEXT[],
  p_idempotency_key TEXT
) RETURNS mantenimiento_tareas LANGUAGE plpgsql AS $$
DECLARE v_t mantenimiento_tareas; v_firma firmas_digitales;
BEGIN
  SELECT * INTO v_t FROM mantenimiento_tareas WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN RETURN v_t; END IF;

  SELECT * INTO v_firma FROM firmas_digitales WHERE id = p_firma_id;
  IF NOT FOUND OR NOT v_firma.verificada OR v_firma.usuario_id <> p_ejecutada_por THEN
    RAISE EXCEPTION 'Firma inexistente, no verificada o de otro usuario' USING ERRCODE = 'P0001';
  END IF;
  PERFORM set_config('app.usuario_id', p_ejecutada_por::text, true);

  IF p_tarea_id IS NULL THEN
    INSERT INTO mantenimiento_tareas(zona_id, tipo_tarea, estado, completada_en, ejecutada_por,
           supervisada_por, firma_id, ubicacion_cierre, porcentaje_zona, observaciones, fotos_urls,
           idempotency_key)
    VALUES (p_zona_id, p_tipo_tarea, 'completada', now(), p_ejecutada_por, p_supervisada_por,
            p_firma_id, p_ubicacion, coalesce(p_porcentaje, 100), p_observaciones,
            coalesce(p_fotos, '{}'), p_idempotency_key)
    RETURNING * INTO v_t;
  ELSE
    UPDATE mantenimiento_tareas
       SET estado = 'completada', completada_en = now(), ejecutada_por = p_ejecutada_por,
           supervisada_por = p_supervisada_por, firma_id = p_firma_id, ubicacion_cierre = p_ubicacion,
           porcentaje_zona = coalesce(p_porcentaje, 100), observaciones = p_observaciones,
           fotos_urls = coalesce(p_fotos, '{}'), idempotency_key = p_idempotency_key
     WHERE id = p_tarea_id AND estado IN ('programada','asignada','en_curso')
    RETURNING * INTO v_t;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Tarea % inexistente o ya cerrada', p_tarea_id USING ERRCODE = 'P0002';
    END IF;
  END IF;

  PERFORM evaluar_semaforo();
  RETURN v_t;
END $$;

-- 11. Datos iniciales ---------------------------------------------------------
-- Zonas 1 a 30: solo fosas. Los nichos están en los sectores de nichos.
INSERT INTO zonas (codigo, numero, nombre, categoria, tipo)
SELECT 'Z' || lpad(n::text, 2, '0'), n, 'Zona ' || n || CASE WHEN n >= 29 THEN ' (COVID)' ELSE '' END,
       CASE WHEN n >= 29 THEN 'covid' ELSE 'parque' END::categoria_sector, 'parque_fosas'
FROM generate_series(1, 30) AS n;   -- 1 a 28: Parque; 29 y 30: zonas COVID

INSERT INTO zonas (codigo, nombre, categoria, tipo, requiere_corte_cesped) VALUES
  ('SV_FOSAS',      'Sección Vieja (fosas)',  'seccion_vieja',     'parque_fosas', TRUE),
  ('SN_FOSAS',      'Sección Nueva',          'seccion_nueva',     'parque_fosas', TRUE),
  ('PAB_AMARILLO',  'Pabellón Amarillo',      'pabellon_amarillo', 'nichos',       FALSE),
  ('CENTRAL',       'Central',                'central',           'nichos',       FALSE),
  ('LATERAL',       'Lateral',                'lateral',           'nichos',       FALSE),
  ('SV_NICHOS',     'Sección Vieja (nichos)', 'seccion_vieja',     'nichos',       FALSE);

INSERT INTO puntos_referencia (tipo, nombre, zona_id) VALUES
  ('acceso',           'Ingreso por Calle Soto',              NULL),
  ('acceso',           'Ingreso por Calle Martin Cartechini', NULL),
  ('administracion',   'Administración',                      NULL),
  ('cruz_mayor',       'Cruz Mayor',                          NULL),
  ('rotonda',          'Rotonda',                             NULL),
  ('banos',            'Baños',                               NULL);

-- Sección Vieja (nichos): calles, pasajes y referencias del plano.
INSERT INTO puntos_referencia (tipo, nombre, zona_id, descripcion)
SELECT t, n, (SELECT id FROM zonas WHERE codigo = 'SV_NICHOS'), d FROM (VALUES
  ('calle'::tipo_punto_ref,  'San Vicente',              'Eje central (vertical)'),
  ('calle',                  'Calle Martin Costacchini', 'Límite inferior (calle principal)'),
  ('calle',                  'Blas Parera',              'Límite derecho'),
  ('pasaje',                 'San Carlos',               'Pasaje horizontal 1 (de abajo hacia arriba)'),
  ('pasaje',                 'San Pedro',                'Pasaje horizontal 2'),
  ('pasaje',                 'San Agustín',              'Pasaje horizontal 3'),
  ('pasaje',                 'San Juan',                 'Pasaje horizontal 4'),
  ('pasaje',                 'Santa María',              'Pasaje horizontal 5'),
  ('pasaje',                 'Santa Teresa',             'Pasaje interno'),
  ('pasaje',                 'San José',                 'Pasaje interno'),
  ('pasaje',                 'San Antonio',              'Pasaje interno'),
  ('otro',                   'Horno crematorio',         'Referencia del sector superior (zona norte)'),
  ('memorial',               'Memorial',                 'Referencia del sector superior (zona norte)'),
  ('banos',                  'Baño (Lateral Bloq. 2)',   'Sector superior (zona norte)')
) AS v(t, n, d);

INSERT INTO bloques_seccion (zona_id, sector, cuadro, nombre, bloque, prop, nota, tiene_nichos, orden)
SELECT (SELECT id FROM zonas WHERE codigo = 'SV_NICHOS'), sector, cuadro, nombre, bloque, prop, nota, tiene_nichos, orden FROM (VALUES
  ('Sector superior (zona norte)',        'D',  'Pabellón Ferroviario Julio Juárez', 10, NULL::smallint, NULL,                          TRUE,   1),
  ('Sector superior (zona norte)',        NULL, 'Pabellón 02 01 03',                  1, NULL, NULL,                                  TRUE,   2),
  ('Sector superior (zona norte)',        NULL, 'Pabellón PB 02 01 02',               1, NULL, NULL,                                  TRUE,   3),
  ('Sector superior (zona norte)',        NULL, 'Pabellón SS 02 01 01',               1, NULL, NULL,                                  TRUE,   4),
  ('Sector superior (zona norte)',        'C',  NULL,                                 9, NULL, 'junto al Bloq. 7',                    TRUE,   5),
  ('Sector superior (zona norte)',        NULL, 'Lateral',                            2, NULL, 'Baño',                                TRUE,   6),
  ('Sector superior — izquierda / centro','A',  NULL,                                 4, NULL, NULL,                                  TRUE,   7),
  ('Sector superior — izquierda / centro','B',  NULL,                                 6, NULL, NULL,                                  TRUE,   8),
  ('Sector superior — izquierda / centro','W',  NULL,                                 5, NULL, 'dentro del Cuadro B',                 TRUE,   9),
  ('Sector superior — izquierda / centro','C',  NULL,                                 7, NULL, NULL,                                  TRUE,  10),
  ('Sector superior — izquierda / centro','V',  NULL,                                 8, NULL, 'dentro del Cuadro C',                 TRUE,  11),
  ('Sector superior — izquierda / centro',NULL, 'Central',                            3, NULL, NULL,                                  TRUE,  12),
  ('Fila 1',                              'O',  NULL,                                19,   15, NULL,                                  TRUE,  13),
  ('Fila 1',                              'P',  NULL,                                25,   17, NULL,                                  TRUE,  14),
  ('Fila 1',                              'Q',  NULL,                                31,   18, NULL,                                  TRUE,  15),
  ('Fila 1',                              'R',  NULL,                                34,   13, NULL,                                  TRUE,  16),
  ('Fila 2',                              NULL, 'Osario',                            14, NULL, NULL,                                  FALSE, 17),
  ('Fila 2',                              'K',  NULL,                                18,   11, NULL,                                  TRUE,  18),
  ('Fila 2',                              'L',  NULL,                                24,   12, NULL,                                  TRUE,  19),
  ('Fila 2',                              'M',  NULL,                                30,   13, NULL,                                  TRUE,  20),
  ('Fila 2',                              'N',  NULL,                                33,   14, NULL,                                  TRUE,  21),
  ('Fila 3',                              'G',  NULL,                                17,    7, 'incluye subsección Cruzados',         TRUE,  22),
  ('Fila 3',                              'H',  NULL,                                23,    8, NULL,                                  TRUE,  23),
  ('Fila 3',                              'I',  NULL,                                29,    9, NULL,                                  TRUE,  24),
  ('Fila 3',                              'J',  NULL,                                32,   10, 'incluye Ferroviario 2',               TRUE,  25),
  ('Fila 4',                              'S',  NULL,                                15,   20, NULL,                                  TRUE,  26),
  ('Fila 4',                              'C',  NULL,                                22,    3, NULL,                                  TRUE,  27),
  ('Fila 4',                              'D',  NULL,                                21,    4, NULL,                                  TRUE,  28),
  ('Fila 4',                              'E',  NULL,                                28,    5, NULL,                                  TRUE,  29),
  ('Fila 4',                              'F',  NULL,                                27,    6, NULL,                                  TRUE,  30),
  ('Fila 4',                              NULL, 'Pared Cuadro T',                  NULL, NULL, 'lateral izquierdo',                   TRUE,  31),
  ('Fila 4',                              NULL, 'N. Chico',                          16, NULL, NULL,                                  TRUE,  32),
  ('Fila 4',                              NULL, 'Ferroviario 1',                   NULL, NULL, NULL,                                  TRUE,  33),
  ('Fila 5 (sector inferior / base)',     'A',  NULL,                                20,    1, NULL,                                  TRUE,  34),
  ('Fila 5 (sector inferior / base)',     NULL, 'Sector C',                        NULL, NULL, 'símbolo herradura / C',               TRUE,  35),
  ('Fila 5 (sector inferior / base)',     'B',  NULL,                                26,    2, NULL,                                  TRUE,  36)
) AS v(sector, cuadro, nombre, bloque, prop, nota, tiene_nichos, orden);

-- Plazos de referencia (ajustables por la Dirección).
INSERT INTO reglas_mantenimiento (tipo_tarea, dias_verde, dias_rojo) VALUES
  ('corte_cesped',         15, 30),
  ('recoleccion_residuos',  3,  7);

-- Temporada de lluvias: los plazos se reducen al 60 %.
INSERT INTO temporadas_climaticas (nombre, desde, hasta, factor_plazos) VALUES
  ('Lluvias 2026-2027', '2026-11-01', '2027-03-31', 0.60);

-- Umbrales globales de stock (ejemplo; los define la Dirección).
INSERT INTO umbrales_stock (tipo_espacio, tipo_tamano, umbral_advertencia, umbral_critico, dias_cobertura_critico) VALUES
  ('nicho', 'normal',         200, 50, 30),
  ('nicho', 'extraordinario',  40, 10, 30),
  ('fosa',  'normal',         150, 40, 30),
  ('fosa',  'extraordinario',  30,  8, 30);

COMMIT;
