/*
 * Gestión operativa — Cementerio San Vicente Parque
 *
 * App de una sola página, sin dependencias externas.
 * MODO DEMOSTRACIÓN: los datos viven en localStorage de este navegador.
 * La capa de datos está concentrada en `Datos` para reemplazarla por la API
 * (openapi.yaml) cuando exista el servidor con la base PostgreSQL (esquema.sql).
 *
 * Reglas que replica de esquema.sql:
 *  - Semáforo: verde ≤ días verdes × factor, amarillo ≤ días rojos × factor,
 *    rojo crítico si supera o nunca se registró. Color de la zona = el peor.
 *    Factor de temporada de lluvias (por defecto 0,60 de noviembre a marzo).
 *  - Stock: crítico si disponibles ≤ umbral crítico o días de cobertura ≤ límite;
 *    advertencia si disponibles ≤ umbral de advertencia.
 *  - Cada registro de campo se firma: PIN + trazo + firma ECDSA P-256 del
 *    dispositivo (WebCrypto) sobre el SHA-256 del contenido, y se encadena con
 *    el hash del registro anterior. Los registros no se editan ni se borran.
 */
"use strict";

const CLAVE_DATOS = "cementerio-sv-demo-v5";
const CLAVE_SESION = "cementerio-sv-sesion";
// Versión publicada. Tiene que coincidir con version.json: si el servidor tiene una más nueva,
// la app avisa para recargar (así nadie usa una versión vieja guardada en el celular).
const VERSION_APP = "2026-10-17.6";
const ZONA_HORARIA = "America/Argentina/Cordoba";
const PIN_DEMO = "1234";
const DIA = 86400000;

// Tareas que se pueden registrar hoy.
const TAREAS = {
  corte_cesped: "Corte de césped",
  limpieza_calles: "Limpieza de calles",
  recoleccion_residuos: "Recolección de residuos",
  relleno_fosas: "Relleno de fosas",
  pintura: "Pintura en general",
  poda: "Poda",
  limpieza_general: "Limpieza general",
  reparacion_nicho: "Reparación de nicho",
};
// Tareas que ya no se ofrecen, pero pueden figurar en registros firmados anteriores.
const TAREAS_ANTERIORES = { desmalezado: "Desmalezado", desagues_pluviales: "Limpieza de desagües", reparacion_caminos: "Reparación de caminos" };
const nombreTarea = (k) => TAREAS[k] || TAREAS_ANTERIORES[k] || k;
const MAX_FOTOS = 3;
const COLORES = { verde: "Verde", amarillo: "Amarillo", rojo_critico: "Rojo crítico" };
const ORDEN_COLOR = { verde: 0, amarillo: 1, rojo_critico: 2 };
const TIPOS_ZONA = { parque_fosas: "Fosas", nichos: "Nichos", mixta: "Mixta", especial: "Especial" };
const STOCK_CLAVES = [
  ["nicho", "normal"], ["nicho", "extraordinario"], ["fosa", "normal"], ["fosa", "extraordinario"], ["fosa", "angelito"],
];
// Las fosas de angelitos (para niños) son un tamaño aparte, solo de fosas (pedido del dueño).
const nombreStock = (tipo, tam) => tam === "angelito" ? "Fosas de angelitos" :
  (tipo === "nicho" ? "Nichos " : "Fosas ") +
  (tam === "normal" ? "normales" : tipo === "nicho" ? "extraordinarios" : "extraordinarias");

/* ───────────────────────── Utilidades ───────────────────────── */
const $ = (sel, raiz = document) => raiz.querySelector(sel);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtFecha = (iso) => iso ? new Date(iso).toLocaleString("es-AR", { timeZone: ZONA_HORARIA, day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—";
const fmtDia = (iso) => iso ? new Date(iso).toLocaleDateString("es-AR", { timeZone: ZONA_HORARIA, day: "2-digit", month: "2-digit", year: "numeric" }) : "—";
const fmtNum = (n, dec = 0) => Number(n).toLocaleString("es-AR", { maximumFractionDigits: dec, minimumFractionDigits: dec });
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : "id-" + Date.now().toString(36) + Math.random().toString(36).slice(2));
const codigoCorto = (hash) => hash.slice(0, 8).toUpperCase().replace(/(.{4})/, "$1-");

function canonico(v) {
  // JSON canónico: claves ordenadas, sin espacios (mismo criterio que RFC 8785 para estos datos).
  if (Array.isArray(v)) return "[" + v.map(canonico).join(",") + "]";
  if (v && typeof v === "object") return "{" + Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => JSON.stringify(k) + ":" + canonico(v[k])).join(",") + "}";
  return JSON.stringify(v);
}
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const desdeB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
async function sha256(texto) {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(texto)));
}

