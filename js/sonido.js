// Sonido generativo por sala (Web Audio).
// La voz sigue la cadena de spectre-daw (spectre-daw, sinte para 3DS):
// dos osciladores → filtro pasa-bajas resonante → envolvente ADSR, con un LFO sobre el corte.
// Cada sala tiene una «partitura» que escucha señales de la simulación (no es música de fondo:
// lo que suena depende de lo que pasa en pantalla).

const PENTA_RE = [0, 3, 5, 7, 10];          // re menor pentatónica
const LIDIO = [0, 2, 4, 6, 7, 9, 11];
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const escala = (sc, raiz, grado) => raiz + sc[((grado % sc.length) + sc.length) % sc.length] + 12 * Math.floor(grado / sc.length);

export class Sonido {
  constructor() {
    this.ac = null; this.mudo = false; this.vol = 0.55; this.actual = null; this.pendiente = null;
    try { this.mudo = localStorage.getItem('lab.mudo') === '1'; } catch {}
    // ?test o ?mudo: la salida maestra queda en 0 siempre (pruebas de agentes; nunca suenan en los altavoces)
    try { const q = new URLSearchParams(location.search); this.silencio = q.has('test') || q.has('mudo'); } catch { this.silencio = false; }
  }
  // El contexto se crea perezosamente (el kiosco permite autoplay; en otro navegador espera un gesto).
  iniciar(forzar = false) {
    // En la web (fuera del servidor local) el navegador no deja sonar sin un gesto y avisa en la consola por cada
    // intento: se espera a la primera tecla o clic. En el kiosco local (autoplay permitido) arranca al abrir, como siempre.
    const local = /^(127\.0\.0\.1|localhost|\[::1\])$/.test(location.hostname);
    const gesto = !navigator.userActivation || navigator.userActivation.hasBeenActive;
    if (!local && !gesto && !forzar) return;      // forzar: «tu música» decodifica aunque aún no haya sonado nada (suena con el primer gesto)
    if (this.ac) { if (this.ac.state === 'suspended' && !this.pausado) this.ac.resume().catch(() => {}); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ac = this.ac = new AC({ latencyHint: 'playback' });
    this.master = ac.createGain(); this.master.gain.value = 0;
    const comp = ac.createDynamicsCompressor();
    comp.threshold.value = -18; comp.knee.value = 12; comp.ratio.value = 3; comp.attack.value = 0.01; comp.release.value = 0.4;
    this.master.connect(comp).connect(ac.destination);
    this.salida = comp;            // la mezcla final: de aquí graba el video
    // reverberación: respuesta al impulso sintética (ruido estéreo con caída exponencial)
    this.rev = ac.createConvolver();
    const len = Math.floor(ac.sampleRate * 3.4), ir = ac.createBuffer(2, len, ac.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = ir.getChannelData(c);
      for (let i = 0; i < len; i++) { const t = i / len; d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, 3.2) * (t < 0.004 ? t / 0.004 : 1); }
    }
    this.rev.buffer = ir;
    // analizador antes del volumen maestro: las salas pueden «oír» aunque esté en silencio
    this.analizador = ac.createAnalyser(); this.analizador.fftSize = 1024; this.analizador.smoothingTimeConstant = 0.6;
    this.fft = new Uint8Array(this.analizador.frequencyBinCount); this.bandasS = [0, 0, 0];
    this.revIn = ac.createGain(); this.revIn.gain.value = 0.9;
    this.revIn.connect(this.rev).connect(this.master);
    // la música generativa pasa por su propio volumen: cuando suena «tu música» (Señal) se apaga sin cortar el secuenciador
    this.gen = ac.createGain(); this.gen.connect(this.master); this.gen.connect(this.analizador);
    this.genRev = ac.createGain(); this.genRev.connect(this.revIn);
    if (this.genApagada) { this.gen.gain.value = 0; this.genRev.gain.value = 0; }
    // ruido rosa en bucle (filtro de Kellet)
    const nl = ac.sampleRate * 4, nb = ac.createBuffer(1, nl, ac.sampleRate), nd = nb.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < nl; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852;
      b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
      nd[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11; b6 = w * 0.115926;
    }
    this.ruidoBuf = nb;
    this.aplicarVolumen(1.5);
    if (this.pendiente) { const p = this.pendiente; this.pendiente = null; this.partitura(p); }
  }
  aplicarVolumen(t = 0.4) {
    if (!this.ac) return;
    const g = this.master.gain, now = this.ac.currentTime;
    g.cancelScheduledValues(now); g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(this.silencio || this.mudo || this.pausado || this.escuchando ? 0 : this.vol, now + t);
  }
  alternarMudo() { this.mudo = !this.mudo; try { localStorage.setItem('lab.mudo', this.mudo ? '1' : '0'); } catch {} this.aplicarVolumen(); return !this.mudo; }
  pausar() { this.pausado = true; if (!this.ac) return; this.aplicarVolumen(0.15); setTimeout(() => { if (this.pausado && this.ac) this.ac.suspend().catch(() => {}); }, 220); }
  reanudar() { this.pausado = false; if (!this.ac) return; this.ac.resume().catch(() => {}); this.aplicarVolumen(0.8); }

  // enciende o apaga la música generativa (fundido corto); la usa «tu música»
  generativa(on, t = 0.5) {
    this.genApagada = !on;
    if (!this.ac || !this.gen) return;
    const now = this.ac.currentTime;
    for (const g of [this.gen.gain, this.genRev.gain]) { g.cancelScheduledValues(now); g.setValueAtTime(g.value, now); g.linearRampToValueAtTime(on ? 1 : 0, now + t); }
  }
  // cambia de partitura con fundido cruzado
  partitura(nombre) {
    if (!this.ac) { this.pendiente = nombre; return; }
    if (this.actual && this.actual.nombre === nombre) return;
    const viejo = this.actual;
    if (viejo) viejo.salir(1.6);
    const P = PARTITURAS[nombre] || PARTITURAS.silencio;
    const bus = this.ac.createGain(); bus.gain.value = 0;
    const envio = this.ac.createGain(); envio.gain.value = P.envio ?? 1;
    bus.connect(this.gen); bus.connect(envio).connect(this.genRev);
    this.actual = new P(this, bus); this.actual.nombre = nombre;
    bus.gain.setTargetAtTime(1, this.ac.currentTime + 0.25, 0.6);
  }
  // energía en graves, medios y agudos (0..1), suavizada
  bandas() {
    if (!this.ac || this.ac.state !== 'running') return null;
    this.analizador.getByteFrequencyData(this.fft);
    const hz = this.ac.sampleRate / this.analizador.fftSize, prom = (a, b) => { let t = 0, n = 0; for (let i = Math.floor(a / hz); i <= Math.ceil(b / hz); i++) { t += this.fft[i]; n++; } return t / n / 255; };
    const v = [prom(30, 160), prom(300, 2000), prom(4000, 11000)];
    for (let i = 0; i < 3; i++) this.bandasS[i] += (v[i] - this.bandasS[i]) * (v[i] > this.bandasS[i] ? 0.6 : 0.15);
    return this.bandasS;
  }
  señales(s, dt) { if (this.actual && this.ac && !this.pausado) this.actual.update(s || {}, dt); }
  evento(n, v) { if (this.actual && this.ac && !this.pausado && !this.mudo) this.actual.evento(n, v || {}); }

  // ---------- instrumentos básicos ----------
  // voz tipo spectre-daw: 2 osciladores → pasa-bajas → ADSR
  voz({ f = 220, tipo = 'triangle', tipo2 = null, det = 7, corte = 1800, q = 0.7, a = 0.01, d = 0.2, s = 0.0, r = 0.4, dur = 0.05, g = 0.2, pan = 0, dest, t0 = 0, barrido = 0 }) {
    const ac = this.ac, now = ac.currentTime + t0;
    const env = ac.createGain(); env.gain.value = 0;
    const lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = corte; lp.Q.value = q;
    if (barrido) lp.frequency.setTargetAtTime(Math.max(60, corte * barrido), now + a, d * 0.8);
    const p = ac.createStereoPanner(); p.pan.value = pan;
    lp.connect(env).connect(p).connect(dest);
    const o1 = ac.createOscillator(); o1.type = tipo; o1.frequency.value = f; o1.connect(lp);
    let o2 = null;
    if (tipo2) { o2 = ac.createOscillator(); o2.type = tipo2; o2.frequency.value = f; o2.detune.value = det; o2.connect(lp); }
    const peak = g, sus = g * s;
    env.gain.setValueAtTime(0, now);
    env.gain.linearRampToValueAtTime(peak, now + a);
    env.gain.setTargetAtTime(sus, now + a, d / 3);
    const off = now + a + Math.max(dur, d);
    env.gain.setTargetAtTime(0, off, r / 4);
    const end = off + r * 1.6 + 0.05;
    o1.start(now); o1.stop(end); if (o2) { o2.start(now); o2.stop(end); }
    o1.onended = () => { try { p.disconnect(); } catch {} };
  }
  // ráfaga de ruido filtrado
  soplo({ f = 800, q = 1, a = 0.02, r = 0.6, g = 0.2, dest, f2 = 0, pan = 0 }) {
    const ac = this.ac, now = ac.currentTime;
    const src = ac.createBufferSource(); src.buffer = this.ruidoBuf; src.loop = true;
    const bp = ac.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = f; bp.Q.value = q;
    if (f2) bp.frequency.exponentialRampToValueAtTime(f2, now + a + r);
    const env = ac.createGain(); env.gain.value = 0;
    const p = ac.createStereoPanner(); p.pan.value = pan;
    src.connect(bp).connect(env).connect(p).connect(dest);
    env.gain.linearRampToValueAtTime(g, now + a);
    env.gain.setTargetAtTime(0, now + a, r / 3);
    src.start(now, Math.random() * 3); src.stop(now + a + r * 2 + 0.1);
    src.onended = () => { try { p.disconnect(); } catch {} };
  }
  // capa continua: osciladores sostenidos → pasa-bajas (con LFO) → ganancia controlable
  dron(freqs, { tipo = 'sine', corte = 900, q = 0.5, g = 0.05, lfo = 0, lfoProf = 0, det = 4, dest }) {
    const ac = this.ac;
    const lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = corte; lp.Q.value = q;
    const out = ac.createGain(); out.gain.value = 0;
    lp.connect(out).connect(dest);
    const oscs = freqs.map((f, i) => {
      const o = ac.createOscillator(); o.type = tipo; o.frequency.value = f; o.detune.value = (i % 2 ? 1 : -1) * det;
      const gg = ac.createGain(); gg.gain.value = 1 / freqs.length; o.connect(gg).connect(lp); o.start(); return o;
    });
    let lfoO = null;
    if (lfo) { lfoO = ac.createOscillator(); lfoO.frequency.value = lfo; const lg = ac.createGain(); lg.gain.value = lfoProf; lfoO.connect(lg).connect(lp.frequency); lfoO.start(); }
    out.gain.setTargetAtTime(g, ac.currentTime, 1.2);
    return {
      lp, out, oscs,
      ganancia(v, tc = 0.3) { out.gain.setTargetAtTime(v, ac.currentTime, tc); },
      corte(v, tc = 0.3) { lp.frequency.setTargetAtTime(v, ac.currentTime, tc); },
      frec(fs, tc = 0.4) { fs.forEach((f, i) => oscs[i] && oscs[i].frequency.setTargetAtTime(f, ac.currentTime, tc)); },
      parar(t = 1) { out.gain.setTargetAtTime(0, ac.currentTime, t / 3); setTimeout(() => { oscs.forEach((o) => o.stop()); if (lfoO) lfoO.stop(); try { out.disconnect(); } catch {} }, t * 1000 + 300); },
    };
  }
  // ruido continuo filtrado (viento, lavado)
  ruido({ tipo = 'bandpass', f = 400, q = 0.7, g = 0.05, dest }) {
    const ac = this.ac;
    const src = ac.createBufferSource(); src.buffer = this.ruidoBuf; src.loop = true;
    const bp = ac.createBiquadFilter(); bp.type = tipo; bp.frequency.value = f; bp.Q.value = q;
    const out = ac.createGain(); out.gain.value = 0;
    src.connect(bp).connect(out).connect(dest); src.start(0, Math.random() * 3);
    out.gain.setTargetAtTime(g, ac.currentTime, 1);
    return {
      bp, out,
      ganancia(v, tc = 0.25) { out.gain.setTargetAtTime(v, ac.currentTime, tc); },
      frec(v, tc = 0.25) { bp.frequency.setTargetAtTime(v, ac.currentTime, tc); },
      parar(t = 1) { out.gain.setTargetAtTime(0, ac.currentTime, t / 3); setTimeout(() => { src.stop(); try { out.disconnect(); } catch {} }, t * 1000 + 300); },
    };
  }
}

