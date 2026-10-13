// Genera public/demo.json con datos ficticios pasados por la MISMA agregación del Worker.
// Uso: node scripts/generar-demo.mjs
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { construirResumen } from "../src/agregados.js";
import { generarDatosFalsos } from "./datos-falsos.mjs";

const ahora = Date.parse("2026-10-13T15:00:00Z");
const meses = 6;
const resumen = construirResumen(generarDatosFalsos({ ahora }), { ahora, meses });
resumen.avisos = ["Datos de ejemplo ficticios (modo demo)."];
resumen.peticiones = { total: 0, porEndpoint: {}, esperaSeg: 0 };

const destino = fileURLToPath(new URL("../public/demo.json", import.meta.url));
writeFileSync(destino, JSON.stringify(resumen, null, 1) + "\n");
console.log(`demo.json generado (${(JSON.stringify(resumen).length / 1024).toFixed(1)} KB)`);
