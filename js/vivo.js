// En vivo (micrófono o MIDI): lo que el archivo sabe por su mapa, aquí se adivina mientras suena.
//   1) BPM y fase: los bombos de los últimos 12 s votan por un periodo (70–180 BPM, peso hacia ~122)
//      y la fase sale de la media circular de sus tiempos dentro del periodo.
//   2) Retardo compensado: entrada (búfer del mic + cuanto de audio + parte de la ventana FFT + sondeo)
//      más salida (dos cuadros + la pantalla). Con el pulso amarrado, los golpes se pintan antes,
//      con la rejilla del BPM y el patrón de bombo aprendido en 16 semicorcheas.
//   3) Novedad (estilo Foote): cada 0.5 s un vector (bandas, energía, brillo, croma); distancia entre
//      los últimos 8 s y los 8 anteriores. Un pico sobre media + k·σ pide cambio de escena, que se
//      hace al inicio del siguiente compás. El umbral se afina solo.
// Viene de modo-rave.js (15 nov 2026), que se inyectaba en la página; aquí vive en el repo.
const VENT = 16;   // 16 vectores de 0.5 s = 8 s por lado

export class Vivo {
  constructor(pista) {
    this.P = pista;
    this.oyentes = new Set();
    this.tv = 0.05;      // la pantalla (HDMI en modo normal): supuesto
    this.reiniciar();
  }
  alCambio(f) { this.oyentes.add(f); return () => this.oyentes.delete(f); }
  reiniciar() {
    this.kicks = []; this.ultK = -99; this.bpm = 0; this.cand = 0; this.candN = 0; this.fase = 0; this.tCalc = 0;
    this.frame = 1 / 60; this.tPrevF = 0;
    this.prob = new Array(16).fill(0); this.lastSlot = null; this.fuerza = 0.75; this.emit = -99; this.hit = 0; this.locked = false; this.usados = 0;
    this.crudoK = -99; this.crudoF = 0; this.puesto = null;   // último golpe oído y el que se dejó escrito en r
    this.N = { h: [], nov: [], ult: performance.now() / 1000, cambios: [], pend: false, k: 1.6, MIN: 24, MAX: 150, tVec: 0, actual: 0, timer: 0 };
    clearTimeout(this.tCambio);
    this.calc();
  }
  // retardo total en segundos (A); se recalcula con el ritmo de cuadros medido
  calc() {
    const P = this.P, ac = P.S && P.S.ac;
    const tr = P.stream && P.stream.getAudioTracks ? P.stream.getAudioTracks()[0] : null, st = tr && tr.getSettings ? tr.getSettings() : {};
    const fft = P.an ? P.an.fftSize : 2048, sr = ac ? ac.sampleRate : 48000;
    this.inp = P.fuente === 'midi' ? 0.004 + this.frame / 2 : (st.latency || 0.003) + ((ac && ac.baseLatency) || 0.01) + (fft / sr) * 0.35 + this.frame / 2;
    this.out = 2 * this.frame + this.tv;
    this.A = this.inp + this.out;
  }
  get estado() {
    return { bpm: +(this.bpm || 0).toFixed(1), fase: this.fase, amarre: +this.hit.toFixed(2), amarrado: this.locked,
      patron: this.prob.map((x) => (x >= 0.5 ? 'x' : '.')).join(''), retardoMs: Math.round(this.A * 1000), novedad: +this.N.actual.toFixed(3),
      umbralK: +this.N.k.toFixed(2), cambios: this.N.cambios.length };
  }

  estimar(now) {
    const ks = this.kicks.filter((k) => now - k.t < 12);
    if (ks.length < 8) return;
    let mejor = 0, bpmM = 0;
    for (let bpm = 70; bpm <= 180; bpm += 0.5) {
      const p = 60 / bpm; let s = 0;
      for (let i = 0; i < ks.length; i++) for (let j = i + 1; j < ks.length; j++) {
        const dt = ks[j].t - ks[i].t; if (dt > 4) break;
        const n = Math.round(dt / p); if (n < 1) continue;
        const e = dt - n * p; s += Math.exp(-(e * e) / (2 * 0.018 * 0.018)) * ks[i].f * ks[j].f / n;
      }
      s *= Math.exp(-Math.pow(Math.log2(bpm / 122), 2) / (2 * 0.5 * 0.5));
      if (s > mejor) { mejor = s; bpmM = bpm; }
    }
    if (!bpmM) return;
    if (this.bpm && Math.abs(bpmM - this.bpm) / this.bpm < 0.04) { this.bpm += (bpmM - this.bpm) * 0.3; this.candN = 0; }
    else if (Math.abs(bpmM - this.cand) / Math.max(1, this.cand) < 0.04) { if (++this.candN >= 2 || !this.bpm) { this.bpm = bpmM; this.candN = 0; } }
    else { this.cand = bpmM; this.candN = 1; if (!this.bpm) this.bpm = bpmM; }
    const p = 60 / this.bpm; let cx = 0, cy = 0;
    for (const k of ks) if (now - k.t < 6) { const a = 2 * Math.PI * ((k.t % p) / p); cx += Math.cos(a) * k.f; cy += Math.sin(a) * k.f; }
    this.fase = ((Math.atan2(cy, cx) / (2 * Math.PI)) * p + p) % p;
    this.P.bpm = Math.round(this.bpm * 10) / 10;
  }

