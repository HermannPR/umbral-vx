// Mapa de una canción: se escucha completa una vez (offline, sin congelar la página) y queda una partitura
// de lo que pasa en cada instante. Así la imagen no adivina: sabe dónde cae cada pulso, cuánto falta para el
// drop y en qué tonalidad está la música. Análisis propio, sin dependencias, con las recetas clásicas:
//   · espectro por FFT (ventana de Hann, 2048 muestras, salto de ~11.6 ms);
//   · golpes por flujo espectral (log) en tres bandas, con umbral adaptativo y picos locales;
//   · tempo por autocorrelación de la envolvente de golpes con preferencia suave por ~120 BPM, y pulsos con
//     fase por programación dinámica (D. Ellis, «Beat Tracking by Dynamic Programming», 2007);
//   · tiempo fuerte del compás: la fase de 4 con más graves;
//   · secciones por energía por compás: drop = salto de energía con graves; subida = los compases antes del
//     drop; pausa = valle; hueco = el silencio de medio compás antes del drop;
//   · croma de 12 notas → tonalidad con los perfiles de Krumhansl-Kessler, compás por compás.
const NFFT = 2048;
const BANDAS = [[30, 150], [150, 2000], [2000, 12000]];
const NOTAS = ['Do', 'Do♯', 'Re', 'Mi♭', 'Mi', 'Fa', 'Fa♯', 'Sol', 'La♭', 'La', 'Si♭', 'Si'];
// perfiles de Krumhansl-Kessler (mayor y menor), desde la tónica
const KK_MAY = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KK_MEN = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const ceder = () => new Promise((r) => setTimeout(r, 0));

// tonalidad de un croma de 12: {pc, menor, conf}; pc = tónica (0 = Do)
export function tonalidad(cr) {
  let m = 0; for (let i = 0; i < 12; i++) m += cr[i];
  if (m <= 1e-9) return { pc: 0, menor: false, conf: 0 };
  const corr = (perfil, k) => {
    let mx = 0, my = 0; for (let i = 0; i < 12; i++) { mx += cr[(i + k) % 12]; my += perfil[i]; }
    mx /= 12; my /= 12;
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < 12; i++) { const a = cr[(i + k) % 12] - mx, b = perfil[i] - my; sxy += a * b; sxx += a * a; syy += b * b; }
    return sxy / Math.sqrt(sxx * syy + 1e-12);
  };
  let mejor = -2, seg = -2, pc = 0, menor = false;
  for (let k = 0; k < 12; k++) for (const [p, mn] of [[KK_MAY, false], [KK_MEN, true]]) {
    const c = corr(p, k);
    if (c > mejor) { seg = mejor; mejor = c; pc = k; menor = mn; } else if (c > seg) seg = c;
  }
  return { pc, menor, conf: clamp((mejor - seg) * 4 + mejor * 0.5, 0, 1) };
}
// posición en la rueda de quintas (0..11); las relativas (La menor / Do mayor) comparten color
export function quinta(pc, menor) { const t = menor ? (pc + 3) % 12 : pc; return (t * 7) % 12; }
export function nombreTono(pc, menor) { return NOTAS[pc] + (menor ? ' menor' : ' mayor'); }

// FFT compleja radix-2 en el lugar
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang), h = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < h; k++) {
        const a = i + k, b = a + h;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
}
// media móvil centrada (ventana 2r+1) por suma acumulada
function mediaMovil(x, r) {
  const n = x.length, s = new Float64Array(n + 1), o = new Float32Array(n);
  for (let i = 0; i < n; i++) s[i + 1] = s[i] + x[i];
  for (let i = 0; i < n; i++) { const a = Math.max(0, i - r), b = Math.min(n, i + r + 1); o[i] = (s[b] - s[a]) / (b - a); }
  return o;
}
function cuantil(x, q) { const s = Float32Array.from(x).sort(); return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : 0; }

