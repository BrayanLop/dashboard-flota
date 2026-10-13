// Pruebas sin red de la agregación y del cliente de cloudFleet.
// Uso: node scripts/probar-agregados.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { construirResumen, clasificarProgramacion, calcularPeriodo, mesesEntre } from "../src/agregados.js";
import { ClienteCloudFleet, ErrorCloudFleet } from "../src/cloudfleet.js";
import { generarDatosFalsos } from "./datos-falsos.mjs";

let ok = 0;
async function prueba(nombre, fn) {
  try {
    await fn();
    ok++;
    console.log(`  ✔ ${nombre}`);
  } catch (e) {
    console.error(`  ✘ ${nombre}\n    ${e.stack}`);
    process.exitCode = 1;
  }
}

const ahora = Date.parse("2026-10-13T15:00:00Z");
const DIA = 86400000;
const iso = (ms) => new Date(ms).toISOString();

// Datos mínimos con la forma de los ejemplos de la documentación.
const datos = {
  vehiculos: [
    { id: 60805, code: "ANS123", typeName: "Tractocamion", odometer: { lastMeter: 378950, lastMeterAt: "2023-11-07T14:11:00.0000000Z" }, avgOdometerDay: 210, costCenter: null, group1: null },
    { id: 60843, code: "ABC236", typeName: "Tractocamion", odometer: null, costCenter: { id: 5677, name: "Propios" } },
    { id: 60900, code: "XYZ999", typeName: null, odometer: null },
  ],
  documentos: [
    { docType: { name: "SOAT", code: "soat" }, vehicleCode: "ABC236", validTo: iso(ahora - 3 * DIA), isCurrent: true, files: [{ url: "x" }] },
    { docType: { name: "SOAT", code: "soat" }, vehicleCode: "ANS123", validTo: iso(ahora + 10 * DIA), isCurrent: true },
    { docType: { name: "RTM", code: "rtm" }, vehicleCode: "ANS123", validTo: iso(ahora + 90 * DIA), isCurrent: true },
    { docType: null, vehicleCode: null, validTo: null, isCurrent: true },
  ],
  ordenes: [
    { number: 4164, vehicleCode: "ABC236", startDate: iso(ahora - 10 * DIA), status: "opened", type: null, totalCostLabors: 10000, totalCostParts: 11352.564103, totalCost: 21352.564103, costCenter: { id: 5677, name: "Propios" } },
    { number: 4165, vehicleCode: "BOP833", startDate: iso(ahora - 20 * DIA), status: "voided", totalCostLabors: 5000, totalCostParts: 0, totalCost: 5000, costCenter: null },
    { number: 4166, vehicleCode: "ANS123", startDate: iso(ahora - 40 * DIA), status: "closed", type: { name: "Preventivo" }, totalCostLabors: null, totalCostParts: null, totalCost: 100000, costCenter: null },
    { number: 4167, vehicleCode: "ANS123", startDate: iso(ahora - 400 * DIA), status: "closed", totalCost: 999999 },
  ],
  ordenesAbiertasExtra: [{ number: 4000, vehicleCode: "XYZ999", startDate: iso(ahora - 150 * DIA), status: "onTechnicalCompletion", totalCost: 1 }],
  programaciones: [
    { status: "Ejecutada a tiempo", vehicle: { code: "ABC236" }, task: { name: "Adaptación sistema eléctrico" }, dateToExecute: iso(ahora - 20 * DIA), dateToExecuteDaysDiff: -72, odometerToExecuteDiff: -3800 },
    { status: "Ejecutada tarde", vehicle: { code: "ANS123" }, task: { name: "Cambio aceite" }, dateToExecute: iso(ahora - 15 * DIA) },
    { status: "Programada", vehicle: { code: "ANS123" }, task: { name: "Frenos" }, dateToExecute: iso(ahora - 2 * DIA) },
    { status: "Programada", vehicle: { code: "XYZ999" }, task: null, dateToExecute: iso(ahora + 5 * DIA) },
    { status: "Programada", vehicle: null, task: { name: "Lejana" }, dateToExecute: iso(ahora + 60 * DIA) },
  ],
  disponibilidad: [
    { code: "ABC236", typeName: "Tractocamion", hoursShouldWork: 11.61, hoursInMaintenance: 0, availability: 100 },
    { code: "ANS123", typeName: "Tractocamion", hoursShouldWork: 100, hoursInMaintenance: 40, availability: 60 },
    { code: "XYZ999", typeName: null, hoursShouldWork: 0, hoursInMaintenance: 0, availability: 100 },
  ],
  novedades: [
    { number: 1579, vehicleCode: "ABC236", prority: "medium", isDone: false },
    { number: 1580, vehicleCode: "ABC236", prority: "high", isDone: false },
    { number: 1581, vehicleCode: "ABC236", prority: null, isDone: false },
    { number: 1582, vehicleCode: "ABC236", prority: "low", isDone: true },
  ],
  combustible: [
    { vehicleCode: "ABC236", date: iso(ahora - 5 * DIA), fuelTypeName: "ACPM", qty: 100, totalCost: 1000000, distanceTraveled: 500, idealOdometerEfficiency: 6.2, costCenter: null },
    { vehicleCode: "ABC236", date: iso(ahora - 15 * DIA), fuelTypeName: "ACPM", qty: 100, totalCost: 1000000, distanceTraveled: 500, idealOdometerEfficiency: 6.2 },
    { vehicleCode: "ABC236", date: iso(ahora - 25 * DIA), fuelTypeName: "ACPM", qty: 100, totalCost: 1000000, distanceTraveled: 500, idealOdometerEfficiency: 6.2 },
    { vehicleCode: "ANS123", date: iso(ahora - 5 * DIA), qty: 2, totalCost: 100000, distanceTraveled: null, realOdometerEfficiency: 3711, idealOdometerEfficiency: 6.2 },
    { vehicleCode: null, date: null, qty: null, totalCost: null },
  ],
};