// ---------- partituras ----------
class Base {
  constructor(S, bus) { this.S = S; this.bus = bus; this.capas = []; this.t = 0; this.init(); }
  init() {}
  update() {}
  evento() {}
  capa(c) { this.capas.push(c); return c; }
  salir(t) {
    const ac = this.S.ac;
    this.bus.gain.setTargetAtTime(0, ac.currentTime, t / 4);
    this.muerto = true;
    setTimeout(() => { this.capas.forEach((c) => c.parar(0.2)); try { this.bus.disconnect(); } catch {} }, t * 1000 + 400);
  }
}

// ---------- Señal: máquina de estilos ----------
// Cinco estilos con forma de pista (intro → subida → drop → pausa → subida → drop…). Todo es síntesis:
// osciladores, ruido y filtros, sin muestras. Las melodías y los riffs son originales; de cada género se
// toma el diseño de sonido, la energía y la forma, nunca sus temas.
// El secuenciador tiene su propio temporizador y programa con MARGEN segundos de anticipación sobre el
// reloj de audio: un cuadro lento de video no lo hace tartamudear. Los visuales leen la misma línea de
// tiempo con estado(t) (bombos, cajas, drops y el filtro del bajo) en el instante que de verdad se oye.
const MARGEN = 0.35;
const VOCALES = { u: [320, 800, 2500], o: [480, 860, 2600], a: [780, 1220, 2700], e: [500, 1750, 2600], i: [300, 2200, 3000] };
const curvaSat = (k, n = 2048) => { const c = new Float32Array(n), d = Math.tanh(k); for (let i = 0; i < n; i++) c[i] = Math.tanh(k * ((i / (n - 1)) * 2 - 1)) / d; return c; };
const curvaRota = (niv, n = 2048) => { const c = new Float32Array(n); for (let i = 0; i < n; i++) c[i] = Math.round(((i / (n - 1)) * 2 - 1) * niv) / niv; return c; };
const hzF = (v) => 60 * Math.pow(2, clamp(v, 0, 1) * 7.6);   // 0..1 → 60 Hz..12 kHz

// riffs del bajo de brostep (2 compases): [paso, semitonos, duración, periodo del wobble en pasos, modo, vocal de salida, vocal de llegada]
// modo: w = wobble del filtro · g = gruñido de formantes (talk-box) · r = chirrido agudo
const RIFF_BRO = [
  [[0, 0, 6, 2, 'w'], [6, 0, 2, 0.5, 'w'], [10, 3, 2, 0, 'g', 'o', 'a'], [12, -2, 4, 4 / 3, 'w'],
    [16, 0, 4, 4, 'w'], [20, 0, 3, 1, 'w'], [24, 7, 2, 0, 'g', 'u', 'i'], [26, 5, 2, 0, 'g', 'i', 'o'], [28, 3, 4, 2 / 3, 'r']],
  [[0, 0, 4, 1, 'w'], [4, 12, 2, 0, 'g', 'a', 'u'], [6, 0, 2, 2 / 3, 'w'], [10, 1, 2, 0, 'g', 'o', 'i'], [12, 0, 4, 0.5, 'r'],
    [16, 0, 2, 0, 'g', 'u', 'a'], [18, 0, 2, 0, 'g', 'a', 'o'], [20, -4, 4, 2, 'w'], [24, 3, 4, 4 / 3, 'w'], [28, 7, 2, 0, 'g', 'e', 'a'], [30, 12, 2, 0.5, 'r']],
];

