// Inicialización WebGPU + captura de errores de shaders.
export async function initWebGPU(report) {
  if (!navigator.gpu) return null;
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) return null;
  const want = ['timestamp-query', 'float32-filterable', 'shader-f16'];
  const requiredFeatures = want.filter((f) => adapter.features.has(f));
  const L = adapter.limits;
  const requiredLimits = {
    maxStorageBufferBindingSize: L.maxStorageBufferBindingSize,
    maxBufferSize: L.maxBufferSize,
    maxComputeWorkgroupStorageSize: L.maxComputeWorkgroupStorageSize,
    maxComputeInvocationsPerWorkgroup: L.maxComputeInvocationsPerWorkgroup,
    maxStorageBuffersPerShaderStage: L.maxStorageBuffersPerShaderStage,
    maxStorageTexturesPerShaderStage: L.maxStorageTexturesPerShaderStage,
  };
  let device;
  try { device = await adapter.requestDevice({ requiredFeatures, requiredLimits }); }
  catch { device = await adapter.requestDevice({ requiredFeatures }).catch(() => null); }   // límites altos rechazados: los de serie
  if (!device) return null;
  device.addEventListener('uncapturederror', (e) => report('GPU: ' + e.error.message));
  device.lost.then((info) => report('Dispositivo GPU perdido: ' + info.message));
  const i0 = adapter.info || {};
  const info = { vendor: i0.vendor || '', architecture: i0.architecture || '', device: i0.device || '', description: i0.description || '',
    isFallbackAdapter: !!(i0.isFallbackAdapter || adapter.isFallbackAdapter) };
  return { adapter, device, features: requiredFeatures, info };
}

export function makeShader(device, code, label, report) {
  const m = device.createShaderModule({ code, label });
  m.getCompilationInfo().then((ci) => {
    for (const msg of ci.messages) {
      if (msg.type === 'error') report(`WGSL ${label}:${msg.lineNum}:${msg.linePos} ${msg.message}`);
    }
  });
  return m;
}

// Lectura asíncrona periódica de contadores GPU (u32) sin bloquear el frame.
export class Counters {
  constructor(device, n = 4, every = 10) {
    this.device = device; this.n = n; this.every = every; this.frame = 0;
    this.buf = device.createBuffer({ size: n * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
    this.read = device.createBuffer({ size: n * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    this.pending = false; this.copied = false; this.values = null;
  }
  clear(enc) { enc.clearBuffer(this.buf); }
  // llamar tras el dispatch que llena los contadores
  copy(enc) {
    this.frame++;
    if (this.pending || this.frame % this.every) return;
    enc.copyBufferToBuffer(this.buf, 0, this.read, 0, this.n * 4); this.copied = true;
  }
  after() {
    if (!this.copied) return;
    this.copied = false; this.pending = true;
    this.read.mapAsync(GPUMapMode.READ).then(() => {
      this.values = Array.from(new Uint32Array(this.read.getMappedRange()));
      this.read.unmap(); this.pending = false;
    }).catch(() => { this.pending = false; });
  }
  destroy() { this.buf.destroy(); this.read.destroy(); }
}

export const U = {
  uniform(device, size) { return device.createBuffer({ size, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }); },
  storage(device, size, extra = 0) { return device.createBuffer({ size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | extra }); },
  // grupos de trabajo 1D para N elementos con wg=256, repartido en 2D si hace falta
  grid1D(N, wg = 256) { const g = Math.ceil(N / wg); const x = Math.min(g, 32768); return [x, Math.ceil(g / x)]; },
};

// Pase de "desvanecido": multiplica el destino por una constante (estelas persistentes en hdr).
const FADE = /* wgsl */`
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(p[i], 0.0, 1.0);
}
@fragment fn fs() -> @location(0) vec4f { return vec4f(0.0); }`;
export function fadePipeline(device, format = 'rgba16float') {
  const module = device.createShaderModule({ code: FADE, label: 'fade' });
  const blend = { color: { srcFactor: 'zero', dstFactor: 'constant', operation: 'add' }, alpha: { srcFactor: 'zero', dstFactor: 'constant', operation: 'add' } };
  return device.createRenderPipeline({ layout: 'auto', vertex: { module, entryPoint: 'vs' }, fragment: { module, entryPoint: 'fs', targets: [{ format, blend }] }, primitive: { topology: 'triangle-list' } });
}
export const BLEND_ADD = { color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' }, alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' } };
// fuente + destino × constante: acumula y desvanece en un solo pase
export const BLEND_DECAY = { color: { srcFactor: 'one', dstFactor: 'constant', operation: 'add' }, alpha: { srcFactor: 'one', dstFactor: 'constant', operation: 'add' } };
