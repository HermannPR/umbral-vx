// Sala 2: fractales 3D (Mandelbulb / Mandelbox) por raymarching en compute, resolución nativa.
import { makeShader, Counters, U } from '../gpu.js';
import { v3, fmt } from '../util.js';

const CS = /* wgsl */`
struct Uni { pos: vec4f, right: vec4f, up: vec4f, fwd: vec4f, prm: vec4f, res: vec4f, light: vec4f };
@group(0) @binding(0) var<uniform> u: Uni;
@group(0) @binding(1) var outTex: texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var<storage, read_write> cnt: array<atomic<u32>, 4>;
var<workgroup> redA: array<u32, 64>;
var<workgroup> redB: array<u32, 64>;

// potencia 8 polinómica (sin trigonometría): camino rápido
fn deBulb8(p: vec3f) -> vec2f {
  var w = p; var m = dot(w, w); var dz = 1.0; var trap = 1e9;
  for (var i = 0; i < 6; i++) {
    dz = 8.0 * pow(m, 3.5) * dz + 1.0;
    let x = w.x; let x2 = x * x; let x4 = x2 * x2;
    let y = w.y; let y2 = y * y; let y4 = y2 * y2;
    let z = w.z; let z2 = z * z; let z4 = z2 * z2;
    let k3 = max(x2 + z2, 1e-5);
    let k2 = inverseSqrt(k3 * k3 * k3 * k3 * k3 * k3 * k3);
    let k1 = x4 + y4 + z4 - 6.0 * y2 * z2 - 6.0 * x2 * y2 + 2.0 * z2 * x2;
    let k4 = x2 - y2 + z2;
    w = p + vec3f(64.0 * x * y * z * (x2 - z2) * k4 * (x4 - 6.0 * x2 * z2 + z4) * k1 * k2,
                  -16.0 * y2 * k3 * k4 * k4 + k1 * k1,
                  -8.0 * y * k4 * (x4 * x4 - 28.0 * x4 * x2 * z2 + 70.0 * x4 * z4 - 28.0 * x2 * z2 * z4 + z4 * z4) * k1 * k2);
    m = dot(w, w);
    trap = min(trap, m);
    if (m > 4.0) { break; }
  }
  return vec2f(0.25 * log(m) * sqrt(m) / dz, trap);
}

fn deBulb(p: vec3f) -> vec2f {
  if (abs(u.prm.z - 8.0) < 0.001) { return deBulb8(p); }
  var z = p; var dr = 1.0; var r = length(z); var trap = 1e9;
  let P = u.prm.z;
  for (var i = 0; i < 8; i++) {
    r = length(z);
    if (r > 2.0) { break; }
    let theta = acos(clamp(z.y / r, -1.0, 1.0)) * P;
    let phi = atan2(z.z, z.x) * P;
    let rp = pow(r, P - 1.0);
    dr = rp * P * dr + 1.0;
    let zr = rp * r;
    z = zr * vec3f(sin(theta) * cos(phi), cos(theta), sin(theta) * sin(phi)) + p;
    trap = min(trap, dot(z, z));
  }
  return vec2f(0.5 * log(max(r, 1e-6)) * r / dr, trap);
}

fn deBox(p: vec3f) -> vec2f {
  let s = u.res.z;
  var z = p; var dr = 1.0; var trap = 1e9;
  for (var i = 0; i < 12; i++) {
    z = clamp(z, vec3f(-1.0), vec3f(1.0)) * 2.0 - z;
    let r2 = dot(z, z);
    if (r2 < 0.25) { z *= 4.0; dr *= 4.0; }
    else if (r2 < 1.0) { z /= r2; dr /= r2; }
    z = z * s + p;
    dr = dr * abs(s) + 1.0;
    trap = min(trap, r2);
  }
  return vec2f(length(z) / abs(dr), trap);
}

fn map(p: vec3f) -> vec2f {
  if (u.prm.y < 0.5) { return deBulb(p); }
  return deBox(p);
}

fn pal(t: f32) -> vec3f {
  let k = u.res.w;
  var a = vec3f(0.6, 0.42, 0.3); var b = vec3f(0.45, 0.35, 0.3); var c = vec3f(1.0); var d = vec3f(0.0, 0.15, 0.35);
  if (k > 0.5 && k < 1.5) { a = vec3f(0.45, 0.6, 0.72); b = vec3f(0.3, 0.3, 0.32); d = vec3f(0.5, 0.55, 0.62); }
  else if (k > 1.5 && k < 2.5) { a = vec3f(0.5); b = vec3f(0.5); d = vec3f(0.0, 0.33, 0.67); }
  else if (k > 2.5) { a = vec3f(0.18, 0.17, 0.22); b = vec3f(0.22, 0.14, 0.3); c = vec3f(2.0, 1.0, 1.0); d = vec3f(0.5, 0.2, 0.25); }
  return a + b * cos(6.2831853 * (c * t + d));
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u, @builtin(local_invocation_index) li: u32) {
  let W = u32(u.res.x); let H = u32(u.res.y);
  var evals = 0u; var prim = 0u;
  if (gid.x < W && gid.y < H) {
    let isBox = u.prm.y > 0.5;
    let ws = select(1.0, 4.0, isBox);
    let uv = (vec2f(gid.xy) + 0.5 - 0.5 * u.res.xy) / u.res.y;
    let rd = normalize(u.fwd.xyz * u.pos.w + u.right.xyz * uv.x - u.up.xyz * uv.y);
    let ro = u.pos.xyz;
    let maxT = select(8.0, 50.0, isBox);
    let maxS = i32(u.prm.w);
    var t = 0.0; var hit = false; var trap = 0.0; var eps = 0.0;
    // recorte con esfera envolvente del Mandelbulb
    if (!isBox) {
      let b = dot(ro, rd); let c = dot(ro, ro) - 1.35 * 1.35; let h = b * b - c;
      if (h > 0.0) { t = max(0.0, -b - sqrt(h)); } else { t = maxT; }
    }
    for (var i = 0; i < maxS; i++) {
      if (t >= maxT) { break; }
      let h = map(ro + rd * t);
      evals++; prim++;
      eps = max(t * u.right.w * 0.7, 2e-6);
      if (h.x < eps) { hit = true; trap = h.y; break; }
      t += h.x * select(0.95, 0.85, isBox);
    }
    let L = normalize(u.light.xyz);
    let gl = f32(prim) / f32(maxS);
    var bg = mix(vec3f(0.012, 0.014, 0.03), vec3f(0.05, 0.03, 0.08), clamp(0.5 - uv.y, 0.0, 1.0));
    bg += pal(0.65 + u.prm.x * 0.01) * gl * gl * 1.4;
    var col = bg;
    if (hit) {
      let p = ro + rd * t;
      let e = eps * 0.5;
      let k = vec2f(1.0, -1.0);
      let n = normalize(k.xyy * map(p + k.xyy * e).x + k.yyx * map(p + k.yyx * e).x + k.yxy * map(p + k.yxy * e).x + k.xxx * map(p + k.xxx * e).x);
      evals += 4u;
      // sombra suave
      var sh = 1.0; var st = 0.004 * ws;
      let p0 = p + n * eps * 3.0;
      for (var j = 0; j < 32; j++) {
        let h = map(p0 + L * st).x; evals++;
        sh = min(sh, 10.0 * h / st);
        st += clamp(h, 0.003 * ws, 0.2 * ws);
        if (sh < 0.002 || st > 2.5 * ws) { break; }
      }
      sh = clamp(sh, 0.0, 1.0);
      // oclusión ambiental
      var ao = 0.0; var sc = 1.0;
      for (var j = 1; j <= 4; j++) {
        let hh = (0.006 + 0.055 * f32(j)) * ws;
        ao += (hh - map(p + n * hh).x) * sc; sc *= 0.7; evals++;
      }
      ao = clamp(1.0 - 2.2 * ao / ws, 0.0, 1.0);
      var tc = sqrt(trap);
      if (isBox) { tc = log(trap + 1.0) * 0.6; }
      let alb = pal(tc * 1.7 + u.prm.x * 0.015);
      let dif = max(dot(n, L), 0.0) * sh;
      let sky = 0.5 + 0.5 * n.y;
      let rfl = reflect(rd, n);
      let spe = pow(max(dot(rfl, L), 0.0), 40.0) * sh;
      let fre = pow(clamp(1.0 + dot(n, rd), 0.0, 1.0), 3.0);
      var lin = dif * vec3f(2.4, 2.0, 1.6);
      lin += sky * vec3f(0.22, 0.3, 0.45) * ao;
      lin += fre * vec3f(0.5, 0.6, 0.9) * ao;
      col = alb * lin * (0.35 + 0.65 * ao) + spe * vec3f(3.0, 2.6, 2.2);
      col = mix(col, bg, 1.0 - exp(-t * 0.05 / ws));
    }
    if (!(col.x == col.x && col.y == col.y && col.z == col.z)) { col = bg; }
    textureStore(outTex, gid.xy, vec4f(min(col, vec3f(30.0)), 1.0));
  }
  redA[li] = evals; redB[li] = prim;
  workgroupBarrier();
  for (var s = 32u; s > 0u; s >>= 1u) {
    if (li < s) { redA[li] += redA[li + s]; redB[li] += redB[li + s]; }
    workgroupBarrier();
  }
  if (li == 0u) { atomicAdd(&cnt[0], redA[0]); atomicAdd(&cnt[1], redB[0]); }
}
`;