const ESTILOS = [
  {
    nombre: 'brostep 2010', bpm: 140, raiz: 41, bombeo: 0.5,
    forma: [['intro', 4], ['subida', 8], ['drop', 16], ['pausa', 8], ['subida', 4], ['drop', 16, 1]], bucle: 3,
    acordes: [[53, 56, 60, 65], [53, 56, 61, 65], [51, 56, 60, 63], [51, 55, 58, 63]],   // Fm · Db · Ab · Eb
    graves: [41, 37, 44, 39],
    // gancho en tresillo (3·3·2): sube y vuelve en Fm, cae en Db, se estira en Ab y deja la puerta abierta en Eb (termina en Do, la quinta de Fa)
    motivo: [[0, 72, 3], [3, 75, 3], [6, 77, 2], [8, 75, 4], [12, 72, 4], [16, 73, 3], [19, 72, 3], [22, 70, 2], [24, 68, 8],
      [32, 72, 3], [35, 75, 3], [38, 79, 2], [40, 80, 4], [44, 75, 4], [48, 77, 3], [51, 75, 3], [54, 70, 2], [56, 72, 8]],
    racks(m) {
      return {
        bajo: m.rackBajo({ oscs: [['sawtooth', 0, 0], ['sawtooth', 0, 11], ['square', -12, 0]], sat: 4, q: 7, formantes: true, sub: 0.6, g: 0.34 }),
        sierra: m.rackSierra({ capas: 5, abre: 22, corte: 600, g: 0.2 }),
      };
    },
    paso(m, x) {
      const { t, n, s, c, prog, sec, spb } = x, R = m.R, ac = this.acordes[c % 4];
      if (sec.t === 'intro') {
        if (s === 0) { R.sierra.acorde(t, ac); R.sierra.nivel(t, 0.55, 0.3); R.sierra.corte(t, 500 + prog * 1600, 1.2); m.kick(t, { g: 0.5, cae: 0.3 }); }
        if (s % 2 === 0) m.nota(t, ac[(s >> 1) % 4] + 12, spb * 1.6, { tipo: 'square', corte: 2600, g: 0.03, d: 0.12, s: 0, r: 0.1, eco: 0.35, pan: s % 4 ? 0.3 : -0.3 });
        if (c >= 2) m.melodia(x, this.motivo, 0, { tipo: 'sawtooth', tipo2: 'square', g: 0.045, corte: 3200, vib: 12, eco: 0.3 });
        if (s === 8 && c % 2) m.hat(t, { g: 0.04, abierto: true });
        m.wob(t, 0.08);
      } else if (sec.t === 'subida') {
        const L = sec.c * 16, rest = L - n;
        if (n === 0) m.subida(t, L * spb);
        if (rest > 4) {
          const div = prog < 0.25 ? 4 : prog < 0.5 ? 2 : 1;
          if (s % div === 0) {
            m.caja(t, { g: 0.16 + prog * 0.45, tono: 180 + prog * 300, cola: 0.1 });
            if (prog > 0.75) m.caja(t + spb / 2, { g: 0.18 + prog * 0.4, tono: 200 + prog * 320, cola: 0.06 });
          }
          if (s % 4 === 0) { m.kick(t, { g: 0.75 }); R.sierra.acorde(t, ac); R.sierra.golpe(t, spb * 2.5, 0.45 + prog * 0.4); R.sierra.corte(t, 700 + prog * prog * 7000, 0.05); }
          if (L > 32 && c < 4) m.melodia(x, this.motivo, 12, { tipo: 'square', g: 0.035, corte: 4000, eco: 0.3 });
          m.wob(t, 0.06 + prog * 0.2);
        } else if (rest === 4) {
          // hueco antes del drop: un gruñido suelto del bajo, a capela
          m.bajoNota(t, { st: this.raiz, dur: 3 * spb, modo: 'g', va: 'u', vb: 'a', spb });
          m.marca(t, 'hueco');
        }
        if (rest <= 4) m.wobPaso(t, spb);
      } else if (sec.t === 'drop') {
        const v = sec.v || 0;
        if (n === 0) m.impacto(t);
        if (s === 0 || (s === 10 && c % 2 === 1) || (s === 3 && c % 4 === 2) || (v && s === 14 && c % 2 === 0)) m.kick(t, { g: 0.95, dist: 1 });
        if (s === 8) m.caja(t, { g: 0.75, tono: 210, cola: 0.2 });
        if (s % 2 === 0) m.hat(t, { g: s % 4 === 2 ? 0.055 : 0.028 });
        if (c % 4 === 3 && s >= 12) m.caja(t, { g: 0.25 + (s - 12) * 0.08, tono: 260 + (s - 12) * 30, cola: 0.05 });
        const k = n % 32;
        for (const e of RIFF_BRO[v]) if (e[0] === k) m.bajoNota(t, { st: this.raiz + e[1], dur: e[2] * spb, periodo: e[3], modo: e[4], va: e[5], vb: e[6], spb });
        m.wobPaso(t, spb);
        if (s === 0 && c % 2 === 0) { R.sierra.acorde(t, ac); R.sierra.golpe(t, spb * 6, 0.3); R.sierra.corte(t, 3200, 0.05); }
      } else {
        if (s === 0) {
          R.sierra.acorde(t, ac); R.sierra.nivel(t, 0.5, 0.6); R.sierra.corte(t, 1400, 1);
          m.nota(t, this.graves[c % 4] - 12, 15 * spb, { tipo: 'sine', corte: 400, g: 0.16, a: 0.08, s: 1, r: 0.6 });
        }
        m.melodia(x, this.motivo, 0, { tipo: 'triangle', tipo2: 'sawtooth', g: 0.055, corte: 2400, vib: 10, eco: 0.45 });
        if (c >= 4 && s % 4 === 2) m.hat(t, { g: 0.035 });
        if (c >= 6 && s % 4 === 0) m.kick(t, { g: 0.55 });
        m.wob(t, 0.05);
      }
    },
  },
  {
    nombre: 'synthwave', bpm: 100, raiz: 33, bombeo: 0.35,
    forma: [['intro', 4], ['subida', 4], ['drop', 16], ['pausa', 8], ['subida', 4], ['drop', 16, 1]], bucle: 3,
    acordes: [[57, 60, 64, 69], [57, 60, 65, 69], [55, 60, 64, 67], [55, 59, 62, 67]],   // Am · F · C · G
    graves: [33, 29, 36, 31],
    // pregunta y respuesta en tresillo: A (Am–F) · A' (C–G) · A otra vez · y la vuelta que sube hasta La sobre G
    melodia: [[0, 76, 3], [3, 74, 3], [6, 72, 2], [8, 69, 4], [12, 72, 4], [16, 77, 3], [19, 76, 3], [22, 74, 2], [24, 72, 8],
      [32, 79, 3], [35, 76, 3], [38, 74, 2], [40, 72, 4], [44, 76, 4], [48, 74, 3], [51, 72, 3], [54, 71, 2], [56, 74, 8],
      [64, 76, 3], [67, 74, 3], [70, 72, 2], [72, 69, 4], [76, 72, 4], [80, 77, 3], [83, 76, 3], [86, 77, 2], [88, 81, 8],
      [96, 79, 3], [99, 81, 3], [102, 79, 2], [104, 76, 4], [108, 74, 4], [112, 74, 3], [115, 76, 3], [118, 79, 2], [120, 81, 8]],
    racks(m) {
      return {
        bajo: m.rackBajo({ oscs: [['sawtooth', 0, 0], ['sawtooth', 0, -9]], sat: 1.3, q: 4, sub: 0.35, g: 0.3 }),
        sierra: m.rackSierra({ capas: 4, abre: 14, corte: 900, g: 0.2 }),
      };
    },
    paso(m, x) {
      const { t, n, s, c, prog, sec, spb } = x, R = m.R, ac = this.acordes[c % 4], gr = this.graves[c % 4], tipo = sec.t;
      if (s === 0) R.sierra.acorde(t, ac);
      // arpegio en semicorcheas por el eco: el pulso de todo el estilo
      const arp = [0, 1, 2, 3, 2, 1, 0, 2];
      m.nota(t, ac[arp[s % 8]] + 12, spb * 0.9, { tipo: 'square', corte: tipo === 'intro' ? 1400 + prog * 2000 : 3600, q: 2, g: tipo === 'drop' ? 0.02 : 0.03, d: 0.09, s: 0, r: 0.12, eco: 0.4, pan: s % 2 ? 0.35 : -0.35 });
      const bajo8 = () => { if (s % 2 === 0) { R.bajo.nota(t, gr + (s % 4 === 2 ? 12 : 0), spb * 1.7); R.bajo.env(t, 0.62, 0.3, 0.07); m.marcaWob(t, 0.75); m.marcaWob(t + spb, 0.3); m.marca(t, 'bajo'); } };
      if (tipo === 'intro') {
        if (s === 0) { R.sierra.nivel(t, 0.5, 0.8); R.sierra.corte(t, 700 + prog * 900, 1); }
        if (c >= 2 && s % 4 === 2) m.hat(t, { g: 0.025 });
        m.marcaWob(t, 0.15 + 0.1 * prog);
      } else if (tipo === 'subida') {
        const L = sec.c * 16, rest = L - n;
        if (n === 0) m.subida(t, L * spb, 0.8);
        if (s === 0) { R.sierra.nivel(t, 0.55, 0.5); R.sierra.corte(t, 900 + prog * 3000, 0.8); }
        if (rest > 16) { if (s % 4 === 0) m.kick(t, { g: 0.7, f1: 50, cae: 0.3 }); bajo8(); }
        else {   // relleno de toms que bajan y cajas que se apilan
          if (s % 2 === 0) m.tom(t, 57 - s, 0.32);
          if (s >= 8) m.caja(t, { g: 0.2 + (s - 8) * 0.05, tono: 220, cola: 0.08 });
          m.marcaWob(t, 0.3 + prog * 0.5);
        }
      } else if (tipo === 'drop') {
        if (n === 0) m.impacto(t, 0.6);
        if (s % 4 === 0) m.kick(t, { g: 0.85, f1: 48 });
        if (s === 4 || s === 12) m.caja(t, { g: 0.55, tono: 190, cola: 0.1, compuerta: 0.26 });
        if (s % 4 === 2) m.hat(t, { g: 0.055 }); else if (s % 2 === 0) m.hat(t, { g: 0.022 });
        bajo8();
        if (s === 0) { R.sierra.nivel(t, 0.42, 0.3); R.sierra.corte(t, 2600, 0.5); }
        m.melodia(x, this.melodia, sec.v ? 12 : 0, { tipo: 'sawtooth', tipo2: 'sawtooth', det: 9, g: 0.05, corte: 3000, q: 1.5, vib: 14, eco: 0.35, a: 0.01, s: 0.7, r: 0.25 });
        if (c % 8 === 7 && s >= 12) m.tom(t, 52 - (s - 12) * 3, 0.3);
      } else {
        if (s === 0) { R.sierra.nivel(t, 0.5, 0.8); R.sierra.corte(t, 1200, 1.5); m.nota(t, gr, 15 * spb, { tipo: 'sawtooth', corte: 300, g: 0.1, a: 0.3, s: 1, r: 1 }); }
        if (c >= 4 && s % 4 === 0) m.kick(t, { g: 0.45, cae: 0.25 });
        m.marcaWob(t, 0.2);
      }
    },
  },
  {
    nombre: 'hyperpop', bpm: 158, raiz: 28, bombeo: 0.7,
    forma: [['intro', 4], ['subida', 4], ['drop', 16], ['pausa', 4], ['subida', 2], ['drop', 16, 1]], bucle: 3,
    acordes: [[64, 68, 71, 76], [63, 66, 71, 75], [64, 68, 73, 76], [64, 69, 73, 76]],   // E · B · C#m · A
    graves: [28, 35, 37, 33],
    // «voces» picadas: diente de sierra por formantes, muy agudas
    chops: [[0, 83, 2, 'a'], [2, 80, 2, 'i'], [4, 78, 2, 'o'], [6, 76, 2, 'a'], [8, 78, 1, 'i'], [9, 80, 1, 'e'], [10, 83, 2, 'a'], [12, 85, 4, 'o'],
      [16, 83, 2, 'i'], [18, 80, 2, 'a'], [20, 78, 4, 'e'], [24, 76, 2, 'o'], [26, 78, 2, 'i'], [28, 80, 4, 'a']],
    b808: [[0, 0, 5], [6, 0, 3], [10, 7, 4], [14, 5, 2, 1], [16, 0, 5], [22, -4, 4, 1], [26, -5, 6, 1]],
    racks(m) {
      return {
        bajo: m.rackBajo({ oscs: [['sine', 0, 0], ['triangle', 0, 0]], sat: 6, q: 0.7, sub: 0, g: 0.34, solo1: true }),
        sierra: m.rackSierra({ capas: 3, abre: 28, corte: 2500, g: 0.2, rota: 7 }),
      };
    },
    paso(m, x) {
      const { t, n, s, c, prog, sec, spb } = x, R = m.R, ac = this.acordes[c % 4], gr = this.graves[c % 4];
      if (s === 0) { R.sierra.acorde(t, ac); if (n === 0) R.bajo.filtro(t, 0.78); }
      const chop = (trans, g) => m.melodia(x, this.chops, trans, (e) => ({ tipo: 'sawtooth', tipo2: 'square', det: 14, vocal: e[3], g, a: 0.003, d: 0.08, s: 0.6, r: 0.06, eco: 0.25, pan: e[0] % 4 ? 0.25 : -0.25 }));
      if (sec.t === 'intro') {
        if (s === 0) { R.sierra.nivel(t, 0.4, 0.2); R.sierra.corte(t, 900 + prog * 1500, 0.5); }
        chop(-12, 0.045);
        if (s === 0 || s === 10) m.kick(t, { g: 0.5 });
        if (s % 2 === 0) m.nota(t, ac[(s >> 1) % 4] + 24, spb, { tipo: 'square', corte: 6000, g: 0.016, d: 0.05, s: 0, r: 0.05, eco: 0.3 });
        m.marcaWob(t, 0.2);
      } else if (sec.t === 'subida') {
        const L = sec.c * 16, rest = L - n;
        if (n === 0) { m.subida(t, L * spb); R.sierra.nivel(t, 0, 0.05); }
        if (rest > 2) {
          const div = prog < 0.5 ? 2 : 1;
          if (s % div === 0) { m.palmas(t, { g: 0.2 + prog * 0.35 }); if (prog > 0.5) m.palmas(t + spb / 2, { g: 0.2 + prog * 0.35 }); }
          if (s % 4 === 0) { R.sierra.golpe(t, spb * 2, 0.5); R.sierra.corte(t, 1500 + prog * 6000, 0.05); }
          chop(Math.round(prog * 12), 0.045);   // la voz sube de tono hacia el drop
        } else if (rest === 2) m.marca(t, 'hueco');
        m.marcaWob(t, 0.2 + prog * 0.6);
      } else if (sec.t === 'drop') {
        const v = sec.v || 0, k = n % 32;
        if (n === 0) { m.impacto(t); R.sierra.nivel(t, 0, 0.02); }
        if (v ? s % 4 === 0 : (s === 0 || s === 6 || s === 10)) m.kick(t, { g: 0.85, f0: 200, f1: 52, cae: 0.2, dist: 1 });
        if (s === 8 || (v && (s === 4 || s === 12))) m.palmas(t, { g: 0.55 });
        if (c % 4 === 3 && s >= 12) { for (let j = 0; j < 3; j++) m.hat(t + (j * spb) / 3, { g: 0.045 }); }
        else if (s % 2 === 0) m.hat(t, { g: s % 4 === 2 ? 0.055 : 0.03 });
        for (const e of this.b808) if (e[0] === k) { R.bajo.nota(t, gr + e[1], e[2] * spb, e[3] ? 0.07 : 0); m.marcaWob(t, 1); m.marcaWob(t + e[2] * spb * 0.6, 0.35); m.marca(t, 'bajo'); }
        if ([0, 3, 6, 10, 12].includes(s)) { R.sierra.golpe(t, spb * 1.2, 0.5); R.sierra.corte(t, 5200, 0.02); }
        chop(v ? 12 : 0, 0.05);
      } else {   // pausa: se corta todo menos el 808, que se arrastra hacia abajo
        if (n === 0) { R.bajo.nota(t, gr, 8 * spb); R.bajo.nota(t + 8 * spb, gr - 7, 7 * spb, 1.2); R.sierra.nivel(t, 0, 0.02); }
        if (s % 4 === 0) chop(-12, 0.04);
        m.marcaWob(t, 0.35 - prog * 0.25);
      }
    },
  },
  {
    nombre: 'ambient', bpm: 72, raiz: 38, bombeo: 0,
    forma: [['intro', 4], ['subida', 4], ['drop', 8], ['pausa', 4]], bucle: 1,
    acordes: [[54, 57, 61, 64], [56, 59, 64, 66], [54, 59, 62, 66], [57, 61, 64, 68]],   // re lidio
    graves: [38, 40, 35, 33],
    campanas: [[0, 74, 8], [8, 73, 8], [16, 69, 16], [32, 76, 8], [40, 78, 8], [48, 80, 8], [56, 76, 8]],
    racks(m) {
      return {
        bajo: m.rackBajo({ oscs: [['sine', 0, 0], ['triangle', 12, 0]], sat: 1.1, q: 0.5, sub: 0, g: 0.28 }),
        sierra: m.rackSierra({ capas: 3, abre: 10, corte: 500, g: 0.24, q: 0.4 }),
        viento: m.rackRuido({ f: 600, q: 0.6, g: 0.03 }),
      };
    },
    paso(m, x) {
      const { t, n, s, c, prog, sec, spb } = x, R = m.R, ac = this.acordes[c % 4], gr = this.graves[c % 4], tipo = sec.t;
      if (s === 0) { R.sierra.acorde(t, ac); R.sierra.nivel(t, tipo === 'drop' ? 0.75 : 0.55, 1.5); }
      const corte = tipo === 'intro' ? 450 + prog * 300 : tipo === 'subida' ? 750 + prog * prog * 2600 : tipo === 'drop' ? 3200 : 900 - prog * 400;
      if (s % 4 === 0) { R.sierra.corte(t, corte, 1.2); R.viento.frec(t, 300 + corte * 0.6, 1.5); R.bajo.filtro(t, 0.5); }
      m.marcaWob(t, Math.log2(corte / 60) / 7.6);
      if (tipo === 'subida' && n === 0) m.subida(t, sec.c * 16 * spb, 0.45);
      if (tipo !== 'intro' || c >= 2) m.melodia(x, this.campanas, tipo === 'drop' ? 12 : 0, { campana: true, g: 0.05, eco: 0.5, pan: (n % 3) * 0.3 - 0.3 });
      if (tipo === 'drop') {
        if (n === 0) m.impacto(t, 0.3);
        if (s === 0) R.bajo.nota(t, gr, 16 * spb);
        if (s === 0 || s === 8) m.kick(t, { g: 0.4, f0: 90, f1: 42, cae: 0.5, clic: 0 });   // latido
        if ((n * 7) % 5 === 0) m.nota(t, ac[(n * 3) % 4] + 24, spb * 3, { tipo: 'sine', g: 0.014, a: 0.05, d: 0.4, s: 0.3, r: 0.6, eco: 0.6, corte: 8000 });
      }
    },
  },
  {
    nombre: 'techno', bpm: 128, raiz: 43, bombeo: 0.4,
    forma: [['intro', 4], ['subida', 8], ['drop', 16], ['pausa', 8], ['subida', 4], ['drop', 16, 1]], bucle: 3,
    // línea ácida: [paso, semitonos, acento, ligado a la siguiente]
    acido: [[0, 0, 1], [2, 0, 0], [3, 12, 0, 1], [5, 0, 1], [6, 10, 0], [8, 0, 1], [9, 0, 0], [10, 13, 0, 1], [11, 12, 1], [13, 3, 0], [14, 7, 0, 1], [15, 5, 0]],
    golpe: [55, 58, 62, 65],   // sol menor 7, acorde de dub
    racks(m) {
      return {
        bajo: m.rackBajo({ oscs: [['sawtooth', 0, 0]], sat: 2.2, q: 16, sub: 0, g: 0.16, solo1: true }),
        sierra: m.rackSierra({ voces: 4, capas: 2, abre: 8, corte: 1800, g: 0.16, q: 2, eco: 0.45 }),
      };
    },
    paso(m, x) {
      const { t, n, s, c, prog, sec, spb } = x, R = m.R, tipo = sec.t, L = sec.c * 16, rest = L - n;
      const conBombo = tipo === 'drop' || tipo === 'intro' || (tipo === 'subida' && rest > 32);
      if (conBombo && s % 4 === 0) m.kick(t, { g: 0.95, f0: 140, f1: 45, cae: 0.42, dist: 1, retumbe: tipo === 'drop' });
      if (s % 4 === 2 && tipo !== 'intro') m.hat(t, { g: 0.05, abierto: true });
      if (tipo !== 'pausa' || c >= 4) m.hat(t, { g: [0.03, 0.014, 0.038, 0.014][s % 4] * (tipo === 'intro' ? 0.7 : 1) });
      if ((tipo === 'drop' || tipo === 'pausa') && (s === 4 || s === 12)) m.palmas(t, { g: 0.38 });
      const base = tipo === 'intro' ? 0.22 : tipo === 'subida' ? 0.28 + prog * 0.4 : tipo === 'drop' ? 0.5 + 0.12 * Math.sin((n / 16) * Math.PI / 2) : 0.36;
      for (const e of this.acido) if (e[0] === s) {
        R.bajo.nota(t, this.raiz + e[1], (e[3] ? 1.9 : 0.6) * spb, m.ligado ? 0.05 : 0);
        m.ligado = !!e[3];
        const pico = Math.min(0.97, base + 0.22 + (e[2] ? 0.18 : 0));
        R.bajo.env(t, pico, base, 0.06 + (e[2] ? 0.04 : 0));
        m.marcaWob(t, pico); m.marcaWob(t + 0.12, base);
      }
      if (tipo === 'subida') {
        if (n === 0) m.subida(t, L * spb);
        if (rest <= 32 && rest > 2 && s % (prog > 0.85 ? 1 : 2) === 0) m.caja(t, { g: 0.14 + prog * 0.4, tono: 240, cola: 0.06 });
        if (rest === 2) m.marca(t, 'hueco');
      }
      if (tipo === 'drop' && n === 0) m.impacto(t, 0.8);
      if ((tipo === 'pausa' || (tipo === 'drop' && sec.v)) && (s === 3 || s === 10) && c % 2 === 0) { R.sierra.acorde(t, this.golpe); R.sierra.golpe(t, spb * 1.2, 0.5); }
    },
  },
];
export const SENAL_ESTILOS = ESTILOS.map((e) => ({ nombre: e.nombre, bpm: e.bpm, forma: e.forma.map((f) => f[0] + ' ' + f[1]) }));