console.log("Agregación:");
const r = construirResumen(datos, { ahora, meses: 6 });

await prueba("periodo de 6 meses y meses del eje", () => {
  const { desde } = calcularPeriodo(ahora, 6);
  assert.equal(r.desde, new Date(desde).toISOString());
  assert.equal(r.costos.porMes.length, 7); // abr..oct (periodo móvil)
  assert.deepEqual(mesesEntre(calcularPeriodo(ahora, 1).desde, ahora), ["2026-09", "2026-10"]);
});
await prueba("estado de flota", () => {
  assert.equal(r.flota.total, 3);
  assert.deepEqual(r.flota.porTipo[0], { tipo: "Tractocamion", cantidad: 2 });
  assert.equal(r.flota.disponibilidad.promedio, 80); // excluye el vehículo con 0 h
  assert.equal(r.flota.disponibilidad.peores[0].codigo, "ANS123");
});
await prueba("documentos vencidos y por vencer", () => {
  assert.equal(r.flota.documentos.vencidos, 1);
  assert.equal(r.flota.documentos.porVencer, 1);
  assert.equal(r.flota.documentos.alertas[0].vehiculo, "ABC236");
  assert.equal(r.flota.documentos.alertas[0].estado, "vencido");
  assert.ok(r.flota.documentos.alertas[0].dias < 0);
  assert.ok(!JSON.stringify(r).includes('"files"'));
});
await prueba("OTs por estado, abiertas y costo por mes", () => {
  const est = Object.fromEntries(r.mantenimiento.otsPorEstado.map((e) => [e.estado, e.cantidad]));
  assert.deepEqual(est, { opened: 1, onTechnicalCompletion: 0, closed: 1, voided: 1 });
  assert.equal(r.mantenimiento.otsAbiertas.total, 2); // incluye la abierta de antes del periodo
  assert.equal(r.mantenimiento.otsAbiertas.lista[0].numero, 4000);
  const totalMes = r.mantenimiento.costoPorMes.reduce((s, m) => s + m.manoObra + m.repuestos, 0);
  assert.equal(totalMes, 10000 + 11353 + 100000); // sin anuladas ni fuera de periodo
});
await prueba("programaciones y cumplimiento", () => {
  const p = r.mantenimiento.programaciones;
  assert.equal(p.ejecutadas, 2);
  assert.equal(p.cumplimiento, 50);
  assert.equal(p.vencidas, 1);
  assert.equal(p.proximas, 1);
  assert.equal(p.alertas[0].estado, "vencida");
  assert.equal(clasificarProgramacion("Ejecutada a tiempo").aTiempo, true);
  assert.equal(clasificarProgramacion("Sin ejecutar").ejecutada, false);
});
await prueba("novedades pendientes por prioridad (campo 'prority')", () => {
  const n = r.mantenimiento.novedadesPendientes;
  assert.equal(n.total, 3);
  assert.equal(n.porPrioridad.find((x) => x.prioridad === "high").cantidad, 1);
  assert.equal(n.porPrioridad.find((x) => x.prioridad === "sin").cantidad, 1);
});
await prueba("combustible y rendimiento", () => {
  const c = r.combustible;
  assert.equal(c.galones, 302);
  assert.equal(c.peoresRendimientos.length, 1); // ANS123 tiene < 3 cargas con distancia
  assert.equal(c.peoresRendimientos[0].real, 5);
  assert.equal(c.peoresRendimientos[0].relacion, 80.6);
  assert.equal(c.rendimientoPorTipo.find((t) => t.tipo === "Tractocamion").real, 5); // ignora 3711 sin distancia
});
await prueba("costos generales", () => {
  const k = r.costos;
  assert.equal(k.total, 21353 + 100000 + 3000000 + 100000);
  assert.equal(k.kmRecorridos, 1500);
  assert.equal(k.porVehiculo[0].vehiculo, "ABC236");
  assert.equal(k.porCentroCosto[0].centro, "Propios");
  assert.equal(r.kpis.costoTotal, k.total);
});
await prueba("datos vacíos o nulos no rompen", () => {
  const v = construirResumen({ vehiculos: null, ordenes: [null, 3] }, { ahora, meses: 1 });
  assert.equal(v.flota.total, 0);
  assert.equal(v.kpis.disponibilidadPromedio, null);
  assert.equal(v.costos.costoPorKm, null);
});

