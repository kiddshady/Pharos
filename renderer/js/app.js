/* ═══════════════════════════════════════════════════════════════════════════
   PHAROS — precios de medicamentos, sin la publicidad de por medio
   Consulta el Manual Farmacéutico (alfabeta.net) y muestra lo único que
   importa: qué cuesta, en qué presentación y de cuándo es ese precio.

   El renderer no habla con internet (la CSP es `default-src 'self'`): le pide
   a `window.onyx.af`, que resuelve en el proceso principal. Acá solo se dibuja.
   ═══════════════════════════════════════════════════════════════════════════ */

import { Icons } from './icons.js';
import { Tooltip, Toast, Modal } from './overlays.js';
import Palette from './palette.js';
import Router from './router.js';
import { initClickFlash, initScrollFades, raf2, bindSwitcher, bindStepper } from './motion.js';
import { esc, paint, head, empty, attempt, copy, colorToken, path } from './ui.js';
import { fmtPesos, fmtBytes, relTime, plural } from './format.js';
import { designHTML, wireDesign } from './design-view.js';

const api = window.onyx;
const favoritos = api.col('favoritos');

/* ══ Íconos del dominio ══════════════════════════════════════════════════════
   Van con Icons.add() y no editando icons.js: así traerse una versión nueva
   del set base no pisa estos. Misma receta que los 72 de fábrica — grilla de
   16, trazo 1.5, contenido entre 1.8 y 14.2. */

Icons.add({
  /* La marca: la torre, y aparte su luz. Son dos piezas para que el splash
     pueda dibujar la torre primero y encender la luz después. */
  faro: '<path d="M6.5 13.7 7.1 6.7h1.8l.6 7z"/><path d="M6.7 6.7V4.5h2.6v2.2"/>'
      + '<path d="M4.6 13.7h6.8"/><path d="M5.2 3.4 3 2.3M10.8 3.4 13 2.3"/>',

  estrella: '<path d="M8 2.2l1.8 3.7 4.1.6-3 2.9.7 4.1L8 11.6l-3.6 1.9.7-4.1-3-2.9 4.1-.6z"/>',

  /* Una cápsula inclinada, partida por su junta.
     El cuerpo y la junta van en el MISMO grupo rotado: si se rota solo el
     cuerpo y la junta se dibuja aparte, queda cruzándolo en diagonal y
     sobresaliendo por los costados — y el ícono se lee como un clip. Dentro
     del grupo, la junta es una vertical en el centro y la rotación la deja
     perpendicular al eje sola.
     El rect mide 10×4.4 y no más: rotado 40°, su esquina más lejana queda a
     5,46 del centro, y sumando el medio trazo el dibujo entra justo en el
     margen de la grilla de 16. */
  pildora: '<g transform="rotate(-40 8 8)">'
         + '<rect x="3" y="5.8" width="10" height="4.4" rx="2.2"/>'
         + '<path d="M8 5.8v4.4"/></g>',

  porcentaje: '<path d="M12.8 3.2 3.2 12.8"/><circle cx="4.9" cy="4.9" r="1.9"/>'
            + '<circle cx="11.1" cy="11.1" r="1.9"/>',

  /* Cobertura de obra social. */
  escudo: '<path d="M8 1.9 13.2 4v4.2c0 3-2.2 4.9-5.2 5.9-3-1-5.2-2.9-5.2-5.9V4z"/>',

  /* Laboratorio: un matraz. */
  matraz: '<path d="M6.4 1.9v4L2.6 12a1.2 1.2 0 0 0 1 1.9h8.8a1.2 1.2 0 0 0 1-1.9L9.6 5.9v-4"/>'
        + '<path d="M5.6 1.9h4.8M4.6 9h6.8"/>',
});

/* ══ Estado ══════════════════════════════════════════════════════════════════
   Un espejo en memoria de lo que hay en disco y de la última consulta. Las
   vistas leen de acá y nunca disparan IPC para dibujarse: si cada repintado
   volviera a pedir los datos, navegar parpadearía y —peor— le pegaría de más
   al servidor de alfabeta. */

const S = {
  info: null,
  settings: {},
  favoritos: [],
  historial: [],

  /** La búsqueda vigente y, si se abrió una droga o un laboratorio, su
      expansión a productos. La vista muestra la expansión cuando existe. */
  busqueda: null,
  expansion: null,
  cargando: false,

  /** Ficha del producto abierto, y los precios que se hayan traído para
      comparar. En memoria: el disco ya tiene su propio caché. */
  ficha: null,
  precios: new Map(),

  /** Referencias slug → {slug, idL, patron, …} para poder abrir un producto
      desde donde sea (resultado, favorito, historial) con un solo parámetro. */
  refs: new Map(),

  /** El barrido de precios en curso, si hay uno. */
  barrido: null,
};

/* ══ Datos en disco ══════════════════════════════════════════════════════════ */

const HISTORIAL = 'historial';

async function loadAll() {
  const [info, settings, favs, hist] = await Promise.all([
    api.info(),
    api.settings.get(),
    favoritos.list(),
    api.doc.read(HISTORIAL, []),
  ]);
  S.info = info;
  S.settings = settings;
  S.favoritos = favs.sort((a, b) => (b.guardadoEn || 0) - (a.guardadoEn || 0));
  S.historial = Array.isArray(hist) ? hist : [];
  S.favoritos.forEach(recordarRef);
}

/** Guarda cómo volver a abrir un producto. */
function recordarRef(p) {
  if (p?.slug) {
    S.refs.set(p.slug, {
      slug: p.slug, idL: p.idL, patron: p.patron,
      nombre: p.nombre, laboratorio: p.laboratorio,
    });
  }
  return p;
}

/** El slug es un nombre de archivo; el id de la colección tiene que pasar por
    SAFE_ID del store (letras, números, guiones), así que se normaliza. */
const idDe = (slug) => String(slug || '')
  .replace(/\.html$/i, '').replace(/[^a-z0-9_-]/gi, '-').slice(0, 60);

const esFavorito = (slug) => S.favoritos.some((f) => f.id === idDe(slug));

