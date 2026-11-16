// Stems de tu canción: voz, batería, bajo y otros, separados en tu propio equipo.
//   · navegador: HTDemucs en ONNX Runtime Web (WebGPU o WASM), en un Worker (stems-worker.js). El modelo de 180 MB
//     se baja una vez y queda en el navegador; después funciona sin conexión.
// Cada stem se puede escuchar o callar, descargar en WAV, y Señal hace que cada visual siga el suyo.
import { wav, envolvente, ataques, entradas } from './stems-util.js';

const SR = 44100;
const MODELO = 'https://huggingface.co/timcsy/demucs-web-onnx/resolve/main/htdemucs_embedded.onnx';
export const NOMBRES = { vocals: 'voz', drums: 'batería', bass: 'bajo', other: 'otros', guitar: 'guitarra', piano: 'piano' };
const ORDEN = ['vocals', 'drums', 'bass', 'guitar', 'piano', 'other'];
const MODELO_MB = 180.5;

export class Stems {
  constructor(pista) {
    this.P = pista;
    this.lista = [];             // [{id, nombre, buf: AudioBuffer, on, blob?}]
    this.fase = 'nada';          // nada | bajando | cargando | preparando | separando | listo | error
    this.p = 0; this.texto = ''; this.motor = ''; this.backend = ''; this.seg = 0;
    this.guardado = null;        // ¿el modelo ya está en este navegador?
    this.puente = null;          // null = sin buscar, false = no hay, {modelo, stems} = hay
    this.de = null;              // la canción (AudioBuffer) de la que salieron
    this.mapa = null;            // envolventes por stem en la rejilla del mapa de la canción
    this.oyentes = new Set();
    this.revisarModelo();
  }
  alCambiar(f) { this.oyentes.add(f); return () => this.oyentes.delete(f); }
  avisar() { for (const f of this.oyentes) { try { f(this); } catch {} } }
  get ocupado() { return ['bajando', 'cargando', 'preparando', 'separando', 'subiendo'].includes(this.fase); }
  get hay() { return this.lista.length > 0; }
  get modeloMB() { return MODELO_MB; }
  // el modelo ya guardado en la caché del navegador (también en la versión pública)
  async revisarModelo() {
    try { const c = await caches.open('umbral-stems-v1'); this.guardado = !!(await c.match(MODELO)); }
    catch { this.guardado = false; }
    this.avisar();
  }

  // la canción cambió: lo separado ya no sirve
  limpiar() {
    if (this.ocupado) this.cancelar();
    this.lista = []; this.de = null; this.mapa = null; this.fase = 'nada'; this.p = 0; this.texto = '';
    this.avisar();
  }

  cancelar() {
    // el worker se tira entero: es lo único que corta un trozo a medias (la próxima vez el modelo sale del caché)
    if (this.worker) { this.worker.terminate(); this.worker = null; }
    if (this.rechazar) { this.rechazar(new Error('cancelado')); this.rechazar = null; }
    if (this.ctlPuente) this.ctlPuente.abort();
    this.fase = 'nada'; this.texto = 'cancelado'; this.p = 0; this.avisar();
  }

  async separar(motor = 'navegador') {
    const P = this.P, buf = P.buffer;
    if (!buf || this.ocupado) return;
    this.lista = []; this.mapa = null; this.de = buf; this.motor = motor; this.p = 0; this.texto = ''; this.t0 = performance.now();
    try {
      const stems = motor === 'puente' ? await this.conPuente(P) : await this.enNavegador(buf);
      if (P.buffer !== buf) return;
      this.lista = ORDEN.filter((k) => stems[k]).map((k) => ({ id: k, nombre: NOMBRES[k] || k, buf: stems[k].buf, blob: stems[k].blob || null, on: true }));
      this.fase = 'listo'; this.p = 1;
      this.seg = (performance.now() - this.t0) / 1000;
      this.texto = `${this.lista.length} stems en ${fmt(this.seg)}${this.backend ? ' · ' + this.backend : ''}`;
      this.avisar();
      P.stemsListos();
    } catch (e) {
      if (P.buffer !== buf) return;
      if (this.fase !== 'nada') { this.fase = 'error'; this.texto = e.message || String(e); }
      this.avisar();
    }
  }

  // ---------- en el navegador ----------
  async enNavegador(buf) {
    this.fase = 'preparando'; this.texto = 'pasando la canción a 44.1 kHz'; this.avisar();
    const [izq, der] = await a441(buf);
    const w = this.worker || (this.worker = new Worker(new URL('./stems-worker.js', import.meta.url), { type: 'module' }));
    return new Promise((res, rej) => {
      this.rechazar = rej;
      w.onerror = (e) => rej(new Error(e.message || 'el worker falló'));
      w.onmessage = (ev) => {
        const m = ev.data;
        if (this.de !== buf) return;
        if (m.tipo === 'fase') {
          this.fase = m.fase === 'bajando' ? 'bajando' : m.fase === 'separando' ? 'separando' : 'cargando';
          if (m.backend) this.backend = m.backend === 'webgpu' ? 'WebGPU' : 'WASM';
          this.texto = m.fase === 'bajando' ? `bajando el modelo (${MODELO_MB} MB, solo esta vez)` : m.fase === 'cargando' ? 'abriendo el modelo' : m.fase === 'preparando' ? 'preparando el modelo' : `separando · ${this.backend}`;
          this.p = 0; this.avisar();
        } else if (m.tipo === 'bajando') {
          this.p = m.n / m.total; this.texto = `bajando el modelo · ${(m.n / 1e6).toFixed(0)} de ${(m.total / 1e6).toFixed(0)} MB (solo esta vez)`; this.avisar();
        } else if (m.tipo === 'avance') {
          this.p = m.p;
          const falta = m.p > 0.02 ? (m.t / m.p) * (1 - m.p) : 0;
          this.texto = `separando · ${this.backend} · trozo ${m.seg} de ${m.de}${falta ? ' · faltan ~' + fmt(falta) : ''}`;
          this.avisar();
        } else if (m.tipo === 'aviso') { console.warn('stems:', m.texto); }
        else if (m.tipo === 'error') { rej(new Error(m.texto === 'cancelado' ? 'cancelado' : 'no se pudo separar: ' + m.texto)); }
        else if (m.tipo === 'listo') {
          this.guardado = true; this.medida = { seg: m.seg, total: m.total, backend: m.backend };
          const ac = this.P.S.ac, out = {};
          for (const [k, [l, r]] of Object.entries(m.stems)) {
            const b = ac.createBuffer(2, l.length, m.sr);
            b.copyToChannel(l, 0); b.copyToChannel(r, 1);
            out[k] = { buf: b };
          }
          res(out);
        }
      };
      w.postMessage({ tipo: 'separar', izq, der }, [izq.buffer, der.buffer]);
    });
  }