const mkSec = (f) => ({ t: f[0], c: f[1], v: f[2] || 0 });

export class SenalMaquina extends Base {
  static envio = 0.18;   // poca reverberación general: los bombos secos, el espacio lo pone el eco
  init() {
    const ac = this.S.ac;
    this.ev = []; this.wobs = []; this.pedido = null; this.saltar = false; this.tras = null; this.bn = null; this.ligado = false; this.limpiezaT = 0;
    const bl = ac.createBuffer(1, ac.sampleRate, ac.sampleRate), bd = bl.getChannelData(0);
    for (let i = 0; i < bd.length; i++) bd[i] = Math.random() * 2 - 1;
    this.blanco = bl;
    this.dr = ac.createGain(); this.dr.gain.value = 0.55; this.dr.connect(this.bus);
    this.duck = ac.createGain(); this.duck.connect(this.bus);
    this.mus = ac.createGain(); this.mus.gain.value = 0.85; this.mus.connect(this.duck);
    // eco con filtro en el lazo, sincronizado a corchea con puntillo
    this.eco = ac.createDelay(2); this.ecoIn = ac.createGain();
    const fb = ac.createGain(); fb.gain.value = 0.36;
    const elp = this.biq('lowpass', 2800), ehp = this.biq('highpass', 250);
    this.ecoIn.connect(ehp).connect(this.eco); this.eco.connect(elp); elp.connect(fb).connect(this.eco); elp.connect(this.duck);
    this.kdist = ac.createWaveShaper(); this.kdist.curve = curvaSat(2.2);
    const kg = ac.createGain(); kg.gain.value = 0.6; this.kdist.connect(kg).connect(this.dr);   // la saturación sube el nivel: se compensa
    // retumbe de techno: el bombo por un pasa-bajas saturado con eco corto
    this.rum = ac.createGain(); this.rum.gain.value = 0.5;
    const rlp = this.biq('lowpass', 150), rsh = ac.createWaveShaper(); rsh.curve = curvaSat(3);
    this.rumD = ac.createDelay(1); const rfb = ac.createGain(); rfb.gain.value = 0.42; const rout = ac.createGain(); rout.gain.value = 0.32;
    this.rum.connect(rlp).connect(rsh).connect(this.rumD); this.rumD.connect(rfb).connect(this.rumD); this.rumD.connect(rout).connect(this.dr);
    this.prox = ac.currentTime + 0.12;
    this.cargarEstilo(0, this.prox);
    this.timer = setInterval(() => this.programar(), 25);
    this.capa({ parar: () => { clearInterval(this.timer); if (this.R) Object.values(this.R).forEach((r) => r.parar(this.S.ac.currentTime)); } });
  }
  update() { this.programar(); }
  // API para la sala
  estilo(i) { const obj = this.pedido ?? this.ei; if (i === obj) return; this.pedido = i === this.ei ? null : i; }
  saltarAlDrop() { this.saltar = true; }
  // instante que se está oyendo ahora (descuenta la latencia de salida)
  ahora() {
    const ac = this.S.ac;
    if (ac.getOutputTimestamp) {
      const o = ac.getOutputTimestamp();
      if (o.contextTime > 0 && o.performanceTime > 0) return Math.min(ac.currentTime, o.contextTime + Math.max(0, performance.now() - o.performanceTime) / 1000);
    }
    return ac.currentTime - (ac.outputLatency || ac.baseLatency || 0);
  }

