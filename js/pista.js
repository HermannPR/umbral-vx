// Tu música: una canción propia (o el micrófono) que Señal escucha y convierte en imagen.
// Análisis propio, sin dependencias (la receta común de los visualizadores web):
//   · bandas graves / medios / agudos con suavizado asimétrico (ataque rápido, caída lenta)
//     y control automático de ganancia por seguidor de pico: cualquier mezcla llena la escala;
//   · golpes por flujo espectral (solo lo que sube entre cuadros) con umbral adaptativo
//     (media + k·desviación de los últimos ~1.5 s) y periodo refractario;
//   · secciones aproximadas: energía corta contra larga (subida, drop, pausa);
//   · BPM al cargar el archivo, por autocorrelación de la envolvente de golpes.
// La salida tiene la misma forma que estado() de la máquina de Señal: la sala no distingue una de otra.
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const reducido = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const CLAVE = 'umbral.pista';
const BANDAS = [[30, 150], [150, 2000], [2000, 12000]];
const HIST = 90;                 // ~1.5 s de flujo a 60 fps

export const AJUSTES_BASE = { sensibilidad: 1, suavizado: 0.5, graves: 1, medios: 1, agudos: 1, volumen: 0.85, bucle: true, destellos: !reducido };

export class Pista {
  constructor(sonido) {
    this.S = sonido;
    this.ajustes = { ...AJUSTES_BASE };
    try { Object.assign(this.ajustes, JSON.parse(localStorage.getItem(CLAVE) || '{}')); } catch {}
    this.fuente = null;          // 'archivo' | 'mic' | null
    this.nombre = ''; this.buffer = null; this.dur = 0; this.offset = 0; this.t0 = 0; this.sonando = false; this.nodo = null;
    this.picos = null; this.bpm = 0; this.enSalaSenal = false; this.seguir = false;
    this.oyentes = new Set();
    this.reiniciarAnalisis();
  }
  get activa() { return !!this.fuente; }
  alCambiar(f) { this.oyentes.add(f); return () => this.oyentes.delete(f); }
  avisar() { for (const f of this.oyentes) { try { f(this); } catch {} } }
  guardar() { try { localStorage.setItem(CLAVE, JSON.stringify(this.ajustes)); } catch {} }
  ajustar(k, v) {
    this.ajustes[k] = v; this.guardar();
    if (k === 'volumen' && this.vol) this.vol.gain.setTargetAtTime(v, this.S.ac.currentTime, 0.05);
    if (k === 'bucle' && this.nodo) { const p = this.pos(); this.reproducir(p); }
  }

  // nodos: fuente → entrada → (analizador propio) y → volumen → salida maestra (+ osciloscopio de la sala)
  asegurar() {
    const S = this.S;
    S.iniciar(true);
    if (!S.ac) throw new Error('Este navegador no tiene Web Audio');
    if (this.entrada) return;
    const ac = S.ac;
    this.entrada = ac.createGain();
    this.an = ac.createAnalyser(); this.an.fftSize = 2048; this.an.smoothingTimeConstant = 0;
    this.vol = ac.createGain(); this.vol.gain.value = this.ajustes.volumen;
    this.entrada.connect(this.an);
    this.entrada.connect(this.vol);
    this.vol.connect(S.master); this.vol.connect(S.analizador);
    this.fdb = new Float32Array(this.an.frequencyBinCount);
    this.mag0 = new Float32Array(this.an.frequencyBinCount);
  }

  async cargarArchivo(file) {
    if (!file) return;
    if (!/^audio\/|\.(mp3|wav|ogg|oga|flac|m4a|aac|opus|webm)$/i.test(file.type || file.name)) throw new Error('Ese archivo no parece audio');
    if (file.size > 250 * 1024 * 1024) throw new Error('El archivo pasa de 250 MB');
    this.asegurar();
    this.cargando = file.name; this.avisar();
    try {
      const datos = await file.arrayBuffer();
      const buf = await this.S.ac.decodeAudioData(datos);
      this.quitar(false);
      this.buffer = buf; this.dur = buf.duration; this.nombre = file.name.replace(/\.[^.]+$/, '');
      this.fuente = 'archivo'; this.offset = 0;
      this.picos = picosDe(buf, 720);
      this.bpm = bpmDe(buf);
      this.reiniciarAnalisis();
      this.S.generativa(false);
      this.reproducir(0);
    } finally { this.cargando = null; this.avisar(); }
  }

