// Laboratorio M5: antesala, salas, transiciones, sonido, recorrido y ciclo de render.
import { initWebGPU } from './gpu.js';
import { Post } from './post.js';
import { fmt } from './util.js';
import { Input, enPanel } from './input.js';
import { leyenda } from './hud.js';
import { SALAS, ACTOS, MARCA, num, dibujarFirma, firmaSVG } from './salas.js';
import { detectarBasico, perfilGuardado, medir, nivel, evaluar, claseGPU, CALIDADES, fmtG } from './equipo.js';
import { Sonido } from './sonido.js';
import { Antesala } from './antesala.js';
import { Pista } from './pista.js';
import { Panel } from './panel.js';
import { Grabadora, puedeGrabar } from './grabar.js';

const $ = (id) => document.getElementById(id);
const canvas = $('c');
const params = new URLSearchParams(location.search);
const TEST = params.has('test');
const REC_S = +(params.get('recorrido') || 45);          // segundos por sala en el recorrido
// tope de fps: 60 por defecto para no competir con otras apps (un juego abierto); 120 se elige en el panel
// (se recuerda) o con ?fps=120. El video siempre graba a 60: Reels, TikTok y YouTube no pasan de ahí.
const FPS_OPCIONES = [60, 120];
let FPS_MAX = +(params.get('fps') || leerFps() || 60);
function leerFps() { try { const x = +localStorage.getItem('umbral.fps'); return FPS_OPCIONES.includes(x) ? x : 0; } catch { return 0; } }
function fijarFps(x) {
  x = +x; if (!FPS_OPCIONES.includes(x)) return;
  FPS_MAX = x; try { localStorage.setItem('umbral.fps', String(x)); } catch {}
  aviso(`Hasta ${x} fps`); sincronizarPanel();
}
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- errores en pantalla + log al servidor local ----------
const errores = [];
function report(msg) {
  msg = String(msg).slice(0, 400);
  if (errores.includes(msg)) return;
  errores.push(msg); if (errores.length > 6) errores.shift();
  $('errores').textContent = errores.join('\n');
  log({ type: 'error', msg });
  console.error(msg);
}
function log() {}   // versión estática: no hay servidor que reciba el registro
addEventListener('error', (e) => report('JS: ' + e.message + ' @' + (e.filename || '').split('/').pop() + ':' + e.lineno));
addEventListener('unhandledrejection', (e) => report('Promise: ' + (e.reason && (e.reason.stack || e.reason.message) || e.reason)));

// ---------- estado ----------
const perf = { fps: 60, frameMs: 16.7, gpuMs: null, hz: 60 };
const pointer = { x: 0, y: 0, down: false, dx: 0, dy: 0, moved: 0 };
const sonido = new Sonido();
// «tu música»: una canción propia (o el micrófono) que Señal escucha en lugar de la música generativa
const pista = sonido.pista = new Pista(sonido);
try { const v = parseFloat(localStorage.getItem('lab.vol')); if (v >= 0 && v <= 1) sonido.vol = v; } catch {}
const input = new Input({
  onConnect: (g) => { aviso('Mando conectado'); refrescarLeyenda(); despertar(); log({ type: 'pad', id: g.id }); },
  onDisconnect: () => { aviso('Mando desconectado'); refrescarLeyenda(); },
});
let ctx = null, current = null, idx = -1, modo = 'arranque', ocupado = false, pausado = false;
let pausaSala = false, framesSala = 0, panel = null, capturaPendiente = false;
const iSenal = SALAS.findIndex((S) => S.slug === 'senal');
let fichaOn = true;
try { fichaOn = localStorage.getItem('umbral.ficha') !== '0'; } catch {}
let recorrido = params.has('recorrido'), salaT = 0, time0 = performance.now(), ultimoUso = performance.now();
let clases = {}, glDemos = null, antesala = null;
let perfil = null, evals = [], calidadManual = null, gpuRef = null;
let reconstruir = false;         // la ventana cambió de tamaño con la antesala abierta: la sala se rehace al volver
const disponible = (i) => !!(evals[i] && evals[i].ok);
// preset de calidad que le toca a la sala i: el manual de la antesala o el medido (y lo que haya bajado el gobernador)
function nivelPara(i) {
  let q = calidadManual !== null ? Math.min(calidadManual, 3) : Math.max(0, evals[i].calidad);
  if (calidadManual === null && ajuste[i] != null) q = Math.min(q, ajuste[i]);
  return q;
}
document.title = MARCA.nombre;

// formato fijo (para grabar video): el lienzo tiene ese tamaño exacto y se ve encajado en la ventana
const FORMATOS = { pantalla: null, 'vertical 9:16 · 1080×1920': [1080, 1920], 'horizontal 16:9 · 1920×1080': [1920, 1080], 'cuadrado 1:1 · 1080×1080': [1080, 1080] };
let formato = null, formatoNombre = 'pantalla';
function canvasSize(escala = !ctx ? 1 : ctx.api === 'webgl2' ? ctx.escalaGL : ctx.calidad ? ctx.calidad.escala : 1) {
  if (formato) return formato.slice();
  const dpr = (window.devicePixelRatio || 1) * escala;
  return [Math.max(64, Math.round(innerWidth * dpr)), Math.max(64, Math.round(innerHeight * dpr))];
}
// ajusta el lienzo y el post-proceso a la escala de la calidad elegida
function aplicarTamaño() {
  const [W, H] = canvasSize();
  if (W === ctx.W && H === ctx.H) return;
  canvas.width = W; canvas.height = H; ctx.W = W; ctx.H = H;
  if (ctx.post) { ctx.post.destroy(); ctx.post = new Post(ctx.device, ctx.format, W, H); ctx.post.rpass = rpass; }
}
// perfil del equipo: caché o mini-benchmark; ?perfil=alto|medio|basico simula otros equipos
async function perfilar(forzar = false) {
  const basico = detectarBasico(gpuRef, ctx.rendererGL || '');
  const sim = { alto: 950, medio: 380, basico: 140, debil: 60 }[params.get('perfil')];
  if (!gpuRef) perfil = basico;
  else if (sim) perfil = { ...basico, gflops: sim, gbps: Math.round(sim / 20), simulado: true };
  else {
    perfil = !forzar && !params.has('medir') ? perfilGuardado(basico) : null;
    if (!perfil) {
      antesala.midiendo(0);
      perfil = await medir(gpuRef, basico, (f) => antesala.midiendo(f));
    }
  }
  if (params.get('perfil') === 'movil') perfil.movil = true;
  perfil.nivel = nivel(perfil);
  evals = SALAS.map((S) => evaluar(S, perfil, !!glClase(S.mod)));
  log({ type: 'perfil', nivel: perfil.nivel.id, clase: perfil.clase && perfil.clase.id, gflops: perfil.gflops, gbps: perfil.gbps, msCuadro: perfil.msCuadro, nucleos: perfil.nucleos, adaptador: perfil.adaptador, cache: !!perfil.desdeCache });
  antesala.equipo(perfil, evals);
}

