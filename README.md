# Dashboard de flota (cloudFleet + Cloudflare Workers)

Dashboard web que resume el estado de la flota a partir de la API de [cloudFleet](https://developer.cloudfleet.com/):
estado de flota, mantenimientos, combustible y costos. Un **Cloudflare Worker** consulta cloudFleet con la API key
(guardada como secreto), agrega los datos y entrega al navegador solo un JSON compacto. **La API key nunca llega al navegador.**

## Qué muestra

- **KPIs**: vehículos, disponibilidad promedio, documentos vencidos / por vencer, OTs abiertas, programaciones vencidas,
  novedades pendientes, costo total del periodo y costo por km.
- **Estado de flota**: vehículos por tipo, 10 vehículos con menor disponibilidad, documentos vencidos y por vencer (30 días)
  por tipo, y tabla de alertas ordenada por urgencia.
- **Mantenimientos**: costo por mes (mano de obra vs repuestos), OTs por estado, novedades pendientes por prioridad,
  tabla de OTs abiertas (días abierta) y programaciones vencidas / próximas con % de cumplimiento a tiempo.
- **Combustible**: galones y costo por mes, rendimiento real vs ideal por tipo de vehículo, top 10 de peor rendimiento
  relativo (real/ideal, mínimo 3 cargas con distancia).
- **Costos**: costo total por mes (mantenimiento + combustible), por centro de costo y top 10 de vehículos con costo/km.

Selector de periodo (1, 3 o 6 meses), botón **Actualizar ahora**, indicador "Datos de hace X min", modo claro/oscuro,
diseño responsive y una tabla equivalente ("Ver como tabla") bajo cada gráfica.

## Arquitectura

```
Navegador ──(mismo origen)──> Worker "dashboard-flota"
                                ├─ public/            archivos estáticos (index.html, app.js, estilos.css, demo.json)
                                ├─ GET  /api/resumen?meses=1..6     (por defecto 6)
                                └─ POST /api/actualizar?meses=1..6  (fuerza refresco)
                                      │  caché KV "CACHE" (30 min por periodo)
                                      └─> https://fleet.cloudfleet.com/api/v1/  (Bearer <CLOUDFLEET_API_KEY>)
```

- `src/worker.js`: rutas, caché KV, anti-estampida (si ya hay un cálculo en curso en el mismo isolate se reutiliza la
  promesa), errores en español (`{ "error": "..." }`), protección de origen en el POST, sin CORS.
- `src/cloudfleet.js`: cliente con peticiones **secuenciales**, paginación por `X-NextPage` (tope 40 páginas por endpoint
  y solo hacia `fleet.cloudfleet.com`), lectura de `X-RateLimit-Remaining` / `X-RateLimit-Reset`, reintento de 429 con
  `Retry-After` y tope total de espera.
- `src/agregados.js`: funciones puras de agregación (probadas en Node sin red).
- La respuesta incluye `generadoEn`, `desde`, `hasta`, `meses`, `desdeCache`, `parcial`, `avisos` y `peticiones`.

### Endpoints de cloudFleet usados (todos GET)

| Endpoint | Filtros usados |
|---|---|
| `vehicles/` | — |
| `availability` | `dateFrom`, `dateTo` |
| `issues/` | ninguno: por defecto devuelve solo pendientes (`includeDone=false`) |
| `vehicles/documents` | `isCurrent=true`, `validToStart=2000-01-01`, `validToEnd=hoy+30d` (fechas sin hora) |
| `work-orders/` | `startDateFrom`, `startDateTo` (+ una consulta de OTs `opened,onTechnicalCompletion` de los 6 meses anteriores cuando el periodo es < 6 meses) |
| `maintenance-schedules/` | `dateToExecuteFrom`, `dateToExecuteTo` (hasta hoy+30 días, rango ≤ 180 días) |
| `fuel-entries` | `startDateFrom`, `startDateTo` (fecha de **tanqueo**, no de creación) |

### Límite de 30 peticiones/minuto y por qué hay caché de 30 min

cloudFleet permite **30 peticiones por minuto** por API key y cada página trae máximo 50 registros. Un refresco completo
hace como mínimo **7 peticiones** (8 si el periodo es de 1 o 3 meses) y una por cada página adicional: una flota de ~50
vehículos suele quedar en 10–20; una flota grande con mucho combustible puede llegar al tope configurado.
Si quedan 1–2 peticiones en la ventana, el Worker espera el `X-RateLimit-Reset`; si recibe un 429 espera `Retry-After`.
La espera total está limitada (`MAX_ESPERA_SEG`, 60 s por defecto); si no alcanza, devuelve lo obtenido con `parcial: true`
(o el error "Límite de cloudFleet alcanzado, intenta en N s" si no obtuvo nada).

Por eso el resultado se guarda **30 minutos** en KV por periodo: varias personas abriendo el dashboard no gastan el cupo
de la API ni hacen esperar a nadie. Un resultado parcial se guarda solo 5 minutos. "Actualizar ahora" no recalcula si el
dato tiene menos de 1 minuto.

**Límites de Workers (plan gratuito):** 50 subrequests por invocación → el Worker usa como máximo `MAX_SUBREQUESTS`
(45 por defecto) peticiones a cloudFleet por refresco. Además el plan gratuito tiene 10 ms de CPU por petición; con
flotas grandes (muchas páginas que parsear) se puede exceder. En ese caso usa el plan Workers Paid (5 USD/mes:
más subrequests y CPU) y sube `MAX_SUBREQUESTS` en `wrangler.jsonc`. La espera por rate limit no consume CPU.

## Configuración

Requisitos: Node 18+ y una cuenta de Cloudflare.

```bash
npm install
npx wrangler login
```

### 1. Secreto con la API key

```bash
npx wrangler secret put CLOUDFLEET_API_KEY
```

(o en el panel: Workers & Pages → dashboard-flota → Settings → Variables and Secrets → Add → tipo *Secret*).
Nunca pongas la key en el código ni en `wrangler.jsonc`.

### 2. Namespace KV para la caché

```bash
npx wrangler kv namespace create CACHE
```

Copia el `id` que devuelve y reemplaza `REEMPLAZAR_CON_ID_DEL_NAMESPACE_KV` en `wrangler.jsonc`.
Si quitas el bloque `kv_namespaces`, el Worker funciona igual pero sin caché (cada visita consulta cloudFleet).

## Probar en local

```bash
cp .dev.vars.example .dev.vars     # y pon tu CLOUDFLEET_API_KEY (este archivo no se sube a git)
npx wrangler dev                    # http://localhost:8787
```

**Modo demo sin API key:** abre `http://localhost:8787/?demo=1`. El frontend carga `public/demo.json`, un ejemplo con
datos ficticios con exactamente la misma forma que `/api/resumen`. Se regenera con `npm run demo`
(usa la misma función de agregación del Worker sobre datos falsos).

**Pruebas sin red:** `npm run probar` (agregación, cliente con fetch simulado: paginación, 401, 429, topes; y que
`demo.json` tenga la misma forma que la agregación). Validar configuración: `npx wrangler deploy --dry-run`.

## Desplegar

```bash
npx wrangler deploy
```

O conecta el repositorio de GitHub en Cloudflare: Workers & Pages → Create → Import a repository → selecciona el repo;
comando de despliegue `npx wrangler deploy`. Recuerda configurar el secreto y el KV en ese Worker.

Quedará en `https://dashboard-flota.<tu-subdominio>.workers.dev` (las *preview URLs* están desactivadas).

## Proteger el acceso con Cloudflare Access (Zero Trust Free)

El dashboard muestra información interna; protégelo para que solo entren correos autorizados:

1. En el panel de Cloudflare abre **Zero Trust** (el plan Free cubre hasta 50 usuarios) y elige un nombre de equipo.
2. Forma rápida: Workers & Pages → dashboard-flota → Settings → Domains & Routes → en `workers.dev` activa
   **Cloudflare Access**. Esto crea una aplicación de Access para ese dominio.
3. O manualmente: Zero Trust → Access → Applications → Add an application → **Self-hosted**; dominio
   `dashboard-flota.<tu-subdominio>.workers.dev` (o tu dominio propio).
4. Crea una **política** *Allow* con regla **Emails** (lista de correos permitidos) o **Emails ending in** `@tuempresa.com`.
   Método de login: *One-time PIN* (código al correo, no requiere proveedor de identidad).
5. Prueba en una ventana privada: debe pedir el correo antes de mostrar el dashboard. La ruta `/api/*` queda protegida
   igual, porque Access cubre todo el dominio.

## Estructura

```
wrangler.jsonc          configuración del Worker (assets, KV, vars)
src/worker.js           rutas /api, caché, anti-estampida
src/cloudfleet.js       cliente de cloudFleet (rate limit, paginación)
src/agregados.js        agregación pura
public/                 index.html, app.js, estilos.css, demo.json, _headers (CSP y cabeceras de seguridad)
scripts/                generar-demo.mjs, probar-agregados.mjs, datos-falsos.mjs
```

## Notas sobre los datos

- Las fechas se agrupan por mes en hora de Colombia (UTC-5).
- El estado de las programaciones es texto (p. ej. "Ejecutada a tiempo"); se interpreta por palabras clave
  (ejecutada / a tiempo / tarde / vencida). Si el texto no indica oportunidad, el cumplimiento se muestra como "—".
- Rendimiento real = distancia recorrida / galones (ponderado); se ignoran cargas sin distancia. La unidad es la que
  tenga configurada cloudFleet (normalmente km/gal).
- El costo por km usa la distancia registrada en las cargas de combustible.
- Las listas de alertas traen máximo 50 filas; los conteos sí son totales.
- Gráficas: Chart.js 4.5.1 desde jsDelivr con SRI. Paleta validada para daltonismo en claro y oscuro
  (azul = mantenimiento, naranja = combustible, violeta = flota; rojo/amarillo solo para estados, siempre con texto).
