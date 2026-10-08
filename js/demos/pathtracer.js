// Sala 6: path tracer progresivo en GPU (esferas difusas, metal, vidrio y emisivas) con profundidad de campo.
import { makeShader, Counters, U } from '../gpu.js';
import { HASH, v3, fmt, Governor } from '../util.js';

const CS = HASH + /* wgsl */`
struct Uni { pos: vec4f, fwd: vec4f, right: vec4f, up: vec4f, lens: vec4f, res: vec4u, misc: vec4f };
struct Sph { c: vec4f, alb: vec4f, em: vec4f };
@group(0) @binding(0) var<uniform> u: Uni;
@group(0) @binding(1) var<storage, read> sph: array<Sph>;
@group(0) @binding(2) var<storage, read_write> acc: array<vec4f>;
@group(0) @binding(3) var outTex: texture_storage_2d<rgba16float, write>;
@group(0) @binding(4) var<storage, read_write> cnt: array<atomic<u32>, 4>;
var<workgroup> red: array<u32, 64>;

fn sky(rd: vec3f) -> vec3f {
  let k = u.misc.z;
  let y = rd.y;
  var zen = vec3f(0.08, 0.16, 0.42); var hor = vec3f(1.0, 0.55, 0.3); var sunC = vec3f(30.0, 18.0, 9.0);
  var sunD = normalize(vec3f(-0.6, 0.18, -0.75));
  if (k > 0.5 && k < 1.5) { zen = vec3f(0.01, 0.0, 0.03); hor = vec3f(0.12, 0.02, 0.18); sunC = vec3f(0.0); }
  else if (k > 1.5 && k < 2.5) { zen = vec3f(0.9, 0.92, 1.0); hor = vec3f(0.7, 0.72, 0.75); sunC = vec3f(6.0, 6.0, 6.2); sunD = normalize(vec3f(0.2, 0.9, 0.3)); }
  else if (k > 2.5) { zen = vec3f(0.0, 0.05, 0.08); hor = vec3f(0.05, 0.4, 0.3); sunC = vec3f(2.0, 8.0, 6.0); sunD = normalize(vec3f(0.5, 0.35, -0.8)); }
  var c = mix(hor, zen, pow(clamp(y, 0.0, 1.0), 0.45));
  if (y < 0.0) { c = hor * 0.25; }
  c += sunC * pow(max(dot(rd, sunD), 0.0), 180.0) + sunC * 0.02 * pow(max(dot(rd, sunD), 0.0), 6.0);
  return c;
}

fn unitVec(s: ptr<function, u32>) -> vec3f {
  let z = rnd(s) * 2.0 - 1.0; let a = rnd(s) * 6.2831853; let r = sqrt(1.0 - z * z);
  return vec3f(r * cos(a), r * sin(a), z);
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u, @builtin(local_invocation_index) li: u32) {
  let W = u.res.x; let H = u.res.y;
  var rays = 0u;
  if (gid.x < W && gid.y < H) {
    let idx = gid.y * W + gid.x;
    var seed = pcg(idx * 1973u + u.res.z * 9277u + 1u);
    let nS = u32(u.misc.x);
    var sum = vec3f(0.0);
    let spp = u.res.w;
    for (var s = 0u; s < spp; s++) {
      let jit = vec2f(rnd(&seed), rnd(&seed)) - 0.5;
      let uv = (vec2f(gid.xy) + 0.5 + jit - 0.5 * vec2f(f32(W), f32(H))) / f32(H);
      var rd = normalize(u.fwd.xyz * u.pos.w + u.right.xyz * uv.x - u.up.xyz * uv.y);
      // profundidad de campo: lente fina
      let fp = u.pos.xyz + rd * (u.lens.y / dot(rd, u.fwd.xyz));
      let la = rnd(&seed) * 6.2831853; let lr = sqrt(rnd(&seed)) * u.lens.x;
      var ro = u.pos.xyz + (u.right.xyz * cos(la) + u.up.xyz * sin(la)) * lr;
      rd = normalize(fp - ro);
      var thr = vec3f(1.0); var rad = vec3f(0.0);
      for (var b = 0; b < 8; b++) {
        rays++;
        var tb = 1e9; var hn = vec3f(0.0); var mi = -1;
        for (var i = 0u; i < nS; i++) {
          let S = sph[i].c;
          let oc = ro - S.xyz;
          let bb = dot(oc, rd); let cc = dot(oc, oc) - S.w * S.w; let h = bb * bb - cc;
          if (h > 0.0) {
            let sq = sqrt(h);
            var t = -bb - sq;
            if (t < 1e-4) { t = -bb + sq; }
            if (t > 1e-4 && t < tb) { tb = t; mi = i32(i); hn = (oc + rd * t) / S.w; }
          }
        }
        var floorHit = false;
        if (rd.y < 0.0) { let t = -ro.y / rd.y; if (t > 1e-4 && t < tb) { tb = t; hn = vec3f(0.0, 1.0, 0.0); floorHit = true; mi = -2; } }
        if (mi == -1) { rad += thr * sky(rd); break; }
        let p = ro + rd * tb;
        if (floorHit) {
          let q = floor(p.xz * 0.9);
          let chk = (i32(q.x) + i32(q.y)) & 1;
          let alb = select(vec3f(0.75, 0.74, 0.72), vec3f(0.06, 0.06, 0.07), chk == 1);
          if (rnd(&seed) < 0.12) { rd = normalize(reflect(rd, hn) + unitVec(&seed) * 0.05); }
          else { rd = normalize(hn + unitVec(&seed)); thr *= alb; }
          ro = p + hn * 1e-3;
        } else {
          let m = sph[mi];
          let typ = m.alb.w;
          if (typ > 2.5) { rad += thr * m.em.rgb; break; }
          if (typ < 0.5) {
            rd = normalize(hn + unitVec(&seed)); thr *= m.alb.rgb; ro = p + hn * 1e-3;
          } else if (typ < 1.5) {
            rd = normalize(reflect(rd, hn) + unitVec(&seed) * m.em.w);
            thr *= m.alb.rgb;
            if (dot(rd, hn) < 0.0) { rd = reflect(rd, hn); }
            ro = p + hn * 1e-3;
          } else {
            let front = dot(rd, hn) < 0.0;
            let nn = select(-hn, hn, front);
            let eta = select(m.em.w, 1.0 / m.em.w, front);
            let cosi = min(dot(-rd, nn), 1.0);
            let sin2 = 1.0 - cosi * cosi;
            var r0 = (1.0 - m.em.w) / (1.0 + m.em.w); r0 = r0 * r0;
            let fr = r0 + (1.0 - r0) * pow(1.0 - cosi, 5.0);
            if (eta * eta * sin2 > 1.0 || rnd(&seed) < fr) { rd = reflect(rd, nn); ro = p + nn * 1e-3; }
            else { rd = refract(rd, nn, eta); ro = p - nn * 1e-3; if (!front) { thr *= m.alb.rgb; } }
          }
        }
        if (b > 2) {
          let pr = clamp(max(thr.x, max(thr.y, thr.z)), 0.05, 0.95);
          if (rnd(&seed) > pr) { break; }
          thr /= pr;
        }
      }
      sum += min(rad, vec3f(40.0));
    }
    var a = acc[idx];
    if (u.misc.y > 0.5) { a = vec4f(0.0); }
    a += vec4f(sum, f32(spp));
    acc[idx] = a;
    textureStore(outTex, gid.xy, vec4f(a.rgb / max(a.w, 1.0), 1.0));
  }
  red[li] = rays;
  workgroupBarrier();
  for (var s = 32u; s > 0u; s >>= 1u) { if (li < s) { red[li] += red[li + s]; } workgroupBarrier(); }
  if (li == 0u) { atomicAdd(&cnt[0], red[0]); }
}
`;