async function toggleFavorito(slug) {
  const ref = S.refs.get(slug);
  if (!ref) return;
  const id = idDe(slug);

  if (esFavorito(slug)) {
    await favoritos.remove(id);
    S.favoritos = S.favoritos.filter((f) => f.id !== id);
    Toast.show({ title: 'Quitado de favoritos', text: ref.nombre, icon: 'estrella' });
  } else {
    const guardado = await favoritos.save({ id, ...ref, guardadoEn: Date.now() });
    S.favoritos = [guardado, ...S.favoritos];
    Toast.show({ title: 'Guardado en favoritos', text: ref.nombre, icon: 'estrella' });
  }
  updateChrome();
  registerCommands();
}

async function anotarHistorial(entrada) {
  // Sin repetidos: la misma búsqueda hecha de nuevo sube al tope, no se apila.
  const clave = `${entrada.modo}|${entrada.patron.toLowerCase()}`;
  const limpio = S.historial.filter((h) => `${h.modo}|${h.patron.toLowerCase()}` !== clave);
  S.historial = [{ ...entrada, cuando: Date.now() }, ...limpio]
    .slice(0, Number(S.settings.historialMax) || 40);
  await api.doc.write(HISTORIAL, S.historial).catch(() => {});
  updateChrome();
}

/* ══ El descuento ════════════════════════════════════════════════════════════
   Se guarda en los ajustes porque casi siempre es el mismo: escribirlo una vez
   y que quede es la diferencia entre una calculadora y una molestia. `activo`
   lo apaga sin borrar el número, para poder comparar con y sin en dos clicks. */

function descuento() {
  const d = S.settings.descuento || {};
  const pct = Math.min(100, Math.max(0, Number(d.porcentaje) || 0));
  return { activo: !!d.activo && pct > 0, porcentaje: pct };
}

/** Un precio con el descuento vigente aplicado. Devuelve también el ahorro,
    porque «cuánto me saco de encima» es la mitad de la pregunta. */
function conDescuento(precio) {
  const { activo, porcentaje } = descuento();
  if (!activo || precio == null) return { final: precio, ahorro: 0, aplicado: false };
  const final = precio * (1 - porcentaje / 100);
  return { final, ahorro: precio - final, aplicado: true, porcentaje };
}

async function guardarDescuento(patch) {
  const actual = S.settings.descuento || { activo: false, porcentaje: 0 };
  S.settings = await api.settings.save({ descuento: { ...actual, ...patch } });
  updateChrome();
}

/* ══ Consultas ═══════════════════════════════════════════════════════════════
   Las tres devuelven {datos, deCache, edad}. Ese envoltorio no se descarta
   nunca: la vista tiene que poder decir si el precio salió de la red recién o
   de un archivo de hace horas. Un precio viejo mostrado como actual es el peor
   error que puede cometer esta app. */

const MODO_LABEL = { producto: 'Producto', droga: 'Droga', laboratorio: 'Laboratorio' };

const PLACEHOLDER = {
  producto: 'Ibupirac, Amoxidal, Sertal…',
  droga: 'ibuprofeno, amoxicilina, losartán…',
  laboratorio: 'Bagó, Roemmers, Elea…',
};

async function buscar(patron, { forzar = false } = {}) {
  const termino = String(patron || '').trim();
  if (termino.length < 2) {
    Toast.error('Escribí al menos dos letras', 'Con una sola, el índice devuelve medio Manual.');
    return;
  }

  const modo = S.settings.modo || 'producto';
  S.cargando = true;
  S.expansion = null;
  if (Router.name === 'buscar') pintarBuscar(termino); else Router.go('buscar');

  try {
    const r = await api.af.buscar({ modo, patron: termino, forzar });
    S.busqueda = { ...r.datos, deCache: r.deCache, edad: r.edad };
    S.busqueda.items.forEach(recordarRef);
    await anotarHistorial({ modo, patron: termino, resultados: r.datos.items.length });
  } catch (err) {
    S.busqueda = { modo, patron: termino, items: [], total: 0, error: err.message };
  } finally {
    S.cargando = false;
    pintarBuscar(termino);
  }
}

/** Abre una droga o un laboratorio: de la entrada del índice a sus productos. */
async function expandir(item) {
  S.cargando = true;
  S.expansion = { nombre: item.nombre, mde: item.mde, items: [] };
  pintarBuscar();

  try {
    const r = await api.af.productos({
      mde: item.mde,
      id: item.idD || item.idL,
      patron: item.patron,
    });
    S.expansion = {
      nombre: item.nombre, mde: item.mde,
      ...r.datos, deCache: r.deCache, edad: r.edad,
    };
    S.expansion.items.forEach(recordarRef);
  } catch (err) {
    S.expansion = { nombre: item.nombre, mde: item.mde, items: [], error: err.message };
  } finally {
    S.cargando = false;
    pintarBuscar();
  }
}

async function abrirProducto(slug, { forzar = false } = {}) {
  const ref = S.refs.get(slug);
  if (!ref) {
    Toast.error('No sé cómo abrir eso', 'Buscalo de nuevo para recuperar su referencia.');
    return;
  }

  S.ficha = null;
  S.cargando = true;
  if (Router.name === 'producto' && Router.param === slug) pintarProducto();
  else Router.go('producto', slug);

  try {
    const r = await api.af.ficha({ slug: ref.slug, idL: ref.idL, patron: ref.patron, forzar });
    S.ficha = { ...r.datos, deCache: r.deCache, edad: r.edad };
  } catch (err) {
    S.ficha = { error: err.message, nombre: ref.nombre };
  } finally {
    S.cargando = false;
    pintarProducto();
  }
}

/* ══ Barrido de precios ══════════════════════════════════════════════════════
   La lista de resultados de alfabeta NO trae precios: hay que abrir la ficha de
   cada producto. Comparar veinte marcas de amoxicilina son veinte consultas, y
   por eso esto es una acción EXPLÍCITA y no algo que pase solo: nadie debería
   disparar veinte pedidos a un servidor ajeno sin querer.

   Va de a uno (el cliente ya serializa y espacia), muestra en qué va, y se
   puede cortar en cualquier momento. */

