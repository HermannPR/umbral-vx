// Antesala: índice del laboratorio, navegable con teclado, ratón o mando.
// A la derecha, la lámina de la sala elegida (captura real) y detrás su firma de harmonógrafo.
import { SALAS, ACTOS, MARCA, num, dibujarFirma } from './salas.js';
import { CARGAS, fmtG } from './equipo.js';
import { glifo } from './hud.js';

const $ = (id) => document.getElementById(id);
const ease = (t) => 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3);

export class Antesala {
  constructor({ onSala, onOpcion, sonido, disponible = () => true, evaluacion = () => null }) {
    Object.assign(this, { onSala, onOpcion, sonido, disponible, evaluacion });
    $('a-marca').textContent = MARCA.nombre; $('a-bajada').textContent = MARCA.bajada;
    this.el = $('antesala'); this.visible = false; this.sel = 0; this.cur = -1; this.estado = {};
    this.items = [...SALAS.map((s, i) => ({ tipo: 'sala', i })), { tipo: 'recorrido' }, { tipo: 'calidad' }, { tipo: 'sonido' }, { tipo: 'instrumentos' }, { tipo: 'medir' }];
    this.nS = SALAS.length;
    // índice
    let html = '';
    ACTOS.forEach((a, k) => {
      if (!SALAS.some((s) => s.acto === k)) return;   // actos sin salas (p. ej. en la versión pública) no se muestran
      html += `<div class="acto"><span>${a.n}</span>${a.nombre}</div>`;
      SALAS.forEach((s, i) => {
        if (s.acto !== k) return;
        html += `<a class="item" data-k="${i}"><span class="n">${num(i)}</span><span class="t">${s.nombre}</span><span class="o"><i>${s.carga}</i> · <span class="est">…</span></span></a>`;
      });
    });
    $('a-indice').innerHTML = html;
    this.$items = [...document.querySelectorAll('#a-indice .item')];
    this.$items.forEach((el) => {
      const k = +el.dataset.k;
      el.addEventListener('mouseenter', () => this.elegir(k, true));
      el.addEventListener('click', () => { this.elegir(k); this.activar(); });
    });
    $('a-opciones').addEventListener('click', (e) => { const o = e.target.closest('.op'); if (o) { this.elegir(+o.dataset.k); this.activar(); } });
    // lámina
    this.img = $('a-img');
    this.img.addEventListener('load', () => { if (this.img.dataset.k == this.salaMostrada) this.img.classList.add('ok'); this.dibujarGlifo(); });
    this.img.addEventListener('error', () => { this.img.classList.remove('ok'); this.sinImagen = true; this.animar(); });
    this.fondo = $('a-fondo'); this.glifo = $('a-glifo');
    this.next = 0; this.lastDir = '';
    addEventListener('resize', () => this.visible && this.animar(true));
  }
  mostrar(cur, estado) {
    this.cur = cur; this.estado = estado; this.visible = true;
    this.el.classList.add('visible');
    this.elegir(cur >= 0 ? cur : this.sel < this.nS ? this.sel : 0, false, true);
    this.render();
    this.next = performance.now() + 250;
  }
  ocultar() { this.visible = false; this.el.classList.remove('visible'); }
  actualizar(estado) { this.estado = estado; this.render(); }