function prng(semilla) { // generador determinista para los datos de ejemplo
  let s = semilla >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

/* ───────────────────────── Datos de ejemplo ───────────────────────── */
async function datosIniciales() {
  const azar = prng(20261016);
  const ahora = Date.now();
  const pinHash = await sha256("pin:" + PIN_DEMO);

  const zonas = [];
  // Parque: zonas 1 a 28. Zonas 29 y 30: zonas COVID. Todas de fosas.
  for (let n = 1; n <= 30; n++) {
    const covid = n >= 29;
    zonas.push({
      id: n, codigo: "Z" + String(n).padStart(2, "0"), numero: n, nombre: covid ? `Zona ${n} (COVID)` : "Zona " + n,
      tipo: "parque_fosas", corte: true, covid,
    });
  }
  // Sectores: fosas (Sección Vieja y Sección Nueva) y nichos (pabellones y Sección Vieja).
  [
    ["SV_FOSAS", "Sección Vieja (fosas)", "parque_fosas", true],
    ["SN_FOSAS", "Sección Nueva", "parque_fosas", true],
    ["PAB_AMARILLO", "Pabellón Amarillo", "nichos", false],
    ["CENTRAL", "Central", "nichos", false],
    ["LATERAL", "Lateral", "nichos", false],
    ["SV_NICHOS", "Sección Vieja", "nichos", false],
  ].forEach(([codigo, nombre, tipo, corte], i) => zonas.push({ id: 31 + i, codigo, numero: null, nombre, tipo, corte }));

  const reglas = {
    corte_cesped: { verde: 15, rojo: 30, lluvia: true },
    recoleccion_residuos: { verde: 3, rojo: 7, lluvia: false },
  };

  for (const z of zonas) {
    z.ultimas = {};
    for (const [tarea, r] of Object.entries(reglas)) {
      if (tarea === "corte_cesped" && !z.corte) continue;
      const p = azar();
      const dias = p < 0.85 ? azar() * r.verde : p < 0.96 ? r.verde + azar() * (r.rojo - r.verde) : r.rojo + 1 + azar() * r.rojo * 0.5;
      z.ultimas[tarea] = new Date(ahora - dias * DIA).toISOString();
    }
  }

  const usuarios = [
    { id: "u-dir", nombre: "Director (demo)", rol: "directivo", legajo: "D-001", pin: pinHash, zonas: [] },
    { id: "u-cap-a", nombre: "Capataz A (demo)", rol: "capataz", legajo: "C-101", pin: pinHash, zonas: range(1, 36) },
  ];
  for (const z of zonas) z.responsable = usuarios.find((u) => u.rol === "capataz" && u.zonas.includes(z.id))?.id || null;

  // Espacios no ocupados, individualizados (los ocupados históricos van como contador).
  const objetivo = { // disponibles, reservados, en mantenimiento, inhabilitados, ocupados históricos
    "nicho|normal": [180, 6, 14, 3, 11230], "nicho|extraordinario": [9, 2, 3, 1, 1840],
    "fosa|normal": [320, 4, 10, 2, 15410], "fosa|extraordinario": [26, 1, 2, 0, 2210],
    ...OBJETIVO_ANGELITOS,
  };
  const espacios = [];
  const ocupadosBase = {};
  let idEsp = 1;
  for (const [clave, [disp, res, mant, inh, ocup]] of Object.entries(objetivo)) {
    const [tipo, tam] = clave.split("|");
    ocupadosBase[clave] = ocup;
    // Fosas en el Parque, las zonas COVID y las secciones de fosas; nichos en los sectores de nichos.
    const zonasTipo = zonas.filter((z) => (tipo === "nicho" ? z.tipo === "nichos" : z.tipo === "parque_fosas"));
    const estados = [...Array(disp).fill("disponible"), ...Array(res).fill("reservado"), ...Array(mant).fill("en_mantenimiento"), ...Array(inh).fill("inhabilitado")];
    estados.forEach((estado, i) => {
      const z = zonasTipo[Math.floor(azar() * zonasTipo.length)];
      espacios.push({ id: idEsp++, zona: z.id, tipo, tam, estado });
    });
  }
  numerarEspacios(espacios, zonas);

  return {
    version: 13,
    creado: new Date(ahora).toISOString(),
    usuarios, zonas, reglas,
    temporada: { desde: "11-01", hasta: "03-31", factor: 0.6 },
    umbrales: {
      "nicho|normal": { adv: 200, crit: 50, cobertura: 30 },
      "nicho|extraordinario": { adv: 40, crit: 10, cobertura: 30 },
      "fosa|normal": { adv: 150, crit: 40, cobertura: 30 },
      "fosa|extraordinario": { adv: 30, crit: 8, cobertura: 30 },
      "fosa|angelito": { ...UMBRAL_ANGELITOS },
    },
    consumoBase90: { "nicho|normal": 270, "nicho|extraordinario": 50, "fosa|normal": 360, "fosa|extraordinario": 30, "fosa|angelito": CONSUMO_ANGELITOS },
    ocupadosBase, espacios,
    registros: [], dispositivos: {}, alertasVistas: {}, reclamos: [],
  };
}
// Ubicación de cada nicho o fosa (datos de ejemplo; con la base real viene del padrón).
// Zonas 1 a 30: zona → cuadro (1 a 40) → fosa. Resto: número dentro del sector.
const MAX_CUADROS = 40;
const PLANTAS = ["Primera planta", "Segunda planta", "Tercera planta"];
const MAX_FILAS = 10;
// Operaciones sobre nichos y fosas. Para el cementerio, la DESCARGA desocupa el lugar (igual que la
// exhumación): el lugar queda libre y vuelve a contar como disponible. La INHUMACIÓN lo ocupa.
// (Los registros viejos con acción "descarga" eran inhumaciones: se muestran como tales.)
const OPERACIONES = {
  // Pedido del dueño: la descarga es solo de nichos y la exhumación solo de fosas.
  descarga: { titulo: "Registrar descarga", accion: "descarga_libera", libera: true, nombre: "Descarga", tipos: ["nicho"] },
  exhumacion: { titulo: "Registrar exhumación", accion: "exhumacion", libera: true, nombre: "Exhumación", tipos: ["fosa"] },
  inhumacion: { titulo: "Registrar inhumación", accion: "inhumacion", libera: false, nombre: "Inhumación", tipos: ["nicho", "fosa"] },
};
const ACCIONES_LIBERAN = ["descarga_libera", "exhumacion"];
const ACCIONES_OCUPAN = ["inhumacion", "descarga"];
const nombreAccion = (a) => ({ descarga_libera: "Descarga", exhumacion: "Exhumación", inhumacion: "Inhumación", descarga: "Inhumación" }[a] || a);
const DESTINOS_EXHUMACION = ["Osario", "Cremación", "Reducción", "Traslado a otro lugar del cementerio", "Traslado a otro cementerio", "Otro"];
// "Segunda planta · Fila 2 · Nicho N° 5". En la Sección Vieja sin la palabra "Nicho" (pedido del dueño).
const ubNicho = (e, esSeccionVieja) => [e.lugar, `Fila ${e.fila}`, (esSeccionVieja ? "N° " : "Nicho N° ") + e.numero].filter(Boolean).join(" · ");
// Sección Vieja (sector de nichos, código SV_NICHOS): cuadro y bloque según el plano (plano-seccion-vieja.js).
function numerarEspacios(espacios, zonas) {
  const numerada = new Set(zonas.filter((z) => z.numero).map((z) => z.id));
  const seccionVieja = zonas.find((z) => z.codigo === "SV_NICHOS")?.id;
  const pabellonAmarillo = zonas.find((z) => z.codigo === "PAB_AMARILLO")?.id;
  const grupos = {};
  for (const e of espacios) {
    e.cuadro = e.tipo === "fosa" && numerada.has(e.zona) ? 1 + ((e.id * 7) % MAX_CUADROS) : undefined;
    e.lugar = e.tipo === "nicho" && e.zona === seccionVieja ? etiquetaBloque(BLOQUES_CON_NICHOS[(e.id * 5) % BLOQUES_CON_NICHOS.length]) : undefined;
    // Pabellón Amarillo: primera, segunda y tercera planta.
    e.planta = e.tipo === "nicho" && e.zona === pabellonAmarillo ? 1 + (e.id % PLANTAS.length) : undefined;
    if (e.planta) e.lugar = PLANTAS[e.planta - 1];
    (grupos[[e.zona, e.tipo, e.cuadro ?? "", e.lugar ?? "", e.planta ?? ""].join("|")] ||= []).push(e);
  }
  for (const lista of Object.values(grupos)) {
    lista.sort((a, b) => a.id - b.id).forEach((e, i) => {
      e.numero = e.cuadro || (e.lugar && !e.planta) ? 1 + i * 3 + (e.id % 3) : 1 + i * 4 + (e.id % 4);
      if (e.tipo === "nicho") e.fila = 1 + ((e.numero - 1) % 5);
      e.ub = e.tipo === "nicho" ? ubNicho(e, e.zona === seccionVieja)
        : e.cuadro ? `Cuadro ${e.cuadro} · Fosa ${e.numero}` : `Fosa N° ${e.numero}`;
    });
  }
}
// Fosas de angelitos: datos de ejemplo (disponibles, reservados, en mantenimiento, inhabilitados, ocupados históricos).
const OBJETIVO_ANGELITOS = { "fosa|angelito": [35, 1, 3, 0, 1650] };
const UMBRAL_ANGELITOS = { adv: 20, crit: 5, cobertura: 30 };
const CONSUMO_ANGELITOS = 18;
const nombreTamano = (e) => (e.tam === "normal" ? "" : e.tam === "angelito" ? "Angelito" : e.tipo === "nicho" ? "Extraordinario" : "Extraordinaria");
const chipTamano = (e) => `<span class="chip ${e.tam === "angelito" ? "angelito" : "critica"}">${nombreTamano(e)}</span>`;
function range(a, b) { return Array.from({ length: b - a + 1 }, (_, i) => a + i); }

/* ───────────────────────── Capa de datos (demo: localStorage) ───────────────────────── */
const Datos = {
  estado: null,
  async cargar() {
    try { this.estado = JSON.parse(localStorage.getItem(CLAVE_DATOS)); } catch { this.estado = null; }
    if (this.estado?.version === 5) { // se sacaron desmalezado y limpieza de desagües: dejan de contar en el semáforo
      for (const k of Object.keys(TAREAS_ANTERIORES)) {
        delete this.estado.reglas[k];
        for (const z of this.estado.zonas) delete z.ultimas[k];
      }
      this.estado.version = 6; this.guardar();
    }
    if ([6, 7, 8, 9, 10, 11].includes(this.estado?.version)) { // ubicación: zona/cuadro/fosa y bloques de la Sección Vieja
      for (const z of this.estado.zonas) if (z.codigo === "SV_NICHOS") z.nombre = "Sección Vieja";
      numerarEspacios(this.estado.espacios, this.estado.zonas);
      this.estado.version = 12; this.guardar();
    }
    if (this.estado?.version === 12) { // se agregan las fosas de angelitos (con lugares de ejemplo)
      const e = this.estado;
      e.umbrales["fosa|angelito"] ||= { ...UMBRAL_ANGELITOS };
      e.consumoBase90["fosa|angelito"] ??= CONSUMO_ANGELITOS;
      const [disp, res, mant, inh, ocup] = OBJETIVO_ANGELITOS["fosa|angelito"];
      e.ocupadosBase["fosa|angelito"] ??= ocup;
      const zonasFosa = e.zonas.filter((z) => z.tipo === "parque_fosas");
      let id = Math.max(0, ...e.espacios.map((x) => Number(x.id) || 0)) + 1;
      const nuevos = [...Array(disp).fill("disponible"), ...Array(res).fill("reservado"), ...Array(mant).fill("en_mantenimiento"), ...Array(inh).fill("inhabilitado")]
        .map((estado, i) => ({ id: id + i, zona: zonasFosa[(i * 7) % zonasFosa.length].id, tipo: "fosa", tam: "angelito", estado }));
      // Se numeran aparte para no cambiar el número de los lugares que ya existen; sin repetir uno ocupado.
      const usados = new Set(e.espacios.filter((x) => x.tipo === "fosa").map((x) => [x.zona, x.cuadro ?? 0, x.numero].join("|")));
      numerarEspacios(nuevos, e.zonas);
      for (const x of nuevos) {
        while (usados.has([x.zona, x.cuadro ?? 0, x.numero].join("|"))) x.numero += 500;
        usados.add([x.zona, x.cuadro ?? 0, x.numero].join("|"));
        x.ub = x.cuadro ? `Cuadro ${x.cuadro} · Fosa ${x.numero}` : `Fosa N° ${x.numero}`;
      }
      e.espacios.push(...nuevos);
      e.version = 13; this.guardar();
    }
    const capB = this.estado?.usuarios?.find((u) => u.id === "u-cap-b");
    if (capB) { // queda un solo capataz para ingresar: hereda las zonas del Capataz B
      const capA = this.estado.usuarios.find((u) => u.id === "u-cap-a");
      if (capA) {
        capA.zonas = [...new Set([...capA.zonas, ...capB.zonas])].sort((a, b) => a - b);
        for (const z of this.estado.zonas) if (z.responsable === capB.id) z.responsable = capA.id;
      }
      this.estado.usuarios = this.estado.usuarios.filter((u) => u.id !== capB.id);
      this.guardar();
    }
    if (this.estado?.usuarios?.some((u) => u.rol === "operario" || u.nombre === "Directivo (demo)")) {
      // Para ingresar quedan solo el director y los capataces.
      this.estado.usuarios = this.estado.usuarios.filter((u) => u.rol !== "operario");
      for (const u of this.estado.usuarios) if (u.nombre === "Directivo (demo)") u.nombre = "Director (demo)";
      this.guardar();
    }
    if (!this.estado || this.estado.version !== 13) { this.estado = await datosIniciales(); this.guardar(); }
    this.estado.reclamos ||= []; // reclamos de contribuyentes (se agregaron después)
    return this.estado;
  },
  guardar(silencioso = false) {
    try { localStorage.setItem(CLAVE_DATOS, JSON.stringify(this.estado)); return true; }
    catch {
      if (!silencioso) avisar("No se pudo guardar en este dispositivo (memoria llena o modo privado).");
      return false;
    }
  },
  async reiniciar() {
    try { localStorage.removeItem(CLAVE_DATOS); } catch { /* sin almacenamiento */ }
    this.estado = await datosIniciales(); this.guardar();
  },
};

/* ───────────────────────── Cálculos ───────────────────────── */
function enTemporada(fecha = new Date()) {
  const t = Datos.estado.temporada;
  const md = new Intl.DateTimeFormat("en-CA", { timeZone: ZONA_HORARIA, month: "2-digit", day: "2-digit" }).format(fecha);
  return t.desde <= t.hasta ? md >= t.desde && md <= t.hasta : md >= t.desde || md <= t.hasta;
}

function semaforoZona(z) {
  const { reglas } = Datos.estado;
  const lluvia = enTemporada();
  const tareas = [];
  for (const [tarea, r] of Object.entries(reglas)) {
    if (tarea === "corte_cesped" && !z.corte) continue;
    const factor = r.lluvia && lluvia ? Datos.estado.temporada.factor : 1;
    const ultima = z.ultimas[tarea] || null;
    const dias = ultima ? (Date.now() - new Date(ultima)) / DIA : null;
    const limV = r.verde * factor, limR = r.rojo * factor;
    const color = dias === null ? "rojo_critico" : dias <= limV ? "verde" : dias <= limR ? "amarillo" : "rojo_critico";
    tareas.push({ tarea, ultima, dias, limV, limR, color, restan: dias === null ? null : limR - dias });
  }
  tareas.sort((a, b) => ORDEN_COLOR[b.color] - ORDEN_COLOR[a.color]);
  const color = tareas.reduce((peor, t) => (ORDEN_COLOR[t.color] > ORDEN_COLOR[peor] ? t.color : peor), "verde");
  return { color, tareas };
}

function resumenStock() {
  const { espacios, umbrales, consumoBase90, ocupadosBase, registros } = Datos.estado;
  const desde = Date.now() - 90 * DIA;
  return STOCK_CLAVES.map(([tipo, tam]) => {
    const clave = tipo + "|" + tam;
    const c = { disponible: 0, ocupado: 0, reservado: 0, en_mantenimiento: 0, inhabilitado: 0 };
    for (const e of espacios) if (e.tipo === tipo && e.tam === tam) c[e.estado]++;
    c.ocupado += ocupadosBase[clave] || 0;
    const recientes = registros.filter((r) => ACCIONES_OCUPAN.includes(r.payload.accion) && r.payload.datos.tipo === tipo && r.payload.datos.tam === tam && new Date(r.registrado_en) >= desde).length;
    const consumo = ((consumoBase90[clave] || 0) + recientes) / 90;
    // Movimientos firmados de los últimos 30 días (descargas ocupan, exhumaciones liberan).
    const hace30 = Date.now() - 30 * DIA;
    const mov = (acciones) => registros.filter((r) => acciones.includes(r.payload.accion) && r.payload.datos.tipo === tipo && r.payload.datos.tam === tam && new Date(r.registrado_en) >= hace30).length;
    const ocupados30 = mov(ACCIONES_OCUPAN), liberados30 = mov(ACCIONES_LIBERAN);
    const cobertura = consumo > 0 ? Math.floor(c.disponible / consumo) : null;
    const u = umbrales[clave];
    let nivel = "ok";
    if (u) {
      if (c.disponible <= u.crit || (cobertura !== null && u.cobertura && cobertura <= u.cobertura)) nivel = "critica";
      else if (c.disponible <= u.adv) nivel = "advertencia";
    }
    const total = Object.values(c).reduce((a, b) => a + b, 0);
    return { tipo, tam, clave, ...c, total, consumo, cobertura, umbral: u, nivel, ocupados30, liberados30 };
  });
}

function alertasActuales() {
  const lista = [];
  for (const s of resumenStock()) {
    if (s.nivel === "ok") continue;
    lista.push({
      clave: "stock:" + s.clave, nivel: s.nivel, tipo: "stock",
      titulo: (s.nivel === "critica" ? "Faltante crítico: " : "Stock bajo: ") + nombreStock(s.tipo, s.tam),
      detalle: `${fmtNum(s.disponible)} disponibles · umbral crítico ${s.umbral.crit} / advertencia ${s.umbral.adv}` + (s.cobertura !== null ? ` · ~${fmtNum(s.cobertura)} días de cobertura` : ""),
    });
  }
  for (const z of Datos.estado.zonas) {
    const sem = semaforoZona(z);
    if (sem.color === "verde") continue;
    const t = sem.tareas[0];
    lista.push({
      clave: "mant:" + z.id, nivel: sem.color === "rojo_critico" ? "critica" : "advertencia", tipo: "mantenimiento", zona: z.id,
      titulo: (sem.color === "rojo_critico" ? "Mantenimiento crítico en " : "Mantenimiento por vencer en ") + z.nombre,
      detalle: `${nombreTarea(t.tarea)}: ${t.dias === null ? "sin registro" : "hace " + fmtNum(t.dias) + " días"} (límite ${fmtNum(t.limR)} días)`,
    });
  }
  const demorados = (Datos.estado.reclamos || []).filter(demorado);
  if (demorados.length) {
    lista.push({
      clave: "reclamos:" + demorados.map((rc) => rc.numero).join(","), nivel: "advertencia", tipo: "reclamos", pestana: "reclamos",
      titulo: demorados.length === 1 ? "1 reclamo de contribuyente demorado" : `${demorados.length} reclamos de contribuyentes demorados`,
      detalle: `Sin resolver hace ${DIAS_RECLAMO_DEMORADO} días o más: ` + demorados.map((rc) => `N° ${rc.numero}`).join(", "),
    });
  }
  return lista.sort((a, b) => (a.nivel === b.nivel ? 0 : a.nivel === "critica" ? -1 : 1));
}
const alertaVista = (a) => Datos.estado.alertasVistas[a.clave] === a.nivel;

/* ───────────────────────── Firma del dispositivo (WebCrypto + IndexedDB) ───────────────────────── */
const Dispositivo = {
  async abrir() {
    return new Promise((ok, mal) => {
      const req = indexedDB.open("cementerio-sv-claves", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("claves");
      req.onsuccess = () => ok(req.result);
      req.onerror = () => mal(req.error);
    });
  },
  async leer(db) {
    return new Promise((ok, mal) => {
      const r = db.transaction("claves").objectStore("claves").get("dispositivo");
      r.onsuccess = () => ok(r.result); r.onerror = () => mal(r.error);
    });
  },
  async escribir(db, valor) {
    return new Promise((ok, mal) => {
      const tx = db.transaction("claves", "readwrite");
      tx.objectStore("claves").put(valor, "dispositivo");
      tx.oncomplete = () => ok(); tx.onerror = () => mal(tx.error);
    });
  },
  async obtener() {
    if (this.cache) return this.cache;
    let db = null, guardado = null;
    try { db = await this.abrir(); guardado = await this.leer(db); } catch { db = null; }
    if (!guardado) {
      // Clave privada NO exportable: no puede copiarse a otro equipo.
      const par = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
      const publicaJwk = await crypto.subtle.exportKey("jwk", par.publicKey);
      guardado = { id: uuid(), privada: par.privateKey, publicaJwk, creado: new Date().toISOString() };
      if (db) { try { await this.escribir(db, guardado); } catch { /* queda solo en memoria */ } }
    }
    const reg = Datos.estado.dispositivos;
    if (!reg[guardado.id]) {
      reg[guardado.id] = { publicaJwk: guardado.publicaJwk, enrolado_en: guardado.creado, agente: navigator.userAgent.slice(0, 160) };
      Datos.guardar();
    }
    this.cache = guardado;
    return guardado;
  },
};

async function verificarFirmaEcdsa(publicaJwk, mensaje, firmaB64) {
  const clave = await crypto.subtle.importKey("jwk", publicaJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  return crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, clave, desdeB64(firmaB64), new TextEncoder().encode(mensaje));
}

async function firmarYRegistrar(usuario, accion, datos, pin, trazoDataUrl, gps, fotos = []) {
  if (await sha256("pin:" + pin) !== usuario.pin) throw new Error("El PIN no es correcto.");
  const disp = await Dispositivo.obtener();
  // Las fotos quedan atadas a la firma por su huella: si alguien cambia una foto, la verificación lo detecta.
  if (fotos.length) datos = { ...datos, fotos_sha256: await Promise.all(fotos.map(sha256)) };
  const payload = {
    accion, datos,
    usuario: { id: usuario.id, nombre: usuario.nombre, legajo: usuario.legajo, rol: usuario.rol },
    dispositivo_id: disp.id,
    hora_dispositivo: new Date().toISOString(),
    gps: gps || null,
    nonce: uuid(),
    trazo_sha256: await sha256(trazoDataUrl),
    metodos: ["firma_dispositivo_ecdsa", "pin_reautenticacion", "firma_manuscrita"],
  };
  const payloadSha = await sha256(canonico(payload));
  const firma = b64(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, disp.privada, new TextEncoder().encode(payloadSha)));
  const registros = Datos.estado.registros;
  const anterior = registros.length ? registros[registros.length - 1].hash_registro : "GENESIS";
  const registrado_en = new Date().toISOString();
  const registro = {
    secuencia: registros.length + 1, payload, payload_sha256: payloadSha, firma_base64: firma,
    trazo: trazoDataUrl, fotos: fotos.length ? fotos : undefined, hash_anterior: anterior, registrado_en,
  };
  registro.hash_registro = await sha256([anterior, payloadSha, firma, registrado_en].join("|"));

  const respaldo = JSON.stringify(Datos.estado);
  // Efectos sobre el estado operativo
  if (accion === "tarea") {
    const z = Datos.estado.zonas.find((x) => x.id === datos.zona);
    if (z && Datos.estado.reglas[datos.tipo_tarea]) z.ultimas[datos.tipo_tarea] = registrado_en;
  } else if (ACCIONES_OCUPAN.includes(accion)) {
    const e = Datos.estado.espacios.find((x) => x.id === datos.espacio_id);
    if (!e && datos.alta_manual) {
      // Nicho o fosa cargado a mano que no figuraba en la lista: se agrega ya ocupado.
      Datos.estado.espacios.push({
        id: datos.espacio_id, zona: datos.zona, tipo: datos.tipo, tam: datos.tam, estado: "ocupado",
        planta: datos.planta, lugar: datos.lugar, fila: datos.fila, cuadro: datos.cuadro, numero: datos.numero, ub: datos.ubicacion, alta_manual: true,
      });
    } else {
      if (!e || !["disponible", "reservado"].includes(e.estado)) throw new Error("Ese espacio ya no está disponible. Elegí otro.");
      e.estado = "ocupado";
      delete e.liberado_en;
      delete e.liberado_por;
    }
  } else if (ACCIONES_LIBERAN.includes(accion)) {
    // Descarga o exhumación: el lugar queda libre y vuelve a contarse como disponible.
    const e = Datos.estado.espacios.find((x) => x.id === datos.espacio_id);
    if (!e && datos.alta_manual) {
      // Lugar ocupado de antes que no estaba cargado uno por uno: se agrega ya libre
      // y se descuenta de los ocupados históricos.
      Datos.estado.espacios.push({
        id: datos.espacio_id, zona: datos.zona, tipo: datos.tipo, tam: datos.tam, estado: "disponible", liberado_en: registrado_en, liberado_por: accion,
        planta: datos.planta, lugar: datos.lugar, fila: datos.fila, cuadro: datos.cuadro, numero: datos.numero, ub: datos.ubicacion, alta_manual: true,
      });
      const clave = datos.tipo + "|" + datos.tam;
      Datos.estado.ocupadosBase[clave] = Math.max(0, (Datos.estado.ocupadosBase[clave] || 0) - 1);
    } else {
      if (!e || e.estado !== "ocupado") throw new Error("Ese lugar no figura ocupado. Revisá la ubicación.");
      e.estado = "disponible";
      e.liberado_en = registrado_en;
      e.liberado_por = accion;
    }
  }
  registros.push(registro);
  if (!Datos.guardar(true)) {
    Datos.estado = JSON.parse(respaldo);
    throw new Error("No queda lugar en este dispositivo para guardar el registro. Probá con menos fotos.");
  }
  return registro;
}

async function verificarCadena() {
  const { registros, dispositivos } = Datos.estado;
  const resultado = [];
  let anterior = "GENESIS";
  for (const r of registros) {
    const problemas = [];
    if (await sha256(canonico(r.payload)) !== r.payload_sha256) problemas.push("el contenido fue modificado");
    if (r.hash_anterior !== anterior) problemas.push("la cadena está cortada");
    if (await sha256([r.hash_anterior, r.payload_sha256, r.firma_base64, r.registrado_en].join("|")) !== r.hash_registro) problemas.push("el sello del registro no coincide");
    if (await sha256(r.trazo) !== r.payload.trazo_sha256) problemas.push("el trazo de firma fue cambiado");
    const huellas = r.payload.datos.fotos_sha256 || [];
    const fotos = r.fotos || [];
    if (huellas.length !== fotos.length || (await Promise.all(fotos.map(sha256))).some((h, i) => h !== huellas[i])) problemas.push("las fotos fueron cambiadas");
    const disp = dispositivos[r.payload.dispositivo_id];
    if (!disp) problemas.push("dispositivo desconocido");
    else if (!(await verificarFirmaEcdsa(disp.publicaJwk, r.payload_sha256, r.firma_base64).catch(() => false))) problemas.push("la firma digital no verifica");
    resultado.push({ secuencia: r.secuencia, ok: problemas.length === 0, problemas });
    anterior = r.hash_registro;
  }
  return resultado;
}

/* ───────────────────────── Interfaz: infraestructura ───────────────────────── */
const UI = { usuario: null, pestana: null, filtroColor: "todas", borrador: null, fotos: [], filtroDisp: { tipo: "todos", extra: "" } };

function avisar(texto) {
  const t = $("#toast");
  t.textContent = texto; t.hidden = false;
  clearTimeout(avisar.timer);
  avisar.timer = setTimeout(() => (t.hidden = true), 3800);
}
function abrirModal(html) {
  $("#modal-contenido").innerHTML = html;
  $("#modal").hidden = false;
  document.body.style.overflow = "hidden";
  $("#modal-contenido").querySelector("h2, h1")?.setAttribute("id", "modal-titulo");
}
function cerrarModal() {
  $("#modal").hidden = true;
  $("#modal-contenido").innerHTML = "";
  document.body.style.overflow = "";
}

const PESTANAS = {
  // El informe diario lo ve solo el Director.
  directivo: [["resumen", "Resumen"], ["informe", "Informe diario"], ["reclamos", "Reclamos"], ["capataces", "Capataces"], ["zonas", "Zonas"], ["alertas", "Alertas"], ["registro", "Registro firmado"], ["ajustes", "Ajustes"]],
  // Los tableros (resumen, zonas, alertas, registro) los ven todos; los ajustes, solo directivos.
  // Capataces y operarios arrancan en el mismo Resumen que los directivos.
  campo: [["resumen", "Resumen"], ["zonas", "Zonas"], ["alertas", "Alertas"], ["reclamos", "Reclamos"], ["registro", "Registro firmado"], ["mis-zonas", "Mis zonas"], ["tarea", "Registrar tarea"], ["descarga", "Registrar descarga"], ["exhumacion", "Registrar exhumación"], ["inhumacion", "Registrar inhumación"], ["mis-registros", "Mis registros"]],
};
const grupoRol = (u) => (u.rol === "directivo" ? "directivo" : "campo");

function render() {
  const u = UI.usuario;
  $("#sesion").innerHTML = u ? `<span>${esc(u.nombre)}<span class="rol">Legajo ${esc(u.legajo)}</span></span><button type="button" data-accion="salir">Salir</button>` : "";
  if (!u) { $("#pestanas").innerHTML = ""; $("#vista").innerHTML = vistaLogin(); return; }
  const pest = PESTANAS[grupoRol(u)];
  if (!pest.some(([id]) => id === UI.pestana)) UI.pestana = pest[0][0];
  const pendientes = alertasActuales().filter((a) => !alertaVista(a)).length;
  $("#pestanas").innerHTML = pest.map(([id, txt]) =>
    `<button type="button" data-pestana="${id}" ${id === UI.pestana ? 'aria-current="page"' : ""}>${txt}${id === "alertas" && pendientes ? `<span class="contador">${pendientes}</span>` : ""}</button>`).join("");
  const activa = $("#pestanas [aria-current]");
  $("#pestanas").scrollLeft = activa ? Math.max(0, activa.offsetLeft - 16) : 0;
  const vistas = {
    resumen: vistaResumen, informe: vistaInforme, reclamos: vistaReclamos, capataces: vistaCapataces, zonas: vistaZonas, alertas: vistaAlertas, registro: vistaRegistro, ajustes: vistaAjustes,
    "mis-zonas": vistaMisZonas, tarea: vistaTarea, descarga: vistaDescarga, exhumacion: vistaExhumacion, inhumacion: vistaInhumacion, "mis-registros": vistaMisRegistros,
  };
  $("#vista").innerHTML = vistas[UI.pestana]();
  if (OPERACIONES[UI.pestana]) actualizarListaEspacios();
}

/* ───────────────────────── Vistas ───────────────────────── */
function vistaLogin() {
  const usuarios = Datos.estado.usuarios.filter((u) => u.activo !== false);
  return `<section class="login">
    <h1>Ingresar</h1>
    <p class="muted">Elegí tu usuario y escribí tu PIN. <span class="chico">(Usuarios de demostración: PIN <strong>${PIN_DEMO}</strong>.)</span></p>
    <form class="form" data-form="login">
      <div class="usuarios" role="radiogroup" aria-label="Usuario">
        ${usuarios.map((u, i) => `<label class="card usuario"><span><strong>${esc(u.nombre)}</strong><br><span class="muted chico">${u.rol === "directivo" ? "Tablero, alertas y control" : "Campo y tableros · " + u.zonas.length + " zonas asignadas"}</span></span><input type="radio" name="usuario" value="${u.id}" ${i === 0 ? "checked" : ""} style="width:auto;min-height:auto"></label>`).join("")}
      </div>
      <label>PIN<input name="pin" type="password" inputmode="numeric" autocomplete="off" required maxlength="8" placeholder="••••"></label>
      <button class="btn grande" type="submit">Ingresar</button>
    </form>
  </section>`;
}

function chipColor(color) { return `<span class="chip ${color}">${COLORES[color]}</span>`; }
function chipNivel(nivel) { return `<span class="chip ${nivel}">${nivel === "critica" ? "Crítico" : nivel === "advertencia" ? "Advertencia" : "Normal"}</span>`; }

function bannerFaltante(stock) {
  const criticos = stock.filter((s) => s.nivel === "critica");
  if (!criticos.length) return "";
  return `<div class="banner critica" role="alert">
    <span aria-hidden="true" style="font-size:1.4rem">⚠</span>
    <div><strong>Faltante crítico</strong>
      <ul>${criticos.map((s) => `<li>${nombreStock(s.tipo, s.tam)}: <strong>${fmtNum(s.disponible)}</strong> disponibles${s.cobertura !== null ? ` · ~${fmtNum(s.cobertura)} días de cobertura` : ""}</li>`).join("")}</ul>
    </div></div>`;
}

function tarjetaStock(s) {
  const u = s.umbral;
  const escala = Math.max(u.adv * 1.5, s.disponible, 1);
  const pct = Math.min(100, (s.disponible / escala) * 100);
  const color = s.nivel === "critica" ? "var(--rojo)" : s.nivel === "advertencia" ? "var(--amarillo-dot)" : "var(--verde)";
  return `<div class="card stock clicable" role="button" tabindex="0" data-ver-disp="${s.tipo}|${s.tam}" aria-label="Ver el listado de ${nombreStock(s.tipo, s.tam).toLowerCase()} disponibles">
    <div class="fila entre"><h3>${nombreStock(s.tipo, s.tam)}</h3>${chipNivel(s.nivel)}</div>
    <div class="numero">${fmtNum(s.disponible)}</div>
    <div class="muted chico">disponibles</div>
    <div class="barra-umbral" role="img" aria-label="Disponibles contra umbrales">
      <span style="width:${pct}%;background:${color}"></span>
      <i class="marca-umbral" style="left:${(u.crit / escala) * 100}%" title="Umbral crítico"></i>
      <i class="marca-umbral" style="left:${(u.adv / escala) * 100}%" title="Umbral de advertencia"></i>
    </div>
    <div class="muted chico">Crítico ≤ ${u.crit} · Advertencia ≤ ${u.adv}</div>
    <div class="chico" style="margin-top:8px">${s.cobertura !== null ? `Cobertura estimada: <strong>~${fmtNum(s.cobertura)} días</strong> (${fmtNum(s.consumo, 1)} por día)` : "Sin consumo reciente"}</div>
    <div class="muted chico">Reservados ${s.reservado} · En mantenimiento ${s.en_mantenimiento} · Inhabilitados ${s.inhabilitado}</div>
    <div class="chico" style="margin-top:6px">Últimos 30 días: <strong style="color:var(--verde)">+${s.liberados30}</strong> ${s.liberados30 === 1 ? "liberado" : "liberados"} (descargas y exhumaciones) · <strong>−${s.ocupados30}</strong> ${s.ocupados30 === 1 ? "ocupado" : "ocupados"} (inhumaciones)</div>
    <div class="ver-listado">${s.disponible ? "Tocá para ver el listado →" : "No hay disponibles"}</div>
  </div>`;
}

// Lista de lugares libres por zona, con el número de cada nicho o fosa.
function seccionDondeHayLugar() {
  const f = UI.filtroDisp;
  const libres = Datos.estado.espacios.filter((e) => e.estado === "disponible" &&
    (f.tipo === "todos" || e.tipo === f.tipo) && (!f.extra || e.tam === f.extra));
  const porZona = new Map();
  for (const z of Datos.estado.zonas) porZona.set(z.id, []);
  for (const e of libres) porZona.get(e.zona)?.push(e);
  const btn = (tipo, txt) => `<button type="button" class="opcion" style="min-height:auto" data-filtro-disp="${tipo}" aria-pressed="${f.tipo === tipo}">${txt}</button>`;
  const plural = (n, uno, varios) => `${n} ${n === 1 ? uno : varios}`;
  const bloques = [...porZona].filter(([, l]) => l.length).map(([id, lista]) => {
    lista.sort((a, b) => a.tipo.localeCompare(b.tipo) || a.numero - b.numero);
    const fosas = lista.filter((e) => e.tipo === "fosa").length, nichos = lista.length - fosas;
    const extra = lista.filter((e) => e.tam === "extraordinario").length, angelitos = lista.filter((e) => e.tam === "angelito").length;
    const sinPalabraNicho = Datos.estado.zonas.find((z) => z.id === id)?.codigo === "SV_NICHOS";
    const resumen = [fosas && plural(fosas, "fosa", "fosas"), nichos && (sinPalabraNicho ? plural(nichos, "lugar", "lugares") : plural(nichos, "nicho", "nichos"))].filter(Boolean).join(" y ") +
      (extra ? ` · <span class="chip critica" style="font-size:.75rem">${extra} extraordinari${extra === 1 ? (fosas && !nichos ? "a" : "o") : (fosas && !nichos ? "as" : "os")}</span>` : "") +
      (angelitos ? ` · <span class="chip angelito" style="font-size:.75rem">${plural(angelitos, "de angelito", "de angelitos")}</span>` : "");
    return `<details class="card lugar"${f.extra || lista.length <= 6 ? " open" : ""}>
      <summary><strong>${esc(nombreZona(id))}</strong> <span class="muted">— ${resumen}</span></summary>
      <ul class="espacios-libres">${lista.map((e) => `<li class="${e.tam === "extraordinario" ? "extra" : e.tam === "angelito" ? "angelito" : ""}">${esc(e.ub)}${e.tam !== "normal" ? ` <strong>· ${nombreTamano(e)}</strong>` : ""}${e.liberado_en ? ` · <em>liberado ${fmtDia(e.liberado_en)}</em>` : ""}</li>`).join("")}</ul>
    </details>`;
  });
  return `<h2 id="donde-hay-lugar">¿Dónde hay lugar?</h2>
    <p class="muted">Nichos y fosas libres, por zona, con su número. Los extraordinarios y las fosas de angelitos están marcados.</p>
    <div class="fila" style="margin-bottom:8px">${btn("todos", "Todos")}${btn("fosa", "Fosas")}${btn("nicho", "Nichos")}
      <label class="fila" style="font-weight:500;gap:6px;margin-left:4px">Tamaño <select data-filtro-extra style="width:auto">
        <option value="">Todos</option><option value="extraordinario" ${f.extra === "extraordinario" ? "selected" : ""}>Solo extraordinarios</option><option value="angelito" ${f.extra === "angelito" ? "selected" : ""}>Solo angelitos</option></select></label></div>
    <p class="chico"><strong>${plural(libres.length, "lugar libre", "lugares libres")}</strong> en ${plural(bloques.length, "zona", "zonas")}.</p>
    <div class="lista-lugares">${bloques.join("") || '<div class="card vacio">No hay lugares libres con ese filtro.</div>'}</div>`;
}

// Listado (ventana) de los nichos o fosas disponibles de un tipo y tamaño.
function abrirListado() {
  const { tipo, tam, zona } = UI.listado;
  const todos = Datos.estado.espacios.filter((e) => e.estado === "disponible" && e.tipo === tipo && e.tam === tam);
  const zonasCon = [...new Set(todos.map((e) => e.zona))].sort((a, b) => a - b);
  const lista = todos.filter((e) => !zona || e.zona === Number(zona))
    .sort((a, b) => a.zona - b.zona || (a.cuadro ?? 0) - (b.cuadro ?? 0) || (a.lugar ?? "").localeCompare(b.lugar ?? "", "es", { numeric: true }) || (a.fila ?? 0) - (b.fila ?? 0) || a.numero - b.numero);
  const esFosa = tipo === "fosa";
  const filas = lista.map((e) => `<tr>
      <td>${esc(nombreZona(e.zona))}</td>
      ${esFosa ? `<td>${e.cuadro ?? "—"}</td><td><strong>${e.numero}</strong></td>` : `<td>${esc(e.lugar || "—")}</td><td>${e.fila ?? "—"}</td><td><strong>${e.numero}</strong></td>`}
      <td>${e.tam !== "normal" ? chipTamano(e) : "Normal"}${e.liberado_en ? `<br><span class="chip ok">Liberado ${fmtDia(e.liberado_en)}</span>` : ""}</td></tr>`).join("");
  abrirModal(`<h2 style="margin-top:0">${nombreStock(tipo, tam)} disponibles</h2>
    <p><strong>${lista.length}</strong> ${lista.length === 1 ? "lugar libre" : "lugares libres"}${zona ? " en " + esc(nombreZona(Number(zona))) : ` en ${zonasCon.length} ${zonasCon.length === 1 ? "zona" : "zonas"}`}.</p>
    <label style="margin-bottom:12px">Zona<select data-listado-zona>
      <option value="">Todas las zonas</option>
      ${zonasCon.map((id) => `<option value="${id}" ${String(id) === String(zona) ? "selected" : ""}>${esc(nombreZona(id))} (${todos.filter((e) => e.zona === id).length})</option>`).join("")}
    </select></label>
    ${lista.length ? `<div class="tabla-scroll"><table>
      <thead><tr><th>Zona</th>${esFosa ? "<th>Cuadro</th><th>Fosa</th>" : "<th>Planta / Cuadro</th><th>Fila</th><th>N°</th>"}<th>Tamaño</th></tr></thead>
      <tbody>${filas}</tbody></table></div>` : '<div class="card vacio">No hay disponibles.</div>'}
    <p style="margin-top:16px"><button class="btn sec" type="button" data-accion="cerrar">Cerrar</button></p>`);
}

function vistaResumen() {
  const stock = resumenStock();
  const zonas = Datos.estado.zonas.map((z) => ({ z, s: semaforoZona(z) }));
  const cuenta = { verde: 0, amarillo: 0, rojo_critico: 0 };
  zonas.forEach(({ s }) => cuenta[s.color]++);
  const criticas = zonas.filter(({ s }) => s.color === "rojo_critico");
  const ultimos = Datos.estado.registros.slice(-8).reverse();
  return `${bannerFaltante(stock)}
    <h1>Resumen</h1>
    <p class="muted">${enTemporada() ? "Temporada de lluvias: los plazos de mantenimiento están acortados." : "Fuera de temporada de lluvias."} Actualizado: ${fmtFecha(new Date().toISOString())}</p>
    <h2>Disponibilidad de nichos y fosas</h2>
    <div class="grilla">${stock.map(tarjetaStock).join("")}</div>
    ${seccionLiberados()}
    <h2>Últimos movimientos</h2>
    <p class="muted chico">Cada trabajo firmado se refleja al instante en los números de arriba.</p>
    ${ultimos.length ? tablaMovimientos(ultimos) : `<div class="card vacio">Todavía no hay trabajos firmados. Cada descarga, exhumación o tarea que se firme aparece acá.</div>`}
    ${seccionDondeHayLugar()}
    <h2>Semáforo de mantenimiento</h2>
    <div class="resumen-semaforo">
      <span class="chip verde">${cuenta.verde} en verde</span>
      <span class="chip amarillo">${cuenta.amarillo} en amarillo</span>
      <span class="chip rojo_critico">${cuenta.rojo_critico} en rojo crítico</span>
    </div>
    ${criticas.length ? `<div class="zonas">${criticas.map(({ z, s }) => tileZona(z, s)).join("")}</div>` : `<p class="muted">No hay zonas en rojo crítico.</p>`}
    <p><button class="btn sec" type="button" data-pestana="zonas">Ver las ${zonas.length} zonas</button></p>
`;
}

function tileZona(z, s) {
  const t = s.tareas[0];
  const pie = t ? (t.dias === null ? "Sin registro" : `${nombreTarea(t.tarea).split(" ")[0]}: hace ${fmtNum(t.dias)} d`) : "Sin tareas";
  return `<button type="button" class="zona c-${s.color}" data-zona="${z.id}" aria-label="${esc(z.nombre)}: ${COLORES[s.color]}">
    <strong>${z.numero ? z.numero : esc(z.nombre)}</strong>
    ${z.covid ? "<span>COVID</span>" : z.numero ? "" : `<span>${TIPOS_ZONA[z.tipo]}</span>`}
    <span>${esc(pie)}</span></button>`;
}

function vistaZonas() {
  const lista = Datos.estado.zonas.map((z) => ({ z, s: semaforoZona(z) }));
  const f = UI.filtroColor;
  const visibles = lista.filter(({ s }) => f === "todas" || s.color === f);
  const grilla = (items) => `<div class="zonas">${items.map(({ z, s }) => tileZona(z, s)).join("") || '<p class="muted">Ninguna con ese color.</p>'}</div>`;
  const btn = (id, txt) => `<button type="button" class="opcion" style="min-height:auto" data-filtro="${id}" aria-pressed="${f === id}">${txt}</button>`;
  return `<h1>Zonas</h1>
    <p class="muted">Color de cada zona según el mantenimiento más atrasado. Tocá una zona para ver el detalle.</p>
    <div class="fila" style="margin-bottom:12px">${btn("todas", "Todas")}${btn("rojo_critico", "Rojo crítico")}${btn("amarillo", "Amarillo")}${btn("verde", "Verde")}</div>
    <h2>Fosas</h2>
    <h3>Parque — zonas 1 a 28</h3>
    ${grilla(visibles.filter(({ z }) => z.numero && !z.covid))}
    <h3 style="margin-top:16px">Zonas COVID — 29 y 30</h3>
    ${grilla(visibles.filter(({ z }) => z.covid))}
    <h3 style="margin-top:16px">Sección Vieja y Sección Nueva</h3>
    ${grilla(visibles.filter(({ z }) => !z.numero && z.tipo === "parque_fosas"))}
    <h2>Nichos</h2>
    ${grilla(visibles.filter(({ z }) => z.tipo === "nichos"))}`;
}

function detalleZona(id) {
  const z = Datos.estado.zonas.find((x) => x.id === id);
  const s = semaforoZona(z);
  const resp = Datos.estado.usuarios.find((u) => u.id === z.responsable);
  const regs = Datos.estado.registros.filter((r) => r.payload.datos.zona === id).slice(-6).reverse();
  const esCampo = UI.usuario && grupoRol(UI.usuario) === "campo";
  abrirModal(`<div class="fila entre"><h2 style="margin:0">${esc(z.nombre)}</h2>${chipColor(s.color)}</div>
    <p class="muted">${TIPOS_ZONA[z.tipo]} · Responsable: ${resp ? esc(resp.nombre) : "sin asignar"}</p>
    <div class="tabla-scroll"><table>
      <thead><tr><th>Tarea</th><th>Última vez</th><th>Hace</th><th>Límite</th><th>Estado</th></tr></thead>
      <tbody>${s.tareas.map((t) => `<tr><td>${nombreTarea(t.tarea)}</td><td>${fmtDia(t.ultima)}</td><td>${t.dias === null ? "—" : fmtNum(t.dias) + " d"}</td><td>${fmtNum(t.limV)} / ${fmtNum(t.limR)} d</td><td>${chipColor(t.color)}</td></tr>`).join("") || '<tr><td colspan="5">Sin tareas con plazo.</td></tr>'}</tbody>
    </table></div>
    ${z.codigo === "SV_NICHOS" ? planoSeccionVieja(z.id) : ""}
    ${z.codigo === "PAB_AMARILLO" ? plantasPabellon(z.id) : ""}
    <h3 style="margin-top:16px">Últimos registros en la zona</h3>
    ${regs.length ? tablaRegistros(regs) : '<p class="muted">Sin registros firmados todavía.</p>'}
    <div class="fila" style="margin-top:16px">
      ${esCampo ? `<button class="btn" type="button" data-ir-tarea="${id}">Registrar tarea acá</button>` : ""}
      <button class="btn sec" type="button" data-accion="cerrar">Cerrar</button>
    </div>`);
}

// Plano de la Sección Vieja (SV_NICHOS): calles, pasajes y cuadros/bloques con los nichos libres de cada uno.
function planoSeccionVieja(zonaId) {
  const p = PLANO_SECCION_VIEJA;
  const libres = {};
  for (const e of Datos.estado.espacios) if (e.zona === zonaId && e.estado === "disponible") libres[e.lugar] = (libres[e.lugar] || 0) + 1;
  const fila = (b) => {
    const n = b.bloque && !b.sinNichos ? libres[etiquetaBloque(b)] || 0 : null;
    return `<tr><td>${b.cuadro ? `<strong>${esc(b.cuadro)}</strong>` : "—"}</td><td>${esc(b.nombre || "")}</td><td>${b.bloque ?? "—"}</td><td>${b.prop ?? "—"}</td>
      <td>${esc(b.nota || "")}</td><td>${n === null ? "—" : n ? `<strong>${n}</strong>` : "0"}</td></tr>`;
  };
  return `<h3 style="margin-top:16px">Plano de la Sección Vieja</h3>
    <div class="resumen-firma chico"><dl>
      ${p.calles.map((c) => `<dt>${esc(c.rol)}</dt><dd>${esc(c.nombre)}</dd>`).join("")}
      <dt>Pasajes horizontales</dt><dd>${p.pasajesHorizontales.map(esc).join(" · ")} <span class="muted">(de abajo hacia arriba)</span></dd>
      <dt>Otros pasajes</dt><dd>${p.otrosPasajes.map(esc).join(" · ")}</dd>
    </dl></div>
    ${p.sectores.map((s) => `<h4 style="margin:14px 0 6px">${esc(s.nombre)}</h4>
      ${s.referencias ? `<p class="muted chico" style="margin:0 0 6px">Referencias: ${s.referencias.map(esc).join(" · ")}</p>` : ""}
      <div class="tabla-scroll"><table>
        <thead><tr><th>Cuadro</th><th>Nombre</th><th>Bloq.</th><th>Prop.</th><th>Detalle</th><th>Libres</th></tr></thead>
        <tbody>${s.bloques.map(fila).join("")}</tbody></table></div>`).join("")}`;
}

// Pabellón Amarillo: estado de los nichos por planta.
function plantasPabellon(zonaId) {
  const esp = Datos.estado.espacios.filter((e) => e.zona === zonaId);
  const cuenta = (p, estado) => esp.filter((e) => e.planta === p && e.estado === estado).length;
  const extra = (p) => esp.filter((e) => e.planta === p && e.estado === "disponible" && e.tam === "extraordinario").length;
  return `<h3 style="margin-top:16px">Plantas del Pabellón Amarillo</h3>
    <div class="tabla-scroll"><table>
      <thead><tr><th>Planta</th><th>Libres</th><th>Extraordinarios libres</th><th>Reservados</th><th>En mantenimiento</th></tr></thead>
      <tbody>${PLANTAS.map((nombre, i) => `<tr><td><strong>${nombre}</strong></td><td><strong>${cuenta(i + 1, "disponible")}</strong></td>
        <td>${extra(i + 1)}</td><td>${cuenta(i + 1, "reservado")}</td><td>${cuenta(i + 1, "en_mantenimiento")}</td></tr>`).join("")}</tbody>
    </table></div>`;
}

/* ───────────────────────── Capataces: ranking y administración (solo Director) ───────────────────────── */
// Lista (no objeto) para que el orden sea el de acá: las claves "7" y "30" se reordenarían solas en un objeto.
const PERIODOS = [["hoy", "Hoy"], ["7", "Últimos 7 días"], ["30", "Últimos 30 días"], ["mes", "Este mes"], ["todo", "Todo"]];
function desdePeriodo(periodo) {
  const hoy = diaDe(new Date());
  if (periodo === "hoy") return hoy;
  if (periodo === "mes") return hoy.slice(0, 8) + "01";
  if (periodo === "todo") return "0000-00-00";
  return sumarDias(hoy, -(Number(periodo) - 1));
}

function rankingCapataces(periodo) {
  const desde = desdePeriodo(periodo);
  const capataces = Datos.estado.usuarios.filter((u) => u.rol === "capataz");
  return capataces.map((u) => {
    const regs = Datos.estado.registros.filter((r) => r.payload.usuario.id === u.id && diaDe(r.registrado_en) >= desde);
    const c = { tarea: 0, descarga: 0, exhumacion: 0, inhumacion: 0 };
    regs.forEach((r) => c[clasificar(r)]++);
    const fotos = regs.reduce((n, r) => n + (r.payload.datos.fotos_sha256?.length || 0), 0);
    const dias = new Set(regs.map((r) => diaDe(r.registrado_en))).size;
    const ultimo = regs.length ? regs[regs.length - 1].registrado_en : null;
    return { u, total: regs.length, c, fotos, dias, ultimo };
  }).filter((x) => x.u.activo !== false || x.total > 0)
    .sort((a, b) => b.total - a.total || a.u.nombre.localeCompare(b.u.nombre));
}

function vistaCapataces() {
  if (UI.usuario?.rol !== "directivo") return '<div class="card vacio">Esta sección la ve solo el Director.</div>';
  const periodo = UI.periodoRanking || "30";
  const ranking = rankingCapataces(periodo);
  const max = Math.max(1, ...ranking.map((x) => x.total));
  const medalla = (i, total) => (total ? ["🥇", "🥈", "🥉"][i] || `${i + 1}°` : "—");
  const btn = ([id, txt]) => `<button type="button" class="opcion" style="min-height:auto" data-periodo="${id}" aria-pressed="${periodo === id}">${txt}</button>`;
  const capataces = Datos.estado.usuarios.filter((u) => u.rol === "capataz");
  return `<h1>Capataces</h1>
    <h2>Ranking de trabajo</h2>
    <p class="muted chico">Cuenta los trabajos firmados por cada capataz: tareas de mantenimiento, descargas, exhumaciones e inhumaciones.</p>
    <div class="fila" style="margin-bottom:12px">${PERIODOS.map(btn).join("")}</div>
    ${ranking.length ? `<div class="lista-alertas">${ranking.map((x, i) => `<div class="card ranking ${i === 0 && x.total ? "primero" : ""}">
        <div class="ranking-fila"><span class="puesto">${medalla(i, x.total)}</span>
          <div class="ranking-nombre"><strong>${esc(x.u.nombre)}</strong>${x.u.activo === false ? ' <span class="chip advertencia">Inactivo</span>' : ""}<div class="muted chico">Legajo ${esc(x.u.legajo)}${x.ultimo ? " · último trabajo " + fmtFecha(x.ultimo) : ""}</div></div>
          <div class="total"><strong>${x.total}</strong><span class="muted chico">trabajos</span></div></div>
        <div class="barra-umbral"><span style="width:${(x.total / max) * 100}%;background:var(--primary)"></span></div>
        <div class="muted chico">Tareas ${x.c.tarea} · Descargas ${x.c.descarga} · Exhumaciones ${x.c.exhumacion} · Inhumaciones ${x.c.inhumacion} · Fotos ${x.fotos} · Días trabajados ${x.dias}</div>
      </div>`).join("")}</div>` : '<div class="card vacio">Todavía no hay capataces.</div>'}

    <h2>Administrar capataces</h2>
    <p class="muted chico">Cada capataz entra con su nombre y su PIN. El PIN no se muestra nunca: si alguien se lo olvida, le asignás uno nuevo.</p>
    <div class="tabla-scroll"><table>
      <thead><tr><th>Nombre</th><th>Legajo</th><th>Estado</th><th></th></tr></thead>
      <tbody>${capataces.map((u) => `<tr>
        <td><strong>${esc(u.nombre)}</strong></td><td>${esc(u.legajo)}</td>
        <td>${u.activo === false ? '<span class="chip advertencia">Inactivo</span>' : '<span class="chip ok">Activo</span>'}</td>
        <td><div class="fila"><button class="btn sec" type="button" data-editar-capataz="${u.id}" style="min-height:36px;padding:4px 12px">Editar</button>
          <button class="btn sec" type="button" data-activar-capataz="${u.id}" style="min-height:36px;padding:4px 12px">${u.activo === false ? "Activar" : "Desactivar"}</button></div></td>
      </tr>`).join("")}</tbody></table></div>

    <h3 style="margin-top:16px">Agregar capataz</h3>
    <form class="form card" data-form="nuevo-capataz">
      <label>Nombre y apellido<input name="nombre" required maxlength="80" autocomplete="off" placeholder="Ej.: Juan Pérez"></label>
      <label>Legajo<input name="legajo" required maxlength="20" autocomplete="off" placeholder="Ej.: C-103"></label>
      <div class="dos-col">
        <label>PIN <span class="muted">(4 a 8 números)</span><input name="pin" type="password" inputmode="numeric" required minlength="4" maxlength="8" autocomplete="new-password"></label>
        <label>Repetir PIN<input name="pin2" type="password" inputmode="numeric" required minlength="4" maxlength="8" autocomplete="new-password"></label>
      </div>
      <button class="btn" type="submit">Agregar capataz</button>
    </form>`;
}

function editarCapataz(id) {
  const u = Datos.estado.usuarios.find((x) => x.id === id);
  if (!u) return;
  abrirModal(`<h2 style="margin-top:0">Editar capataz</h2>
    <form class="form" data-form="editar-capataz" data-id="${u.id}">
      <label>Nombre y apellido<input name="nombre" required maxlength="80" value="${esc(u.nombre)}" autocomplete="off"></label>
      <label>Legajo<input name="legajo" required maxlength="20" value="${esc(u.legajo)}" autocomplete="off"></label>
      <div class="dos-col">
        <label>PIN nuevo <span class="muted">(dejar vacío para no cambiarlo)</span><input name="pin" type="password" inputmode="numeric" minlength="4" maxlength="8" autocomplete="new-password"></label>
        <label>Repetir PIN nuevo<input name="pin2" type="password" inputmode="numeric" minlength="4" maxlength="8" autocomplete="new-password"></label>
      </div>
      <p class="muted chico">Los trabajos ya firmados conservan el nombre con el que se firmaron.</p>
      <div class="fila"><button class="btn" type="submit">Guardar</button><button class="btn sec" type="button" data-accion="cerrar">Cancelar</button></div>
    </form>`);
}

// Valida nombre, legajo y PIN; devuelve un mensaje de error o null.
function validarCapataz(f, idActual, pinObligatorio) {
  const nombre = f.nombre.value.trim(), legajo = f.legajo.value.trim();
  if (nombre.length < 3) return "Escribí el nombre y apellido.";
  if (!legajo) return "Escribí el legajo.";
  if (Datos.estado.usuarios.some((u) => u.id !== idActual && u.legajo.toLowerCase() === legajo.toLowerCase())) return "Ya hay otra persona con ese legajo.";
  if (Datos.estado.usuarios.some((u) => u.id !== idActual && u.nombre.toLowerCase() === nombre.toLowerCase())) return "Ya hay otra persona con ese nombre.";
  const pin = f.pin.value;
  if (pinObligatorio || pin) {
    if (!/^\d{4,8}$/.test(pin)) return "El PIN tiene que tener entre 4 y 8 números.";
    if (pin !== f.pin2.value) return "Los dos PIN no coinciden.";
  }
  return null;
}

/* ───────────────────────── Reclamos de contribuyentes ───────────────────────── */
// Los carga quien atiende al contribuyente (Director o capataz); los capataces los siguen y los resuelven.
// El Director ve además el informe (por período, motivo, zona, estado y tiempos de respuesta).
const MOTIVOS_RECLAMO = {
  limpieza: "Falta de limpieza", pasto: "Pasto alto / corte de césped", deterioro: "Nicho o fosa deteriorado",
  filtraciones: "Filtraciones o humedad", robo: "Robo o faltante de objetos", ubicacion: "No encuentra la ubicación / señalización",
  atencion: "Atención al público", seguridad: "Iluminación / seguridad", otro: "Otro",
};
const ESTADOS_RECLAMO = { pendiente: "Pendiente", en_proceso: "En proceso", resuelto: "Resuelto" };
const CHIP_RECLAMO = { pendiente: "critica", en_proceso: "advertencia", resuelto: "ok" };
const DIAS_RECLAMO_DEMORADO = 7; // sin resolver después de esto, se marca como demorado
const chipReclamo = (rc) => `<span class="chip ${CHIP_RECLAMO[rc.estado]}">${ESTADOS_RECLAMO[rc.estado]}</span>`;
const diasAbierto = (rc) => Math.floor(((rc.resuelto_en ? new Date(rc.resuelto_en) : Date.now()) - new Date(rc.fecha)) / DIA);
const demorado = (rc) => rc.estado !== "resuelto" && diasAbierto(rc) >= DIAS_RECLAMO_DEMORADO;

function vistaReclamos() {
  const esDirector = UI.usuario?.rol === "directivo";
  const todos = Datos.estado.reclamos;
  const periodo = UI.periodoReclamos || "30";
  const desde = desdePeriodo(periodo);
  const delPeriodo = todos.filter((rc) => diaDe(rc.fecha) >= desde);
  const abiertos = todos.filter((rc) => rc.estado !== "resuelto");
  const resueltosPer = todos.filter((rc) => rc.resuelto_en && diaDe(rc.resuelto_en) >= desde);
  const promedio = resueltosPer.length ? resueltosPer.reduce((n, rc) => n + diasAbierto(rc), 0) / resueltosPer.length : null;
  const filtro = UI.filtroReclamos || "abiertos";
  const lista = (filtro === "abiertos" ? abiertos : filtro === "todos" ? delPeriodo : delPeriodo.filter((rc) => rc.estado === filtro))
    .slice().sort((a, b) => (filtro === "abiertos" ? a.fecha.localeCompare(b.fecha) : b.fecha.localeCompare(a.fecha)));
  const contar = (arr, clave) => arr.reduce((m, rc) => ((m[clave(rc)] = (m[clave(rc)] || 0) + 1), m), {});
  const tablaConteo = (titulo, obj, nombre) => {
    const filas = Object.entries(obj).sort((a, b) => b[1] - a[1]);
    const max = Math.max(1, ...filas.map(([, n]) => n));
    return `<div class="card"><h3>${titulo}</h3>${filas.map(([k, n]) => `<div class="conteo"><div class="fila entre"><span>${esc(nombre(k))}</span><strong>${n}</strong></div>
      <div class="barra-umbral"><span style="width:${(n / max) * 100}%;background:var(--primary)"></span></div></div>`).join("") || '<span class="muted">Sin reclamos en el período.</span>'}</div>`;
  };
  const kpi = (n, txt, clase = "") => `<div class="card kpi ${clase}"><div class="numero">${n}</div><div class="muted chico">${txt}</div></div>`;
  const btnP = ([id, txt]) => `<button type="button" class="opcion" style="min-height:auto" data-periodo-reclamos="${id}" aria-pressed="${periodo === id}">${txt}</button>`;
  const btnF = (id, txt) => `<button type="button" class="opcion" style="min-height:auto" data-filtro-reclamos="${id}" aria-pressed="${filtro === id}">${txt}</button>`;
  const fila = (rc) => `<tr class="${demorado(rc) ? "demorado" : ""}">
      <td><button type="button" class="enlace" data-reclamo="${rc.id}"><strong>N° ${rc.numero}</strong></button><div class="muted chico">${fmtDia(rc.fecha)}</div></td>
      <td>${esc(rc.contribuyente.nombre)}</td>
      <td>${esc(MOTIVOS_RECLAMO[rc.motivo] || rc.motivo)}<div class="muted chico">${rc.zona ? esc(nombreZona(rc.zona)) : "Sin zona"}${rc.ubicacion ? " · " + esc(rc.ubicacion) : ""}</div></td>
      <td>${chipReclamo(rc)}${demorado(rc) ? `<div class="chico" style="color:var(--rojo)"><strong>${diasAbierto(rc)} días sin resolver</strong></div>` : rc.estado === "resuelto" ? `<div class="muted chico">en ${diasAbierto(rc)} ${diasAbierto(rc) === 1 ? "día" : "días"}</div>` : ""}</td>
    </tr>`;
  const zonas = Datos.estado.zonas;
  return `<div class="fila entre informe-cabecera">
      <div><h1>Reclamos de contribuyentes</h1><p class="muted" style="margin:0">${esDirector ? "Carga, seguimiento e informe." : "Carga y seguimiento de los reclamos."}</p></div>
      ${esDirector ? '<div class="fila no-imprimir"><button class="btn" type="button" data-accion="imprimir">Imprimir informe</button></div>' : ""}
    </div>
    ${esDirector ? `<h2>Informe</h2>
    <div class="fila no-imprimir" style="margin-bottom:12px">${PERIODOS.map(btnP).join("")}</div>
    <p class="muted chico solo-imprimir">Período: ${PERIODOS.find(([id]) => id === periodo)[1]}</p>
    <div class="grilla kpis">
      ${kpi(delPeriodo.length, "recibidos en el período")}
      ${kpi(resueltosPer.length, "resueltos en el período", "ok")}
      ${kpi(abiertos.length, "sin resolver (hoy)", abiertos.length ? "critica" : "")}
      ${kpi(abiertos.filter(demorado).length, `demorados (${DIAS_RECLAMO_DEMORADO} días o más)`, abiertos.some(demorado) ? "critica" : "")}
      ${kpi(promedio === null ? "—" : fmtNum(promedio, 1), "días promedio para resolver")}
    </div>
    <div class="grilla" style="margin-top:12px">
      ${tablaConteo("Por motivo", contar(delPeriodo, (rc) => rc.motivo), (k) => MOTIVOS_RECLAMO[k] || k)}
      ${tablaConteo("Por zona", contar(delPeriodo, (rc) => rc.zona || 0), (k) => (Number(k) ? nombreZona(Number(k)) : "Sin zona"))}
      ${tablaConteo("Por estado", contar(delPeriodo, (rc) => rc.estado), (k) => ESTADOS_RECLAMO[k])}
    </div>` : ""}
    <h2>Listado</h2>
    <div class="fila no-imprimir" style="margin-bottom:8px">${btnF("abiertos", `Sin resolver (${abiertos.length})`)}${btnF("pendiente", "Pendientes")}${btnF("en_proceso", "En proceso")}${btnF("resuelto", "Resueltos")}${btnF("todos", "Todos")}</div>
    ${filtro === "abiertos" ? '<p class="muted chico">Todos los que siguen sin resolver, del más viejo al más nuevo.</p>' : `<p class="muted chico">Recibidos en el período: ${PERIODOS.find(([id]) => id === periodo)[1].toLowerCase()}.</p>`}
    ${lista.length ? `<div class="tabla-scroll"><table>
      <thead><tr><th>Reclamo</th><th>Contribuyente</th><th>Motivo y lugar</th><th>Estado</th></tr></thead>
      <tbody>${lista.map(fila).join("")}</tbody></table></div>` : `<div class="card vacio">${filtro === "abiertos" ? "No hay reclamos sin resolver." : "No hay reclamos con ese filtro."}</div>`}
    <h2 class="no-imprimir">Cargar reclamo</h2>
    <form class="form card no-imprimir" data-form="reclamo">
      <div class="dos-col">
        <label>Apellido y nombre del contribuyente<input name="nombre" required maxlength="120" autocomplete="off"></label>
        <label>Teléfono de contacto <span class="muted">(opcional)</span><input name="telefono" type="tel" inputmode="tel" maxlength="30" autocomplete="off"></label>
      </div>
      <label>Motivo<select name="motivo" required><option value="">Elegí el motivo</option>${Object.entries(MOTIVOS_RECLAMO).map(([k, t]) => `<option value="${k}">${t}</option>`).join("")}</select></label>
      <div class="dos-col">
        <label>Zona <span class="muted">(opcional)</span><select name="zona"><option value="">Sin zona / general</option>${zonas.map((z) => `<option value="${z.id}">${esc(z.nombre)}</option>`).join("")}</select></label>
        <label>Ubicación <span class="muted">(opcional)</span><input name="ubicacion" maxlength="120" autocomplete="off" placeholder="Ej.: Cuadro 12 · Fosa 34"></label>
      </div>
      <label>Detalle del reclamo<textarea name="detalle" required maxlength="1000"></textarea></label>
      <button class="btn" type="submit">Guardar reclamo</button>
    </form>`;
}

function detalleReclamo(id) {
  const rc = Datos.estado.reclamos.find((x) => x.id === id);
  if (!rc) return;
  const siguiente = rc.estado === "pendiente" ? "en_proceso" : null;
  abrirModal(`<h2 style="margin-top:0">Reclamo N° ${rc.numero} ${chipReclamo(rc)}</h2>
    <dl class="detalle-reclamo">
      <dt>Recibido</dt><dd>${fmtFecha(rc.fecha)} · cargó ${esc(rc.registrado_por.nombre)}</dd>
      <dt>Contribuyente</dt><dd>${esc(rc.contribuyente.nombre)}${rc.contribuyente.telefono ? ` · <a href="tel:${esc(rc.contribuyente.telefono.replace(/[^\d+]/g, ""))}">${esc(rc.contribuyente.telefono)}</a>` : ""}</dd>
      <dt>Motivo</dt><dd>${esc(MOTIVOS_RECLAMO[rc.motivo] || rc.motivo)}</dd>
      <dt>Lugar</dt><dd>${rc.zona ? esc(nombreZona(rc.zona)) : "Sin zona"}${rc.ubicacion ? " · " + esc(rc.ubicacion) : ""}</dd>
      <dt>Detalle</dt><dd style="white-space:pre-wrap">${esc(rc.detalle)}</dd>
      ${rc.estado === "resuelto" ? `<dt>Resuelto</dt><dd>${fmtFecha(rc.resuelto_en)} (${diasAbierto(rc)} ${diasAbierto(rc) === 1 ? "día" : "días"})</dd>` : demorado(rc) ? `<dt>Demora</dt><dd style="color:var(--rojo)"><strong>${diasAbierto(rc)} días sin resolver</strong></dd>` : ""}
    </dl>
    <h3>Seguimiento</h3>
    <ul class="historial">${rc.historial.map((h) => `<li><strong>${ESTADOS_RECLAMO[h.estado]}</strong> · ${fmtFecha(h.fecha)} · ${esc(h.usuario)}${h.nota ? `<div>${esc(h.nota)}</div>` : ""}</li>`).join("")}</ul>
    ${rc.estado !== "resuelto" ? `<form class="form" data-form="seguimiento-reclamo" data-id="${rc.id}">
      <label>Qué se hizo / respuesta al contribuyente${siguiente ? ' <span class="muted">(opcional para "En proceso")</span>' : ""}<textarea name="nota" maxlength="600"></textarea></label>
      <input type="hidden" name="estado" value="">
      <div class="fila">
        ${siguiente ? '<button class="btn sec" type="submit" data-estado-reclamo="en_proceso">Pasar a En proceso</button>' : ""}
        <button class="btn" type="submit" data-estado-reclamo="resuelto">Marcar resuelto</button>
        <button class="btn sec" type="button" data-accion="cerrar">Cerrar</button>
      </div></form>`
    : `<div class="fila"><button class="btn sec" type="button" data-reabrir-reclamo="${rc.id}">Reabrir</button><button class="btn" type="button" data-accion="cerrar">Cerrar</button></div>`}`);
}

/* ───────────────────────── Informe diario (solo Director) ───────────────────────── */
// Día calendario en Córdoba ("2026-10-17").
const diaDe = (fecha) => new Intl.DateTimeFormat("en-CA", { timeZone: ZONA_HORARIA, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(fecha));
const diaLargo = (dia) => new Date(dia + "T12:00:00").toLocaleDateString("es-AR", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
function sumarDias(dia, n) { const d = new Date(dia + "T12:00:00"); d.setDate(d.getDate() + n); return diaDe(d); }

function clasificar(r) {
  const a = r.payload.accion;
  if (a === "tarea") return "tarea";
  if (ACCIONES_LIBERAN.includes(a)) return a === "exhumacion" ? "exhumacion" : "descarga";
  return "inhumacion";
}

// Trabajos pendientes según el semáforo: vencidos (rojo), por vencer (amarillo) y los que vencen en 7 días.
function pendientes() {
  const lista = [];
  for (const z of Datos.estado.zonas) {
    for (const t of semaforoZona(z).tareas) {
      const restan = t.dias === null ? -Infinity : t.limR - t.dias;
      if (t.color === "verde" && restan > 7) continue;
      lista.push({ zona: z, tarea: t.tarea, color: t.color, ultima: t.ultima, dias: t.dias, restan });
    }
  }
  return lista.sort((a, b) => a.restan - b.restan);
}

function vistaInforme() {
  if (UI.usuario?.rol !== "directivo") return '<div class="card vacio">El informe diario lo ve solo el Director.</div>';
  const hoy = diaDe(new Date());
  const dia = UI.diaInforme || hoy;
  const regs = Datos.estado.registros.filter((r) => diaDe(r.registrado_en) === dia);
  const cuenta = { tarea: 0, descarga: 0, exhumacion: 0, inhumacion: 0 };
  regs.forEach((r) => cuenta[clasificar(r)]++);
  const fotos = regs.reduce((n, r) => n + (r.payload.datos.fotos_sha256?.length || 0), 0);
  const porPersona = {};
  regs.forEach((r) => (porPersona[r.payload.usuario.nombre] = (porPersona[r.payload.usuario.nombre] || 0) + 1));
  const porTarea = {};
  regs.filter((r) => r.payload.accion === "tarea").forEach((r) => (porTarea[r.payload.datos.tipo_tarea] = (porTarea[r.payload.datos.tipo_tarea] || 0) + 1));
  const pend = pendientes();
  const vencidas = pend.filter((p) => p.color === "rojo_critico");
  const porVencer = pend.filter((p) => p.color === "amarillo");
  const proximas = pend.filter((p) => p.color === "verde");
  const semana = Array.from({ length: 7 }, (_, i) => sumarDias(dia, i - 6)).map((d) => {
    const rs = Datos.estado.registros.filter((r) => diaDe(r.registrado_en) === d);
    const c = { tarea: 0, descarga: 0, exhumacion: 0, inhumacion: 0 };
    rs.forEach((r) => c[clasificar(r)]++);
    return { d, c, total: rs.length };
  });
  const kpi = (n, txt, clase = "") => `<div class="card kpi ${clase}"><div class="numero">${n}</div><div class="muted chico">${txt}</div></div>`;
  const filaPend = (p) => `<tr>
      <td><button type="button" class="enlace" data-zona="${p.zona.id}">${esc(p.zona.nombre)}</button></td>
      <td>${nombreTarea(p.tarea)}</td>
      <td>${p.ultima ? fmtDia(p.ultima) : "Nunca"}</td>
      <td>${p.dias === null ? "Sin registro" : p.restan < 0 ? `<strong>Atrasada ${fmtNum(-p.restan)} d</strong>` : `Vence en ${fmtNum(Math.max(0, p.restan))} d`}</td>
      <td>${chipColor(p.color)}</td></tr>`;
  const tablaPend = (lista, vacio) => lista.length ? `<div class="tabla-scroll"><table>
      <thead><tr><th>Zona</th><th>Tarea</th><th>Última vez</th><th>Plazo</th><th>Estado</th></tr></thead>
      <tbody>${lista.map(filaPend).join("")}</tbody></table></div>` : `<div class="card vacio">${vacio}</div>`;
  return `<div class="fila entre informe-cabecera">
      <div><h1>Informe diario</h1><p class="muted" style="margin:0">${diaLargo(dia)}${dia === hoy ? " (hoy)" : ""}</p></div>
      <div class="fila no-imprimir">
        <button class="btn sec" type="button" data-dia="${sumarDias(dia, -1)}" aria-label="Día anterior">←</button>
        <input type="date" data-elegir-dia value="${dia}" max="${hoy}" style="width:auto">
        <button class="btn sec" type="button" data-dia="${sumarDias(dia, 1)}" ${dia >= hoy ? "disabled" : ""} aria-label="Día siguiente">→</button>
        <button class="btn" type="button" data-accion="imprimir">Imprimir</button>
      </div></div>
    <h2>Trabajos realizados</h2>
    <div class="grilla kpis">
      ${kpi(cuenta.tarea, "tareas de mantenimiento")}
      ${kpi(cuenta.descarga, "descargas (liberan)", "ok")}
      ${kpi(cuenta.exhumacion, "exhumaciones (liberan)", "ok")}
      ${kpi(cuenta.inhumacion, "inhumaciones (ocupan)")}
      ${kpi(fotos, "fotos adjuntas")}
    </div>
    ${regs.length ? `
      <div class="grilla" style="margin-top:12px">
        <div class="card"><h3>Por persona</h3>${Object.entries(porPersona).map(([n, c]) => `<div class="fila entre"><span>${esc(n)}</span><strong>${c}</strong></div>`).join("")}</div>
        <div class="card"><h3>Por tipo de tarea</h3>${Object.entries(porTarea).map(([t, c]) => `<div class="fila entre"><span>${nombreTarea(t)}</span><strong>${c}</strong></div>`).join("") || '<span class="muted">Sin tareas de mantenimiento.</span>'}</div>
      </div>
      <h3 style="margin-top:16px">Detalle del día</h3>${tablaMovimientos(regs.slice().reverse())}`
    : '<div class="card vacio" style="margin-top:12px">No se registraron trabajos firmados este día.</div>'}
    <h2>Reclamos de contribuyentes</h2>
    <div class="grilla kpis">
      ${kpi(Datos.estado.reclamos.filter((rc) => diaDe(rc.fecha) === dia).length, "reclamos recibidos")}
      ${kpi(Datos.estado.reclamos.filter((rc) => rc.resuelto_en && diaDe(rc.resuelto_en) === dia).length, "reclamos resueltos", "ok")}
      ${kpi(Datos.estado.reclamos.filter((rc) => rc.estado !== "resuelto").length, "sin resolver (hoy)")}
    </div>
    <p class="chico no-imprimir"><button type="button" class="enlace" data-pestana="reclamos">Ver los reclamos →</button></p>
    <h2>Trabajos pendientes</h2>
    <p class="muted chico">Según los plazos de mantenimiento de cada zona${enTemporada() ? " (acortados por la temporada de lluvias)" : ""}. Estado al momento de abrir el informe.</p>
    <div class="resumen-semaforo">
      <span class="chip rojo_critico">${vencidas.length} vencidas</span>
      <span class="chip amarillo">${porVencer.length} por vencer</span>
      <span class="chip verde">${proximas.length} vencen en los próximos 7 días</span>
    </div>
    <h3>Vencidas (hacer primero)</h3>${tablaPend(vencidas, "No hay tareas vencidas.")}
    <h3 style="margin-top:16px">Por vencer</h3>${tablaPend(porVencer, "No hay tareas por vencer.")}
    <details class="card" style="margin-top:16px"><summary><strong>Próximos 7 días (${proximas.length})</strong> <span class="muted chico">— tocá para ver</span></summary>
      <div style="margin-top:10px">${tablaPend(proximas, "Nada vence en los próximos 7 días.")}</div></details>
    <h2>Últimos 7 días</h2>
    <div class="tabla-scroll"><table>
      <thead><tr><th>Día</th><th>Tareas</th><th>Descargas</th><th>Exhumaciones</th><th>Inhumaciones</th><th>Total</th></tr></thead>
      <tbody>${semana.map(({ d, c, total }) => `<tr ${d === dia ? 'class="dia-actual"' : ""}>
        <td><button type="button" class="enlace" data-dia="${d}">${new Date(d + "T12:00:00").toLocaleDateString("es-AR", { weekday: "short", day: "2-digit", month: "2-digit" })}</button></td>
        <td>${c.tarea}</td><td>${c.descarga}</td><td>${c.exhumacion}</td><td>${c.inhumacion}</td><td><strong>${total}</strong></td></tr>`).join("")}</tbody>
    </table></div>
    <p class="muted chico" style="margin-top:12px">Informe generado el ${fmtFecha(new Date().toISOString())} · ${esc(UI.usuario.nombre)}</p>`;
}

function vistaAlertas() {
  const todas = alertasActuales();
  const nuevas = todas.filter((a) => !alertaVista(a));
  const vistas = todas.filter(alertaVista);
  const item = (a, conBoton) => `<div class="card alerta">
      <div>${chipNivel(a.nivel)} <strong>${esc(a.titulo)}</strong><div class="muted chico">${esc(a.detalle)}</div></div>
      <div class="fila">${a.zona ? `<button class="btn sec" type="button" data-zona="${a.zona}">Ver</button>` : a.pestana ? `<button class="btn sec" type="button" data-pestana="${a.pestana}">Ver</button>` : ""}${conBoton ? `<button class="btn sec" type="button" data-vista="${esc(a.clave)}|${a.nivel}">Marcar vista</button>` : ""}</div>
    </div>`;
  return `<h1>Alertas</h1>
    <p class="muted">Se abren y se cierran solas según el stock y los plazos de mantenimiento.</p>
    ${nuevas.length ? `<div class="lista-alertas">${nuevas.map((a) => item(a, true)).join("")}</div>` : '<div class="card vacio">No hay alertas nuevas.</div>'}
    ${vistas.length ? `<h2>Ya vistas (siguen abiertas)</h2><div class="lista-alertas">${vistas.map((a) => item(a, false)).join("")}</div>` : ""}`;
}

function descripcionRegistro(r) {
  const d = r.payload.datos;
  if (r.payload.accion === "tarea") return `${nombreTarea(d.tipo_tarea)} en ${esc(nombreZona(d.zona))} (${d.porcentaje}%)${d.fotos_sha256?.length ? ` · ${d.fotos_sha256.length} ${d.fotos_sha256.length === 1 ? "foto" : "fotos"}` : ""}`;
  if (ACCIONES_LIBERAN.includes(r.payload.accion)) return `${nombreAccion(r.payload.accion)} en ${d.tipo} ${d.tam} — ${esc(d.ubicacion)} (${esc(nombreZona(d.zona))}) · ${esc(d.difunto.nombre)} → ${esc(d.destino)} · <strong>quedó libre</strong>`;
  return `Inhumación en ${d.tipo} ${d.tam} — ${esc(d.ubicacion)} (${esc(nombreZona(d.zona))}) · ${esc(d.difunto.nombre)} · <strong>quedó ocupado</strong>`;
}
const nombreZona = (id) => Datos.estado.zonas.find((z) => z.id === id)?.nombre || "—";

// Lugares que quedaron libres por una descarga o exhumación (últimos 30 días) y siguen disponibles.
function seccionLiberados() {
  const desde = Date.now() - 30 * DIA;
  const lista = Datos.estado.espacios
    .filter((e) => e.estado === "disponible" && e.liberado_en && new Date(e.liberado_en) >= desde)
    .sort((a, b) => b.liberado_en.localeCompare(a.liberado_en));
  if (!lista.length) return "";
  const tipoTxt = (e) => (e.tipo === "nicho" ? "Nicho" : "Fosa") + (e.tam === "angelito" ? " de angelito" : e.tam === "extraordinario" ? " " + nombreTamano(e).toLowerCase() : "");
  return `<h2 id="liberados">Lugares liberados (disponibles)</h2>
    <p class="muted chico">Quedaron libres por una descarga o exhumación firmada y ya cuentan como disponibles.</p>
    <div class="lista-alertas">${lista.slice(0, 20).map((e) => `<div class="card alerta liberado">
      <div><span class="chip ok">Disponible</span> <strong>${esc(nombreZona(e.zona))} · ${esc(e.ub)}</strong>
        <div class="muted chico">${tipoTxt(e)} · ${e.liberado_por ? nombreAccion(e.liberado_por) : "Liberado"} del ${fmtFecha(e.liberado_en)}</div></div>
    </div>`).join("")}</div>`;
}

// Movimientos con su efecto sobre la disponibilidad.
function tablaMovimientos(regs) {
  const efecto = (r) => {
    const d = r.payload.datos;
    if (ACCIONES_OCUPAN.includes(r.payload.accion)) return `<span class="chip advertencia">−1 ${d.tipo === "nicho" ? "nicho" : "fosa"} libre</span>`;
    if (ACCIONES_LIBERAN.includes(r.payload.accion)) return `<span class="chip ok">+1 ${d.tipo === "nicho" ? "nicho" : "fosa"} libre</span>`;
    return `<span class="chip info">Mantenimiento</span>`;
  };
  return `<div class="tabla-scroll"><table>
    <thead><tr><th>Cuándo</th><th>Qué</th><th>Efecto</th><th>Código</th></tr></thead>
    <tbody>${regs.map((r) => `<tr>
      <td>${fmtFecha(r.registrado_en)}<br><span class="muted chico">${esc(r.payload.usuario.nombre)}</span></td>
      <td>${descripcionRegistro(r)}</td><td>${efecto(r)}</td>
      <td><button type="button" class="enlace mono" data-registro="${r.secuencia}">${codigoCorto(r.hash_registro)}</button></td>
    </tr>`).join("")}</tbody></table></div>`;
}

function tablaRegistros(regs) {
  return `<div class="tabla-scroll"><table>
    <thead><tr><th>Fecha y hora</th><th>Quién</th><th>Qué</th><th>Código</th></tr></thead>
    <tbody>${regs.map((r) => `<tr>
      <td>${fmtFecha(r.registrado_en)}</td>
      <td>${esc(r.payload.usuario.nombre)}<br><span class="muted chico">Legajo ${esc(r.payload.usuario.legajo)}</span></td>
      <td>${descripcionRegistro(r)}</td>
      <td><button type="button" class="enlace mono" data-registro="${r.secuencia}">${codigoCorto(r.hash_registro)}</button></td>
    </tr>`).join("")}</tbody></table></div>`;
}

function vistaRegistro() {
  const regs = Datos.estado.registros.slice().reverse();
  return `<div class="fila entre"><h1>Registro firmado</h1>
      <button class="btn sec" type="button" data-accion="verificar" ${regs.length ? "" : "disabled"}>Verificar integridad</button></div>
    <p class="muted">Cada tarea y cada descarga queda con quién la hizo, fecha y hora, ubicación y firma. No se puede editar ni borrar: si alguien cambia algo, la verificación lo detecta.</p>
    <div id="resultado-verificacion"></div>
    ${regs.length ? tablaRegistros(regs) : '<div class="card vacio">Todavía no hay registros firmados.</div>'}`;
}

function detalleRegistro(sec) {
  const r = Datos.estado.registros.find((x) => x.secuencia === sec);
  if (!r) return;
  const p = r.payload;
  const gps = p.gps ? `<a href="https://www.google.com/maps?q=${p.gps.lat},${p.gps.lng}" target="_blank" rel="noopener">${p.gps.lat.toFixed(5)}, ${p.gps.lng.toFixed(5)}</a> (±${Math.round(p.gps.precision)} m)` : "No disponible";
  abrirModal(`<h2 style="margin-top:0">Registro N° ${r.secuencia}</h2>
    <div class="resumen-firma"><dl>
      <dt>Qué</dt><dd>${descripcionRegistro(r)}</dd>
      ${p.datos.observaciones ? `<dt>Observaciones</dt><dd>${esc(p.datos.observaciones)}</dd>` : ""}
      ${p.datos.difunto ? `<dt>${ACCIONES_LIBERAN.includes(p.accion) ? "Persona" : "Difunto"}</dt><dd>${esc(p.datos.difunto.nombre)}${p.datos.difunto.dni ? " · DNI " + esc(p.datos.difunto.dni) : ""}${p.datos.difunto.fecha ? " · fallecimiento " + esc(p.datos.difunto.fecha) : ""}</dd>${p.datos.destino ? `<dt>Destino</dt><dd>${esc(p.datos.destino)}</dd>` : ""}<dt>N° de planilla</dt><dd>${esc(p.datos.expediente || "—")}</dd>` : ""}
      <dt>Quién</dt><dd>${esc(p.usuario.nombre)} · legajo ${esc(p.usuario.legajo)}</dd>
      <dt>Hora de registro</dt><dd>${fmtFecha(r.registrado_en)}</dd>
      <dt>Hora del celular</dt><dd>${fmtFecha(p.hora_dispositivo)}</dd>
      <dt>Ubicación</dt><dd>${gps}</dd>
      <dt>Dispositivo</dt><dd class="mono">${esc(p.dispositivo_id)}</dd>
      <dt>Firmado con</dt><dd>PIN personal, trazo de firma y firma digital del dispositivo</dd>
      <dt>Huella del contenido</dt><dd class="mono">${r.payload_sha256}</dd>
      <dt>Sello anterior</dt><dd class="mono">${r.hash_anterior}</dd>
      <dt>Sello del registro</dt><dd class="mono">${r.hash_registro}</dd>
    </dl></div>
    ${r.fotos?.length ? `<h3 style="margin-top:16px">Fotos del trabajo</h3><div class="fotos">${r.fotos.map((src, i) => `<a href="${src}" target="_blank" rel="noopener"><img src="${src}" alt="Foto ${i + 1} del trabajo"></a>`).join("")}</div>` : ""}
    <h3 style="margin-top:16px">Trazo de firma</h3>
    <img src="${r.trazo}" alt="Trazo de firma" style="width:100%;max-width:420px;border:1px solid var(--line);border-radius:10px;background:#fff">
    <p style="margin-top:16px"><button class="btn sec" type="button" data-accion="cerrar">Cerrar</button></p>`);
}

function vistaAjustes() {
  const e = Datos.estado;
  return `<h1>Ajustes</h1>
  <p class="muted">Valores de ejemplo: la Dirección los define. Al guardar, las alertas y el semáforo se recalculan.</p>
  <form class="form" data-form="ajustes" style="max-width:none">
    <h2>Umbrales de faltante</h2>
    <div class="tabla-scroll"><table>
      <thead><tr><th>Tipo</th><th>Advertencia (≤)</th><th>Crítico (≤)</th><th>Cobertura crítica (días)</th></tr></thead>
      <tbody>${STOCK_CLAVES.map(([t, m]) => { const k = t + "|" + m, u = e.umbrales[k]; return `<tr><td>${nombreStock(t, m)}</td>
        <td><input type="number" min="0" name="adv:${k}" value="${u.adv}" aria-label="Advertencia ${nombreStock(t, m)}"></td>
        <td><input type="number" min="0" name="crit:${k}" value="${u.crit}" aria-label="Crítico ${nombreStock(t, m)}"></td>
        <td><input type="number" min="0" name="cob:${k}" value="${u.cobertura || 0}" aria-label="Cobertura ${nombreStock(t, m)}"></td></tr>`; }).join("")}</tbody>
    </table></div>
    <h2>Plazos de mantenimiento</h2>
    <div class="tabla-scroll"><table>
      <thead><tr><th>Tarea</th><th>Verde hasta (días)</th><th>Rojo después de (días)</th><th>Se acorta con lluvia</th></tr></thead>
      <tbody>${Object.entries(e.reglas).map(([k, r]) => `<tr><td>${nombreTarea(k)}</td>
        <td><input type="number" min="1" name="verde:${k}" value="${r.verde}" aria-label="Verde ${nombreTarea(k)}"></td>
        <td><input type="number" min="2" name="rojo:${k}" value="${r.rojo}" aria-label="Rojo ${nombreTarea(k)}"></td>
        <td><input type="checkbox" name="lluvia:${k}" ${r.lluvia ? "checked" : ""} style="width:24px;min-height:24px" aria-label="Lluvia ${nombreTarea(k)}"></td></tr>`).join("")}</tbody>
    </table></div>
    <h2>Temporada de lluvias</h2>
    <div class="dos-col" style="max-width:560px">
      <label>Desde (mes-día)<input name="t-desde" value="${e.temporada.desde}" pattern="\\d{2}-\\d{2}" required></label>
      <label>Hasta (mes-día)<input name="t-hasta" value="${e.temporada.hasta}" pattern="\\d{2}-\\d{2}" required></label>
      <label>Factor de plazos <span class="muted">(0,60 = 40 % más corto)</span><input name="t-factor" type="number" step="0.05" min="0.1" max="1" value="${e.temporada.factor}" required></label>
    </div>
    <div><button class="btn" type="submit">Guardar ajustes</button></div>
  </form>`;
}

/* Campo */
function vistaMisZonas() {
  const u = UI.usuario;
  const mias = Datos.estado.zonas.filter((z) => u.zonas.includes(z.id)).map((z) => ({ z, s: semaforoZona(z) }))
    .sort((a, b) => ORDEN_COLOR[b.s.color] - ORDEN_COLOR[a.s.color]);
  const urgentes = mias.filter(({ s }) => s.color !== "verde").length;
  return `<h1>Mis zonas</h1>
    <p class="muted">${urgentes ? `${urgentes} zonas necesitan atención. Las más atrasadas aparecen primero.` : "Todas tus zonas están al día."}</p>
    <div class="zonas">${mias.map(({ z, s }) => tileZona(z, s)).join("")}</div>
    <div class="grilla" style="margin-top:20px">
      <button class="btn grande" type="button" data-pestana="tarea">Registrar tarea</button>
      <button class="btn grande sec" type="button" data-pestana="descarga">Registrar descarga</button>
    </div>`;
}

function vistaTarea() {
  const u = UI.usuario;
  const b = UI.borrador?.accion === "tarea" ? UI.borrador : { zona: u.zonas[0], tipo_tarea: "corte_cesped", porcentaje: 100, observaciones: "" };
  // Se puede registrar en cualquier zona o sector (no solo en las asignadas).
  const todas = Datos.estado.zonas;
  const opcion = (z) => `<option value="${z.id}" ${z.id === b.zona ? "selected" : ""}>${esc(z.nombre)} — ${COLORES[semaforoZona(z).color]}</option>`;
  const grupo = (titulo, lista) => (lista.length ? `<optgroup label="${titulo}">${lista.map(opcion).join("")}</optgroup>` : "");
  const opciones =
    grupo("Parque — zonas 1 a 28", todas.filter((z) => z.numero && !z.covid)) +
    grupo("Zonas COVID", todas.filter((z) => z.covid)) +
    grupo("Sección Vieja y Sección Nueva (fosas)", todas.filter((z) => !z.numero && z.tipo === "parque_fosas")) +
    grupo("Nichos", todas.filter((z) => z.tipo === "nichos"));
  return `<h1>Registrar tarea</h1>
    <p class="muted">Al terminar el trabajo, completá y firmá. La fecha, la hora y tu ubicación se toman solas.</p>
    <form class="form" data-form="tarea">
      <label>Zona<select name="zona" required>${opciones}</select></label>
      <fieldset style="border:0;padding:0;margin:0"><legend style="font-weight:600;margin-bottom:6px">Tarea realizada</legend>
        <div class="opciones">${Object.entries(TAREAS).map(([k, t]) => `<button type="button" class="opcion" data-elegir="tipo_tarea" data-valor="${k}" aria-pressed="${k === b.tipo_tarea}">${t}</button>`).join("")}</div>
        <input type="hidden" name="tipo_tarea" value="${b.tipo_tarea}">
      </fieldset>
      <label>¿Cuánto de la zona se cubrió?<select name="porcentaje">${[100, 75, 50, 25].map((p) => `<option value="${p}" ${p === b.porcentaje ? "selected" : ""}>${p}%</option>`).join("")}</select></label>
      <label>Observaciones <span class="muted">(opcional)</span><textarea name="observaciones" maxlength="600">${esc(b.observaciones)}</textarea></label>
      <div>
        <strong>Fotos del trabajo</strong> <span class="muted">(opcional, hasta ${MAX_FOTOS})</span>
        <p class="muted chico" style="margin:2px 0 8px">Sirven como constancia de que el trabajo se hizo. Quedan firmadas junto con el registro.</p>
        <div class="fotos" id="fotos-previa">${previaFotos()}</div>
        <label class="btn sec" style="margin-top:8px" ${UI.fotos.length >= MAX_FOTOS ? "hidden" : ""} id="agregar-foto">📷 Agregar foto
          <input type="file" accept="image/*" multiple data-fotos hidden></label>
      </div>
      <button class="btn grande" type="submit">Continuar a la firma</button>
    </form>`;
}

function vistaDescarga() { return vistaOperacion("descarga"); }
function vistaExhumacion() { return vistaOperacion("exhumacion"); }
function vistaInhumacion() { return vistaOperacion("inhumacion"); }

// Descarga y exhumación: el lugar queda libre y vuelve a contar como disponible en el Resumen.
// Inhumación: el lugar pasa a ocupado. Mismo formulario de ubicación: zona + planta/cuadro/bloque + fila + número.
function vistaOperacion(modo) {
  const exh = OPERACIONES[modo].libera;
  const tipos = OPERACIONES[modo].tipos;
  const b = UI.borrador?.accion === modo ? { ...UI.borrador } : { tipo: tipos[0], tam: "normal", zona: "" };
  if (!tipos.includes(b.tipo)) b.tipo = tipos[0];
  if (b.tam === "angelito" && b.tipo !== "fosa") b.tam = "normal"; // angelitos: solo fosas
  const queLugar = tipos.length === 2 ? "el nicho o la fosa" : tipos[0] === "nicho" ? "el nicho" : "la fosa";
  UI.filtroDescarga = { tipo: b.tipo, tam: b.tam, zona: b.zona, planta: "", lugar: "", cuadro: "", fila: "" };
  const op = (campo, valor, txt) => `<button type="button" class="opcion" data-elegir="${campo}" data-valor="${valor}" aria-pressed="${b[campo] === valor}">${txt}</button>`;
  return `<h1>${OPERACIONES[modo].titulo}</h1>
    <p class="muted">${exh ? `Al firmar, ${queLugar} queda <strong>libre</strong> y vuelve a contarse como disponible en el Resumen.` : "El nicho o la fosa pasa a <strong>ocupado</strong> y se descuenta de los disponibles."}
      ${tipos.length === 1 ? `<br><strong>Solo ${tipos[0] === "nicho" ? "nichos: aparecen únicamente los sectores con nichos" : "fosas: aparecen únicamente las zonas y secciones con fosas"}.</strong>` : ""}</p>
    <form class="form" data-form="${modo}">
      <div class="dos-col">
        <fieldset style="border:0;padding:0;margin:0"><legend style="font-weight:600;margin-bottom:6px">Tipo</legend>
          <div class="opciones">${tipos.length === 2 ? op("tipo", "nicho", "Nicho") + op("tipo", "fosa", "Fosa") : `<span class="opcion" aria-pressed="true" style="cursor:default">${tipos[0] === "nicho" ? "Nicho" : "Fosa"}</span>`}</div></fieldset>
        <fieldset style="border:0;padding:0;margin:0"><legend style="font-weight:600;margin-bottom:6px">Tamaño</legend>
          <div class="opciones">${op("tam", "normal", "Normal")}${op("tam", "extraordinario", "Extraordinario")}${tipos.includes("fosa") ? op("tam", "angelito", "Angelito").replace("<button", `<button${b.tipo === "fosa" ? "" : " hidden"}`) : ""}</div></fieldset>
      </div>
      <input type="hidden" name="tipo" value="${b.tipo}"><input type="hidden" name="tam" value="${b.tam}">
      <label>Zona<select name="zona" data-filtro-zona><option value="">Todas las zonas</option></select></label>
      <div id="sub-ubicacion" hidden></div>
      <div id="carga-manual" class="form">
        <label id="campo-fila">Fila<select name="fila" data-filtro-fila></select></label>
        <label id="campo-cuadro">Cuadro<select name="cuadro" data-filtro-cuadro></select></label>
        <label><span id="titulo-numero">Número de nicho</span> <span class="muted">(escribilo a mano)</span>
          <input name="numero_manual" type="number" min="1" max="99999" inputmode="numeric" autocomplete="off" placeholder="Ej.: 125"></label>
        <div><span class="muted chico">${exh ? "Ocupados registrados en esta ubicación" : "Libres en esta ubicación"} (tocá uno para completarlo):</span>
          <ul class="espacios-libres" id="sugeridos"></ul></div>
      </div>
      <h2 style="margin:4px 0 0">${exh ? "Datos de la persona (restos retirados)" : "Datos de la persona fallecida"}</h2>
      <label>Apellido y nombre<input name="dif_nombre" required maxlength="120" autocomplete="off"></label>
      <label>Fecha de fallecimiento${exh ? ' <span class="muted">(opcional)</span>' : ""}<input name="dif_fecha" type="date" ${exh ? "" : "required"}></label>
      ${exh ? `<label>Destino de los restos<select name="destino" required>
        <option value="">Elegí el destino</option>${DESTINOS_EXHUMACION.map((d) => `<option>${d}</option>`).join("")}</select></label>` : ""}
      <label>N° de planilla<input name="expediente" required maxlength="60" autocomplete="off"></label>
      <label>Observaciones <span class="muted">(opcional)</span><textarea name="observaciones" maxlength="600"></textarea></label>
      <button class="btn grande" type="submit">Continuar a la firma</button>
    </form>`;
}

function actualizarListaEspacios() {
  const form = $('form[data-form="descarga"], form[data-form="exhumacion"], form[data-form="inhumacion"]');
  if (!form) return;
  const f = UI.filtroDescarga;
  // Descarga: se buscan lugares libres. Exhumación: lugares ocupados (que quedarán libres).
  const exh = OPERACIONES[form.dataset.form].libera;
  const palabra = exh ? "ocupados" : "libres";
  const disponibles = Datos.estado.espacios.filter((e) => e.tipo === f.tipo && e.tam === f.tam && e.estado === (exh ? "ocupado" : "disponible"));
  const porZona = {};
  disponibles.forEach((e) => (porZona[e.zona] = (porZona[e.zona] || 0) + 1));
  const selZona = form.elements.zona;
  // Todas las zonas del tipo (aunque no tengan libres registrados: el número se puede cargar a mano).
  const zonasTipo = Datos.estado.zonas.filter((z) => (f.tipo === "nicho" ? z.tipo === "nichos" : z.tipo === "parque_fosas"));
  if (f.zona && !zonasTipo.some((z) => String(z.id) === String(f.zona))) f.zona = "";
  selZona.innerHTML = `<option value="">Elegí la zona</option>` +
    zonasTipo.map((z) => `<option value="${z.id}" ${String(z.id) === String(f.zona) ? "selected" : ""}>${esc(z.nombre)} (${porZona[z.id] || 0} ${palabra})</option>`).join("");
  const enZona = disponibles.filter((e) => !f.zona || e.zona === Number(f.zona));

  // Datos de ubicación según la zona elegida: planta (Pabellón Amarillo),
  // cuadro/bloque (Sección Vieja) o cuadro (fosas de las zonas 1 a 30).
  const zonaSel = f.zona ? Datos.estado.zonas.find((z) => z.id === Number(f.zona)) : null;
  const sub = $("#sub-ubicacion");
  let html = "";
  const cuantos = (pred) => enZona.filter(pred).length;
  if (zonaSel?.codigo === "PAB_AMARILLO" && f.tipo === "nicho") {
    const btn = (valor, txt) => `<button type="button" class="opcion" data-planta="${valor}" aria-pressed="${String(f.planta) === String(valor)}">${txt}</button>`;
    html = `<fieldset style="border:0;padding:0;margin:0"><legend style="font-weight:600;margin-bottom:6px">Planta</legend>
      <div class="opciones">${btn("", `Todas (${enZona.length})`)}${PLANTAS.map((p, i) => btn(i + 1, `${p} (${cuantos((e) => e.planta === i + 1)})`)).join("")}</div></fieldset>`;
  } else if (zonaSel?.codigo === "SV_NICHOS" && f.tipo === "nicho") {
    // Todos los cuadros/bloques del plano (en una exhumación casi nunca están cargados de antemano).
    const lugares = [...new Set([...BLOQUES_CON_NICHOS.map(etiquetaBloque), ...enZona.map((e) => e.lugar)])].sort((a, b) => a.localeCompare(b, "es", { numeric: true }));
    html = `<label>Cuadro / Bloque<select data-filtro-lugar><option value="">Todos (${enZona.length})</option>
      ${lugares.map((l) => `<option value="${esc(l)}" ${l === f.lugar ? "selected" : ""}>${esc(l)} (${cuantos((e) => e.lugar === l)})</option>`).join("")}</select></label>`;
  }
  if (sub) { sub.innerHTML = html; sub.hidden = !html; }

  const lista = enZona
    .filter((e) => !f.planta || e.planta === Number(f.planta))
    .filter((e) => !f.lugar || e.lugar === f.lugar)
    .filter((e) => !f.cuadro || e.cuadro === Number(f.cuadro))
    .sort((a, b) => a.zona - b.zona || (a.cuadro ?? 0) - (b.cuadro ?? 0) || (a.lugar ?? "").localeCompare(b.lugar ?? "", "es", { numeric: true }) || (a.fila ?? 0) - (b.fila ?? 0) || a.numero - b.numero);

  // Carga a mano: nichos → fila + número; fosas de las zonas 1 a 30 → cuadro + número;
  // fosas de las secciones → solo número. Los libres se muestran como ayuda.
  const esNicho = f.tipo === "nicho";
  const conCuadro = !esNicho && !!zonaSel?.numero;
  $("#campo-fila").hidden = !esNicho;
  $("#campo-cuadro").hidden = !conCuadro;
  $("#titulo-numero").textContent = esNicho ? "Número de nicho" : "Número de fosa";
  if (esNicho) {
    const porFila = (n) => lista.filter((e) => e.fila === n).length;
    form.elements.fila.innerHTML = `<option value="">Elegí la fila</option>` +
      Array.from({ length: MAX_FILAS }, (_, i) => i + 1).map((n) => `<option value="${n}" ${String(n) === String(f.fila) ? "selected" : ""}>Fila ${n}${porFila(n) ? ` (${porFila(n)} ${palabra})` : ""}</option>`).join("");
  }
  if (conCuadro) {
    const porCuadro = (n) => lista.filter((e) => e.cuadro === n).length;
    form.elements.cuadro.innerHTML = `<option value="">Elegí el cuadro</option>` +
      Array.from({ length: MAX_CUADROS }, (_, i) => i + 1).map((n) => `<option value="${n}" ${String(n) === String(f.cuadro) ? "selected" : ""}>Cuadro ${n}${porCuadro(n) ? ` (${porCuadro(n)} ${palabra})` : ""}</option>`).join("");
  }
  const sugeridos = lista.filter((e) => (!f.fila || e.fila === Number(f.fila))).slice(0, 40);
  const textoSugerido = (e) => esNicho
    ? `${f.fila ? "" : `Fila ${e.fila} · `}N° ${e.numero}${f.planta || !e.planta ? "" : ` · ${PLANTAS[e.planta - 1]}`}${f.lugar || !e.lugar || e.planta ? "" : ` · ${esc(e.lugar)}`}`
    : `${e.cuadro && !f.cuadro ? `Cuadro ${e.cuadro} · ` : ""}Fosa ${e.numero}`;
  $("#sugeridos").innerHTML = f.zona
    ? sugeridos.map((e) => `<li><button type="button" class="enlace" data-sugerido="${e.id}">${textoSugerido(e)}${e.tam !== "normal" ? " · " + nombreTamano(e) : ""}</button></li>`).join("") || `<li class="muted">No hay ${palabra} registrados acá. Igual podés cargar el número a mano.</li>`
    : '<li class="muted">Elegí primero la zona.</li>';
}

function vistaMisRegistros() {
  const regs = Datos.estado.registros.filter((r) => r.payload.usuario.id === UI.usuario.id).reverse();
  return `<h1>Mis registros</h1>
    <p class="muted">Lo que firmaste desde la app. Tocá el código para ver el comprobante.</p>
    ${regs.length ? tablaRegistros(regs) : '<div class="card vacio">Todavía no registraste nada.</div>'}`;
}

/* ───────────────────────── Fotos del trabajo ───────────────────────── */
function previaFotos() {
  return UI.fotos.map((src, i) => `<div class="foto"><img src="${src}" alt="Foto ${i + 1}"><button type="button" data-quitar-foto="${i}" aria-label="Quitar foto ${i + 1}">✕</button></div>`).join("");
}
function refrescarFotos() {
  const previa = $("#fotos-previa");
  if (previa) previa.innerHTML = previaFotos();
  const boton = $("#agregar-foto");
  if (boton) boton.hidden = UI.fotos.length >= MAX_FOTOS;
}
// Achica la foto (lado mayor 900 px, JPEG) para que entre en el celular y se suba rápido.
function achicarFoto(archivo) {
  return new Promise((ok, mal) => {
    const url = URL.createObjectURL(archivo);
    const img = new Image();
    img.onload = () => {
      const escala = Math.min(1, 900 / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * escala); c.height = Math.round(img.height * escala);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      ok(c.toDataURL("image/jpeg", 0.6));
    };
    img.onerror = () => { URL.revokeObjectURL(url); mal(new Error("No se pudo leer la imagen.")); };
    img.src = url;
  });
}

/* ───────────────────────── Firma (modal) ───────────────────────── */
function abrirFirma(accion, datos, resumenHtml) {
  UI.firmaPendiente = { accion, datos, gps: null };
  abrirModal(`<h2 style="margin-top:0">Conformidad y firma</h2>
    <div class="resumen-firma"><dl>${resumenHtml}
      <dt>Quién</dt><dd>${esc(UI.usuario.nombre)} · legajo ${esc(UI.usuario.legajo)}</dd>
      <dt>Ubicación</dt><dd id="gps-estado">Buscando ubicación…</dd>
    </dl></div>
    <form class="form" data-form="firma" style="margin-top:14px">
      <div>
        <div class="fila entre"><strong>Firmá con el dedo</strong><button type="button" class="enlace" data-accion="borrar-trazo">Borrar</button></div>
        <canvas class="lienzo" id="lienzo" aria-label="Recuadro para firmar"></canvas>
      </div>
      <label>Tu PIN<input name="pin" type="password" inputmode="numeric" autocomplete="off" required maxlength="8" placeholder="••••"></label>
      <button class="btn grande" type="submit">Firmar y registrar</button>
      <button class="btn sec" type="button" data-accion="cerrar">Volver</button>
    </form>`);
  prepararLienzo($("#lienzo"));
  if ("geolocation" in navigator) {
    navigator.geolocation.getCurrentPosition(
      (p) => {
        if (!UI.firmaPendiente) return;
        UI.firmaPendiente.gps = { lat: p.coords.latitude, lng: p.coords.longitude, precision: p.coords.accuracy };
        const el = $("#gps-estado"); if (el) el.textContent = `${p.coords.latitude.toFixed(5)}, ${p.coords.longitude.toFixed(5)} (±${Math.round(p.coords.accuracy)} m)`;
      },
      () => { const el = $("#gps-estado"); if (el) el.textContent = "Sin ubicación (permiso denegado o sin señal). Se registra igual."; },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 });
  } else { $("#gps-estado").textContent = "Este equipo no informa ubicación."; }
}

function prepararLienzo(c) {
  const ratio = window.devicePixelRatio || 1;
  const rect = c.getBoundingClientRect();
  c.width = rect.width * ratio; c.height = rect.height * ratio;
  const ctx = c.getContext("2d");
  ctx.scale(ratio, ratio); ctx.lineWidth = 2.5; ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.strokeStyle = "#111";
  c.trazos = 0;
  let dibujando = false;
  const pos = (e) => { const r = c.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  c.addEventListener("pointerdown", (e) => { dibujando = true; c.setPointerCapture(e.pointerId); ctx.beginPath(); ctx.moveTo(...pos(e)); });
  c.addEventListener("pointermove", (e) => { if (!dibujando) return; ctx.lineTo(...pos(e)); ctx.stroke(); c.trazos++; });
  const fin = () => { dibujando = false; };
  c.addEventListener("pointerup", fin); c.addEventListener("pointercancel", fin);
}

function trazoReducido(c) {
  const out = document.createElement("canvas");
  out.width = 420; out.height = Math.round((c.height / c.width) * 420);
  const ctx = out.getContext("2d");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(c, 0, 0, out.width, out.height);
  return out.toDataURL("image/png");
}

/* ───────────────────────── Eventos ───────────────────────── */
document.addEventListener("click", async (ev) => {
  const el = ev.target.closest("button, [data-zona], [data-ver-disp]");
  if (!el) { if (ev.target === $("#modal")) cerrarModal(); return; }
  const d = el.dataset;
  if (d.pestana) { UI.pestana = d.pestana; cerrarModal(); render(); $("#vista").focus({ preventScroll: true }); window.scrollTo(0, 0); return; }
  if (d.zona) { detalleZona(Number(d.zona)); return; }
  if (d.registro) { detalleRegistro(Number(d.registro)); return; }
  if (d.filtro) { UI.filtroColor = d.filtro; render(); return; }
  if ("planta" in d) { Object.assign(UI.filtroDescarga, { planta: d.planta, fila: "" }); actualizarListaEspacios(); return; }
  if (d.sugerido) {
    const e = Datos.estado.espacios.find((x) => x.id === Number(d.sugerido));
    const form = el.closest("form");
    if (e && form) {
      if (e.planta) UI.filtroDescarga.planta = String(e.planta);
      if (e.lugar && !e.planta) UI.filtroDescarga.lugar = e.lugar;
      if (e.fila) UI.filtroDescarga.fila = String(e.fila);
      if (e.cuadro) UI.filtroDescarga.cuadro = String(e.cuadro);
      actualizarListaEspacios();
      form.elements.numero_manual.value = e.numero;
    }
    return;
  }
  if (d.dia) { UI.diaInforme = d.dia; render(); return; }
  if (d.periodo) { UI.periodoRanking = d.periodo; render(); return; }
  if (d.periodoReclamos) { UI.periodoReclamos = d.periodoReclamos; render(); return; }
  if (d.filtroReclamos) { UI.filtroReclamos = d.filtroReclamos; render(); return; }
  if (d.reclamo) { detalleReclamo(d.reclamo); return; }
  if (d.estadoReclamo) { el.form.elements.estado.value = d.estadoReclamo; return; } // sigue al submit del formulario
  if (d.reabrirReclamo) {
    const rc = Datos.estado.reclamos.find((x) => x.id === d.reabrirReclamo);
    if (rc) {
      rc.estado = "pendiente"; rc.resuelto_en = null;
      rc.historial.push({ fecha: new Date().toISOString(), estado: "pendiente", usuario: UI.usuario.nombre, nota: "Reabierto" });
      Datos.guardar(); render(); detalleReclamo(rc.id); avisar(`Reclamo N° ${rc.numero} reabierto.`);
    }
    return;
  }
  if (d.editarCapataz) { editarCapataz(d.editarCapataz); return; }
  if (d.activarCapataz) {
    const u = Datos.estado.usuarios.find((x) => x.id === d.activarCapataz);
    if (u && (u.activo === false || confirm(`¿Desactivar a ${u.nombre}? No va a poder ingresar. Sus trabajos quedan registrados.`))) {
      u.activo = u.activo === false;
      Datos.guardar(); render(); avisar(u.activo ? `${u.nombre} puede volver a ingresar.` : `${u.nombre} ya no puede ingresar.`);
    }
    return;
  }
  if (d.filtroDisp) { UI.filtroDisp.tipo = d.filtroDisp; render(); return; }
  if (d.verDisp) {
    const [tipo, tam] = d.verDisp.split("|");
    UI.listado = { tipo, tam, zona: "" };
    abrirListado();
    return;
  }
  if (d.quitarFoto) { UI.fotos.splice(Number(d.quitarFoto), 1); refrescarFotos(); return; }
  if (d.vista) {
    const i = d.vista.lastIndexOf("|");
    Datos.estado.alertasVistas[d.vista.slice(0, i)] = d.vista.slice(i + 1);
    Datos.guardar(); render(); return;
  }
  if (d.irTarea) {
    UI.borrador = { accion: "tarea", zona: Number(d.irTarea), tipo_tarea: "corte_cesped", porcentaje: 100, observaciones: "" };
    UI.pestana = "tarea"; cerrarModal(); render(); return;
  }
  if (d.elegir) {
    const form = el.closest("form");
    form.querySelectorAll(`[data-elegir="${d.elegir}"]`).forEach((b) => b.setAttribute("aria-pressed", String(b === el)));
    form.elements[d.elegir].value = d.valor;
    if (d.elegir === "tipo") { // el tamaño "Angelito" es solo de fosas
      const ang = form.querySelector('[data-elegir="tam"][data-valor="angelito"]');
      if (ang) {
        ang.hidden = d.valor !== "fosa";
        if (ang.hidden && form.elements.tam.value === "angelito") {
          form.elements.tam.value = "normal"; UI.filtroDescarga.tam = "normal";
          form.querySelectorAll('[data-elegir="tam"]').forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.valor === "normal")));
        }
      }
    }
    if (OPERACIONES[form.dataset.form]) { Object.assign(UI.filtroDescarga, { [d.elegir]: d.valor, planta: "", lugar: "", cuadro: "", fila: "" }); actualizarListaEspacios(); }
    return;
  }
  switch (d.accion) {
    case "salir":
      UI.usuario = null; UI.borrador = null; UI.fotos = [];
      try { localStorage.removeItem(CLAVE_SESION); } catch { /* sin almacenamiento */ }
      render(); break;
    case "cerrar": UI.firmaPendiente = null; cerrarModal(); break;
    case "imprimir": window.print(); break;
    case "borrar-trazo": { const c = $("#lienzo"); c.getContext("2d").clearRect(0, 0, c.width, c.height); c.trazos = 0; break; }
    case "verificar": {
      el.disabled = true; el.textContent = "Verificando…";
      const res = await verificarCadena();
      const malos = res.filter((r) => !r.ok);
      $("#resultado-verificacion").innerHTML = malos.length
        ? `<div class="banner critica"><div><strong>${malos.length === 1 ? "Se detectó 1 registro alterado" : `Se detectaron ${malos.length} registros alterados`}</strong><ul>${malos.map((m) => `<li>N° ${m.secuencia}: ${m.problemas.join(", ")}</li>`).join("")}</ul></div></div>`
        : `<div class="banner" style="background:var(--verde-bg);color:var(--verde);border:1px solid currentColor"><div><strong>Todo en orden</strong>${res.length === 1 ? "El registro está completo y con firma válida." : `Los ${res.length} registros están completos, encadenados y con firma válida.`}</div></div>`;
      el.disabled = false; el.textContent = "Verificar integridad";
      break;
    }
  }
});