async function boot() {
  for (let i = 0; i < 200 && (innerWidth < 2 || innerHeight < 2); i++) await espera(50);
  await document.fonts.ready.catch(() => {});
  if (params.has('sin-gpu')) { sinGPU('forzado con ?sin-gpu'); return; }
  const gpu = params.get('webgl') == null ? await initWebGPU(report).catch((e) => { report(e.message); return null; }) : null;
  gpuRef = gpu;
  // si la GPU se pierde a media visita (el proceso de la GPU se reinició), se recarga sola una o dos veces; si insiste, la página amable
  if (gpu) vigilarPerdida(gpu);
  let gl = null, rendererGL = '';
  if (!gpu) {
    gl = canvas.getContext('webgl2', { antialias: false, alpha: false, powerPreference: 'high-performance' });
    if (!gl) { sinGPU('ni WebGPU ni WebGL2'); return; }
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    rendererGL = String(gl.getParameter(dbg ? dbg.UNMASKED_RENDERER_WEBGL : gl.RENDERER) || '');
  }
  // WebGL2: la escala se decide una vez (las salas GL no cambian de resolución); por software va a la mitad
  const claseGL = gl ? claseGPU({}, rendererGL).id : '';
  const escalaGL = claseGL === 'software' ? 0.5 : claseGL === 'integrada' ? 0.75 : 1;
  const [W, H] = canvasSize(gl ? escalaGL : 1);
  canvas.width = W; canvas.height = H;
  if (gpu) {
    const context = canvas.getContext('webgpu');
    const format = navigator.gpu.getPreferredCanvasFormat();
    context.configure({ device: gpu.device, format, alphaMode: 'opaque' });
    ctx = { api: 'webgpu', device: gpu.device, context, format, W, H, pointer, perf, report, features: gpu.features, input, sonido, capa: $('capa') };
    ctx.post = new Post(gpu.device, format, W, H);
    setupTimestamps(gpu);
    ctx.cpass = cpass; ctx.rpass = rpass; ctx.post.rpass = rpass;
    ctx.gpuInfo = [gpu.info.vendor, gpu.info.architecture].filter(Boolean).join(' ');
  } else {
    ctx = { api: 'webgl2', gl, W, H, pointer, perf, report, input, sonido, capa: $('capa'), rendererGL, escalaGL };
    const m = await import('./gl/fallback.js');
    glDemos = m.makeDemos(ctx);
    aviso('Sin WebGPU: modo WebGL2 con 7 salas');
  }
  log({ type: 'boot', api: ctx.api, W, H, dpr: devicePixelRatio, features: ctx.features || [] });
  antesala = new Antesala({
    sonido, disponible,
    evaluacion: (i) => evals[i],
    onSala: (i) => { if (i === idx && current) cerrarAntesala(); else entrar(i); },
    onOpcion: (o) => {
      if (o === 'recorrido') { recorrido = !recorrido; if (recorrido) { if (idx < 0 || !current) entrar(vecina(-1, 1)); else cerrarAntesala(); } }
      else if (o === 'sonido') sonido.alternarMudo();
      else if (o === 'instrumentos') alternarInstrumentos();
      else if (o === 'calidad') { calidadManual = calidadManual === null ? 3 : calidadManual === 0 ? null : calidadManual - 1; }
      else if (o === 'medir') { perfilar(true).then(() => antesala.actualizar(estado())); }
      antesala.actualizar(estado());
    },
  });
  panel = new Panel(accPanel());
  aplicarFicha();
  $('f-x').addEventListener('click', () => fijarFicha(false));
  $('f-mini').addEventListener('click', () => fijarFicha(true));
  sonido.iniciar();
  abrirAntesala();
  await perfilar();
  const s = +params.get('sala');
  if (s >= 1 && s <= SALAS.length) await entrar(s - 1, true);
  else if (recorrido) await entrar(vecina(-1, 1));
  window.__lab.ready = true;
  requestAnimationFrame(frame);
}

function glClase(mod) {
  if (!glDemos) return null;
  const orden = ['galaxy', 'fractal', 'reaction', 'fluid', 'physarum', 'pathtracer', 'remix'];
  const k = orden.indexOf(mod);
  return k >= 0 ? glDemos[k] : null;
}
async function claseDe(i) {
  const mod = SALAS[i].mod;
  if (ctx.api !== 'webgpu') return glClase(mod);
  if (!clases[mod]) clases[mod] = (await import(`./demos/${mod}.js`)).default;
  return clases[mod];
}
// la sala disponible más cercana en esa dirección (el recorrido salta las que este equipo no puede correr)
function vecina(i, dir) { for (let k = 1; k <= SALAS.length; k++) { const j = (i + dir * k + SALAS.length * 2) % SALAS.length; if (disponible(j)) return j; } return i; }
const estado = () => ({ recorrido, sonido: !sonido.mudo, instrumentos: !!(panel && panel.instrumentosVisibles), pad: input.connected, calidad: calidadManual === null ? 'automática' : CALIDADES[calidadManual].nombre });

// ---------- timestamps GPU ----------
// ---------- gobernador de calidad ----------
// La medición elige el preset inicial de cada sala; cada sala ajusta su carga fina (partículas, pasos) y, si aun así
// el cuadro se pasa 1.5× de presupuesto durante 5 s, aquí se baja un preset entero (resolución + carga) y se recuerda.
// En el M5 nunca se dispara (58–60 fps). Con ?test o bajo automatización (grabador, pruebas) está apagado salvo ?gobernador.
const GOBERNADOR = (!TEST && !navigator.webdriver) || params.has('gobernador');
const ajuste = {};
let gobLento = 0;
function gobernarCalidad(rawDt) {
  // las salas que regulan su propia carga (el Mandelbrot profundo refina con presupuesto) no se rehacen desde aquí
  if (!GOBERNADOR || calidadManual !== null || ocupado || !current || current.autoRegula || !ctx.calidad || ctx.api !== 'webgpu' || ctx.calidad.nivel === 0 || salaT < 4) { gobLento = 0; return; }
  const presupuesto = 1000 / Math.min(FPS_MAX, 60);
  if (rawDt * 1000 > 250) return;                                  // un tirón aislado (cambio de app) no cuenta
  if (perf.frameMs > presupuesto * 1.5) gobLento += rawDt; else gobLento = Math.max(0, gobLento - rawDt * 0.5);
  if (gobLento < 5) return;
  gobLento = 0;
  ajuste[idx] = ctx.calidad.nivel - 1;
  aviso('Calidad ajustada · ' + CALIDADES[ajuste[idx]].nombre);
  log({ type: 'gobernador', sala: idx + 1, nivel: ajuste[idx], fps: +perf.fps.toFixed(1) });
  rehacerSala();                  // sin portada y en el mismo lugar
}

