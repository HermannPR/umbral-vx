// Modo de respaldo WebGL2: las 7 salas reimplementadas con shaders de fragmentos y texturas ping-pong.
import { VS, program, target, upload, freeTarget, pass, setU, TONEMAP } from './glcore.js';
import { m4, v3, fmt } from '../util.js';
import GalvanizadoGL, { MODOS_GALV } from './galvanizado.js';

const HDR = `#version 300 es
precision highp float; precision highp int;
`;
const PAL = `
vec3 cpal(float t, float k) {
  vec3 a = vec3(0.62, 0.45, 0.33), b = vec3(0.4, 0.3, 0.25), c = vec3(1.0), d = vec3(0.0, 0.1, 0.2);
  if (k > 0.5 && k < 1.5) { a = vec3(0.45, 0.6, 0.72); b = vec3(0.3, 0.3, 0.32); d = vec3(0.5, 0.55, 0.62); }
  else if (k > 1.5 && k < 2.5) { a = vec3(0.5); b = vec3(0.5); d = vec3(0.0, 0.33, 0.67); }
  else if (k > 2.5) { a = vec3(0.18, 0.17, 0.22); b = vec3(0.22, 0.14, 0.3); c = vec3(2.0, 1.0, 1.0); d = vec3(0.5, 0.2, 0.25); }
  return a + b * cos(6.2831853 * (c * t + d));
}`;
const HASHGL = `
uint pcg(uint v) { uint s = v * 747796405u + 2891336453u; uint w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u; return (w >> 22u) ^ w; }
float rnd(inout uint s) { s = pcg(s); return float(s) * (1.0 / 4294967296.0); }`;

// ---------------- Sala 2: fractal ----------------
const FRACTAL_FS = HDR + PAL + `
uniform vec3 pos, fwd, right, up; uniform vec4 prm; uniform vec2 res; uniform float pal, boxS;
out vec4 o;
vec3 fpal(float t){return pal>3.5?vec3(.55):cpal(t,pal);}
vec2 deBulb(vec3 p) {
  vec3 w = p; float m = dot(w, w), dz = 1.0, trap = 1e9;
  for (int i = 0; i < 6; i++) {
    dz = 8.0 * pow(m, 3.5) * dz + 1.0;
    float x = w.x, x2 = x*x, x4 = x2*x2, y = w.y, y2 = y*y, y4 = y2*y2, z = w.z, z2 = z*z, z4 = z2*z2;
    float k3 = max(x2 + z2, 1e-5), k2 = inversesqrt(k3*k3*k3*k3*k3*k3*k3);
    float k1 = x4 + y4 + z4 - 6.0*y2*z2 - 6.0*x2*y2 + 2.0*z2*x2, k4 = x2 - y2 + z2;
    w = p + vec3(64.0*x*y*z*(x2-z2)*k4*(x4-6.0*x2*z2+z4)*k1*k2, -16.0*y2*k3*k4*k4 + k1*k1,
                 -8.0*y*k4*(x4*x4 - 28.0*x4*x2*z2 + 70.0*x4*z4 - 28.0*x2*z2*z4 + z4*z4)*k1*k2);
    m = dot(w, w); trap = min(trap, m);
    if (m > 4.0) break;
  }
  return vec2(0.25 * log(m) * sqrt(m) / dz, trap);
}
vec2 deBox(vec3 p) {
  vec3 z = p; float dr = 1.0, trap = 1e9;
  for (int i = 0; i < 12; i++) {
    z = clamp(z, -1.0, 1.0) * 2.0 - z;
    float r2 = dot(z, z);
    if (r2 < 0.25) { z *= 4.0; dr *= 4.0; } else if (r2 < 1.0) { z /= r2; dr /= r2; }
    z = z * boxS + p; dr = dr * abs(boxS) + 1.0; trap = min(trap, r2);
  }
  return vec2(length(z) / abs(dr), trap);
}
vec2 map(vec3 p) { return prm.y < 0.5 ? deBulb(p) : deBox(p); }
void main() {
  bool isBox = prm.y > 0.5; float ws = isBox ? 4.0 : 1.0;
  vec2 uv = (vec2(gl_FragCoord.x, res.y - gl_FragCoord.y) - 0.5 * res) / res.y;
  vec3 rd = normalize(fwd * 1.25 + right * uv.x - up * uv.y), ro = pos;
  float t = 0.0, maxT = isBox ? 50.0 : 8.0, eps = 0.0, trap = 0.0; bool hit = false; int steps = 0;
  if (!isBox) { float b = dot(ro, rd), c = dot(ro, ro) - 1.82; float h = b*b - c; t = h > 0.0 ? max(0.0, -b - sqrt(h)) : maxT; }
  for (int i = 0; i < 140; i++) {
    if (t >= maxT) break;
    vec2 h = map(ro + rd * t); steps++;
    eps = max(t / (res.y * 1.25) * 0.7, 2e-6);
    if (h.x < eps) { hit = true; trap = h.y; break; }
    t += h.x * (isBox ? 0.85 : 0.95);
  }
  vec3 L = normalize(vec3(cos(prm.x * 0.12) * 0.7 + 0.2, 0.75, sin(prm.x * 0.12) * 0.7 - 0.3));
  float gl = float(steps) / 140.0;
  vec3 bg = mix(vec3(0.012, 0.014, 0.03), vec3(0.05, 0.03, 0.08), clamp(0.5 - uv.y, 0.0, 1.0)) + fpal(0.65) * gl * gl * 1.4;
  vec3 col = bg;
  if (hit) {
    vec3 p = ro + rd * t; float e = eps * 0.5; vec2 k = vec2(1, -1);
    vec3 n = normalize(k.xyy*map(p + k.xyy*e).x + k.yyx*map(p + k.yyx*e).x + k.yxy*map(p + k.yxy*e).x + k.xxx*map(p + k.xxx*e).x);
    float sh = 1.0, st = 0.004 * ws; vec3 p0 = p + n * eps * 3.0;
    for (int j = 0; j < 24; j++) { float h = map(p0 + L * st).x; sh = min(sh, 10.0 * h / st); st += clamp(h, 0.004 * ws, 0.2 * ws); if (sh < 0.002 || st > 2.5 * ws) break; }
    sh = clamp(sh, 0.0, 1.0);
    float ao = 0.0, sc = 1.0;
    for (int j = 1; j <= 4; j++) { float hh = (0.006 + 0.055 * float(j)) * ws; ao += (hh - map(p + n * hh).x) * sc; sc *= 0.7; }
    ao = clamp(1.0 - 2.2 * ao / ws, 0.0, 1.0);
    float tc = isBox ? log(trap + 1.0) * 0.6 : sqrt(trap);
    vec3 alb = fpal(tc * 0.9 + prm.x * 0.015);
    float dif = max(dot(n, L), 0.0) * sh, sky = 0.5 + 0.5 * n.y;
    float spe = pow(max(dot(reflect(rd, n), L), 0.0), 40.0) * sh, fre = pow(clamp(1.0 + dot(n, rd), 0.0, 1.0), 3.0);
    vec3 lin = dif * vec3(2.4, 2.0, 1.6) + sky * vec3(0.22, 0.3, 0.45) * ao + fre * vec3(0.5, 0.6, 0.9) * ao;
    col = alb * lin * (0.35 + 0.65 * ao) + spe * vec3(3.0, 2.6, 2.2);
    if(pal>3.5){col=vec3(dot(lin*(.35+.65*ao),vec3(.2126,.7152,.0722))*.32);}
    col = mix(col, bg, 1.0 - exp(-t * 0.05 / ws));
  }
  o = vec4(min(col, vec3(30.0)), float(steps));
}`;