async function barrerPrecios(items) {
  if (S.barrido) return;

  const pendientes = items.filter((i) => i.tipo === 'producto' && !S.precios.has(i.slug));
  if (!pendientes.length) {
    Toast.show({ title: 'Ya están todos', text: 'No quedan precios por traer.', icon: 'check' });
    return;
  }

  S.barrido = { hechos: 0, total: pendientes.length, cortar: false };
  pintarBuscar();

  for (const it of pendientes) {
    if (S.barrido.cortar) break;
    try {
      const r = await api.af.ficha({ slug: it.slug, idL: it.idL, patron: it.patron });
      const precios = r.datos.presentaciones.map((p) => p.precio).filter((n) => n != null);
      S.precios.set(it.slug, {
        min: precios.length ? Math.min(...precios) : null,
        cuantas: r.datos.presentaciones.length,
        fecha: r.datos.presentaciones[0]?.fecha || null,
      });
    } catch {
      // Un producto que falla no puede cortar el barrido entero: se marca y sigue.
      S.precios.set(it.slug, { min: null, cuantas: 0, fecha: null, fallo: true });
    }
    S.barrido.hechos += 1;
    pintarBuscar();
  }

  const cortado = S.barrido.cortar;
  S.barrido = null;
  pintarBuscar();
  Toast.show({
    title: cortado ? 'Barrido interrumpido' : 'Precios listos',
    text: cortado ? 'Quedó guardado lo que alcanzó a traer.' : 'Ya podés comparar la columna de precios.',
    icon: cortado ? 'info' : 'check',
  });
}

/* ══ Piezas compartidas ══════════════════════════════════════════════════════ */

/** De dónde salió el dato y qué antigüedad tiene. Esto no se omite nunca. */
function origen(v = {}) {
  if (v.deCache) {
    return '<span class="ox-meta" data-tip="Estaba guardado en disco. Actualizá para volver a preguntar.">'
      + `${Icons.svg('clock', 'ox-icon--sm')} guardado ${esc(relTime(Date.now() - (v.edad || 0)))}</span>`;
  }
  return '<span class="ox-meta" data-tip="Recién consultado a alfabeta.net">'
    + `${Icons.svg('zap', 'ox-icon--sm')} de la red</span>`;
}

function botonFavorito(slug) {
  const on = esFavorito(slug);
  return `<button class="ox-iconbtn ox-flashable" data-fav="${esc(slug)}"
    data-tip="${on ? 'Quitar de favoritos' : 'Guardar en favoritos'}">
    ${Icons.svg('estrella', on ? 'ox-icon--fill' : '')}</button>`;
}

const cargando = () => `
  <div class="ox-col" style="gap:10px;padding:8px 0">
    ${Array.from({ length: 5 }, () => '<div class="ox-skeleton" style="height:46px"></div>').join('')}
  </div>`;

/* ══ Vista: Buscar ═══════════════════════════════════════════════════════════ */

function viewBuscar() {
  paint(head({
    title: 'Buscar',
    sub: 'Manual Farmacéutico — precios sugeridos al público',
    actions: `<button class="ox-btn ox-btn--secondary ox-flashable" data-action="recargar"
                data-tip="Volver a consultar, salteando lo guardado">
                ${Icons.svg('retry')} Actualizar</button>`,
  }) + '<div class="ox-scroll ox-grow" id="zona-buscar"></div>');

  pintarBuscar();
}

/** Repinta SOLO la zona de abajo del campo. El buscador se deja intacto a
    propósito: si se repintara entero, escribir mientras llegan los datos
    perdería el foco y el cursor saltaría al principio. */
function pintarBuscar(valorForzado) {
  if (Router.name !== 'buscar') return;
  const zona = document.getElementById('zona-buscar');
  if (!zona) return;

  const campo = document.getElementById('campo');
  const habiaFoco = document.activeElement === campo;
  const valor = valorForzado ?? campo?.value ?? S.busqueda?.patron ?? '';

  zona.innerHTML = buscadorHTML(valor) + resultadosHTML();
  Icons.mount(zona);
  initScrollFades(zona);
  wireBuscar(zona);

  if (habiaFoco) {
    const nuevo = document.getElementById('campo');
    nuevo?.focus();
    nuevo?.setSelectionRange(nuevo.value.length, nuevo.value.length);
  }
}

function buscadorHTML(valor) {
  const modo = S.settings.modo || 'producto';
  return `
    <div class="ox-col" style="gap:14px;margin-bottom:24px">
      <div class="ox-segmented" id="seg-modo" style="align-self:flex-start">
        ${Object.entries(MODO_LABEL).map(([k, v]) => `
          <button class="ox-segmented__opt${k === modo ? ' is-active' : ''}" data-value="${k}">${v}</button>`).join('')}
      </div>
      <div class="ox-row" style="gap:10px">
        <div class="ox-inputwrap ox-grow">
          ${Icons.svg('search', 'ox-icon--sm')}
          <input class="ox-input" id="campo" spellcheck="false" autocomplete="off"
                 placeholder="${esc(PLACEHOLDER[modo])}" value="${esc(valor)}">
        </div>
        <button class="ox-btn ox-btn--primary ox-flashable" data-action="buscar">Buscar</button>
      </div>
    </div>`;
}