document.addEventListener("change", async (ev) => {
  if (ev.target.matches("[data-fotos]")) {
    const elegidos = [...ev.target.files];
    const archivos = elegidos.slice(0, MAX_FOTOS - UI.fotos.length);
    ev.target.value = "";
    for (const a of archivos) {
      try { UI.fotos.push(await achicarFoto(a)); } catch (e) { avisar(e.message); }
    }
    if (elegidos.length > archivos.length) avisar(`Se pueden adjuntar hasta ${MAX_FOTOS} fotos.`);
    refrescarFotos();
    return;
  }
  if (ev.target.matches("[data-listado-zona]")) { UI.listado.zona = ev.target.value; abrirListado(); return; }
  if (ev.target.matches("[data-elegir-dia]")) { if (ev.target.value) { UI.diaInforme = ev.target.value; render(); } return; }
  if (ev.target.matches("[data-filtro-extra]")) { UI.filtroDisp.extra = ev.target.value; render(); return; }
  if (ev.target.matches("[data-filtro-zona]")) { Object.assign(UI.filtroDescarga, { zona: ev.target.value, planta: "", lugar: "", cuadro: "", fila: "" }); actualizarListaEspacios(); }
  if (ev.target.matches("[data-filtro-lugar]")) { Object.assign(UI.filtroDescarga, { lugar: ev.target.value, fila: "" }); actualizarListaEspacios(); }
  if (ev.target.matches("[data-filtro-fila]")) { UI.filtroDescarga.fila = ev.target.value; actualizarListaEspacios(); }
  if (ev.target.matches("[data-filtro-cuadro]")) { UI.filtroDescarga.cuadro = ev.target.value; actualizarListaEspacios(); }
});

