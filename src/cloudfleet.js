// Cliente mínimo de la API de cloudFleet pensado para Cloudflare Workers.
// - Peticiones SECUENCIALES (nunca en paralelo) para respetar 30 req/min.
// - Lee X-RateLimit-Remaining / X-RateLimit-Reset y espera cuando quedan 1-2.
// - Reintenta 429 respetando Retry-After, con un tope total de espera.
// - Pagina siguiendo el header X-NextPage (solo si apunta al mismo host de cloudFleet).
// - Lleva la cuenta de subrequests para no superar el límite del plan de Workers.

export const BASE_URL = "https://fleet.cloudfleet.com/api/v1/";
const ORIGEN_PERMITIDO = new URL(BASE_URL).origin;

/** Error con mensaje en español listo para mostrar al usuario. */
export class ErrorCloudFleet extends Error {
  constructor(mensaje, { estado = 502, reintentarEn = null, recuperable = false } = {}) {
    super(mensaje);
    this.name = "ErrorCloudFleet";
    this.estado = estado; // código HTTP que devolverá el Worker
    this.reintentarEn = reintentarEn; // segundos (para 429)
    this.recuperable = recuperable; // true: se puede devolver lo obtenido como parcial
  }
}

const dormirPorDefecto = (ms) => new Promise((r) => setTimeout(r, ms));

