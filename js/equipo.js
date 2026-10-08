// Perfil del equipo: capacidades del navegador + mini-benchmark de la GPU (≈2.5 s, se guarda en caché).
// Con eso se decide, sala por sala, si corre en calidad máxima, reducida o si no está disponible.

const CLAVE = 'umbral.equipo.v2';
export const CALIDADES = [
  { nombre: 'baja', escala: 0.5, carga: 0.25 },
  { nombre: 'media', escala: 0.66, carga: 0.45 },
  { nombre: 'alta', escala: 0.82, carga: 0.7 },
  { nombre: 'máxima', escala: 1.0, carga: 1.0 },
];
// prueba de cuadro (ms a 1080p) a partir de la cual las salas pesadas bajan un nivel
export const MS_CUADRO_LENTO = 8;
// GFLOP/s medidos que pide cada nivel de carga para correr en calidad máxima a 60 fps a resolución nativa
export const CARGAS = {
  ligera: { gflops: 80, orden: 0 },
  media: { gflops: 300, orden: 1 },
  pesada: { gflops: 800, orden: 2 },
  extrema: { gflops: 1500, orden: 3 },
};

const FMA = /* wgsl */`
@group(0) @binding(0) var<storage, read_write> o: array<vec4f>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) g: vec3u) {
  var a = vec4f(f32(g.x) * 1e-7, 0.1, 0.2, 0.3);
  var b = a + 0.5; var c = a + 0.7; var d = a + 0.9;
  let m = vec4f(0.9999); let k = vec4f(0.0001);
  for (var i = 0u; i < 512u; i++) {
    a = fma(a, m, k); b = fma(b, m, k); c = fma(c, m, k); d = fma(d, m, k);
    a = fma(a, m, k); b = fma(b, m, k); c = fma(c, m, k); d = fma(d, m, k);
  }
  o[g.x & 1023u] = a + b + c + d;
}`;
const COPIA = /* wgsl */`
@group(0) @binding(0) var<storage, read> s: array<vec4f>;
@group(0) @binding(1) var<storage, read_write> o: array<vec4f>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) g: vec3u) {
  let i = g.x + g.y * 65535u * 256u;
  if (i >= arrayLength(&o)) { return; }
  o[i] = s[i] * 1.0001;
}`;