// versión JS de los DE para que la cámara no atraviese la superficie
function deBulb(p, P) {
  let [x, y, z] = p, dr = 1, r = Math.hypot(x, y, z);
  for (let i = 0; i < 8; i++) {
    r = Math.hypot(x, y, z); if (r > 2) break;
    const th = Math.acos(Math.max(-1, Math.min(1, y / r))) * P, ph = Math.atan2(z, x) * P, rp = Math.pow(r, P - 1);
    dr = rp * P * dr + 1; const zr = rp * r;
    x = zr * Math.sin(th) * Math.cos(ph) + p[0]; y = zr * Math.cos(th) + p[1]; z = zr * Math.sin(th) * Math.sin(ph) + p[2];
  }
  return 0.5 * Math.log(Math.max(r, 1e-6)) * r / dr;
}
function deBox(p, s) {
  let [x, y, z] = p, dr = 1;
  const f = (v) => Math.max(-1, Math.min(1, v)) * 2 - v;
  for (let i = 0; i < 12; i++) {
    x = f(x); y = f(y); z = f(z);
    const r2 = x * x + y * y + z * z;
    if (r2 < 0.25) { x *= 4; y *= 4; z *= 4; dr *= 4; } else if (r2 < 1) { x /= r2; y /= r2; z /= r2; dr /= r2; }
    x = x * s + p[0]; y = y * s + p[1]; z = z * s + p[2]; dr = dr * Math.abs(s) + 1;
  }
  return Math.hypot(x, y, z) / Math.abs(dr);
}