  async microfono() {
    this.asegurar();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('Este navegador no da acceso al micrófono');
    const st = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    this.quitar(false);
    this.stream = st;
    this.mic = this.S.ac.createMediaStreamSource(st);
    // el micrófono solo se analiza: nunca va a los altavoces (no hay acople)
    this.mic.connect(this.an); this.mic.connect(this.S.analizador);
    this.fuente = 'mic'; this.nombre = 'micrófono'; this.bpm = 0; this.picos = null; this.sonando = true;
    this.reiniciarAnalisis();
    this.S.generativa(false);
    this.avisar();
  }

  quitar(avisar = true) {
    this.parar();
    if (this.mic) { try { this.mic.disconnect(); } catch {} this.mic = null; }
    if (this.stream) { this.stream.getTracks().forEach((t) => t.stop()); this.stream = null; }
    const habia = !!this.fuente;
    this.fuente = null; this.buffer = null; this.picos = null; this.nombre = ''; this.dur = 0; this.offset = 0; this.sonando = false; this.bpm = 0; this.seguir = false;
    if (habia && this.S.ac) this.S.generativa(true);
    if (avisar) this.avisar();
  }

  reproducir(desde = this.pos()) {
    if (this.fuente !== 'archivo' || !this.buffer) return;
    this.parar();
    const ac = this.S.ac, n = ac.createBufferSource();
    n.buffer = this.buffer; n.loop = !!this.ajustes.bucle; n.connect(this.entrada);
    n.onended = () => { if (this.nodo === n) { this.nodo = null; this.sonando = false; this.offset = 0; this.avisar(); } };
    this.offset = clamp(desde, 0, Math.max(0, this.dur - 0.05)); this.t0 = ac.currentTime;
    n.start(0, this.offset);
    this.nodo = n; this.sonando = true;
    this.avisar();
  }
  pausar() { if (this.fuente !== 'archivo') return; this.offset = this.pos(); this.parar(); this.sonando = false; this.avisar(); }
  alternar() { if (this.sonando) this.pausar(); else this.reproducir(); }
  buscar(seg) { if (this.fuente !== 'archivo') return; if (this.sonando) this.reproducir(seg); else { this.offset = clamp(seg, 0, this.dur); this.avisar(); } }
  parar() { if (this.nodo) { const n = this.nodo; this.nodo = null; n.onended = null; try { n.stop(); } catch {} try { n.disconnect(); } catch {} } }
  // posición en el reloj del audio: se congela sola cuando el contexto se suspende (pausa, ventana sin foco)
  pos() {
    if (this.fuente !== 'archivo' || !this.buffer) return 0;
    if (!this.sonando || !this.S.ac) return this.offset;
    const p = this.offset + (this.S.ac.currentTime - this.t0);
    return this.nodo && this.nodo.loop ? p % this.dur : Math.min(p, this.dur);
  }

  // al salir de Señal la canción espera; al volver, sigue donde iba
  enSala(esSenal) {
    this.enSalaSenal = esSenal;
    if (!this.fuente) return;
    if (!esSenal) { this.seguir = this.sonando; if (this.fuente === 'archivo') this.pausar(); this.S.generativa(true); }
    else { this.S.generativa(false); if (this.seguir) this.reproducir(); }
  }

  reiniciarAnalisis() {
    this.b = [0, 0, 0]; this.pico = [1e-3, 1e-3, 1e-3]; this.hist = BANDAS.map(() => new Float32Array(HIST)); this.hi = 0; this.llenos = 0;
    this.ult = [-99, -99, -99]; this.corto = 0; this.largo = 0; this.minRatio = 1; this.minT = 0;
    this.r = { real: true, pista: true, tv: 0, estilo: 'tu música', bpm: 120, seccion: 'intro', prog: 0, compas: 0, compases: 8,
      tKick: -99, kick: 0, tCaja: -99, tDrop: -99, tHueco: -99, wob: 0, bandas: [0, 0, 0] };
    this.tPrev = performance.now() / 1000; this.subeT = 0;
  }

