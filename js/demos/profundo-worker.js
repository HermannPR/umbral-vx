// Worker del Mandelbrot profundo: todo lo que pide precisión arbitraria (BigInt) vive aquí, lejos del cuadro.
//  ref    → órbita de referencia (periódica si encuentra un núcleo cerca) + tabla BLA
//  bla    → rehace la tabla BLA de la última órbita para otro |δc| máximo
//  mini   → busca el minibrot dominante en una vista (caja → Newton → tamaño), para el autopiloto
//  pixel  → μ exacto de un punto por iteración directa (las pruebas comparan la GPU contra esto)
import * as M from './profundo-mat.js';

let ultima = null;   // { Z, N } de la última referencia, para rehacer la BLA

function referencia(q) {
  const { cx, cy, P, maxIter, lr, ldiag } = q;
  let rx = cx, ry = cy, periodo = 0, o = null, nucleo = false;
  // 1) ¿hay un núcleo en la vista? una referencia periódica nunca escapa y el rebasing en m = p es exacto
  if (q.buscarNucleo !== false) {
    for (const dl of [1, -2, -5]) {
      if (o) break;
      const p = M.periodoCaja(cx, cy, P, lr + dl, Math.min(maxIter, 250000));
      if (!p || p > maxIter) continue;
      const nu = M.nucleo(cx, cy, P, p, lr + dl);
      if (nu) {
        const lejos = M.fe.l2(M.fixToFE(nu.cx - cx, nu.cy - cy, P));
        if (lejos < lr + 2) {
          const op = M.orbita(nu.cx, nu.cy, P, p + 1, -Infinity, true, 0);
          // el núcleo vuelve a 0: |Z_p| ≈ |dz_p|·(error del núcleo) tiene que ser diminuto frente a |dz_p|·radio
          const zp = { x: op.Z[4 * p], y: op.Z[4 * p + 1], e: op.Z[4 * p + 2] };
          if (op.N === p + 1 && M.fe.l2(zp) - nu.ldz < lr - 30) { o = op; rx = nu.cx; ry = nu.cy; periodo = p; nucleo = true; }
        }
      }
    }
  }
  // 2) si no, la órbita del centro (hasta maxIter o hasta que escape)
  if (!o) o = M.orbita(cx, cy, P, maxIter, -Infinity, true, 0);
  ultima = { Z: o.Z.slice(), N: o.N };   // copia: o.Z se transfiere a la página
  const loff = M.fe.l2(M.fixToFE(rx - cx, ry - cy, P));
  const ldc = M.logadd(loff, lr + ldiag) + 1;            // |δc| máximo con colchón ×2
  const bla = M.tablaBLA(o.Z, o.N, ldc);
  return { Z: o.Z, N: o.N, escapo: o.escapo, periodo, nucleo, rx, ry, P, ldc, bla };
}

self.onmessage = (ev) => {
  const q = ev.data, t0 = performance.now();
  try {
    if (q.tipo === 'ref') {
      const r = referencia(q);
      r.ms = performance.now() - t0;
      self.postMessage({ id: q.id, tipo: 'ref', ...r }, [r.Z.buffer, r.bla.datos.buffer]);
    } else if (q.tipo === 'bla') {
      if (!ultima) return self.postMessage({ id: q.id, tipo: 'bla', error: 'sin órbita' });
      const bla = M.tablaBLA(ultima.Z, ultima.N, q.ldc);
      self.postMessage({ id: q.id, tipo: 'bla', bla, ldc: q.ldc, N: ultima.N, ms: performance.now() - t0 }, [bla.datos.buffer]);
    } else if (q.tipo === 'mini') {
      const r = M.buscarMinibrot(q.cx, q.cy, q.P, q.lr, q.maxP || 200000, q.intentos || 6);
      self.postMessage({ id: q.id, tipo: 'mini', r, ms: performance.now() - t0 });
    } else if (q.tipo === 'pixel') {
      const mu = q.puntos.map(([x, y]) => M.pixelExacto(x, y, q.P, q.maxIter));
      self.postMessage({ id: q.id, tipo: 'pixel', mu, ms: performance.now() - t0 });
    }
  } catch (e) {
    self.postMessage({ id: q.id, tipo: q.tipo, error: String(e && e.stack || e) });
  }
};
