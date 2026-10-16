/*
 * Plano de la Sección Vieja: calles, pasajes, sectores, cuadros y bloques.
 * Lo pasó el dueño. Se usa solo en el sector "Sección Vieja" de nichos (código SV_NICHOS).
 * Ahí la ubicación se muestra sin la palabra "Nicho": "Cuadro O · Bloq. 19 · N° 12".
 * "Prop." se transcribe tal como figura en el plano.
 */
"use strict";

const PLANO_SECCION_VIEJA = {
  calles: [
    { rol: "Eje central (vertical)", nombre: "San Vicente" },
    { rol: "Límite inferior (calle principal)", nombre: "Calle Martin Costacchini" },
    { rol: "Límite derecho", nombre: "Blas Parera" },
  ],
  // De abajo hacia arriba
  pasajesHorizontales: ["San Carlos", "San Pedro", "San Agustín", "San Juan", "Santa María"],
  otrosPasajes: ["Santa Teresa", "San José", "San Antonio"],
  sectores: [
    {
      nombre: "Sector superior (zona norte)",
      referencias: ["Zona 1", "Horno crematorio", "Memorial"],
      bloques: [
        { cuadro: "D", bloque: 10, nombre: "Pabellón Ferroviario Julio Juárez" },
        { bloque: 1, nombre: "Pabellón 02 01 03" },
        { bloque: 1, nombre: "Pabellón PB 02 01 02" },
        { bloque: 1, nombre: "Pabellón SS 02 01 01" },
        { cuadro: "C", bloque: 9, nota: "junto al Bloq. 7" },
        { nombre: "Lateral", bloque: 2, nota: "Baño" },
      ],
    },
    {
      nombre: "Sector superior — izquierda / centro",
      bloques: [
        { cuadro: "A", bloque: 4 },
        { cuadro: "B", bloque: 6 },
        { cuadro: "W", bloque: 5, nota: "dentro del Cuadro B" },
        { cuadro: "C", bloque: 7 },
        { cuadro: "V", bloque: 8, nota: "dentro del Cuadro C" },
        { nombre: "Central", bloque: 3 },
      ],
    },
    {
      nombre: "Fila 1 (de arriba hacia abajo)",
      bloques: [
        { cuadro: "O", bloque: 19, prop: 15 },
        { cuadro: "P", bloque: 25, prop: 17 },
        { cuadro: "Q", bloque: 31, prop: 18 },
        { cuadro: "R", bloque: 34, prop: 13 },
      ],
    },
    {
      nombre: "Fila 2",
      bloques: [
        { nombre: "Osario", bloque: 14, sinNichos: true },
        { cuadro: "K", bloque: 18, prop: 11 },
        { cuadro: "L", bloque: 24, prop: 12 },
        { cuadro: "M", bloque: 30, prop: 13 },
        { cuadro: "N", bloque: 33, prop: 14 },
      ],
    },
    {
      nombre: "Fila 3",
      bloques: [
        { cuadro: "G", bloque: 17, prop: 7, nota: "incluye subsección Cruzados" },
        { cuadro: "H", bloque: 23, prop: 8 },
        { cuadro: "I", bloque: 29, prop: 9 },
        { cuadro: "J", bloque: 32, prop: 10, nota: "incluye Ferroviario 2" },
      ],
    },
    {
      nombre: "Fila 4",
      bloques: [
        { cuadro: "S", bloque: 15, prop: 20 },
        { cuadro: "C", bloque: 22, prop: 3 },
        { cuadro: "D", bloque: 21, prop: 4 },
        { cuadro: "E", bloque: 28, prop: 5 },
        { cuadro: "F", bloque: 27, prop: 6 },
        { nombre: "Pared Cuadro T", nota: "lateral izquierdo" },
        { nombre: "N. Chico", bloque: 16 },
        { nombre: "Ferroviario 1" },
      ],
    },
    {
      nombre: "Fila 5 (sector inferior / base)",
      bloques: [
        { cuadro: "A", bloque: 20, prop: 1 },
        { nombre: "Sector C", nota: "símbolo herradura / C" },
        { cuadro: "B", bloque: 26, prop: 2 },
      ],
    },
  ],
};

// "Cuadro O · Bloq. 19", "Pabellón PB 02 01 02 · Bloq. 1", "Central · Bloq. 3"
function etiquetaBloque(b) {
  return [b.cuadro && `Cuadro ${b.cuadro}`, b.nombre, b.bloque && `Bloq. ${b.bloque}`].filter(Boolean).join(" · ");
}

// Lugares de la Sección Vieja donde hay nichos (los que tienen número de bloque, sin el Osario).
const BLOQUES_CON_NICHOS = PLANO_SECCION_VIEJA.sectores
  .flatMap((s) => s.bloques.map((b) => ({ ...b, sector: s.nombre })))
  .filter((b) => b.bloque && !b.sinNichos);