// GPU perdida (el proceso de la GPU se reinició, memoria, vigilante): se pide otro dispositivo en silencio y la sala
// se rehace en el mismo lugar, sin portada. Solo si se pierde 3 veces en un minuto, la página amable sin GPU.
let perdidas = [], recuperando = false, simulandoPerdida = false;
async function perdidaGPU(msg) {
  const ahora = Date.now();
  perdidas = perdidas.filter((t) => ahora - t < 60000); perdidas.push(ahora);
  log({ type: 'gpu-perdida', msg, n: perdidas.length });
  if (perdidas.length >= 3) { sinGPU('la GPU se perdió varias veces seguidas: ' + msg); return; }
  if (recuperando) return;
  recuperando = true;
  const vista = current && current.guardarVista ? (() => { try { return current.guardarVista(); } catch { return null; } })() : null;
  const i = idx, enSala = modo === 'sala';
  if (current) { try { current.destroy(); } catch {} current = null; }
  try {
    const gpu = await initWebGPU(report);
    gpuRef = gpu;
    vigilarPerdida(gpu);
    ctx.device = gpu.device; ctx.features = gpu.features;
    ctx.context.configure({ device: gpu.device, format: ctx.format, alphaMode: 'opaque' });
    if (ctx.post) { try { ctx.post.destroy(); } catch {} }
    ctx.post = new Post(gpu.device, ctx.format, ctx.W, ctx.H); ctx.post.rpass = rpass;
    ts = null; setupTimestamps(gpu);
    recuperando = false; ocupado = false;
    aviso('La GPU se reinició · sigo donde estabas');
    if (i >= 0) { if (enSala) await entrar(i, true, { silencioso: true, vista }); else { vistaPendiente = vista; reconstruir = true; } }
  } catch (e) {
    recuperando = false;
    report('recuperar GPU: ' + (e.message || e));
    sinGPU('la GPU se perdió y no volvió: ' + msg);
  }
}
function vigilarPerdida(gpu) {
  gpu.device.lost.then((info) => {
    if (info.reason === 'destroyed' && !simulandoPerdida) return;
    simulandoPerdida = false;
    perdidaGPU(info.message || 'dispositivo perdido');
  });
}
// rehace la sala actual sin portada, conservando la vista (cambio de tamaño, gobernador)
let vistaPendiente = null;
function rehacerSala() {
  if (idx < 0) return;
  const vista = current && current.guardarVista ? (() => { try { return current.guardarVista(); } catch { return null; } })() : null;
  return entrar(idx, true, { silencioso: true, vista });
}

// ---------- sin GPU: página amable con el video y las láminas ----------
function sinGPU(motivo) {
  document.body.classList.add('sin-gpu');
  const P = $('sin-gpu');
  P.querySelector('.marca').textContent = MARCA.nombre + ' · ' + MARCA.bajada;
  P.hidden = false;
  const v = $('sg-video');
  if (MARCA.video) { v.href = MARCA.video; v.textContent = 'Ver el recorrido en video'; }
  else { v.removeAttribute('href'); v.textContent = 'El video del recorrido llega pronto'; }
  $('sg-laminas').innerHTML = SALAS.map((S, i) => `<figure><img src="capturas/laminas/${num(i)}-${S.slug}.jpg" alt="${S.nombre}" loading="lazy"><figcaption><b>${num(i)}</b> ${S.nombre}</figcaption></figure>`).join('');
  $('sg-motivo').textContent = motivo;
  log({ type: 'sin-gpu', motivo });
  window.__lab.sinGPU = motivo; window.__lab.ready = true;
}

let ts = null, tsIdx = 0;
const MAXQ = 160;
function setupTimestamps(gpu) {
  if (!gpu.features.includes('timestamp-query')) return;
  const d = gpu.device;
  ts = {
    qs: d.createQuerySet({ type: 'timestamp', count: MAXQ }),
    resolve: d.createBuffer({ size: MAXQ * 8, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC }),
    read: d.createBuffer({ size: MAXQ * 8, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }),
    pending: false,
  };
}
function tsWrites() {
  if (!ts || tsIdx + 2 > MAXQ) return {};
  const i = tsIdx; tsIdx += 2;
  return { timestampWrites: { querySet: ts.qs, beginningOfPassWriteIndex: i, endOfPassWriteIndex: i + 1 } };
}
const cpass = (enc, desc = {}) => enc.beginComputePass({ ...desc, ...tsWrites() });
const rpass = (enc, desc) => enc.beginRenderPass({ ...desc, ...tsWrites() });

// ---------- salas ----------
async function entrar(i, primera = false, op = {}) {
  if (ocupado || !ctx) return;
  const sil = !!op.silencioso;    // rehacer la misma sala: sin portada, sin pausas, conservando la vista
  i = (i + SALAS.length) % SALAS.length;
  if (!disponible(i)) { aviso('No disponible en este equipo · ' + (evals[i] ? evals[i].motivo : '')); return; }
  ocupado = true;
  const S = SALAS[i], t0 = performance.now();
  if (!sil) mostrarPortada(i, primera);
  if (!primera && !sil) await espera(400);
  antesala && antesala.ocultar();
  if (current) { try { current.destroy(); } catch (e) { report(e.message); } current = null; }
  $('capa').innerHTML = '';
  idx = i; modo = 'sala'; reconstruir = false;
  errores.length = 0; $('errores').textContent = '';          // los errores de la sala anterior no se quedan pegados en esta
  const q = nivelPara(i);
  ctx.calidad = { nivel: q, ...CALIDADES[q] };
  if (ctx.api === 'webgpu') aplicarTamaño();
  document.documentElement.style.setProperty('--acento', S.acento);
  // pausa: una sala nueva siempre arranca andando (y con sonido, aunque la anterior estuviera en pausa)
  if (!sil) {
    pausaSala = false; mostrarPausa(); if (panel) panel.pintarBarra(true);
    if (sonido.pausado && !pausado) sonido.reanudar();
    sonido.partitura(S.slug);
    pista.enSala(S.slug === 'senal');
  }
  document.body.classList.remove('en-antesala');
  llenarFicha(i);                 // antes de init: las salas que se acomodan alrededor de la ficha la miden ya con su texto
  try {
    const D = await claseDe(i);
    const d = new D(ctx);
    d.palette = D.paletaInicial || 0; d.chaos = false; d.sala = S;
    await d.init();
    if (op.vista && d.restaurarVista) { try { await d.restaurarVista(op.vista); } catch (e) { report('restaurar vista: ' + e.message); } }
    if (ctx.device) await ctx.device.queue.onSubmittedWorkDone();
    current = d;
  } catch (e) {
    report('init ' + S.nombre + ': ' + (e.stack || e.message));
    // en vez de un lienzo negro: una nota tranquila y cómo seguir
    $('capa').innerHTML = `<div class="fallo"><div class="rotulo-t">Nº ${num(i)} · no arrancó</div><p>${S.nombre} no pudo arrancar en este equipo.</p>
      <div class="rotulo">${input.connected ? 'LB RB' : '← →'} otra sala · ${input.connected ? 'B' : 'esc'} antesala</div></div>`;
  }
  if (panel) panel.sala({ num: num(i), acto: ACTOS[S.acto].nombre, nombre: S.nombre, D: current && current.constructor, slug: S.slug });
  refrescarLeyenda();
  salaT = 0; perf.fps = 60; perf.gpuMs = null; gpuAcc = []; frameAcc = [];
  framesSala = 0;
  despertar();
  log({ type: 'enter', sala: i + 1, slug: S.slug });
  if (!sil) {
    await espera(Math.max(0, (primera ? 1500 : 1700) - (performance.now() - t0)));
    ocultarPortada();
    if (panel && !panel.abierto) panel.llamar();
  }
  ocupado = false;
}