console.log("Cliente cloudFleet (fetch simulado):");
function respuesta(estado, cuerpo, cab = {}) {
  return new Response(JSON.stringify(cuerpo), { status: estado, headers: { "Content-Type": "application/json", ...cab } });
}
await prueba("pagina con X-NextPage, espera al quedar 2 y reintenta 429", async () => {
  const llamadas = [];
  const esperas = [];
  const guion = [
    () => respuesta(200, [{ a: 1 }], { "X-NextPage": "https://fleet.cloudfleet.com/api/v1/vehicles/?page=2", "X-RateLimit-Remaining": "2", "X-RateLimit-Reset": "7" }),
    () => respuesta(429, {}, { "Retry-After": "3" }),
    () => respuesta(200, [{ a: 2 }], { "X-NextPage": "https://otro-host.example/robar", "X-RateLimit-Remaining": "20" }),
  ];
  const c = new ClienteCloudFleet("k", {
    fetchImpl: async (url, init) => { llamadas.push([url, init.headers.Authorization]); return guion[llamadas.length - 1](); },
    dormir: async (ms) => esperas.push(ms),
  });
  const res = await c.listar("vehicles/", {}, "vehiculos");
  assert.deepEqual(res.items, [{ a: 1 }, { a: 2 }]);
  assert.equal(llamadas.length, 3); // no sigue la página hacia otro host
  assert.equal(llamadas[0][1], "Bearer k");
  assert.deepEqual(esperas, [7250, 3250]);
});
await prueba("401 -> 'API key inválida'", async () => {
  const c = new ClienteCloudFleet("k", { fetchImpl: async () => respuesta(401, {}) });
  await assert.rejects(c.listar("vehicles/"), (e) => e instanceof ErrorCloudFleet && e.message === "API key inválida");
});
await prueba("429 sin presupuesto de espera -> mensaje con segundos", async () => {
  const c = new ClienteCloudFleet("k", { maxEsperaMs: 1000, fetchImpl: async () => respuesta(429, {}, { "Retry-After": "34" }), dormir: async () => {} });
  await assert.rejects(c.listar("vehicles/"), (e) => e.estado === 429 && /intenta en 35 s/.test(e.message));
});
await prueba("tope de páginas y de subrequests", async () => {
  const sig = { "X-NextPage": "https://fleet.cloudfleet.com/api/v1/fuel-entries?page=n" };
  const c = new ClienteCloudFleet("k", { maxPaginas: 3, fetchImpl: async () => respuesta(200, [{}], sig) });
  const r1 = await c.listar("fuel-entries");
  assert.equal(r1.truncado, true);
  assert.equal(r1.paginas, 3);
  const c2 = new ClienteCloudFleet("k", { maxSubrequests: 2, fetchImpl: async () => respuesta(200, [{}], sig) });
  const r2 = await c2.listar("fuel-entries");
  assert.equal(r2.items.length, 2);
  assert.ok(r2.error && r2.truncado);
});

console.log("demo.json:");
function compararForma(a, b, ruta = "$") {
  if (Array.isArray(a) || Array.isArray(b)) {
    assert.ok(Array.isArray(a) && Array.isArray(b), `${ruta}: arreglo esperado`);
    if (a.length && b.length) compararForma(a[0], b[0], ruta + "[0]");
    return;
  }
  if (a && typeof a === "object") {
    assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort(), `${ruta}: claves distintas`);
    for (const k of Object.keys(a)) compararForma(a[k], b[k], `${ruta}.${k}`);
  }
}
await prueba("demo.json tiene la misma forma que la agregación (más 'peticiones' del Worker)", () => {
  const demo = JSON.parse(readFileSync(new URL("../public/demo.json", import.meta.url), "utf8"));
  const real = construirResumen(generarDatosFalsos({ ahora, semilla: 7 }), { ahora, meses: 6 });
  real.peticiones = { total: 0, porEndpoint: {}, esperaSeg: 0 };
  compararForma(real, demo);
});

console.log(`\n${ok} pruebas correctas${process.exitCode ? " (hay fallos)" : ""}.`);