document.addEventListener("submit", async (ev) => {
  const form = ev.target;
  ev.preventDefault();
  const f = form.elements;
  const tipoForm = form.dataset.form;
  try {
    if (tipoForm === "login") {
      const u = Datos.estado.usuarios.find((x) => x.id === f.usuario.value && x.activo !== false);
      if (!u || (await sha256("pin:" + f.pin.value)) !== u.pin) { avisar("El PIN no es correcto."); f.pin.value = ""; f.pin.focus(); return; }
      UI.usuario = u; UI.pestana = null; $("#toast").hidden = true;
      try { localStorage.setItem(CLAVE_SESION, u.id); } catch { /* sin almacenamiento */ }
      render();
    } else if (tipoForm === "tarea") {
      const datos = {
        zona: Number(f.zona.value), tipo_tarea: f.tipo_tarea.value,
        porcentaje: Number(f.porcentaje.value), observaciones: f.observaciones.value.trim() || undefined,
      };
      UI.borrador = { accion: "tarea", ...datos, observaciones: datos.observaciones || "" };
      abrirFirma("tarea", datos, `<dt>Tarea</dt><dd>${nombreTarea(datos.tipo_tarea)} (${datos.porcentaje}%)</dd><dt>Zona</dt><dd>${esc(nombreZona(datos.zona))}</dd>${datos.observaciones ? `<dt>Obs.</dt><dd>${esc(datos.observaciones)}</dd>` : ""}${UI.fotos.length ? `<dt>Fotos</dt><dd>${UI.fotos.length}</dd>` : ""}`);
      UI.firmaPendiente.fotos = UI.fotos.slice();
    } else if (OPERACIONES[tipoForm]) {
      const exh = OPERACIONES[tipoForm].libera;
      if (!OPERACIONES[tipoForm].tipos.includes(f.tipo.value)) { avisar(`${OPERACIONES[tipoForm].nombre}: solo ${OPERACIONES[tipoForm].tipos.map((t) => t + "s").join(" o ")}.`); return; }
      if (f.tam.value === "angelito" && f.tipo.value !== "fosa") { avisar("Las de angelitos son solo fosas."); return; }
      let esp, altaManual = false;
      const fd = UI.filtroDescarga;
      const zona = Datos.estado.zonas.find((z) => z.id === Number(fd.zona));
      const num = Number(f.numero_manual.value);
      if (!zona) { avisar("Elegí la zona."); return; }
      const ocupadoTxt = (e) => {
        const a = e.tipo === "fosa" ? "a" : "o";
        return { disponible: "libre", reservado: "reservad" + a, ocupado: "ocupad" + a, en_mantenimiento: "en mantenimiento" }[e.estado] || "inhabilitad" + a;
      };
      // Descarga: tiene que estar libre (o reservado). Exhumación: tiene que estar ocupado.
      const sirve = (e) => (exh ? e.estado === "ocupado" : ["disponible", "reservado"].includes(e.estado));
      const nuevoId = () => Math.max(0, ...Datos.estado.espacios.map((e) => e.id)) + 1;
      if (f.tipo.value === "nicho") {
        const fila = Number(fd.fila);
        if (zona.codigo === "PAB_AMARILLO" && !fd.planta) { avisar("Elegí la planta."); return; }
        if (zona.codigo === "SV_NICHOS" && !fd.lugar) { avisar("Elegí el cuadro / bloque."); return; }
        if (!fila) { avisar("Elegí la fila."); return; }
        if (!(num > 0)) { avisar("Escribí el número de nicho."); return; }
        const lugar = zona.codigo === "PAB_AMARILLO" ? PLANTAS[Number(fd.planta) - 1] : zona.codigo === "SV_NICHOS" ? fd.lugar : undefined;
        esp = Datos.estado.espacios.find((e) => e.tipo === "nicho" && e.zona === zona.id && (e.lugar ?? "") === (lugar ?? "") && e.fila === fila && e.numero === num);
        if (esp && !sirve(esp)) {
          avisar(exh && esp.estado === "disponible" ? `El nicho ${num} de la fila ${fila} ya figura libre (disponible): no hace falta registrar la descarga.` : `El nicho ${num} de la fila ${fila} figura ${ocupadoTxt(esp)}. Revisá el número.`);
          return;
        }
        if (!esp) {
          altaManual = true;
          esp = {
            id: nuevoId(), zona: zona.id, tipo: "nicho", tam: f.tam.value,
            planta: zona.codigo === "PAB_AMARILLO" ? Number(fd.planta) : undefined, lugar, fila, numero: num,
          };
          esp.ub = ubNicho(esp, zona.codigo === "SV_NICHOS");
        }
      } else {
        const cuadro = zona.numero ? Number(fd.cuadro) : undefined;
        if (zona.numero && !cuadro) { avisar("Elegí el cuadro."); return; }
        if (!(num > 0)) { avisar("Escribí el número de fosa."); return; }
        esp = Datos.estado.espacios.find((e) => e.tipo === "fosa" && e.zona === zona.id && (e.cuadro ?? 0) === (cuadro ?? 0) && e.numero === num);
        if (esp && !sirve(esp)) {
          avisar(exh && esp.estado === "disponible" ? `La fosa ${num}${cuadro ? ` del cuadro ${cuadro}` : ""} ya figura libre (disponible): no hace falta registrar la descarga.` : `La fosa ${num}${cuadro ? ` del cuadro ${cuadro}` : ""} figura ${ocupadoTxt(esp)}. Revisá el número.`);
          return;
        }
        if (!esp) {
          altaManual = true;
          esp = { id: nuevoId(), zona: zona.id, tipo: "fosa", tam: f.tam.value, cuadro, numero: num };
          esp.ub = cuadro ? `Cuadro ${cuadro} · Fosa ${num}` : `Fosa N° ${num}`;
        }
      }
      if (!f.expediente.value.trim()) { avisar("Escribí el N° de planilla."); f.expediente.focus(); return; }
      const datos = {
        espacio_id: esp.id, ubicacion: esp.ub, zona: esp.zona, tipo: esp.tipo, tam: esp.tam,
        planta: esp.planta, cuadro: esp.cuadro, lugar: esp.tipo === "nicho" ? esp.lugar : undefined, fila: esp.fila, numero: esp.numero,
        alta_manual: altaManual || undefined,
        difunto: { nombre: f.dif_nombre.value.trim(), fecha: f.dif_fecha.value },
        expediente: f.expediente.value.trim(), observaciones: f.observaciones.value.trim() || undefined,
      };
      if (exh) {
        if (!f.destino.value) { avisar("Elegí el destino de los restos."); return; }
        datos.destino = f.destino.value;
        if (!datos.difunto.fecha) delete datos.difunto.fecha;
      }
      UI.borrador = { accion: tipoForm, tipo: esp.tipo, tam: esp.tam, zona: UI.filtroDescarga.zona };
      abrirFirma(OPERACIONES[tipoForm].accion, datos, `<dt>Zona</dt><dd>${esc(nombreZona(esp.zona))}</dd>${esp.planta ? `<dt>Planta</dt><dd>${PLANTAS[esp.planta - 1]}</dd>` : ""}<dt>Espacio</dt><dd>${esc(esp.ub)}${esp.tam !== "normal" ? " · <strong>" + nombreTamano(esp) + "</strong>" : ""}${altaManual ? `<br><span class="muted chico">Cargado a mano: no figuraba en la lista de ${exh ? "ocupados" : "libres"}, se agrega al registro.</span>` : ""}</dd><dt>${exh ? "Persona" : "Difunto"}</dt><dd>${esc(datos.difunto.nombre)}</dd><dt>N° de planilla</dt><dd>${esc(datos.expediente)}</dd>${exh ? `<dt>Destino</dt><dd>${esc(datos.destino)}</dd><dt>Resultado</dt><dd><strong>El lugar queda libre y disponible.</strong></dd>` : ""}`);
    } else if (tipoForm === "firma") {
      const c = $("#lienzo");
      if (!c.trazos) { avisar("Falta tu firma en el recuadro."); return; }
      const boton = form.querySelector('button[type="submit"]');
      boton.disabled = true; boton.textContent = "Firmando…";
      const { accion, datos, gps, fotos = [] } = UI.firmaPendiente;
      const mueveStock = ACCIONES_LIBERAN.includes(accion) || ACCIONES_OCUPAN.includes(accion);
      const disponiblesDe = () => resumenStock().find((s) => s.tipo === datos.tipo && s.tam === datos.tam)?.disponible;
      const antes = mueveStock ? disponiblesDe() : null;
      let reg;
      try { reg = await firmarYRegistrar(UI.usuario, accion, datos, f.pin.value, trazoReducido(c), gps, fotos); }
      catch (e) { boton.disabled = false; boton.textContent = "Firmar y registrar"; avisar(e.message); return; }
      UI.firmaPendiente = null; UI.borrador = null;
      if (accion === "tarea") UI.fotos = [];
      render();
      abrirModal(`<div class="comprobante">
        <h2 style="margin-top:0">Registrado ✔</h2>
        <p>${descripcionRegistro(reg)}</p>
        ${mueveStock ? `<div class="banner ${ACCIONES_LIBERAN.includes(accion) ? "ok" : "advertencia"}" style="justify-content:center;margin:8px 0">
          <div><strong>${nombreStock(datos.tipo, datos.tam)} disponibles: ${fmtNum(antes)} → ${fmtNum(disponiblesDe())}</strong>
          ${ACCIONES_LIBERAN.includes(accion) ? "El lugar quedó libre: ya figura como disponible en el Resumen." : "El lugar quedó ocupado y ya se descontó en el Resumen."}</div></div>` : ""}
        <p class="muted">${fmtFecha(reg.registrado_en)} · ${esc(UI.usuario.nombre)}</p>
        <p class="muted chico">Código de verificación</p>
        <p class="codigo mono">${codigoCorto(reg.hash_registro)}</p>
        <div class="fila" style="justify-content:center">
          <button class="btn" type="button" data-accion="cerrar">Listo</button>
          <button class="btn sec" type="button" data-registro="${reg.secuencia}">Ver comprobante</button>
          <button class="btn sec" type="button" data-pestana="resumen">Ir al Resumen</button>
        </div></div>`);
    } else if (tipoForm === "reclamo") {
      const nombre = f.nombre.value.trim(), detalle = f.detalle.value.trim();
      if (nombre.length < 3) { avisar("Escribí el nombre del contribuyente."); return; }
      if (!f.motivo.value) { avisar("Elegí el motivo."); return; }
      if (!detalle) { avisar("Escribí el detalle del reclamo."); return; }
      const ahora = new Date().toISOString();
      const rc = {
        id: "rc-" + uuid().slice(0, 8), numero: Math.max(0, ...Datos.estado.reclamos.map((x) => x.numero)) + 1, fecha: ahora,
        contribuyente: { nombre, telefono: f.telefono.value.trim() || undefined },
        motivo: f.motivo.value, zona: Number(f.zona.value) || null, ubicacion: f.ubicacion.value.trim() || undefined, detalle,
        estado: "pendiente", resuelto_en: null, registrado_por: { id: UI.usuario.id, nombre: UI.usuario.nombre },
        historial: [{ fecha: ahora, estado: "pendiente", usuario: UI.usuario.nombre, nota: "Reclamo recibido" }],
      };
      Datos.estado.reclamos.push(rc);
      if (!Datos.guardar()) { Datos.estado.reclamos.pop(); return; }
      UI.filtroReclamos = "abiertos"; render(); avisar(`Reclamo N° ${rc.numero} guardado.`);
    } else if (tipoForm === "seguimiento-reclamo") {
      const rc = Datos.estado.reclamos.find((x) => x.id === form.dataset.id);
      const estado = f.estado.value || ev.submitter?.dataset.estadoReclamo;
      if (!rc || !ESTADOS_RECLAMO[estado]) return;
      const nota = f.nota.value.trim();
      if (estado === "resuelto" && !nota) { avisar("Para marcarlo resuelto, escribí qué se hizo."); f.nota.focus(); return; }
      const ahora = new Date().toISOString();
      rc.estado = estado; rc.resuelto_en = estado === "resuelto" ? ahora : null;
      rc.historial.push({ fecha: ahora, estado, usuario: UI.usuario.nombre, nota: nota || undefined });
      Datos.guardar(); render(); detalleReclamo(rc.id);
      avisar(estado === "resuelto" ? `Reclamo N° ${rc.numero} resuelto.` : `Reclamo N° ${rc.numero} en proceso.`);
    } else if (tipoForm === "nuevo-capataz" || tipoForm === "editar-capataz") {
      if (UI.usuario?.rol !== "directivo") return;
      const nuevo = tipoForm === "nuevo-capataz";
      const id = nuevo ? null : form.dataset.id;
      const error = validarCapataz(f, id, nuevo);
      if (error) { avisar(error); return; }
      const datos = { nombre: f.nombre.value.trim(), legajo: f.legajo.value.trim() };
      if (f.pin.value) datos.pin = await sha256("pin:" + f.pin.value);
      if (nuevo) {
        Datos.estado.usuarios.push({ id: "u-cap-" + uuid().slice(0, 8), rol: "capataz", activo: true, zonas: Datos.estado.zonas.map((z) => z.id), ...datos });
      } else {
        Object.assign(Datos.estado.usuarios.find((u) => u.id === id), datos);
        cerrarModal();
      }
      Datos.guardar(); render();
      avisar(nuevo ? `${datos.nombre} ya puede ingresar con su PIN.` : "Cambios guardados.");
    } else if (tipoForm === "ajustes") {
      const e = Datos.estado;
      const nuevosU = {};
      for (const [t, m] of STOCK_CLAVES) {
        const k = t + "|" + m;
        const adv = Number(f["adv:" + k].value), crit = Number(f["crit:" + k].value), cob = Number(f["cob:" + k].value);
        if (!(adv > crit) || crit < 0) { avisar(`${nombreStock(t, m)}: la advertencia tiene que ser mayor que el crítico.`); return; }
        nuevosU[k] = { adv, crit, cobertura: cob || null };
      }
      const nuevasR = {};
      for (const k of Object.keys(e.reglas)) {
        const verde = Number(f["verde:" + k].value), rojo = Number(f["rojo:" + k].value);
        if (!(verde > 0 && rojo > verde)) { avisar(`${nombreTarea(k)}: el plazo rojo tiene que ser mayor que el verde.`); return; }
        nuevasR[k] = { verde, rojo, lluvia: f["lluvia:" + k].checked };
      }
      const factor = Number(f["t-factor"].value);
      if (!(factor > 0 && factor <= 1)) { avisar("El factor de lluvia va entre 0,1 y 1."); return; }
      e.umbrales = nuevosU; e.reglas = nuevasR;
      e.temporada = { desde: f["t-desde"].value, hasta: f["t-hasta"].value, factor };
      Datos.guardar(); render(); avisar("Ajustes guardados.");
    }
  } catch (e) {
    console.error(e);
    avisar("Ocurrió un error: " + e.message);
  }
});