function resultadosHTML() {
  if (S.cargando && !S.barrido) return cargando();

  const vista = S.expansion || S.busqueda;
  if (!vista) {
    return empty({
      icon: 'faro',
      title: 'Buscá un medicamento',
      text: 'Por nombre comercial, por droga o por laboratorio. Buscando por droga vas a ver todas las marcas juntas, que es lo que sirve para comparar.',
    });
  }

  if (vista.error) {
    return empty({ icon: 'alert', title: 'No se pudo consultar', text: vista.error });
  }

  if (!vista.items.length) {
    return empty({
      icon: 'search',
      title: 'Sin coincidencias',
      text: `El Manual no tiene nada para “${esc(vista.patron || vista.nombre || '')}”. Probá con menos letras.`,
    });
  }

  const esProductos = vista.items[0].tipo === 'producto';
  const recortado = vista.total && vista.total > vista.items.length;

  const encabezado = `
    <div class="ox-row" style="gap:12px;align-items:center;margin-bottom:12px;flex-wrap:wrap">
      ${S.expansion ? `
        <button class="ox-btn ox-btn--ghost ox-btn--sm ox-flashable" data-action="volver">
          ${Icons.svg('arrowLeft', 'ox-icon--sm')} Volver</button>
        <span class="ox-title">${esc(S.expansion.nombre)}</span>` : ''}
      <span class="ox-meta">${plural(vista.items.length, 'resultado', 'resultados')}${
        recortado ? ` de ${vista.total}` : ''}</span>
      ${origen(vista)}
      <div class="ox-spacer"></div>
      ${esProductos ? barridoHTML(vista) : ''}
    </div>`;

  const filas = esProductos
    ? vista.items.map(filaProducto).join('')
    : vista.items.map(filaIndice).join('');

  return `${encabezado}<div class="ox-list">${filas}</div>`;
}

/** El control del barrido: invita, informa o deja cortar. */
function barridoHTML(vista) {
  if (S.barrido) {
    const pct = Math.round((S.barrido.hechos / S.barrido.total) * 100);
    return `
      <div class="ox-row" style="gap:10px;align-items:center">
        <div class="ox-meter" style="--ox-pct:${pct};width:120px"><div class="ox-meter__fill"></div></div>
        <span class="ox-meta ox-num">${S.barrido.hechos}/${S.barrido.total}</span>
        <button class="ox-btn ox-btn--ghost ox-btn--sm ox-flashable" data-action="cortar">Cortar</button>
      </div>`;
  }

  const faltan = vista.items.filter((i) => !S.precios.has(i.slug)).length;
  if (!faltan) {
    return `<span class="ox-meta">${Icons.svg('check', 'ox-icon--sm')} precios traídos</span>`;
  }
  return `
    <button class="ox-btn ox-btn--secondary ox-btn--sm ox-flashable" data-action="barrer"
      data-tip="Abre la ficha de cada producto, de a uno y espaciado">
      ${Icons.svg('download', 'ox-icon--sm')} Traer precios (${faltan})</button>`;
}

function filaProducto(it) {
  const p = S.precios.get(it.slug);
  let precio = '<span class="ox-meta">—</span>';

  if (p?.fallo) {
    precio = '<span class="ox-meta ox-danger">sin datos</span>';
  } else if (p) {
    const c = conDescuento(p.min);
    precio = `
      <div class="ox-col" style="gap:2px;align-items:flex-end">
        <span class="ox-num ox-copyable" style="font-weight:var(--ox-w-medium)">${esc(fmtPesos(c.final))}</span>
        ${c.aplicado ? `<span class="ox-meta ox-num">lista ${esc(fmtPesos(p.min))}</span>` : ''}
        ${p.cuantas > 1 ? `<span class="ox-meta">desde · ${p.cuantas} present.</span>` : ''}
      </div>`;
  }

  return `
    <div class="ox-listitem" data-open="${esc(it.slug)}" tabindex="0">
      <span class="ox-iconcell">${Icons.svg('pildora', 'ox-icon--sm')}</span>
      <div class="ox-listitem__main">
        <div class="ox-listitem__title ox-truncate ox-copyable">${esc(it.nombre)}</div>
        <div class="ox-listitem__sub ox-truncate">${esc(it.laboratorio || '—')}</div>
      </div>
      <div class="ox-listitem__aside">${precio}</div>
      <div class="ox-rowactions">${botonFavorito(it.slug)}</div>
    </div>`;
}

function filaIndice(it) {
  return `
    <div class="ox-listitem" data-expandir="${esc(it.mde)}:${esc(it.idD || it.idL)}" tabindex="0">
      <span class="ox-iconcell">${Icons.svg(it.mde === 'lab' ? 'matraz' : 'pildora', 'ox-icon--sm')}</span>
      <div class="ox-listitem__main">
        <div class="ox-listitem__title ox-truncate ox-copyable">${esc(it.nombre)}</div>
        <div class="ox-listitem__sub">Ver todos sus productos</div>
      </div>
      <div class="ox-listitem__aside">${Icons.svg('chevronRight', 'ox-icon--sm')}</div>
    </div>`;
}

/** Los listeners de esta vista se enganchan a nodos que MUEREN con el
    repintado. Enganchar a #view sería acumular un handler por visita: la
    primera vez anda, la segunda cada click se dispara dos veces. */
function wireBuscar(zona) {
  const seg = zona.querySelector('#seg-modo');
  if (seg) {
    bindSwitcher(seg, async (valor) => {
      S.settings = await api.settings.save({ modo: valor });
      // El placeholder cambia con el índice; lo escrito se respeta.
      const campo = document.getElementById('campo');
      if (campo) campo.placeholder = PLACEHOLDER[valor];
    });
  }

  zona.querySelector('#campo')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') buscar(e.currentTarget.value);
  });
}

/* ══ Vista: Producto ═════════════════════════════════════════════════════════ */

function viewProducto() {
  pintarProducto();
}