// picos de una curva de flujo: máximo local, sobre media + k·desviación de ±0.5 s, con periodo refractario
function picos(f, fps, k, refr, off) {
  const r = Math.round(fps * 0.5), m = mediaMovil(f, r), f2 = new Float32Array(f.length);
  for (let i = 0; i < f.length; i++) f2[i] = f[i] * f[i];
  const m2 = mediaMovil(f2, r), t = [], s = [];
  let ult = -1e9;
  const w = Math.max(1, Math.round(fps * 0.03));
  for (let i = w; i < f.length - w; i++) {
    const sd = Math.sqrt(Math.max(0, m2[i] - m[i] * m[i]));
    const um = m[i] + k * sd + 1e-6;
    if (f[i] <= um || f[i] < m[i] * 1.3) continue;
    let max = true; for (let j = i - w; j <= i + w; j++) if (f[j] > f[i]) { max = false; break; }
    if (!max || (i - ult) / fps < refr) continue;
    ult = i; t.push(i / fps + off); s.push(f[i] / um);
  }
  // fuerza relativa: la mediana de la canción vale 1
  const med = cuantil(s, 0.5) || 1;
  return { t: Float32Array.from(t), s: Float32Array.from(s, (v) => v / med) };
}

export async function analizar(buf, { alAvanzar = () => {}, cancelado = () => false } = {}) {
  const sr = buf.sampleRate, L = buf.length, nc = Math.min(2, buf.numberOfChannels);
  const ch = []; for (let c = 0; c < nc; c++) ch.push(buf.getChannelData(c));
  const hop = sr > 70000 ? 1024 : 512, fps = sr / hop;
  // cada cuadro se fecha en el centro de su ventana (si no, todo llegaría ~23 ms antes)
  const off = NFFT / 2 / sr;
  const nF = Math.max(1, Math.floor((L - NFFT) / hop) + 1), nb = NFFT / 2;
  const hz = sr / NFFT;
  const ven = new Float32Array(NFFT); for (let i = 0; i < NFFT; i++) ven[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (NFFT - 1));
  const rangos = BANDAS.map(([a, b]) => [Math.max(1, Math.floor(a / hz)), Math.min(nb - 1, Math.ceil(b / hz))]);
  // a qué nota cae cada bin (55 Hz – 4.2 kHz); los bins graves pesan menos (poca resolución)
  const pcBin = new Int8Array(nb).fill(-1), pesoBin = new Float32Array(nb);
  for (let i = 1; i < nb; i++) { const f = i * hz; if (f < 80 || f > 4200) continue; pcBin[i] = ((Math.round(12 * Math.log2(f / 440)) + 69) % 12 + 12) % 12; pesoBin[i] = f < 160 ? 0.5 : 1; }
  const E = [0, 1, 2].map(() => new Float32Array(nF)), FL = [0, 1, 2].map(() => new Float32Array(nF));
  const rms = new Float32Array(nF), cent = new Float32Array(nF), croma = new Float32Array(nF * 12);
  const re = new Float32Array(NFFT), im = new Float32Array(NFFT), lm0 = new Float32Array(nb), lm = new Float32Array(nb), mg = new Float32Array(nb);
  let tCeder = performance.now();
  for (let f = 0; f < nF; f++) {
    const o = f * hop;
    let e2 = 0;
    for (let i = 0; i < NFFT; i++) {
      let v = 0; for (let c = 0; c < nc; c++) v += ch[c][o + i] || 0;
      v /= nc; e2 += v * v; re[i] = v * ven[i]; im[i] = 0;
    }
    rms[f] = Math.sqrt(e2 / NFFT);
    fft(re, im);
    let sm = 0, sf = 0;
    for (let i = 1; i < nb; i++) {
      const m = mg[i] = Math.sqrt(re[i] * re[i] + im[i] * im[i]);
      lm[i] = Math.log(1 + 1000 * m); sm += m; sf += m * i;
    }
    // croma solo con picos del espectro (los parciales de las notas, no el ruido ni el barrido del bombo)
    for (let i = 2; i < nb - 1; i++) { const p = pcBin[i]; if (p >= 0 && mg[i] > mg[i - 1] && mg[i] >= mg[i + 1]) croma[f * 12 + p] += mg[i] * pesoBin[i]; }
    cent[f] = sm > 1e-9 ? (sf / sm) * hz : 0;
    for (let k = 0; k < 3; k++) {
      const [a, b] = rangos[k]; let e = 0, fl = 0;
      for (let i = a; i <= b; i++) { e += Math.exp(lm[i]) - 1; const d = lm[i] - lm0[i]; if (d > 0) fl += d; }
      E[k][f] = e / (b - a + 1); FL[k][f] = fl / (b - a + 1);
    }
    lm0.set(lm);
    if (performance.now() - tCeder > 12) {
      if (cancelado()) return null;
      alAvanzar((f / nF) * 0.85); await ceder(); tCeder = performance.now();
    }
  }
  if (cancelado()) return null;

  // ---- bandas normalizadas (el 97 % de la canción llena la escala) ----
  const bandas = E.map((e) => { const p = cuantil(e, 0.97) || 1e-9; return Float32Array.from(e, (v) => clamp(v / p, 0, 1.25)); });
  const pR = cuantil(rms, 0.97) || 1e-9, energia = Float32Array.from(rms, (v) => clamp(v / pR, 0, 1.25));
  const c0 = cuantil(cent, 0.05), c1 = cuantil(cent, 0.95) || 1, brillo = mediaMovil(Float32Array.from(cent, (v) => clamp((v - c0) / Math.max(1, c1 - c0), 0, 1)), Math.round(fps * 0.3));

  // ---- golpes por banda ----
  const golpes = picos(FL[0], fps, 1.1, 0.11, off), cajas = picos(FL[1], fps, 1.2, 0.09, off), agudos = picos(FL[2], fps, 1.2, 0.07, off);

  // ---- tempo y pulsos ----
  const on = new Float32Array(nF);
  for (let f = 0; f < nF; f++) on[f] = FL[0][f] * 1.2 + FL[1][f] + FL[2][f] * 0.6;
  const mo = mediaMovil(on, Math.round(fps * 0.4));
  let sd = 0; for (let f = 0; f < nF; f++) { on[f] = Math.max(0, on[f] - mo[f]); sd += on[f] * on[f]; }
  sd = Math.sqrt(sd / nF) || 1; for (let f = 0; f < nF; f++) on[f] /= sd;
  const lagMin = Math.floor((60 / 200) * fps), lagMax = Math.ceil((60 / 60) * fps), ac = new Float32Array(lagMax + 2);
  for (let l = lagMin; l <= lagMax + 1; l++) { let s = 0; for (let i = 0; i + l < nF; i++) s += on[i] * on[i + l]; ac[l] = s / (nF - l); }
  let mejor = -1, lag = Math.round((60 / 120) * fps);
  for (let l = lagMin; l <= lagMax; l++) {
    const bpm = (60 * fps) / l, w = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 0.9, 2));
    const v = ac[l] * w;
    if (v > mejor && ac[l] >= ac[l - 1] && ac[l] >= ac[l + 1]) { mejor = v; lag = l; }
  }
  // refinamiento parabólico del máximo
  const ya = ac[lag - 1], yb = ac[lag], yc = ac[lag + 1], den = ya - 2 * yb + yc;
  const P = lag + (Math.abs(den) > 1e-12 ? clamp((0.5 * (ya - yc)) / den, -0.5, 0.5) : 0);
  const bpm = (60 * fps) / P;
  alAvanzar(0.9); await ceder();
  if (cancelado()) return null;
  const beatsF = pulsos(on, P, 100);
  const beats = Float32Array.from(beatsF, (f) => f / fps + off);

  // ---- tiempo fuerte: la fase (de 4) donde más cambia la música (acorde y energía) y más graves hay ----
  const nB = beatsF.length, crB = new Float32Array(nB * 12), eB = new Float32Array(nB), gB = new Float32Array(nB);
  for (let i = 0; i < nB; i++) {
    const a = beatsF[i], b = Math.max(a + 1, Math.min(nF, beatsF[i + 1] ?? a + Math.round(P)));
    for (let f = a; f < b; f++) { eB[i] += energia[f]; gB[i] += bandas[0][f]; for (let k = 0; k < 12; k++) crB[i * 12 + k] += croma[f * 12 + k]; }
    eB[i] /= b - a; gB[i] /= b - a;
    let s = 0; for (let k = 0; k < 12; k++) s += crB[i * 12 + k] * crB[i * 12 + k]; s = Math.sqrt(s) || 1;
    for (let k = 0; k < 12; k++) crB[i * 12 + k] /= s;
  }
  const nov = new Float32Array(nB);
  for (let i = 1; i < nB; i++) {
    let dot = 0; for (let k = 0; k < 12; k++) dot += crB[i * 12 + k] * crB[(i - 1) * 12 + k];
    nov[i] = (1 - dot) * 2 + Math.max(0, eB[i] - eB[i - 1]) * 3 + gB[i] * 0.25;
  }
  let fase = 0, mf = -1;
  for (let ph = 0; ph < 4; ph++) {
    let s = 0, n = 0;
    for (let i = ph; i < nB; i += 4) { s += nov[i]; n++; }
    if (n && s / n > mf) { mf = s / n; fase = ph; }
  }
  const compases = [];
  const per = P / fps;
  for (let t = (beats[fase] || 0) - 4 * per; t > 0; t -= 4 * per) compases.unshift(t);
  for (let i = fase; i < beats.length; i += 4) compases.push(beats[i]);
  if (!compases.length) compases.push(0);
  const nC = compases.length, finC = (c) => (c + 1 < nC ? compases[c + 1] : buf.duration);

  // ---- secciones por compás ----
  const aF = (t) => (t - off) * fps;
  const prom = (x, t0, t1) => { const a = clamp(Math.floor(aF(t0)), 0, nF - 1), b = clamp(Math.ceil(aF(t1)), a + 1, nF); let s = 0; for (let i = a; i < b; i++) s += x[i]; return s / (b - a); };
  const eC = new Float32Array(nC), gC = new Float32Array(nC);
  for (let c = 0; c < nC; c++) { eC[c] = prom(energia, compases[c], finC(c)); gC[c] = prom(bandas[0], compases[c], finC(c)); }
  const eS = Float32Array.from(eC, (v, c) => (v * 2 + (eC[c - 1] ?? v) * 0.5 + (eC[c + 1] ?? v) * 0.5) / 3);
  const lo = cuantil(eS, 0.08), hi = cuantil(eS, 0.95), z = Float32Array.from(eS, (v) => clamp((v - lo) / Math.max(1e-6, hi - lo), 0, 1.2));
  const gMed = cuantil(gC, 0.5);
  const tipo = new Array(nC).fill('intro');
  // drops: entrada a un tramo alto con graves, después de algo claramente más bajo
  const drops = [];
  for (let c = 1; c < nC; c++) {
    const alto = z[c] > 0.68 && gC[c] >= gMed * 0.9;
    if (!alto) continue;
    const antes = (z[c - 1] + (z[c - 2] ?? z[c - 1])) / 2;
    if (z[c] - antes > 0.16 && (!drops.length || c - drops[drops.length - 1] >= 8)) drops.push(c);
  }
  for (const d of drops) {
    let c = d; while (c < nC && !(z[c] < 0.5 && (z[c + 1] ?? 0) < 0.5)) { tipo[c] = 'drop'; c++; }
  }
  // pausa: un valle después de que la canción ya sonó fuerte (el arranque callado es intro)
  for (let c = 0, sono = false; c < nC; c++) { if (z[c] > 0.55) sono = true; else if (sono && tipo[c] !== 'drop' && z[c] < 0.3) tipo[c] = 'pausa'; }
  // subida: los compases antes del drop mientras la energía (o el brillo) siga creciendo hacia él; mínimo 2, máximo 16
  const bC = Float32Array.from({ length: nC }, (_, c) => prom(brillo, compases[c], finC(c)));
  const sube = (c) => z[c] + bC[c] * 0.5;
  for (const d of drops) {
    let c = d - 1, n = 0;
    while (c >= 0 && n < 16 && tipo[c] !== 'drop') {
      if (n >= 2 && !(sube(c) < sube(c + 1) - 0.005)) break;
      if (tipo[c] === 'pausa' && n >= 2) break;
      tipo[c] = 'subida'; c--; n++;
    }
  }
  // el instante del drop: el pulso (±2) con el mayor salto de energía de graves
  const tDrops = drops.map((c) => {
    const ib = ultimo(beats, compases[c] + 0.01);
    let mejorT = compases[c], mejorS = -1e9;
    for (let j = Math.max(1, ib - 2); j <= Math.min(nB - 1, ib + 2); j++) {
      const t = beats[j], s = prom(bandas[0], t, t + per) + prom(energia, t, t + per) - prom(bandas[0], t - per, t) - prom(energia, t - per, t);
      if (s > mejorS) { mejorS = s; mejorT = t; }
    }
    return mejorT;
  });
  // hueco: antes del drop la música cae a menos de la mitad hasta el golpe (máx. un compás)
  const huecos = [];
  for (const td of tDrops) {
    const m = prom(energia, td - per * 8, td - per * 4);
    let ini = -1;
    for (let i = Math.floor(aF(td)) - 1; i >= Math.max(0, Math.floor(aF(td - per * 4))); i--) { if (energia[i] < m * 0.4) ini = i; else break; }
    if (ini >= 0 && aF(td) - ini > fps * 0.12) huecos.push(ini / fps + off);
  }
  const secciones = [];
  for (let c = 0; c < nC; c++) {
    const t0 = compases[c], t1 = finC(c), s = secciones[secciones.length - 1];
    if (s && s.tipo === tipo[c]) s.t1 = t1; else secciones.push({ t0, t1, tipo: tipo[c] });
  }
  if (secciones.length && secciones[0].t0 > 0) secciones[0].t0 = 0;
  // la frontera subida → drop va donde cae el drop de verdad
  for (let k = 1; k < secciones.length; k++) {
    if (secciones[k].tipo !== 'drop') continue;
    const td = tDrops.find((x) => Math.abs(x - secciones[k].t0) < per * 3);
    if (td != null && td > secciones[k - 1].t0 + per) { secciones[k - 1].t1 = td; secciones[k].t0 = td; }
  }

  // ---- tonalidad: global y por compás (ventana de ±2 compases) ----
  const crC = new Float32Array(nC * 12), glob = new Float32Array(12);
  for (let c = 0; c < nC; c++) {
    const a = clamp(Math.floor(aF(compases[c])), 0, nF - 1), b = clamp(Math.ceil(aF(finC(c))), a + 1, nF);
    for (let f = a; f < b; f++) { let s = 0; for (let k = 0; k < 12; k++) s += croma[f * 12 + k]; if (s <= 1e-9) continue; for (let k = 0; k < 12; k++) { crC[c * 12 + k] += croma[f * 12 + k] / s; glob[k] += croma[f * 12 + k] / s; } }
  }
  const tg = tonalidad(glob);
  const tonoC = new Int8Array(nC), menorC = new Uint8Array(nC), w = new Float32Array(12);
  for (let c = 0; c < nC; c++) {
    w.fill(0);
    for (let j = Math.max(0, c - 2); j <= Math.min(nC - 1, c + 2); j++) for (let k = 0; k < 12; k++) w[k] += crC[j * 12 + k];
    const t = tonalidad(w);
    // poca confianza: se queda con la tonalidad global
    const ok = t.conf > 0.25;
    tonoC[c] = quinta(ok ? t.pc : tg.pc, ok ? t.menor : tg.menor); menorC[c] = (ok ? t.menor : tg.menor) ? 1 : 0;
  }
  alAvanzar(1);
  return {
    fps, off, nF, dur: buf.duration, bpm, periodo: per, beats, compases: Float64Array.from(compases), fase,
    bandas, energia, brillo, golpes, cajas, agudos, secciones, drops: Float64Array.from(tDrops), huecos: Float64Array.from(huecos),
    tonoC, menorC, tono: { pc: tg.pc, menor: tg.menor, nombre: nombreTono(tg.pc, tg.menor), quinta: quinta(tg.pc, tg.menor) },
  };
}