document.addEventListener("keydown", (e) => {
  if ((e.key === "Enter" || e.key === " ") && e.target.matches?.("[data-ver-disp]")) { e.preventDefault(); e.target.click(); return; }
  if (e.key === "Escape" && !$("#modal").hidden) { UI.firmaPendiente = null; cerrarModal(); }
});

$("#reiniciar").addEventListener("click", async () => {
  if (!confirm("¿Borrar todos los registros de esta demostración y volver a los datos de ejemplo?")) return;
  await Datos.reiniciar();
  UI.usuario = null; UI.borrador = null; UI.fotos = [];
  try { localStorage.removeItem(CLAVE_SESION); } catch { /* sin almacenamiento */ }
  cerrarModal(); render(); avisar("Demostración reiniciada.");
});

/* ───────────────────────── Versión ───────────────────────── */
async function revisarVersion() {
  try {
    const r = await fetch("version.json?_=" + Date.now(), { cache: "no-store" });
    if (!r.ok) return;
    const { version } = await r.json();
    if (version && version !== VERSION_APP && !$("#aviso-version")) {
      const div = document.createElement("div");
      div.id = "aviso-version";
      div.className = "aviso-version";
      div.innerHTML = `Hay una versión nueva de la app. <button type="button" class="btn" id="actualizar-app">Actualizar ahora</button>`;
      document.body.prepend(div);
      $("#actualizar-app").addEventListener("click", () => location.reload());
    }
  } catch { /* sin conexión: se sigue con la versión actual */ }
}

/* ───────────────────────── Inicio ───────────────────────── */
(async function iniciar() {
  if (!window.crypto?.subtle) {
    $("#vista").innerHTML = `<div class="banner critica"><div><strong>No se puede firmar en esta dirección.</strong>Abrí la app desde su dirección segura (https://…).</div></div>`;
    return;
  }
  revisarVersion();
  setInterval(revisarVersion, 5 * 60000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) revisarVersion(); });
  await Datos.cargar();
  let id = null;
  try { id = localStorage.getItem(CLAVE_SESION); } catch { /* sin almacenamiento */ }
  UI.usuario = Datos.estado.usuarios.find((u) => u.id === id && u.activo !== false) || null;
  render();
  setInterval(() => { if (UI.usuario && $("#modal").hidden && !document.activeElement?.closest?.("form")) render(); }, 60000);
})();