function pintarProducto() {
  if (Router.name !== 'producto') return;
  const slug = Router.param;
  const ref = S.refs.get(slug) || {};
  const f = S.ficha;

  const crumbs = [{ label: 'Buscar', view: 'buscar' }, { label: ref.nombre || 'Producto' }];

  if (S.cargando || !f) {
    paint(head({ crumbs, title: ref.nombre || 'Cargando…' })
      + `<div class="ox-scroll ox-grow">${cargando()}</div>`);
    return;
  }

  if (f.error) {
    paint(head({ crumbs, title: f.nombre || 'Producto' }) + `
      <div class="ox-scroll ox-grow">${empty({
        icon: 'alert',
        title: 'No se pudo traer la ficha',
        text: f.error,
        actions: '<button class="ox-btn ox-btn--secondary ox-flashable" data-action="reintentar">Reintentar</button>',
      })}</div>`);
    return;
  }

  const d = descuento();

  paint(head({
    crumbs: [{ label: 'Buscar', view: 'buscar' }, { label: f.nombre }],
    title: f.nombre,
    sub: [f.laboratorio, f.droga].filter(Boolean).join(' · '),
    actions: `${botonFavorito(slug)}
      <button class="ox-btn ox-btn--secondary ox-flashable" data-action="reintentar"
        data-tip="Volver a consultar a alfabeta.net">${Icons.svg('retry')} Actualizar</button>`,
  }) + `
    <div class="ox-scroll ox-grow">
      <div class="ox-row" style="gap:8px;flex-wrap:wrap;margin-bottom:20px;align-items:center">
        ${f.droga ? `<span class="ox-chip">${Icons.svg('pildora', 'ox-icon--sm')} ${esc(f.droga)}</span>` : ''}
        ${f.accion ? `<span class="ox-chip ox-chip--outline">${esc(f.accion)}</span>` : ''}
        ${f.laboratorio ? `<span class="ox-chip ox-chip--outline">${Icons.svg('matraz', 'ox-icon--sm')} ${esc(f.laboratorio)}</span>` : ''}
        <div class="ox-spacer"></div>
        ${origen(f)}
      </div>

      ${descuentoHTML(d)}

      <div class="ox-section">
        <div class="ox-section__head">
          <span class="ox-section__title">${plural(f.presentaciones.length, 'Presentación', 'Presentaciones')}</span>
        </div>
        ${f.presentaciones.length
          ? presentacionesHTML(f.presentaciones)
          : empty({ icon: 'info', title: 'Sin presentaciones', text: 'El Manual no lista precios para este producto.' })}
      </div>
    </div>`);

  wireProducto();
  updateChrome();
}

/** El calculador de descuento. Vive en la ficha porque es donde están los
    precios, y su valor se guarda solo: se escribe una vez, no una por consulta. */
function descuentoHTML(d) {
  return `
    <div class="ox-card" style="margin-bottom:20px">
      <div class="ox-card__body">
        <div class="ox-row" style="gap:16px;align-items:center;flex-wrap:wrap">
          <label class="ox-row" style="gap:10px;cursor:pointer">
            <button class="ox-switch${d.activo ? ' is-on' : ''}" id="sw-descuento"
              data-tip="${d.activo ? 'Volver a los precios de lista' : 'Aplicar el descuento a toda la ficha'}"></button>
            <span class="ox-label">${Icons.svg('porcentaje', 'ox-icon--sm')} Aplicar descuento</span>
          </label>

          <div class="ox-stepper" id="st-descuento" style="width:126px">
            <input class="ox-input ox-num" type="number" min="0" max="100" step="1"
                   value="${d.porcentaje}" aria-label="Porcentaje de descuento">
            <div class="ox-stepper__btns">
              <button class="ox-stepper__btn" data-step="up" tabindex="-1"><i data-icon="chevronUp"></i></button>
              <button class="ox-stepper__btn" data-step="down" tabindex="-1"><i data-icon="chevronDown"></i></button>
            </div>
          </div>

          <div class="ox-row" style="gap:6px">
            ${[10, 15, 20, 25, 40].map((n) => `
              <button class="ox-btn ox-btn--ghost ox-btn--sm ox-flashable" data-pct="${n}">${n}%</button>`).join('')}
          </div>

          <div class="ox-spacer"></div>
          <span class="ox-meta">${d.activo
            ? `Mostrando precios con <b>${d.porcentaje}%</b> menos`
            : 'Mostrando precios de lista'}</span>
        </div>
      </div>
    </div>`;
}

function presentacionesHTML(lista) {
  const d = descuento();

  return `
    <table class="ox-table">
      <thead>
        <tr>
          <th>Presentación</th>
          <th class="ox-td--num">${d.activo ? 'Lista' : 'Precio'}</th>
          ${d.activo ? `<th class="ox-td--num">Con ${d.porcentaje}%</th><th class="ox-td--num">Ahorro</th>` : ''}
          <th class="ox-td--num">Vigente</th>
        </tr>
      </thead>
      <tbody>
        ${lista.map((p) => {
          const c = conDescuento(p.precio);
          return `
            <tr class="ox-tr">
              <td>
                <div class="ox-copyable">${esc(p.descripcion)}</div>
                ${p.coberturas.length ? coberturasHTML(p.coberturas) : ''}
              </td>
              <td class="ox-td--num ox-num ${d.activo ? 'ox-dim' : 'ox-copyable'}">${esc(fmtPesos(p.precio))}</td>
              ${d.activo ? `
                <td class="ox-td--num ox-num ox-copyable" style="font-weight:var(--ox-w-semi)">${esc(fmtPesos(c.final))}</td>
                <td class="ox-td--num ox-num ox-dim2">−${esc(fmtPesos(c.ahorro))}</td>` : ''}
              <td class="ox-td--num ox-meta">${p.fecha ? esc(fechaCorta(p.fecha)) : '—'}</td>
            </tr>`;
        }).join('')}
      </tbody>
    </table>`;
}

/** Las coberturas de obra social de una presentación. `paga` es lo que pone el
    afiliado en el mostrador — el número que más se pregunta. */
function coberturasHTML(coberturas) {
  return `
    <div class="ox-col" style="gap:6px;margin-top:8px">
      ${coberturas.map((c) => {
        const paga = conDescuento(c.paga);
        return `
        <div class="ox-row" style="gap:8px;align-items:baseline;flex-wrap:wrap">
          <span class="ox-chip">${Icons.svg('escudo', 'ox-icon--sm')} ${esc(c.obra)}</span>
          ${c.detalle ? `<span class="ox-meta">${esc(c.detalle)}</span>` : ''}
          ${c.paga != null ? `<span class="ox-meta">paga <b class="ox-num ox-copyable">${esc(fmtPesos(paga.final))}</b></span>` : ''}
          ${c.cubre != null ? `<span class="ox-meta">cubre <span class="ox-num">${esc(fmtPesos(c.cubre))}</span></span>` : ''}
        </div>`;
      }).join('')}
    </div>`;
}