// pulsos por programación dinámica: cada pulso premia la envolvente y castiga alejarse del periodo
function pulsos(on, P, rigidez) {
  const n = on.length, sc = new Float32Array(n), prev = new Int32Array(n).fill(-1);
  const a = Math.round(P / 2), b = Math.round(P * 2);
  for (let t = 0; t < n; t++) {
    let m = 0, mi = -1;
    for (let tau = t - b; tau <= t - a; tau++) {
      if (tau < 0) continue;
      const d = Math.log((t - tau) / P), v = sc[tau] - rigidez * d * d;
      if (mi < 0 || v > m) { m = v; mi = tau; }
    }
    sc[t] = on[t] + (mi >= 0 ? Math.max(0, m) : 0);
    prev[t] = mi >= 0 && m > 0 ? mi : -1;
  }
  // el último pulso: el mejor puntaje del último periodo
  let t = n - 1, best = -1e9;
  for (let i = Math.max(0, n - Math.round(P)); i < n; i++) if (sc[i] > best) { best = sc[i]; t = i; }
  const out = [];
  while (t >= 0) { out.push(t); t = prev[t]; }
  out.reverse();
  // rellena el principio (antes del primer pulso detectado) con el periodo
  const f0 = out[0] || 0, rel = [];
  for (let f = f0 - P; f >= 0; f -= P) rel.unshift(Math.round(f));
  return Int32Array.from([...rel, ...out]);
}

// búsqueda: último índice con x[i] <= t (−1 si ninguno)
export function ultimo(x, t) {
  let a = 0, b = x.length - 1, r = -1;
  while (a <= b) { const m = (a + b) >> 1; if (x[m] <= t) { r = m; a = m + 1; } else b = m - 1; }
  return r;
}