let portadaRaf = 0;
function mostrarPortada(i, lento) {
  const S = SALAS[i], P = $('portada');
  $('p-num').innerHTML = `<b>Nº ${num(i)}</b> &nbsp;·&nbsp; ${ACTOS[S.acto].n} ${ACTOS[S.acto].nombre}`;
  $('p-nombre').textContent = S.nombre;
  $('p-lema').textContent = S.lema;
  P.classList.toggle('lento', false);
  P.style.setProperty('--acento', S.acento);
  P.classList.add('visible');
  const c = $('p-firma'), dpr = devicePixelRatio || 1, w = c.clientWidth;
  c.width = c.height = Math.round(w * dpr);
  const g = c.getContext('2d'), t0 = performance.now();
  cancelAnimationFrame(portadaRaf);
  const paso = () => {
    const p = Math.min(1, (performance.now() - t0) / 1300), e = 1 - Math.pow(1 - p, 3);
    g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, w);
    dibujarFirma(g, S.firma, { x: w / 2, y: w / 2, r: w * 0.46, color: S.acento, ancho: 0.9, alfa: 0.95, progreso: e, n: 2600 });
    if (p < 1) portadaRaf = requestAnimationFrame(paso);
  };
  paso();
}
function ocultarPortada() { const P = $('portada'); P.classList.add('lento'); P.classList.remove('visible'); }

function llenarFicha(i) {
  const S = SALAS[i], A = ACTOS[S.acto];
  $('f-num').textContent = 'Nº ' + num(i);
  $('f-acto').textContent = A.n + ' · ' + A.nombre;
  $('f-nombre').textContent = S.nombre;
  $('f-lema').textContent = S.lema;
  $('f-origen').textContent = 'origen · ' + S.origen;
  $('f-firma').innerHTML = firmaSVG(S.firma, 52);
  $('f-mini').textContent = num(i) + ' · ' + S.nombre;
  $('f-calidad').textContent = 'calidad ' + ctx.calidad.nombre + (calidadManual !== null ? ' (manual)' : '') + ' · carga ' + S.carga;
  refrescarLeyenda();
}
function nombreModo() {
  if (!current) return '';
  if (current.nombreModo) return current.nombreModo();
  const D = current.constructor;
  return D.palettes ? D.palettes[current.palette] : '';
}
let modoMostrado = '';
function refrescarLeyenda() {
  if (!current || idx < 0 || !panel) return;
  modoMostrado = nombreModo();
  panel.leyenda(leyenda(current.constructor, input.connected, modoMostrado));
  panel.modo(modoMostrado);
  lastHeld = null;                // los glifos nuevos vuelven a marcar lo que esté apretado
}
// ↑ ↓: modo de la sala (o preset de color si la sala no tiene modos)
function cambiarModo(dir) {
  if (!current) return;
  const D = current.constructor;
  let n = '';
  if (current.cambiarModo) n = current.cambiarModo(dir);
  else if (D.palettes) { const k = D.palettes.length; current.palette = (current.palette + dir + k) % k; n = D.palettes[current.palette]; }
  if (n) aviso('Modo · ' + n);
  refrescarLeyenda();
}
function alternarPausaSala() {
  pausaSala = !pausaSala; mostrarPausa(); if (panel) panel.pintarBarra(true);
  if (pausaSala) sonido.pausar(); else { sonido.reanudar(); last = performance.now(); }
  log({ type: 'pausa-sala', on: pausaSala });
}
// el aviso «En pausa» es de la sala: no se ve encima de la antesala (la pausa de la sala sigue ahí al volver)
function mostrarPausa() {
  const P = $('pausa');
  if (pausado) return;            // la pausa por foco tiene su propio texto
  if (pausaSala && modo === 'sala') { P.innerHTML = `<span>En pausa</span> ${input.connected ? '⧉' : 'espacio'} para seguir`; P.classList.add('visible'); }
  else P.classList.remove('visible');
}

function abrirAntesala() {
  if (!antesala) return;
  modo = 'antesala';
  document.body.classList.add('en-antesala');
  pista.enSala(false);
  antesala.mostrar(current ? idx : -1, estado());
  mostrarPausa();
  if (pausaSala && sonido.pausado && !pausado) sonido.reanudar();      // la antesala suena aunque la sala quedó en pausa
  sonido.partitura('antesala');
  despertar();
}
function cerrarAntesala() {
  if (!current) return;
  // si cambió la calidad o el tamaño de la ventana mientras estaba la antesala, la sala se rehace (con su portada)
  if (nivelPara(idx) !== ctx.calidad.nivel) return entrar(idx, true);
  if (reconstruir) { const vista = vistaPendiente; vistaPendiente = null; return vista ? entrar(idx, true, { silencioso: true, vista }) : rehacerSala(); }
  antesala.ocultar(); modo = 'sala';
  document.body.classList.remove('en-antesala');
  document.documentElement.style.setProperty('--acento', SALAS[idx].acento);
  llenarFicha(idx);               // p. ej. «(manual)» si se fijó la calidad en la antesala
  sonido.partitura(SALAS[idx].slug);
  pista.enSala(SALAS[idx].slug === 'senal');
  if (pausaSala) sonido.pausar();
  mostrarPausa();
  last = performance.now(); despertar();
}

