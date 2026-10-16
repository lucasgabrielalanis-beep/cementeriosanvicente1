// Arma ../index.html a partir de ../README.md y copia mermaid a ../vendor/.
// Uso: cd herramientas && npm install && npm run pagina
// La página queda autosuficiente: no descarga el README ni librerías de otros sitios.
import { readFileSync, writeFileSync, copyFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { marked } from "marked";

const aqui = dirname(fileURLToPath(import.meta.url));
const raiz = join(aqui, "..");

const escapar = (t) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const renderer = new marked.Renderer();
const codigoBase = renderer.code.bind(renderer);
renderer.code = (code, lang, escaped) =>
  lang === "mermaid" ? `<div class="mermaid">${escapar(code)}</div>\n` : codigoBase(code, lang, escaped);

const contenido = marked.parse(readFileSync(join(raiz, "README.md"), "utf8"), { renderer });
const plantilla = readFileSync(join(aqui, "plantilla.html"), "utf8");
writeFileSync(join(raiz, "index.html"), plantilla.replace("<!-- CONTENIDO -->", contenido));

mkdirSync(join(raiz, "vendor"), { recursive: true });
copyFileSync(join(aqui, "node_modules/mermaid/dist/mermaid.min.js"), join(raiz, "vendor/mermaid.min.js"));
console.log("index.html y vendor/mermaid.min.js actualizados");