  // una lectura por cuadro (la llama la sala); devuelve el estado en el mismo formato que la máquina de Señal
  estado() {
    const r = this.r, now = performance.now() / 1000, dt = clamp(now - this.tPrev, 1 / 240, 0.1);
    this.tPrev = now; r.tv = now;
    if (!this.an || !this.fuente || (this.fuente === 'archivo' && !this.sonando)) {
      for (let k = 0; k < 3; k++) this.b[k] *= Math.exp(-dt * 3);
      r.wob = this.b[1] * this.ajustes.medios; r.bandas = this.b.slice(); r.seccion = this.fuente ? 'pausa' : 'intro';
      return r;
    }
    const A = this.ajustes, an = this.an, hz = this.S.ac.sampleRate / an.fftSize;
    an.getFloatFrequencyData(this.fdb);
    const flujo = [0, 0, 0], energia = [0, 0, 0];
    BANDAS.forEach(([a, b], k) => {
      const i0 = Math.max(1, Math.floor(a / hz)), i1 = Math.min(this.fdb.length - 1, Math.ceil(b / hz));
      let e = 0, f = 0;
      for (let i = i0; i <= i1; i++) {
        const m = this.fdb[i] > -160 ? Math.pow(10, this.fdb[i] / 20) : 0;
        const d = m - this.mag0[i]; if (d > 0) f += d;
        this.mag0[i] = m; e += m;
      }
      const n = i1 - i0 + 1; flujo[k] = f / n; energia[k] = e / n;
    });
    // bandas con control de ganancia: el pico decae despacio (~8 s), así la canción llena la escala sola
    const caida = 0.35 + (0.04 - 0.35) * A.suavizado;
    for (let k = 0; k < 3; k++) {
      this.pico[k] = Math.max(energia[k], this.pico[k] * Math.exp(-dt / 8), 1e-4);
      const v = clamp(energia[k] / this.pico[k], 0, 1);
      this.b[k] += (v - this.b[k]) * clamp((v > this.b[k] ? 0.6 : caida) * dt * 60, 0, 1);
    }
    // golpes: flujo sobre su media + k·desviación de ~1.5 s
    const k0 = 1.5 / clamp(A.sensibilidad, 0.2, 3);
    for (let k = 0; k < 3; k++) {
      const h = this.hist[k]; let m = 0, s = 0;
      const nh = Math.max(1, Math.min(this.llenos, HIST));
      for (let i = 0; i < nh; i++) m += h[i];
      m /= nh;
      for (let i = 0; i < nh; i++) s += (h[i] - m) * (h[i] - m);
      s = Math.sqrt(s / nh);
      const umbral = m + k0 * s + 1e-6;
      const golpe = this.llenos > 20 && flujo[k] > umbral && flujo[k] > m * 1.25 && now - this.ult[k] > (k === 0 ? 0.12 : 0.09);
      if (golpe) {
        this.ult[k] = now;
        if (k === 0) { r.tKick = now; r.kick = clamp(0.55 + (flujo[k] / umbral - 1) * 0.6, 0.45, 1); }
        else if (k === 2 || (k === 1 && now - r.tCaja > 0.2)) r.tCaja = now;
      }
      h[this.hi] = flujo[k];
    }
    this.hi = (this.hi + 1) % HIST; this.llenos++;
    // secciones: energía corta (0.35 s) contra larga (8 s)
    const E = energia[0] * 1.4 + energia[1] + energia[2] * 0.6;
    this.corto += (E - this.corto) * (1 - Math.exp(-dt / 0.35));
    this.largo += (E - this.largo) * (1 - Math.exp(-dt / (this.llenos < 120 ? 1 : 8)));
    const ratio = this.corto / Math.max(1e-6, this.largo);
    if (ratio < this.minRatio || now - this.minT > 3.5) { this.minRatio = ratio; this.minT = now; }
    if (ratio > 1.3 && this.minRatio < 0.82 && now - r.tDrop > 6 && this.llenos > 180) { r.tDrop = now; this.minRatio = ratio; }
    if (ratio < 0.5 && now - r.tHueco > 4 && r.tHueco <= r.tDrop) r.tHueco = now;
    if (ratio > 0.85 && r.tHueco > r.tDrop) r.tHueco = -99;          // el hueco termina cuando vuelve la música
    this.subeT = ratio > 1.04 && ratio < 1.3 ? this.subeT + dt : Math.max(0, this.subeT - dt * 2);
    if (now - r.tDrop < 8 && ratio > 0.8) { r.seccion = 'drop'; r.prog = clamp((now - r.tDrop) / 8, 0, 1); }
    else if (this.subeT > 1.2) { r.seccion = 'subida'; r.prog = clamp((this.subeT - 1.2) / 4, 0, 1); }
    else if (ratio < 0.6) { r.seccion = 'pausa'; r.prog = 0; }
    else { r.seccion = 'intro'; r.prog = 0; }
    r.bpm = this.bpm || 120;
    const compas = (240 / r.bpm);
    const t = this.fuente === 'archivo' ? this.pos() : now;
    r.compas = Math.floor(t / compas) % 8; r.compases = 8;
    r.wob = clamp(this.b[1] * A.medios, 0, 1);
    r.bandas = this.b.slice();
    return r;
  }
}

