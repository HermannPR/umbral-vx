// Sala 5: vida artificial tipo Physarum (moho mucilaginoso): millones de agentes que siguen rastros químicos.
import { makeShader, U } from '../gpu.js';
import { FS_VERT, HASH, fmt, Governor } from '../util.js';

const COMMON = /* wgsl */`
struct Uni { size: vec4u, prm: vec4f, cur: vec4f, burst: vec4f, sp: array<vec4f, 3>, col: array<vec4f, 3> };
@group(0) @binding(0) var<uniform> u: Uni;
`;

const AGENT = COMMON + HASH + /* wgsl */`
@group(0) @binding(1) var<storage, read_write> ag: array<vec4f>;
@group(0) @binding(2) var trail: texture_2d<f32>;
@group(0) @binding(3) var<storage, read_write> dep: array<atomic<u32>>;

fn wrapi(q: vec2f) -> vec2i {
  let S = vec2f(u.size.xy);
  let w = q - floor(q / S) * S;
  return clamp(vec2i(w), vec2i(0), vec2i(u.size.xy) - 1);
}
fn sense(p: vec2f, a: f32, d: f32, w: vec3f) -> f32 {
  let q = p + vec2f(cos(a), sin(a)) * d;
  var v = dot(textureLoad(trail, wrapi(q), 0).rgb, w);
  if (u.cur.w > 0.0) { let dd = q - u.cur.xy; v += u.cur.w * exp(-dot(dd, dd) / (u.cur.z * u.cur.z)); }
  return v;
}

@compute @workgroup_size(256)
fn step(@builtin(global_invocation_id) g: vec3u) {
  let i = g.x + g.y * 32768u * 256u;
  if (i >= u.size.z) { return; }
  var a = ag[i];
  let s = u32(a.w);
  let P = u.sp[s];
  let rep = u.prm.w;
  let w = select(vec3f(-rep), vec3f(1.0), vec3<bool>(s == 0u, s == 1u, s == 2u));
  var p = a.xy; var ang = a.z;
  let F = sense(p, ang, P.y, w);
  let FL = sense(p, ang + P.x, P.y, w);
  let FR = sense(p, ang - P.x, P.y, w);
  var h = pcg(i * 2654435761u + u.size.w * 97u);
  let r = rnd(&h);
  if (F > FL && F > FR) { }
  else if (F < FL && F < FR) { ang += (r - 0.5) * 2.0 * P.z; }
  else if (FL > FR) { ang += P.z * (0.6 + 0.4 * r); }
  else { ang -= P.z * (0.6 + 0.4 * r); }
  var spd = P.w;
  if (u.burst.w > 0.0) {
    let d = p - u.burst.xy;
    if (dot(d, d) < u.burst.z * u.burst.z) { ang = atan2(d.y, d.x) + (r - 0.5) * 0.3; spd *= 6.0 * (1.0 - length(d) / u.burst.z) + 1.0; }
  }
  p += vec2f(cos(ang), sin(ang)) * spd;
  let S = vec2f(u.size.xy);
  p = p - floor(p / S) * S;
  let ip = wrapi(p);
  atomicAdd(&dep[u32(ip.y) * u.size.x + u32(ip.x)], 1u << (s * 10u));
  ag[i] = vec4f(p, ang, a.w);
}

@compute @workgroup_size(256)
fn spawn(@builtin(global_invocation_id) g: vec3u) {
  let j = g.x + g.y * 32768u * 256u;
  let start = u32(u.cur.x); let count = u32(u.cur.y);
  if (j >= count) { return; }
  let i = start + j;
  var h = pcg(i * 747796405u + u32(u.prm.x * 1000.0));
  let S = vec2f(u.size.xy);
  let c = S * 0.5;
  let rr = sqrt(rnd(&h)) * S.y * 0.42;
  let th = rnd(&h) * 6.2831853;
  let p = c + vec2f(cos(th), sin(th)) * rr;
  let ang = th + 3.14159265 + (rnd(&h) - 0.5) * 0.6;
  ag[i] = vec4f(p, ang, f32(i % 3u));
}
`;