  // una vez por cuadro, con el estado crudo (golpes tal como se oyeron); lo deja en hora de pantalla
  ajustar(r, now) {
    const t0 = performance.now();
    if (this.tPrevF) this.frame += (Math.min(0.1, (t0 - this.tPrevF) / 1000) - this.frame) * 0.02;
    this.tPrevF = t0;
    // r se reusa entre cuadros: si r.tKick sigue siendo el que se pintó aquí, no hubo golpe nuevo
    // (sin esto, los golpes adelantados volvían a entrar como oídos y torcían el BPM y la fase)
    if (r.tKick !== this.puesto) { this.crudoK = r.tKick; this.crudoF = r.kick; }
    const rawK = this.crudoK, rawF = this.crudoF;
    r.tKick = this.puesto = rawK; r.kick = rawF;
    if (rawK !== this.ultK && rawK > 0) { this.ultK = rawK; this.kicks.push({ t: rawK, f: rawF || 0.6 }); if (this.kicks.length > 80) this.kicks.shift(); }
    if (now - this.tCalc > 2) { this.tCalc = now; this.estimar(now); this.calc(); }
    if (now - this.N.tVec >= 0.5) { this.N.tVec = now; this.novedad(r, now); }
    if (!this.bpm) return r;
    const p = 60 / this.bpm, q = p / 4, tol = Math.min(0.04, q * 0.35), A = this.A;
    r.bpm = this.bpm; r.compases = 8;
    const K = this.kicks.filter((k) => now - k.t < 8);
    let h = 0; for (const k of K) { let e = (((k.t - this.fase) % p) + p) % p; if (e > p / 2) e -= p; if (Math.abs(e) < 0.045) h++; }
    this.hit = K.length ? h / K.length : 0;
    this.locked = K.length >= 4 && this.hit >= 0.5;
    // patrón de bombo en 16 semicorcheas: aprende y olvida en ~4 compases
    const sNow = Math.floor((now - tol - this.fase) / q);
    if (this.lastSlot === null || sNow - this.lastSlot > 64 || sNow < this.lastSlot) this.lastSlot = sNow;
    for (let s = this.lastSlot + 1; s <= sNow; s++) {
      const ts = this.fase + s * q, i = ((s % 16) + 16) % 16;
      let hit = 0; for (const k of K) if (Math.abs(k.t - ts) < tol) { hit = 1; break; }
      this.prob[i] += (hit - this.prob[i]) * 0.25;
    }
    this.lastSlot = sNow;
    if (K.length) { const u = K.slice(-4); this.fuerza += (u.reduce((a, k) => a + k.f, 0) / u.length - this.fuerza) * 0.1; }
    const vivo = K.length && now - K[K.length - 1].t < 8 * p;
    const nB = Math.floor((now + (this.locked ? A : 0) - this.fase) / p);
    r.tBeat = this.fase + nB * p - (this.locked ? A : 0); r.compas = Math.floor(nB / 4) % 8;
    r.fase = (((now + (this.locked ? A : 0) - this.fase) / p) % 1 + 1) % 1;   // 0..1 dentro del pulso, en hora de pantalla
    if (this.locked && vivo) {
      // el golpe que ya toca pintar: hora en pantalla = hora real del golpe - retardo total
      const sR = Math.floor((now + A - this.fase) / q);
      let tPred = -99, pr = 0;
      for (let s = sR; s > sR - 8; s--) { const i = ((s % 16) + 16) % 16; if (this.prob[i] >= 0.5) { tPred = this.fase + s * q - A; pr = this.prob[i]; break; } }
      const si = ((Math.round((rawK - this.fase) / q) % 16) + 16) % 16;
      let t = tPred, f = Math.min(1, this.fuerza * (0.65 + 0.35 * pr));
      // un golpe real fuera del patrón también cuenta (llega tarde, pero es real)
      if (rawK > tPred + 0.09 && this.prob[si] < 0.5 && now - rawK < 0.05) { t = rawK; f = rawF; }
      if (t > -90) { r.tKick = this.puesto = t; r.kick = f; if (t !== this.emit) { this.emit = t; this.usados++; } }
    }
    return r;
  }

