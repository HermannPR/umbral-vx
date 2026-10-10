// Matemática del Mandelbrot profundo (sin GPU, sin DOM): sirve al Worker, a la página y a las pruebas en Node.
//  · punto fijo con BigInt: un real es v / 2^P (P bits de fracción)
//  · floatexp complejo { x, y, e }: (x + iy)·2^e con max(|x|,|y|) en [0.5, 1) — exponente sin límite práctico
//  · órbita de referencia, detección de periodo (bola), Newton al núcleo, tamaño del minibrot, tabla BLA y píxel exacto en CPU
// Ver investigacion/ZOOM-INFINITO.md.

export const ZE = -1e6;                 // exponente del cero
export const BAIL = 65536;              // |z|² de escape (radio 256: color suave sin bandas)

// ---------------- floats ----------------
export function ldexp(x, k) {           // x·2^k sin desbordar 2^k
  while (k > 1000) { x *= 2 ** 1000; k -= 1000; }
  while (k < -1000) { x *= 2 ** -1000; k += 1000; }
  return x * 2 ** k;
}
export function frexp(v) {              // v = m·2^e, |m| en [0.5, 1)
  if (v === 0 || !isFinite(v)) return [0, ZE];
  let e = Math.ceil(Math.log2(Math.abs(v)));
  let m = ldexp(v, -e);
  if (Math.abs(m) >= 1) { m /= 2; e++; } else if (Math.abs(m) < 0.5) { m *= 2; e--; }
  return [m, e];
}
export const logadd = (a, b) => {       // log2(2^a + 2^b)
  if (a === -Infinity) return b; if (b === -Infinity) return a;
  const M = Math.max(a, b); return M + Math.log2(1 + 2 ** (Math.min(a, b) - M));
};

// ---------------- floatexp complejo ----------------
export const fe = {
  n(x, y, e) {
    const M = Math.max(Math.abs(x), Math.abs(y));
    if (M === 0 || !isFinite(M)) return { x: 0, y: 0, e: ZE };
    const k = frexp(M)[1];
    return { x: ldexp(x, -k), y: ldexp(y, -k), e: e + k };
  },
  num(x, y = 0) { return fe.n(x, y, 0); },
  mul(a, b) { return fe.n(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x, a.e + b.e); },
  add(a, b) {
    if (a.e < b.e) [a, b] = [b, a];
    const d = b.e - a.e; if (d < -80) return a;
    return fe.n(a.x + ldexp(b.x, d), a.y + ldexp(b.y, d), a.e);
  },
  neg(a) { return { x: -a.x, y: -a.y, e: a.e }; },
  div(a, b) {
    const q = b.x * b.x + b.y * b.y;
    return fe.n((a.x * b.x + a.y * b.y) / q, (a.y * b.x - a.x * b.y) / q, a.e - b.e);
  },
  l2(a) { const h = Math.hypot(a.x, a.y); return h === 0 ? -Infinity : a.e + Math.log2(h); },   // log2 |a|
  arg(a) { return Math.atan2(a.y, a.x); },
  re(a) { return ldexp(a.x, a.e); }, im(a) { return ldexp(a.y, a.e); },
};

// ---------------- punto fijo (BigInt) ----------------
export function bitLen(n) {
  if (n < 0n) n = -n; if (n === 0n) return 0;
  const s = n.toString(16);
  return (s.length - 1) * 4 + (32 - Math.clz32(parseInt(s[0], 16)));
}
// real en punto fijo → [m, e]
export function fixToFE1(v, P) {
  if (v === 0n) return [0, ZE];
  const bl = bitLen(v), sh = bl - 60;
  const n = sh > 0 ? Number(v >> BigInt(sh)) : Number(v);
  const [m, k] = frexp(n);
  return [m, k + Math.max(sh, 0) - P];
}
export function fixToFE(x, y, P) {
  const [mx, ex] = fixToFE1(x, P), [my, ey] = fixToFE1(y, P);
  const e = Math.max(ex, ey);
  return { x: ex === ZE ? 0 : ldexp(mx, ex - e), y: ey === ZE ? 0 : ldexp(my, ey - e), e };
}
export function fe1ToFix(m, e, P) {     // m·2^e → BigInt con P bits
  if (m === 0 || e <= ZE / 2) return 0n;
  const mi = BigInt(Math.round(m * 2 ** 53)), s = e - 53 + P;
  return s >= 0 ? mi << BigInt(s) : mi >> BigInt(-s);
}
export const feToFix = (a, P) => [fe1ToFix(a.x, a.e, P), fe1ToFix(a.y, a.e, P)];
export const numToFix = (v, P) => { const [m, e] = frexp(v); return fe1ToFix(m, e, P); };
export const cambiaP = (v, P0, P1) => (P1 >= P0 ? v << BigInt(P1 - P0) : v >> BigInt(P0 - P1));
export function fixToNum(v, P) { const [m, e] = fixToFE1(v, P); return e === ZE ? 0 : ldexp(m, e); }