const DIFFUSE = COMMON + /* wgsl */`
@group(0) @binding(1) var tin: texture_2d<f32>;
@group(0) @binding(2) var tout: texture_storage_2d<rgba16float, write>;
@group(0) @binding(3) var<storage, read_write> dep: array<atomic<u32>>;
@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) g: vec3u) {
  let W = i32(u.size.x); let H = i32(u.size.y);
  if (i32(g.x) >= W || i32(g.y) >= H) { return; }
  let p = vec2i(g.xy);
  var sum = vec3f(0.0);
  for (var dy = -1; dy <= 1; dy++) {
    for (var dx = -1; dx <= 1; dx++) {
      let q = vec2i((p.x + dx + W) % W, (p.y + dy + H) % H);
      sum += textureLoad(tin, q, 0).rgb;
    }
  }
  let c = textureLoad(tin, p, 0).rgb;
  let idx = g.y * u.size.x + g.x;
  let d = atomicExchange(&dep[idx], 0u);
  let dv = vec3f(f32(d & 1023u), f32((d >> 10u) & 1023u), f32((d >> 20u) & 1023u));
  let n = mix(c, sum / 9.0, u.prm.z) * u.prm.y + dv * u.prm.x;
  textureStore(tout, p, vec4f(min(n, vec3f(60000.0)), 1.0));
}
`;

const DRAW = FS_VERT + COMMON + /* wgsl */`
@group(0) @binding(1) var tr: texture_2d<f32>;
@fragment fn fs(i: VO) -> @location(0) vec4f {
  let t = textureLoad(tr, vec2i(i.pos.xy), 0).rgb;
  let k = 1.0 - exp(-t * 0.35);
  var col = u.col[0].rgb * k.x + u.col[1].rgb * k.y + u.col[2].rgb * k.z;
  col += vec3f(1.0) * pow(max(k.x * k.y + k.y * k.z + k.x * k.z, 0.0), 2.0) * 0.6;
  if (u.cur.w > 0.0) { let d = length(i.pos.xy - u.cur.xy); col += vec3f(0.5, 0.8, 1.0) * 0.4 * smoothstep(3.0, 0.0, abs(d - u.cur.z * 0.5)); }
  return vec4f(col + vec3f(0.003, 0.004, 0.008), 1.0);
}
`;

const PALS = [
  [[0.72, 0.82, 0.42], [0.86, 0.48, 0.3], [0.92, 0.89, 0.8]],
  [[0.95, 0.9, 0.8], [0.55, 0.28, 0.13], [0.28, 0.45, 0.5]],
  [[1.0, 0.35, 0.1], [1.0, 0.8, 0.3], [0.6, 0.1, 0.9]],
  [[0.9, 0.9, 1.0], [0.4, 0.5, 1.0], [0.9, 0.3, 0.5]],
];

function randomSpecies(chaos) {
  return Array.from({ length: 3 }, () => ({
    sa: 0.25 + Math.random() * 0.9, sd: 6 + Math.random() * 30, ra: 0.15 + Math.random() * 0.6, sp: (1.0 + Math.random() * 1.6) * (chaos ? 1.6 : 1),
  }));
}