class GLFractal {
  static palettes = ['Ámbar', 'Glaciar', 'Neón', 'Obsidiana', ...MODOS_GALV];
  static paletaInicial = 4;
  static controls = { ls: 'volar', rs: 'mirar', trig: '− / + escala del Mandelbox', a: 'cambiar Mandelbulb ⇄ Mandelbox' };
  static info = { title: 'Fractal 3D en tiempo real', short: 'Raymarching (WebGL2)', desc: 'Raymarching por píxel del Mandelbulb / Mandelbox con sombras suaves y oclusión ambiental (modo WebGL2).' };
  constructor(ctx, out) { this.ctx = ctx; this.out = out || ctx.hdr; }
  init() { this.prog = program(this.ctx.gl, VS, FRACTAL_FS, this.ctx.report, 'fractal'); this.grado = new GalvanizadoGL(this.ctx.gl,this.out,this.ctx.report); this.mode = 0; this.boxS = 2; this.tt = 0; this.colorT = 0; this.yaw = 0; this.pitch = 0; this.dist = 1; }
  frame(dt, t) {
    const inp = this.ctx.input, gl = this.ctx.gl;
    this.tt += dt * (this.chaos ? 2.5 : 1); this.colorT += dt;
    if (inp.pressed.a) this.mode ^= 1;
    this.boxS = Math.max(1.5, Math.min(3.2, this.boxS + (inp.r2 - inp.l2) * dt * 0.5));
    this.yaw += (inp.rx + inp.lx) * dt; this.pitch = Math.max(-1, Math.min(1, this.pitch - inp.ry * dt)); this.dist = Math.max(0.5, Math.min(1.8, this.dist * Math.exp(inp.ly * dt)));
    const a = this.tt * (this.mode ? 0.06 : 0.11) + this.yaw, R = (this.mode ? 9 + 3 * Math.sin(this.tt * 0.05) : 1.75 + 0.55 * Math.sin(this.tt * 0.07)) * this.dist * (this.distScale || 1);
    const el = 0.45 * Math.sin(this.tt * 0.05) + this.pitch;
    const pos = [Math.cos(a) * R * Math.cos(el), Math.sin(el) * R, Math.sin(a) * R * Math.cos(el)];
    const fwd = v3.norm(v3.mul(pos, -1)), right = v3.norm(v3.cross(fwd, [0, 1, 0])), up = v3.cross(right, fwd);
    pass(gl, this.prog, this.palette >= 4 ? this.grado.raw : this.out, { pos, fwd, right, up, prm: [this.tt, this.mode, 8, 0], res: [this.out.w, this.out.h], pal: this.palette || 0, boxS: this.boxS });
    if(this.palette >= 4) this.grado.run(this.palette,this.colorT);
  }
  stats() { const px = this.out.w * this.out.h; return [['fractal', this.mode ? 'Mandelbox' : 'Mandelbulb'], ['píxeles trazados', fmt.int(px), true], ['pasos máx / rayo', '140']]; }
  destroy() { this.ctx.gl.deleteProgram(this.prog.p); this.grado.destroy(); }
}

// ---------------- Sala 3: reacción-difusión ----------------
const RD_STEP = HDR + HASHGL + `
uniform sampler2D S; uniform vec2 res; uniform float time, mapOff; uniform vec4 seed; uniform float init;
out vec4 o;
vec2 params(vec2 q) {
  float t = time * 0.02 + mapOff; q /= res.y;
  float a = sin(q.x * 2.1 + t) * cos(q.y * 2.7 - t * 0.7) * 0.5 + 0.5, b = sin(q.y * 1.7 + q.x * 0.9 + t * 0.8) * 0.5 + 0.5;
  return mix(mix(vec2(0.0545, 0.062), vec2(0.0367, 0.0649), smoothstep(0.25, 0.75, a)), mix(vec2(0.029, 0.057), vec2(0.058, 0.065), smoothstep(0.3, 0.7, a)), smoothstep(0.35, 0.65, b));
}
vec2 at(ivec2 p) { ivec2 r = ivec2(res); return texelFetch(S, (p + r) % r, 0).xy; }
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  if (init > 0.5) {
    uvec2 cell = uvec2(gl_FragCoord.xy / 96.0); uint s = pcg(cell.x * 7919u + cell.y * 104729u);
    vec2 c = (vec2(cell) + vec2(rnd(s), rnd(s))) * 96.0; float r = 4.0 + rnd(s) * 10.0;
    o = vec4((length(gl_FragCoord.xy - c) < r && rnd(s) < 0.55) ? vec2(0.5, 0.25) : vec2(1.0, 0.0), 0.0, 1.0); return;
  }
  vec2 c = at(p);
  vec2 lap = (at(p + ivec2(1, 0)) + at(p - ivec2(1, 0)) + at(p + ivec2(0, 1)) + at(p - ivec2(0, 1))) * 0.2
    + (at(p + ivec2(1, 1)) + at(p - ivec2(1, 1)) + at(p + ivec2(1, -1)) + at(p - ivec2(1, -1))) * 0.05 - c;
  vec2 fk = params(gl_FragCoord.xy);
  float uvv = c.x * c.y * c.y;
  vec2 n = clamp(c + vec2(lap.x - uvv + fk.x * (1.0 - c.x), 0.5 * lap.y + uvv - (fk.x + fk.y) * c.y), 0.0, 1.0);
  if (seed.z > 0.0 && length(gl_FragCoord.xy - seed.xy) < seed.z) n = vec2(0.5, 0.25);
  o = vec4(n, 0.0, 1.0);
}`;
const RD_DRAW = HDR + `
uniform sampler2D S; uniform vec2 res; uniform float time, pal;
out vec4 o;
vec3 p4(float t) { vec3 d = pal < 0.5 ? vec3(0.0, 0.33, 0.67) : pal < 1.5 ? vec3(0.0, 0.15, 0.25) : pal < 2.5 ? vec3(0.6, 0.7, 0.8) : vec3(0.9, 0.2, 0.3); return 0.5 + 0.5 * cos(6.2831853 * (t + d)); }
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec2 c = texelFetch(S, p, 0).xy;
  float gx = texelFetch(S, p + ivec2(1, 0), 0).y - texelFetch(S, p - ivec2(1, 0), 0).y, gy = texelFetch(S, p + ivec2(0, 1), 0).y - texelFetch(S, p - ivec2(0, 1), 0).y;
  vec3 n = normalize(vec3(-gx * 6.0, -gy * 6.0, 1.0)); float dif = max(dot(n, normalize(vec3(-0.5, 0.6, 0.65))), 0.0);
  float v = smoothstep(0.05, 0.4, c.y);
  vec3 base = p4(c.y * 0.9 + gl_FragCoord.x / res.x * 0.5 + time * 0.01);
  o = vec4(mix(vec3(0.01, 0.012, 0.025), base, v) * (0.35 + 0.9 * dif) + base * smoothstep(0.25, 0.45, c.y) * 0.35, 1.0);
}`;
class GLReaction {
  static palettes = ['Arcoíris', 'Coral', 'Laguna', 'Orquídea'];
  static controls = { ls: 'mover pincel', rs: 'desplazar mapa F/k', trig: '− / + pasos por frame', a: 'sembrar' };
  static info = { title: 'Reacción-difusión', short: 'Gray-Scott (WebGL2)', desc: 'Gray-Scott en cada píxel con texturas ping-pong; muchos pasos de simulación por frame (modo WebGL2).' };
  constructor(ctx) { this.ctx = ctx; }
  init() {
    const { gl, W, H, report } = this.ctx;
    this.t = [target(gl, W, H, { fmt: 'RGBA32F', filter: false }), target(gl, W, H, { fmt: 'RGBA32F', filter: false })];
    this.ps = program(gl, VS, RD_STEP, report, 'rd'); this.pd = program(gl, VS, RD_DRAW, report, 'rd-draw');
    this.cur = 0; this.steps = 12; this.brush = [W / 2, H / 2]; this.mapOff = 0; this.init0 = true; this.autoT = 0;
  }
  frame(dt, t) {
    const { gl, W, H, input: inp, pointer: ptr } = this.ctx;
    this.steps = Math.max(1, Math.min(64, Math.round(this.steps * Math.exp((inp.r2 - inp.l2) * dt))));
    if (!(inp.r2 || inp.l2)) { const ms = this.ctx.perf.frameMs; if (ms < 14 && this.steps < 64) this.steps++; else if (ms > 19 && this.steps > 2) this.steps--; }
    this.brush[0] = (this.brush[0] + inp.lx * dt * H * 0.6 + W) % W; this.brush[1] = (this.brush[1] - inp.ly * dt * H * 0.6 + H) % H;
    this.mapOff += inp.rx * dt * 0.8 + (this.chaos ? dt * 0.25 : 0);
    this.autoT += dt;
    let seed = [0, 0, 0, 0];
    if (inp.held.a) seed = [...this.brush, H * 0.015, 0];
    else if (ptr.down) seed = [ptr.x, H - ptr.y, H * 0.015, 0];
    else if (this.autoT > (this.chaos ? 0.15 : 0.9)) { this.autoT = 0; seed = [Math.random() * W, Math.random() * H, H * 0.012, 0]; }
    for (let s = 0; s < this.steps; s++) {
      pass(gl, this.ps, this.t[1 - this.cur], { res: [W, H], time: t, mapOff: this.mapOff, seed: s === 0 ? seed : [0, 0, 0, 0], init: this.init0 ? 1 : 0 }, { S: this.t[this.cur].tex });
      this.init0 = false; this.cur ^= 1;
    }
    pass(gl, this.pd, this.ctx.hdr, { res: [W, H], time: t, pal: this.palette || 0 }, { S: this.t[this.cur].tex });
  }
  onKey(k) { if (k === 'r') this.init0 = true; }
  stats() { const c = this.ctx.W * this.ctx.H, f = this.ctx.perf.fps; return [['celdas', fmt.int(c), true], ['pasos / frame', String(this.steps)], ['actualizaciones de celda / s', fmt.si(c * this.steps * f), true]]; }
  destroy() { const gl = this.ctx.gl; this.t.forEach((x) => freeTarget(gl, x)); gl.deleteProgram(this.ps.p); gl.deleteProgram(this.pd.p); }
}

