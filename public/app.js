// Dashboard de flota — frontend.
// Consume /api/resumen del Worker (o demo.json con ?demo=1). Sin datos sensibles en el navegador.
"use strict";

(() => {
  const params = new URLSearchParams(location.search);
  const MODO_DEMO = params.get("demo") === "1";
  const $ = (sel, raiz = document) => raiz.querySelector(sel);

  // ---------- almacenamiento local (solo preferencias; tolerante a fallos) ----------
  const pref = {
    leer(k) { try { return localStorage.getItem(k); } catch { return null; } },
    guardar(k, v) { try { localStorage.setItem(k, v); } catch {} },
  };

  // ---------- formato es-CO ----------
  const nf0 = new Intl.NumberFormat("es-CO", { maximumFractionDigits: 0 });
  const nf1 = new Intl.NumberFormat("es-CO", { maximumFractionDigits: 1 });
  const cop = new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 });
  const fmtMes = new Intl.DateTimeFormat("es-CO", { month: "short", year: "numeric", timeZone: "UTC" });
  const fmtMesCorto = new Intl.DateTimeFormat("es-CO", { month: "short", timeZone: "UTC" });
  const fmtFecha = new Intl.DateTimeFormat("es-CO", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
  const fmtFechaHora = new Intl.DateTimeFormat("es-CO", { dateStyle: "medium", timeStyle: "short", timeZone: "America/Bogota" });

  const esNum = (v) => typeof v === "number" && Number.isFinite(v);
  const fNum = (v, dec = 0) => (esNum(v) ? (dec ? nf1 : nf0).format(v) : "—");
  const fCop = (v) => (esNum(v) ? cop.format(v) : "—");
  /** Moneda compacta: $ 898,8 M (millones) / $ 45 mil. */
  function fCopCorto(v) {
    if (!esNum(v)) return "—";
    const a = Math.abs(v);
    if (a >= 1e6) return `$ ${nf1.format(v / 1e6)} M`;
    if (a >= 1e3) return `$ ${nf0.format(v / 1e3)} mil`;
    return cop.format(v);
  }
  const fPct = (v) => (esNum(v) ? `${nf1.format(v)} %` : "—");
  const mesDate = (k) => new Date(`${k}-01T00:00:00Z`);
  const fMes = (k) => fmtMes.format(mesDate(k));
  const fMesCorto = (k) => fmtMesCorto.format(mesDate(k));
  const fDia = (k) => (k ? fmtFecha.format(new Date(`${k}T00:00:00Z`)) : "—");

  function hace(iso) {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return "";
    const min = Math.max(0, Math.round((Date.now() - t) / 60000));
    if (min < 1) return "Datos de hace un momento";
    if (min < 60) return `Datos de hace ${min} min`;
    const h = Math.round(min / 60);
    if (h < 48) return `Datos de hace ${h} h`;
    return `Datos de hace ${Math.round(h / 24)} días`;
  }

  function diasTexto(d) {
    if (!esNum(d)) return "—";
    if (d === 0) return "hoy";
    if (d < 0) return `hace ${-d} d`;
    return `en ${d} d`;
  }

  // ---------- DOM seguro (los textos vienen de la API: siempre textContent) ----------
  function el(tag, attrs = {}, ...hijos) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === "class") e.className = v;
      else if (k === "text") e.textContent = v;
      else e.setAttribute(k, v === true ? "" : v);
    }
    for (const h of hijos.flat()) if (h != null) e.append(h instanceof Node ? h : document.createTextNode(String(h)));
    return e;
  }

  function tabla(columnas, filas) {
    const thead = el("thead", {}, el("tr", {}, columnas.map((c) => el("th", { class: c.num ? "n" : null, scope: "col" }, c.titulo))));
    const tbody = el("tbody", {}, filas.map((f) =>
      el("tr", {}, columnas.map((c) => {
        const v = c.valor(f);
        return el("td", { class: c.num ? "n" : null }, v instanceof Node ? v : String(v ?? "—"));
      }))
    ));
    return el("div", { class: "tabla-env" }, el("table", {}, thead, tbody));
  }

  function insigniaEstado(nivel, texto) {
    return el("span", { class: `estado ${nivel}` }, texto);
  }

  // ---------- estado de la app ----------
  let mesesActual = Number.parseInt(pref.leer("flota.meses") || "6", 10);
  if (![1, 3, 6].includes(mesesActual)) mesesActual = 6;
  let datosActuales = null;
  const graficas = new Map();
  let controlador = null;

  // ---------- tema ----------
  function aplicarTema(t) {
    if (t === "light" || t === "dark") document.documentElement.setAttribute("data-theme", t);
    else document.documentElement.removeAttribute("data-theme");
  }
  aplicarTema(pref.leer("flota.tema"));
  $("#btn-tema").addEventListener("click", () => {
    const oscuroAhora = getComputedStyle(document.documentElement).colorScheme.includes("dark");
    const nuevo = oscuroAhora ? "light" : "dark";
    aplicarTema(nuevo);
    pref.guardar("flota.tema", nuevo);
    if (datosActuales) renderGraficas(datosActuales);
  });
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", () => {
    if (datosActuales) renderGraficas(datosActuales);
  });

  const token = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

  // ---------- carga ----------
  function marcarPeriodo() {
    for (const b of document.querySelectorAll(".segmentado button")) {
      b.setAttribute("aria-pressed", String(Number(b.dataset.meses) === mesesActual));
    }
  }

  function mostrar(estado) {
    $("#estado-carga").classList.toggle("oculto", estado !== "carga");
    $("#estado-error").classList.toggle("oculto", estado !== "error");
    $("#contenido").classList.toggle("oculto", estado !== "datos");
  }

  function avisos(lista) {
    const cont = $("#avisos");
    cont.replaceChildren(
      ...lista.map(({ tipo, texto }) =>
        el("div", { class: `aviso ${tipo}`, role: tipo === "error" ? "alert" : null },
          el("span", { class: "icono", "aria-hidden": "true" }, tipo === "error" ? "✕" : "!"),
          el("span", {}, texto))
      )
    );
  }

  async function cargar({ forzar = false } = {}) {
    if (controlador) controlador.abort();
    controlador = new AbortController();
    const boton = $("#btn-actualizar");
    boton.disabled = true;
    boton.textContent = "Actualizando…";
    if (datosActuales) $("#principal").classList.add("recargando");
    else mostrar("carga");

    try {
      let resp;
      if (MODO_DEMO) {
        resp = await fetch("demo.json", { cache: "no-store", signal: controlador.signal });
      } else if (forzar) {
        resp = await fetch(`/api/actualizar?meses=${mesesActual}`, { method: "POST", signal: controlador.signal });
      } else {
        resp = await fetch(`/api/resumen?meses=${mesesActual}`, { signal: controlador.signal });
      }
      let cuerpo = null;
      try { cuerpo = await resp.json(); } catch {}
      if (!resp.ok || !cuerpo || cuerpo.error) {
        throw new Error(cuerpo?.error || `El servidor respondió HTTP ${resp.status}`);
      }
      datosActuales = cuerpo;
      render(cuerpo);
      mostrar("datos");
    } catch (e) {
      if (e.name === "AbortError") return;
      const msg = e.message === "Failed to fetch" ? "No hay conexión con el servidor" : e.message;
      if (datosActuales) {
        avisos([{ tipo: "error", texto: `${msg}. Se muestran los últimos datos cargados.` }, ...avisosDe(datosActuales)]);
        mostrar("datos");
      } else {
        $("#texto-error").textContent = msg;
        mostrar("error");
      }
    } finally {
      $("#principal").classList.remove("recargando");
      boton.disabled = false;
      boton.textContent = "Actualizar ahora";
    }
  }

  for (const b of document.querySelectorAll(".segmentado button")) {
    b.addEventListener("click", () => {
      const m = Number(b.dataset.meses);
      if (m === mesesActual) return;
      mesesActual = m;
      pref.guardar("flota.meses", String(m));
      marcarPeriodo();
      cargar();
    });
  }
  $("#btn-actualizar").addEventListener("click", () => cargar({ forzar: true }));
  $("#btn-reintentar").addEventListener("click", () => cargar());

  function actualizarFrescura() {
    if (!datosActuales) return;
    const t = hace(datosActuales.generadoEn);
    const extra = datosActuales.desdeCache ? " (caché)" : "";
    const f = $("#frescura");
    f.textContent = t + extra;
    f.title = `Generado: ${fmtFechaHora.format(new Date(datosActuales.generadoEn))}`;
  }
  setInterval(actualizarFrescura, 30000);

  // ---------- render ----------
  function avisosDe(d) {
    const out = [];
    if (d.parcial) out.push({ tipo: "info", texto: "Datos parciales: no se pudo descargar todo de cloudFleet en este refresco." });
    for (const a of d.avisos || []) out.push({ tipo: "info", texto: a });
    return out;
  }

  function render(d) {
    $("#insignia-demo").classList.toggle("oculto", !MODO_DEMO);
    const desde = d.desde ? fmtFecha.format(new Date(d.desde)) : "";
    const hasta = d.hasta ? fmtFecha.format(new Date(d.hasta)) : "";
    $("#texto-periodo").textContent = desde && hasta ? `${desde} – ${hasta}` : "";
    if (MODO_DEMO && esNum(d.meses) && d.meses !== mesesActual) {
      avisos([{ tipo: "info", texto: `Modo demo: el ejemplo siempre muestra ${d.meses} meses.` }, ...avisosDe(d)]);
    } else {
      avisos(avisosDe(d));
    }
    actualizarFrescura();
    renderKpis(d);
    renderTablas(d);
    renderGraficas(d);
  }

  function renderKpis(d) {
    const k = d.kpis || {};
    const tiles = [
      { etiqueta: "Vehículos", valor: fNum(k.vehiculos) },
      { etiqueta: "Disponibilidad promedio", valor: fPct(k.disponibilidadPromedio), detalle: d.flota?.disponibilidad?.vehiculosMedidos != null ? `${fNum(d.flota.disponibilidad.vehiculosMedidos)} vehículos medidos` : null },
      { etiqueta: "Documentos vencidos", valor: fNum(k.documentosVencidos), detalle: `${fNum(k.documentosPorVencer)} por vencer en 30 días` },
      { etiqueta: "OTs abiertas", valor: fNum(k.otsAbiertas) },
      { etiqueta: "Programaciones vencidas", valor: fNum(k.programacionesVencidas), detalle: `${fNum(d.mantenimiento?.programaciones?.proximas)} próximas en 30 días` },
      { etiqueta: "Novedades pendientes", valor: fNum(k.novedadesPendientes) },
      { etiqueta: "Costo total del periodo", valor: fCopCorto(k.costoTotal), detalle: fCop(k.costoTotal) },
      { etiqueta: "Costo por km", valor: esNum(k.costoPorKm) ? fCop(k.costoPorKm) : "—", detalle: d.costos?.kmRecorridos ? `${fNum(d.costos.kmRecorridos)} km recorridos` : "Sin distancia registrada" },
    ];
    $("#kpis").replaceChildren(
      ...tiles.map((t) =>
        el("div", { class: "kpi" },
          el("div", { class: "etiqueta" }, t.etiqueta),
          el("div", { class: "valor" }, t.valor),
          t.detalle ? el("div", { class: `detalle ${t.nivel || ""}` }, t.nivel === "critico" ? `✕ ${t.detalle}` : t.nivel === "alerta" ? `! ${t.detalle}` : t.detalle) : null)
      )
    );

    const p = d.mantenimiento?.programaciones || {};
    $("#mini-programaciones").replaceChildren(
      mini(fNum(p.vencidas), "Vencidas"),
      mini(fNum(p.proximas), "Próximas 30 días"),
      mini(fNum(p.ejecutadas), "Ejecutadas en el periodo"),
      mini(esNum(p.cumplimiento) ? fPct(p.cumplimiento) : "—", esNum(p.cumplimiento) ? "Ejecutadas a tiempo" : "Cumplimiento (sin dato de oportunidad)")
    );
    const c = d.combustible || {};
    $("#mini-combustible").replaceChildren(
      mini(fNum(c.galones, 1), "Galones"),
      mini(fCopCorto(c.costo), "Costo combustible"),
      mini(fNum(c.cargas), "Cargas registradas")
    );
  }
  const mini = (v, e) => el("div", {}, el("div", { class: "v" }, v), el("div", { class: "e" }, e));

  function ponerTabla(nombre, nodo, contador) {
    const tarjeta = document.querySelector(`[data-tabla="${nombre}"]`);
    tarjeta.querySelector(".tabla-env, .vacio")?.remove();
    const c = tarjeta.querySelector("[data-contador]");
    if (c) c.textContent = contador ?? "";
    tarjeta.append(nodo);
  }
  const vacio = (t = "Sin datos en el periodo") => el("p", { class: "vacio" }, t);

  function renderTablas(d) {
    const docs = d.flota?.documentos || {};
    ponerTabla("documentos",
      docs.alertas?.length
        ? tabla([
            { titulo: "Estado", valor: (f) => insigniaEstado(f.estado === "vencido" ? "critico" : "alerta", f.estado === "vencido" ? "Vencido" : "Por vencer") },
            { titulo: "Vehículo", valor: (f) => f.vehiculo },
            { titulo: "Documento", valor: (f) => f.documento },
            { titulo: "Vence", valor: (f) => fDia(f.venceEl) },
            { titulo: "Días", num: true, valor: (f) => diasTexto(f.dias) },
          ], docs.alertas)
        : vacio("Ningún documento vencido ni por vencer"),
      `(${fNum((docs.vencidos || 0) + (docs.porVencer || 0))})`);

    const ab = d.mantenimiento?.otsAbiertas || {};
    ponerTabla("otsAbiertas",
      ab.lista?.length
        ? tabla([
            { titulo: "OT", valor: (f) => (f.numero != null ? `#${f.numero}` : "—") },
            { titulo: "Vehículo", valor: (f) => f.vehiculo },
            { titulo: "Estado", valor: (f) => f.estado },
            { titulo: "Tipo", valor: (f) => f.tipo },
            { titulo: "Inicio", valor: (f) => fDia(f.inicio) },
            { titulo: "Días abierta", num: true, valor: (f) => fNum(f.diasAbierta) },
            { titulo: "Costo", num: true, valor: (f) => fCop(f.costo) },
          ], ab.lista)
        : vacio("No hay OTs abiertas"),
      `(${fNum(ab.total)})`);

    const pr = d.mantenimiento?.programaciones || {};
    ponerTabla("programaciones",
      pr.alertas?.length
        ? tabla([
            { titulo: "Estado", valor: (f) => insigniaEstado(f.estado === "vencida" ? "critico" : "alerta", f.estado === "vencida" ? "Vencida" : "Próxima") },
            { titulo: "Vehículo", valor: (f) => f.vehiculo },
            { titulo: "Tarea", valor: (f) => f.tarea },
            { titulo: "Fecha", valor: (f) => fDia(f.fecha) },
            { titulo: "Días", num: true, valor: (f) => diasTexto(f.dias) },
            { titulo: "Km restantes", num: true, valor: (f) => fNum(f.kmRestantes) },
          ], pr.alertas)
        : vacio("Sin programaciones vencidas ni próximas"),
      `(${fNum((pr.vencidas || 0) + (pr.proximas || 0))})`);

    const c = d.combustible || {};
    $("#sub-rendimiento").textContent = `Real / ideal · vehículos con al menos ${fNum(c.minCargas)} cargas con distancia`;
    ponerTabla("peoresRendimientos",
      c.peoresRendimientos?.length
        ? tabla([
            { titulo: "Vehículo", valor: (f) => f.vehiculo },
            { titulo: "Tipo", valor: (f) => f.tipo },
            { titulo: "Cargas", num: true, valor: (f) => fNum(f.cargas) },
            { titulo: "Real", num: true, valor: (f) => fNum(f.real, 1) },
            { titulo: "Ideal", num: true, valor: (f) => fNum(f.ideal, 1) },
            { titulo: "Real / ideal", num: true, valor: (f) => medidor(f.relacion) },
          ], c.peoresRendimientos)
        : vacio("No hay vehículos con suficientes cargas para comparar"),
      c.peoresRendimientos?.length ? `(top ${c.peoresRendimientos.length})` : "");

    const cv = d.costos?.porVehiculo || [];
    ponerTabla("costoVehiculo",
      cv.length
        ? tabla([
            { titulo: "Vehículo", valor: (f) => f.vehiculo },
            { titulo: "Tipo", valor: (f) => f.tipo },
            { titulo: "Mantenimiento", num: true, valor: (f) => fCop(f.mantenimiento) },
            { titulo: "Combustible", num: true, valor: (f) => fCop(f.combustible) },
            { titulo: "Total", num: true, valor: (f) => fCop(f.total) },
            { titulo: "Km", num: true, valor: (f) => (f.km ? fNum(f.km) : "—") },
            { titulo: "Costo/km", num: true, valor: (f) => fCop(f.costoPorKm) },
          ], cv)
        : vacio());
  }

  function medidor(pct) {
    const barra = el("b");
    barra.style.width = `${Math.max(0, Math.min(100, pct || 0))}%`;
    return el("span", {}, el("span", { class: "medidor", "aria-hidden": "true" }, barra), fPct(pct));
  }

  // ---------- gráficas (Chart.js) ----------
  function baseOpciones({ horizontal = false, apilado = false, formatoValor = fNum, formatoEje, maxValor, leyenda = false } = {}) {
    const muda = token("--tinta-muda");
    const rejilla = token("--rejilla");
    const eje = token("--eje");
    const ejeValor = {
      stacked: apilado,
      beginAtZero: true,
      max: maxValor,
      grid: { color: rejilla, lineWidth: 1, drawTicks: false },
      border: { display: false },
      ticks: { color: muda, padding: 6, maxTicksLimit: 6, callback: (v) => (formatoEje || formatoValor)(v), font: { size: 11 } },
    };
    const ejeCat = {
      stacked: apilado,
      grid: { display: false },
      border: { color: eje, width: 1 },
      ticks: { color: muda, font: { size: 11 }, autoSkip: true, maxRotation: 0 },
    };
    return {
      responsive: true,
      maintainAspectRatio: false,
      indexAxis: horizontal ? "y" : "x",
      animation: matchMedia("(prefers-reduced-motion: reduce)").matches ? false : { duration: 300 },
      interaction: { mode: "index", intersect: false, axis: horizontal ? "y" : "x" },
      layout: { padding: { top: 4, right: 8 } },
      scales: horizontal ? { x: ejeValor, y: ejeCat } : { x: ejeCat, y: ejeValor },
      plugins: {
        legend: { display: false }, // leyenda propia en HTML
        tooltip: {
          backgroundColor: token("--superficie"),
          titleColor: token("--tinta-2"),
          bodyColor: token("--tinta"),
          borderColor: token("--borde"),
          borderWidth: 1,
          padding: 10,
          cornerRadius: 8,
          usePointStyle: true,
          boxWidth: 12,
          boxHeight: 2,
          bodyFont: { weight: "600" },
          callbacks: {
            label: (ctx) => {
              const v = horizontal ? ctx.parsed.x : ctx.parsed.y;
              return leyenda || ctx.chart.data.datasets.length > 1 ? `${formatoValor(v)}  ${ctx.dataset.label}` : formatoValor(v);
            },
            labelPointStyle: () => ({ pointStyle: "line", rotation: 0 }),
          },
        },
      },
    };
  }

  function serieBarra(label, data, color, { apilado = false } = {}) {
    return {
      label,
      data,
      backgroundColor: color,
      hoverBackgroundColor: color,
      borderColor: token("--superficie"),
      // separación de 2 px entre segmentos/barras contiguas (color de la superficie)
      borderWidth: apilado ? 1 : 0,
      borderSkipped: "start",
      borderRadius: 4,
      maxBarThickness: 24,
      categoryPercentage: 0.7,
      barPercentage: 0.9,
    };
  }

  /** Inserta (o reemplaza) la gráfica, su leyenda y su tabla equivalente dentro de la tarjeta. */
  function grafica(nombre, { etiquetas, series, opciones, alto = false, columnasTabla, filasTabla }) {
    const tarjeta = document.querySelector(`[data-grafica="${nombre}"]`);
    graficas.get(nombre)?.destroy();
    graficas.delete(nombre);
    tarjeta.querySelectorAll(".lienzo, .vacio, .leyenda, details").forEach((n) => n.remove());

    const hayDatos = etiquetas.length && series.some((s) => s.data.some((v) => esNum(v) && v !== 0));
    if (!hayDatos || typeof Chart === "undefined") {
      tarjeta.append(vacio(typeof Chart === "undefined" ? "No se pudo cargar la librería de gráficas" : "Sin datos en el periodo"));
      return;
    }
    if (series.length > 1) {
      tarjeta.append(el("div", { class: "leyenda" }, series.map((s) => {
        const i = el("i", { "aria-hidden": "true" });
        i.style.background = s.backgroundColor;
        return el("span", {}, i, s.label);
      })));
    }
    const canvas = el("canvas", { role: "img", "aria-label": tarjeta.querySelector("h3").textContent });
    tarjeta.append(el("div", { class: `lienzo${alto ? " alto" : ""}` }, canvas));
    graficas.set(nombre, new Chart(canvas, { type: "bar", data: { labels: etiquetas, datasets: series }, options: opciones }));

    tarjeta.append(el("details", { class: "ver-tabla" }, el("summary", {}, "Ver como tabla"), tabla(columnasTabla, filasTabla)));
  }

  function renderGraficas(d) {
    const cFlota = token("--serie-flota");
    const cMant = token("--serie-mant");
    const cComb = token("--serie-comb");

    // Flota
    const porTipo = d.flota?.porTipo || [];
    grafica("vehiculosTipo", {
      etiquetas: porTipo.map((t) => t.tipo),
      series: [serieBarra("Vehículos", porTipo.map((t) => t.cantidad), cFlota)],
      opciones: baseOpciones({ horizontal: true }),
      columnasTabla: [{ titulo: "Tipo", valor: (f) => f.tipo }, { titulo: "Vehículos", num: true, valor: (f) => fNum(f.cantidad) }],
      filasTabla: porTipo,
    });

    const peores = d.flota?.disponibilidad?.peores || [];
    grafica("disponibilidad", {
      etiquetas: peores.map((p) => p.codigo),
      series: [serieBarra("Disponibilidad", peores.map((p) => p.disponibilidad), cFlota)],
      opciones: baseOpciones({ horizontal: true, formatoValor: fPct, formatoEje: (v) => `${v} %`, maxValor: 100 }),
      alto: peores.length > 6,
      columnasTabla: [
        { titulo: "Vehículo", valor: (f) => f.codigo },
        { titulo: "Tipo", valor: (f) => f.tipo },
        { titulo: "Disponibilidad", num: true, valor: (f) => fPct(f.disponibilidad) },
        { titulo: "Horas en mantenimiento", num: true, valor: (f) => fNum(f.horasMantenimiento, 1) },
      ],
      filasTabla: peores,
    });

    const docTipo = d.flota?.documentos?.porTipo || [];
    grafica("documentosTipo", {
      etiquetas: docTipo.map((t) => t.tipo),
      series: [
        serieBarra("Vencidos", docTipo.map((t) => t.vencidos), token("--estado-critico"), { apilado: true }),
        serieBarra("Por vencer (30 días)", docTipo.map((t) => t.porVencer), token("--estado-alerta"), { apilado: true }),
      ],
      opciones: baseOpciones({ horizontal: true, apilado: true, leyenda: true }),
      columnasTabla: [
        { titulo: "Documento", valor: (f) => f.tipo },
        { titulo: "Vencidos", num: true, valor: (f) => fNum(f.vencidos) },
        { titulo: "Por vencer", num: true, valor: (f) => fNum(f.porVencer) },
      ],
      filasTabla: docTipo,
    });

    // Mantenimientos
    const cm = d.mantenimiento?.costoPorMes || [];
    grafica("costoMantenimiento", {
      etiquetas: cm.map((m) => fMesCorto(m.mes)),
      series: [
        serieBarra("Mano de obra", cm.map((m) => m.manoObra), token("--serie-mano-obra"), { apilado: true }),
        serieBarra("Repuestos", cm.map((m) => m.repuestos), token("--serie-repuestos"), { apilado: true }),
      ],
      opciones: baseOpciones({ apilado: true, formatoValor: fCopCorto, leyenda: true }),
      columnasTabla: [
        { titulo: "Mes", valor: (f) => fMes(f.mes) },
        { titulo: "Mano de obra", num: true, valor: (f) => fCop(f.manoObra) },
        { titulo: "Repuestos", num: true, valor: (f) => fCop(f.repuestos) },
        { titulo: "Total", num: true, valor: (f) => fCop(f.manoObra + f.repuestos) },
      ],
      filasTabla: cm,
    });

    const est = d.mantenimiento?.otsPorEstado || [];
    grafica("otsEstado", {
      etiquetas: est.map((e) => e.etiqueta),
      series: [serieBarra("OTs", est.map((e) => e.cantidad), cMant)],
      opciones: baseOpciones(),
      columnasTabla: [{ titulo: "Estado", valor: (f) => f.etiqueta }, { titulo: "OTs", num: true, valor: (f) => fNum(f.cantidad) }],
      filasTabla: est,
    });

    const nov = d.mantenimiento?.novedadesPendientes?.porPrioridad || [];
    grafica("novedades", {
      etiquetas: nov.map((n) => n.etiqueta),
      series: [serieBarra("Novedades", nov.map((n) => n.cantidad), cMant)],
      opciones: baseOpciones(),
      columnasTabla: [{ titulo: "Prioridad", valor: (f) => f.etiqueta }, { titulo: "Pendientes", num: true, valor: (f) => fNum(f.cantidad) }],
      filasTabla: nov,
    });

    // Combustible (naranja = combustible en todo el tablero)
    const cbm = d.combustible?.porMes || [];
    grafica("galonesMes", {
      etiquetas: cbm.map((m) => fMesCorto(m.mes)),
      series: [serieBarra("Galones", cbm.map((m) => m.galones), cComb)],
      opciones: baseOpciones({ formatoValor: (v) => fNum(v, 1) }),
      columnasTabla: [{ titulo: "Mes", valor: (f) => fMes(f.mes) }, { titulo: "Galones", num: true, valor: (f) => fNum(f.galones, 1) }],
      filasTabla: cbm,
    });
    grafica("costoCombustibleMes", {
      etiquetas: cbm.map((m) => fMesCorto(m.mes)),
      series: [serieBarra("Costo", cbm.map((m) => m.costo), cComb)],
      opciones: baseOpciones({ formatoValor: fCopCorto }),
      columnasTabla: [{ titulo: "Mes", valor: (f) => fMes(f.mes) }, { titulo: "Costo", num: true, valor: (f) => fCop(f.costo) }],
      filasTabla: cbm,
    });

    const rt = d.combustible?.rendimientoPorTipo || [];
    grafica("rendimientoTipo", {
      etiquetas: rt.map((r) => r.tipo),
      series: [
        serieBarra("Real", rt.map((r) => r.real), cComb),
        serieBarra("Ideal", rt.map((r) => r.ideal), token("--serie-ideal")),
      ],
      opciones: baseOpciones({ horizontal: true, formatoValor: (v) => fNum(v, 1), leyenda: true }),
      alto: rt.length > 4,
      columnasTabla: [
        { titulo: "Tipo", valor: (f) => f.tipo },
        { titulo: "Real", num: true, valor: (f) => fNum(f.real, 1) },
        { titulo: "Ideal", num: true, valor: (f) => fNum(f.ideal, 1) },
        { titulo: "Cargas con distancia", num: true, valor: (f) => fNum(f.cargas) },
      ],
      filasTabla: rt,
    });

    // Costos
    const ctm = d.costos?.porMes || [];
    grafica("costoTotalMes", {
      etiquetas: ctm.map((m) => fMesCorto(m.mes)),
      series: [
        serieBarra("Mantenimiento", ctm.map((m) => m.mantenimiento), cMant, { apilado: true }),
        serieBarra("Combustible", ctm.map((m) => m.combustible), cComb, { apilado: true }),
      ],
      opciones: baseOpciones({ apilado: true, formatoValor: fCopCorto, leyenda: true }),
      columnasTabla: [
        { titulo: "Mes", valor: (f) => fMes(f.mes) },
        { titulo: "Mantenimiento", num: true, valor: (f) => fCop(f.mantenimiento) },
        { titulo: "Combustible", num: true, valor: (f) => fCop(f.combustible) },
        { titulo: "Total", num: true, valor: (f) => fCop(f.total) },
      ],
      filasTabla: ctm,
    });

    const cc = d.costos?.porCentroCosto || [];
    grafica("costoCentro", {
      etiquetas: cc.map((c) => c.centro),
      series: [
        serieBarra("Mantenimiento", cc.map((c) => c.mantenimiento), cMant, { apilado: true }),
        serieBarra("Combustible", cc.map((c) => c.combustible), cComb, { apilado: true }),
      ],
      opciones: baseOpciones({ horizontal: true, apilado: true, formatoValor: fCopCorto, leyenda: true }),
      alto: cc.length > 5,
      columnasTabla: [
        { titulo: "Centro de costo", valor: (f) => f.centro },
        { titulo: "Mantenimiento", num: true, valor: (f) => fCop(f.mantenimiento) },
        { titulo: "Combustible", num: true, valor: (f) => fCop(f.combustible) },
        { titulo: "Total", num: true, valor: (f) => fCop(f.total) },
      ],
      filasTabla: cc,
    });
  }

  // ---------- inicio ----------
  marcarPeriodo();
  if (MODO_DEMO) document.title = "Dashboard de flota (demo)";
  cargar();
})();
