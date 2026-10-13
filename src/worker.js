// Worker del dashboard de flota.
// - Sirve los archivos de ./public (static assets).
// - GET  /api/resumen?meses=1..6   -> resumen agregado (con caché KV de 30 min)
// - POST /api/actualizar?meses=1..6 -> fuerza el recálculo
// La API key de cloudFleet vive solo como secreto del Worker (env.CLOUDFLEET_API_KEY).

import { ClienteCloudFleet, ErrorCloudFleet } from "./cloudfleet.js";
import { construirResumen, calcularPeriodo, claveDia, DIAS_ALERTA } from "./agregados.js";

const TTL_CACHE_SEG = 30 * 60; // 30 minutos
const TTL_PARCIAL_SEG = 5 * 60; // un resultado incompleto se guarda menos tiempo
const REFRESCO_MINIMO_SEG = 60; // "Actualizar ahora" no recalcula si el dato tiene < 1 min
const VERSION_CACHE = "v1";
const DIA_MS = 24 * 60 * 60 * 1000;

// Cálculos en curso en este isolate: misma clave => misma promesa (evita estampidas).
const enCurso = new Map();

const CABECERAS_JSON = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

function json(cuerpo, estado = 200, extra = {}) {
  return new Response(JSON.stringify(cuerpo), { status: estado, headers: { ...CABECERAS_JSON, ...extra } });
}

function leerMeses(url) {
  const v = url.searchParams.get("meses");
  if (v == null || v === "") return 6;
  const n = Number.parseInt(v, 10);
  if (!Number.isInteger(n) || n < 1 || n > 6 || String(n) !== v.trim()) return null;
  return n;
}

const claveCache = (meses) => `resumen:${VERSION_CACHE}:meses=${meses}`;

async function leerCache(env, meses) {
  if (!env.CACHE) return null;
  try {
    return await env.CACHE.get(claveCache(meses), "json");
  } catch (e) {
    console.warn("KV no disponible:", e?.message);
    return null;
  }
}

async function guardarCache(env, meses, resumen) {
  if (!env.CACHE) return;
  try {
    await env.CACHE.put(claveCache(meses), JSON.stringify(resumen), {
      expirationTtl: resumen.parcial ? TTL_PARCIAL_SEG : TTL_CACHE_SEG,
    });
  } catch (e) {
    console.warn("No se pudo guardar en KV:", e?.message);
  }
}

/** Fecha ISO8601 (UTC) para los filtros de cloudFleet. */
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

/**
 * Descarga de cloudFleet todo lo necesario, en orden de prioridad y de forma secuencial.
 * Peticiones mínimas por refresco: 7 (8 si meses < 6). Ver README para la estimación.
 */
async function descargarDatos(env, meses, ahora) {
  const cliente = new ClienteCloudFleet(env.CLOUDFLEET_API_KEY, {
    maxSubrequests: Number.parseInt(env.MAX_SUBREQUESTS ?? "45", 10) || 45,
    maxEsperaMs: (Number.parseInt(env.MAX_ESPERA_SEG ?? "60", 10) || 60) * 1000,
    maxPaginas: 40,
  });
  const { desde, hasta } = calcularPeriodo(ahora, meses);
  // Programaciones: hasta hoy + 30 días; el rango no puede superar 6 meses.
  const progHasta = ahora + DIAS_ALERTA * DIA_MS;
  const progDesde = Math.max(desde, progHasta - 180 * DIA_MS);
  const hace6Meses = calcularPeriodo(ahora, 6).desde;

  const tareas = [
    ["vehiculos", "vehicles/", {}],
    ["disponibilidad", "availability", { dateFrom: iso(desde), dateTo: iso(hasta) }],
    ["novedades", "issues/", {}], // por defecto la API devuelve solo las pendientes (includeDone=false)
    // Documentos vigentes que vencen hasta dentro de 30 días (fechas sin hora, según la API).
    ["documentos", "vehicles/documents", { isCurrent: "true", validToStart: "2000-01-01", validToEnd: claveDia(ahora + DIAS_ALERTA * DIA_MS) }],
    ["ordenes", "work-orders/", { startDateFrom: iso(desde), startDateTo: iso(hasta) }],
    ...(meses < 6
      ? [["ordenesAbiertasExtra", "work-orders/", { status: "opened,onTechnicalCompletion", startDateFrom: iso(hace6Meses), startDateTo: iso(desde) }]]
      : []),
    ["programaciones", "maintenance-schedules/", { dateToExecuteFrom: iso(progDesde), dateToExecuteTo: iso(progHasta) }],
    // Filtro por fecha de tanqueo (startDate*), no por fecha de creación del registro.
    ["combustible", "fuel-entries", { startDateFrom: iso(desde), startDateTo: iso(hasta) }],
  ];

  const datos = {};
  const avisos = [];
  let parcial = false;
  let detenido = null;

  for (const [clave, ruta, params] of tareas) {
    if (detenido) {
      datos[clave] = [];
      continue;
    }
    try {
      const r = await cliente.listar(ruta, params, clave);
      datos[clave] = r.items;
      if (r.truncado) {
        parcial = true;
        if (r.error) {
          detenido = r.error;
        } else {
          avisos.push(`Se alcanzó el tope de ${cliente.maxPaginas} páginas en ${clave}; se usan los primeros ${r.items.length} registros.`);
        }
      }
    } catch (e) {
      if (e instanceof ErrorCloudFleet && e.recuperable) {
        datos[clave] = [];
        detenido = e;
        parcial = true;
      } else {
        throw e;
      }
    }
  }

  if (detenido) {
    const faltan = tareas.filter(([c]) => !datos[c]?.length).map(([c]) => c);
    // Si no se obtuvo nada útil, se reporta el error tal cual (p. ej. límite alcanzado).
    if (!datos.vehiculos?.length && !datos.ordenes?.length && !datos.combustible?.length) throw detenido;
    avisos.push(`${detenido.message}. Datos parciales (sin datos o incompletos: ${faltan.join(", ") || "ninguno"}).`);
  }
  if (progDesde > desde) avisos.push("Las programaciones se consultan desde " + claveDia(progDesde) + " (cloudFleet limita el rango a 6 meses).");

  return {
    datos,
    avisos,
    parcial,
    periodo: { desde, hasta },
    peticiones: { total: cliente.subrequests, porEndpoint: cliente.porEndpoint, esperaSeg: Math.round(cliente.esperaMs / 1000) },
  };
}

