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
  ["nicho", "normal"], ["nicho", "extraordinario"], ["fosa", "normal"], ["fosa", "extraordinario"],
];
const nombreStock = (tipo, tam) =>
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
    ["SV_NICHOS", "Sección Vieja (nichos)", "nichos", false],
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
    { id: "u-dir", nombre: "Directivo (demo)", rol: "directivo", legajo: "D-001", pin: pinHash, zonas: [] },
    { id: "u-cap-a", nombre: "Capataz A (demo)", rol: "capataz", legajo: "C-101", pin: pinHash, zonas: [...range(1, 14), 29, 31, 33, 34] },
    { id: "u-cap-b", nombre: "Capataz B (demo)", rol: "capataz", legajo: "C-102", pin: pinHash, zonas: [...range(15, 28), 30, 32, 35, 36] },
    { id: "u-op-1", nombre: "Operario 1 (demo)", rol: "operario", legajo: "O-201", pin: pinHash, zonas: [...range(1, 14), 29, 31, 33, 34] },
  ];
  for (const z of zonas) z.responsable = usuarios.find((u) => u.rol === "capataz" && u.zonas.includes(z.id))?.id || null;

  // Espacios no ocupados, individualizados (los ocupados históricos van como contador).
  const objetivo = { // disponibles, reservados, en mantenimiento, inhabilitados, ocupados históricos
    "nicho|normal": [180, 6, 14, 3, 11230], "nicho|extraordinario": [9, 2, 3, 1, 1840],
    "fosa|normal": [320, 4, 10, 2, 15410], "fosa|extraordinario": [26, 1, 2, 0, 2210],
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
      const ub = tipo === "nicho"
        ? `Bloque ${"ABCDEF"[i % 6]} · Nivel ${1 + (i % 5)} · Col. ${10 + Math.floor(i / 5)}`
        : `Secc. ${"ABCD"[i % 4]} · Fila ${1 + Math.floor(i / 12)} · N° ${1 + (i % 12)}`;
      espacios.push({ id: idEsp++, zona: z.id, tipo, tam, estado, ub });
    });
  }

  return {
    version: 6,
    creado: new Date(ahora).toISOString(),
    usuarios, zonas, reglas,
    temporada: { desde: "11-01", hasta: "03-31", factor: 0.6 },
    umbrales: {
      "nicho|normal": { adv: 200, crit: 50, cobertura: 30 },
      "nicho|extraordinario": { adv: 40, crit: 10, cobertura: 30 },
      "fosa|normal": { adv: 150, crit: 40, cobertura: 30 },
      "fosa|extraordinario": { adv: 30, crit: 8, cobertura: 30 },
    },
    consumoBase90: { "nicho|normal": 270, "nicho|extraordinario": 50, "fosa|normal": 360, "fosa|extraordinario": 30 },
    ocupadosBase, espacios,
    registros: [], dispositivos: {}, alertasVistas: {},
  };
}
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
    if (!this.estado || this.estado.version !== 6) { this.estado = await datosIniciales(); this.guardar(); }
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
    const recientes = registros.filter((r) => r.payload.accion === "descarga" && r.payload.datos.tipo === tipo && r.payload.datos.tam === tam && new Date(r.registrado_en) >= desde).length;
    const consumo = ((consumoBase90[clave] || 0) + recientes) / 90;
    const cobertura = consumo > 0 ? Math.floor(c.disponible / consumo) : null;
    const u = umbrales[clave];
    let nivel = "ok";
    if (u) {
      if (c.disponible <= u.crit || (cobertura !== null && u.cobertura && cobertura <= u.cobertura)) nivel = "critica";
      else if (c.disponible <= u.adv) nivel = "advertencia";
    }
    const total = Object.values(c).reduce((a, b) => a + b, 0);
    return { tipo, tam, clave, ...c, total, consumo, cobertura, umbral: u, nivel };
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
  } else if (accion === "descarga") {
    const e = Datos.estado.espacios.find((x) => x.id === datos.espacio_id);
    if (!e || !["disponible", "reservado"].includes(e.estado)) throw new Error("Ese espacio ya no está disponible. Elegí otro.");
    e.estado = "ocupado";
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
const UI = { usuario: null, pestana: null, filtroColor: "todas", borrador: null, fotos: [] };

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
  directivo: [["resumen", "Resumen"], ["zonas", "Zonas"], ["alertas", "Alertas"], ["registro", "Registro firmado"], ["ajustes", "Ajustes"]],
  // Los tableros (resumen, zonas, alertas, registro) los ven todos; los ajustes, solo directivos.
  // Capataces y operarios arrancan en el mismo Resumen que los directivos.
  campo: [["resumen", "Resumen"], ["zonas", "Zonas"], ["alertas", "Alertas"], ["registro", "Registro firmado"], ["mis-zonas", "Mis zonas"], ["tarea", "Registrar tarea"], ["descarga", "Registrar descarga"], ["mis-registros", "Mis registros"]],
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
    resumen: vistaResumen, zonas: vistaZonas, alertas: vistaAlertas, registro: vistaRegistro, ajustes: vistaAjustes,
    "mis-zonas": vistaMisZonas, tarea: vistaTarea, descarga: vistaDescarga, "mis-registros": vistaMisRegistros,
  };
  $("#vista").innerHTML = vistas[UI.pestana]();
  if (UI.pestana === "descarga") actualizarListaEspacios();
}