// escena: [x,y,z,r], [albedo rgb, tipo 0 difuso 1 metal 2 vidrio 3 emisivo], [emisión rgb, rugosidad / ior]
function buildScene(t, anim) {
  const S = [];
  const add = (c, r, alb, typ, em = [0, 0, 0], p = 0) => S.push([...c, r, ...alb, typ, ...em, p]);
  const bob = (i) => (anim ? Math.abs(Math.sin(t * 2.2 + i * 1.7)) * 0.9 : 0);
  add([0, 1 + bob(0), 0], 1, [0.95, 0.98, 1.0], 2, [0, 0, 0], 1.5);
  add([-2.25, 1 + bob(1), 0.4], 1, [0.95, 0.95, 0.97], 1, [0, 0, 0], 0.0);
  add([2.25, 1 + bob(2), -0.3], 1, [1.0, 0.72, 0.32], 1, [0, 0, 0], 0.18);
  add([0.2, 0.5 + bob(3), 2.3], 0.5, [0.9, 0.2, 0.15], 0);
  add([-1.2, 0.35 + bob(4), 2.0], 0.35, [0.3, 0.9, 1.0], 2, [0, 0, 0], 1.45);
  add([1.5, 0.4 + bob(5), 1.8], 0.4, [0.95, 0.95, 0.95], 0);
  const cols = [[1, 0.3, 0.1], [0.2, 0.6, 1], [1, 0.2, 0.7], [0.3, 1, 0.5], [1, 0.85, 0.2], [0.6, 0.3, 1]];
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2 + 0.2, R = 4.2 + (i % 2) * 0.9, r = 0.28 + 0.14 * ((i * 7) % 3) / 2;
    const c = [Math.cos(a) * R, r + bob(i + 6) * 0.6, Math.sin(a) * R];
    const col = cols[i % cols.length];
    const kind = i % 4;
    if (kind === 0) add(c, r * 0.8, [0, 0, 0], 3, col.map((x) => x * 9));
    else if (kind === 1) add(c, r, col, 2, [0, 0, 0], 1.5);
    else if (kind === 2) add(c, r, col, 1, [0, 0, 0], 0.05);
    else add(c, r, col, 0);
  }
  add([0, 6.5, -6], 1.6, [0, 0, 0], 3, [3.2, 3.0, 2.8]);
  return S;
}