// ---------------- Sala 4: fluido ----------------
const FL_COMMON = HDR + `uniform vec2 res; uniform float dt; out vec4 o;
vec4 L(sampler2D s, ivec2 p) { return texelFetch(s, clamp(p, ivec2(0), ivec2(res) - 1), 0); }
`;
const FL_FORCE = FL_COMMON + `
uniform sampler2D V; uniform vec4 em[12]; uniform vec4 dir[12]; uniform float ne, vort;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec2 v = L(V, p).xy;
  float cR = L(V, p + ivec2(1, 0)).y - L(V, p - ivec2(1, 0)).y - L(V, p + ivec2(0, 1)).x + L(V, p - ivec2(0, 1)).x;
  float c = 0.5 * cR;
  // confinamiento de vorticidad aproximado con curl vecino
  float cx = abs(0.5 * (L(V, p + ivec2(2, 0)).y - L(V, p).y)) - abs(0.5 * (L(V, p).y - L(V, p - ivec2(2, 0)).y));
  float cy = abs(0.5 * (L(V, p + ivec2(0, 2)).x - L(V, p).x)) - abs(0.5 * (L(V, p).x - L(V, p - ivec2(0, 2)).x));
  vec2 n = vec2(cx, cy) / (length(vec2(cx, cy)) + 1e-5);
  v += vec2(n.y, -n.x) * c * vort * dt;
  vec2 fp = gl_FragCoord.xy;
  for (int i = 0; i < 12; i++) {
    if (float(i) >= ne) break;
    vec2 d = fp - em[i].xy; float w = exp(-dot(d, d) / (em[i].z * em[i].z));
    v += (dir[i].z < 0.5 ? dir[i].xy : vec2(-d.y, d.x) / em[i].z) * em[i].w * w * dt;
  }
  o = vec4(clamp(v, -3000.0, 3000.0), 0.0, 1.0);
}`;
const FL_DIV = FL_COMMON + `uniform sampler2D V; void main() { ivec2 p = ivec2(gl_FragCoord.xy);
  o = vec4(0.5 * (L(V, p + ivec2(1, 0)).x - L(V, p - ivec2(1, 0)).x + L(V, p + ivec2(0, 1)).y - L(V, p - ivec2(0, 1)).y), 0.0, 0.0, 1.0); }`;
const FL_JAC = FL_COMMON + `uniform sampler2D P, D; uniform float decay; void main() { ivec2 p = ivec2(gl_FragCoord.xy);
  o = vec4(decay * 0.25 * (L(P, p + ivec2(1, 0)).x + L(P, p - ivec2(1, 0)).x + L(P, p + ivec2(0, 1)).x + L(P, p - ivec2(0, 1)).x - L(D, p).x), 0.0, 0.0, 1.0); }`;
const FL_PROJ = FL_COMMON + `uniform sampler2D V, P; void main() { ivec2 p = ivec2(gl_FragCoord.xy);
  vec2 v = L(V, p).xy - 0.5 * vec2(L(P, p + ivec2(1, 0)).x - L(P, p - ivec2(1, 0)).x, L(P, p + ivec2(0, 1)).x - L(P, p - ivec2(0, 1)).x);
  if (p.x == 0 || p.x == int(res.x) - 1) v.x = 0.0; if (p.y == 0 || p.y == int(res.y) - 1) v.y = 0.0;
  o = vec4(v, 0.0, 1.0); }`;
const FL_ADV = FL_COMMON + `uniform sampler2D V, Q; uniform vec2 qres; uniform float diss; uniform vec4 em[12]; uniform vec4 col[12]; uniform float ne;
void main() {
  vec2 uv = gl_FragCoord.xy / qres;
  vec2 v = texture(V, uv).xy;
  vec4 c = texture(Q, uv - dt * v / res) * diss;
  vec2 fp = uv * res;
  for (int i = 0; i < 12; i++) { if (float(i) >= ne) break; vec2 d = fp - em[i].xy; c.rgb += col[i].rgb * exp(-dot(d, d) / (em[i].z * em[i].z * 0.6)) * col[i].w * dt; }
  o = vec4(min(c.rgb, vec3(8.0)), 1.0);
}`;
const FL_ADVV = FL_COMMON + `uniform sampler2D V; void main() { vec2 uv = gl_FragCoord.xy / res; vec2 v = texture(V, uv).xy;
  o = vec4(texture(V, uv - dt * v / res).xy * 0.999, 0.0, 1.0); }`;