/* ───────────────────────── Vistas ───────────────────────── */
function vistaLogin() {
  const usuarios = Datos.estado.usuarios;
  return `<section class="login">
    <h1>Ingresar</h1>
    <p class="muted">Elegí un usuario de prueba. El PIN de demostración es <strong>${PIN_DEMO}</strong>.</p>
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
  return `<div class="card stock">
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
  </div>`;
}

function vistaResumen() {
  const stock = resumenStock();
  const zonas = Datos.estado.zonas.map((z) => ({ z, s: semaforoZona(z) }));
  const cuenta = { verde: 0, amarillo: 0, rojo_critico: 0 };
  zonas.forEach(({ s }) => cuenta[s.color]++);
  const criticas = zonas.filter(({ s }) => s.color === "rojo_critico");
  const ultimos = Datos.estado.registros.slice(-5).reverse();
  return `${bannerFaltante(stock)}
    <h1>Resumen</h1>
    <p class="muted">${enTemporada() ? "Temporada de lluvias: los plazos de mantenimiento están acortados." : "Fuera de temporada de lluvias."} Actualizado: ${fmtFecha(new Date().toISOString())}</p>
    <h2>Disponibilidad de nichos y fosas</h2>
    <div class="grilla">${stock.map(tarjetaStock).join("")}</div>
    <h2>Semáforo de mantenimiento</h2>
    <div class="resumen-semaforo">
      <span class="chip verde">${cuenta.verde} en verde</span>
      <span class="chip amarillo">${cuenta.amarillo} en amarillo</span>
      <span class="chip rojo_critico">${cuenta.rojo_critico} en rojo crítico</span>
    </div>
    ${criticas.length ? `<div class="zonas">${criticas.map(({ z, s }) => tileZona(z, s)).join("")}</div>` : `<p class="muted">No hay zonas en rojo crítico.</p>`}
    <p><button class="btn sec" type="button" data-pestana="zonas">Ver las ${zonas.length} zonas</button></p>
    <h2>Últimos registros firmados</h2>
    ${ultimos.length ? tablaRegistros(ultimos) : `<div class="card vacio">Todavía no hay registros. Lo que cargue el personal en campo aparece acá.</div>`}`;
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
    <h3 style="margin-top:16px">Últimos registros en la zona</h3>
    ${regs.length ? tablaRegistros(regs) : '<p class="muted">Sin registros firmados todavía.</p>'}
    <div class="fila" style="margin-top:16px">
      ${esCampo ? `<button class="btn" type="button" data-ir-tarea="${id}">Registrar tarea acá</button>` : ""}
      <button class="btn sec" type="button" data-accion="cerrar">Cerrar</button>
    </div>`);
}