// forma de onda para el panel: máximo absoluto por tramo (mono)
function picosDe(buf, n) {
  const L = buf.length, out = new Float32Array(n), ch = [];
  for (let c = 0; c < Math.min(2, buf.numberOfChannels); c++) ch.push(buf.getChannelData(c));
  const paso = Math.max(1, Math.floor(L / n / 64));
  let max = 1e-6;
  for (let i = 0; i < n; i++) {
    const a = Math.floor((i * L) / n), b = Math.floor(((i + 1) * L) / n);
    let m = 0;
    for (let j = a; j < b; j += paso) for (const d of ch) { const v = Math.abs(d[j]); if (v > m) m = v; }
    out[i] = m; if (m > max) max = m;
  }
  for (let i = 0; i < n; i++) out[i] /= max;
  return out;
}

// BPM aproximado: envolvente de golpes de graves (≈86 Hz) y autocorrelación entre 70 y 180 BPM
function bpmDe(buf) {
  const sr = buf.sampleRate, d = buf.getChannelData(0);
  const ini = Math.min(Math.floor(buf.length * 0.15), sr * 30), fin = Math.min(buf.length, ini + sr * 60);
  if (fin - ini < sr * 8) return 0;
  const hop = 512, nF = Math.floor((fin - ini) / hop), env = new Float32Array(nF);
  let lp = 0, prev = 0;
  const a = 1 - Math.exp((-2 * Math.PI * 180) / sr);       // pasa-bajas de un polo a ~180 Hz
  for (let f = 0; f < nF; f++) {
    let e = 0;
    for (let j = 0; j < hop; j++) { lp += (d[ini + f * hop + j] - lp) * a; e += lp * lp; }
    e = Math.sqrt(e / hop);
    env[f] = Math.max(0, e - prev); prev = e;
  }
  const fps = sr / hop;
  let mejor = 0, bpm = 0;
  for (let b = 70; b <= 180; b += 0.5) {
    const lag = (60 / b) * fps, l0 = Math.floor(lag), fr = lag - l0;
    let s = 0;
    for (let i = 0; i + l0 + 1 < nF; i++) s += env[i] * (env[i + l0] * (1 - fr) + env[i + l0 + 1] * fr);
    s /= nF - l0;
    // preferencia suave por el rango de baile (90–150) para no caer en la mitad o el doble
    const peso = 1 + 0.12 * Math.exp(-Math.pow((b - 120) / 30, 2));
    if (s * peso > mejor) { mejor = s * peso; bpm = b; }
  }
  return Math.round(bpm);
}