const FL_DRAW = HDR + `uniform sampler2D Q; uniform vec2 res; out vec4 o; void main() { vec2 uv = gl_FragCoord.xy / res; vec3 c = texture(Q, uv).rgb;
  float l = dot(texture(Q, uv + vec2(2.0 / res.x, 0.0)).rgb - texture(Q, uv - vec2(2.0 / res.x, 0.0)).rgb, vec3(0.33));
  o = vec4(c * (0.8 + l * 0.5) + vec3(0.004, 0.005, 0.01), 1.0); }`;

function hsv(h, s, v) { h = ((h % 1) + 1) % 1; const i = Math.floor(h * 6), f = h * 6 - i, p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s); return [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i % 6]; }
const FPALS = [(h) => hsv(h, 0.85, 1), (h) => hsv(0.02 + 0.12 * Math.sin(h * 6.283) ** 2, 0.9, 1), (h) => hsv(0.5 + 0.12 * Math.sin(h * 6.283), 0.8, 1), (h) => hsv(0.78 + 0.15 * Math.sin(h * 6.283), 0.7, 1)];

class GLFluid {
  static palettes = ['Espectro', 'Fuego', 'Océano', 'Nebulosa'];
  static controls = { ls: 'mover cursor', rs: 'chorro en esa dirección', trig: '− / + fuerza', a: 'lanzar un vórtice' };
  static info = { title: 'Fluido', short: 'Navier-Stokes (WebGL2)', desc: 'Navier-Stokes incompresible con confinamiento de vorticidad e iteraciones de Jacobi para la presión (modo WebGL2).' };
  constructor(ctx, out) { this.ctx = ctx; this.out = out || ctx.hdr; }
  init() {
    const { gl, report } = this.ctx, W = this.out.w, H = this.out.h, SW = Math.ceil(W / 2), SH = Math.ceil(H / 2);
    Object.assign(this, { W, H, SW, SH });
    const T = (w, h, f = true) => target(gl, w, h, { filter: f });
    this.v = [T(SW, SH), T(SW, SH)]; this.p = [T(SW, SH, false), T(SW, SH, false)]; this.d = T(SW, SH, false); this.q = [T(W, H), T(W, H)];
    const P = (fs, n) => program(gl, VS, fs, report, n);
    this.pF = P(FL_FORCE, 'force'); this.pD = P(FL_DIV, 'div'); this.pJ = P(FL_JAC, 'jac'); this.pP = P(FL_PROJ, 'proj'); this.pA = P(FL_ADV, 'adv'); this.pAV = P(FL_ADVV, 'advv'); this.pDr = P(FL_DRAW, 'fdraw');
    this.cursor = [SW / 2, SH / 2]; this.force = 1; this.vort = []; this.iters = 30;
  }
  frame(dt, t) {
    const gl = this.ctx.gl, inp = this.ctx.input, { SW, SH, W, H } = this, k = this.chaos ? 1.8 : 1, s = Math.min(SW, SH);
    const pal = FPALS[this.palette || 0];
    this.force = Math.max(0.2, Math.min(4, this.force * Math.exp((inp.r2 - inp.l2) * dt * 1.2)));
    this.cursor[0] = Math.max(0, Math.min(SW, this.cursor[0] + inp.lx * dt * SH * 0.7)); this.cursor[1] = Math.max(0, Math.min(SH, this.cursor[1] - inp.ly * dt * SH * 0.7));
    if (inp.pressed.a) this.vort.push({ p: [...this.cursor], str: 2600 * this.force * (Math.random() < 0.5 ? -1 : 1), life: 1.6, col: pal(Math.random()) });
    this.vort = this.vort.filter((v) => (v.life -= dt) > 0);
    const em = [];
    for (let i = 0; i < 5; i++) {
      const ph = i * 2.399, sp = (0.13 + 0.04 * i) * k;
      const x = SW * (0.5 + 0.38 * Math.sin(t * sp + ph)), y = SH * (0.5 + 0.36 * Math.sin(t * sp * 1.37 + ph * 1.7));
      const ang = t * 0.5 + i * 1.3 + 1.2 * Math.sin(t * 0.9 + i);
      em.push({ p: [x, y], r: s * 0.018, str: 3800 * this.force * k, dir: [Math.cos(ang), Math.sin(ang), 0], col: [...pal(t * 0.03 + i / 5), 2.2] });
    }
    for (const v of this.vort) em.push({ p: v.p, r: s * 0.06, str: v.str, dir: [0, 0, 1], col: [...v.col, 3 * Math.min(1, v.life)] });
    const rs = Math.hypot(inp.rx, inp.ry);
    if (rs > 0.1) em.push({ p: [...this.cursor], r: s * 0.025, str: 1600 * rs * this.force, dir: [inp.rx / rs, -inp.ry / rs, 0], col: [...pal(t * 0.1), 3] });
    const n = Math.min(12, em.length), E = new Float32Array(48), D = new Float32Array(48), C = new Float32Array(48);
    em.slice(0, n).forEach((e, i) => { E.set([...e.p, e.r, e.str], i * 4); D.set([...e.dir, 0], i * 4); C.set(e.col, i * 4); });
    const h = 1 / 60, rs2 = [SW, SH];
    pass(gl, this.pF, this.v[1], { res: rs2, dt: h, em: E, dir: D, ne: n, vort: this.chaos ? 22 : 12 }, { V: this.v[0].tex });
    pass(gl, this.pD, this.d, { res: rs2, dt: h }, { V: this.v[1].tex });
    for (let i = 0; i < this.iters; i++) { pass(gl, this.pJ, this.p[1], { res: rs2, decay: i === 0 ? 0.8 : 1 }, { P: this.p[0].tex, D: this.d.tex }); this.p.reverse(); }
    pass(gl, this.pP, this.v[0], { res: rs2 }, { V: this.v[1].tex, P: this.p[0].tex });
    pass(gl, this.pAV, this.v[1], { res: rs2, dt: h }, { V: this.v[0].tex }); this.v.reverse();
    pass(gl, this.pA, this.q[1], { res: rs2, qres: [W, H], dt: h, diss: 0.993, em: E, col: C, ne: n }, { V: this.v[0].tex, Q: this.q[0].tex }); this.q.reverse();
    pass(gl, this.pDr, this.out, { res: [W, H] }, { Q: this.q[0].tex });
  }
  stats() { const c = this.SW * this.SH; return [['celdas de velocidad', fmt.int(c), true], ['píxeles de tinte', fmt.int(this.W * this.H)], ['iteraciones Jacobi', String(this.iters)], ['vórtices activos', String(this.vort.length)]]; }
  destroy() { const gl = this.ctx.gl; [...this.v, ...this.p, this.d, ...this.q].forEach((x) => freeTarget(gl, x)); }
}