  cargarEstilo(i, t) {
    if (this.R) Object.values(this.R).forEach((r) => r.parar(t));
    this.ei = i; this.E = ESTILOS[i]; this.R = this.E.racks(this);
    this.si = 0; this.n = 0; this.tras = null; this.bn = null; this.ligado = false;
    this.sec = mkSec(this.E.forma[0]);
    const negra = 60 / this.E.bpm;
    this.eco.delayTime.setValueAtTime(negra * 0.75, t); this.rumD.delayTime.setValueAtTime(negra / 4, t);
    this.marcaSec(t);
  }
  marcaSec(t) {
    const E = this.E;
    this.marca(t, 'sec', { tipo: this.sec.t, c: this.sec.c, v: this.sec.v, dur: this.sec.c * 16 * (60 / E.bpm / 4), estilo: E.nombre, i: this.ei, bpm: E.bpm });
  }
  programar() { if (!this.muerto) this.programarHasta(this.S.ac.currentTime + MARGEN); }
  programarHasta(hasta) {
    const ac = this.S.ac;
    // tras un corte largo (pestaña dormida, sistema cargado) no se amontonan las notas atrasadas
    if (this.prox < ac.currentTime) this.prox = ac.currentTime + 0.05;
    let guarda = 0;
    while (this.prox < hasta && guarda++ < 256) {
      const t = this.prox;
      if (this.n % 4 === 0 && this.pedido !== null) { const i = this.pedido; this.pedido = null; this.cargarEstilo(i, t); }
      if (this.n % 16 === 0) this.alCompas(t);
      const spb = 60 / this.E.bpm / 4, sec = this.sec;
      this.E.paso(this, { t, n: this.n, s: this.n % 16, c: this.n >> 4, prog: this.n / (sec.c * 16), sec, spb });
      this.n++; this.prox += spb;
    }
    if (ac.currentTime - this.limpiezaT > 1) this.limpiar(ac.currentTime - 4);
  }
  alCompas(t) {
    const F = this.E.forma, sig = (j) => (j + 1 >= F.length ? this.E.bucle : j + 1);
    if (this.n >= this.sec.c * 16) {
      if (this.tras !== null) { this.si = this.tras; this.tras = null; } else this.si = sig(this.si);
      this.sec = mkSec(F[this.si]); this.n = 0; this.marcaSec(t);
    }
    if (this.saltar) {
      this.saltar = false;
      let j = this.si, g = 0;
      if (this.sec.t === 'drop') { do j = sig(j); while (F[j][0] === 'drop' && g++ < 16); this.si = j; this.sec = mkSec(F[j]); }
      else { do j = sig(j); while (F[j][0] !== 'drop' && g++ < 16); this.tras = j; this.sec = { t: 'subida', c: 2, v: 0 }; }
      this.n = 0; this.marcaSec(t);
    }
  }
  limpiar(lim) {
    this.limpiezaT = this.S.ac.currentTime;
    let sec = null; const ev = [];
    for (const e of this.ev) { if (e.t >= lim) ev.push(e); else if (e.k === 'sec') sec = e; }
    if (sec) ev.unshift(sec);
    this.ev = ev;
    let k = 0; while (k < this.wobs.length - 1 && this.wobs[k + 1].t < lim) k++;
    if (k) this.wobs.splice(0, k);
  }
  // lo que se oye en el instante tv: sección, últimos golpes y el filtro del bajo
  estado(tv) {
    const r = { estilo: this.E.nombre, i: this.ei, bpm: this.E.bpm, seccion: '', prog: 0, compas: 0, compases: 0, t0: 0, dur: 0,
      tKick: -99, kick: 0, tCaja: -99, tDrop: -99, tHueco: -99, tSubida: -99, durSubida: 1, tBajo: -99, wob: 0, adelanto: this.prox - this.S.ac.currentTime };
    for (const e of this.ev) {
      if (e.t > tv) continue;
      switch (e.k) {
        case 'sec': Object.assign(r, { seccion: e.v.tipo, t0: e.t, dur: e.v.dur, estilo: e.v.estilo, i: e.v.i, bpm: e.v.bpm, compases: e.v.c, variante: e.v.v }); break;
        case 'kick': if (e.t >= r.tKick) { r.tKick = e.t; r.kick = e.v; } break;
        case 'caja': if (e.t >= r.tCaja) r.tCaja = e.t; break;
        case 'drop': r.tDrop = e.t; break;
        case 'hueco': r.tHueco = e.t; break;
        case 'subida': r.tSubida = e.t; r.durSubida = e.v; break;
        case 'bajo': if (e.t >= r.tBajo) r.tBajo = e.t; break;
      }
    }
    r.prog = r.dur ? clamp((tv - r.t0) / r.dur, 0, 1) : 0;
    r.compas = Math.min(r.compases - 1, Math.floor(r.prog * r.compases));
    const w = this.wobs; let a = null, b = null;
    for (let k = 0; k < w.length; k++) { if (w[k].t <= tv) a = w[k]; else { b = w[k]; break; } }
    r.wob = a ? (b ? a.v + ((b.v - a.v) * (tv - a.t)) / Math.max(1e-4, b.t - a.t) : a.v) : 0;
    return r;
  }
  marca(t, k, v) { this.ev.push({ t, k, v }); }
  marcaWob(t, v) { const w = this.wobs; let i = w.length; while (i > 0 && w[i - 1].t > t) i--; w.splice(i, 0, { t, v }); }
  wob(t, v) { if (this.R.bajo) this.R.bajo.filtro(t, v); this.marcaWob(t, v); }
  melodia(x, mel, trans, o) {
    const len = mel.len || (mel.len = Math.ceil(Math.max(...mel.map((e) => e[0] + e[2])) / 16) * 16);
    const k = x.n % len;
    for (const e of mel) if (e[0] === k) this.nota(x.t, e[1] + trans, e[2] * x.spb, typeof o === 'function' ? o(e) : o);
  }
  // nota del bajo de brostep: wobble, gruñido de formantes o chirrido
  bajoNota(t, o) {
    const B = this.R.bajo, modo = o.modo || 'w';
    B.nota(t, o.st, o.dur);
    this.bn = { t0: t, fin: t + o.dur, periodo: o.periodo || 2, modo };
    if (modo === 'g') { B.formantes(t, 0.9); B.vocal(t, VOCALES[o.va || 'o'], VOCALES[o.vb || 'a'], o.dur); }
    else if (modo === 'r') { B.formantes(t, 0.5); B.vocal(t, VOCALES.i, VOCALES.e, o.dur); }
    else B.formantes(t, 0);
    this.marca(t, 'bajo', o.st);
  }
  wobPaso(t, spb) {
    const bn = this.bn, k = bn && bn.periodo < 1 ? 8 : 4;
    for (let j = 0; j < k; j++) {
      const tt = t + (j * spb) / k;
      let v = 0.06;
      if (bn && tt < bn.fin) {
        if (bn.modo === 'g') v = 0.72 + 0.06 * Math.sin((tt - bn.t0) * 40);
        else {
          const ph = ((tt - bn.t0) / spb / bn.periodo) % 1, lo = bn.modo === 'r' ? 0.45 : 0.12, hi = bn.modo === 'r' ? 0.96 : 0.86;
          v = lo + (hi - lo) * (0.5 - 0.5 * Math.cos(ph * Math.PI * 2));
        }
      }
      this.wob(tt, v);
    }
  }