function vistaAlertas() {
  const todas = alertasActuales();
  const nuevas = todas.filter((a) => !alertaVista(a));
  const vistas = todas.filter(alertaVista);
  const item = (a, conBoton) => `<div class="card alerta">
      <div>${chipNivel(a.nivel)} <strong>${esc(a.titulo)}</strong><div class="muted chico">${esc(a.detalle)}</div></div>
      <div class="fila">${a.zona ? `<button class="btn sec" type="button" data-zona="${a.zona}">Ver</button>` : ""}${conBoton ? `<button class="btn sec" type="button" data-vista="${esc(a.clave)}|${a.nivel}">Marcar vista</button>` : ""}</div>
    </div>`;
  return `<h1>Alertas</h1>
    <p class="muted">Se abren y se cierran solas según el stock y los plazos de mantenimiento.</p>
    ${nuevas.length ? `<div class="lista-alertas">${nuevas.map((a) => item(a, true)).join("")}</div>` : '<div class="card vacio">No hay alertas nuevas.</div>'}
    ${vistas.length ? `<h2>Ya vistas (siguen abiertas)</h2><div class="lista-alertas">${vistas.map((a) => item(a, false)).join("")}</div>` : ""}`;
}

function descripcionRegistro(r) {
  const d = r.payload.datos;
  if (r.payload.accion === "tarea") return `${nombreTarea(d.tipo_tarea)} en ${esc(nombreZona(d.zona))} (${d.porcentaje}%)${d.fotos_sha256?.length ? ` · ${d.fotos_sha256.length} ${d.fotos_sha256.length === 1 ? "foto" : "fotos"}` : ""}`;
  return `Descarga en ${d.tipo} ${d.tam} — ${esc(d.ubicacion)} (${esc(nombreZona(d.zona))}) · ${esc(d.difunto.nombre)}`;
}
const nombreZona = (id) => Datos.estado.zonas.find((z) => z.id === id)?.nombre || "—";

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
      ${p.accion === "descarga" ? `<dt>Difunto</dt><dd>${esc(p.datos.difunto.nombre)}${p.datos.difunto.dni ? " · DNI " + esc(p.datos.difunto.dni) : ""} · fallecimiento ${esc(p.datos.difunto.fecha)}</dd><dt>Expediente</dt><dd>${esc(p.datos.expediente || "—")}</dd>` : ""}
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

function vistaDescarga() {
  const b = UI.borrador?.accion === "descarga" ? UI.borrador : { tipo: "nicho", tam: "normal", zona: "" };
  UI.filtroDescarga = { tipo: b.tipo, tam: b.tam, zona: b.zona };
  const op = (campo, valor, txt) => `<button type="button" class="opcion" data-elegir="${campo}" data-valor="${valor}" aria-pressed="${b[campo] === valor}">${txt}</button>`;
  return `<h1>Registrar descarga</h1>
    <p class="muted">Inhumación en nicho o fosa. Elegí el espacio, cargá los datos y firmá.</p>
    <form class="form" data-form="descarga">
      <div class="dos-col">
        <fieldset style="border:0;padding:0;margin:0"><legend style="font-weight:600;margin-bottom:6px">Tipo</legend>
          <div class="opciones">${op("tipo", "nicho", "Nicho")}${op("tipo", "fosa", "Fosa")}</div></fieldset>
        <fieldset style="border:0;padding:0;margin:0"><legend style="font-weight:600;margin-bottom:6px">Tamaño</legend>
          <div class="opciones">${op("tam", "normal", "Normal")}${op("tam", "extraordinario", "Extraordinario")}</div></fieldset>
      </div>
      <input type="hidden" name="tipo" value="${b.tipo}"><input type="hidden" name="tam" value="${b.tam}">
      <label>Zona<select name="zona" data-filtro-zona><option value="">Todas las zonas</option></select></label>
      <label>Espacio disponible<select name="espacio" required></select></label>
      <h2 style="margin:4px 0 0">Datos de la persona fallecida</h2>
      <label>Apellido y nombre<input name="dif_nombre" required maxlength="120" autocomplete="off"></label>
      <div class="dos-col">
        <label>DNI <span class="muted">(opcional)</span><input name="dif_dni" inputmode="numeric" maxlength="12" autocomplete="off"></label>
        <label>Fecha de fallecimiento<input name="dif_fecha" type="date" required></label>
      </div>
      <label>N° de expediente u orden <span class="muted">(opcional)</span><input name="expediente" maxlength="60" autocomplete="off"></label>
      <label>Observaciones <span class="muted">(opcional)</span><textarea name="observaciones" maxlength="600"></textarea></label>
      <button class="btn grande" type="submit">Continuar a la firma</button>
    </form>`;
}