const SHOTS = [
  { az: 0.35, el: 0.22, d: 7.2, f: 7.0 },
  { az: 2.2, el: 0.12, d: 5.0, f: 4.6 },
  { az: -1.1, el: 0.45, d: 9.0, f: 8.8 },
  { az: 3.6, el: 0.08, d: 4.2, f: 3.2 },
];

export default class PathTracer {
  static palettes = ['Atardecer', 'Noche neón', 'Estudio', 'Aurora'];
  static controls = { ls: 'mover cámara (órbita / distancia)', rs: 'mirar', trig: '− / + apertura (desenfoque)', a: 'siguiente toma' };
  static info = {
    title: 'Path tracer',
    short: 'Trazado de caminos progresivo',
    desc: 'Simulación física de la luz: cada píxel lanza caminos aleatorios que rebotan, se reflejan y se refractan en vidrio; las muestras se acumulan y la imagen converge.',
  };
  constructor(ctx) { this.ctx = ctx; this.post = { exposure: 0.85, bloom: 0.35, vignette: 0.5 }; }
  async init() {
    const { device: d, report, W, H } = this.ctx;
    this.W = W; this.H = H;
    this.ub = U.uniform(d, 112);
    this.sph = U.storage(d, 64 * 48);
    this.acc = U.storage(d, W * H * 16);
    this.cnt = new Counters(d, 4, 6);
    const m = makeShader(d, CS, 'pathtracer', report);
    this.pipe = await d.createComputePipelineAsync({ layout: 'auto', compute: { module: m, entryPoint: 'main' } });
    this.bg = d.createBindGroup({ layout: this.pipe.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: this.ub } }, { binding: 1, resource: { buffer: this.sph } }, { binding: 2, resource: { buffer: this.acc } },
      { binding: 3, resource: this.ctx.post.hdrView }, { binding: 4, resource: { buffer: this.cnt.buf } }] });
    this.gov = new Governor({ min: 1, max: Math.max(2, Math.round(32 * (this.ctx.calidad ? this.ctx.calidad.carga : 1))), value: 2, stepUp: (v) => v + 1, stepDown: (v) => v - 1, lowMs: 11, highMs: 15, every: 0.5 });
    this.shot = 0; this.shotT = 0; this.frameI = 0; this.samples = 0; this.reset = true; this.aperture = 0.06;
    this.camOff = { az: 0, el: 0, d: 1, yaw: 0, pitch: 0 };
    this.lastPal = -1; this.writeScene(0);
  }
  writeScene(t) {
    const S = buildScene(t, this.chaos);
    this.nS = S.length;
    this.ctx.device.queue.writeBuffer(this.sph, 0, new Float32Array(S.flat()));
  }
  frame(enc, dt, t) {
    const d = this.ctx.device, inp = this.ctx.input, { W, H } = this;
    const ms = this.ctx.perf.gpuMs ?? this.ctx.perf.frameMs;
    this.gov.update(dt, ms);
    const spp = this.gov.value;
    this.spp = spp;
    this.sonido = { ruido: Math.min(1, 2 / Math.sqrt(1 + (this.samples || 0) / 4)) };
    // tomas automáticas cada 15 s (si nadie toca el mando)
    this.shotT += dt;
    const moving = Math.abs(inp.lx) + Math.abs(inp.ly) + Math.abs(inp.rx) + Math.abs(inp.ry) > 0.05;
    const trig = inp.r2 - inp.l2;
    // ↑ ↓ (cambiarModo) ya fijó la toma; A y el reloj de 15 s pasan a la siguiente
    if (inp.pressed.a || (this.shotT > 15 && !moving)) { this.shot = (this.shot + 1) % SHOTS.length; this.pedirToma = true; }
    if (this.pedirToma) { this.pedirToma = false; this.shotT = 0; this.camOff = { az: 0, el: 0, d: 1, yaw: 0, pitch: 0 }; this.reset = true; }
    if (moving) {
      const o = this.camOff; this.shotT = 0;
      o.az += inp.lx * dt * 0.8; o.d = Math.max(0.35, Math.min(2.2, o.d * Math.exp(inp.ly * dt)));
      o.yaw += inp.rx * dt * 0.7; o.pitch = Math.max(-0.8, Math.min(0.8, o.pitch - inp.ry * dt * 0.6));
      this.reset = true;
    }
    if (Math.abs(trig) > 0.05) { this.aperture = Math.max(0, Math.min(0.5, this.aperture + trig * dt * 0.15)); this.reset = true; }
    if (this.palette !== this.lastPal) { this.lastPal = this.palette; this.reset = true; }
    if (this.chaos) { this.writeScene(t); this.reset = true; } else if (this.wasChaos) { this.writeScene(0); this.reset = true; }
    this.wasChaos = this.chaos;
    const sh = SHOTS[this.shot], o = this.camOff;
    const az = sh.az + o.az, el = sh.el, dist = sh.d * o.d;
    const target = [0, 0.9, 0];
    const pos = [Math.cos(az) * Math.cos(el) * dist, 0.35 + Math.sin(el) * dist, Math.sin(az) * Math.cos(el) * dist];
    let fwd = v3.norm(v3.sub(target, pos));
    let yaw = Math.atan2(fwd[2], fwd[0]) + o.yaw, pitch = Math.asin(fwd[1]) + o.pitch;
    fwd = [Math.cos(yaw) * Math.cos(pitch), Math.sin(pitch), Math.sin(yaw) * Math.cos(pitch)];
    const right = v3.norm(v3.cross(fwd, [0, 1, 0])), up = v3.cross(right, fwd);
    const focus = Math.max(0.5, v3.dot(v3.sub(target, pos), fwd));
    if (this.reset) { this.samples = 0; }
    const a = new ArrayBuffer(112), f = new Float32Array(a), u = new Uint32Array(a);
    f.set([...pos, 1.6, ...fwd, 0, ...right, 0, ...up, 0, this.aperture, focus, 0, 0]);
    u.set([W, H, this.frameI++, spp], 20);
    f.set([this.nS, this.reset ? 1 : 0, this.palette || 0, 0], 24);
    d.queue.writeBuffer(this.ub, 0, a);
    this.reset = false;
    this.samples += spp;
    this.cnt.clear(enc);
    const p = this.ctx.cpass(enc); p.setPipeline(this.pipe); p.setBindGroup(0, this.bg);
    p.dispatchWorkgroups(Math.ceil(W / 8), Math.ceil(H / 8)); p.end();
    this.cnt.copy(enc);
  }
  after() { this.cnt.after(); }
  nombreModo() { return 'toma ' + ((this.shot || 0) + 1) + ' de ' + SHOTS.length; }
  // la toma cambia ya (no en el siguiente cuadro): así la ayuda y el aviso muestran la misma
  cambiarModo(dir) { this.shot = ((this.shot || 0) + dir + SHOTS.length) % SHOTS.length; this.pedirToma = true; return this.nombreModo(); }
  stats() {
    const fps = this.ctx.perf.fps, px = this.W * this.H, rays = this.cnt.values ? this.cnt.values[0] : 0;
    return [
      ['muestras / píxel', fmt.int(this.samples), true],
      ['muestras / frame', `${this.spp} spp`],
      ['caminos / s', fmt.si(px * this.spp * fps)],
      ['rayos (rebotes) / s', fmt.si(rays * fps), true],
      ['rebotes medios / camino', rays ? (rays / (px * this.spp)).toFixed(2) : '–'],
      ['esferas · toma', `${this.nS} · ${this.shot + 1}/${SHOTS.length}`],
    ];
  }
  destroy() { [this.ub, this.sph, this.acc].forEach((x) => x.destroy()); this.cnt.destroy(); }
}