let avisoT = 0;
function aviso(msg) {
  $('aviso').textContent = msg; $('aviso').classList.add('visible'); clearTimeout(avisoT);
  avisoT = setTimeout(() => $('aviso').classList.remove('visible'), 1900);
}
// T: los instrumentos viven en el panel (se abre en esa sección, o se cierra si ya estaban a la vista)
function alternarInstrumentos() {
  if (!panel) return;
  if (panel.instrumentosVisibles) panel.guis.instrumentos.close(); else panel.abrir('instrumentos');
  dibujarDatos();
}
// la ficha ya no se va sola: se cierra con su × (o desde el panel) y queda el rótulo chico para traerla de vuelta.
// Solo en el recorrido automático descansa sola, para que el video quede limpio.
function despertar() { ultimoUso = performance.now(); $('hud').classList.remove('reposo'); $('ficha').classList.remove('reposo'); }
function aplicarFicha() { document.body.classList.toggle('sin-ficha', !fichaOn); if (panel) panel.vista({ ficha: fichaOn }); }
function fijarFicha(v) { fichaOn = !!v; try { localStorage.setItem('umbral.ficha', fichaOn ? '1' : '0'); } catch {} aplicarFicha(); }
function alternarTexto() { const o = $('hud').classList.toggle('oculto'); document.body.classList.toggle('sin-texto', o); }

// ---------- vista: pantalla completa, imagen, enlace ----------
function pantallaCompleta() {
  const d = document, el = d.documentElement;
  if (d.fullscreenElement || d.webkitFullscreenElement) (d.exitFullscreen || d.webkitExitFullscreen).call(d);
  else { const f = el.requestFullscreen || el.webkitRequestFullscreen; if (f) Promise.resolve(f.call(el)).catch(() => aviso('Pantalla completa no disponible')); else aviso('Pantalla completa no disponible'); }
}
// la imagen se toma justo después de dibujar el cuadro (antes de que el navegador lo presente): sin texto, a la resolución del lienzo
function captura() { if (modo !== 'sala' || !current) { aviso('Entra a una sala para guardar la imagen'); return; } capturaPendiente = true; }
function guardarPNG() {
  const nombre = `umbral-${num(idx)}-${SALAS[idx].slug}.png`;
  canvas.toBlob((b) => {
    if (!b) { aviso('No pude guardar la imagen'); return; }
    const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = nombre;
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    aviso('Imagen guardada · ' + nombre);
  }, 'image/png');
}
// formato del lienzo: pantalla o uno fijo para video (la sala se rehace a ese tamaño)
function fijarFormato(nombre) {
  if (!(nombre in FORMATOS) || grabadora.activa) return;
  formatoNombre = nombre; formato = FORMATOS[nombre];
  document.body.classList.toggle('formato-fijo', !!formato);
  clearTimeout(resizeT); redimensionar();
  sincronizarPanel();
}
// grabar: lo que se ve y lo que suena, en tiempo real (G empieza y detiene)
const grabadora = new Grabadora();
let grabandoCancion = false, recT = 0;
function marcarRec() {
  const on = grabadora.activa;
  document.body.classList.toggle('grabando', on);
  let el = $('rec');
  if (!el) { el = document.createElement('div'); el.id = 'rec'; el.setAttribute('aria-live', 'polite'); document.body.append(el); }
  clearInterval(recT);
  const pinta = () => { const s = Math.floor(grabadora.segundos); el.textContent = `● grabando ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}${grabandoCancion && pista.dur ? ' / ' + Math.floor(pista.dur / 60) + ':' + String(Math.floor(pista.dur % 60)).padStart(2, '0') : ''} · G detiene`; };
  if (on) { pinta(); recT = setInterval(pinta, 500); }
  if (panel && panel.grabacion) panel.grabacion(on);
}
function grabar() {
  if (grabadora.activa) { grabadora.detener(); return; }
  if (modo !== 'sala' || !current) { aviso('Entra a una sala para grabar'); return; }
  if (!puedeGrabar()) { aviso('Este navegador no puede grabar video'); return; }
  sonido.iniciar(true);
  if (sonido.mudo) { sonido.alternarMudo(); sincronizarPanel(); }
  const nodos = [];
  if (sonido.salida) nodos.push(sonido.salida);
  if (pista.fuente === 'mic' && pista.mic) nodos.push(pista.mic);
  const S = SALAS[idx], d = new Date(), dd = (n) => String(n).padStart(2, '0');
  const nombre = `umbral-${S.slug}${S.slug === 'senal' && pista.activa && pista.fuente === 'archivo' ? '-' + pista.nombre : ''}-${d.getFullYear()}${dd(d.getMonth() + 1)}${dd(d.getDate())}-${dd(d.getHours())}${dd(d.getMinutes())}${dd(d.getSeconds())}`;
  try {
    grabadora.iniciar({ canvas, ac: sonido.ac, nodos, fps: Math.min(60, FPS_MAX), nombre, alTerminar: (r) => {
      grabandoCancion = false; pista.sinBucle = false; marcarRec();
      aviso(`Video guardado · ${r.archivo} · ${(r.bytes / 1e6).toFixed(1)} MB`);
      log({ type: 'video', ext: r.ext, dur: +r.dur.toFixed(1), mb: +(r.bytes / 1e6).toFixed(1), W: canvas.width, H: canvas.height });
    } });
  } catch (e) { aviso((e && e.message) || 'No pude grabar'); return; }
  marcarRec();
  if (!grabandoCancion) aviso('Grabando · G para detener');
}
// la canción completa: de 0:00 al final, sin repetir; el video se descarga solo al terminar
async function grabarCancion() {
  if (grabadora.activa) { grabadora.detener(); return; }
  if (pista.fuente !== 'archivo') { aviso('Primero suelta una canción'); return; }
  if (!(modo === 'sala' && idx === iSenal)) await entrar(iSenal);
  for (let k = 0; (ocupado || (formato && (canvas.width !== formato[0] || canvas.height !== formato[1]))) && k < 100; k++) await espera(100);
  pista.sinBucle = true; pista.pausar(); pista.buscar(0);
  grabandoCancion = true;
  grabar();
  if (!grabadora.activa) { grabandoCancion = false; pista.sinBucle = false; return; }
  aviso('Grabando la canción completa · G detiene');
  setTimeout(() => { if (grabadora.activa) pista.reproducir(0); }, 350);
}
pista.alTerminar = () => { if (grabandoCancion && grabadora.activa) setTimeout(() => grabadora.detener(), 800); };
// escenario: pantalla completa, sin panel ni texto (H lo devuelve)
function escenario() {
  if (panel) panel.cerrar();
  if (!$('hud').classList.contains('oculto')) alternarTexto();
  const d = document;
  if (!(d.fullscreenElement || d.webkitFullscreenElement)) pantallaCompleta();
}
function copiarEnlace() {
  const url = location.origin + location.pathname + (idx >= 0 && modo === 'sala' ? '?sala=' + (idx + 1) : '');
  const ok = () => aviso('Enlace copiado'), no = () => aviso(url);
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(ok, no); else no();
}

