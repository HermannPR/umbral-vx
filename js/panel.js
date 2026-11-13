// Panel lateral: controles, la sala, «tu música», instrumentos y vista, en un solo lugar que no se va solo.
// Se abre y se cierra con «?» o con el botón de la esquina, y recuerda cómo lo dejaste (abierto o cerrado,
// y qué secciones). Los controles finos son lil-gui (MIT, George Michael Brower), tematizado con la letra
// y la tinta de la galería; el armazón, la forma de onda y la zona para soltar canciones son propios.
import GUI from './vendor/lil-gui.esm.min.js';
import { MARCA } from './salas.js';

const $ = (id) => document.getElementById(id);
const CLAVE = 'umbral.panel';
const leer = (d) => { try { return { ...d, ...JSON.parse(localStorage.getItem(CLAVE) || '{}') }; } catch { return d; } };
const fmtT = (s) => { s = Math.max(0, Math.floor(s || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

export class Panel {
  // acc: lo que el panel le pide a main.js (pulsar un botón, la sala actual, avisos, vista…)
  constructor(acc) {
    this.acc = acc;
    const SECC = { musica: true, sala: true, vista: false, controles: false, instrumentos: false };
    this.pref = leer({ abierto: innerWidth >= 1100, secciones: SECC });
    if (this.pref.v !== 2) this.pref = { abierto: this.pref.abierto, secciones: { ...SECC }, v: 2 };   // panel nuevo: lo raro empieza cerrado
    this.abierto = !!this.pref.abierto;
    const asa = this.asa = document.createElement('button');
    asa.id = 'asa'; asa.type = 'button'; asa.setAttribute('aria-controls', 'panel'); asa.title = 'Abrir el panel (?)';
    asa.innerHTML = '<span class="asa-ico" aria-hidden="true"><i></i><i></i><i></i></span><span class="asa-txt">controles</span><span class="g">?</span>';
    const el = this.el = document.createElement('aside');
    el.id = 'panel'; el.setAttribute('aria-label', 'Panel de controles');
    el.innerHTML = `
      <header class="pn-cab">
        <div class="pn-tit"><div class="pn-num" id="pn-num"></div><div class="pn-nombre" id="pn-nombre"></div><div class="pn-modo" id="pn-modo"></div></div>
        <button type="button" class="pn-x" id="pn-x" aria-label="Cerrar el panel" title="Cerrar (?)">×</button>
      </header>
      <nav class="pn-barra" aria-label="Acciones principales">
        <div class="pb-nav">
          <button type="button" data-a="ant" title="Sala anterior (←)" aria-label="Sala anterior">‹</button>
          <button type="button" data-a="pausa" class="pb-pausa" title="Pausa (espacio)"><span class="pb-ico">❚❚</span><span class="pb-t">pausa</span></button>
          <button type="button" data-a="sig" title="Sala siguiente (→)" aria-label="Sala siguiente">›</button>
        </div>
        <div class="pb-acc">
          <button type="button" data-a="grabar" class="pb-rec" title="Grabar video de lo que se ve y suena (G)"><i class="pb-punto"></i><span class="pb-t">grabar video</span><kbd>G</kbd></button>
          <button type="button" data-a="pantalla" title="Pantalla completa (V)"><span class="pb-t">pantalla completa</span><kbd>V</kbd></button>
          <button type="button" data-a="foto" title="Guardar imagen PNG sin texto (O)"><span class="pb-t">foto PNG</span><kbd>O</kbd></button>
          <button type="button" data-a="texto" title="Ocultar todo el texto y el panel; H lo devuelve"><span class="pb-t">ocultar todo</span><kbd>H</kbd></button>
        </div>
      </nav>
      <div class="pn-cuerpo" id="pn-cuerpo">
        <section id="pn-musica"></section>
        <section id="pn-sala"></section>
        <section id="pn-vista"></section>
        <section id="pn-controles"></section>
        <section id="pn-instr"></section>
      </div>
      <footer class="pn-pie">${MARCA.autor ? `<span>${esc(MARCA.autor)}</span>` : ''}${MARCA.repo ? `<a href="${MARCA.repo}" target="_blank" rel="noopener">código abierto ↗</a>` : ''}</footer>`;
    document.body.append(asa, el);
    asa.addEventListener('click', () => this.abrir());
    $('pn-x').addEventListener('click', () => this.cerrar());
    const A = acc, accion = { ant: () => A.pulsar('l1'), sig: () => A.pulsar('r1'), pausa: () => A.pulsar('pausa'),
      grabar: () => A.grabar(), pantalla: () => A.pantallaCompleta(), foto: () => A.captura(), texto: () => A.ocultarTodo() };
    this.barra = el.querySelector('.pn-barra');
    for (const ev of ['fullscreenchange', 'webkitfullscreenchange']) document.addEventListener(ev, () => this.pintarBarra(true));
    this.barra.addEventListener('click', (e) => { const b = e.target.closest('button[data-a]'); if (b && accion[b.dataset.a]) accion[b.dataset.a](); });
    if (!A.puedeGrabar) { const r = this.barra.querySelector('.pb-rec'); r.disabled = true; r.title = 'Este navegador no puede grabar video'; }
    // los controles sueltan el foco al usarse: espacio, enter y flechas vuelven a ser de la sala
    el.addEventListener('change', (e) => this.soltarFoco(e.target));
    el.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) this.soltarFoco(b); });
    this.armarFijas();
    this.aplicar(false);
  }
  soltarFoco(t) { if (t && t.matches && !t.matches('input[type=text], input[type=number]')) setTimeout(() => t.blur(), 0); }
  guardar() { try { localStorage.setItem(CLAVE, JSON.stringify({ abierto: this.abierto, secciones: this.pref.secciones, v: 2 })); } catch {} }
  aplicar(guardar = true) {
    document.body.classList.toggle('panel-abierto', this.abierto);
    this.asa.setAttribute('aria-expanded', String(this.abierto));
    this.el.setAttribute('aria-hidden', String(!this.abierto));
    this.el.inert = !this.abierto;
    if (guardar) this.guardar();
    this.acc.alCambiar && this.acc.alCambiar(this.abierto);
  }
  abrir(seccion) {
    this.abierto = true; this.aplicar();
    const g = seccion && this.guis[seccion];
    if (g) { g.open(); g.domElement.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
  }
  cerrar() { this.abierto = false; this.aplicar(); }
  alternar() { if (this.abierto) this.cerrar(); else this.abrir(); }
  // al entrar a una sala con el panel cerrado, el asa se asoma unos segundos para que se sepa dónde está todo
  llamar(ms = 5200) { const a = this.asa; a.classList.remove('llama'); void a.offsetWidth; a.classList.add('llama'); clearTimeout(this.llamaT); this.llamaT = setTimeout(() => a.classList.remove('llama'), ms); }

  seccion(id, titulo, clave) {
    const g = new GUI({ container: $(id), title: titulo, autoPlace: false });
    if (!this.pref.secciones[clave]) g.close();
    g.onOpenClose((x) => { if (x !== g) return; this.pref.secciones[clave] = !g._closed; this.guardar(); });
    this.guis[clave] = g;
    return g;
  }

  // ---------- secciones fijas: controles, instrumentos, vista y sonido ----------
  armarFijas() {
    this.guis = {};
    const c = this.seccion('pn-controles', 'Atajos de teclado', 'controles');
    this.leyEl = document.createElement('div'); this.leyEl.className = 'pn-leyenda';
    c.$children.appendChild(this.leyEl);
    const ins = this.seccion('pn-instr', 'Instrumentos', 'instrumentos');
    this.insEl = document.createElement('div'); this.insEl.className = 'pn-ins';
    ins.$children.appendChild(this.insEl);
    const v = this.seccion('pn-vista', 'Ajustes', 'vista');
    const A = this.acc;
    this.v = {
      sonido: true, volumen: 0.55, ficha: true, recorrido: false, calidad: 'automática', formato: 'pantalla', fps: 60,
      enlace: () => A.copiarEnlace(), antesala: () => A.antesala(), escenario: () => A.escenario(),
    };
    this.cv = {
      sonido: v.add(this.v, 'sonido').name('sonido').onChange((x) => A.sonido(x)),
      volumen: v.add(this.v, 'volumen', 0, 1, 0.01).name('volumen').onChange((x) => A.volumen(x)),
      formato: v.add(this.v, 'formato', A.formatos).name('formato del lienzo').onChange((x) => A.formato(x)),
      calidad: v.add(this.v, 'calidad', A.calidades).name('calidad').onChange((x) => A.calidad(x)),
      fps: v.add(this.v, 'fps', A.fpsOpciones).name('fps máximos').onChange((x) => A.fps(x)),
      ficha: v.add(this.v, 'ficha').name('ficha de la sala').onChange((x) => A.ficha(x)),
      recorrido: v.add(this.v, 'recorrido').name('recorrido automático').onChange((x) => A.recorrido(x)),
    };
    this.cv.formato.domElement.title = 'Para Reels o TikTok: vertical 9:16. El video graba en este formato.';
    this.cv.fps.domElement.title = '120 para pantallas de 120 Hz. El video siempre graba a 60.';
    v.add(this.v, 'escenario').name('modo escenario (sin texto, pantalla completa)');
    v.add(this.v, 'enlace').name('copiar enlace a esta sala');
    v.add(this.v, 'antesala').name('volver a la antesala  ·  esc');
  }
  // refleja el estado real (lo cambian también las teclas)
  vista(e) {
    for (const k of ['sonido', 'ficha', 'recorrido', 'calidad', 'volumen', 'formato', 'fps']) {
      if (e[k] === undefined || this.v[k] === e[k]) continue;
      this.v[k] = e[k]; this.cv[k].updateDisplay();
    }
    if (e.formato !== undefined && this.selFormato && this.selFormato.value !== e.formato) this.selFormato.value = e.formato;
  }
  // grabando: los botones de grabar dicen «detener»; el formato no se cambia a media toma
  grabacion(on) {
    this.grabando = !!on;
    const r = this.barra.querySelector('.pb-rec');
    r.classList.toggle('on', this.grabando); r.querySelector('.pb-t').textContent = this.grabando ? '■ 0:00' : 'grabar video';
    r.title = this.grabando ? 'Detener la grabación (G)' : 'Grabar video de lo que se ve y suena (G)';
    if (this.cv.formato) { if (on) this.cv.formato.disable(); else this.cv.formato.enable(); }
    if (this.selFormato) this.selFormato.disabled = this.grabando;
    if (this.btnCancion) this.btnCancion.textContent = on ? '■ detener la grabación' : '● grabar la canción completa';
    this.barraT = 0;
  }
  // la barra: pausa, tiempo grabado y pantalla completa reflejan el estado real (4 veces por segundo, barato)
  pintarBarra(ya = false) {
    const A = this.acc, b = this.barra, now = performance.now();
    if (!ya && now - (this.barraT || 0) < 250) return;
    this.barraT = now;
    const pausa = !!(A.pausada && A.pausada()), p = b.querySelector('.pb-pausa');
    if (p.classList.contains('on') !== pausa) { p.classList.toggle('on', pausa); p.querySelector('.pb-ico').textContent = pausa ? '▶' : '❚❚'; p.querySelector('.pb-t').textContent = pausa ? 'seguir' : 'pausa'; }
    const d = document, full = !!(d.fullscreenElement || d.webkitFullscreenElement), f = b.querySelector('[data-a=pantalla]');
    if (f.classList.contains('on') !== full) { f.classList.toggle('on', full); f.querySelector('.pb-t').textContent = full ? 'salir de pantalla' : 'pantalla completa'; }
    if (this.grabando && A.segundosRec) { const s = Math.floor(A.segundosRec()); b.querySelector('.pb-rec .pb-t').textContent = `■ ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }
  }
  get instrumentosVisibles() { return this.abierto && this.guis.instrumentos && !this.guis.instrumentos._closed; }
  instrumentos(html) { if (this.instrumentosVisibles) this.insEl.innerHTML = html; }
  leyenda(html) { this.leyEl.innerHTML = html; }
  modo(txt) { $('pn-modo').textContent = txt ? 'modo · ' + txt : ''; }

  // ---------- por sala: cabecera, botones de la sala y «tu música» (solo en Señal) ----------
  sala({ num, acto, nombre, D, slug }) {
    $('pn-num').textContent = `Nº ${num} · ${acto}`;
    $('pn-nombre').textContent = nombre;
    for (const k of ['sala', 'musica']) { if (this.guis[k]) { this.guis[k].destroy(); delete this.guis[k]; } }
    this.selFormato = this.btnCancion = this.onda = null; this.valImg = this.senalRef = null;
    if (this.quitarOyente) { this.quitarOyente(); this.quitarOyente = null; }
    const A = this.acc, c = (D && D.controls) || {};
    const g = this.seccion('pn-sala', 'La sala', 'sala');
    // botones de la sala en rejilla (ir de sala en sala y la pausa están en la barra de arriba)
    const caja = document.createElement('div'); caja.className = 'pn-chips';
    const b = (txt, boton, tecla, clase = '') => `<button type="button" class="${clase}" data-b="${boton}" title="${esc(txt)}"><span class="pc-t">${esc(txt)}</span>${tecla ? `<kbd>${tecla}</kbd>` : ''}</button>`;
    caja.innerHTML = b('modo anterior', 'down', '↓') + b('modo siguiente', 'up', '↑')
      + b(c.a || 'acción', 'a', 'enter', 'ancho fuerte')
      + (D && D.palettes ? b('cambiar paleta', 'x', 'X') : '')
      + (c.y !== null ? b(c.y || 'modo caos', 'y', 'C') : '');
    const ult = caja.lastElementChild; if (caja.children.length % 2 === 0 && ult && !ult.classList.contains('ancho')) ult.classList.add('ancho');
    caja.addEventListener('click', (e) => { const t = e.target.closest('button[data-b]'); if (t) A.pulsar(t.dataset.b); });
    g.$children.appendChild(caja);
    if (slug === 'senal') this.armarMusica();
  }

  armarMusica() {
    const A = this.acc, P = A.pista, g = this.seccion('pn-musica', 'Tu música', 'musica');
    const caja = document.createElement('div'); caja.className = 'pm';
    caja.innerHTML = `
      <label class="pm-soltar" tabindex="0">
        <input type="file" accept="audio/*,.mp3,.wav,.ogg,.flac,.m4a,.aac,.opus" hidden>
        <b>Suelta aquí tu canción</b><span>o haz clic para elegirla · mp3, wav, ogg, flac, m4a</span>
      </label>
      <div class="pm-pista" hidden>
        <div class="pm-nombre"></div><div class="pm-meta"></div>
        <canvas class="pm-onda" aria-label="Forma de onda: haz clic para saltar"></canvas>
        <div class="pm-fila"><button type="button" class="pm-play">▶ reproducir</button><button type="button" class="pm-otra">otra</button><button type="button" class="pm-quitar">quitar</button></div>
        <div class="pm-fila pm-tempo" hidden><span class="pm-tt">tempo</span><button type="button" data-t="0.5">÷ 2</button><button type="button" data-t="1">tal cual</button><button type="button" data-t="2">× 2</button></div>
      </div>
      <div class="pm-video" hidden>
        <div class="pm-vt">video de la canción</div>
        <div class="pm-fila"><select class="pm-formato" aria-label="Formato del video"></select></div>
        <div class="pm-fila"><button type="button" class="pm-grabar">● grabar la canción completa</button></div>
      </div>
      <div class="pm-fila"><button type="button" class="pm-mic">usar el micrófono</button></div>
      <details class="pm-nota"><summary>Tu canción no sale de tu equipo</summary>Se escucha y se analiza en el navegador. Señal la escucha completa una vez y sabe dónde caen los pulsos, las subidas y los drops, y en qué tonalidad va: graves → golpe, medios → torsión, agudos → chispas, tonalidad → color. El video se graba en tiempo real de 0:00 al final y se descarga solo (MP4 si el navegador puede; si no, WebM).</details>`;
    g.$children.appendChild(caja);
    const q = (s) => caja.querySelector(s);
    const input = q('input[type=file]'), zona = q('.pm-soltar');
    const elegir = () => input.click();
    zona.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); elegir(); } });
    input.addEventListener('change', () => { const f = input.files && input.files[0]; input.value = ''; if (f) A.cargarCancion(f); });
    q('.pm-otra').addEventListener('click', elegir);
    q('.pm-play').addEventListener('click', () => P.alternar());
    q('.pm-quitar').addEventListener('click', () => P.quitar());
    caja.querySelectorAll('.pm-tempo button').forEach((b) => b.addEventListener('click', () => P.fijarTempo(+b.dataset.t)));
    q('.pm-mic').addEventListener('click', () => (P.fuente === 'mic' ? P.quitar() : P.microfono().catch((e) => A.aviso(e.name === 'NotAllowedError' ? 'Sin permiso para el micrófono' : e.message))));
    // video: formato (el mismo de Ajustes) y grabar de 0:00 al final
    const sel = this.selFormato = q('.pm-formato');
    sel.innerHTML = A.formatos.map((f) => `<option>${esc(f)}</option>`).join('');
    sel.value = this.v.formato;
    sel.addEventListener('change', () => A.formato(sel.value));
    const bc = this.btnCancion = q('.pm-grabar');
    if (A.puedeGrabar) bc.addEventListener('click', () => A.grabarCancion()); else { bc.disabled = true; bc.textContent = 'este navegador no graba video'; }
    const onda = this.onda = q('.pm-onda');
    onda.addEventListener('pointerdown', (e) => { if (P.fuente !== 'archivo') return; const r = onda.getBoundingClientRect(); P.buscar(((e.clientX - r.left) / r.width) * P.dur); });

    const s = A.senal && A.senal();
    if (s && s.opciones) {
      const o = s.opciones(), im = g.addFolder('Imagen');
      const val = { look: o.looks[o.look], parche: o.parches[o.parche], tintas: o.tintas[o.tinta] };
      this.cImg = {
        look: im.add(val, 'look', o.looks).name('carácter').onChange((v) => s.fijar('look', o.looks.indexOf(v))),
        parche: im.add(val, 'parche', o.parches).name('parche').onChange((v) => s.fijar('parche', o.parches.indexOf(v))),
        tintas: im.add(val, 'tintas', o.tintas).name('tintas').onChange((v) => s.fijar('tintas', o.tintas.indexOf(v))),
      };
      this.valImg = val; this.senalRef = s;
      // color y escenas que siguen la música
      const F = o.fx;
      im.add(F, 'color', o.colores).name('color').onChange((v) => s.efecto('color', v));
      im.add(F, 'escenas', o.escenas).name('escenas').onChange((v) => s.efecto('escenas', v));
      const fx = g.addFolder('Efectos');
      fx.add(F, 'osciloscopio').name('osciloscopio').onChange((v) => s.efecto('osciloscopio', v));
      fx.add(F, 'zoom', 0, 1, 0.05).name('zoom radial en golpes').onChange((v) => s.efecto('zoom', v));
      fx.add(F, 'barrido', 0, 1, 0.05).name('líneas de monitor').onChange((v) => s.efecto('barrido', v));
      fx.add(F, 'mosh', 0, 1, 0.05).name('datamosh').onChange((v) => s.efecto('mosh', v));
      fx.add(F, 'espejo', o.espejos).name('espejo de pantalla').onChange((v) => s.efecto('espejo', v));
      fx.add(F, 'estrobo').name('estrobo en el drop').onChange((v) => s.efecto('estrobo', v));
      fx.close();
    }
    // reacción: ajuste fino, cerrada
    const aj = P.ajustes, r = g.addFolder('Reacción');
    r.add(aj, 'sensibilidad', 0.3, 2.5, 0.05).name('sensibilidad').onChange((v) => P.ajustar('sensibilidad', v));
    r.add(aj, 'suavizado', 0, 1, 0.01).name('suavizado').onChange((v) => P.ajustar('suavizado', v));
    r.add(aj, 'graves', 0, 2, 0.05).name('graves → golpe').onChange((v) => P.ajustar('graves', v));
    r.add(aj, 'medios', 0, 2, 0.05).name('medios → torsión').onChange((v) => P.ajustar('medios', v));
    r.add(aj, 'agudos', 0, 2, 0.05).name('agudos → chispas').onChange((v) => P.ajustar('agudos', v));
    r.add(aj, 'volumen', 0, 1.2, 0.01).name('volumen').onChange((v) => P.ajustar('volumen', v));
    r.add(aj, 'bucle').name('repetir').onChange((v) => P.ajustar('bucle', v));
    r.add(aj, 'destellos').name('destellos y negativos').onChange((v) => P.ajustar('destellos', v));
    r.close();
    this.grabacion(A.grabando && A.grabando());
    const pintar = () => {
      const hay = P.fuente === 'archivo', mic = P.fuente === 'mic';
      q('.pm-pista').hidden = !hay; zona.hidden = hay; q('.pm-video').hidden = !hay;
      zona.classList.toggle('cargando', !!P.cargando);
      zona.querySelector('b').textContent = P.cargando ? 'Escuchando «' + P.cargando + '»…' : 'Suelta aquí tu canción';
      q('.pm-mic').textContent = mic ? 'dejar el micrófono' : 'usar el micrófono';
      q('.pm-mic').classList.toggle('on', mic);
      if (hay) {
        q('.pm-nombre').textContent = P.nombre;
        q('.pm-play').textContent = P.sonando ? '❚❚ pausa' : '▶ reproducir';
      }
      const tempo = q('.pm-tempo'); tempo.hidden = !(hay && P.mapa);
      tempo.querySelectorAll('button').forEach((b) => b.classList.toggle('on', +b.dataset.t === P.tempo));
      this.metaT = 0; this.ondaPos = -1; this.metaTxt = '';
    };
    this.pintarMusica = pintar;
    this.quitarOyente = P.alCambiar(pintar);
    pintar();
  }
  // cada cuadro (barato): reloj, forma de onda con el avance, y lo que la sala cambió con el teclado
  tick() {
    if (!this.abierto) return;
    this.pintarBarra();
    if (!this.guis.musica || this.guis.musica._closed) return;
    const P = this.acc.pista, c = this.onda;
    if (this.valImg && this.senalRef) {
      const o = this.senalRef.opciones();
      for (const [k, i, L] of [['look', o.look, o.looks], ['parche', o.parche, o.parches], ['tintas', o.tinta, o.tintas]]) {
        if (this.valImg[k] !== L[i]) { this.valImg[k] = L[i]; this.cImg[k].updateDisplay(); }
      }
    }
    if (P.fuente !== 'archivo' || !c || !P.picos) return;
    const p = P.pos(), sec = this.senalRef && this.senalRef.A && this.senalRef.A.mapa ? this.senalRef.A.seccion : '';
    const meta = `${fmtT(p)} / ${fmtT(P.dur)}${P.bpm ? ` · ${P.mapa ? '' : '~'}${P.bpm} bpm` : ''}${P.analizando != null ? ` · escuchando ${Math.round(P.analizando * 100)} %` : P.tono ? ' · ' + P.tono : ''}${sec ? ' · ' + sec : ''}`;
    if (meta !== this.metaTxt) { this.metaTxt = meta; this.el.querySelector('.pm-meta').textContent = meta; }
    const dpr = devicePixelRatio || 1, w = Math.round(c.clientWidth * dpr), h = Math.round(c.clientHeight * dpr);
    if (!w || !h) return;
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; this.ondaPos = -1; }
    const x = Math.round((p / P.dur) * w);
    if (x === this.ondaPos) return;
    this.ondaPos = x;
    const g = c.getContext('2d'), n = P.picos.length, acento = getComputedStyle(document.documentElement).getPropertyValue('--acento').trim() || '#ece6da';
    g.clearRect(0, 0, w, h);
    // secciones del mapa: subida y drop se marcan debajo de la onda
    const M = P.mapa;
    if (M) {
      for (const sc of M.secciones) {
        if (sc.tipo === 'intro') continue;
        g.fillStyle = sc.tipo === 'drop' ? 'rgba(214,69,50,.30)' : sc.tipo === 'subida' ? 'rgba(236,230,218,.12)' : 'rgba(0,0,0,.35)';
        g.fillRect((sc.t0 / P.dur) * w, 0, ((sc.t1 - sc.t0) / P.dur) * w, h);
      }
      g.fillStyle = 'rgba(236,230,218,.9)';
      for (const td of M.drops) g.fillRect((td / P.dur) * w, 0, Math.max(1, dpr), h * 0.22);
    }
    const bw = w / n;
    for (let i = 0; i < n; i++) {
      const v = Math.max(0.04, P.picos[i]) * h * 0.46, xi = i * bw;
      g.fillStyle = xi < x ? acento : 'rgba(236,230,218,.28)';
      g.fillRect(xi, h / 2 - v, Math.max(1, bw - dpr * 0.5), v * 2);
    }
    g.fillStyle = '#ece6da'; g.fillRect(x, 0, Math.max(1, dpr), h);
  }
}