// Prueba de cuadro: un sombreador de fragmentos pesado (ruido fractal + pasos de raymarching) a 1920×1080 en rgba16float,
// como una sala exigente. Se mide cuánto tarda un cuadro completo en la GPU (mediana de 9). En el M5: ~1–2 ms.
const CUADRO = /* wgsl */`
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(p[i], 0.0, 1.0);
}
fn h(p: vec2f) -> f32 { return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453); }
fn ruido(p: vec2f) -> f32 {
  let i = floor(p); let f = fract(p); let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(h(i), h(i + vec2f(1.0, 0.0)), u.x), mix(h(i + vec2f(0.0, 1.0)), h(i + vec2f(1.0, 1.0)), u.x), u.y);
}
@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  var p = pos.xy * 0.004; var a = 0.0; var t = 0.0;
  for (var k = 0; k < 24; k++) {
    var q = p + vec2f(t, a); var amp = 0.5; var v = 0.0;
    for (var o = 0; o < 4; o++) { v += amp * ruido(q); q = q * 2.03 + 1.7; amp *= 0.5; }
    a += v * 0.05; t += 0.07 + v * 0.02;
  }
  return vec4f(a, t * 0.1, fract(a * 3.0), 1.0);
}`;
export async function medirCuadro(gpu) {
  const d = gpu.device;
  d.pushErrorScope('validation');                 // un fallo aquí no debe llegar a la pantalla de errores
  try { return await cuadro(d); } finally { await d.popErrorScope().catch(() => {}); }
}
async function cuadro(d) {
  const module = d.createShaderModule({ code: CUADRO });
  const pipe = await d.createRenderPipelineAsync({ layout: 'auto', vertex: { module, entryPoint: 'vs' }, fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba16float' }] }, primitive: { topology: 'triangle-list' } });
  const tex = d.createTexture({ size: [1920, 1080], format: 'rgba16float', usage: GPUTextureUsage.RENDER_ATTACHMENT });
  const view = tex.createView(), tiempos = [];
  for (let k = 0; k < 11; k++) {
    const e = d.createCommandEncoder();
    const p = e.beginRenderPass({ colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
    p.setPipeline(pipe); p.draw(3); p.end();
    const t0 = performance.now();
    d.queue.submit([e.finish()]); await d.queue.onSubmittedWorkDone();
    if (k >= 2) tiempos.push(performance.now() - t0);          // los dos primeros calientan
  }
  tex.destroy();
  tiempos.sort((a, b) => a - b);
  return +tiempos[tiempos.length >> 1].toFixed(2);
}

// Clase de GPU según lo que reporta el adaptador (WebGPU) o el renderer (WebGL2). Es una pista: decide lo medido.
export function claseGPU(info = {}, rendererGL = '') {
  const t = [info.vendor, info.architecture, info.device, info.description, rendererGL].filter(Boolean).join(' ').toLowerCase();
  if (info.isFallbackAdapter || /swiftshader|llvmpipe|softpipe|software|basic render/.test(t)) return { id: 'software', nombre: 'GPU por software' };
  if (/apple|metal/.test(t)) return { id: 'apple', nombre: 'Apple silicon' };
  if (/nvidia|geforce|quadro|radeon rx|radeon pro/.test(t)) return { id: 'dedicada', nombre: 'GPU dedicada' };
  if (/intel|iris|uhd|adreno|mali|powervr|qualcomm|radeon\(tm\) graphics|amd/.test(t)) return { id: 'integrada', nombre: 'GPU integrada' };
  return { id: 'desconocida', nombre: 'GPU' };
}

function firmaAdaptador(info) { return [info.vendor, info.architecture, info.device, info.description].filter(Boolean).join('|'); }

export function detectarBasico(gpu, rendererGL = '') {
  const ua = navigator.userAgent || '';
  const movil = /Android|iPhone|iPad|Mobile/i.test(ua) || (matchMedia('(pointer: coarse)').matches && !matchMedia('(pointer: fine)').matches);
  const p = {
    webgpu: !!gpu, movil,
    nucleos: navigator.hardwareConcurrency || 0,
    memoria: navigator.deviceMemory || null,       // los navegadores lo topan en 8 GB
    adaptador: gpu ? { vendor: gpu.info.vendor || '', arquitectura: gpu.info.architecture || '', descripcion: gpu.info.description || '' } : null,
    limites: null, features: gpu ? gpu.features : [],
    pantalla: { w: Math.round(screen.width * devicePixelRatio), h: Math.round(screen.height * devicePixelRatio) },
    clase: claseGPU(gpu ? gpu.info : {}, rendererGL),
  };
  if (gpu) {
    const L = gpu.device.limits;
    p.limites = {
      maxBufferSize: L.maxBufferSize, maxStorageBufferBindingSize: L.maxStorageBufferBindingSize,
      maxComputeWorkgroupStorageSize: L.maxComputeWorkgroupStorageSize, maxComputeInvocationsPerWorkgroup: L.maxComputeInvocationsPerWorkgroup,
      maxStorageBuffersPerShaderStage: L.maxStorageBuffersPerShaderStage,
    };
    p.firma = firmaAdaptador(gpu.info);
  }
  return p;
}

export function perfilGuardado(basico) {
  try {
    const j = JSON.parse(localStorage.getItem(CLAVE) || 'null');
    if (j && j.firma === basico.firma && j.nucleos === basico.nucleos && Date.now() - j.fecha < 30 * 864e5) return { ...basico, ...j, desdeCache: true };
  } catch {}
  return null;
}

// Mide FP32 (FMA) y ancho de banda de memoria. progreso(f) recibe 0..1.
export async function medir(gpu, basico, progreso = () => {}) {
  const d = gpu.device;
  const mod = d.createShaderModule({ code: FMA }), mod2 = d.createShaderModule({ code: COPIA });
  const pF = await d.createComputePipelineAsync({ layout: 'auto', compute: { module: mod, entryPoint: 'main' } });
  const pC = await d.createComputePipelineAsync({ layout: 'auto', compute: { module: mod2, entryPoint: 'main' } });
  const out = d.createBuffer({ size: 1024 * 16, usage: GPUBufferUsage.STORAGE });
  const bgF = d.createBindGroup({ layout: pF.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: out } }] });
  const MB = Math.min(128, Math.floor(basico.limites.maxStorageBufferBindingSize / (1 << 20)));
  const A = d.createBuffer({ size: MB << 20, usage: GPUBufferUsage.STORAGE }), B = d.createBuffer({ size: MB << 20, usage: GPUBufferUsage.STORAGE });
  const bgC = d.createBindGroup({ layout: pC.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: A } }, { binding: 1, resource: { buffer: B } }] });
  const WG = 4096, FLOP_POR_DISPATCH = WG * 256 * 512 * 8 * 4 * 2;   // hilos × iteraciones × fma(vec4) × 2 flop
  const nVec = (MB << 20) / 16, gC = Math.ceil(nVec / 256), gx = Math.min(gC, 65535), gy = Math.ceil(gC / gx);
  const lote = async (fn, n) => {
    const e = d.createCommandEncoder();
    for (let i = 0; i < n; i++) { const p = e.beginComputePass(); fn(p); p.end(); }
    d.queue.submit([e.finish()]); await d.queue.onSubmittedWorkDone();
  };
  const fma = (p) => { p.setPipeline(pF); p.setBindGroup(0, bgF); p.dispatchWorkgroups(WG); };
  const copia = (p) => { p.setPipeline(pC); p.setBindGroup(0, bgC); p.dispatchWorkgroups(gx, gy); };
  // calentamiento + calibración: lotes que duren ~60 ms
  await lote(fma, 1); await lote(copia, 1);
  let n = 1, t0 = performance.now();
  await lote(fma, n); let dtL = performance.now() - t0;
  n = Math.max(1, Math.min(256, Math.round(60 / Math.max(dtL, 0.5))));
  // FP32: 1.4 s
  let flops = 0, tiempo = 0; const T1 = 1400, ini = performance.now();
  while (performance.now() - ini < T1) {
    t0 = performance.now(); await lote(fma, n); tiempo += performance.now() - t0; flops += n * FLOP_POR_DISPATCH;
    progreso(Math.min(0.7, (performance.now() - ini) / T1 * 0.7));
  }
  const gflops = flops / (tiempo / 1000) / 1e9;
  // memoria: 0.7 s
  let bytes = 0; tiempo = 0; const ini2 = performance.now();
  while (performance.now() - ini2 < 700) {
    t0 = performance.now(); await lote(copia, 4); tiempo += performance.now() - t0; bytes += 4 * 2 * (MB << 20);
    progreso(0.7 + Math.min(0.3, (performance.now() - ini2) / 700 * 0.3));
  }
  const gbps = bytes / (tiempo / 1000) / 1e9;
  out.destroy(); A.destroy(); B.destroy();
  const msCuadro = await medirCuadro(gpu).catch(() => null);
  const r = { gflops: Math.round(gflops), gbps: Math.round(gbps), msCuadro, fecha: Date.now(), firma: basico.firma, nucleos: basico.nucleos };
  // si la ventana perdió el foco mientras medía (otra app usando la GPU), la cifra sale baja: no se guarda
  const limpio = !document.hidden;
  if (limpio) try { localStorage.setItem(CLAVE, JSON.stringify(r)); } catch {}
  progreso(1);
  return { ...basico, ...r, desdeCache: false };
}