  // ---------- instrumentos ----------
  biq(tipo, f, q = 0.7) { const b = this.S.ac.createBiquadFilter(); b.type = tipo; b.frequency.value = f; b.Q.value = q; return b; }
  // bajo persistente: osciladores → saturación → dos pasa-bajas (24 dB) ‖ banco de formantes → VCA; sub limpio aparte
  rackBajo({ oscs = [['sawtooth', 0, 0]], sat = 3, q = 6, formantes = false, sub = 0, g = 0.3, solo1 = false } = {}) {
    const ac = this.S.ac, t0 = ac.currentTime;
    const out = ac.createGain(); out.gain.value = g; out.connect(this.mus);
    const pre = ac.createGain(); pre.gain.value = 1.4 / oscs.length;
    const sh = ac.createWaveShaper(); sh.curve = curvaSat(sat); sh.oversample = '2x';
    const lp1 = this.biq('lowpass', 300, q), lp2 = this.biq('lowpass', solo1 ? 16000 : 480, 0.7);
    const vca = ac.createGain(); vca.gain.value = 0;
    pre.connect(sh); sh.connect(lp1).connect(lp2).connect(vca); vca.connect(out);
    const os = oscs.map(([tipo, oct, det]) => { const o = ac.createOscillator(); o.type = tipo; o.detune.value = det; o.connect(pre); o.start(t0); return { o, oct }; });
    let fm = null, bps = [];
    if (formantes) {
      fm = ac.createGain(); fm.gain.value = 0; fm.connect(vca);
      bps = [1, 0.7, 0.4].map((gg, k) => { const b = this.biq('bandpass', VOCALES.a[k], 8); const gk = ac.createGain(); gk.gain.value = gg * 2.6; sh.connect(b).connect(gk).connect(fm); return b; });
    }
    let so = null, sv = null;
    if (sub) { so = ac.createOscillator(); so.type = 'sine'; sv = ac.createGain(); sv.gain.value = 0; so.connect(sv).connect(out); so.start(t0); }
    let fPrev = 55;
    return {
      nota(t, m, dur, glide = 0) {
        const f = mtof(m);
        for (const { o, oct } of os) {
          const k = Math.pow(2, oct / 12);
          if (glide) { o.frequency.setValueAtTime(fPrev * k, t); o.frequency.exponentialRampToValueAtTime(f * k, t + glide); } else o.frequency.setValueAtTime(f * k, t);
        }
        if (so) { if (glide) { so.frequency.setValueAtTime(fPrev / 2, t); so.frequency.exponentialRampToValueAtTime(f / 2, t + glide); } else so.frequency.setValueAtTime(f / 2, t); }
        fPrev = f;
        const off = t + Math.max(0.02, dur - 0.012);
        vca.gain.setTargetAtTime(1, t, 0.003); vca.gain.setTargetAtTime(0, off, 0.01);
        if (sv) { sv.gain.setTargetAtTime(sub, t, 0.004); sv.gain.setTargetAtTime(0, off, 0.012); }
      },
      filtro(t, v) { lp1.frequency.linearRampToValueAtTime(hzF(v), t); if (!solo1) lp2.frequency.linearRampToValueAtTime(hzF(v) * 1.6, t); },
      env(t, pico, base, cae) { lp1.frequency.setValueAtTime(hzF(pico), t); lp1.frequency.setTargetAtTime(hzF(base), t + 0.004, cae); },
      formantes(t, v) { if (fm) fm.gain.setTargetAtTime(v, t, 0.01); },
      vocal(t, A, B, dur) { bps.forEach((b, k) => { b.frequency.setValueAtTime(A[k], t); b.frequency.linearRampToValueAtTime(B[k], t + dur); }); },
      parar(t) {
        out.gain.setTargetAtTime(0, t, 0.04);
        const fin = Math.max(ac.currentTime, t) + 0.4;
        os.forEach(({ o }) => o.stop(fin)); if (so) so.stop(fin);
        os[0].o.onended = () => { try { out.disconnect(); } catch {} };
      },
    };
  }
  // acordes de sierras desafinadas (supersaw), abiertos en estéreo; opcionalmente «rotos» (reducción de bits)
  rackSierra({ voces = 4, capas = 5, abre = 20, corte = 800, q = 0.7, g = 0.2, rota = 0, eco = 0 } = {}) {
    const ac = this.S.ac, t0 = ac.currentTime;
    const out = ac.createGain(); out.gain.value = g; out.connect(this.mus);
    if (eco) { const e = ac.createGain(); e.gain.value = eco; out.connect(e).connect(this.ecoIn); }
    const vca = ac.createGain(); vca.gain.value = 0; vca.connect(out);
    const lp = this.biq('lowpass', corte, q); lp.connect(vca);
    let entrada = lp;
    if (rota) { const sh = ac.createWaveShaper(); sh.curve = curvaRota(rota); sh.connect(lp); entrada = sh; }
    const mez = ac.createGain(); mez.gain.value = 2 / (voces * Math.sqrt(capas)); mez.connect(entrada);
    const vs = [];
    for (let v = 0; v < voces; v++) {
      const fila = [];
      for (let k = 0; k < capas; k++) {
        const o = ac.createOscillator(); o.type = 'sawtooth';
        const x = capas > 1 ? (k / (capas - 1)) * 2 - 1 : 0;
        o.detune.value = x * abre + (Math.random() - 0.5) * 4;
        const p = ac.createStereoPanner(); p.pan.value = x * 0.7;
        o.connect(p).connect(mez); o.start(t0); fila.push(o);
      }
      vs.push(fila);
    }
    return {
      acorde(t, notas) { vs.forEach((fila, v) => { const f = mtof(notas[v % notas.length]); fila.forEach((o) => o.frequency.setValueAtTime(f, t)); }); },
      nivel(t, v, tc = 0.2) { vca.gain.setTargetAtTime(v, t, tc); },
      golpe(t, dur, v) { vca.gain.setTargetAtTime(v, t, 0.004); vca.gain.setTargetAtTime(0, t + dur * 0.4, dur * 0.25); },
      corte(t, hz, tc = 0.1) { lp.frequency.setTargetAtTime(hz, t, tc); },
      parar(t) {
        out.gain.setTargetAtTime(0, t, 0.06);
        const fin = Math.max(ac.currentTime, t) + 0.5;
        vs.flat().forEach((o) => o.stop(fin));
        vs[0][0].onended = () => { try { out.disconnect(); } catch {} };
      },
    };
  }
  rackRuido({ f = 500, q = 0.7, g = 0.03 } = {}) {
    const ac = this.S.ac, src = ac.createBufferSource(); src.buffer = this.S.ruidoBuf || this.blanco; src.loop = true;
    const bp = this.biq('bandpass', f, q), out = ac.createGain(); out.gain.value = 0;
    src.connect(bp).connect(out).connect(this.mus); src.start(ac.currentTime, Math.random());
    out.gain.setTargetAtTime(g, ac.currentTime, 1.5);
    return {
      frec(t, hz, tc = 1) { bp.frequency.setTargetAtTime(hz, t, tc); },
      parar(t) { out.gain.setTargetAtTime(0, t, 0.3); src.stop(Math.max(ac.currentTime, t) + 1.5); src.onended = () => { try { out.disconnect(); } catch {} }; },
    };
  }
  ruidoCorto(t, { tipo = 'highpass', f = 2500, q = 0.7, g = 0.1, cae = 0.03, dest = this.dr, largo = 0 } = {}) {
    const ac = this.S.ac, src = ac.createBufferSource(); src.buffer = this.blanco; src.loop = true;
    const b = this.biq(tipo, f, q), e = ac.createGain(); e.gain.value = 0;
    e.gain.setValueAtTime(0, t); e.gain.linearRampToValueAtTime(g, t + 0.001);
    if (largo) { e.gain.setValueAtTime(g * 0.8, t + largo); e.gain.linearRampToValueAtTime(0, t + largo + 0.012); }   // compuerta
    else e.gain.setTargetAtTime(0, t + 0.002, cae / 3);
    src.connect(b).connect(e).connect(dest); src.start(t, Math.random() * 0.5); src.stop(t + (largo || cae * 2.5) + 0.05);
    src.onended = () => { try { e.disconnect(); } catch {} };
    return b;
  }
  bombeo(t) {
    const p = this.E.bombeo || 0; if (!p) return;
    const gg = this.duck.gain; gg.setTargetAtTime(1 - p, t, 0.004); gg.setTargetAtTime(1, t + 0.03, 0.07 + (60 / this.E.bpm) * 0.08);
  }
  kick(t, { g = 0.85, f0 = 160, f1 = 48, cae = 0.36, clic = 0.25, dist = 0, retumbe = false } = {}) {
    const ac = this.S.ac, o = ac.createOscillator(), e = ac.createGain();
    o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(f1, t + 0.08);
    e.gain.setValueAtTime(0, t); e.gain.linearRampToValueAtTime(g, t + 0.003); e.gain.setTargetAtTime(0, t + 0.03, cae / 3.5);
    o.connect(e).connect(dist ? this.kdist : this.dr); if (retumbe) e.connect(this.rum);
    o.start(t); o.stop(t + cae * 2 + 0.1); o.onended = () => { try { e.disconnect(); } catch {} };
    if (clic) this.ruidoCorto(t, { f: 2500, g: g * clic, cae: 0.006 });
    this.bombeo(t); this.marca(t, 'kick', g);
  }
  caja(t, { g = 0.5, tono = 190, cola = 0.16, compuerta = 0 } = {}) {
    const ac = this.S.ac, o = ac.createOscillator(), e = ac.createGain(); o.type = 'triangle';
    o.frequency.setValueAtTime(tono, t); o.frequency.exponentialRampToValueAtTime(tono * 0.7, t + 0.06);
    e.gain.setValueAtTime(0, t); e.gain.linearRampToValueAtTime(g * 0.7, t + 0.002); e.gain.setTargetAtTime(0, t + 0.01, 0.03);
    o.connect(e).connect(this.dr); o.start(t); o.stop(t + 0.3); o.onended = () => { try { e.disconnect(); } catch {} };
    this.ruidoCorto(t, { tipo: 'bandpass', f: 2600, q: 0.6, g, cae: cola });
    if (compuerta) this.ruidoCorto(t, { tipo: 'bandpass', f: 1800, q: 0.5, g: g * 0.35, largo: compuerta });
    this.marca(t, 'caja', g);
  }
  palmas(t, { g = 0.4 } = {}) {
    for (const [d, k] of [[0, 0.7], [0.011, 0.8], [0.022, 1]]) this.ruidoCorto(t + d, { tipo: 'bandpass', f: 1300, q: 1.1, g: g * k, cae: d > 0.02 ? 0.14 : 0.01 });
    this.marca(t, 'caja', g);
  }
  hat(t, { g = 0.04, abierto = false } = {}) { this.ruidoCorto(t, { f: abierto ? 6500 : 8000, q: 0.5, g, cae: abierto ? 0.22 : 0.035 }); }
  tom(t, m, g = 0.3) {
    const ac = this.S.ac, o = ac.createOscillator(), e = ac.createGain(), f = mtof(m);
    o.frequency.setValueAtTime(f, t); o.frequency.exponentialRampToValueAtTime(f * 0.6, t + 0.2);
    e.gain.setValueAtTime(0, t); e.gain.linearRampToValueAtTime(g, t + 0.003); e.gain.setTargetAtTime(0, t + 0.02, 0.08);
    o.connect(e).connect(this.dr); o.start(t); o.stop(t + 0.5); o.onended = () => { try { e.disconnect(); } catch {} };
    this.marca(t, 'caja', g * 0.6);
  }
  // voz melódica: dos osciladores → pasa-bajas (o formantes, para las «voces») → envolvente, con vibrato y eco
  nota(t, m, dur, o = {}) {
    const ac = this.S.ac, f = mtof(m);
    let { tipo = 'sawtooth', tipo2 = null, det = 7, corte = 2400, q = 1, g = 0.05, a = 0.005, d = 0.2, s = 0.6, r = 0.2, vib = 0, eco = 0, pan = 0, vocal = null, campana = false } = o;
    if (campana) { tipo = 'sine'; tipo2 = 'sine'; det = 1200 * Math.log2(2.76); a = 0.002; d = 1.5; s = 0; r = 1.6; corte = 7000; }
    const e = ac.createGain(); e.gain.value = 0;
    const p = ac.createStereoPanner(); p.pan.value = pan;
    e.connect(p).connect(this.mus);
    if (eco) { const se = ac.createGain(); se.gain.value = eco; p.connect(se).connect(this.ecoIn); }
    let entradas;
    if (vocal) {
      const V = VOCALES[vocal];
      entradas = [0, 1, 2].map((k) => { const b = this.biq('bandpass', V[k] * 1.25, 7), gk = ac.createGain(); gk.gain.value = [2.4, 1.7, 1][k]; b.connect(gk).connect(e); return b; });
    } else { const lp = this.biq('lowpass', corte, q); lp.connect(e); entradas = [lp]; }
    const o1 = ac.createOscillator(); o1.type = tipo; o1.frequency.value = f;
    const o2 = tipo2 ? ac.createOscillator() : null;
    if (o2) { o2.type = tipo2; o2.frequency.value = f; o2.detune.value = det; }
    for (const en of entradas) { o1.connect(en); if (o2) o2.connect(en); }
    const fin = t + dur + r * 2 + 0.05;
    if (vib) {
      const lfo = ac.createOscillator(), lg = ac.createGain(); lfo.frequency.value = 5.6; lg.gain.value = 0;
      lg.gain.setValueAtTime(0, t); lg.gain.linearRampToValueAtTime(vib, t + Math.min(0.25, dur));
      lfo.connect(lg); lg.connect(o1.detune); if (o2) lg.connect(o2.detune); lfo.start(t); lfo.stop(fin);
    }
    e.gain.setValueAtTime(0, t); e.gain.linearRampToValueAtTime(g, t + a); e.gain.setTargetAtTime(g * s, t + a, d / 3);
    e.gain.setTargetAtTime(0, t + Math.max(a, dur), r / 3);
    o1.start(t); o1.stop(fin); if (o2) { o2.start(t); o2.stop(fin); }
    o1.onended = () => { try { p.disconnect(); } catch {} };
  }
  // subida: ruido que barre hacia arriba y una sirena que sube dos octavas
  subida(t, dur, g = 1) {
    const ac = this.S.ac, fin = t + dur;
    const src = ac.createBufferSource(); src.buffer = this.blanco; src.loop = true;
    const bp = this.biq('bandpass', 300, 2.2), e = ac.createGain(); e.gain.value = 0;
    bp.frequency.setValueAtTime(300, t); bp.frequency.exponentialRampToValueAtTime(9000, fin);
    e.gain.setValueAtTime(0, t); e.gain.linearRampToValueAtTime(0.14 * g, fin - 0.02); e.gain.linearRampToValueAtTime(0, fin);
    src.connect(bp).connect(e).connect(this.dr); src.start(t); src.stop(fin + 0.05);
    const o = ac.createOscillator(); o.type = 'sawtooth';
    o.frequency.setValueAtTime(mtof(this.E.raiz + 36), t); o.frequency.exponentialRampToValueAtTime(mtof(this.E.raiz + 60), fin);
    const lp = this.biq('lowpass', 2500), oe = ac.createGain(); oe.gain.value = 0;
    oe.gain.setValueAtTime(0, t); oe.gain.linearRampToValueAtTime(0.022 * g, fin - 0.02); oe.gain.linearRampToValueAtTime(0, fin);
    o.connect(lp).connect(oe).connect(this.mus); o.start(t); o.stop(fin + 0.05);
    o.onended = () => { try { oe.disconnect(); e.disconnect(); } catch {} };
    this.marca(t, 'subida', dur);
  }
  // el golpe del drop: estruendo grave, platillo y un barrido que cae
  impacto(t, g = 1) {
    const ac = this.S.ac, o = ac.createOscillator(), e = ac.createGain();
    o.frequency.setValueAtTime(75, t); o.frequency.exponentialRampToValueAtTime(30, t + 0.9);
    e.gain.setValueAtTime(0, t); e.gain.linearRampToValueAtTime(0.75 * g, t + 0.004); e.gain.setTargetAtTime(0, t + 0.05, 0.35);
    o.connect(e).connect(this.dr); o.start(t); o.stop(t + 2); o.onended = () => { try { e.disconnect(); } catch {} };
    this.ruidoCorto(t, { f: 3500, g: 0.15 * g, cae: 1.8 });
    const b = this.ruidoCorto(t, { tipo: 'bandpass', f: 5000, q: 1.5, g: 0.2 * g, cae: 1.0 });
    b.frequency.setValueAtTime(5000, t); b.frequency.exponentialRampToValueAtTime(140, t + 1.1);
    this.marca(t, 'drop', g);
  }
}