/** "2026-09-03" → "03/09". El año se omite: son precios del mes en curso. */
function fechaCorta(iso) {
  const [, m, d] = String(iso).split('-');
  return d && m ? `${d}/${m}` : iso;
}

function wireProducto() {
  document.getElementById('sw-descuento')?.addEventListener('click', async () => {
    const d = descuento();
    // Prender el switch sin porcentaje no cambiaría nada y parecería roto.
    await guardarDescuento({ activo: !d.activo, porcentaje: d.porcentaje || 10 });
    pintarProducto();
  });

  const st = document.getElementById('st-descuento');
  if (st) {
    bindStepper(st, async (valor) => {
      const n = Number(valor) || 0;
      await guardarDescuento({ porcentaje: n, activo: n > 0 });
      pintarProducto();
    });
  }

  document.querySelectorAll('[data-pct]').forEach((b) =>
    b.addEventListener('click', async () => {
      await guardarDescuento({ porcentaje: Number(b.dataset.pct), activo: true });
      pintarProducto();
    }));
}

/* ══ Vista: Favoritos ════════════════════════════════════════════════════════ */

function viewFavoritos() {
  paint(head({ title: 'Favoritos', sub: 'Los que consultás seguido, a un click' }) + `
    <div class="ox-scroll ox-grow">${
      S.favoritos.length
        ? `<div class="ox-list">${S.favoritos.map((f) => `
            <div class="ox-listitem" data-open="${esc(f.slug)}" tabindex="0">
              <span class="ox-iconcell">${Icons.svg('pildora', 'ox-icon--sm')}</span>
              <div class="ox-listitem__main">
                <div class="ox-listitem__title ox-truncate ox-copyable">${esc(f.nombre)}</div>
                <div class="ox-listitem__sub ox-truncate">${esc(f.laboratorio || '—')} · guardado ${esc(relTime(f.guardadoEn))}</div>
              </div>
              <div class="ox-rowactions">${botonFavorito(f.slug)}</div>
            </div>`).join('')}</div>`
        : empty({
            icon: 'estrella',
            title: 'Todavía no guardaste ninguno',
            text: 'La estrella de cualquier producto lo deja acá para siempre.',
          })
    }</div>`);
}

/* ══ Vista: Historial ════════════════════════════════════════════════════════ */

function viewHistorial() {
  paint(head({
    title: 'Historial',
    sub: 'Lo último que buscaste',
    actions: S.historial.length
      ? `<button class="ox-btn ox-btn--ghost ox-flashable" data-action="borrar-historial">
           ${Icons.svg('trash')} Vaciar</button>`
      : '',
  }) + `
    <div class="ox-scroll ox-grow">${
      S.historial.length
        ? `<div class="ox-list">${S.historial.map((h) => `
            <div class="ox-listitem" data-rebuscar="${esc(h.modo)}:${esc(h.patron)}" tabindex="0">
              <span class="ox-iconcell">${Icons.svg('search', 'ox-icon--sm')}</span>
              <div class="ox-listitem__main">
                <div class="ox-listitem__title ox-truncate ox-copyable">${esc(h.patron)}</div>
                <div class="ox-listitem__sub">${esc(MODO_LABEL[h.modo] || h.modo)} · ${h.resultados} ${plural(h.resultados, 'resultado', 'resultados')}</div>
              </div>
              <div class="ox-listitem__aside"><span class="ox-meta">${esc(relTime(h.cuando))}</span></div>
            </div>`).join('')}</div>`
        : empty({ icon: 'clock', title: 'Sin búsquedas todavía', text: 'Lo que busques va a quedar acá.' })
    }</div>`);
}

/* ══ Vista: Ajustes ══════════════════════════════════════════════════════════ */

function viewAjustes() {
  const d = descuento();

  paint(head({ title: 'Ajustes', sub: 'Cómo consulta y qué recuerda' }) + `
    <div class="ox-scroll ox-grow">
      <div class="ox-section">
        <div class="ox-section__head"><span class="ox-section__title">Descuento</span></div>
        <div class="ox-card"><div class="ox-card__body">
          <div class="ox-kv">
            <span class="ox-kv__k">Estado</span>
            <span class="ox-kv__v">${d.activo ? `Aplicando ${d.porcentaje}%` : 'Apagado'}</span>
            <span class="ox-kv__k">Porcentaje</span>
            <span class="ox-kv__v ox-num">${d.porcentaje}%</span>
          </div>
          <span class="ox-field__hint" style="margin-top:10px;display:block">
            Se cambia desde la ficha de cualquier producto, que es donde se ve el efecto.</span>
        </div></div>
      </div>

      <div class="ox-section">
        <div class="ox-section__head"><span class="ox-section__title">Consultas guardadas</span></div>
        <div class="ox-card"><div class="ox-card__body">
          <div class="ox-kv">
            <span class="ox-kv__k">Vigencia</span>
            <span class="ox-kv__v"><span class="ox-num" id="kv-horas">${Number(S.settings.cacheHoras) || 12}</span> h</span>
            <span class="ox-kv__k">Guardadas</span>
            <span class="ox-kv__v ox-num" id="kv-entradas">—</span>
            <span class="ox-kv__k">En disco</span>
            <span class="ox-kv__v ox-num" id="kv-bytes">—</span>
          </div>

          <div class="ox-row" style="gap:14px;align-items:flex-end;margin-top:16px;flex-wrap:wrap">
            <div class="ox-field" style="width:150px">
              <label class="ox-field__label">Horas de vigencia</label>
              <div class="ox-stepper" id="st-horas">
                <input class="ox-input ox-num" type="number" min="0" max="168" step="1"
                       value="${Number(S.settings.cacheHoras) || 12}">
                <div class="ox-stepper__btns">
                  <button class="ox-stepper__btn" data-step="up" tabindex="-1"><i data-icon="chevronUp"></i></button>
                  <button class="ox-stepper__btn" data-step="down" tabindex="-1"><i data-icon="chevronDown"></i></button>
                </div>
              </div>
            </div>
            <button class="ox-btn ox-btn--secondary ox-flashable" data-action="vaciar-cache">
              ${Icons.svg('trash')} Vaciar lo guardado</button>
          </div>

          <span class="ox-field__hint" style="margin-top:12px;display:block">
            Pasadas esas horas, la app vuelve a preguntarle a alfabeta.net. En 0 consulta siempre:
            es más lento y le pega más al servidor.</span>
        </div></div>
      </div>

      <div class="ox-section">
        <div class="ox-section__head"><span class="ox-section__title">La app</span></div>
        <div class="ox-card"><div class="ox-card__body">
          <div class="ox-kv">
            <span class="ox-kv__k">Versión</span><span class="ox-kv__v ox-mono">${esc(S.info?.version || '—')}</span>
            <span class="ox-kv__k">Electron</span><span class="ox-kv__v ox-mono">${esc(S.info?.electron || '—')}</span>
            <span class="ox-kv__k">Datos</span>
            <span class="ox-kv__v ox-mono" data-tip="${esc(S.info?.dataDir || '')}">${path(S.info?.dataDir || '')}</span>
            <span class="ox-kv__k">Fuente</span>
            <span class="ox-kv__v">alfabeta.net · Manual Farmacéutico</span>
          </div>
        </div></div>
      </div>
    </div>`);

  const st = document.getElementById('st-horas');
  if (st) {
    bindStepper(st, async (valor) => {
      S.settings = await api.settings.save({ cacheHoras: Math.max(0, Number(valor) || 0) });
      const kv = document.getElementById('kv-horas');
      if (kv) kv.textContent = S.settings.cacheHoras;
    });
  }

  refrescarEstadoCache();
}