  // ---------- escuchar, descargar ----------
  alternar(id) {
    const s = this.lista.find((x) => x.id === id); if (!s) return;
    s.on = !s.on; this.avisar(); this.P.mezclaCambio();
  }
  solo(id) {
    const unico = this.lista.every((x) => x.on === (x.id === id));
    for (const x of this.lista) x.on = unico ? true : x.id === id;
    this.avisar(); this.P.mezclaCambio();
  }
  get mezclaPropia() { return this.hay && this.lista.some((x) => !x.on); }
  blobDe(s) {
    if (!s.blob) s.blob = wav([s.buf.getChannelData(0), s.buf.getChannelData(1)], s.buf.sampleRate);
    return s.blob;
  }
  descargar(id) {
    const s = this.lista.find((x) => x.id === id); if (!s) return;
    const a = document.createElement('a'), url = URL.createObjectURL(this.blobDe(s));
    a.href = url; a.download = `${limpio(this.P.nombre || 'cancion')} - ${s.nombre}.wav`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  async descargarTodos() { for (const s of this.lista) { this.descargar(s.id); await new Promise((r) => setTimeout(r, 400)); } }
  async borrarModelo() { try { await caches.delete('umbral-stems-v1'); } catch {} this.guardado = false; this.avisar(); }

  // por stem, en la rejilla del mapa (fps, off, nF) de la canción: envolvente y ataques. La batería se escucha
  // aparte (bombo, caja, platillos) y la voz da sus entradas tras un silencio.
  prepararMapa(M, analizar, picos) {
    if (!M || !this.hay || this.mapa) return Promise.resolve(this.mapa);
    const env = (ids) => {
      const ss = this.lista.filter((x) => ids.includes(x.id)); if (!ss.length) return null;
      const chs = [];
      for (const s of ss) for (let c = 0; c < s.buf.numberOfChannels; c++) chs.push(s.buf.getChannelData(c));
      // suma de stems (otros + guitarra + piano) en dos canales
      if (ss.length > 1) {
        const L = chs[0].length, a = new Float32Array(L), b = new Float32Array(L);
        for (let i = 0; i < chs.length; i++) { const d = chs[i], o = i % 2 ? b : a; for (let j = 0; j < Math.min(L, d.length); j++) o[j] += d[j]; }
        return envolvente([a, b], ss[0].buf.sampleRate, M.fps, M.nF, M.off);
      }
      return envolvente(chs, ss[0].buf.sampleRate, M.fps, M.nF, M.off);
    };
    const mapa = { voz: env(['vocals']), bateria: env(['drums']), bajo: env(['bass']), otros: env(['other', 'guitar', 'piano']), golpes: null, cajas: null, platillos: null };
    const at = (e, refr) => (e && picos ? ataques(e, M.fps, M.off, picos, refr) : null);
    mapa.ataques = { voz: at(mapa.voz, 0.14), bateria: at(mapa.bateria, 0.09), bajo: at(mapa.bajo, 0.12), otros: at(mapa.otros, 0.1) };
    mapa.entradasVoz = mapa.voz ? entradas(mapa.voz, M.fps, M.off) : null;
    const bat = this.lista.find((x) => x.id === 'drums'), de = this.de;
    const fin = () => { if (this.de === de) { this.mapa = mapa; this.avisar(); } return mapa; };
    if (!bat || !analizar) return Promise.resolve(fin());
    return analizar(bat.buf, { cancelado: () => this.de !== de }).then((m) => { if (m) { mapa.golpes = m.golpes; mapa.cajas = m.cajas; mapa.platillos = m.agudos; } return fin(); }).catch(() => fin());
  }
}

// la canción a 44.1 kHz estéreo (lo que pide el modelo)
async function a441(buf) {
  let b = buf;
  if (buf.sampleRate !== SR || buf.numberOfChannels !== 2) {
    const n = Math.ceil(buf.duration * SR), oc = new OfflineAudioContext(2, n, SR);
    const s = oc.createBufferSource(); s.buffer = buf;
    // mono → los dos canales
    if (buf.numberOfChannels === 1) { const m = oc.createChannelMerger(2); s.connect(m, 0, 0); s.connect(m, 0, 1); m.connect(oc.destination); }
    else s.connect(oc.destination);
    s.start();
    b = await oc.startRendering();
  }
  return [Float32Array.from(b.getChannelData(0)), Float32Array.from(b.getChannelData(1))];
}
function fmt(s) { s = Math.max(0, Math.round(s)); return s < 60 ? s + ' s' : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`; }
function limpio(s) { return String(s).replace(/[\\/:*?"<>|]+/g, '').slice(0, 80).trim() || 'cancion'; }
