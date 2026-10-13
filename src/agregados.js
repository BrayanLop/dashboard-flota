// Agregación de datos de cloudFleet -> resumen compacto para el dashboard.
// Funciones puras (sin red) para poder probarlas en Node.
// Todas las fechas se agrupan en hora de Colombia (UTC-5, sin horario de verano).

export const OFFSET_COLOMBIA_MS = -5 * 60 * 60 * 1000;
const DIA_MS = 24 * 60 * 60 * 1000;

export const DIAS_ALERTA = 30; // ventana de "por vencer" / "próximas"
export const MIN_CARGAS_RENDIMIENTO = 3; // cargas mínimas para entrar al top de peor rendimiento
const MAX_ALERTAS = 50; // filas máximas por lista de alertas (las cifras totales sí son completas)

// ---------- utilidades seguras ante nulos ----------

export function num(v) {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : 0;
}

function numONulo(v) {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

/** Texto de un campo que puede venir como string, como objeto {name} o null. */
export function nombre(v, porDefecto = "Sin asignar") {
  if (v == null) return porDefecto;
  if (typeof v === "string") return v.trim() || porDefecto;
  if (typeof v === "object" && typeof v.name === "string" && v.name.trim()) return v.name.trim();
  return porDefecto;
}

export function fecha(v) {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

function redondear(n, dec = 0) {
  const f = 10 ** dec;
  return Math.round(n * f) / f;
}

function lista(v) {
  return Array.isArray(v) ? v.filter((x) => x && typeof x === "object") : [];
}

function sinAcentos(s) {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

/** "YYYY-MM" en hora de Colombia. */
export function claveMes(ts) {
  const d = new Date(ts + OFFSET_COLOMBIA_MS);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** "YYYY-MM-DD" en hora de Colombia. */
export function claveDia(ts) {
  return new Date(ts + OFFSET_COLOMBIA_MS).toISOString().slice(0, 10);
}

/** Medianoche de Colombia (en ms UTC) del día que contiene ts. */
export function inicioDiaColombia(ts) {
  const local = ts + OFFSET_COLOMBIA_MS;
  return local - (((local % DIA_MS) + DIA_MS) % DIA_MS) - OFFSET_COLOMBIA_MS;
}

/** Suma meses de calendario en hora de Colombia (ajusta fin de mes). */
export function sumarMeses(ts, meses) {
  const d = new Date(ts + OFFSET_COLOMBIA_MS);
  const dia = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + meses);
  const ultimo = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(dia, ultimo));
  return d.getTime() - OFFSET_COLOMBIA_MS;
}

/**
 * Periodo consultado: desde = medianoche de (hoy - N meses + 1 día), hasta = ahora.
 * Así el rango nunca supera los 6 meses que exige cloudFleet.
 */
export function calcularPeriodo(ahora, meses) {
  const hoy = inicioDiaColombia(ahora);
  const desde = sumarMeses(hoy, -meses) + DIA_MS;
  return { desde, hasta: ahora };
}

/** Lista de meses "YYYY-MM" entre dos instantes (inclusive). */
export function mesesEntre(desde, hasta) {
  const out = [];
  const a = new Date(desde + OFFSET_COLOMBIA_MS);
  let y = a.getUTCFullYear();
  let m = a.getUTCMonth();
  const fin = claveMes(hasta);
  for (let i = 0; i < 24; i++) {
    const k = `${y}-${String(m + 1).padStart(2, "0")}`;
    out.push(k);
    if (k === fin) break;
    m++;
    if (m > 11) { m = 0; y++; }
  }
  return out;
}

function topN(arr, n, cmp) {
  return [...arr].sort(cmp).slice(0, n);
}

function contarPor(items, claveFn) {
  const m = new Map();
  for (const it of items) {
    const k = claveFn(it);
    m.set(k, (m.get(k) || 0) + 1);
  }
  return m;
}

// ---------- etiquetas ----------

export const ETIQUETAS_ESTADO_OT = {
  opened: "Abierta",
  onTechnicalCompletion: "Cierre técnico",
  closed: "Cerrada",
  voided: "Anulada",
};

export const ETIQUETAS_PRIORIDAD = { high: "Alta", medium: "Media", low: "Baja" };

/**
 * Clasifica el estado textual de una programación de mantenimiento.
 * cloudFleet devuelve textos como "Ejecutada a tiempo"; se interpretan por palabras clave.
 */
export function clasificarProgramacion(estadoTexto) {
  const s = sinAcentos(estadoTexto);
  if (!s) return { ejecutada: false, aTiempo: null, anulada: false, vencidaTexto: false };
  const anulada = /anulad|cancelad|descartad|eliminad/.test(s);
  const ejecutada = /ejecutad|realizad|cumplid/.test(s) && !/sin ejecutar|no ejecutad|por ejecutar/.test(s);
  let aTiempo = null;
  if (ejecutada) {
    if (/a tiempo|oportun/.test(s)) aTiempo = true;
    else if (/tarde|tardia|fuera de tiempo|retras|vencid|atrasad/.test(s)) aTiempo = false;
  }
  const vencidaTexto = !ejecutada && /vencid|atrasad|retras/.test(s);
  return { ejecutada, aTiempo, anulada, vencidaTexto };
}

// ---------- secciones ----------

function resumenFlota(vehiculos, disponibilidad, documentos, ahora) {
  const porTipo = [...contarPor(vehiculos, (v) => nombre(v.typeName, "Sin tipo"))]
    .map(([tipo, cantidad]) => ({ tipo, cantidad }))
    .sort((a, b) => b.cantidad - a.cantidad || a.tipo.localeCompare(b.tipo, "es"));

  // Disponibilidad: promedio simple de vehículos que debían trabajar (> 0 h).
  const disp = disponibilidad
    .map((d) => ({
      codigo: nombre(d.code, "—"),
      tipo: nombre(d.typeName, "Sin tipo"),
      disponibilidad: numONulo(d.availability),
      horasDebioTrabajar: num(d.hoursShouldWork),
      horasMantenimiento: num(d.hoursInMaintenance),
    }))
    .filter((d) => d.disponibilidad != null && d.horasDebioTrabajar > 0);
  const promedio = disp.length ? redondear(disp.reduce((s, d) => s + d.disponibilidad, 0) / disp.length, 1) : null;
  const peores = topN(disp, 10, (a, b) => a.disponibilidad - b.disponibilidad || b.horasMantenimiento - a.horasMantenimiento).map(
    (d) => ({
      codigo: d.codigo,
      tipo: d.tipo,
      disponibilidad: redondear(d.disponibilidad, 1),
      horasMantenimiento: redondear(d.horasMantenimiento, 1),
    })
  );

  // Documentos vigentes vencidos o por vencer en los próximos 30 días.
  const hoy = inicioDiaColombia(ahora);
  const limite = ahora + DIAS_ALERTA * DIA_MS;
  const porTipoDoc = new Map();
  const alertas = [];
  let vencidos = 0;
  let porVencer = 0;
  for (const d of documentos) {
    if (d.isCurrent === false) continue;
    const vence = fecha(d.validTo);
    if (vence == null || vence > limite) continue;
    const tipoDoc = nombre(d.docType, "Documento");
    const fila = porTipoDoc.get(tipoDoc) || { tipo: tipoDoc, vencidos: 0, porVencer: 0 };
    const vencido = vence < ahora;
    if (vencido) { fila.vencidos++; vencidos++; } else { fila.porVencer++; porVencer++; }
    porTipoDoc.set(tipoDoc, fila);
    alertas.push({
      vehiculo: nombre(d.vehicleCode, "—"),
      documento: tipoDoc,
      venceEl: claveDia(vence),
      dias: Math.floor((inicioDiaColombia(vence) - hoy) / DIA_MS),
      estado: vencido ? "vencido" : "porVencer",
    });
  }
  alertas.sort((a, b) => a.dias - b.dias || a.vehiculo.localeCompare(b.vehiculo, "es"));

  return {
    total: vehiculos.length,
    porTipo,
    disponibilidad: { promedio, vehiculosMedidos: disp.length, peores },
    documentos: {
      vencidos,
      porVencer,
      porTipo: [...porTipoDoc.values()].sort((a, b) => b.vencidos + b.porVencer - (a.vencidos + a.porVencer)),
      alertas: alertas.slice(0, MAX_ALERTAS),
    },
  };
}

function resumenMantenimiento({ ordenes, ordenesAbiertasExtra, programaciones, novedades }, ctx) {
  const { ahora, desde, hasta, meses } = ctx;

  // OTs del periodo (deduplicadas por número).
  const porNumero = new Map();
  for (const o of ordenes) porNumero.set(o.number ?? `${o.vehicleCode}-${o.startDate}`, o);
  const delPeriodo = [...porNumero.values()].filter((o) => {
    const t = fecha(o.startDate);
    return t == null || (t >= desde && t <= hasta);
  });

  const conteo = contarPor(delPeriodo, (o) => (o.status in ETIQUETAS_ESTADO_OT ? o.status : "otro"));
  const otsPorEstado = ["opened", "onTechnicalCompletion", "closed", "voided"]
    .map((estado) => ({ estado, etiqueta: ETIQUETAS_ESTADO_OT[estado], cantidad: conteo.get(estado) || 0 }));
  if (conteo.get("otro")) otsPorEstado.push({ estado: "otro", etiqueta: "Otro", cantidad: conteo.get("otro") });

  // OTs abiertas (incluye las abiertas antes del periodo si se consultaron aparte).
  const abiertasMap = new Map();
  for (const o of [...delPeriodo, ...ordenesAbiertasExtra]) {
    if (o.status !== "opened" && o.status !== "onTechnicalCompletion") continue;
    abiertasMap.set(o.number ?? `${o.vehicleCode}-${o.startDate}`, o);
  }
  const abiertas = [...abiertasMap.values()].map((o) => {
    const inicio = fecha(o.startDate);
    return {
      numero: o.number ?? null,
      vehiculo: nombre(o.vehicleCode, "—"),
      estado: ETIQUETAS_ESTADO_OT[o.status],
      tipo: nombre(o.type, "Sin tipo"),
      inicio: inicio != null ? claveDia(inicio) : null,
      diasAbierta: inicio != null ? Math.max(0, Math.floor((ahora - inicio) / DIA_MS)) : null,
      costo: Math.round(num(o.totalCost)),
    };
  });
  abiertas.sort((a, b) => (b.diasAbierta ?? -1) - (a.diasAbierta ?? -1));

  // Costo por mes (excluye anuladas).
  const mesesLista = mesesEntre(desde, hasta);
  const costoMes = new Map(mesesLista.map((m) => [m, { mes: m, manoObra: 0, repuestos: 0 }]));
  for (const o of delPeriodo) {
    if (o.status === "voided") continue;
    const t = fecha(o.startDate);
    if (t == null) continue;
    const fila = costoMes.get(claveMes(t));
    if (!fila) continue;
    const mo = num(o.totalCostLabors);
    const rep = num(o.totalCostParts);
    fila.manoObra += mo;
    // Si no viene el desglose, el total va a repuestos para no perder el costo.
    fila.repuestos += mo === 0 && rep === 0 ? num(o.totalCost) : rep;
  }
  const costoPorMes = [...costoMes.values()].map((f) => ({ mes: f.mes, manoObra: Math.round(f.manoObra), repuestos: Math.round(f.repuestos) }));

  // Programaciones.
  const limite = ahora + DIAS_ALERTA * DIA_MS;
  let ejecutadas = 0;
  let aTiempo = 0;
  let conDatoOportunidad = 0;
  let vencidas = 0;
  let proximas = 0;
  const alertas = [];
  for (const p of programaciones) {
    const c = clasificarProgramacion(p.status);
    if (c.anulada) continue;
    const t = fecha(p.dateToExecute);
    if (c.ejecutada) {
      if (t != null && t >= desde && t <= hasta) {
        ejecutadas++;
        if (c.aTiempo != null) { conDatoOportunidad++; if (c.aTiempo) aTiempo++; }
      }
      continue;
    }
    const vencida = c.vencidaTexto || (t != null && t < ahora);
    const proxima = !vencida && t != null && t <= limite;
    if (!vencida && !proxima) continue;
    if (vencida) vencidas++; else proximas++;
    alertas.push({
      vehiculo: nombre(p.vehicle?.code, "—"),
      tarea: nombre(p.task, nombre(p.routine, "Sin tarea")),
      fecha: t != null ? claveDia(t) : null,
      dias: t != null ? Math.floor((inicioDiaColombia(t) - inicioDiaColombia(ahora)) / DIA_MS) : null,
      kmRestantes: numONulo(p.odometerToExecuteDiff),
      estado: vencida ? "vencida" : "proxima",
      estadoTexto: typeof p.status === "string" ? p.status : null,
    });
  }
  alertas.sort((a, b) => (a.dias ?? -99999) - (b.dias ?? -99999));

  // Novedades pendientes por prioridad (el campo viene como "prority" en la API).
  const pendientes = novedades.filter((n) => n.isDone !== true);
  const conteoPrio = contarPor(pendientes, (n) => {
    const p = sinAcentos(n.prority ?? n.priority);
    return p in ETIQUETAS_PRIORIDAD ? p : "sin";
  });
  const porPrioridad = ["high", "medium", "low"].map((p) => ({
    prioridad: p,
    etiqueta: ETIQUETAS_PRIORIDAD[p],
    cantidad: conteoPrio.get(p) || 0,
  }));
  if (conteoPrio.get("sin")) porPrioridad.push({ prioridad: "sin", etiqueta: "Sin prioridad", cantidad: conteoPrio.get("sin") });

  return {
    totalOts: delPeriodo.length,
    otsPorEstado,
    otsAbiertas: { total: abiertas.length, lista: abiertas.slice(0, MAX_ALERTAS) },
    costoPorMes,
    programaciones: {
      ejecutadas,
      ejecutadasATiempo: aTiempo,
      // % de ejecutadas a tiempo; null si el texto de estado no permite saberlo.
      cumplimiento: conDatoOportunidad ? redondear((aTiempo / conDatoOportunidad) * 100, 1) : null,
      vencidas,
      proximas,
      alertas: alertas.slice(0, MAX_ALERTAS),
    },
    novedadesPendientes: { total: pendientes.length, porPrioridad },
  };
}

function resumenCombustible(cargas, tipoPorVehiculo, ctx) {
  const { desde, hasta } = ctx;
  const delPeriodo = cargas.filter((c) => {
    const t = fecha(c.date);
    return t != null && t >= desde && t <= hasta;
  });

  const porMesMap = new Map(mesesEntre(desde, hasta).map((m) => [m, { mes: m, galones: 0, costo: 0 }]));
  for (const c of delPeriodo) {
    const f = porMesMap.get(claveMes(fecha(c.date)));
    if (!f) continue;
    f.galones += num(c.qty);
    f.costo += num(c.totalCost);
  }
  const porMes = [...porMesMap.values()].map((f) => ({ mes: f.mes, galones: redondear(f.galones, 1), costo: Math.round(f.costo) }));

  // Rendimiento: real = distancia / cantidad (ponderado); ideal = promedio ponderado por cantidad.
  // Se ignoran cargas sin distancia o sin cantidad (p. ej. tanqueos parciales sin odómetro).
  function acumular(mapa, clave, c) {
    const qty = num(c.qty);
    const dist = num(c.distanceTraveled);
    const ideal = numONulo(c.idealOdometerEfficiency);
    const a = mapa.get(clave) || { dist: 0, qtyReal: 0, idealPond: 0, qtyIdeal: 0, cargas: 0 };
    if (qty > 0 && dist > 0) { a.dist += dist; a.qtyReal += qty; a.cargas++; }
    if (qty > 0 && ideal != null && ideal > 0) { a.idealPond += ideal * qty; a.qtyIdeal += qty; }
    mapa.set(clave, a);
  }
  const porTipoMap = new Map();
  const porVehMap = new Map();
  for (const c of delPeriodo) {
    const veh = nombre(c.vehicleCode, "—");
    const tipo = tipoPorVehiculo.get(veh) || "Sin tipo";
    acumular(porTipoMap, tipo, c);
    acumular(porVehMap, veh, c);
  }
  const real = (a) => (a.qtyReal > 0 ? a.dist / a.qtyReal : null);
  const ideal = (a) => (a.qtyIdeal > 0 ? a.idealPond / a.qtyIdeal : null);

  const rendimientoPorTipo = [...porTipoMap.entries()]
    .map(([tipo, a]) => ({ tipo, real: real(a), ideal: ideal(a), cargas: a.cargas }))
    .filter((r) => r.real != null || r.ideal != null)
    .map((r) => ({ tipo: r.tipo, real: r.real != null ? redondear(r.real, 1) : null, ideal: r.ideal != null ? redondear(r.ideal, 1) : null, cargas: r.cargas }))
    .sort((a, b) => a.tipo.localeCompare(b.tipo, "es"));

  const candidatos = [...porVehMap.entries()]
    .map(([vehiculo, a]) => ({ vehiculo, tipo: tipoPorVehiculo.get(vehiculo) || "Sin tipo", cargas: a.cargas, real: real(a), ideal: ideal(a) }))
    .filter((r) => r.cargas >= MIN_CARGAS_RENDIMIENTO && r.real != null && r.ideal != null && r.ideal > 0);
  const peoresRendimientos = topN(candidatos, 10, (a, b) => a.real / a.ideal - b.real / b.ideal).map((r) => ({
    vehiculo: r.vehiculo,
    tipo: r.tipo,
    cargas: r.cargas,
    real: redondear(r.real, 1),
    ideal: redondear(r.ideal, 1),
    relacion: redondear((r.real / r.ideal) * 100, 1),
  }));

  return {
    galones: redondear(delPeriodo.reduce((s, c) => s + num(c.qty), 0), 1),
    costo: Math.round(delPeriodo.reduce((s, c) => s + num(c.totalCost), 0)),
    cargas: delPeriodo.length,
    porMes,
    rendimientoPorTipo,
    peoresRendimientos,
    minCargas: MIN_CARGAS_RENDIMIENTO,
  };
}

function resumenCostos({ ordenes, cargas, tipoPorVehiculo, centroPorVehiculo }, ctx) {
  const { desde, hasta } = ctx;
  const enPeriodo = (t) => t != null && t >= desde && t <= hasta;
  const porMes = new Map(mesesEntre(desde, hasta).map((m) => [m, { mes: m, mantenimiento: 0, combustible: 0 }]));
  const porCentro = new Map();
  const porVeh = new Map();

  const sumar = (mapa, clave, campo, valor, extra) => {
    const f = mapa.get(clave) || { ...extra, mantenimiento: 0, combustible: 0, km: 0 };
    f[campo] += valor;
    mapa.set(clave, f);
    return f;
  };

  const vistas = new Set();
  for (const o of ordenes) {
    const k = o.number ?? `${o.vehicleCode}-${o.startDate}`;
    if (vistas.has(k)) continue;
    vistas.add(k);
    if (o.status === "voided") continue;
    const t = fecha(o.startDate);
    if (!enPeriodo(t)) continue;
    const costo = num(o.totalCost) || num(o.totalCostLabors) + num(o.totalCostParts);
    const veh = nombre(o.vehicleCode, "—");
    const mes = porMes.get(claveMes(t));
    if (mes) mes.mantenimiento += costo;
    const centro = nombre(o.costCenter, centroPorVehiculo.get(veh) || "Sin centro de costo");
    sumar(porCentro, centro, "mantenimiento", costo, { centro });
    sumar(porVeh, veh, "mantenimiento", costo, { vehiculo: veh });
  }
  for (const c of cargas) {
    const t = fecha(c.date);
    if (!enPeriodo(t)) continue;
    const costo = num(c.totalCost);
    const veh = nombre(c.vehicleCode, "—");
    const mes = porMes.get(claveMes(t));
    if (mes) mes.combustible += costo;
    const centro = nombre(c.costCenter, centroPorVehiculo.get(veh) || "Sin centro de costo");
    sumar(porCentro, centro, "combustible", costo, { centro });
    const f = sumar(porVeh, veh, "combustible", costo, { vehiculo: veh });
    f.km += Math.max(0, num(c.distanceTraveled));
  }

  const total = (f) => f.mantenimiento + f.combustible;
  const totalGeneral = [...porVeh.values()].reduce((s, f) => s + total(f), 0);
  const kmTotales = [...porVeh.values()].reduce((s, f) => s + f.km, 0);
  // Costo/km solo con vehículos que registran distancia (para no dividir costos sin km).
  const conKm = [...porVeh.values()].filter((f) => f.km > 0);
  const costoConKm = conKm.reduce((s, f) => s + total(f), 0);

  return {
    total: Math.round(totalGeneral),
    mantenimiento: Math.round([...porVeh.values()].reduce((s, f) => s + f.mantenimiento, 0)),
    combustible: Math.round([...porVeh.values()].reduce((s, f) => s + f.combustible, 0)),
    kmRecorridos: Math.round(kmTotales),
    costoPorKm: kmTotales > 0 ? redondear(costoConKm / kmTotales, 1) : null,
    porMes: [...porMes.values()].map((f) => ({
      mes: f.mes,
      mantenimiento: Math.round(f.mantenimiento),
      combustible: Math.round(f.combustible),
      total: Math.round(total(f)),
    })),
    porCentroCosto: [...porCentro.values()]
      .map((f) => ({ centro: f.centro, mantenimiento: Math.round(f.mantenimiento), combustible: Math.round(f.combustible), total: Math.round(total(f)) }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 15),
    porVehiculo: topN([...porVeh.values()], 10, (a, b) => total(b) - total(a)).map((f) => ({
      vehiculo: f.vehiculo,
      tipo: tipoPorVehiculo.get(f.vehiculo) || "Sin tipo",
      mantenimiento: Math.round(f.mantenimiento),
      combustible: Math.round(f.combustible),
      total: Math.round(total(f)),
      km: Math.round(f.km),
      costoPorKm: f.km > 0 ? redondear(total(f) / f.km, 1) : null,
    })),
  };
}

/**
 * Construye el resumen completo.
 * @param {object} datos  { vehiculos, documentos, ordenes, ordenesAbiertasExtra, programaciones, disponibilidad, novedades, combustible }
 * @param {object} ctx    { ahora:number(ms), meses:number, desde?:number, hasta?:number }
 */
export function construirResumen(datos, ctx) {
  const ahora = ctx.ahora;
  const meses = ctx.meses;
  const periodo = ctx.desde != null ? { desde: ctx.desde, hasta: ctx.hasta ?? ahora } : calcularPeriodo(ahora, meses);
  const c = { ahora, meses, ...periodo };

  const vehiculos = lista(datos.vehiculos);
  const tipoPorVehiculo = new Map();
  const centroPorVehiculo = new Map();
  for (const v of vehiculos) {
    const cod = nombre(v.code, null);
    if (!cod) continue;
    tipoPorVehiculo.set(cod, nombre(v.typeName, "Sin tipo"));
    const centro = nombre(v.costCenter, null);
    if (centro) centroPorVehiculo.set(cod, centro);
  }

  const ordenes = lista(datos.ordenes);
  const cargas = lista(datos.combustible);

  const flota = resumenFlota(vehiculos, lista(datos.disponibilidad), lista(datos.documentos), ahora);
  const mantenimiento = resumenMantenimiento(
    {
      ordenes,
      ordenesAbiertasExtra: lista(datos.ordenesAbiertasExtra),
      programaciones: lista(datos.programaciones),
      novedades: lista(datos.novedades),
    },
    c
  );
  const combustible = resumenCombustible(cargas, tipoPorVehiculo, c);
  const costos = resumenCostos({ ordenes, cargas, tipoPorVehiculo, centroPorVehiculo }, c);

  return {
    generadoEn: new Date(ahora).toISOString(),
    desde: new Date(c.desde).toISOString(),
    hasta: new Date(c.hasta).toISOString(),
    meses,
    desdeCache: false,
    parcial: false,
    avisos: [],
    kpis: {
      vehiculos: flota.total,
      disponibilidadPromedio: flota.disponibilidad.promedio,
      documentosVencidos: flota.documentos.vencidos,
      documentosPorVencer: flota.documentos.porVencer,
      otsAbiertas: mantenimiento.otsAbiertas.total,
      programacionesVencidas: mantenimiento.programaciones.vencidas,
      novedadesPendientes: mantenimiento.novedadesPendientes.total,
      costoTotal: costos.total,
      galones: combustible.galones,
      costoPorKm: costos.costoPorKm,
    },
    flota,
    mantenimiento,
    combustible,
    costos,
  };
}