function entero(v) {
  if (v == null || v === "") return null;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

export class ClienteCloudFleet {
  /**
   * @param {string} apiKey
   * @param {object} [op]
   * @param {number} [op.maxSubrequests=45]  tope de peticiones por refresco
   * @param {number} [op.maxEsperaMs=60000]  tope total de espera por rate limit
   * @param {number} [op.maxPaginas=40]      tope de páginas por endpoint
   * @param {Function} [op.fetchImpl]        para pruebas
   * @param {Function} [op.dormir]           para pruebas
   */
  constructor(apiKey, op = {}) {
    if (!apiKey) throw new ErrorCloudFleet("Falta configurar el secreto CLOUDFLEET_API_KEY en el Worker", { estado: 500 });
    this.apiKey = apiKey;
    this.maxSubrequests = op.maxSubrequests ?? 45;
    this.maxEsperaMs = op.maxEsperaMs ?? 60_000;
    this.maxPaginas = op.maxPaginas ?? 40;
    this.fetch = op.fetchImpl ?? ((...a) => fetch(...a));
    this.dormir = op.dormir ?? dormirPorDefecto;
    this.subrequests = 0;
    this.esperaMs = 0;
    this.restantes = null; // X-RateLimit-Remaining de la última respuesta
    this.reinicioSeg = null; // X-RateLimit-Reset de la última respuesta
    this.porEndpoint = {};
  }

  async #esperar(ms, motivo) {
    if (this.esperaMs + ms > this.maxEsperaMs) {
      const seg = Math.ceil(ms / 1000);
      throw new ErrorCloudFleet(`Límite de cloudFleet alcanzado, intenta en ${seg} s`, {
        estado: 429,
        reintentarEn: seg,
        recuperable: true,
      });
    }
    this.esperaMs += ms;
    console.log(`cloudFleet: esperando ${ms} ms (${motivo})`);
    await this.dormir(ms);
  }

  /** Una petición GET con control de rate limit. Devuelve { datos, siguiente }. */
  async #pedir(url, etiqueta) {
    for (let intento = 0; intento < 4; intento++) {
      // Pausa preventiva si quedan 1-2 peticiones en la ventana actual.
      if (this.restantes != null && this.restantes <= 2) {
        const seg = Math.max(1, this.reinicioSeg ?? 60);
        await this.#esperar(seg * 1000 + 250, "quedan pocas peticiones en la ventana");
        this.restantes = null;
      }
      if (this.subrequests >= this.maxSubrequests) {
        throw new ErrorCloudFleet("Se alcanzó el tope de peticiones por refresco; datos incompletos", {
          estado: 503,
          recuperable: true,
        });
      }
      this.subrequests++;
      this.porEndpoint[etiqueta] = (this.porEndpoint[etiqueta] || 0) + 1;

      let resp;
      try {
        resp = await this.fetch(url, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json; charset=utf-8",
            Accept: "application/json",
          },
        });
      } catch (e) {
        throw new ErrorCloudFleet("No se pudo conectar con cloudFleet", { estado: 502, recuperable: true });
      }

      const restantes = entero(resp.headers.get("X-RateLimit-Remaining"));
      const reinicio = entero(resp.headers.get("X-RateLimit-Reset"));
      if (restantes != null) this.restantes = restantes;
      if (reinicio != null) this.reinicioSeg = reinicio;

      if (resp.status === 429) {
        const seg = entero(resp.headers.get("Retry-After")) ?? reinicio ?? 60;
        await this.#esperar(seg * 1000 + 250, "HTTP 429");
        this.restantes = null;
        continue;
      }
      if (resp.status === 401) throw new ErrorCloudFleet("API key inválida", { estado: 502 });
      if (resp.status === 403) throw new ErrorCloudFleet("La API key no tiene permisos para consultar esta información en cloudFleet", { estado: 502 });
      if (!resp.ok) {
        let detalle = "";
        let mensaje = "";
        try {
          const cuerpo = await resp.json();
          mensaje = String(cuerpo?.error?.message ?? cuerpo?.message ?? "");
          detalle = mensaje ? `: ${mensaje.slice(0, 200)}` : "";
        } catch {}
        // cloudFleet responde 404 "No ... found with the specified filters" cuando no hay resultados.
        if (resp.status === 404 && /no .*found/i.test(mensaje)) return { datos: [], siguiente: null };
        throw new ErrorCloudFleet(`Error de cloudFleet en ${etiqueta} (HTTP ${resp.status})${detalle}`, { estado: 502 });
      }

      let datos;
      try {
        datos = await resp.json();
      } catch {
        throw new ErrorCloudFleet(`Respuesta inválida de cloudFleet en ${etiqueta}`, { estado: 502 });
      }
      return { datos, siguiente: resp.headers.get("X-NextPage") };
    }
    throw new ErrorCloudFleet("Límite de cloudFleet alcanzado, intenta en 60 s", { estado: 429, reintentarEn: 60, recuperable: true });
  }

  /**
   * Lista todos los elementos de un endpoint paginado.
   * @returns {Promise<{items:any[], paginas:number, truncado:boolean, error?:ErrorCloudFleet}>}
   *   Si ocurre un error recuperable a mitad de la paginación, devuelve lo obtenido con `error`.
   */
  async listar(ruta, params = {}, etiqueta = ruta) {
    const url = new URL(ruta, BASE_URL);
    for (const [k, v] of Object.entries(params)) if (v != null && v !== "") url.searchParams.set(k, String(v));
    let siguiente = url.toString();
    const items = [];
    let paginas = 0;
    while (siguiente) {
      if (paginas >= this.maxPaginas) return { items, paginas, truncado: true };
      let r;
      try {
        r = await this.#pedir(siguiente, etiqueta);
      } catch (e) {
        if (e instanceof ErrorCloudFleet && e.recuperable && paginas > 0) return { items, paginas, truncado: true, error: e };
        throw e;
      }
      paginas++;
      if (Array.isArray(r.datos)) items.push(...r.datos);
      siguiente = null;
      if (r.siguiente) {
        try {
          const u = new URL(r.siguiente, BASE_URL);
          // Solo se sigue la paginación hacia cloudFleet (la API key nunca sale a otro host).
          if (u.origin === ORIGEN_PERMITIDO) siguiente = u.toString();
        } catch {}
      }
    }
    return { items, paginas, truncado: false };
  }
}