// v·2^sh redondeado, como BigInt (sh puede pasar de 1023: desplazamientos de píxel a cualquier profundidad)
export function aBig(v, sh) {
  const si = Math.floor(sh), w = Math.round(v * 2 ** (sh - si) * 2 ** 60);
  const b = BigInt(w), k = si - 60;
  return k >= 0 ? b << BigInt(k) : b >> BigInt(-k);
}
// decimal "−0.7436…" ↔ punto fijo
export function decToFix(s, P) {
  s = String(s).trim().replace('−', '-');
  let neg = false; if (s[0] === '-') { neg = true; s = s.slice(1); } else if (s[0] === '+') s = s.slice(1);
  let exp10 = 0; const iE = s.search(/e/i);
  if (iE >= 0) { exp10 = parseInt(s.slice(iE + 1), 10); s = s.slice(0, iE); }
  const [ip, fp = ''] = s.split('.');
  let num = BigInt((ip || '0') + fp) << BigInt(P);
  const k = fp.length - exp10;
  if (k >= 0) num = num / 10n ** BigInt(k); else num = num * 10n ** BigInt(-k);
  return neg ? -num : num;
}
export function fixToDec(v, P, dig) {
  const neg = v < 0n; if (neg) v = -v;
  const ip = v >> BigInt(P);
  const frac = ((v - (ip << BigInt(P))) * 10n ** BigInt(dig)) >> BigInt(P);
  return (neg ? '-' : '') + ip.toString() + '.' + frac.toString().padStart(dig, '0');
}
// bits de fracción que pide un radio de vista 2^lr (con colchón)
export const bitsPara = (lr, extra = 96) => Math.max(96, Math.ceil(-lr) + extra);

// ---------------- órbita de referencia ----------------
// Guarda Z_0..Z_{N-1} como floatexp f32 (x, y, e, 0). Detecta además el periodo con el método de la bola:
// r_{n+1} = r_n (2|z_n| + r_n) + r_0; el primer n ≥ 1 con |z_n| < r_n es el periodo del átomo dominante.
export function orbita(cx, cy, P, maxIter, lr0 = -Infinity, guardar = true, alto = 0) {
  const Pn = BigInt(P), P1 = Pn - 1n, cuatro = 4n << Pn, S = BigInt(P - 62);
  const Z = guardar ? new Float32Array(4 * maxIter) : null;
  let x = 0n, y = 0n, lr = -Infinity, periodo = 0, N = maxIter, escapo = false;
  for (let n = 0; n < maxIter; n++) {
    // z_n en floatexp (atajo cuando z no es diminuto)
    let zx, zy, ze;
    const hx = Number(x >> S), hy = Number(y >> S);
    if (Math.abs(hx) + Math.abs(hy) >= 2 ** 40) {
      const M = Math.max(Math.abs(hx), Math.abs(hy)), k = frexp(M)[1];
      zx = ldexp(hx, -k); zy = ldexp(hy, -k); ze = k - 62;
    } else { const f = fixToFE(x, y, P); zx = f.x; zy = f.y; ze = f.e; }
    if (Z) { const o = 4 * n; Z[o] = zx; Z[o + 1] = zy; Z[o + 2] = ze; }
    const lz = zx === 0 && zy === 0 ? -Infinity : ze + Math.log2(Math.hypot(zx, zy));
    if (n >= 1 && !periodo && lz < lr) { periodo = n; if (alto === 1) { N = n + 1; break; } }
    lr = n === 0 ? lr0 : logadd(lr + logadd(1 + lz, lr), lr0);
    const x2 = (x * x) >> Pn, y2 = (y * y) >> Pn;
    if (x2 + y2 > cuatro) { N = n + 1; escapo = true; break; }
    const xy = (x * y) >> P1;
    x = x2 - y2 + cx; y = xy + cy;
  }
  return { Z: Z ? Z.subarray(0, 4 * N) : null, N, escapo, periodo };
}

