// Datos ficticios con la misma forma que las respuestas de la API de cloudFleet
// (según los ejemplos de la colección de Postman). Sin red, deterministas (semilla fija).

export function generarDatosFalsos({ ahora, semilla = 42, vehiculos: nVeh = 36 } = {}) {
  let s = semilla >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const entre = (a, b) => a + rnd() * (b - a);
  const ent = (a, b) => Math.floor(entre(a, b + 1));
  const elegir = (arr) => arr[Math.floor(rnd() * arr.length)];
  const DIA = 86400000;
  const isoZ = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, ".0000000Z");

  const tipos = [
    { tipo: "Tractocamion", marcas: [["KENWORTH", "T800"], ["International", "9800"]], ideal: 6.2, km: 260 },
    { tipo: "Camión sencillo", marcas: [["Chevrolet", "NPR"], ["Hino", "Dutro"]], ideal: 11.5, km: 160 },
    { tipo: "Camioneta", marcas: [["Toyota", "Hilux"], ["Nissan", "Frontier"]], ideal: 32, km: 120 },
    { tipo: "Volqueta", marcas: [["Mercedes-Benz", "Actros"]], ideal: 5.4, km: 140 },
  ];
  const centros = [
    { id: 5677, name: "Propios", code: null },
    { id: 6037, name: "Inversiones", code: "INVE" },
    { id: 6120, name: "Operación Antioquia", code: "OPANT" },
    { id: 6121, name: "Operación Costa", code: "OPCOS" },
  ];
  const grupos = [
    { id: 3231, name: "TRANSPORTES", code: null },
    { id: 3205, name: "PLANTA PRINCIPAL", code: "401" },
  ];
  const letras = "ABCDEFGHJKLMNPRSTUVWXYZ";

  const vehiculos = [];
  for (let i = 0; i < nVeh; i++) {
    const t = i === 0 ? tipos[0] : elegir(tipos);
    const [marca, linea] = elegir(t.marcas);
    const code = `${elegir(letras)}${elegir(letras)}${elegir(letras)}${String(100 + i * 7).slice(-3)}`;
    vehiculos.push({
      id: 60800 + i,
      code,
      typeName: i === 5 ? null : t.tipo, // un vehículo sin tipo para probar nulos
      brandName: marca,
      lineName: linea,
      odometerType: 1,
      mainMeasurementType: 1,
      odometer: { lastMeter: ent(20000, 400000), lastMeterAt: isoZ(ahora - ent(0, 5) * DIA) },
      hourmeter: null,
      workload: "medium",
      avgOdometerDay: t.km,
      costCenter: i % 7 === 0 ? null : elegir(centros),
      group1: null,
      driver: null,
      createdAt: "2017-04-28T14:08:58.4000000Z",
      _t: t,
    });
  }
  const tipoDe = (v) => v._t;

  const docsTipos = [
    { name: "SOAT", code: "soat" },
    { name: "Revisión técnico-mecánica", code: "rtm" },
    { name: "Póliza todo riesgo", code: "poliza" },
    { name: "Tarjeta de operación", code: "toper" },
  ];
  const documentos = [];
  for (const v of vehiculos) {
    for (const d of docsTipos) {
      if (d.code === "toper" && tipoDe(v).tipo === "Camioneta") continue;
      if (rnd() < 0.82) continue; // solo una parte cae en la ventana consultada (validToEnd = hoy+30)
      const vence = ahora + ent(-45, 30) * DIA;
      documentos.push({
        id: ent(20000, 30000),
        docType: d,
        number: "",
        vendor: null,
        vehicleCode: v.code,
        cost: rnd() < 0.5 ? null : ent(400000, 2500000),
        issueDate: null,
        validFrom: isoZ(vence - 365 * DIA),
        validTo: isoZ(vence),
        costCenter: v.costCenter,
        isCurrent: true,
        files: [],
      });
    }
  }

  const estados = ["closed", "closed", "closed", "closed", "closed", "onTechnicalCompletion", "opened", "voided"];
  const tiposOt = [null, { id: 1, name: "Preventivo" }, { id: 2, name: "Correctivo" }];
  const ordenes = [];
  let numOt = 4100;
  for (let d = 180; d >= 0; d--) {
    const n = ent(0, 2);
    for (let k = 0; k < n; k++) {
      const v = elegir(vehiculos);
      const inicio = ahora - d * DIA - ent(0, 10) * 3600000;
      let status = elegir(estados);
      if (d < 3 && status === "closed") status = "opened";
      if (d > 25 && (status === "opened" || status === "onTechnicalCompletion") && rnd() < 0.85) status = "closed";
      const pesado = ["Tractocamion", "Volqueta"].includes(tipoDe(v).tipo) ? 2.2 : 1;
      const labors = Math.round(entre(80000, 900000) * pesado);
      const parts = rnd() < 0.15 ? 0 : Math.round(entre(50000, 2600000) * pesado);
      ordenes.push({
        number: numOt++,
        vehicleCode: v.code,
        workshopDate: isoZ(inicio),
        startDate: isoZ(inicio),
        estimatedFinishDate: isoZ(inicio + DIA),
        status,
        odometer: ent(20000, 400000),
        vendor: { id: 74745, name: "Taller ficticio S.A.S", businessId: "900000000" },
        driver: { id: 1, name: "Conductor de prueba" },
        type: elegir(tiposOt),
        city: { id: 10263, name: "Medellín", code: "1" },
        costCenter: v.costCenter,
        primaryGroup: elegir(grupos),
        totalCostLabors: labors,
        totalCostParts: parts,
        totalCost: labors + parts,
        technicalCompletionDate: null,
        finalCompletionDate: null,
      });
    }
  }

  const tareas = ["Cambio de aceite motor", "Rotación de llantas", "Revisión de frenos", "Cambio de filtros", "Alineación y balanceo", "Engrase general"];
  const programaciones = [];
  let cons = 5100;
  for (const v of vehiculos) {
    for (let k = 0; k < 4; k++) {
      const fechaEj = ahora + ent(-150, 30) * DIA;
      let status;
      if (fechaEj > ahora) status = "Programada";
      else {
        const r = rnd();
        status = r < 0.68 ? "Ejecutada a tiempo" : r < 0.86 ? "Ejecutada tarde" : "Vencida";
      }
      programaciones.push({
        status,
        consecutive: cons++,
        vehicle: { id: v.id, code: v.code, type: v.typeName, currentOdometer: v.odometer.lastMeter, avgOdometerDay: v.avgOdometerDay, currentHourmeter: null, avgHourmeterDay: null },
        task: { id: 300000 + k, name: elegir(tareas) },
        odometerToExecute: v.odometer.lastMeter + ent(-3000, 3000),
        hourmeterToExecute: null,
        dateToExecute: new Date(fechaEj).toISOString().replace(/\.\d{3}Z$/, "Z"),
        executionDateIsCalculated: true,
        odometerToExecuteDiff: ent(-3000, 3000),
        hourmeterToExecuteDiff: null,
        dateToExecuteDaysDiff: Math.round((fechaEj - ahora) / DIA),
        scheduleSource: "Auto",
        woCreation: null,
        woExecution: null,
        scheduleType: "Trabajo",
        routine: null,
      });
    }
  }

  const disponibilidad = vehiculos.map((v, i) => {
    const debio = i === 3 ? 0 : entre(600, 1100);
    const mant = rnd() < 0.3 ? entre(40, 260) : entre(0, 30);
    return {
      id: v.id,
      code: v.code,
      typeName: v.typeName,
      brandName: v.brandName,
      lineName: v.lineName,
      city: null,
      costCenter: v.costCenter,
      primaryGroup: elegir(grupos),
      secundaryGroup: null,
      hoursShouldWork: Math.round(debio * 100) / 100,
      hoursInMaintenance: Math.round(mant * 100) / 100,
      availability: debio > 0 ? Math.round(Math.max(0, (1 - mant / debio) * 100) * 100) / 100 : 100,
    };
  });

  const prios = ["high", "medium", "medium", "low", "low", null];
  const novedades = [];
  for (let k = 0; k < 23; k++) {
    const v = elegir(vehiculos);
    novedades.push({
      number: 1500 + k,
      vehicleCode: v.code,
      reportedAt: isoZ(ahora - ent(0, 60) * DIA),
      reporter: { id: 1, name: "Persona de prueba" },
      prority: elegir(prios),
      odometer: null,
      responsible: null,
      associatedLabor: { id: 1, name: "Revisar" },
      comment: null,
      isDone: false,
      doneAt: null,
      workOrderDoneNumber: null,
      createdAt: isoZ(ahora - ent(0, 60) * DIA),
      fromChecklistNumber: null,
    });
  }

  const combustible = [];
  let numComb = 2800;
  for (const v of vehiculos) {
    const t = tipoDe(v);
    const ineficiente = rnd() < 0.2 ? entre(0.62, 0.85) : entre(0.9, 1.08);
    let fechaC = ahora - 180 * DIA + ent(0, 5) * DIA;
    while (fechaC < ahora) {
      const qty = Math.round(entre(t.ideal > 20 ? 8 : 35, t.ideal > 20 ? 18 : 95) * 10) / 10;
      const sinDistancia = rnd() < 0.06;
      const dist = sinDistancia ? null : Math.round(qty * t.ideal * ineficiente * entre(0.93, 1.07));
      const precio = entre(10400, 11200); // COP por galón (ACPM / gasolina)
      combustible.push({
        number: numComb++,
        vehicleCode: v.code,
        date: new Date(fechaC).toISOString().replace(/\.\d{3}Z$/, "Z"),
        odometer: v.odometer.lastMeter,
        distanceTraveled: dist,
        hourmeter: null,
        hourmeterTraveled: null,
        fuelTypeName: t.ideal > 20 ? "Gasolina" : "ACPM",
        qty,
        totalCost: Math.round(qty * precio),
        realOdometerEfficiency: dist != null ? Math.round((dist / qty) * 10) / 10 : null,
        idealOdometerEfficiency: t.ideal,
        realHourmeterEfficiency: null,
        idealHourmeterEfficiency: null,
        driver: { id: 1, name: "Conductor de prueba" },
        vendor: null,
        createdAt: new Date(fechaC + 3600000).toISOString(),
        createdBy: "Persona de prueba",
        city: { id: 10550, name: "Armenia", code: "ARM" },
        costCenter: v.costCenter,
        primaryGroup: elegir(grupos),
        secundaryGroup: null,
      });
      fechaC += Math.round(entre(t.km > 200 ? 3 : 5, t.km > 200 ? 6 : 12) * DIA);
    }
  }

  for (const v of vehiculos) delete v._t;
  return { vehiculos, documentos, ordenes, ordenesAbiertasExtra: [], programaciones, disponibilidad, novedades, combustible };
}