// ---------- tu música: soltar una canción en cualquier lado la lleva a Señal ----------
async function cargarCancion(f) {
  if (iSenal < 0) return;
  if (!disponible(iSenal)) { aviso('Señal no está disponible en este equipo'); return; }
  try {
    for (let k = 0; ocupado && k < 60; k++) await espera(100);
    if (!(modo === 'sala' && idx === iSenal)) await entrar(iSenal);
    for (let k = 0; ocupado && k < 60; k++) await espera(100);
    if (!(modo === 'sala' && idx === iSenal)) return;
    await pista.cargarArchivo(f);
    pista.enSala(true);
    aviso('Tu música · ' + pista.nombre);
    panel && panel.abrir('musica');
  } catch (e) { aviso(e && e.name === 'EncodingError' ? 'No pude leer ese audio' : (e && e.message) || 'No pude abrir ese audio'); }
}
let arrastres = 0;
const conArchivos = (e) => e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files');
addEventListener('dragenter', (e) => { if (!ctx || !conArchivos(e)) return; e.preventDefault(); arrastres++; $('soltar').classList.add('visible'); });
addEventListener('dragover', (e) => { if (!conArchivos(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
addEventListener('dragleave', (e) => { if (!conArchivos(e)) return; arrastres = Math.max(0, arrastres - 1); if (!arrastres) $('soltar').classList.remove('visible'); });
addEventListener('drop', (e) => {
  if (!conArchivos(e)) return;
  e.preventDefault(); arrastres = 0; $('soltar').classList.remove('visible');
  const f = e.dataTransfer.files && e.dataTransfer.files[0];
  if (f) cargarCancion(f);
});

// lo que el panel puede pedir
function accPanel() {
  return {
    alCambiar: () => { dibujarDatos(); antesala && antesala.actualizar(estado()); },
    pulsar: (b) => { input.inject = b; },
    pantallaCompleta, captura, copiarEnlace, escenario,
    formatos: Object.keys(FORMATOS), formato: (x) => fijarFormato(x),
    grabar, grabarCancion, grabando: () => grabadora.activa, puedeGrabar: puedeGrabar(),
    segundosRec: () => grabadora.segundos, pausada: () => pausaSala && modo === 'sala',
    ocultarTodo: alternarTexto,
    antesala: () => abrirAntesala(),
    sonido: (x) => { if (x === sonido.mudo) sonido.alternarMudo(); antesala && antesala.actualizar(estado()); },
    volumen: (x) => { sonido.vol = x; sonido.aplicarVolumen(0.1); try { localStorage.setItem('lab.vol', String(x)); } catch {} },
    ficha: (x) => fijarFicha(x),
    recorrido: (x) => { if (x !== recorrido) alternarRecorrido(); },
    calidad: (x) => {
      const q = CALIDADES.findIndex((c) => c.nombre === x);
      calidadManual = q < 0 ? null : q;
      if (modo === 'sala' && current && nivelPara(idx) !== ctx.calidad.nivel) rehacerSala().then(() => llenarFicha(idx));
      else if (current) llenarFicha(idx);
      antesala && antesala.actualizar(estado());
    },
    calidades: ['automática', ...CALIDADES.map((c) => c.nombre)],
    fpsOpciones: FPS_OPCIONES, fps: (x) => fijarFps(x),
    pista,
    senal: () => (current && idx === iSenal && modo === 'sala' ? current : null),
    cargarCancion,
    aviso,
  };
}
function sincronizarPanel() {
  if (!panel) return;
  panel.vista({ sonido: !sonido.mudo, volumen: sonido.vol, ficha: fichaOn, recorrido, calidad: calidadManual === null ? 'automática' : CALIDADES[calidadManual].nombre, formato: formatoNombre, fps: FPS_MAX });
}
function alternarRecorrido() {
  recorrido = !recorrido; aviso(recorrido ? `Recorrido · ${REC_S} s por sala` : 'Recorrido detenido');
  if (recorrido && modo === 'antesala') { if (current) cerrarAntesala(); else entrar(vecina(-1, 1)); }
  if (!recorrido) despertar();
  antesala && antesala.actualizar(estado()); sincronizarPanel();
}

// ---------- entrada ----------
// Esquema único para todas las salas (ver hud.js)
function manejarBotones() {
  const P = input.pressed;
  if (modo === 'antesala') {
    if ((P.start || P.b) && current) { cerrarAntesala(); return; }
    if (P.pausa) input.pressed.a = true;          // en la antesala, espacio también entra
    antesala.nav(input);
    return;
  }
  if (modo !== 'sala') return;
  if (P.start || P.b) { abrirAntesala(); return; }
  if (P.l1 || P.left) { entrar(vecina(idx, -1)); return; }
  if (P.r1 || P.right) { entrar(vecina(idx, 1)); return; }
  if (!current || ocupado) return;
  if (P.pausa) alternarPausaSala();
  if (pausaSala) { input.pressed = {}; return; }
  if (P.up) cambiarModo(1); else if (P.down) cambiarModo(-1);
  const D = current.constructor;
  if (P.x && D.palettes) { current.palette = (current.palette + 1) % D.palettes.length; aviso('Paleta · ' + D.palettes[current.palette]); refrescarLeyenda(); }
  if (P.y && !(D.controls && D.controls.y === null)) {
    // C / Y: una acción de un golpe (accionY devuelve qué pasó) o una alternancia (sí / no)
    if (current.accionY) { const n = current.accionY(); if (n) aviso(n); }
    else { current.chaos = !current.chaos; aviso((D.controls && D.controls.y) ? D.controls.y + (current.chaos ? ' · sí' : ' · no') : current.chaos ? 'Modo caos' : 'Modo sereno'); }
  }
  if (P.a) { input.rumble(); sonido.evento('a'); }
}

addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || !ctx) return;
  sonido.iniciar();
  const k = e.key.toLowerCase();
  despertar();
  if (!antesala) return;
  // dentro del panel solo cuentan «?» (cerrarlo) y esc (devolverle el foco a la sala)
  if (enPanel(e)) {
    if (e.key === '?' && !(e.target.matches && e.target.matches('input[type=search], input[type=text]'))) { e.preventDefault(); panel.cerrar(); }
    else if (e.key === 'Escape') { e.target.blur && e.target.blur(); }
    return;
  }
  if (/^[0-9]$/.test(k) && modo !== 'arranque') { const i = k === '0' ? 9 : +k - 1; if (i < SALAS.length) entrar(i); }
  else if (k === 'p') alternarRecorrido();
  else if (k === 'h') alternarTexto();
  else if (e.key === '?' || (e.key === '/' && e.shiftKey)) { if (modo === 'sala') panel.alternar(); }
  else if (k === 'v') pantallaCompleta();
  else if (k === 'o' && modo === 'sala') captura();
  else if (k === 'g' && modo === 'sala') grabar();
  // T (telemetría): instrumentos. Antes era I, pero I es parte de IJKL (stick derecho) y los abría al mirar hacia arriba
  else if (k === 't') { alternarInstrumentos(); antesala && antesala.actualizar(estado()); }
  else if (k === 'n') { aviso(sonido.alternarMudo() ? 'Sonido' : 'Silencio'); antesala && antesala.actualizar(estado()); sincronizarPanel(); }
  else if (current && current.onKey && modo === 'sala') current.onKey(k);
});
// el puntero va en píxeles del lienzo (no del CSS × dpr): con calidad < máxima el lienzo es más chico que la pantalla
const dpr = () => (canvas.width > 64 ? canvas.width / Math.max(1, innerWidth) : window.devicePixelRatio || 1);
addEventListener('pointerdown', (e) => { sonido.iniciar(); despertar(); if (enPanel(e) || (e.target.closest && e.target.closest('#ficha, #f-mini, #soltar'))) return; pointer.down = true; pointer.x = e.clientX * dpr(); pointer.y = e.clientY * dpr(); despertar(); });
addEventListener('pointerup', () => { pointer.down = false; });
addEventListener('pointermove', (e) => {
  document.body.classList.add('cursor');
  clearTimeout(pointer.hide); pointer.hide = setTimeout(() => document.body.classList.remove('cursor'), 2500);
  if (enPanel(e)) return;
  const x = e.clientX * dpr(), y = e.clientY * dpr();
  pointer.dx += x - pointer.x; pointer.dy += y - pointer.y; pointer.x = x; pointer.y = y; pointer.moved = performance.now();
  despertar();
});
// una ráfaga de resize (kiosco, pantalla completa) reconstruye la sala una sola vez, y nunca a media entrada
let resizeT = 0;
addEventListener('resize', () => {
  if (antesala) antesala.actualizar(estado());
  clearTimeout(resizeT); resizeT = setTimeout(redimensionar, 300);
});
function redimensionar() {
  if (ocupado) { resizeT = setTimeout(redimensionar, 300); return; }
  const [W, H] = canvasSize();
  if (!ctx || (W === ctx.W && H === ctx.H)) return;
  canvas.width = W; canvas.height = H; ctx.W = W; ctx.H = H;
  if (ctx.post) { ctx.post.destroy(); ctx.post = new Post(ctx.device, ctx.format, W, H); ctx.post.rpass = rpass; }
  if (current && modo === 'sala') rehacerSala();                 // sin portada y en el mismo lugar (antes volvía al inicio)
  else if (current) { vistaPendiente = current.guardarVista ? current.guardarVista() : null; reconstruir = true; }       // con la antesala abierta: se rehace al volver (sus búferes tienen el tamaño viejo)
}

// ---------- pausa al perder el foco (no competir con un juego u otras apps) ----------
function pausar() {
  if (pausado || TEST || grabadora.activa) return;           // grabando no se pausa: el video saldría cortado
  pausado = true; sonido.pausar(); $('pausa').innerHTML = '<span>En pausa</span> la ventana perdió el foco'; $('pausa').classList.add('visible'); log({ type: 'pausa' });
}
function reanudar() {
  if (!pausado) return;
  pausado = false; if (!(pausaSala && modo === 'sala')) sonido.reanudar(); $('pausa').classList.remove('visible'); mostrarPausa(); last = performance.now(); despertar();
}
addEventListener('blur', pausar);
addEventListener('focus', reanudar);
document.addEventListener('visibilitychange', () => (document.hidden ? pausar() : document.hasFocus() && reanudar()));

// ---------- bucle ----------
let last = performance.now(), hudT = 0, logT = 0, gpuAcc = [], frameAcc = [];
function median(a) { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; }

function frame(now) {
  requestAnimationFrame(frame);
  if (pausado) return;
  if (now - last < 1000 / FPS_MAX - 1.5) return;         // tope de fps (en 120 Hz se dibuja un frame sí y otro no)
  const rawDt = (now - last) / 1000; last = now;
  const dt = pausaSala ? 0 : Math.min(rawDt, 0.05);
  frameAcc.push(rawDt * 1000); if (frameAcc.length > 30) frameAcc.shift();
  perf.frameMs = frameAcc.reduce((a, b) => a + b, 0) / frameAcc.length;
  perf.fps = 1000 / perf.frameMs;
  input.poll();
  if (input.lastPadUse > now - 200 || Math.hypot(input.lx, input.ly, input.rx, input.ry) > 0.2) despertar();
  if (antesala) manejarBotones();
  if (modo !== 'sala') { input.lx = input.ly = input.rx = input.ry = input.l2 = input.r2 = 0; input.pressed = {}; input.held = {}; }
  actualizarGlifos();
  if (!current || modo === 'antesala' || (pausaSala && !capturaPendiente)) return;
  framesSala++;
  const t = (now - time0) / 1000;
  salaT += dt;
  ctx.recorrido = recorrido; ctx.salaT = salaT;
  try {
    if (ctx.api === 'webgpu') {
      const enc = ctx.device.createCommandEncoder();
      tsIdx = 0;
      current.frame(enc, dt, t);
      ctx.post.run(enc, ctx.context.getCurrentTexture().createView(), current.post || {}, t);
      let copied = false; const nq = tsIdx;
      if (ts && nq > 0) {
        enc.resolveQuerySet(ts.qs, 0, nq, ts.resolve, 0);
        if (!ts.pending) { enc.copyBufferToBuffer(ts.resolve, 0, ts.read, 0, nq * 8); copied = true; }
      }
      ctx.device.queue.submit([enc.finish()]);
      if (capturaPendiente) { capturaPendiente = false; guardarPNG(); }
      if (copied) {
        ts.pending = true;
        ts.read.mapAsync(GPUMapMode.READ, 0, nq * 8).then(() => {
          const a = new BigUint64Array(ts.read.getMappedRange(0, nq * 8));
          let lo = 0n, hi = 0n; // Metal marca el inicio al encolar: se usa el intervalo total del frame
          for (let i = 0; i < nq; i++) { const v = a[i]; if (v === 0n) continue; if (lo === 0n || v < lo) lo = v; if (v > hi) hi = v; }
          ts.read.unmap(); ts.pending = false;
          const ms = Number(hi - lo) / 1e6;
          if (ms > 0 && ms < 1000) { gpuAcc.push(ms); if (gpuAcc.length > 15) gpuAcc.shift(); perf.gpuMs = median(gpuAcc); }
        }).catch(() => { ts.pending = false; });
      }
    } else { current.frame(dt, t); if (capturaPendiente) { capturaPendiente = false; guardarPNG(); } }
  } catch (e) { report('frame: ' + (e.stack || e.message)); }
  if (current.after) current.after();
  if (pausaSala) return;
  if (panel) panel.tick();

  // sonido: señales de la sala + movimiento general de la entrada
  const mov = Math.min(1, Math.hypot(input.lx, input.ly) * 0.6 + Math.hypot(input.rx, input.ry) * 0.6 + (now - pointer.moved < 200 ? 0.5 : 0) + (pointer.down ? 0.4 : 0));
  sonido.señales({ mov, ...(current.sonido || {}) }, dt);

  if (recorrido && !ocupado && salaT > REC_S) entrar(vecina(idx, 1));
  $('recorrido').classList.toggle('activo', recorrido);
  if (recorrido) {
    $('rec-barra').style.width = Math.min(100, (salaT / REC_S) * 100) + '%';
    const sig = vecina(idx, 1);
    $('rec-sig').textContent = 'a continuación · ' + num(sig) + ' ' + SALAS[sig].nombre;
    $('rec-sig').classList.toggle('visible', salaT > REC_S - 7);
  }
  if (recorrido && salaT > 12 && salaT < REC_S - 7) { $('hud').classList.add('reposo'); $('ficha').classList.add('reposo'); }
  else if (recorrido && salaT <= 12) despertar();

  gobernarCalidad(rawDt);
  if (!current) return;           // el gobernador pudo rehacer la sala: entrar() ya la vació y la nueva aún no está lista
  hudT += rawDt; logT += rawDt;
  if (hudT > 0.25) { hudT = 0; dibujarDatos(); sincronizarPanel(); }
  if (logT > 3) {
    logT = 0;
    log({ type: 'stats', sala: idx + 1, fps: +perf.fps.toFixed(1), gpuMs: perf.gpuMs && +perf.gpuMs.toFixed(2), stats: (current.stats ? current.stats() : []).filter((r) => r !== '-').map((r) => r.slice(0, 2)) });
  }
}

let lastHeld = null;
function actualizarGlifos() {
  const h = Object.keys(input.held).sort().join(',') + (input.l2 > 0.1 ? ',l2' : '') + (input.r2 > 0.1 ? ',r2' : '') +
    (Math.hypot(input.lx, input.ly) > 0.2 ? ',ls' : '') + (Math.hypot(input.rx, input.ry) > 0.2 ? ',rs' : '');
  if (h === lastHeld) return; lastHeld = h;
  const on = new Set(h.split(','));
  document.querySelectorAll('#panel .g[data-b]').forEach((el) => el.classList.toggle('on', el.dataset.b.split(' ').some((b) => on.has(b))));
}

function dibujarDatos() {
  if (!current) return;           // la sala se está rehaciendo
  if (nombreModo() !== modoMostrado) refrescarLeyenda();
  const rows = current.stats ? current.stats() : [];
  const big = rows.find((r) => r !== '-' && r[2]);
  const lectura = current.lectura ? current.lectura() : big ? `${big[1]} ${big[0]}` : '';
  $('f-dato').textContent = [lectura, perf.fps.toFixed(0) + ' fps'].filter(Boolean).join('   ·   ');
  if (!panel || !panel.instrumentosVisibles) return;
  const D = current.constructor, g = [];
  const row = (k, v, c = '') => `<div class="r ${c}"><span>${k}</span><b>${v}</b></div>`;
  g.push(`<div class="tit">${ctx.api === 'webgpu' ? 'WebGPU' : 'WebGL2'}${ctx.gpuInfo ? ' · ' + ctx.gpuInfo : ''}</div>`);
  g.push(row('fps', perf.fps.toFixed(0), 'dest'));
  g.push(row('ms / frame', perf.frameMs.toFixed(2)));
  if (perf.gpuMs != null) g.push(row('GPU ms / frame', perf.gpuMs.toFixed(2)));
  g.push(row('resolución', `${ctx.W} × ${ctx.H}`));
  g.push(row('calidad', ctx.calidad ? ctx.calidad.nombre : '—'));
  if (perfil && perfil.gflops) g.push(row('equipo', `${perfil.nivel.nombre} · ${fmtG(perfil.gflops)}`));
  g.push('<div class="sep"></div>');
  for (const r of rows) g.push(r === '-' ? '<div class="sep"></div>' : row(r[0], r[1], r[2] ? 'dest' : ''));
  g.push('<div class="sep"></div>');
  if (D.palettes) g.push(row('paleta', D.palettes[current.palette]));
  if (current.chaos) g.push(row('modo', 'caos'));
  g.push(row('recorrido', recorrido ? `${Math.max(0, REC_S - salaT).toFixed(0)} s` : 'detenido'));
  panel.instrumentos(g.join(''));
}

// ---------- ganchos de prueba (herramientas/capturar.mjs) ----------
window.__lab = {
  ready: false, count: SALAS.length, sinGPU: null, slugs: SALAS.map((S) => S.slug),
  async go(i) { if (i === 0) { abrirAntesala(); return; } if (modo === 'antesala' && i - 1 === idx && current) { await cerrarAntesala(); return; } await entrar(i - 1); },
  info() { return { modoVista: modo, ocupado, pausada: pausaSala, frames: framesSala, modo: nombreModo(), sel: antesala && antesala.sel, ayuda: !!(panel && panel.abierto), musica: pista.fuente, slug: modo === 'antesala' ? 'antesala' : SALAS[idx].slug, perf: { fps: +perf.fps.toFixed(1), gpuMs: perf.gpuMs && +perf.gpuMs.toFixed(2) }, calidad: ctx && ctx.calidad && ctx.calidad.nombre, W: ctx && ctx.W, errores,
    audio: { pausado: !!sonido.pausado, estado: sonido.ac ? sonido.ac.state : 'sin contexto', partitura: sonido.actual ? sonido.actual.nombre : '' } }; },
  perfil() { return { perfil, evals, api: ctx && ctx.api, rendererGL: ctx && ctx.rendererGL, escalaGL: ctx && ctx.escalaGL, ajuste }; },
  hud(v) { $('hud').classList.toggle('oculto', !v); $('capa').style.visibility = v ? '' : 'hidden'; },
  despertar,
  pulsar(b) { input.inject = b; },
  panel: () => panel,
  pista,
  formato: (x) => fijarFormato(x), grabar: () => grabar(), grabarCancion: () => grabarCancion(), grabadora,
  simularPerdidaGPU() { simulandoPerdida = true; ctx.device.destroy(); },
  gobernar() { gobLento = 99; },
};

export { fmt };
boot().catch((e) => report('boot: ' + (e.stack || e.message)));