  elegir(k, sonar = true, forzar = false) {
    if (k === this.sel && !forzar) return;
    this.sel = k;
    if (sonar && this.sonido) this.sonido.evento('mover', { i: Math.min(k, this.nS - 1) });
    if (k < this.nS) this.mostrarSala(k);
    this.render();
  }
  mostrarSala(i) {
    const s = SALAS[i];
    document.documentElement.style.setProperty('--acento', s.acento);
    $('a-num').textContent = 'Nº ' + num(i);
    $('a-acto').textContent = ACTOS[s.acto].n + ' · ' + ACTOS[s.acto].nombre;
    $('a-nombre').textContent = s.nombre;
    $('a-lema').textContent = s.lema;
    $('a-origen').textContent = 'origen · ' + s.origen;
    this.veredicto(i);
    this.salaMostrada = i; this.sinImagen = false;
    this.img.classList.remove('ok');
    this.img.dataset.k = i;
    this.img.src = `capturas/laminas/${num(i)}-${s.slug}.jpg`;
    this.animar();
  }
  // estado de la medición del equipo (0..1)
  midiendo(f) {
    $('a-equipo').classList.remove('listo');
    $('eq-txt').innerHTML = `midiendo la GPU… <b>${Math.round(f * 100)} %</b>`;
    $('eq-barra').firstElementChild.style.width = (f * 100).toFixed(0) + '%';
  }
  equipo(p, evals) {
    this.perfil = p;
    const a = p.adaptador ? [p.adaptador.vendor, p.adaptador.arquitectura].filter(Boolean).join(' ') : 'sin WebGPU';
    const partes = [`perfil <b class="niv">${p.nivel.nombre}</b>`];
    if (p.adaptador) partes.push(a);
    if (p.nucleos) partes.push(`${p.nucleos} núcleos`);
    if (p.memoria >= 8) partes.push(`≥ ${p.memoria} GB`);
    if (p.gflops) partes.push(`<b>${fmtG(p.gflops)}</b> · ${p.gbps} GB/s medidos${p.simulado ? ' (simulado)' : ''}`);
    if (p.movil) partes.push('móvil');
    const ok = evals.filter((e) => e.ok).length, max = evals.filter((e) => e.ok && e.calidad === 3).length;
    $('eq-txt').innerHTML = partes.join(' · ') + `<br>${ok} de ${evals.length} salas disponibles · ${max} en calidad máxima`;
    $('a-equipo').classList.add('listo');
    this.$items.forEach((el) => {
      const e = evals[+el.dataset.k], est = el.querySelector('.est');
      est.textContent = e.ok ? (e.calidad === 3 ? 'máxima' : e.estado.replace('calidad ', '')) : 'no disponible';
      est.className = 'est ' + (!e.ok ? 'est-no' : e.calidad === 3 ? 'est-perfecto' : 'est-reducida');
      el.classList.toggle('nd', !e.ok);
    });
    if (this.salaMostrada != null) this.veredicto(this.salaMostrada);
  }
  veredicto(i) {
    const S = SALAS[i], e = this.evaluacion(i), req = S.requisitos || {};
    const pide = [`carga ${S.carga}`, 'WebGPU', `~${fmtG(CARGAS[S.carga].gflops)}`, `búferes de ${req.mb || 64} MB`];
    let v = '';
    if (!e) v = 'midiendo tu equipo…';
    else if (!e.ok) v = `<span class="no">no disponible en este equipo: ${e.motivo}</span>`;
    else if (e.calidad === 3) v = '<b>en tu equipo corre perfecto</b>, en calidad máxima';
    else v = `<b>en tu equipo corre en ${e.estado}</b> · ${e.motivo}`;
    $('a-veredicto').innerHTML = 'pide · ' + pide.join(' · ') + '<br>' + v;
  }
  render() {
    this.$items.forEach((el) => {
      const k = +el.dataset.k;
      el.classList.toggle('sel', k === this.sel);
      el.classList.toggle('cur', k === this.cur);
    });
    const e = this.estado, n = this.nS;
    const ops = [
      `Recorrido <b>${e.recorrido ? 'en marcha' : 'detenido'}</b>`,
      `Calidad <b>${e.calidad || 'automática'}</b>`,
      `Sonido <b>${e.sonido ? 'sí' : 'no'}</b>`,
      `Instrumentos <b>${e.instrumentos ? 'visibles' : 'ocultos'}</b>`,
      `<b>Medir de nuevo</b>`,
    ];
    $('a-opciones').innerHTML = ops.map((o, i) => `<span class="op${this.sel === n + i ? ' sel' : ''}" data-k="${n + i}">${o}</span>`).join('');
    const pad = !!e.pad;
    $('a-ayuda').innerHTML = `<span>${glifo('dpad', pad)} elegir</span><span>${glifo('a', pad)} entrar</span>` +
      (this.cur >= 0 ? `<span>${glifo('start', pad)} volver a la sala</span>` : '') + (pad ? '' : `<span><span class="g">P</span> recorrido</span>`);
  }
  activar() {
    const it = this.items[this.sel];
    if (it.tipo === 'sala') { if (!this.disponible(it.i)) return; this.sonido && this.sonido.evento('elegir'); this.onSala(it.i); }
    else this.onOpcion(it.tipo);
  }
  // navegación con mando / teclado (llamar cada frame mientras está visible)
  nav(inp) {
    let dir = '';
    if (inp.held.up || inp.ly < -0.55) dir = 'u'; else if (inp.held.down || inp.ly > 0.55) dir = 'd';
    else if (inp.held.left || inp.lx < -0.55) dir = 'l'; else if (inp.held.right || inp.lx > 0.55) dir = 'r';
    const now = performance.now();
    if (dir && (dir !== this.lastDir || now > this.next)) {
      this.next = now + (dir !== this.lastDir ? 360 : 120);
      const n = this.items.length, s = this.sel;
      if (dir === 'u' || dir === 'l') this.elegir((s - 1 + n) % n);
      if (dir === 'd' || dir === 'r') this.elegir((s + 1) % n);
    }
    this.lastDir = dir;
    if (inp.pressed.a) this.activar();
  }

  // ---------- dibujo: firma grande de fondo + glifo dentro del marco si no hay lámina ----------
  animar(inmediato = false) {
    this.t0 = performance.now() - (inmediato ? 1e5 : 0);
    if (!this.raf) this.raf = requestAnimationFrame(() => this.paso());
  }
  paso() {
    this.raf = 0;
    if (!this.visible) return;
    const p = ease((performance.now() - this.t0) / 2600);
    this.dibujarFondo(p); this.dibujarGlifo(p);
    if (p < 1) this.raf = requestAnimationFrame(() => this.paso());
  }
  dibujarFondo(p) {
    const c = this.fondo, dpr = devicePixelRatio || 1;
    const w = c.clientWidth, h = c.clientHeight;
    if (c.width !== Math.round(w * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
    const s = SALAS[this.salaMostrada ?? 0];
    const fig = document.querySelector('#a-lamina .marco').getBoundingClientRect();
    const marco = document.querySelector('#a-lamina .marco').getBoundingClientRect();
    const cx = marco.left + marco.width / 2, cy = marco.top + marco.height / 2;
    const r = Math.min(fig.width * 0.62, h * 0.6);
    dibujarFirma(g, s.firma, { x: cx, y: cy, r, color: s.acento, ancho: 0.8, alfa: 0.16, progreso: p, n: 3000 });
  }
  dibujarGlifo(p = 1) {
    const c = this.glifo, dpr = devicePixelRatio || 1;
    const w = c.clientWidth, h = c.clientHeight;
    if (!w) return;
    if (c.width !== Math.round(w * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
    if (!this.sinImagen) return;
    const s = SALAS[this.salaMostrada ?? 0];
    dibujarFirma(g, s.firma, { x: w / 2, y: h / 2, r: h * 0.4, color: s.acento, ancho: 1, alfa: 0.9, progreso: p, n: 3000 });
  }
}
