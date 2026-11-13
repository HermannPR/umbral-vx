// Motor MilkDrop: presets de MilkDrop (Winamp) con butterchurn (github.com/jberg/butterchurn, MIT) en un canvas
// WebGL2 propio. butterchurn escucha el mismo analizador de la sala y Señal copia cada cuadro a WebGPU.
// Los presets vienen de butterchurn-presets (MIT); cada uno conserva el nombre de su autor.
// butterchurn compila las ecuaciones de cada preset con new Function, como en su uso normal.

let cargando = null;
function guion(src) {
  return new Promise((ok, mal) => { const s = document.createElement('script'); s.src = src; s.async = true; s.onload = ok; s.onerror = () => mal(new Error('no cargó ' + src)); document.head.appendChild(s); });
}
async function libreria(base) {
  if (!cargando) cargando = (async () => {
    if (!window.butterchurn) await guion(`${base}/butterchurn.min.js`);
    if (!window.butterchurnExtraImages) await guion(`${base}/butterchurnExtraImages.min.js`).catch(() => {});
    const bc = window.butterchurn;
    return bc && bc.default ? bc.default : bc;
  })();
  return cargando;
}

export class MotorMilkdrop {
  constructor({ report, base, presets } = {}) {
    this.report = report || ((m) => console.warn(m)); this.base = base; this.presets = presets;
    this.w = 0; this.h = 0; this.viz = null; this.actual = null; this.cache = new Map(); this.malos = new Set();
  }
  async iniciar(ac) {
    if (this.viz) return;
    const bc = await libreria(this.base);
    this.canvas = document.createElement('canvas'); this.canvas.width = 640; this.canvas.height = 360;
    this.viz = bc.createVisualizer(ac, this.canvas, { width: 640, height: 360, pixelRatio: 1, textureRatio: 1 });
    const extra = window.butterchurnExtraImages;
    if (extra) { try { this.viz.loadExtraImages((extra.default || extra).getImages()); } catch {} }
    this.w = 640; this.h = 360;
  }
  conectar(nodo) { if (this.viz && nodo && nodo !== this.nodo) { try { if (this.nodo) this.viz.disconnectAudio(this.nodo); } catch {} this.viz.connectAudio(nodo); this.nodo = nodo; } }
  async datos(preset) {
    if (this.cache.has(preset.id)) return this.cache.get(preset.id);
    const r = await fetch(`${this.presets}/${encodeURIComponent(preset.f)}`);
    if (!r.ok) throw new Error(`${preset.f}: ${r.status}`);
    const j = await r.json();
    if (this.cache.size > 40) this.cache.delete(this.cache.keys().next().value);
    this.cache.set(preset.id, j);
    return j;
  }
  async usar(preset, seg = 2) {
    if (!this.viz || this.malos.has(preset.id)) return false;
    try { this.viz.loadPreset(await this.datos(preset), seg); this.actual = preset; return true; }
    catch (e) { this.malos.add(preset.id); this.report(`preset ${preset.id}: ${String(e.message || e).slice(0, 200)}`); return false; }
  }
  tam(w, h) {
    w = Math.max(16, Math.round(w)); h = Math.max(16, Math.round(h));
    if (!this.viz || (w === this.w && h === this.h)) return;
    this.w = w; this.h = h; this.canvas.width = w; this.canvas.height = h;
    this.viz.setRendererSize(w, h);
  }
  dibujar() { if (this.viz && this.actual) { try { this.viz.render(); } catch (e) { this.malos.add(this.actual.id); this.report(`milkdrop: ${e.message}`); this.actual = null; } } }
  destroy() {
    try { if (this.nodo) this.viz.disconnectAudio(this.nodo); } catch {}
    const gl = this.canvas && this.canvas.getContext('webgl2'); const ext = gl && gl.getExtension('WEBGL_lose_context'); if (ext) ext.loseContext();
    this.viz = null;
  }
}
