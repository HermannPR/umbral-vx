// Modo rave: Señal se queda sola horas escuchando el cuarto (o el MIDI de FL) y reacciona en vivo.
//   · BPM, fase, retardo y novedad vienen de vivo.js (pista.vivo).
//   · Pantalla limpia y calmada: sin osciloscopio, líneas de monitor, datamosh, estrobo ni zoom en golpes,
//     escenas solo por novedad musical (en inicio de compás), carácter según el BPM
//     (<100 ambient, 100–118 synthwave, si no techno; nunca brostep ni hyperpop: «demasiada intensidad»).
//   · Proyector (techo): giro 180°, espejo en cuatro, exposición automática (mediana del brillo, meta 0.2,
//     piso 0.55) y veto de escenas que lavan el techo (brillo > 0.42 por 8 s; guardado en umbral-veto).
//   · Salidas en ventanas popup sin pestañas (proyector y tele), con el lienzo en vivo (captureStream).
// Viene de modo-rave.js y modo-proyector.js (15 nov 2026), que se inyectaban en la página.
const CLAVE = 'umbral.rave', CLAVE_VETO = 'umbral-veto', CLAVE_ANTES = 'umbral.rave.antes';
const BASE = { giro: 0, espejo: 'cuatro', exposicion: true, meta: 0.2, piso: 0.55 };
export const estiloPorBpm = (bpm) => (bpm < 100 ? 'ambient' : bpm < 118 ? 'synthwave' : 'techno');

export class Rave {
  // senal: () => la instancia viva de Señal (la sala la recrea) · lienzo: () => el canvas
  constructor({ pista, senal, lienzo }) {
    this.P = pista; this.lienzo = lienzo;
    this.S = () => { const s = senal(); return s && s.fx && s.efecto ? s : null; };   // null fuera de Señal o en el respaldo sin efectos
    this.cfg = { ...BASE };
    try { Object.assign(this.cfg, JSON.parse(localStorage.getItem(CLAVE) || '{}')); } catch {}
    this.veto = new Set(['senal/2']);   // Retícula: gris y clara, lava el techo
    try { JSON.parse(localStorage.getItem(CLAVE_VETO) || '[]').forEach((v) => this.veto.add(v)); } catch {}
    this.activo = false; this.timers = []; this.escenas = []; this.log = []; this.L = 0; this.gan = 1; this.mues = []; this.alto = 0;
    this.popups = {}; this.oyentes = new Set();
    // Señal guarda sus efectos en localStorage: si la página se recargó en modo rave (o se salió fuera de
    // Señal), los efectos de antes quedaron aquí y se devuelven en cuanto Señal exista
    try { this.pendiente = JSON.parse(localStorage.getItem(CLAVE_ANTES) || 'null'); } catch { this.pendiente = null; }
    if (this.pendiente) this.esperarRestaurar();
  }
  guardarAntes(o) { try { if (o) localStorage.setItem(CLAVE_ANTES, JSON.stringify(o)); else localStorage.removeItem(CLAVE_ANTES); } catch {} }
  // devuelve los efectos de antes del modo rave; si Señal no está (otra sala, cargando), reintenta cada segundo
  restaurar() {
    const o = this.pendiente; if (!o || this.activo) return true;
    const S = this.S(); if (!S) return false;
    for (const [k, v] of Object.entries(o.fx || {})) if (S.fx[k] !== v) S.efecto(k, v);
    if (o.destellos && !this.P.ajustes.destellos) this.P.ajustar('destellos', true);
    this.pendiente = null; this.guardarAntes(null);
    return true;
  }
  esperarRestaurar() {
    if (this.reloj) return;
    this.reloj = setInterval(() => { if (this.activo || this.restaurar()) { clearInterval(this.reloj); this.reloj = null; } }, 1000);
  }
  alCambiar(f) { this.oyentes.add(f); return () => this.oyentes.delete(f); }
  avisar() { for (const f of this.oyentes) { try { f(this); } catch {} } }
  guardar() { try { localStorage.setItem(CLAVE, JSON.stringify(this.cfg)); } catch {} }
  guardarVeto() { try { localStorage.setItem(CLAVE_VETO, JSON.stringify([...this.veto].slice(-80))); } catch {} }
  ajustar(k, v) { this.cfg[k] = v; this.guardar(); if (this.activo) this.aplicar(true); this.avisar(); }

