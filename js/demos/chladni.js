// Sala «Chladni»: arena sobre una placa cuadrada que vibra en el modo (m, n).
// Idea de Math Visual Lab (figuras de Chladni). Cada grano salta en proporción a cuánto se mueve la placa
// donde está; en las líneas nodales no se mueve, así que ahí se queda. La placa suena en su frecuencia.
import { makeShader, U } from '../gpu.js';
import { HASH, FS_VERT, fmt, zonaLibre } from '../util.js';

const MODOS = [[1, 2], [1, 3], [2, 3], [1, 4], [3, 4], [2, 5], [1, 5], [3, 5], [4, 5], [2, 7], [3, 7], [5, 6], [4, 7], [1, 6], [5, 8], [3, 8], [6, 7]];
const frec = (m, n) => 98 * Math.sqrt((m * m + n * n) / 5);

const COMUN = HASH + /* wgsl */`
struct Uni {
  a: vec4f,   // W, H, t, paleta
  b: vec4f,   // placa x0, y0, lado (px), N
  m: vec4f,   // m0, n0, m1, n1
  c: vec4f,   // mezcla, amplitud, ganancia, signo
  d: vec4u,   // semilla, reiniciar, 0, 0
};
const PI = 3.14159265;
fn modo(m: f32, n: f32, p: vec2f, sg: f32) -> f32 {
  return cos(n * PI * p.x) * cos(m * PI * p.y) + sg * cos(m * PI * p.x) * cos(n * PI * p.y);
}
fn placa(p: vec2f) -> f32 {
  return mix(modo(u.m.x, u.m.y, p, u.c.w), modo(u.m.z, u.m.w, p, u.c.w), u.c.x);
}
`;

const SIM = COMUN.replace('const PI', '@group(0) @binding(0) var<uniform> u: Uni;\nconst PI') + /* wgsl */`
@group(0) @binding(1) var<storage, read_write> pos: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> acc: array<atomic<u32>>;
fn gauss2(s: ptr<function, u32>) -> vec2f {
  let a = max(rnd(s), 1e-7); let b = rnd(s);
  let r = sqrt(-2.0 * log(a));
  return vec2f(cos(6.2831853 * b), sin(6.2831853 * b)) * r;
}
@compute @workgroup_size(256)
fn sim(@builtin(global_invocation_id) g: vec3u) {
  let i = g.x + g.y * 32768u * 256u;
  if (i >= u32(u.b.w)) { return; }
  var s = pcg(i * 2654435761u + u.d.x);
  var P = pos[i];
  if (u.d.y == 1u) { P = vec4f(rnd(&s), rnd(&s), rnd(&s), 0.0); }
  var p = P.xy;
  for (var k = 0u; k < 3u; k++) {
    let a = abs(placa(p));
    // el grano rebota con la placa: paso aleatorio proporcional a la amplitud local
    p += gauss2(&s) * (a * u.c.y * 0.0065 + 0.0014);
    // y un pequeño deslizamiento cuesta abajo de |u| (afila las líneas)
    let e = 0.0015;
    let gx = abs(placa(p + vec2f(e, 0.0))) - abs(placa(p - vec2f(e, 0.0)));
    let gy = abs(placa(p + vec2f(0.0, e))) - abs(placa(p - vec2f(0.0, e)));
    p -= vec2f(gx, gy) / (2.0 * e) * 0.00006 * u.c.y;
    p = clamp(p, vec2f(0.001), vec2f(0.999));
  }
  pos[i] = vec4f(p, P.z, P.w);
  let q = u.b.xy + p * u.b.z;
  let W = u32(u.a.x);
  let k = (u32(q.y) * W + u32(q.x));
  atomicAdd(&acc[k], u32(256.0 * (0.6 + 0.8 * P.z)));
}
`;