// ---------------- Sala 1: galaxia ----------------
const GX_UPD = HDR + `
uniform sampler2D P, V; uniform vec4 cA, cB, vA, vB; uniform float dt, kick; uniform vec3 kpos;
layout(location = 0) out vec4 oP; layout(location = 1) out vec4 oV;
vec3 acc(vec3 p, vec3 c, float gm, float vh2) { vec3 d = c - p; float r2 = dot(d, d); float inv = inversesqrt(r2 + 0.006); return d * (gm * inv * inv * inv + vh2 / (r2 + 0.6)); }
void main() {
  ivec2 ij = ivec2(gl_FragCoord.xy); vec4 p = texelFetch(P, ij, 0), v = texelFetch(V, ij, 0);
  for (int k = 0; k < 4; k++) { float fk = float(k) * dt; v.xyz += (acc(p.xyz, cA.xyz + vA.xyz * fk, cA.w, vA.w) + acc(p.xyz, cB.xyz + vB.xyz * fk, cB.w, vB.w)) * dt; p.xyz += v.xyz * dt; }
  if (kick > 0.0) { vec3 d = p.xyz - kpos; float r2 = dot(d, d); v.xyz += d * inversesqrt(r2 + 0.01) * kick * exp(-r2 * 0.6); }
  oP = p; oV = v;
}`;
const GX_VS = `#version 300 es
precision highp float; uniform sampler2D P, V; uniform mat4 vp; uniform float bright, side; out vec3 c;
void main() {
  ivec2 ij = ivec2(gl_VertexID % int(side), gl_VertexID / int(side));
  vec4 p = texelFetch(P, ij, 0), v = texelFetch(V, ij, 0);
  gl_Position = vp * vec4(p.xyz, 1.0); gl_PointSize = 1.0;
  float gal = floor(v.w / 4.0), typ = v.w - gal * 4.0;
  vec3 col = gal > 0.5 ? mix(vec3(1.0, 0.85, 0.6), vec3(0.45, 0.4, 1.0), p.w) : mix(vec3(1.0, 0.72, 0.38), vec3(0.3, 0.55, 1.0), p.w);
  if (typ > 1.5) col = vec3(1.0, 0.7, 0.4) * 0.8; else if (typ > 0.5) col = vec3(1.0, 0.3, 0.5) * 1.6;
  c = col * bright * (0.7 + 0.5 * smoothstep(0.3, 2.0, length(v.xyz)));
}`;
const GX_FS = HDR + `in vec3 c; out vec4 o; void main() { o = vec4(c, 1.0); }`;
class GLGalaxy {
  static palettes = ['Clásica'];
  static controls = { ls: 'orbitar cámara', rs: 'zoom', a: 'onda de choque (supernova)' };
  static info = { title: 'Galaxia de millones', short: 'N-cuerpos (WebGL2)', desc: 'Dos galaxias en colisión: cada estrella integra la gravedad de los núcleos y sus halos oscuros en un shader (modo WebGL2).' };
  constructor(ctx) { this.ctx = ctx; }
  init() {
    const { gl, report } = this.ctx;
    this.side = 1024; this.N = this.side * this.side;
    this.t = [target(gl, this.side, this.side, { fmt: 'RGBA32F', filter: false, mrt: 2 }), target(gl, this.side, this.side, { fmt: 'RGBA32F', filter: false, mrt: 2 })];
    this.pu = program(gl, VS, GX_UPD, report, 'gx-upd'); this.pd = program(gl, GX_VS, GX_FS, report, 'gx-draw');
    const mA = 1, mB = 0.55, M = mA + mB, R = [6.5, 3.6, 1.4], V0 = [-0.5, -0.16, -0.08];
    this.c = { A: { p: v3.mul(R, -mB / M), v: v3.mul(V0, -mB / M), gm: mA, vh2: 0.22, rs: 0.5, n: v3.norm([0.15, 0.25, 1]) }, B: { p: v3.mul(R, mA / M), v: v3.mul(V0, mA / M), gm: mB, vh2: 0.14, rs: 0.36, n: v3.norm([-0.6, 0.45, 0.66]) } };
    const P = new Float32Array(this.N * 4), Vv = new Float32Array(this.N * 4);
    const g = () => Math.sqrt(-2 * Math.log(Math.max(Math.random(), 1e-7))) * Math.cos(6.283 * Math.random());
    for (let i = 0; i < this.N; i++) {
      const B = Math.random() < 0.4, G = B ? this.c.B : this.c.A, n = G.n;
      const e1 = v3.norm(v3.cross(n, Math.abs(n[0]) > 0.8 ? [0, 1, 0] : [1, 0, 0])), e2 = v3.cross(n, e1);
      let r, th, z, typ = 0;
      if (Math.random() < 0.14) { r = G.rs * 0.35 * Math.abs(g()) + 0.03; th = Math.random() * 6.283; z = g() * r * 0.5; typ = 2; }
      else { r = Math.min(G.rs * -Math.log(1 - Math.random()) + 0.08, G.rs * 6); const arm = Math.floor(Math.random() * 2); th = arm * Math.PI + Math.log(r / G.rs + 0.2) * 1.6 + g() * 0.3; z = g() * (0.025 + 0.02 * r); }
      const rad = v3.add(v3.mul(e1, Math.cos(th)), v3.mul(e2, Math.sin(th)));
      const p = v3.add(v3.add(G.p, v3.mul(rad, r)), v3.mul(n, z));
      const v2 = G.gm * r * r / Math.pow(r * r + 0.006, 1.5) + G.vh2 * r * r / (r * r + 0.6);
      const tang = v3.norm(v3.cross(n, rad)), vel = v3.add(G.v, v3.mul(tang, Math.sqrt(v2)));
      P.set([...p, Math.min(1, Math.max(0, r / (G.rs * 3.5) + (Math.random() - 0.5) * 0.5))], i * 4);
      Vv.set([...vel, (B ? 4 : 0) + typ], i * 4);
    }
    upload(gl, this.t[0], 0, P); upload(gl, this.t[0], 1, Vv);
    this.cur = 0; this.simT = 0; this.az = 0; this.zoom = 1;
  }
  accel(p, o) { const d = v3.sub(o.p, p), r2 = v3.dot(d, d), inv = 1 / Math.sqrt(r2 + 0.006); return v3.mul(d, o.gm * inv * inv * inv + o.vh2 / (r2 + 0.6)); }
  frame(dt, t) {
    const { gl, input: inp, W, H } = this.ctx, { A, B } = this.c, h = 0.0025;
    let kick = 0, kpos = [0, 0, 0];
    if (inp.pressed.a) { kick = 1.4; kpos = (Math.random() < 0.5 ? A : B).p; }
    gl.useProgram(this.pu.p);
    pass(gl, this.pu, this.t[1 - this.cur], { cA: [...A.p, A.gm], cB: [...B.p, B.gm], vA: [...A.v, A.vh2], vB: [...B.v, B.vh2], dt: h, kick, kpos }, { P: this.t[this.cur].texs[0], V: this.t[this.cur].texs[1] });
    this.cur ^= 1;
    for (let k = 0; k < 4; k++) {
      const aA = this.accel(A.p, B), aB = this.accel(B.p, A);
      A.v = v3.add(A.v, v3.mul(aA, h)); B.v = v3.add(B.v, v3.mul(aB, h));
      A.p = v3.add(A.p, v3.mul(A.v, h)); B.p = v3.add(B.p, v3.mul(B.v, h));
    }
    this.simT += h * 4;
    this.az += inp.lx * dt * 1.4; this.zoom = Math.max(0.35, Math.min(2.5, this.zoom * Math.exp(inp.ry * dt)));
    const cm = v3.mul(v3.add(v3.mul(A.p, A.gm), v3.mul(B.p, B.gm)), 1 / (A.gm + B.gm));
    const az = t * 0.07 + this.az, el = 0.55 + 0.35 * Math.sin(t * 0.045), dist = 5.4 * this.zoom;
    const eye = v3.add(cm, [Math.cos(az) * Math.cos(el) * dist, Math.sin(el) * dist, Math.sin(az) * Math.cos(el) * dist]);
    const vp = m4.mul(m4.perspective(0.8, W / H, 0.05, 100), m4.lookAt(eye, cm, [0, 1, 0]));
    const hdr = this.ctx.hdr;
    gl.bindFramebuffer(gl.FRAMEBUFFER, hdr.fb); gl.viewport(0, 0, hdr.w, hdr.h);
    gl.clearColor(0.002, 0.003, 0.008, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
    gl.useProgram(this.pd.p);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.t[this.cur].texs[0]); gl.uniform1i(this.pd.u.P, 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.t[this.cur].texs[1]); gl.uniform1i(this.pd.u.V, 1);
    gl.uniformMatrix4fv(this.pd.u.vp, false, vp); setU(gl, this.pd, { bright: 0.03 * 3 * (W * H / 5.9e6), side: this.side });
    gl.drawArrays(gl.POINTS, 0, this.N);
    gl.disable(gl.BLEND);
  }
  stats() { const f = this.ctx.perf.fps; return [['estrellas', fmt.int(this.N), true], ['interacciones / s', fmt.si(this.N * 8 * f)], ['tiempo simulado', this.simT.toFixed(1)]]; }
  destroy() { const gl = this.ctx.gl; this.t.forEach((x) => freeTarget(gl, x)); }
}