function actualizarListaEspacios() {
  const form = $('form[data-form="descarga"]');
  if (!form) return;
  const f = UI.filtroDescarga;
  const disponibles = Datos.estado.espacios.filter((e) => e.tipo === f.tipo && e.tam === f.tam && e.estado === "disponible");
  const porZona = {};
  disponibles.forEach((e) => (porZona[e.zona] = (porZona[e.zona] || 0) + 1));
  const selZona = form.elements.zona;
  selZona.innerHTML = `<option value="">Todas las zonas (${disponibles.length})</option>` +
    Object.keys(porZona).map(Number).sort((a, b) => a - b).map((id) => `<option value="${id}" ${String(id) === String(f.zona) ? "selected" : ""}>${esc(nombreZona(id))} (${porZona[id]})</option>`).join("");
  if (f.zona && !porZona[f.zona]) f.zona = "";
  const lista = disponibles.filter((e) => !f.zona || e.zona === Number(f.zona)).slice(0, 200);
  form.elements.espacio.innerHTML = lista.length
    ? lista.map((e) => `<option value="${e.id}">${esc(nombreZona(e.zona))} · ${esc(e.ub)}</option>`).join("")
    : `<option value="">No hay ${nombreStock(f.tipo, f.tam).toLowerCase()} disponibles</option>`;
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
  const el = ev.target.closest("button, [data-zona]");
  if (!el) { if (ev.target === $("#modal")) cerrarModal(); return; }
  const d = el.dataset;
  if (d.pestana) { UI.pestana = d.pestana; cerrarModal(); render(); $("#vista").focus({ preventScroll: true }); window.scrollTo(0, 0); return; }
  if (d.zona) { detalleZona(Number(d.zona)); return; }
  if (d.registro) { detalleRegistro(Number(d.registro)); return; }
  if (d.filtro) { UI.filtroColor = d.filtro; render(); return; }
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
    if (form.dataset.form === "descarga") { UI.filtroDescarga[d.elegir] = d.valor; actualizarListaEspacios(); }
    return;
  }
  switch (d.accion) {
    case "salir":
      UI.usuario = null; UI.borrador = null; UI.fotos = [];
      try { localStorage.removeItem(CLAVE_SESION); } catch { /* sin almacenamiento */ }
      render(); break;
    case "cerrar": UI.firmaPendiente = null; cerrarModal(); break;
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
  if (ev.target.matches("[data-filtro-zona]")) { UI.filtroDescarga.zona = ev.target.value; actualizarListaEspacios(); }
});