const DRAW = FS_VERT + COMUN.replace('const PI', '@group(0) @binding(0) var<uniform> u: Uni;\nconst PI') + /* wgsl */`
@group(0) @binding(1) var<storage, read_write> acc: array<u32>;
@fragment fn fs(i: VO) -> @location(0) vec4f {
  let px = vec2u(i.pos.xy);
  let k = px.y * u32(u.a.x) + px.x;
  let dens = f32(acc[k]) / 256.0;
  acc[k] = 0u;
  let q = (i.pos.xy - u.b.xy) / u.b.z;
  var arena = vec3f(0.85, 0.74, 0.55); var metal = vec3f(0.032, 0.031, 0.029);
  let pal = u.a.w;
  if (pal > 0.5 && pal < 1.5) { arena = vec3f(0.95, 0.95, 0.93); metal = vec3f(0.035, 0.035, 0.04); }
  else if (pal > 1.5 && pal < 2.5) { arena = vec3f(0.12, 0.09, 0.07); metal = vec3f(0.55, 0.32, 0.18); }
  else if (pal > 2.5) { arena = vec3f(0.85, 0.92, 1.0); metal = vec3f(0.03, 0.07, 0.16); }
  if (q.x < 0.0 || q.y < 0.0 || q.x > 1.0 || q.y > 1.0) {
    return vec4f(0.0, 0.0, 0.0, 1.0);
  }
  // placa: metal con un brillo que tiembla con la vibración (estroboscopio lento)
  let v = placa(q);
  let e = 0.002;
  let gx = placa(q + vec2f(e, 0.0)) - v; let gy = placa(q + vec2f(0.0, e)) - v;
  let n = normalize(vec3f(-gx, -gy, e * 6.0 / max(0.15, u.c.y)));
  let luz = pow(max(0.0, dot(n, normalize(vec3f(-0.4, -0.5, 1.0)))), 6.0);
  var col = metal * (0.85 + 0.9 * luz * (0.5 + 0.5 * sin(u.a.z * 7.0)) * u.c.y);
  // granos: saturación suave
  let a = 1.0 - exp(-dens * u.c.z);
  col = mix(col, arena * (0.7 + 0.5 * a), a);
  // bisel del borde
  let b = min(min(q.x, 1.0 - q.x), min(q.y, 1.0 - q.y)) * u.b.z;
  col *= mix(0.6, 1.0, smoothstep(0.0, 3.0, b));
  return vec4f(col, 1.0);
}
`;