// ---------------- Sala 5: physarum ----------------
const PH_UPD = HDR + HASHGL + `
uniform sampler2D A, T; uniform vec2 res; uniform vec4 sp[3]; uniform float frame; uniform vec4 bait, burst;
out vec4 o;
float sense(vec2 p, float a, float d, vec3 w) { vec2 q = mod(p + vec2(cos(a), sin(a)) * d, res); float v = dot(texelFetch(T, ivec2(q), 0).rgb, w);
  if (bait.w > 0.0) { vec2 dd = q - bait.xy; v += bait.w * exp(-dot(dd, dd) / (bait.z * bait.z)); } return v; }
void main() {
  vec4 a = texelFetch(A, ivec2(gl_FragCoord.xy), 0);
  int s = int(a.w); vec4 P = sp[s];
  vec3 w = vec3(-0.55); w[s] = 1.0;
  float F = sense(a.xy, a.z, P.y, w), FL = sense(a.xy, a.z + P.x, P.y, w), FR = sense(a.xy, a.z - P.x, P.y, w);
  uint h = pcg(uint(gl_FragCoord.x) * 1973u + uint(gl_FragCoord.y) * 9277u + uint(frame) * 26699u); float r = rnd(h);
  float ang = a.z;
  if (F > FL && F > FR) {} else if (F < FL && F < FR) ang += (r - 0.5) * 2.0 * P.z; else if (FL > FR) ang += P.z; else ang -= P.z;
  float spd = P.w;
  if (burst.w > 0.0) { vec2 d = a.xy - burst.xy; if (dot(d, d) < burst.z * burst.z) { ang = atan(d.y, d.x); spd *= 5.0; } }
  o = vec4(mod(a.xy + vec2(cos(ang), sin(ang)) * spd, res), ang, a.w);
}`;
const PH_DEP_VS = `#version 300 es
precision highp float; uniform sampler2D A; uniform vec2 res; uniform float side; out vec3 c;
void main() { ivec2 ij = ivec2(gl_VertexID % int(side), gl_VertexID / int(side)); vec4 a = texelFetch(A, ij, 0);
  gl_Position = vec4(a.xy / res * 2.0 - 1.0, 0.0, 1.0); gl_PointSize = 1.0; c = vec3(0.0); c[int(a.w)] = 1.0; }`;
const PH_DEP_FS = HDR + `in vec3 c; out vec4 o; void main() { o = vec4(c, 1.0); }`;
const PH_DIFF = HDR + `uniform sampler2D T, D; uniform vec2 res; uniform float decay; out vec4 o;
void main() { ivec2 p = ivec2(gl_FragCoord.xy), r = ivec2(res); vec3 s = vec3(0.0);
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) s += texelFetch(T, (p + ivec2(x, y) + r) % r, 0).rgb;
  vec3 c = texelFetch(T, p, 0).rgb; o = vec4(min(mix(c, s / 9.0, 0.35) * decay + texelFetch(D, p, 0).rgb * 0.12, vec3(6e4)), 1.0); }`;
const PH_DRAW = HDR + `uniform sampler2D T; uniform vec3 c0, c1, c2; out vec4 o;
void main() { vec3 t = texelFetch(T, ivec2(gl_FragCoord.xy), 0).rgb; vec3 k = 1.0 - exp(-t * 0.35);
  o = vec4(c0 * k.x + c1 * k.y + c2 * k.z + vec3(0.003, 0.004, 0.008), 1.0); }`;