async function calcularResumen(env, meses) {
  const ahora = Date.now();
  const d = await descargarDatos(env, meses, ahora);
  const resumen = construirResumen(d.datos, { ahora, meses, ...d.periodo });
  resumen.parcial = d.parcial;
  resumen.avisos = d.avisos;
  resumen.peticiones = d.peticiones;
  await guardarCache(env, meses, resumen);
  return resumen;
}

/** Calcula reutilizando la promesa si ya hay un cálculo en curso para ese periodo. */
function calcularSinEstampida(env, meses) {
  const k = claveCache(meses);
  let p = enCurso.get(k);
  if (!p) {
    p = calcularResumen(env, meses).finally(() => enCurso.delete(k));
    enCurso.set(k, p);
  }
  return p;
}

function respuestaError(e) {
  if (e instanceof ErrorCloudFleet) {
    const extra = e.reintentarEn ? { "Retry-After": String(e.reintentarEn) } : {};
    return json({ error: e.message, reintentarEn: e.reintentarEn ?? undefined }, e.estado, extra);
  }
  console.error("Error inesperado:", e?.stack || e);
  return json({ error: "Error interno al generar el resumen" }, 500);
}

/** Protección CSRF básica: si el navegador envía Origin, debe ser el mismo del Worker. */
function mismoOrigen(request, url) {
  const origen = request.headers.get("Origin");
  if (origen && origen !== url.origin) return false;
  const sitio = request.headers.get("Sec-Fetch-Site");
  if (sitio && sitio !== "same-origin" && sitio !== "none") return false;
  return true;
}

async function manejarApi(request, env, url) {
  const ruta = url.pathname.replace(/\/+$/, "");

  if (ruta === "/api/resumen") {
    if (request.method !== "GET" && request.method !== "HEAD") return json({ error: "Método no permitido" }, 405, { Allow: "GET, HEAD" });
    const meses = leerMeses(url);
    if (meses == null) return json({ error: "El parámetro meses debe ser un entero entre 1 y 6" }, 400);
    const cache = await leerCache(env, meses);
    if (cache) return json({ ...cache, desdeCache: true });
    try {
      return json(await calcularSinEstampida(env, meses));
    } catch (e) {
      return respuestaError(e);
    }
  }

  if (ruta === "/api/actualizar") {
    if (request.method !== "POST") return json({ error: "Método no permitido" }, 405, { Allow: "POST" });
    if (!mismoOrigen(request, url)) return json({ error: "Origen no permitido" }, 403);
    const meses = leerMeses(url);
    if (meses == null) return json({ error: "El parámetro meses debe ser un entero entre 1 y 6" }, 400);
    // Evita gastar el cupo de cloudFleet si el dato es de hace menos de 1 minuto.
    const cache = await leerCache(env, meses);
    if (cache?.generadoEn && Date.now() - Date.parse(cache.generadoEn) < REFRESCO_MINIMO_SEG * 1000) {
      return json({ ...cache, desdeCache: true });
    }
    try {
      return json(await calcularSinEstampida(env, meses));
    } catch (e) {
      return respuestaError(e);
    }
  }

  return json({ error: "Ruta no encontrada" }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      return manejarApi(request, env, url);
    }
    // Todo lo demás: archivos estáticos de ./public.
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response("No encontrado", { status: 404 });
  },
};