export default class Chladni {
  static palettes = ['Arena y grafito', 'Sal', 'Cobre', 'Cianotipia'];
  static controls = { ls: 'elegir (m, n) a mano', rs: '', trig: '− / + amplitud', a: 'golpe de arco', y: 'esparcir la arena' };
  static info = { title: 'Chladni', desc: '' };
  constructor(ctx) { this.ctx = ctx; this.post = { exposure: 1.0, bloom: 0.08, vignette: 0.45, lift: [0.024, 0.021, 0.017], grain: 0.03 }; this.sonido = { freq: frec(3, 5), amp: 0.5 }; }
  async init() {
    const { device: d, report, W, H } = this.ctx;
    const q = this.ctx.calidad ? this.ctx.calidad.carga : 1;
    this.N = Math.round((1.6e6 * q * (W * H) / 5.7e6 + 1.4e5) / 256) * 256;
    this.pos = U.storage(d, this.N * 16); this.acc = U.storage(d, W * H * 4); this.u = U.uniform(d, 80);
    const sm = makeShader(d, SIM, 'chladni-sim', report), dm = makeShader(d, DRAW, 'chladni-draw', report);
    this.pSim = await d.createComputePipelineAsync({ layout: 'auto', compute: { module: sm, entryPoint: 'sim' } });
    this.pDraw = await d.createRenderPipelineAsync({ layout: 'auto', vertex: { module: dm, entryPoint: 'vs' }, fragment: { module: dm, entryPoint: 'fs', targets: [{ format: 'rgba16float' }] } });
    this.bgSim = d.createBindGroup({ layout: this.pSim.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: this.u } }, { binding: 1, resource: { buffer: this.pos } }, { binding: 2, resource: { buffer: this.acc } }] });
    this.bgDraw = d.createBindGroup({ layout: this.pDraw.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: this.u } }, { binding: 1, resource: { buffer: this.acc } }] });
    this.k = 7; this.prev = MODOS[7]; this.cur = MODOS[7]; this.mezcla = 1; this.amp = 1; this.base = 0.55; this.reset = true;
    this.modoT = 0; this.seed = 1; this.sg = -1; this.ultNav = 0;
    // la placa: tan grande como antes (74 % del alto), pero sin meterse bajo la ficha en ventanas chicas
    this.geo = zonaLibre(1, { arriba: 64, extraAbajo: 34, maxH: innerHeight * 0.74, centroX: innerWidth / innerHeight > 1.4 ? 0.62 : 0.5 });
    this.rotulo();
  }
  rotulo() {
    const [m, n] = this.cur, { x: x0, y: y0, w: S } = this.geo;
    this.ctx.capa.innerHTML = `<div style="position:absolute;left:44px;top:38px;max-width:${Math.max(220, x0 - 90)}px">
      <div class="rotulo-t" style="margin-bottom:10px">placa cuadrada, bordes libres</div>
      <div style="font:italic 400 16px/1.5 var(--serif);color:var(--papel-2)">u = cos nπx · cos mπy ${this.sg < 0 ? '−' : '+'} cos mπx · cos nπy</div></div>
      <div id="ch-modo" style="position:absolute;left:${x0}px;top:${y0 + S + 18}px;width:${S}px;display:flex;justify-content:space-between" class="rotulo">
      <span>modo (m, n) = (${m}, ${n})</span><span>${frec(m, n).toFixed(1)} Hz</span></div>`;
  }
  cambiar(mn) {
    if (mn[0] === mn[1]) return;
    this.prev = this.mezcla < 1 ? this.prev : this.cur; this.cur = mn; this.mezcla = 0; this.modoT = 0;
    this.amp = Math.max(this.amp, 0.95);
    this.ctx.sonido.evento('arco');
    this.rotulo();
  }
  nombreModo() { return `(${this.cur[0]}, ${this.cur[1]})`; }
  // C / Y: esparcir la arena es un golpe, no una alternancia
  accionY() { this.reset = true; this.amp = Math.max(this.amp, 1.2); this.ctx.sonido.evento('arco'); return 'Arena esparcida'; }
  cambiarModo(dir) { this.k = (this.k + dir + MODOS.length) % MODOS.length; this.ultNav = performance.now(); this.cambiar(MODOS[this.k]); return this.nombreModo(); }
  frame(enc, dt, t) {
    const d = this.ctx.device, inp = this.ctx.input, W = this.ctx.W, H = this.ctx.H;
    this.modoT += dt;
    const now = performance.now();
    let [m, n] = this.cur;
    const nav = (dm, dn) => { if (now - this.ultNav < 220) return; this.ultNav = now; let m2 = Math.max(1, Math.min(9, m + dm)), n2 = Math.max(1, Math.min(9, n + dn)); if (m2 === n2) n2 = Math.min(9, n2 + (dn || 1)); if (m2 !== n2) this.cambiar([m2, n2]); };
    if (inp.lx > 0.6) nav(0, 1); else if (inp.lx < -0.6) nav(0, -1);
    else if (inp.ly < -0.6) nav(1, 0); else if (inp.ly > 0.6) nav(-1, 0);
    if (inp.pressed.a) { this.amp = 1.4; this.ctx.sonido.evento('arco'); }
    this.base = Math.max(0.15, Math.min(1, this.base + (inp.r2 - inp.l2) * dt * 0.6));
    if (this.modoT > 8 && (this.ctx.recorrido || now - this.ultNav > 12000)) { this.k = (this.k + 1) % MODOS.length; this.cambiar(MODOS[this.k]); if (this.k % 5 === 4) { this.sg = -this.sg; this.rotulo(); } }
    this.mezcla = Math.min(1, this.mezcla + dt / 1.6);
    this.amp += (this.base - this.amp) * Math.min(1, dt * 0.5);
    const r = W / innerWidth, S = this.geo.w * r, x0 = Math.round(this.geo.x * r), y0 = Math.round(this.geo.y * r);
    const f = new Float32Array(20), u = new Uint32Array(f.buffer);
    f.set([W, H, t, this.palette || 0], 0); f.set([x0, y0, S, this.N], 4); f.set([...this.prev, ...this.cur], 8);
    const gain = 0.9 * 5.7e6 / (W * H) * (1.6e6 / this.N);
    f.set([this.mezcla * this.mezcla * (3 - 2 * this.mezcla), this.amp, gain, this.sg], 12);
    u.set([this.seed++ * 7919, this.reset ? 1 : 0, 0, 0], 16);
    this.reset = false;
    d.queue.writeBuffer(this.u, 0, f);
    const cp = this.ctx.cpass(enc); cp.setPipeline(this.pSim); cp.setBindGroup(0, this.bgSim); cp.dispatchWorkgroups(...U.grid1D(this.N)); cp.end();
    const rp = this.ctx.rpass(enc, { colorAttachments: [{ view: this.ctx.post.hdrView, loadOp: 'clear', clearValue: [0, 0, 0, 1], storeOp: 'store' }] });
    rp.setPipeline(this.pDraw); rp.setBindGroup(0, this.bgDraw); rp.draw(3); rp.end();
    const fq = frec(...this.prev) + (frec(...this.cur) - frec(...this.prev)) * this.mezcla;
    this.sonido.freq = fq; this.sonido.amp = Math.min(1, this.amp);
  }
  lectura() { return `modo (${this.cur[0]}, ${this.cur[1]}) · ${frec(...this.cur).toFixed(1)} Hz · ${fmt.int(this.N)} granos`; }
  stats() {
    return [['granos', fmt.int(this.N), true], ['modo', `(${this.cur[0]}, ${this.cur[1]})`], ['frecuencia', frec(...this.cur).toFixed(1) + ' Hz'],
      ['amplitud', this.amp.toFixed(2)], ['saltos / s', fmt.si(this.N * 3 * this.ctx.perf.fps)]];
  }
  destroy() { this.pos.destroy(); this.acc.destroy(); this.u.destroy(); this.ctx.capa.innerHTML = ''; }
}
