// Utilidades compartidas: matrices, WGSL comunes, formato de números.
export const FS_VERT = /* wgsl */`
struct VO { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
@vertex fn vs(@builtin(vertex_index) i: u32) -> VO {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var o: VO;
  o.pos = vec4f(p[i], 0.0, 1.0);
  o.uv = vec2f(p[i].x * 0.5 + 0.5, 0.5 - p[i].y * 0.5);
  return o;
}
`;

export const HASH = /* wgsl */`
fn pcg(v: u32) -> u32 {
  let s = v * 747796405u + 2891336453u;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
fn rnd(s: ptr<function, u32>) -> f32 {
  *s = pcg(*s);
  return f32(*s) * (1.0 / 4294967296.0);
}
`;

export const fmt = {
  int: (n) => Math.round(n).toLocaleString('es-ES'),
  si(n, unit = '') {
    const a = Math.abs(n);
    if (a >= 1e12) return (n / 1e12).toFixed(2) + ' T' + unit;
    if (a >= 1e9) return (n / 1e9).toFixed(2) + ' G' + unit;
    if (a >= 1e6) return (n / 1e6).toFixed(2) + ' M' + unit;
    if (a >= 1e3) return (n / 1e3).toFixed(1) + ' k' + unit;
    return n.toFixed(0) + ' ' + unit;
  },
};

export const v3 = {
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  mul: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  len: (a) => Math.hypot(a[0], a[1], a[2]),
  norm: (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; },
  mix: (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t],
};

export const m4 = {
  perspective(fovy, aspect, near, far) {
    const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
    return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, far * nf, -1, 0, 0, far * near * nf, 0]);
  },
  lookAt(eye, center, up) {
    const z = v3.norm(v3.sub(eye, center));
    const x = v3.norm(v3.cross(up, z));
    const y = v3.cross(z, x);
    return new Float32Array([x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0,
      -v3.dot(x, eye), -v3.dot(y, eye), -v3.dot(z, eye), 1]);
  },
  mul(a, b) {
    const o = new Float32Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
      let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = s;
    }
    return o;
  },
};

// Controlador de carga: sube/baja un parámetro para mantener ~60 FPS.
export class Governor {
  constructor({ min, max, value, stepUp, stepDown, lowMs = 12.5, highMs = 16.0, every = 0.6 }) {
    Object.assign(this, { min, max, value, stepUp, stepDown, lowMs, highMs, every });
    this.acc = 0; this.locked = false;
  }
  // ms: tiempo GPU (o intervalo de frame) suavizado
  update(dt, ms) {
    this.acc += dt;
    if (this.acc < this.every || ms == null) return false;
    this.acc = 0;
    const old = this.value;
    if (ms < this.lowMs && this.value < this.max) this.value = Math.min(this.max, this.stepUp(this.value));
    else if (ms > this.highMs && this.value > this.min) this.value = Math.max(this.min, this.stepDown(this.value));
    return this.value !== old;
  }
}