document.addEventListener("submit", async (ev) => {
  const form = ev.target;
  ev.preventDefault();
  const f = form.elements;
  const tipoForm = form.dataset.form;
  try {
    if (tipoForm === "login") {
      const u = Datos.estado.usuarios.find((x) => x.id === f.usuario.value);
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
    } else if (tipoForm === "descarga") {
      const esp = Datos.estado.espacios.find((e) => e.id === Number(f.espacio.value));
      if (!esp) { avisar("Elegí un espacio disponible."); return; }
      const datos = {
        espacio_id: esp.id, ubicacion: esp.ub, zona: esp.zona, tipo: esp.tipo, tam: esp.tam,
        difunto: { nombre: f.dif_nombre.value.trim(), dni: f.dif_dni.value.trim() || undefined, fecha: f.dif_fecha.value },
        expediente: f.expediente.value.trim() || undefined, observaciones: f.observaciones.value.trim() || undefined,
      };
      UI.borrador = { accion: "descarga", tipo: esp.tipo, tam: esp.tam, zona: UI.filtroDescarga.zona };
      abrirFirma("descarga", datos, `<dt>Espacio</dt><dd>${esp.tipo === "nicho" ? "Nicho" : "Fosa"} ${esp.tam} · ${esc(esp.ub)} · ${esc(nombreZona(esp.zona))}</dd><dt>Difunto</dt><dd>${esc(datos.difunto.nombre)}${datos.difunto.dni ? " · DNI " + esc(datos.difunto.dni) : ""}</dd>`);
    } else if (tipoForm === "firma") {
      const c = $("#lienzo");
      if (!c.trazos) { avisar("Falta tu firma en el recuadro."); return; }
      const boton = form.querySelector('button[type="submit"]');
      boton.disabled = true; boton.textContent = "Firmando…";
      const { accion, datos, gps, fotos = [] } = UI.firmaPendiente;
      let reg;
      try { reg = await firmarYRegistrar(UI.usuario, accion, datos, f.pin.value, trazoReducido(c), gps, fotos); }
      catch (e) { boton.disabled = false; boton.textContent = "Firmar y registrar"; avisar(e.message); return; }
      UI.firmaPendiente = null; UI.borrador = null;
      if (accion === "tarea") UI.fotos = [];
      render();
      abrirModal(`<div class="comprobante">
        <h2 style="margin-top:0">Registrado ✔</h2>
        <p>${descripcionRegistro(reg)}</p>
        <p class="muted">${fmtFecha(reg.registrado_en)} · ${esc(UI.usuario.nombre)}</p>
        <p class="muted chico">Código de verificación</p>
        <p class="codigo mono">${codigoCorto(reg.hash_registro)}</p>
        <div class="fila" style="justify-content:center">
          <button class="btn" type="button" data-accion="cerrar">Listo</button>
          <button class="btn sec" type="button" data-registro="${reg.secuencia}">Ver comprobante</button>
        </div></div>`);
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

document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("#modal").hidden) { UI.firmaPendiente = null; cerrarModal(); } });

$("#reiniciar").addEventListener("click", async () => {
  if (!confirm("¿Borrar todos los registros de esta demostración y volver a los datos de ejemplo?")) return;
  await Datos.reiniciar();
  UI.usuario = null; UI.borrador = null; UI.fotos = [];
  try { localStorage.removeItem(CLAVE_SESION); } catch { /* sin almacenamiento */ }
  cerrarModal(); render(); avisar("Demostración reiniciada.");
});

/* ───────────────────────── Inicio ───────────────────────── */
(async function iniciar() {
  if (!window.crypto?.subtle) {
    $("#vista").innerHTML = `<div class="banner critica"><div><strong>No se puede firmar en esta dirección.</strong>Abrí la app desde su dirección segura (https://…).</div></div>`;
    return;
  }
  await Datos.cargar();
  let id = null;
  try { id = localStorage.getItem(CLAVE_SESION); } catch { /* sin almacenamiento */ }
  UI.usuario = Datos.estado.usuarios.find((u) => u.id === id) || null;
  render();
  setInterval(() => { if (UI.usuario && $("#modal").hidden && !document.activeElement?.closest?.("form")) render(); }, 60000);
})();