  vector(r) {
    const P = this.P, b = Array.from(P.b || [0, 0, 0]), cr = Array.from(P.crV || new Array(12).fill(0));
    const s = cr.reduce((a, x) => a + x, 0) || 1, e = r.energia || (b[0] + b[1] + b[2]) / 3, br = r.brillo || 0;
    return [b[0] * 1.5, b[1] * 1.5, b[2] * 1.5, e * 2, br].concat(cr.map((x) => (x / s) * 3));
  }
  novedad(r, t) {
    const N = this.N;
    N.h.push(this.vector(r)); if (N.h.length > 64) N.h.shift();
    if (N.h.length < VENT * 2) return;
    const media = (a) => { const m = new Array(a[0].length).fill(0); a.forEach((v) => v.forEach((x, i) => (m[i] += x / a.length))); return m; };
    const desv = (a, m) => { const d = new Array(m.length).fill(0); a.forEach((v) => v.forEach((x, i) => (d[i] += (x - m[i]) ** 2 / a.length))); return d.map(Math.sqrt); };
    const A2 = N.h.slice(-VENT * 2, -VENT), B2 = N.h.slice(-VENT);
    const mA = media(A2), mB = media(B2), sA = desv(A2, mA), sB = desv(B2, mB);
    let d = 0; for (let i = 0; i < mA.length; i++) d += (mA[i] - mB[i]) ** 2 / (sA[i] * sB[i] + 0.004);
    d = Math.sqrt(d / mA.length);
    N.actual = d;
    N.nov.push(d); if (N.nov.length > 240) N.nov.shift();
    const m = N.nov.reduce((a, x) => a + x, 0) / N.nov.length, s = Math.sqrt(N.nov.reduce((a, x) => a + (x - m) ** 2, 0) / N.nov.length);
    const k = N.nov.length, pico = k > 3 && N.nov[k - 2] > N.nov[k - 3] && N.nov[k - 2] >= N.nov[k - 1];
    const umbral = m + N.k * s, largo = t - N.ult > N.MAX;
    if (!N.pend && t - N.ult > N.MIN && ((k >= 60 && pico && N.nov[k - 2] > umbral) || largo)) {
      N.pend = true;
      const motivo = largo ? 'largo' : 'patrón', dPico = +N.nov[k - 2].toFixed(2), um = +umbral.toFixed(2);
      // espera el inicio del siguiente compás, en hora de pantalla
      const p = 60 / (this.bpm || 120), A = this.locked ? this.A : 0;
      const x = (t + A - this.fase) / p, n = Math.floor(x), resto = (x - n) * p;
      let dly = (((4 - (((n % 4) + 4) % 4)) % 4) * p) - resto; if (dly < 0.05) dly += 4 * p;
      N.ult = t + dly;
      this.tCambio = setTimeout(() => {
        N.pend = false;
        const c = { t: new Date().toLocaleTimeString(), at: performance.now() / 1000, motivo, d: dPico, umbral: um, k: +N.k.toFixed(2) };
        N.cambios.push(c); if (N.cambios.length > 30) N.cambios.shift();
        for (const f of this.oyentes) { try { f(c); } catch {} }
        // se afina solo: si cambia muy seguido sube la exigencia
        const c4 = N.cambios.slice(-4);
        if (c4.length === 4 && (c4[3].at - c4[0].at) / 3 < 40) N.k = Math.min(3, N.k + 0.2);
      }, dly * 1000);
    }
    // y si pasa mucho sin cambiar, la baja poco a poco
    if (t - N.ult > 110) N.k = Math.max(1.0, N.k - 0.01);
  }
  // el proyector vetó la escena actual: cambiar en el siguiente compás
  forzar() { const N = this.N, t = performance.now() / 1000; if (!N.pend && t - N.ult > 4) N.ult = t - N.MAX - 1; }
}