async function refrescarEstadoCache() {
  const est = await api.cache.estado().catch(() => null);
  if (!est) return;
  const e = document.getElementById('kv-entradas');
  const b = document.getElementById('kv-bytes');
  if (e) e.textContent = est.entradas;
  if (b) b.textContent = fmtBytes(est.bytes);
}

/* ══ Vista: Piezas ═══════════════════════════════════════════════════════════
   La vitrina del sistema visual. No está en el rail —no es parte de la app—
   pero queda a mano desde la paleta para cuando haya que tocar la UI. */

function viewPiezas() {
  // wireDesign necesita el contenedor donde buscar sus controles. paint() lo
  // devuelve; llamarla sin argumento rompe el cableado en silencio: la vitrina
  // se pinta igual y solo se nota al apretar algo.
  const raiz = paint(head({ title: 'Piezas', sub: 'El sistema visual, en vivo' }) + designHTML());
  wireDesign(raiz);
}

/* ══ Router ══════════════════════════════════════════════════════════════════ */

Router.define({
  buscar: { view: viewBuscar },
  producto: { view: viewProducto, nav: 'buscar' },
  favoritos: { view: viewFavoritos },
  historial: { view: viewHistorial },
  ajustes: { view: viewAjustes },
  piezas: { view: viewPiezas },
}, document.getElementById('view'));

/* ══ Shell ═══════════════════════════════════════════════════════════════════ */

function wireShell() {
  const w = api?.win;
  document.getElementById('win-min')?.addEventListener('click', () => w?.minimize());
  document.getElementById('win-close')?.addEventListener('click', () => w?.close());
  const maxBtn = document.getElementById('win-max');
  maxBtn?.addEventListener('click', () => w?.toggleMaximize());
  w?.onMaximized((isMax) => {
    maxBtn.innerHTML = Icons.svg(isMax ? 'winRestore' : 'winMax');
    maxBtn.setAttribute('aria-label', isMax ? 'Restaurar' : 'Maximizar');
  });

  document.querySelectorAll('.ox-navitem').forEach((b) =>
    b.addEventListener('click', () => Router.go(b.dataset.view)));

  document.getElementById('btn-palette')?.addEventListener('click', () => Palette.toggle());

  /* Delegación global, cableada UNA sola vez. Las vistas se repintan enteras,
     así que enganchar esto adentro de una vista acumularía un handler por
     visita: a la segunda, cada click se dispararía dos veces. */
  document.addEventListener('click', (e) => {
    const goto = e.target.closest('[data-goto]');
    if (goto) { Router.go(goto.dataset.goto, goto.dataset.param || null); return; }

    const fav = e.target.closest('[data-fav]');
    if (fav) {
      e.stopPropagation();   // la estrella vive dentro de una fila que abre el producto
      toggleFavorito(fav.dataset.fav).then(() => Router.refresh());
      return;
    }

    const abrir = e.target.closest('[data-open]');
    if (abrir) { abrirProducto(abrir.dataset.open); return; }

    const exp = e.target.closest('[data-expandir]');
    if (exp) {
      const [mde, id] = exp.dataset.expandir.split(':');
      const item = S.busqueda?.items.find((i) => String(i.idD || i.idL) === id && i.mde === mde);
      if (item) expandir(item);
      return;
    }

    const re = e.target.closest('[data-rebuscar]');
    if (re) {
      // El patrón puede tener ':' adentro, así que se corta en el PRIMERO.
      const crudo = re.dataset.rebuscar;
      const corte = crudo.indexOf(':');
      const modo = crudo.slice(0, corte);
      const patron = crudo.slice(corte + 1);
      api.settings.save({ modo }).then((s) => { S.settings = s; buscar(patron); });
      return;
    }

    const cp = e.target.closest('[data-copy]');
    if (cp) { copy(cp.dataset.copy); return; }

    const pct = e.target.closest('[data-pct]');
    if (pct) return;   // lo maneja wireProducto, con su propio listener

    const act = e.target.closest('[data-action]');
    if (act) acciones(act.dataset.action);
  });

  // Enter y Espacio sobre una fila: la lista tiene que ser usable sin mouse.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const fila = e.target.closest?.('[data-open],[data-expandir],[data-rebuscar]');
    if (!fila) return;
    e.preventDefault();
    fila.click();
  });
}