// Nivel del equipo (un nombre para el perfil). El tope se llama «M5» por el Mac donde nació la galería.
export function esM5(p) {
  // Apple silicon de 10+ núcleos (M5 y superiores) con una medición rápida. Si otra app (un juego) le robó GPU
  // a la medición, basta la mitad del umbral: el Mac de casa siempre arranca en máxima.
  const g = p.gflops || 0;
  if (p.movil) return false;
  if (g >= CARGAS.extrema.gflops) return true;
  return !!(p.clase && p.clase.id === 'apple' && p.nucleos >= 10 && g >= CARGAS.extrema.gflops * 0.5);
}
export function nivel(p) {
  if (!p.webgpu) return { id: 'sin-webgpu', nombre: 'sin WebGPU' };
  const g = p.gflops || 0;
  if (p.clase && p.clase.id === 'software') return { id: 'basico', nombre: 'básico (por software)' };
  if (esM5(p)) return { id: 'm5', nombre: 'M5' };
  if (g >= CARGAS.pesada.gflops * 0.75) return { id: 'alto', nombre: 'alto' };
  if (g >= CARGAS.media.gflops * 0.75) return { id: 'medio', nombre: 'medio' };
  return { id: 'basico', nombre: 'básico' };
}

// Evalúa una sala para este equipo. Devuelve { ok, calidad (0..3), estado, motivo }
export function evaluar(sala, p, tieneFallbackGL) {
  const req = sala.requisitos || {};
  if (!p.webgpu) {
    if (tieneFallbackGL) return { ok: true, calidad: 0, estado: 'baja', motivo: 'sin WebGPU: versión WebGL2 simplificada' };
    return { ok: false, calidad: -1, estado: 'no disponible', motivo: 'necesita WebGPU' };
  }
  const L = p.limites || {};
  for (const f of req.features || []) if (!p.features.includes(f)) return { ok: false, calidad: -1, estado: 'no disponible', motivo: `necesita la extensión ${f}` };
  if (req.wg && L.maxComputeWorkgroupStorageSize < req.wg) return { ok: false, calidad: -1, estado: 'no disponible', motivo: `necesita ${req.wg / 1024} KB de memoria compartida por grupo` };
  const mbMin = (req.mb || 64) * CALIDADES[0].carga;
  if (L.maxBufferSize < mbMin * (1 << 20)) return { ok: false, calidad: -1, estado: 'no disponible', motivo: `necesita búferes de ${Math.ceil(mbMin)} MB` };
  if (!p.gflops) return { ok: true, calidad: 3, estado: 'sin medir', motivo: '' };
  if (esM5(p)) return { ok: true, calidad: 3, estado: 'perfecto', motivo: 'corre en calidad máxima' };
  const pide = CARGAS[sala.carga].gflops, f = p.gflops / pide;
  let q = f >= 1 ? 3 : f >= 0.6 ? 2 : f >= 0.33 ? 1 : f >= 0.15 ? 0 : -1;
  // la prueba de cuadro corrige al benchmark de cómputo: si llenar la pantalla cuesta caro, un nivel menos en salas pesadas
  if (q > 0 && p.msCuadro != null && p.msCuadro > MS_CUADRO_LENTO && CARGAS[sala.carga].orden >= 2) q--;
  if (p.clase && p.clase.id === 'software') q = Math.min(q, 0);
  if (q >= 0 && L.maxBufferSize < (req.mb || 64) * CALIDADES[q].carga * (1 << 20)) q = Math.max(0, q - 1);
  if (p.movil) q = Math.min(q, 1);
  if (q < 0) return { ok: false, calidad: -1, estado: 'no disponible', motivo: `necesita una GPU unas ${Math.ceil(pide / Math.max(1, p.gflops))} veces más rápida` };
  const estado = q === 3 ? 'perfecto' : 'calidad ' + CALIDADES[q].nombre;
  const motivo = q === 3 ? 'corre en calidad máxima' : `tu GPU da ~${Math.round(f * 100)} % de lo que pide en máxima`;
  return { ok: true, calidad: q, estado, motivo };
}

export const fmtG = (g) => (g >= 1000 ? (g / 1000).toFixed(1) + ' TFLOP/s' : g + ' GFLOP/s');