export default class Physarum {
  static palettes = ['Liquen', 'Tinta', 'Brasa', 'Hielo'];
  static controls = { ls: 'mover cebo (atrae agentes)', rs: 'ángulo / alcance de sensores', trig: '− / + millones de agentes', a: 'estallido: dispersa la colonia' };
  static info = {
    title: 'Vida artificial',
    short: 'Physarum: millones de agentes',
    desc: 'Millones de agentes independientes huelen 3 puntos del rastro químico, giran, avanzan y depositan feromona; tres especies compiten y la red emerge sola.',
  };
  constructor(ctx) { this.ctx = ctx; this.post = { exposure: 1.0, bloom: 0.55, vignette: 0.55 }; }
  async init() {
    const { device: d, report, W, H } = this.ctx;
    this.W = W; this.H = H;
    const L = d.limits;
    this.MAX = Math.min(Math.max(1 << 20, Math.round((16 << 20) * (this.ctx.calidad ? this.ctx.calidad.carga : 1) / (1 << 20)) << 20), Math.floor(Math.min(L.maxStorageBufferBindingSize, L.maxBufferSize) / 16));
    let saved = 0; try { saved = +localStorage.getItem('lab.physN') || 0; } catch {}
    this.N = Math.min(this.MAX, saved || (4 << 20));
    this.ag = U.storage(d, this.MAX * 16);
    this.dep = U.storage(d, W * H * 4);
    const tex = () => d.createTexture({ size: [W, H], format: 'rgba16float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING });
    this.tr = [tex(), tex()]; this.trV = this.tr.map((t) => t.createView());
    this.ub = U.uniform(d, 64 + 96); this.ubSpawn = U.uniform(d, 64 + 96);
    const am = makeShader(d, AGENT, 'physarum-agent', report);
    this.pStep = await d.createComputePipelineAsync({ layout: 'auto', compute: { module: am, entryPoint: 'step' } });
    this.pSpawn = await d.createComputePipelineAsync({ layout: 'auto', compute: { module: am, entryPoint: 'spawn' } });
    this.pDiff = await d.createComputePipelineAsync({ layout: 'auto', compute: { module: makeShader(d, DIFFUSE, 'physarum-diffuse', report), entryPoint: 'main' } });
    const dm = makeShader(d, DRAW, 'physarum-draw', report);
    this.pDraw = await d.createRenderPipelineAsync({ layout: 'auto', vertex: { module: dm, entryPoint: 'vs' }, fragment: { module: dm, entryPoint: 'fs', targets: [{ format: 'rgba16float' }] } });
    const B = (p, ents) => d.createBindGroup({ layout: p.getBindGroupLayout(0), entries: ents.map(([b, r]) => ({ binding: b, resource: r })) });
    const ub = { buffer: this.ub };
    this.bgStep = [0, 1].map((k) => B(this.pStep, [[0, ub], [1, { buffer: this.ag }], [2, this.trV[k]], [3, { buffer: this.dep }]]));
    this.bgSpawn = B(this.pSpawn, [[0, { buffer: this.ubSpawn }], [1, { buffer: this.ag }]]);
    this.bgDiff = [0, 1].map((k) => B(this.pDiff, [[0, ub], [1, this.trV[k]], [2, this.trV[1 - k]], [3, { buffer: this.dep }]]));
    this.bgDraw = [0, 1].map((k) => B(this.pDraw, [[0, ub], [1, this.trV[k]]]));
    this.gov = new Governor({ min: 1 << 20, max: this.MAX, value: this.N, stepUp: (v) => v + (1 << 20), stepDown: (v) => v - (1 << 20), lowMs: 11.5, highMs: 14.5, every: 0.6 });
    this.cur = 0; this.frameN = 0; this.age = 0; this.morphT = 0;
    this.spec = randomSpecies(false); this.target = randomSpecies(false);
    this.bait = [W / 2, H / 2]; this.baitOn = 0; this.burst = null; this.saScale = 1; this.sdScale = 1;
    this.pendingSpawn = [0, this.N];
  }
  writeU(buf, extra) {
    const a = new ArrayBuffer(160), u = new Uint32Array(a), f = new Float32Array(a);
    u.set([this.W, this.H, this.N, this.frameN]);
    f.set([0.12, this.chaos ? 0.86 : 0.9, 0.35, 0.55], 4);
    f.set(extra?.cur ?? [...this.bait, this.H * 0.06, this.baitOn * 3], 8);
    f.set(this.burst ? [...this.burst, this.H * 0.18, 1] : [0, 0, 0, 0], 12);
    this.spec.forEach((s, i) => f.set([s.sa * this.saScale, s.sd * this.sdScale, s.ra, s.sp], 16 + i * 4));
    PALS[this.palette || 0].forEach((c, i) => f.set([...c, 1], 28 + i * 4));
    this.ctx.device.queue.writeBuffer(buf, 0, a);
  }
  frame(enc, dt, t) {
    const inp = this.ctx.input, ptr = this.ctx.pointer;
    this.age += dt; this.frameN++;
    // número de agentes: automático al principio, manual con gatillos
    const trig = inp.r2 - inp.l2;
    let want = this.N;
    if (Math.abs(trig) > 0.05) { this.manual = true; this.tgt = Math.max(1 << 19, Math.min(this.MAX, (this.tgt || this.N) + trig * dt * 3e6)); want = Math.round(this.tgt / 65536) * 65536; }
    else { this.tgt = this.N; if (!this.manual && this.age > 1.5 && this.age < 16 && this.gov.update(dt, this.ctx.perf.gpuMs ?? this.ctx.perf.frameMs)) want = this.gov.value; }
    if (want > this.N) { this.pendingSpawn = [this.N, want - this.N]; this.N = want; } else if (want < this.N) this.N = want;
    if (!this.manual) { try { localStorage.setItem('lab.physN', this.N); } catch {} }
    // morfología: deriva lenta de parámetros por especie
    this.morphT += dt * (this.chaos ? 4 : 1);
    if (this.morphT > 11) { this.morphT = 0; this.target = randomSpecies(this.chaos); }
    const k = 1 - Math.exp(-dt * (this.chaos ? 1.2 : 0.35));
    this.spec = this.spec.map((s, i) => { const g = this.target[i]; return { sa: s.sa + (g.sa - s.sa) * k, sd: s.sd + (g.sd - s.sd) * k, ra: s.ra + (g.ra - s.ra) * k, sp: s.sp + (g.sp - s.sp) * k }; });
    this.saScale = Math.max(0.3, Math.min(2.5, this.saScale * Math.exp(inp.rx * dt)));
    this.sdScale = Math.max(0.3, Math.min(3, this.sdScale * Math.exp(-inp.ry * dt)));
    // cebo y estallido
    const moving = Math.abs(inp.lx) + Math.abs(inp.ly) > 0.05;
    this.bait[0] = Math.max(0, Math.min(this.W, this.bait[0] + inp.lx * dt * this.H * 0.5));
    this.bait[1] = Math.max(0, Math.min(this.H, this.bait[1] + inp.ly * dt * this.H * 0.5));
    if (ptr.down) { this.bait = [ptr.x, ptr.y]; }
    this.baitOn = moving || ptr.down ? 1 : Math.max(0, this.baitOn - dt * 0.5);
    this.burst = null;
    if (inp.pressed.a) this.burst = [...this.bait];
    if (this.chaos && Math.random() < dt * 0.5) this.burst = [Math.random() * this.W, Math.random() * this.H];
    this.writeU(this.ub);
    const p = this.ctx.cpass(enc);
    if (this.pendingSpawn) {
      const [s0, cnt] = this.pendingSpawn; this.pendingSpawn = null;
      this.writeU(this.ubSpawn, { cur: [s0, cnt, 0, 0] });
      p.setPipeline(this.pSpawn); p.setBindGroup(0, this.bgSpawn); p.dispatchWorkgroups(...U.grid1D(cnt));
    }
    p.setPipeline(this.pStep); p.setBindGroup(0, this.bgStep[this.cur]); p.dispatchWorkgroups(...U.grid1D(this.N));
    p.setPipeline(this.pDiff); p.setBindGroup(0, this.bgDiff[this.cur]); p.dispatchWorkgroups(Math.ceil(this.W / 16), Math.ceil(this.H / 16));
    p.end();
    this.cur ^= 1;
    const rp = this.ctx.rpass(enc, { colorAttachments: [{ view: this.ctx.post.hdrView, loadOp: 'clear', clearValue: [0, 0, 0, 1], storeOp: 'store' }] });
    rp.setPipeline(this.pDraw); rp.setBindGroup(0, this.bgDraw[this.cur]); rp.draw(3); rp.end();
  }
  onKey(k) { if (k === 'r') { this.pendingSpawn = [0, this.N]; } }
  stats() {
    const fps = this.ctx.perf.fps, N = this.N;
    return [
      ['agentes', fmt.int(N), true],
      ['especies', '3 (compiten)'],
      ['lecturas de sensor / s', fmt.si(N * 3 * fps)],
      ['pasos de agente / s', fmt.si(N * fps)],
      ['celdas de rastro', fmt.int(this.W * this.H)],
      ['≈ memoria', fmt.si((N * 16 * 2 + N * 12 * 3 + this.W * this.H * 40) * fps, 'B/s')],
    ];
  }
  destroy() { [this.ag, this.dep, ...this.tr, this.ub, this.ubSpawn].forEach((x) => x.destroy()); }
}