export default class Fractal {
  static palettes = ['Ámbar', 'Glaciar', 'Neón', 'Obsidiana'];
  static controls = { ls: 'volar (avanzar / lateral)', rs: 'mirar', trig: '− / + potencia del fractal', a: 'cambiar Mandelbulb ⇄ Mandelbox' };
  static info = {
    title: 'Fractal 3D en tiempo real',
    short: 'Raymarching de Mandelbulb y Mandelbox',
    desc: 'Raymarching por píxel a resolución nativa: cada rayo evalúa la función de distancia del fractal cientos de veces, más sombras suaves y oclusión ambiental.',
  };
  constructor(ctx) { this.ctx = ctx; this.post = { exposure: 1.0, bloom: 0.35, vignette: 0.7 }; }
  async init() {
    const { device: d, report } = this.ctx;
    this.ub = U.uniform(d, 112);
    this.cnt = new Counters(d, 4, 8);
    const m = makeShader(d, CS, 'fractal', report);
    this.pipe = await d.createComputePipelineAsync({ layout: 'auto', compute: { module: m, entryPoint: 'main' } });
    this.bg = d.createBindGroup({ layout: this.pipe.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: this.ub } }, { binding: 1, resource: this.ctx.post.hdrView }, { binding: 2, resource: { buffer: this.cnt.buf } }] });
    this.mode = 0; this.power = 8; this.boxScale = 2.0; this.fade = 1; this.switching = 0;
    this.pos = [0, 0.3, 2.4]; this.fwd = v3.norm(v3.mul(this.pos, -1));
    this.lastInput = -1e9; this.tt = 0; this.maxSteps = Math.round(180 * (0.45 + 0.55 * (this.ctx.calidad ? this.ctx.calidad.carga : 1)));
    if (this.distScale) this.pos = v3.mul(this.pos, this.distScale);
  }
  de(p) { return this.mode === 0 ? deBulb(p, this.power) : deBox(p, this.boxScale); }
  autopilot(t) {
    if (this.mode === 0) {
      const a = t * 0.11, R = (1.75 + 0.55 * Math.sin(t * 0.07)) * (this.distScale || 1), el = 0.45 * Math.sin(t * 0.05);
      const pos = [Math.cos(a) * R * Math.cos(el), Math.sin(el) * R + 0.1, Math.sin(a) * R * Math.cos(el)];
      const look = [0.25 * Math.sin(t * 0.13), 0.15 * Math.cos(t * 0.09), 0.25 * Math.cos(t * 0.11)];
      return [pos, v3.norm(v3.sub(look, pos))];
    }
    const a = t * 0.06, R = 9.0 + 3.0 * Math.sin(t * 0.05), el = 0.35 + 0.3 * Math.sin(t * 0.037);
    const pos = [Math.cos(a) * R * Math.cos(el), Math.sin(el) * R, Math.sin(a) * R * Math.cos(el)];
    const look = [2.5 * Math.sin(t * 0.08), 1.5 * Math.sin(t * 0.06), 2.5 * Math.cos(t * 0.07)];
    return [pos, v3.norm(v3.sub(look, pos))];
  }
  frame(enc, dt, t) {
    const d = this.ctx.device, inp = this.ctx.input, W = this.ctx.W, H = this.ctx.H;
    this.tt += dt * (this.chaos ? 2.5 : 1);
    // cambio de fractal con fundido
    if (inp.pressed.a && !this.switching) this.switching = 1;
    if (this.switching) {
      this.fade -= dt / 0.35;
      if (this.fade <= 0) {
        this.fade = 0; this.switching = 0; this.mode ^= 1;
        [this.pos, this.fwd] = this.autopilot(this.tt); this.lastInput = -1e9;
        this.fadeIn = true;
      }
    } else if (this.fade < 1) this.fade = Math.min(1, this.fade + dt / 0.5);
    this.post.exposure = this.fade;
    // parámetro del fractal
    const trig = inp.r2 - inp.l2;
    if (this.mode === 0) {
      this.power = Math.max(2, Math.min(14, this.power + trig * dt * 2.5));
      if (this.chaos) this.power = 8 + 3.5 * Math.sin(this.tt * 0.6);
    } else {
      this.boxScale = Math.max(1.5, Math.min(3.2, this.boxScale + trig * dt * 0.5));
      if (this.chaos) this.boxScale = 2.3 + 0.7 * Math.sin(this.tt * 0.4);
    }
    // cámara: autopiloto o vuelo manual
    const active = Math.abs(inp.lx) + Math.abs(inp.ly) + Math.abs(inp.rx) + Math.abs(inp.ry) > 0.05;
    if (active) this.lastInput = t;
    const ws = this.mode === 0 ? 1 : 4;
    if (t - this.lastInput < 6) {
      const up = [0, 1, 0];
      let yaw = Math.atan2(this.fwd[2], this.fwd[0]), pitch = Math.asin(Math.max(-1, Math.min(1, this.fwd[1])));
      yaw += inp.rx * 1.6 * dt; pitch = Math.max(-1.45, Math.min(1.45, pitch - inp.ry * 1.3 * dt));
      this.fwd = [Math.cos(yaw) * Math.cos(pitch), Math.sin(pitch), Math.sin(yaw) * Math.cos(pitch)];
      const right = v3.norm(v3.cross(this.fwd, up));
      const speed = Math.max(0.004 * ws, Math.min(1.2 * ws, this.de(this.pos) * 1.6)) * (this.chaos ? 2 : 1);
      this.pos = v3.add(this.pos, v3.mul(v3.add(v3.mul(this.fwd, -inp.ly), v3.mul(right, inp.lx)), speed * dt));
    } else {
      const [pA, fA] = this.autopilot(this.tt);
      const k = 1 - Math.exp(-dt * 0.9);
      this.pos = v3.mix(this.pos, pA, k); this.fwd = v3.norm(v3.mix(this.fwd, fA, 1 - Math.exp(-dt * 1.2)));
    }
    // evitar atravesar la superficie
    const minD = 0.012 * ws;
    for (let i = 0; i < 4; i++) {
      const dd = this.de(this.pos); if (dd >= minD) break;
      const e = 1e-3 * ws, g = v3.norm([this.de(v3.add(this.pos, [e, 0, 0])) - dd, this.de(v3.add(this.pos, [0, e, 0])) - dd, this.de(v3.add(this.pos, [0, 0, e])) - dd]);
      this.pos = v3.add(this.pos, v3.mul(g, minD - dd + 1e-4 * ws));
    }
    const fwd = this.fwd, right = v3.norm(v3.cross(fwd, [0, 1, 0])), up = v3.cross(right, fwd);
    const fs = 1.25;
    const la = this.tt * (this.chaos ? 0.5 : 0.12);
    const light = v3.norm([Math.cos(la) * 0.7 + 0.2, 0.75, Math.sin(la) * 0.7 - 0.3]);
    const f = new Float32Array(28);
    f.set([...this.pos, fs, ...right, 1 / (H * fs), ...up, 0, ...fwd, 0,
      this.tt, this.mode, this.power, this.maxSteps, W, H, this.boxScale, this.palette || 0, ...light, this.chaos ? 1 : 0]);
    d.queue.writeBuffer(this.ub, 0, f);
    this.cnt.clear(enc);
    const p = this.ctx.cpass(enc); p.setPipeline(this.pipe); p.setBindGroup(0, this.bg);
    p.dispatchWorkgroups(Math.ceil(W / 8), Math.ceil(H / 8)); p.end();
    this.cnt.copy(enc);
  }
  after() { this.cnt.after(); }
  onKey(k) { if (k === 'f') this.switching = 1; }
  nombreModo() { return (this.mode ^ (this.switching ? 1 : 0)) ? 'Mandelbox' : 'Mandelbulb'; }
  cambiarModo() { if (!this.switching) this.switching = 1; return this.nombreModo(); }
  stats() {
    const W = this.ctx.W, H = this.ctx.H, fps = this.ctx.perf.fps, v = this.cnt.values;
    const evals = v ? v[0] : 0, prim = v ? v[1] : 0;
    const flopsPerEval = this.mode === 0 ? 8 * 48 : 12 * 26;
    return [
      ['fractal', this.mode === 0 ? `Mandelbulb  p=${this.power.toFixed(2)}` : `Mandelbox  s=${this.boxScale.toFixed(2)}`],
      ['píxeles trazados', fmt.int(W * H), true],
      ['pasos de rayo / píxel', (prim / (W * H)).toFixed(1)],
      ['evaluaciones DE / frame', fmt.si(evals)],
      ['evaluaciones DE / s', fmt.si(evals * fps)],
      ['≈ cómputo', fmt.si(evals * fps * flopsPerEval, 'FLOP/s')],
    ];
  }
  destroy() { this.ub.destroy(); this.cnt.destroy(); }
}