  async activar() {
    if (this.activo || this.activando) return;   // un doble clic durante el permiso del micrófono duplicaba los relojes
    const P = this.P;
    this.activando = true;
    try { if (!P.enVivo) await P.microfono(); } finally { this.activando = false; }
    this.activo = true;
    // si quedó un respaldo sin devolver (recarga en modo rave), ese es el estado de verdad de antes
    this.antes = this.pendiente ? { ...this.pendiente.fx } : null;
    this.destellosAntes = this.pendiente ? !!this.pendiente.destellos : P.ajustes.destellos;
    this.pendiente = null; this.respaldado = false;
    document.body.classList.add('rave');
    this.quitarCambio = P.vivo.alCambio(() => this.cambiar());
    this.timers.push(setInterval(() => this.aplicar(), 1000));
    this.timers.push(setInterval(() => this.estilo(), 15000));
    this.timers.push(setInterval(() => requestAnimationFrame(() => this.exponer()), 1000));
    this.timers.push(setInterval(() => this.bitacora(), 10000));
    this.aplicar(true);
    this.avisar();
  }
  desactivar() {
    if (!this.activo) return;
    this.activo = false;
    this.timers.forEach(clearInterval); this.timers = [];
    if (this.quitarCambio) this.quitarCambio();
    document.body.classList.remove('rave');
    const c = this.lienzo(); if (c) { c.style.filter = ''; c.style.transform = ''; }
    // el modo rave apaga efectos y destellos; al salir vuelven (fuera de Señal, en cuanto vuelva)
    this.pendiente = { fx: this.antes || {}, destellos: !!this.destellosAntes };
    this.antes = null; this.respaldado = false;
    if (!this.restaurar()) this.esperarRestaurar();
    this.avisar();
  }

  // pantalla limpia; se reaplica cada segundo porque la sala recrea a Señal (cambio de tamaño, GPU)
  aplicar(forzar = false) {
    const S = this.S(); if (!S) return;
    const quiero = { escenas: 'manual', osciloscopio: false, barrido: 0, zoom: 0, mosh: 0, estrobo: false, espejo: this.cfg.espejo };
    if (!this.antes) { this.antes = {}; for (const k of Object.keys(quiero)) this.antes[k] = S.fx[k]; }
    if (!this.respaldado) { this.respaldado = true; this.guardarAntes({ fx: this.antes, destellos: !!this.destellosAntes }); }
    for (const [k, v] of Object.entries(quiero)) if (S.fx[k] !== v) S.efecto(k, v);
    if (this.P.ajustes.destellos) this.P.ajustar('destellos', false);
    if (S !== this.ultS) { this.ultS = S; if (this.ultId && S.sel && S.sel.id !== this.ultId && S.cat) { const e = S.cat.porId.get(this.ultId); if (e) S.elegir(e); } forzar = true; }
    if (forzar) this.estilo();
    if (S.sel && this.veto.has(S.sel.id) && !this.ocupado) { this.cambiar(); return; }
    if (S.sel) this.ultId = S.sel.id;
  }
  estilo() {
    const S = this.S(); if (!S || !this.P.vivo.bpm) return;
    const o = S.opciones(), quiero = estiloPorBpm(this.P.vivo.bpm), i = o.looks.indexOf(quiero);
    if (i >= 0 && o.look !== i) S.fijar('look', i);
  }
  async cambiar() {
    const S = this.S(); if (!S || this.ocupado) return;
    this.ocupado = true;
    try {
      const antes = S.sel && S.sel.n;
      for (let k = 0; k < 6; k++) { await S.saltarA(1, true); if (!(S.sel && this.veto.has(S.sel.id))) break; }
      this.escenas.push({ t: new Date().toLocaleTimeString(), antes, despues: S.sel && S.sel.n, motor: S.motorAct });
      if (this.escenas.length > 40) this.escenas.shift();
      if (S.sel) this.ultId = S.sel.id;
    } finally { this.ocupado = false; this.avisar(); }
  }

