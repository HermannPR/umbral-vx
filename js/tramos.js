// Grabación por tramos para sesiones largas («me voy y se queda solo»): cada N minutos cierra un archivo
// y abre otro, sin diálogos encima de la proyección. Cada trozo de un segundo se escribe al disco en
// cuanto llega, así la memoria no crece (la grabación larga en memoria tumbó la pestaña el 15 nov).
// El archivo se consolida cada minuto (se cierra y se reabre en su lugar): si la pestaña o la Mac se caen,
// se pierde a lo más un minuto, no el tramo entero (createWritable solo escribe el archivo de verdad al cerrar).
// Destino, en este orden:
//   1) una carpeta que eliges una vez (File System Access; Chrome y Edge; Brave lo trae apagado);
//   2) el almacenamiento privado del sitio (OPFS): sin diálogo; luego se bajan desde el panel.
import { tipoVideo } from './grabar.js';
const CONSOLIDAR_MS = 60 * 1000;

export class GrabadoraTramos {
  constructor() {
    this.min = 5; this.carpeta = null; this.dest = ''; this.activa = false; this.tramos = []; this.actual = null; this.error = '';
    this.consolidarMs = CONSOLIDAR_MS;
    this.oyentes = new Set();
  }
  alCambiar(f) { this.oyentes.add(f); return () => this.oyentes.delete(f); }
  avisar() { for (const f of this.oyentes) { try { f(this); } catch {} } }
  static get puedeCarpeta() { return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function'; }
  static get puedeOPFS() { return typeof navigator !== 'undefined' && navigator.storage && typeof navigator.storage.getDirectory === 'function'; }

  // con un gesto del usuario (clic): elige la carpeta una sola vez
  async elegirCarpeta() {
    if (!GrabadoraTramos.puedeCarpeta) throw new Error('Este navegador no deja elegir carpeta; se guarda en el sitio');
    this.carpeta = await window.showDirectoryPicker({ id: 'umbral-tramos', mode: 'readwrite' });
    this.dest = 'carpeta: ' + this.carpeta.name; this.avisar();
  }
  async raiz() {
    if (this.carpeta) return this.carpeta;
    if (!GrabadoraTramos.puedeOPFS) throw new Error('Este navegador no puede guardar tramos sin diálogo');
    const r = await navigator.storage.getDirectory();
    this.dest = 'almacenamiento del sitio';
    return r.getDirectoryHandle('tramos', { create: true });
  }

  // canvas: el lienzo · ac: AudioContext · nodos: audio a grabar · nombre: prefijo
  async iniciar({ canvas, ac, nodos = [], fps = 60, nombre = 'umbral', min }) {
    if (this.activa || this.abriendo) return;   // un doble clic mientras se abre la carpeta arrancaba dos grabaciones
    if (min) this.min = min;
    const mime = tipoVideo();
    if (!mime) throw new Error('Este navegador no puede grabar video');
    this.abriendo = true;
    try { this.dir = await this.raiz(); } finally { this.abriendo = false; }
    const vs = canvas.captureStream(fps);
    let dest = null;
    if (ac) { dest = ac.createMediaStreamDestination(); for (const n of nodos) { try { n.connect(dest); } catch {} } }
    this.stream = new MediaStream([...vs.getVideoTracks(), ...(dest ? dest.stream.getAudioTracks() : [])]);
    this.mime = mime; this.ext = mime.startsWith('video/mp4') ? 'mp4' : 'webm'; this.nombre = nombre; this.nodos = nodos; this.destino = dest;
    this.bps = Math.round(Math.min(16e6, Math.max(4e6, canvas.width * canvas.height * fps * 0.05)));
    this.activa = true; this.error = '';
    try { await this.abrirTramo(); }
    catch (e) { this.activa = false; this.soltar(); this.avisar(); throw e; }   // sin archivo no hay grabación: no se queda «grabando»
    this.reloj = setInterval(() => this.rotar(), this.min * 60 * 1000);
    this.avisar();
  }
  async abrirTramo() {
    const d = new Date(), dd = (n) => String(n).padStart(2, '0');
    const archivo = `${this.nombre}-${d.getFullYear()}${dd(d.getMonth() + 1)}${dd(d.getDate())}-${dd(d.getHours())}${dd(d.getMinutes())}${dd(d.getSeconds())}.${this.ext}`;
    const fh = await this.dir.getFileHandle(archivo, { create: true });
    const w = await fh.createWritable();
    const rec = new MediaRecorder(this.stream, { mimeType: this.mime, videoBitsPerSecond: this.bps, audioBitsPerSecond: 192000 });
    const T = { archivo, fh, w, rec, bytes: 0, escritos: 0, t0: performance.now(), tCierre: performance.now(), cola: Promise.resolve(), listo: false };
    const escribir = async (blob) => {
      await T.w.write(blob); T.escritos += blob.size;
      if (performance.now() - T.tCierre > this.consolidarMs) await this.consolidar(T);
    };
    rec.ondataavailable = (e) => { if (e.data && e.data.size) { T.bytes += e.data.size; T.cola = T.cola.then(() => escribir(e.data)).catch((err) => { this.error = String(err); }); } };
    T.fin = new Promise((res) => { rec.onstop = () => { T.cola.then(() => T.w.close()).catch(() => {}).finally(() => { T.listo = true; T.dur = (performance.now() - T.t0) / 1000; this.avisar(); res(); }); }; });
    rec.start(1000);
    this.tramos.push(T); this.actual = T;
  }
  // cierra (el archivo queda escrito de verdad) y reabre conservando lo escrito, para seguir al final
  async consolidar(T) {
    T.tCierre = performance.now();
    await T.w.close();
    T.w = await T.fh.createWritable({ keepExistingData: true });
    await T.w.seek(T.escritos);
    T.consolidados = (T.consolidados || 0) + 1;
  }
  // el tramo nuevo empieza antes de cerrar el viejo: no se pierde ni un segundo
  async rotar() {
    if (!this.activa) return;
    const viejo = this.actual;
    // si el tramo nuevo no abre (disco lleno, permiso), el viejo sigue grabando y se reintenta en la próxima vuelta
    try { await this.abrirTramo(); } catch (e) { this.error = String(e); this.avisar(); return; }
    // si se detuvo mientras abría, el tramo nuevo se cierra aquí (si no, quedaba grabando para siempre)
    if (!this.activa) { const T = this.actual; if (T && T !== viejo && T.rec.state !== 'inactive') T.rec.stop(); return; }
    if (viejo && viejo.rec.state !== 'inactive') viejo.rec.stop();
    this.avisar();
  }
  soltar() {
    for (const n of this.nodos) { try { n.disconnect(this.destino); } catch {} }
    this.stream.getTracks().forEach((t) => t.stop());
  }
  async detener() {
    if (!this.activa) return;
    this.activa = false; clearInterval(this.reloj);
    const T = this.actual; if (T && T.rec.state !== 'inactive') T.rec.stop();
    if (T) await T.fin;
    this.soltar();
    this.actual = null; this.avisar();
  }
  get segundos() { return this.actual ? (performance.now() - this.actual.t0) / 1000 : 0; }
  // los tramos que quedaron en el almacenamiento del sitio (también los de sesiones anteriores)
  async listar() {
    const dir = this.carpeta || (GrabadoraTramos.puedeOPFS ? await (await navigator.storage.getDirectory()).getDirectoryHandle('tramos', { create: true }) : null);
    if (!dir) return [];
    const out = [];
    for await (const [nombre, h] of dir.entries()) if (h.kind === 'file') { const f = await h.getFile(); out.push({ nombre, bytes: f.size, h }); }
    return out.sort((a, b) => a.nombre.localeCompare(b.nombre));
  }
  async bajar(item) {
    const f = await item.h.getFile();
    const a = document.createElement('a'); a.href = URL.createObjectURL(f); a.download = item.nombre;
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  }
  async borrar(item) {
    const dir = this.carpeta || (await (await navigator.storage.getDirectory()).getDirectoryHandle('tramos'));
    await dir.removeEntry(item.nombre);
  }
}