function acciones(a) {
  const campo = document.getElementById('campo');

  if (a === 'buscar') buscar(campo?.value);
  if (a === 'recargar') buscar(campo?.value || S.busqueda?.patron, { forzar: true });
  if (a === 'volver') { S.expansion = null; pintarBuscar(); }
  if (a === 'barrer') barrerPrecios((S.expansion || S.busqueda)?.items || []);
  if (a === 'cortar' && S.barrido) S.barrido.cortar = true;
  if (a === 'reintentar') abrirProducto(Router.param, { forzar: true });
  if (a === 'borrar-historial') borrarHistorial();
  if (a === 'vaciar-cache') vaciarCache();
}

async function borrarHistorial() {
  const ok = await Modal.confirm({
    title: '¿Vaciar el historial?',
    sub: 'Se borran las búsquedas recordadas. Los favoritos y lo guardado en disco no se tocan.',
    confirmLabel: 'Vaciar',
    danger: true,
  });
  if (!ok) return;
  S.historial = [];
  await attempt(() => api.doc.write(HISTORIAL, []));
  updateChrome();
  Router.refresh();
  Toast.show({ title: 'Historial vacío', icon: 'trash' });
}

async function vaciarCache() {
  const ok = await Modal.confirm({
    title: '¿Vaciar las consultas guardadas?',
    sub: 'La próxima búsqueda va a tardar un poco más porque se vuelve a preguntar todo. No se pierde ningún favorito.',
    confirmLabel: 'Vaciar',
    danger: true,
  });
  if (!ok) return;
  const n = await attempt(() => api.cache.vaciar(), { errorTitle: 'No se pudo vaciar' });
  S.precios.clear();
  refrescarEstadoCache();
  Toast.show({ title: 'Listo', text: `${n} ${plural(n, 'consulta borrada', 'consultas borradas')}`, icon: 'trash' });
}

/** Todo lo que vive fuera de la vista: statusbar y contadores del rail. */
function updateChrome() {
  const cf = document.querySelector('[data-view="favoritos"] .ox-navitem__count');
  if (cf) cf.textContent = S.favoritos.length;

  const ch = document.querySelector('[data-view="historial"] .ox-navitem__count');
  if (ch) ch.textContent = S.historial.length;

  const d = descuento();
  const valor = document.querySelector('#stat-descuento .ox-statusbar__value');
  if (valor) valor.textContent = d.activo ? `−${d.porcentaje}%` : 'sin descuento';

  const ctx = document.getElementById('titlebar-context');
  if (ctx) {
    const nombre = Router.name === 'producto'
      ? (S.ficha?.nombre || S.refs.get(Router.param)?.nombre || '')
      : '';
    ctx.innerHTML = nombre
      ? `${Icons.svg('pildora', 'ox-icon--sm')}<span>${esc(nombre)}</span>`
      : '';
  }

  const dir = S.info?.dataDir || '';
  const foot = document.getElementById('rail-foot');
  if (foot) foot.innerHTML = dir ? `<div class="ox-meta" data-tip="${esc(dir)}">${path(dir)}</div>` : '';
}

function registerCommands() {
  const d = descuento();
  Palette.clear();
  Palette.register([
    { id: 'nav-buscar', group: 'Ir a', icon: 'search', label: 'Buscar', run: () => Router.go('buscar') },
    { id: 'nav-fav', group: 'Ir a', icon: 'estrella', label: 'Favoritos', run: () => Router.go('favoritos') },
    { id: 'nav-hist', group: 'Ir a', icon: 'clock', label: 'Historial', run: () => Router.go('historial') },
    { id: 'nav-ajustes', group: 'Ir a', icon: 'settings', label: 'Ajustes', run: () => Router.go('ajustes') },
    { id: 'nav-piezas', group: 'Ir a', icon: 'layers', label: 'Piezas', hint: 'sistema visual', run: () => Router.go('piezas') },
    {
      id: 'desc-toggle', group: 'Descuento', icon: 'porcentaje',
      label: d.activo ? `Apagar el descuento (${d.porcentaje}%)` : 'Aplicar el descuento',
      run: async () => {
        await guardarDescuento({ activo: !d.activo, porcentaje: d.porcentaje || 10 });
        registerCommands();
        Router.refresh();
      },
    },
    ...S.favoritos.map((f) => ({
      id: `fav-${f.id}`,
      group: 'Favoritos',
      icon: 'pildora',
      label: f.nombre,
      hint: f.laboratorio || '',
      run: () => abrirProducto(f.slug),
    })),
  ]);
}

/* ══ Color de la ventana ═════════════════════════════════════════════════════
   --ox-bg está en oklch y Electron solo entiende hex. Se resuelve acá y se le
   manda al proceso principal, así el frame fantasma que pinta el compositor de
   Windows al restaurar sigue camuflado aunque cambie el matiz en tokens.css.
   La traducción la hace colorToken() con un canvas, nunca un regex. */
function syncWindowColor() {
  const hex = colorToken('--ox-bg');
  if (hex) api?.win?.setBackground(hex);
}

/* ══ Arranque ════════════════════════════════════════════════════════════════ */

async function boot() {
  Icons.mount(document);
  Tooltip.init();
  Palette.init();
  initClickFlash();
  initScrollFades();
  wireShell();
  syncWindowColor();

  try {
    await loadAll();
  } catch (err) {
    // Si los datos no cargan, la app tiene que DECIRLO. Una pantalla vacía sin
    // explicación es peor que un error feo.
    paint(empty({ icon: 'alert', title: 'No se pudo iniciar', text: err.message }));
    console.error(err);
    return;
  }

  registerCommands();
  updateChrome();
  Router.onChange(updateChrome);
  Router.go('buscar');

  // El splash se va recién cuando ya hay algo pintado debajo. El doble rAF
  // garantiza que el navegador aplicó los estilos de la vista antes del fade.
  raf2(() => {
    const splash = document.getElementById('boot-splash');
    if (!splash) return;
    splash.style.opacity = '0';
    splash.addEventListener('transitionend', () => splash.remove(), { once: true });
    setTimeout(() => splash.remove(), 600);
  });

  // El campo listo para escribir: abrir la app y teclear tiene que alcanzar.
  setTimeout(() => document.getElementById('campo')?.focus(), 260);
}

boot();
