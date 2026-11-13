// Catálogo de Señal: un solo índice para todos los motores.
//   senal    → los parches propios de Señal (su sombreador «uber»)
//   umbral   → presets GLSL propios (js/motores/presets-umbral.js)
//   milkdrop → MilkDrop vía butterchurn (presets/milkdrop)
//   isf      → ISF de Vidvox; modv → ISF de modV (presets/isf, presets/modv)
//   fosfora  → efectos WGSL de fosfora (presets/fosfora)
// Los filtros ISF (con inputImage) no son presets: forman la lista de capas de efecto.
// Se recuerdan el preset elegido, la colección, la búsqueda, la capa y los favoritos.

export const COLECCIONES = [
  { c: 'todas', n: 'todas las colecciones' },
  { c: 'fav', n: '★ favoritos' },
  { c: 'senal', n: 'Señal · parches' },
  { c: 'umbral', n: 'UMBRAL · GLSL propio' },
  { c: 'milkdrop', n: 'MilkDrop · butterchurn' },
  { c: 'fosfora', n: 'fosfora · WGSL' },
  { c: 'isf', n: 'ISF · Vidvox' },
  { c: 'modv', n: 'ISF · modV' },
];
export const NOMBRE_COL = Object.fromEntries(COLECCIONES.map((x) => [x.c, x.n]));
const CLAVE = 'umbral.senal.cat';
const quitarAcentos = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export class Catalogo {
  constructor({ base, parches, propios }) {
    this.base = base;
    this.todos = parches.map((n, i) => ({ id: 'senal/' + i, n, a: 'UMBRAL', l: 'MIT', c: 'senal', m: 'senal', i, e: ['hydra'] }));
    for (const p of propios) this.todos.push({ id: p.id, n: p.nombre, a: p.autor, l: p.licencia, c: 'umbral', m: 'gl', e: p.etiquetas || [], preset: p });
    this.fxs = [];
    this.porId = new Map(this.todos.map((x) => [x.id, x]));
    this.estado = { id: null, c: 'todas', q: '', fx: null, favs: [] };
    try { Object.assign(this.estado, JSON.parse(localStorage.getItem(CLAVE) || '{}')); } catch {}
    this.favs = new Set(this.estado.favs || []);
    this.malos = new Set();
    this.listo = false; this.oyentes = new Set();
    this.filtrar();
  }
  async cargar() {
    try {
      const r = await fetch(`${this.base}/indice.json`);
      if (!r.ok) throw new Error(r.status);
      const j = await r.json();
      for (const x of j.presets) {
        if (x.fx) this.fxs.push(x); else this.todos.push(x);
        this.porId.set(x.id, x);
      }
    } catch (e) { console.warn('catálogo de presets:', e); }
    this.listo = true;
    this.filtrar();
    this.avisar();
  }
  guardar() { try { localStorage.setItem(CLAVE, JSON.stringify({ ...this.estado, favs: [...this.favs] })); } catch {} }
  alCambiar(fn) { this.oyentes.add(fn); return () => this.oyentes.delete(fn); }
  avisar() { for (const f of this.oyentes) { try { f(); } catch {} } }
  // la lista visible: colección + búsqueda (nombre, autor, etiquetas); los presets que fallaron no salen
  filtrar(c = this.estado.c, q = this.estado.q) {
    this.estado.c = c; this.estado.q = q;
    const qs = quitarAcentos(q || '').split(/\s+/).filter(Boolean);
    this.lista = this.todos.filter((x) => {
      if (this.malos.has(x.id)) return false;
      if (c === 'fav') { if (!this.favs.has(x.id)) return false; } else if (c !== 'todas' && x.c !== c) return false;
      if (!qs.length) return true;
      const h = x._h || (x._h = quitarAcentos(`${x.n} ${x.a} ${x.c} ${(x.e || []).join(' ')}`));
      return qs.every((w) => h.includes(w));
    });
    this.guardar();
    return this.lista;
  }
  // el siguiente / anterior dentro de la lista visible (si el actual no está en ella, empieza por el principio)
  vecino(id, dir) {
    const L = this.lista.length ? this.lista : this.todos;
    const i = L.findIndex((x) => x.id === id);
    if (i >= 0) return L[(i + dir + L.length) % L.length];
    // el actual ya no está en la lista (otro filtro, o falló): el más cercano en el orden completo
    const T = this.todos, j = T.findIndex((x) => x.id === id), en = new Set(L.map((x) => x.id));
    if (j >= 0) for (let k = 1; k <= T.length; k++) { const x = T[(j + dir * k + T.length * k) % T.length]; if (en.has(x.id)) return x; }
    return L[dir > 0 ? 0 : L.length - 1];
  }
  azar(id) {
    const L = this.lista.length > 1 ? this.lista : this.todos;
    let x; do { x = L[Math.floor(Math.random() * L.length)]; } while (L.length > 1 && x.id === id);
    return x;
  }
  marcarMalo(id) { this.malos.add(id); this.filtrar(); this.avisar(); }
  fav(id) { if (this.favs.has(id)) this.favs.delete(id); else this.favs.add(id); if (this.estado.c === 'fav') this.filtrar(); this.guardar(); this.avisar(); return this.favs.has(id); }
  posicion(id) { const i = this.lista.findIndex((x) => x.id === id); return i < 0 ? null : i + 1; }
}