  // el lienzo WebGPU solo se puede leer dentro del mismo cuadro: se mide en rAF, después del render
  exponer() {
    const c = this.lienzo(); if (!c) return;
    // fuera de Señal (otra sala, antesala) el lienzo queda como es; al volver se retoma
    if (!this.S()) { if (c.style.filter || c.style.transform) { c.style.filter = ''; c.style.transform = ''; } this.alto = 0; return; }
    const giro = this.cfg.giro ? `rotate(${this.cfg.giro}deg)` : '';
    if (c.style.transform !== giro) c.style.transform = giro;
    if (!this.cfg.exposicion) { c.style.filter = ''; return; }
    try {
      if (!this.oc) { this.oc = document.createElement('canvas'); this.oc.width = 48; this.oc.height = 27; this.ox = this.oc.getContext('2d', { willReadFrequently: true }); }
      this.ox.drawImage(c, 0, 0, 48, 27);
      const d = this.ox.getImageData(0, 0, 48, 27).data; let s = 0;
      for (let i = 0; i < d.length; i += 4) s += (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
      this.mues.push(s / (48 * 27)); if (this.mues.length > 7) this.mues.shift();
      this.L = [...this.mues].sort((a, b) => a - b)[this.mues.length >> 1];   // mediana: ignora destellos
      const obj = Math.max(this.cfg.piso, Math.min(1, (this.cfg.meta / Math.max(0.01, this.L)) * 1.6));
      this.gan += (obj - this.gan) * 0.25;
      c.style.filter = `brightness(${this.gan.toFixed(3)}) contrast(1.12) saturate(1.25)`;
      const S = this.S(), id = S && S.sel && S.sel.id;
      this.alto = this.L > 0.42 ? this.alto + 1 : 0;
      if (this.alto >= 8 && id) {
        this.veto.add(id); this.guardarVeto(); this.alto = 0;
        this.log.push({ t: new Date().toLocaleTimeString(), veto: S.sel.n, L: +this.L.toFixed(2) });
        this.P.vivo.forzar();
      }
    } catch (e) { this.err = String(e); }
  }
  bitacora() {
    const V = this.P.vivo;
    this.log.push({ t: new Date().toLocaleTimeString(), ...V.estado, fuente: this.P.fuente, L: +this.L.toFixed(2) });
    if (this.log.length > 180) this.log.shift();
    if (!this.P.enVivo && !this.reconectando) {
      this.reconectando = true; this.P.microfono().catch(() => {}).finally(() => { this.reconectando = false; });
    }
  }

  // ventanas sin pestañas para el proyector y la tele; necesita un clic real (gesto del usuario)
  abrirSalida(nombre, { x = 0, girar = false } = {}) {
    const c = this.lienzo(); if (!c) return null;
    // ya abierta: solo al frente (reabrirla dejaba otra captura del lienzo y otro reloj vivos)
    const ya = this.popups[nombre];
    if (ya && !ya.w.closed) { try { ya.w.focus(); } catch {} return ya.w; }
    const w = window.open('', 'umbral-' + nombre, `popup,left=${x},top=0,width=1920,height=1080`);
    if (!w) throw new Error('El navegador bloqueó la ventana: permite ventanas emergentes para este sitio');
    w.document.title = 'UMBRAL VX · ' + nombre;
    w.document.body.style.cssText = 'margin:0;background:#000;overflow:hidden;cursor:none';
    w.document.body.innerHTML = '';
    const v = w.document.createElement('video');
    v.autoplay = v.muted = v.playsInline = true;
    v.style.cssText = 'width:100vw;height:100vh;object-fit:cover' + (girar ? ';transform:rotate(180deg)' : '');
    w.document.body.append(v);
    const flujo = c.captureStream(60);
    v.srcObject = flujo; v.play().catch(() => {});
    // la exposición del lienzo es un filtro CSS: captureStream no lo trae, se copia
    const id = setInterval(() => { if (w.closed) { this.soltarSalida(nombre); this.avisar(); return; } try { v.style.filter = c.style.filter; } catch {} }, 1000);
    w.ondblclick = () => { const d = w.document; if (!d.fullscreenElement) d.documentElement.requestFullscreen().catch(() => {}); };
    this.popups[nombre] = { w, id, flujo }; this.avisar();
    return w;
  }
  // suelta el reloj y la captura del lienzo de una salida
  soltarSalida(nombre) {
    const s = this.popups[nombre]; if (!s) return;
    clearInterval(s.id); s.flujo.getTracks().forEach((t) => t.stop());
    delete this.popups[nombre];
  }
  cerrarSalidas() { for (const [n, s] of Object.entries(this.popups)) { try { s.w.close(); } catch {} this.soltarSalida(n); } this.avisar(); }
  olvidarVetos() { this.veto = new Set(['senal/2']); this.guardarVeto(); this.avisar(); }
}