const PARTITURAS = {
  silencio: class extends Base {},

  // Antesala: un acorde quieto cuya raíz cambia con la sala elegida, y encima una cajita de música lenta:
  // un motivo pentatónico de cinco notas que se dice dos veces (la segunda queda en suspenso, en la quinta)
  // y se contesta en la tónica; luego calla un compás. Cada sala elegida trae un motivo nuevo en su tono.
  antesala: class extends Base {
    init() {
      this.d = this.capa(this.S.dron([mtof(38), mtof(45), mtof(52)], { tipo: 'sine', corte: 700, g: 0.05, lfo: 0.07, lfoProf: 150, dest: this.bus }));
      this.raiz = 38; this.k = 0; this.cambio = true;
      const paso = () => { if (this.muerto) return; try { this.tic(); } catch {} this.timer = setTimeout(paso, 430); };
      this.timer = setTimeout(paso, 2200);
    }
    nuevoMotivo() {
      const esc = [0, 2, 4, 7, 9, 12, 14, 16, 19];
      let i = 3 + Math.floor(Math.random() * 3);
      this.motivo = [0, 1, 2, 3, 4].map((j) => { if (j) i = clamp(i + [-2, -1, -1, 1, 1, 2][Math.floor(Math.random() * 6)], 1, esc.length - 1); return esc[i]; });
    }
    tic() {
      const S = this.S;
      if (!S.ac || S.pausado || S.ac.state !== 'running') return;
      const fase = this.k % 32; this.k++;
      if (fase === 0 && this.cambio) { this.nuevoMotivo(); this.cambio = false; }
      const bloque = fase >> 3, p = fase & 7, j = [0, 1, 2, 4, 6].indexOf(p);
      if (bloque === 3 || j < 0) return;
      let st = this.motivo[j];
      if (j === 4) st = bloque === 1 ? 7 : bloque === 2 ? 12 : st;        // pregunta en la quinta, respuesta en la tónica
      const m = this.raiz + 36 + st, largo = j === 4;
      S.voz({ f: mtof(m), tipo: 'sine', tipo2: 'triangle', det: 1200, a: 0.004, d: largo ? 1.8 : 0.9, s: 0, r: largo ? 2.2 : 1.2, g: largo ? 0.034 : 0.026, corte: 2600, pan: (j - 2) * 0.18, dest: this.bus });
      if (bloque === 2 && j === 4) S.voz({ f: mtof(m - 12), tipo: 'sine', a: 0.01, d: 2.4, s: 0, r: 2.6, g: 0.03, corte: 1200, dest: this.bus });
    }
    salir(t) { clearTimeout(this.timer); super.salir(t); }
    evento(n, v) {
      const S = this.S;
      if (n === 'mover') {
        S.voz({ f: 1320, tipo: 'sine', a: 0.002, d: 0.05, r: 0.05, g: 0.04, corte: 4000, dest: this.bus });
        const r = 38 + [0, 5, 7, 3, 10, 2, 9, 4, 11, 6, 8][v.i % 11];
        if (r !== this.raiz) { this.raiz = r; this.cambio = true; this.k = 0; }
        this.d.frec([mtof(r), mtof(r + 7), mtof(r + 14)], 0.6);
      } else if (n === 'elegir') {
        S.voz({ f: mtof(74), tipo: 'triangle', a: 0.005, d: 0.4, r: 0.8, g: 0.08, corte: 3000, dest: this.bus });
        S.voz({ f: mtof(81), tipo: 'triangle', a: 0.005, d: 0.5, r: 1.0, g: 0.06, corte: 3000, dest: this.bus, t0: 0.09 });
      }
    }
  },

  // Colisión: un bordón grave que se abre a medida que los núcleos se acercan.
  colision: class extends Base {
    init() { this.d = this.capa(this.S.dron([55, 82.41, 110.3], { tipo: 'sawtooth', corte: 220, q: 1.2, g: 0.07, lfo: 0.05, lfoProf: 40, dest: this.bus })); }
    update(s) { const c = clamp(s.cerca ?? 0.3, 0, 1); this.d.corte(160 + c * c * 1300, 0.8); this.d.ganancia(0.05 + c * 0.05, 0.8); }
    evento(n) {
      if (n === 'a') {
        this.S.soplo({ f: 2400, f2: 120, q: 0.9, a: 0.01, r: 1.8, g: 0.22, dest: this.bus });
        this.S.voz({ f: 41, tipo: 'sine', a: 0.01, d: 1.4, r: 1.5, g: 0.35, corte: 200, dest: this.bus });
      }
    }
  },

  // Atractores: cada vez que la trayectoria testigo cruza el plano x = 0 (una sección de Poincaré)
  // suena una nota; la altura sale de z. El caos se oye: nunca hay dos frases iguales.
  atractores: class extends Base {
    init() { this.d = this.capa(this.S.dron([mtof(38), mtof(45)], { tipo: 'triangle', corte: 500, g: 0.035, dest: this.bus })); }
    evento(n, v) {
      if (n === 'cruce') {
        const grado = Math.round(clamp(v.z, 0, 1) * 9);
        const m = escala(PENTA_RE, 62, grado);
        this.S.voz({ f: mtof(m), tipo: 'triangle', tipo2: 'sine', det: 3, a: 0.004, d: 0.5, s: 0, r: 0.9, g: 0.07, corte: 2400, barrido: 0.3, pan: v.lado * 0.45, dest: this.bus });
      } else if (n === 'a') {
        this.S.voz({ f: mtof(38), tipo: 'sine', a: 0.02, d: 1.5, r: 2, g: 0.18, corte: 600, dest: this.bus });
      }
    }
  },

  // Péndulos: un tono que sigue el ángulo del péndulo testigo; el ruido entra cuando el abanico se dispersa.
  pendulos: class extends Base {
    init() {
      this.d = this.capa(this.S.dron([220], { tipo: 'sine', corte: 2000, g: 0.0, dest: this.bus }));
      this.n = this.capa(this.S.ruido({ f: 900, q: 0.6, g: 0.0, dest: this.bus }));
    }
    update(s) {
      if (s.vista === 0) {
        const a = s.angulo ?? 0;
        this.d.frec([mtof(57 + 12 * (0.5 + 0.5 * Math.sin(a)))], 0.08);
        this.d.ganancia(0.035, 0.4);
        const c = clamp(s.caos ?? 0, 0, 1);
        this.n.ganancia(c * 0.035, 0.6); this.n.frec(400 + c * 2600, 0.6);
      } else {
        this.d.ganancia(0.0, 0.5);
        this.n.ganancia(clamp(s.actividad ?? 0, 0, 1) * 0.045, 0.3); this.n.frec(2200, 0.3);
      }
    }
    evento(n, v) {
      if (n === 'vuelta') this.S.voz({ f: mtof(escala(PENTA_RE, 69, v.k | 0)), tipo: 'sine', a: 0.003, d: 0.6, r: 1.2, g: 0.06, corte: 3000, pan: v.pan || 0, dest: this.bus });
      if (n === 'a') this.S.voz({ f: mtof(50), tipo: 'triangle', a: 0.01, d: 0.6, r: 1, g: 0.1, corte: 900, dest: this.bus });
    }
  },

  // Chladni: la placa suena en la frecuencia de su modo (m, n). El arco (A) la excita.
  chladni: class extends Base {
    init() {
      this.f = 220;
      this.d = this.capa(this.S.dron([220, 440, 660], { tipo: 'sine', corte: 4000, g: 0.0, det: 2, dest: this.bus }));
      this.d.oscs[1].frequency.value = 440; this.d.oscs[2].frequency.value = 660;
      const ac = this.S.ac; // vibrato
      this.lfo = ac.createOscillator(); this.lfo.frequency.value = 4.6; const lg = ac.createGain(); lg.gain.value = 3;
      this.lfo.connect(lg); this.d.oscs.forEach((o) => lg.connect(o.detune)); this.lfo.start();
      this.capa({ parar: () => this.lfo.stop() });
    }
    update(s) {
      if (s.freq && Math.abs(s.freq - this.f) > 0.5) { this.f = s.freq; this.d.frec([this.f, this.f * 2.0, this.f * 2.76], 0.12); }
      this.d.ganancia(0.02 + clamp(s.amp ?? 0, 0, 1) * 0.07, 0.25);
    }
    evento(n) {
      if (n === 'arco' || n === 'a') this.S.soplo({ f: this.f * 2, q: 6, a: 0.08, r: 0.9, g: 0.12, dest: this.bus });
    }
  },

  // Morfogénesis: un acorde húmedo y gotas cuando se siembra.
  morfogenesis: class extends Base {
    init() { this.d = this.capa(this.S.dron([mtof(46), mtof(53), mtof(56), mtof(61)], { tipo: 'triangle', corte: 650, g: 0.04, lfo: 0.09, lfoProf: 220, dest: this.bus })); }
    update(s, dt) {
      this.t += dt;
      const act = clamp(s.mov ?? 0, 0, 1);
      if (Math.random() < dt * (0.25 + act * 5)) this.gota();
    }
    gota() {
      const m = escala(PENTA_RE, 70 - 2, (Math.random() * 8) | 0);
      this.S.voz({ f: mtof(m), tipo: 'sine', a: 0.002, d: 0.12, r: 0.25, g: 0.035, corte: 3000, pan: Math.random() * 1.2 - 0.6, dest: this.bus });
    }
    evento(n) { if (n === 'a') { this.gota(); this.gota(); } }
  },

  // Plasmodio: un pad que respira lento; campana cuando la colonia estalla.
  plasmodio: class extends Base {
    init() { this.d = this.capa(this.S.dron([mtof(40), mtof(47), mtof(52), mtof(56)], { tipo: 'sawtooth', corte: 420, q: 2, g: 0.04, lfo: 0.11, lfoProf: 260, dest: this.bus })); }
    evento(n) {
      if (n === 'a') [0, 7, 12].forEach((k, i) => this.S.voz({ f: mtof(76 + k), tipo: 'sine', tipo2: 'sine', det: 1200 * Math.log2(2.76), a: 0.003, d: 1.6, r: 2, g: 0.05, corte: 5000, t0: i * 0.06, dest: this.bus }));
    }
  },

  // Tinta: un lavado de ruido que se abre cuando agitas el agua.
  tinta: class extends Base {
    init() {
      this.n = this.capa(this.S.ruido({ tipo: 'lowpass', f: 300, q: 0.4, g: 0.03, dest: this.bus }));
      this.d = this.capa(this.S.dron([mtof(36), mtof(43)], { tipo: 'sine', corte: 500, g: 0.04, dest: this.bus }));
      this.ag = 0;
    }
    update(s, dt) { this.ag += ((s.mov ?? 0) - this.ag) * Math.min(1, dt * 2); this.n.frec(250 + this.ag * 2400, 0.2); this.n.ganancia(0.025 + this.ag * 0.06, 0.2); }
    evento(n) { if (n === 'a') this.S.soplo({ f: 200, f2: 2600, q: 1.2, a: 0.25, r: 0.9, g: 0.12, dest: this.bus }); }
  },

  // Viento: ruido filtrado según la rapidez medida por el anemómetro; un silbido eólico que sube con ella.
  viento: class extends Base {
    init() {
      this.n = this.capa(this.S.ruido({ f: 300, q: 0.9, g: 0.0, dest: this.bus }));
      this.w = this.capa(this.S.dron([520], { tipo: 'sine', corte: 3000, g: 0.0, dest: this.bus }));
      this.v = 0;
    }
    update(s, dt) {
      const v = clamp((s.rapidez ?? 5) / 9, 0, 1.4);
      this.v += (v - this.v) * Math.min(1, dt * 3);
      this.n.frec(140 + this.v * 900, 0.15); this.n.ganancia(0.02 + this.v * this.v * 0.11, 0.15);
      this.w.frec([380 + this.v * 520], 0.3); this.w.ganancia(this.v > 0.55 ? (this.v - 0.55) * 0.03 : 0, 0.4);
    }
    evento(n) { if (n === 'modo') this.S.voz({ f: 880, tipo: 'sine', a: 0.003, d: 0.08, r: 0.1, g: 0.05, dest: this.bus }); }
  },

  // Bulbo: un acorde lidio que se aclara con el movimiento de la cámara.
  bulbo: class extends Base {
    init() { this.d = this.capa(this.S.dron([mtof(41), mtof(48), mtof(52), mtof(55), mtof(59)], { tipo: 'triangle', corte: 700, g: 0.04, lfo: 0.06, lfoProf: 180, dest: this.bus })); this.m = 0; }
    update(s, dt) { this.m += ((s.mov ?? 0) - this.m) * Math.min(1, dt * 1.5); this.d.corte(600 + this.m * 2200, 0.3); }
    evento(n) { if (n === 'a') this.S.voz({ f: mtof(29), tipo: 'sine', tipo2: 'triangle', det: 1200 * Math.log2(2.4), a: 0.01, d: 2.5, r: 3, g: 0.16, corte: 900, dest: this.bus }); }
  },

  // Luz: campanas de vidrio que se espacian a medida que la imagen converge, hasta el silencio.
  luz: class extends Base {
    init() { this.d = this.capa(this.S.dron([mtof(60), mtof(67), mtof(71)], { tipo: 'sine', corte: 2400, g: 0.0, dest: this.bus })); }
    update(s, dt) {
      const ruido = clamp(s.ruido ?? 1, 0, 1);
      if (Math.random() < dt * ruido * 6) {
        const m = escala(LIDIO, 72, (Math.random() * 10) | 0);
        this.S.voz({ f: mtof(m), tipo: 'sine', tipo2: 'sine', det: 1200 * Math.log2(3.01), a: 0.002, d: 0.8, r: 1.4, g: 0.03 + ruido * 0.03, corte: 6000, pan: Math.random() * 1.4 - 0.7, dest: this.bus });
      }
      this.d.ganancia((1 - ruido) * 0.03, 1.5);
    }
    evento(n) { if (n === 'a') this.d.ganancia(0, 0.1); }
  },

  // Señal: máquina de estilos con forma de pista (ver SenalMaquina arriba).
  senal: SenalMaquina,

  ensamble: class extends Base {
    init() {
      this.d = this.capa(this.S.dron([mtof(43), mtof(50), mtof(55), mtof(62)], { tipo: 'triangle', corte: 800, g: 0.04, lfo: 0.08, lfoProf: 250, dest: this.bus }));
      this.n = this.capa(this.S.ruido({ tipo: 'lowpass', f: 300, q: 0.4, g: 0.015, dest: this.bus }));
      this.ag = 0;
    }
    update(s, dt) { this.ag += ((s.mov ?? 0) - this.ag) * Math.min(1, dt * 2); this.n.frec(250 + this.ag * 2000, 0.2); }
    evento(n) { if (n === 'a') this.S.soplo({ f: 300, f2: 3000, q: 1, a: 0.2, r: 1, g: 0.12, dest: this.bus }); }
  },

};