const PPALS = [[[0.1, 0.9, 1.0], [1.0, 0.25, 0.7], [1.0, 0.75, 0.15]], [[0.2, 1.0, 0.4], [0.1, 0.5, 1.0], [0.8, 1.0, 0.9]], [[1.0, 0.35, 0.1], [1.0, 0.8, 0.3], [0.6, 0.1, 0.9]], [[0.9, 0.9, 1.0], [0.4, 0.5, 1.0], [0.9, 0.3, 0.5]]];
class GLPhysarum {
  static palettes = ['Bioluminiscente', 'Bosque', 'Magma', 'Hielo'];
  static controls = { ls: 'mover cebo', rs: 'alcance de sensores', a: 'estallido' };
  static info = { title: 'Vida artificial', short: 'Physarum (WebGL2)', desc: 'Un millón de agentes que huelen el rastro químico, giran, avanzan y depositan feromona (modo WebGL2).' };
  constructor(ctx) { this.ctx = ctx; }
  init() {
    const { gl, W, H, report } = this.ctx;
    this.side = 1024; this.N = this.side * this.side;
    this.a = [target(gl, this.side, this.side, { fmt: 'RGBA32F', filter: false }), target(gl, this.side, this.side, { fmt: 'RGBA32F', filter: false })];
    this.tr = [target(gl, W, H, { filter: false }), target(gl, W, H, { filter: false })]; this.dep = target(gl, W, H, { filter: false });
    const A = new Float32Array(this.N * 4);
    for (let i = 0; i < this.N; i++) { const r = Math.sqrt(Math.random()) * H * 0.42, th = Math.random() * 6.283; A.set([W / 2 + Math.cos(th) * r, H / 2 + Math.sin(th) * r, th + Math.PI, i % 3], i * 4); }
    upload(gl, this.a[0], 0, A);
    this.pu = program(gl, VS, PH_UPD, report, 'ph-upd'); this.pdep = program(gl, PH_DEP_VS, PH_DEP_FS, report, 'ph-dep');
    this.pdf = program(gl, VS, PH_DIFF, report, 'ph-diff'); this.pdr = program(gl, VS, PH_DRAW, report, 'ph-draw');
    this.frameN = 0; this.bait = [W / 2, H / 2]; this.sd = 1;
    this.spec = [[0.6, 18, 0.35, 1.4], [0.4, 26, 0.45, 1.8], [0.9, 12, 0.3, 1.2]];
  }
  frame(dt, t) {
    const { gl, W, H, input: inp } = this.ctx;
    this.frameN++;
    this.bait[0] = Math.max(0, Math.min(W, this.bait[0] + inp.lx * dt * H * 0.5)); this.bait[1] = Math.max(0, Math.min(H, this.bait[1] - inp.ly * dt * H * 0.5));
    this.sd = Math.max(0.3, Math.min(3, this.sd * Math.exp(-inp.ry * dt)));
    const sp = new Float32Array(12); this.spec.forEach((s, i) => sp.set([s[0] * (1 + 0.3 * Math.sin(t * 0.1 + i)), s[1] * this.sd, s[2], s[3] * (this.chaos ? 1.6 : 1)], i * 4));
    const baitOn = Math.abs(inp.lx) + Math.abs(inp.ly) > 0.05 ? 3 : 0;
    pass(gl, this.pu, this.a[1], { res: [W, H], sp, frame: this.frameN, bait: [...this.bait, H * 0.06, baitOn], burst: inp.pressed.a ? [...this.bait, H * 0.18, 1] : [0, 0, 0, 0] }, { A: this.a[0].tex, T: this.tr[0].tex });
    this.a.reverse();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.dep.fb); gl.viewport(0, 0, W, H); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE); gl.useProgram(this.pdep.p);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.a[0].tex); gl.uniform1i(this.pdep.u.A, 0); setU(gl, this.pdep, { res: [W, H], side: this.side });
    gl.drawArrays(gl.POINTS, 0, this.N); gl.disable(gl.BLEND);
    pass(gl, this.pdf, this.tr[1], { res: [W, H], decay: this.chaos ? 0.86 : 0.9 }, { T: this.tr[0].tex, D: this.dep.tex }); this.tr.reverse();
    const P = PPALS[this.palette || 0];
    pass(gl, this.pdr, this.ctx.hdr, { c0: P[0], c1: P[1], c2: P[2] }, { T: this.tr[0].tex });
  }
  stats() { const f = this.ctx.perf.fps; return [['agentes', fmt.int(this.N), true], ['lecturas de sensor / s', fmt.si(this.N * 3 * f)]]; }
  destroy() { const gl = this.ctx.gl; [...this.a, ...this.tr, this.dep].forEach((x) => freeTarget(gl, x)); }
}

// ---------------- Sala 6: path tracer ----------------
const PT_FS = HDR + HASHGL + `
uniform sampler2D ACC; uniform vec3 pos, fwd, right, up; uniform vec2 res; uniform float frame, reset, nS, aperture, focus;
uniform vec4 S[72];
out vec4 o;
vec3 sky(vec3 rd) { vec3 c = mix(vec3(1.0, 0.55, 0.3), vec3(0.08, 0.16, 0.42), pow(clamp(rd.y, 0.0, 1.0), 0.45)); if (rd.y < 0.0) c = vec3(0.25, 0.14, 0.08);
  vec3 sd = normalize(vec3(-0.6, 0.18, -0.75)); return c + vec3(30.0, 18.0, 9.0) * pow(max(dot(rd, sd), 0.0), 180.0); }
vec3 uvec(inout uint s) { float z = rnd(s) * 2.0 - 1.0, a = rnd(s) * 6.2831853, r = sqrt(1.0 - z * z); return vec3(r * cos(a), r * sin(a), z); }
void main() {
  uint seed = pcg(uint(gl_FragCoord.x) * 1973u + uint(gl_FragCoord.y) * 9277u + uint(frame) * 26699u);
  vec2 uv = (vec2(gl_FragCoord.x, res.y - gl_FragCoord.y) + vec2(rnd(seed), rnd(seed)) - 0.5 - 0.5 * res) / res.y;
  vec3 rd = normalize(fwd * 1.6 + right * uv.x - up * uv.y);
  vec3 fp = pos + rd * (focus / dot(rd, fwd)); float la = rnd(seed) * 6.2831853, lr = sqrt(rnd(seed)) * aperture;
  vec3 ro = pos + (right * cos(la) + up * sin(la)) * lr; rd = normalize(fp - ro);
  vec3 thr = vec3(1.0), rad = vec3(0.0);
  for (int b = 0; b < 6; b++) {
    float tb = 1e9; vec3 hn; int mi = -1;
    for (int i = 0; i < 24; i++) {
      if (float(i) >= nS) break;
      vec4 c = S[i * 3]; vec3 oc = ro - c.xyz; float bb = dot(oc, rd), cc = dot(oc, oc) - c.w * c.w, h = bb * bb - cc;
      if (h > 0.0) { float sq = sqrt(h), t = -bb - sq; if (t < 1e-4) t = -bb + sq; if (t > 1e-4 && t < tb) { tb = t; mi = i; hn = (oc + rd * t) / c.w; } }
    }
    bool fl = false;
    if (rd.y < 0.0) { float t = -ro.y / rd.y; if (t > 1e-4 && t < tb) { tb = t; hn = vec3(0, 1, 0); fl = true; mi = -2; } }
    if (mi == -1) { rad += thr * sky(rd); break; }
    vec3 p = ro + rd * tb;
    if (fl) { vec2 q = floor(p.xz * 0.9); bool chk = mod(q.x + q.y, 2.0) > 0.5; rd = normalize(hn + uvec(seed)); thr *= chk ? vec3(0.06) : vec3(0.75); ro = p + hn * 1e-3; continue; }
    vec4 alb = S[mi * 3 + 1], em = S[mi * 3 + 2];
    if (alb.w > 2.5) { rad += thr * em.rgb; break; }
    if (alb.w < 0.5) { rd = normalize(hn + uvec(seed)); thr *= alb.rgb; ro = p + hn * 1e-3; }
    else if (alb.w < 1.5) { rd = normalize(reflect(rd, hn) + uvec(seed) * em.w); thr *= alb.rgb; ro = p + hn * 1e-3; }
    else { bool front = dot(rd, hn) < 0.0; vec3 nn = front ? hn : -hn; float eta = front ? 1.0 / em.w : em.w, ci = min(dot(-rd, nn), 1.0);
      float r0 = (1.0 - em.w) / (1.0 + em.w); r0 *= r0; float fr = r0 + (1.0 - r0) * pow(1.0 - ci, 5.0);
      if (eta * eta * (1.0 - ci * ci) > 1.0 || rnd(seed) < fr) { rd = reflect(rd, nn); ro = p + nn * 1e-3; } else { rd = refract(rd, nn, eta); ro = p - nn * 1e-3; if (!front) thr *= alb.rgb; } }
  }
  vec4 prev = reset > 0.5 ? vec4(0.0) : texelFetch(ACC, ivec2(gl_FragCoord.xy), 0);
  o = prev + vec4(min(rad, vec3(40.0)), 1.0);
}`;
const PT_SHOW = HDR + `uniform sampler2D ACC; out vec4 o; void main() { vec4 a = texelFetch(ACC, ivec2(gl_FragCoord.xy), 0); o = vec4(a.rgb / max(a.w, 1.0), 1.0); }`;
class GLPathTracer {
  static palettes = ['Atardecer'];
  static controls = { ls: 'mover cámara', trig: '− / + apertura', a: 'siguiente toma' };
  static info = { title: 'Path tracer', short: 'Trazado de caminos (WebGL2)', desc: 'Simulación física de la luz con reflexión y refracción; las muestras se acumulan y la imagen converge (modo WebGL2).' };
  constructor(ctx) { this.ctx = ctx; }
  init() {
    const { gl, W, H, report } = this.ctx;
    this.acc = [target(gl, W, H, { fmt: 'RGBA32F', filter: false }), target(gl, W, H, { fmt: 'RGBA32F', filter: false })];
    this.p = program(gl, VS, PT_FS, report, 'pt'); this.ps = program(gl, VS, PT_SHOW, report, 'pt-show');
    const S = [];
    const add = (c, r, alb, typ, em = [0, 0, 0], q = 0) => S.push(...c, r, ...alb, typ, ...em, q);
    add([0, 1, 0], 1, [0.95, 0.98, 1], 2, [0, 0, 0], 1.5); add([-2.25, 1, 0.4], 1, [0.95, 0.95, 0.97], 1); add([2.25, 1, -0.3], 1, [1, 0.72, 0.32], 1, [0, 0, 0], 0.18);
    const cols = [[1, 0.3, 0.1], [0.2, 0.6, 1], [1, 0.2, 0.7], [0.3, 1, 0.5], [1, 0.85, 0.2], [0.6, 0.3, 1]];
    for (let i = 0; i < 16; i++) { const a = i / 16 * 6.283 + 0.2, R = 4.2 + (i % 2) * 0.9, r = 0.3, k = i % 4, col = cols[i % 6];
      if (k === 0) add([Math.cos(a) * R, r, Math.sin(a) * R], r * 0.8, [0, 0, 0], 3, col.map((x) => x * 9)); else add([Math.cos(a) * R, r, Math.sin(a) * R], r, col, k === 1 ? 2 : k === 2 ? 1 : 0, [0, 0, 0], k === 1 ? 1.5 : 0.05); }
    this.S = new Float32Array(72 * 4); this.S.set(S); this.nS = S.length / 12;
    this.cur = 0; this.frameI = 0; this.samples = 0; this.reset = true; this.az = 0.35; this.d = 7.2; this.ap = 0.06; this.shotT = 0;
  }
  frame(dt, t) {
    const { gl, W, H, input: inp } = this.ctx;
    this.shotT += dt;
    if (Math.abs(inp.lx) + Math.abs(inp.ly) > 0.05) { this.az += inp.lx * dt * 0.8; this.d = Math.max(3, Math.min(14, this.d * Math.exp(inp.ly * dt))); this.reset = true; }
    if (Math.abs(inp.r2 - inp.l2) > 0.05) { this.ap = Math.max(0, Math.min(0.5, this.ap + (inp.r2 - inp.l2) * dt * 0.15)); this.reset = true; }
    if (inp.pressed.a || this.shotT > 15) { this.shotT = 0; this.az += 1.9; this.reset = true; }
    const pos = [Math.cos(this.az) * this.d, 0.35 + 0.22 * this.d, Math.sin(this.az) * this.d], tgt = [0, 0.9, 0];
    const fwd = v3.norm(v3.sub(tgt, pos)), right = v3.norm(v3.cross(fwd, [0, 1, 0])), up = v3.cross(right, fwd);
    if (this.reset) this.samples = 0;
    pass(gl, this.p, this.acc[1], { pos, fwd, right, up, res: [W, H], frame: this.frameI++, reset: this.reset ? 1 : 0, nS: this.nS, aperture: this.ap, focus: v3.len(v3.sub(tgt, pos)), S: this.S }, { ACC: this.acc[0].tex });
    this.reset = false; this.acc.reverse(); this.samples++;
    pass(gl, this.ps, this.ctx.hdr, {}, { ACC: this.acc[0].tex });
  }
  stats() { const px = this.ctx.W * this.ctx.H, f = this.ctx.perf.fps; return [['muestras / píxel', fmt.int(this.samples), true], ['caminos / s', fmt.si(px * f)]]; }
  destroy() { const gl = this.ctx.gl; this.acc.forEach((x) => freeTarget(gl, x)); }
}