// ---------------- Newton al núcleo de periodo p ----------------
// c ← c − z_p / (dz_p/dc), con z en BigInt y dz en floatexp (crece a 10^600 y más)
export function nucleo(cx, cy, P, p, lr0, pasos = 64, diag = null) {
  const Pn = BigInt(P), P1 = Pn - 1n, uno = fe.num(1), lim = 1024n << Pn;
  const x0 = cx, y0 = cy;
  let lprev = Infinity;
  for (let it = 0; it < pasos; it++) {
    let x = 0n, y = 0n, dz = { x: 0, y: 0, e: ZE };
    for (let k = 0; k < p; k++) {
      const z = fixToFE(x, y, P);
      dz = fe.add(fe.mul({ x: z.x, y: z.y, e: z.e + 1 }, dz), uno);
      const x2 = (x * x) >> Pn, y2 = (y * y) >> Pn, xy = (x * y) >> P1;
      if (x2 + y2 > lim) return null;               // escapó: este c no está cerca de un núcleo
      x = x2 - y2 + cx; y = xy + cy;
    }
    if (dz.x === 0 && dz.y === 0) return null;
    let d = fe.neg(fe.div(fixToFE(x, y, P), dz));
    const lpaso = fe.l2(d);
    if (lpaso > lr0 - 1) d = { x: d.x, y: d.y, e: d.e - Math.ceil(lpaso - lr0 + 1) };   // Newton amortiguado: nunca más de medio radio
    const [dx, dy] = feToFix(d, P);
    cx += dx; cy += dy;
    const ld = fe.l2(d);
    const lejos = fe.l2(fixToFE(cx - x0, cy - y0, P));
    if (diag) diag.push([it, +(ld * 0.30103).toFixed(1), +(lejos * 0.30103).toFixed(2)]);
    if (!(lejos <= lr0 + 3)) return null;            // se fue a otro lado
    // convergencia cuadrática hasta el piso de precisión: listo cuando ya no baja
    if (ld < -P + 16 || (dx === 0n && dy === 0n) || (ld < lr0 - 40 && ld > lprev - 2)) return { cx, cy, pasos: it + 1, ldz: fe.l2(dz) };
    lprev = ld;
  }
  return null;
}

// tamaño complejo del minibrot (mathr): l ← 2 z_j l, b ← b + 1/l (j = 1..p−1); tamaño = 1/(b l²).
// Un punto w del Mandelbrot principal aparece cerca del minibrot en c ≈ núcleo + tamaño·w.
export function tamaño(cx, cy, P, p) {
  const Pn = BigInt(P), P1 = Pn - 1n, uno = fe.num(1);
  let x = 0n, y = 0n, l = uno, b = uno;
  for (let j = 1; j < p; j++) {
    const x2 = (x * x) >> Pn, y2 = (y * y) >> Pn, xy = (x * y) >> P1;
    x = x2 - y2 + cx; y = xy + cy;
    const z = fixToFE(x, y, P);
    l = fe.mul({ x: z.x, y: z.y, e: z.e + 1 }, l);
    b = fe.add(b, fe.div(uno, l));
  }
  return fe.div(uno, fe.mul(b, fe.mul(l, l)));
}

// ---------------- tabla BLA ----------------
// Nivel 0: un paso por iteración m (A = 2Z_m, B = 1, R = max(0, ε|Z_m| − |δc|máx/(|2Z_m|+1))).
// Nivel k+1: combina vecinos sin solaparse: A = A_y A_x; B = A_y B_x + B_y; R = min(R_x, max(0, (R_y − |B_x||δc|)/|A_x|)).
// Salida: 8 floats por entrada (A.x, A.y, A.e, log2 R | B.x, B.y, B.e, 0) y desplazamiento/cantidad por nivel.
export function tablaBLA(Z, N, ldc, lEps = -24) {
  const n0 = Math.max(0, N - 1);
  const niveles = [];
  let A = new Array(n0), B = new Array(n0), R = new Float64Array(n0), LB = new Float64Array(n0), LA = new Float64Array(n0);
  const b1 = fe.num(1);
  for (let m = 0; m < n0; m++) {
    const z = { x: Z[4 * m], y: Z[4 * m + 1], e: Z[4 * m + 2] };
    const lz = fe.l2(z);
    A[m] = fe.n(z.x, z.y, z.e + 1); B[m] = b1; LA[m] = lz + 1; LB[m] = 0;
    const absA = lz === -Infinity ? 0 : 2 ** Math.min(lz + 1, 1000);
    const a = lEps + lz, b = ldc - Math.log2(absA + 1);
    R[m] = lz === -Infinity || a <= b ? -Infinity : a + Math.log2(1 - 2 ** (b - a));
  }
  niveles.push({ A, B, R, LA, LB, n: n0 });
  while (niveles[niveles.length - 1].n >= 2 && niveles.length < 24) {
    const p = niveles[niveles.length - 1], n = p.n >> 1;
    const A2 = new Array(n), B2 = new Array(n), R2 = new Float64Array(n), LA2 = new Float64Array(n), LB2 = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      const x = 2 * k, y = x + 1;
      A2[k] = fe.mul(p.A[y], p.A[x]);
      B2[k] = fe.add(fe.mul(p.A[y], p.B[x]), p.B[y]);
      LA2[k] = fe.l2(A2[k]); LB2[k] = fe.l2(B2[k]);
      const t = p.LB[x] + ldc, ry = p.R[y];
      let v = -Infinity;
      if (ry > t && p.LA[x] > -Infinity) v = ry + Math.log2(1 - 2 ** (t - ry)) - p.LA[x];
      R2[k] = Math.min(p.R[x], v);
    }
    niveles.push({ A: A2, B: B2, R: R2, LA: LA2, LB: LB2, n });
  }
  let total = 0; const meta = new Uint32Array(64);
  niveles.forEach((L, i) => { meta[i] = total; meta[32 + i] = L.n; total += L.n; });
  const datos = new Float32Array(Math.max(8, total * 8));
  niveles.forEach((L, i) => {
    let o = meta[i] * 8;
    for (let k = 0; k < L.n; k++, o += 8) {
      const a = L.A[k], b = L.B[k], r = L.R[k];
      datos[o] = a.x; datos[o + 1] = a.y; datos[o + 2] = a.e; datos[o + 3] = r === -Infinity ? -1e30 : r;
      datos[o + 4] = b.x; datos[o + 5] = b.y; datos[o + 6] = b.e;
    }
  });
  return { datos, meta, niveles: niveles.length, total };
}

// ---------------- píxel exacto en CPU (referencia de las pruebas) ----------------
// Iteración directa en punto fijo, sin perturbación: μ = n + 1 − log2(½ ln|z|²), o −1 si no escapa.
export function pixelExacto(cx, cy, P, maxIter) {
  const Pn = BigInt(P), P1 = Pn - 1n, lim = BigInt(BAIL) << Pn;
  let x = 0n, y = 0n;
  for (let n = 0; n < maxIter; n++) {
    const x2 = (x * x) >> Pn, y2 = (y * y) >> Pn;
    if (x2 + y2 > lim) {
      const r2 = fixToNum(x2 + y2, P);
      return Math.max(0, n + 1 - Math.log2(0.5 * Math.log(r2)));
    }
    const xy = (x * y) >> P1;
    x = x2 - y2 + cx; y = xy + cy;
  }
  return -1;
}