// ---------------- Sala 7: remix ----------------
const RX_COMP = HDR + `uniform sampler2D F, Q; uniform vec2 res; out vec4 o; void main() { vec2 uv = gl_FragCoord.xy / res;
  vec3 d = texture(Q, uv).rgb; vec3 f = texture(F, uv + (d.rg - d.gb) * 0.01).rgb; o = vec4(f * 0.45 + d * 1.3 + f * d * 0.6, 1.0); }`;
class GLRemix {
  static palettes = ['Espectro', 'Fuego', 'Océano', 'Nebulosa'];
  static controls = { ls: 'guiar el fluido', rs: 'girar el fractal', trig: '− / + fuerza', a: 'vórtice' };
  static info = { title: 'Remix', short: 'Fractal + fluido (WebGL2)', desc: 'Un fractal 3D por raymarching deformado por un fluido Navier-Stokes en tiempo real (modo WebGL2).' };
  constructor(ctx) { this.ctx = ctx; }
  init() {
    const { gl, W, H, report } = this.ctx, hw = Math.ceil(W / 2), hh = Math.ceil(H / 2);
    this.ft = target(gl, hw, hh); this.qt = target(gl, hw, hh);
    this.frac = new GLFractal(this.ctx, this.ft); this.fluid = new GLFluid(this.ctx, this.qt);
    this.frac.distScale = 1.9; this.frac.init(); this.fluid.init();
    this.pc = program(gl, VS, RX_COMP, report, 'rx');
  }
  frame(dt, t) {
    for (const s of [this.frac, this.fluid]) { s.palette = this.palette; s.chaos = this.chaos; }
    this.frac.frame(dt, t); this.fluid.frame(dt, t);
    pass(this.ctx.gl, this.pc, this.ctx.hdr, { res: [this.ctx.W, this.ctx.H] }, { F: this.ft.tex, Q: this.qt.tex });
  }
  stats() { return [...this.frac.stats().slice(0, 2), ...this.fluid.stats().slice(0, 2)]; }
  destroy() { this.frac.destroy(); this.fluid.destroy(); freeTarget(this.ctx.gl, this.ft); freeTarget(this.ctx.gl, this.qt); }
}

export function makeDemos(ctx) {
  const gl = ctx.gl;
  if (!gl.getExtension('EXT_color_buffer_float')) ctx.report('WebGL2 sin EXT_color_buffer_float: algunas salas no funcionarán');
  gl.getExtension('OES_texture_float_linear');
  ctx.hdr = target(gl, ctx.W, ctx.H);
  const tone = program(gl, VS, TONEMAP, ctx.report, 'tonemap');
  // envoltorio común: cada sala pinta en ctx.hdr y aquí se hace el tonemapping a pantalla
  const wrap = (C) => class extends C {
    frame(dt, t) { super.frame(dt, t); pass(gl, tone, null, { exposure: 1.0, res: [ctx.W, ctx.H] }, { src: ctx.hdr.tex }, ctx.W, ctx.H); }
  };
  return [GLGalaxy, GLFractal, GLReaction, GLFluid, GLPhysarum, GLPathTracer, GLRemix].map((C) => { const D = wrap(C); D.info = C.info; D.palettes = C.palettes; D.controls = C.controls; return D; });
}