// Periodo por el método de la caja (curva de Jordan, Munafo; «box period» de KF): se itera el cuadrado de lado 2·2^lr
// alrededor del centro (las 4 esquinas por perturbación en floatexp) y el periodo es el primer n en que la imagen
// del cuadrado rodea al 0. Más fino que la bola, que sobreestima y suele dar el periodo de un átomo de afuera.
export function periodoCaja(cx, cy, P, lr, maxP = 200000) {
  const Pn = BigInt(P), P1 = Pn - 1n, cuatro = 4n << Pn;
  const sg = [[1, 1], [-1, 1], [-1, -1], [1, -1]];
  const dc = sg.map(([a, b]) => fe.n(a, b, lr));
  const d = dc.map(() => ({ x: 0, y: 0, e: ZE }));
  let x = 0n, y = 0n;
  for (let n = 0; n < maxP; n++) {
    const Z = fixToFE(x, y, P);
    if (n >= 1) {
      // esquinas z = Z + δ, llevadas a un exponente común
      const zs = d.map((q) => fe.add(Z, q));
      const E = Math.max(...zs.map((z) => z.e));
      // una esquina escapó hace rato: su exponente se duplica en cada paso y ldexp(x, z.e − E) se colgaba
      if (E > 1000) return 0;
      const pts = zs.map((z) => [ldexp(z.x, z.e - E), ldexp(z.y, z.e - E)]);
      let dentro = false;
      for (let i = 0, j = 3; i < 4; j = i++) {
        const [xi, yi] = pts[i], [xj, yj] = pts[j];
        if ((yi > 0) !== (yj > 0) && 0 < (xj - xi) * (0 - yi) / (yj - yi) + xi) dentro = !dentro;
      }
      if (dentro) return n;
    }
    const x2 = (x * x) >> Pn, y2 = (y * y) >> Pn;
    if (x2 + y2 > cuatro) return 0;
    const Zm2 = { x: Z.x, y: Z.y, e: Z.e + 1 };
    for (let k = 0; k < 4; k++) d[k] = fe.add(fe.add(fe.mul(Zm2, d[k]), fe.mul(d[k], d[k])), dc[k]);
    const xy = (x * y) >> P1;
    x = x2 - y2 + cx; y = xy + cy;
  }
  return 0;
}

// Busca el minibrot dominante cerca de (cx, cy) dentro de un radio 2^lr: periodo → Newton → tamaño.
// Si Newton se va lejos o cae en un divisor del periodo, achica el radio y vuelve a intentar.
export function buscarMinibrot(cx, cy, P, lr, maxP = 200000, intentos = 8) {
  for (let k = 0; k < intentos; k++, lr -= 1.5) {
    const periodo = periodoCaja(cx, cy, P, lr, maxP);
    if (!periodo) continue;
    let nu = nucleo(cx, cy, P, periodo, lr);
    if (!nu) continue;
    let s = tamaño(nu.cx, nu.cy, P, periodo), ls = fe.l2(s);
    if (!isFinite(ls) || ls > lr + 3) continue;
    // el minibrot puede ser mucho más chico que la vista (tamaño ~ radio²): afinar el núcleo con más bits
    const Pn = Math.max(P, Math.ceil(-ls) + 80);
    let Pf = P;
    if (Pn > P) {
      const nu2 = nucleo(cambiaP(nu.cx, P, Pn), cambiaP(nu.cy, P, Pn), Pn, periodo, ls + 6);
      if (nu2) { nu = nu2; Pf = Pn; s = tamaño(nu.cx, nu.cy, Pn, periodo); ls = fe.l2(s); }
    }
    return { cx: nu.cx, cy: nu.cy, P: Pf, periodo, tam: s, ltam: ls, lr };
  }
  return null;
}

// valles del Mandelbrot principal: el autopiloto los visita en cada minibrot (c ≈ núcleo + tamaño·w)
export const VALLES = [[-0.7436439, 0.1318259], [0.2860, 0.0115], [-0.0880, 0.6540], [-0.7453, 0.1127], [-1.2557, 0.3815], [0.3750, 0.2160]];
