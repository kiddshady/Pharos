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

  /* Salir: el símbolo de encendido. Cerrar la ventana no sale (queda en la
     bandeja), así que la paleta necesita un comando que sí lo haga. */
  salir: '<path d="M8 2.4v5.4"/><path d="M4.9 5.2a4.6 4.6 0 1 0 6.2 0"/>',

  /* El carrito: manija, canasto y dos ruedas. El canasto es más ancho arriba
     que abajo, que es lo que lo distingue de una caja con ruedas. */
  carrito: '<path d="M2.2 2.8h1.7l1.5 7.4h7l1.5-5.1H4.4"/>'
         + '<circle cx="6.6" cy="13" r="1.1"/><circle cx="11.3" cy="13" r="1.1"/>',
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

  /** Las presentaciones que se van a comprar, con la foto de su precio al
      momento de agregarlas. Ver "El carrito" más abajo. */
  carrito: [],
  /** El refresco de precios del carrito en curso, si hay uno. */
  refresco: null,

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

  /** Lo último que informó el actualizador. Llega entero en cada cambio, así
      que la vista se dibuja con esto y no lleva cuenta de nada. */
  update: null,
  avisadoDe: null,
};

/* ══ Datos en disco ══════════════════════════════════════════════════════════ */

const HISTORIAL = 'historial';
const CARRITO = 'carrito';

async function loadAll() {
  const [info, settings, favs, hist, carro] = await Promise.all([
    api.info(),
    api.settings.get(),
    favoritos.list(),
    api.doc.read(HISTORIAL, []),
    api.doc.read(CARRITO, { items: [] }),
  ]);
  S.info = info;
  S.settings = settings;
  S.favoritos = favs.sort((a, b) => (b.guardadoEn || 0) - (a.guardadoEn || 0));
  S.historial = Array.isArray(hist) ? hist : [];
  S.carrito = Array.isArray(carro?.items) ? carro.items : [];
  S.favoritos.forEach(recordarRef);
  // Los ítems del carrito también se abren con un click: necesitan su referencia.
  S.carrito.forEach(recordarRef);
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

/* ══ El carrito ══════════════════════════════════════════════════════════════
   Planificar la compra: qué presentaciones, cuántas, y cuánto va a salir en el
   mostrador. Cada ítem decide POR SU CUENTA dos cosas que en la ficha son
   globales: si va por PAMI (paga el afiliado) o particular (precio de lista), y
   si lleva el descuento de la farmacia. Porque así es la compra real: el
   remedio del abuelo va por PAMI, el ibuprofeno particular, y el descuento se
   aplica a unos y a otros no.

   El porcentaje es el MISMO de la ficha (es el de la farmacia, no cambia según
   dónde se mire); lo que es independiente es el prendido/apagado por ítem.

   Cada ítem guarda una FOTO de su precio —lista, lo que paga PAMI, la fecha de
   vigencia y cuándo se tomó— porque los precios cambian y un total armado con
   números de hace dos semanas tiene que decirlo. "Actualizar precios" vuelve a
   consultar cada ficha y renueva la foto. */

function guardarCarrito() {
  return api.doc.write(CARRITO, { items: S.carrito })
    .catch((err) => Toast.error('No se pudo guardar el carrito', err.message));
}

/** Lo que paga el afiliado de PAMI por esta presentación, si el Manual lo lista. */
const pamiDe = (p) => p?.coberturas?.find((c) => /\bPAMI\b/i.test(c.obra))?.paga ?? null;

/** La foto del precio de una presentación, tal como la guarda el carrito.
    `edad` es cuánto hacía que la ficha estaba en el caché: la foto se fecha
    cuando se consultó de verdad, no cuando se apretó el botón. */
const fotoDe = (p, edad = 0) => ({
  precio: p.precio, pami: pamiDe(p), fecha: p.fecha || null, consultado: Date.now() - (edad || 0),
});

const enCarrito = (slug, presentacion) =>
  S.carrito.find((i) => i.slug === slug && i.presentacion === presentacion);

/** Agrega la presentación `indice` de la ficha abierta; si ya estaba, suma una. */
async function agregarAlCarrito(indice) {
  const f = S.ficha;
  const p = f?.presentaciones?.[Number(indice)];
  const ref = S.refs.get(Router.param);
  if (!p || !ref) return;

  const ya = enCarrito(ref.slug, p.descripcion);
  if (ya) {
    ya.cantidad = Math.min(99, ya.cantidad + 1);
  } else {
    S.carrito.push({
      id: `${idDe(ref.slug)}-${Date.now().toString(36)}`,
      slug: ref.slug, idL: ref.idL, patron: ref.patron,
      nombre: f.nombre || ref.nombre, laboratorio: f.laboratorio || ref.laboratorio || null,
      presentacion: p.descripcion,
      ...fotoDe(p, f.deCache ? f.edad : 0),
      cantidad: 1,
      modo: 'particular',
      // Arranca como esté la ficha: si el descuento está puesto, se asume que
      // también corre en la compra. Después se decide fila por fila.
      descuento: descuento().activo,
      agregadoEn: Date.now(),
    });
  }
  await guardarCarrito();
  Toast.show({
    title: ya ? `Ahora son ${ya.cantidad} en el carrito` : 'Agregado al carrito',
    text: `${f.nombre} · ${p.descripcion}`,
    icon: 'carrito',
  });
  updateChrome();
  registerCommands();
  if (Router.name === 'producto') pintarProducto();
}

async function quitarDelCarrito(id) {
  const it = S.carrito.find((i) => i.id === id);
  if (!it) return;
  S.carrito = S.carrito.filter((i) => i.id !== id);
  await guardarCarrito();
  updateChrome();
  registerCommands();
  Toast.show({ title: 'Quitado del carrito', text: `${it.nombre} · ${it.presentacion}`, icon: 'carrito' });
}

/* Guardar en cada tecla del stepper sería una escritura por milisegundo de
   aguante; se junta todo en una, un momento después de que paró. */
let guardarCarritoTimer = null;
function cambiarItem(id, patch) {
  const it = S.carrito.find((i) => i.id === id);
  if (!it) return;
  Object.assign(it, patch);
  clearTimeout(guardarCarritoTimer);
  guardarCarritoTimer = setTimeout(guardarCarrito, 300);
  actualizarFila(it);
  pintarTotales();
  updateChrome();
}

/** Lo que se paga por UNA unidad del ítem, con su modo y su descuento. */
function unitario(it) {
  const base = it.modo === 'pami' && it.pami != null ? it.pami : it.precio;
  if (base == null) return null;
  const { porcentaje } = descuento();
  return it.descuento && porcentaje > 0 ? base * (1 - porcentaje / 100) : base;
}

/** Los totales del carrito. `lista` es cuánto saldría todo a precio de lista,
    particular y sin descuento: el número contra el que se mide el ahorro. */
function totalesCarrito() {
  const t = { total: 0, lista: 0, particular: 0, pami: 0, unidades: 0, sinPrecio: 0 };
  for (const it of S.carrito) {
    const u = unitario(it);
    const n = Number(it.cantidad) || 0;
    t.unidades += n;
    if (u == null) { t.sinPrecio += 1; continue; }
    const sub = u * n;
    t.total += sub;
    t.lista += (it.precio ?? 0) * n;
    if (it.modo === 'pami' && it.pami != null) t.pami += sub; else t.particular += sub;
  }
  t.ahorro = t.lista - t.total;
  return t;
}

/** El precio más viejo del carrito: la fecha que hay que mirar antes de confiar. */
function vigenciaCarrito() {
  const fotos = S.carrito.map((i) => i.consultado).filter(Boolean);
  return fotos.length ? Math.min(...fotos) : null;
}

/** Vuelve a consultar la ficha de cada producto del carrito y renueva las
    fotos. Explícito, de a uno y espaciado, como el barrido de precios. */
async function refrescarCarrito() {
  if (S.refresco || !S.carrito.length) return;

  const slugs = [...new Set(S.carrito.map((i) => i.slug))];
  S.refresco = { hechos: 0, total: slugs.length, cortar: false, fallos: 0 };
  pintarCarrito();

  for (const slug of slugs) {
    if (S.refresco.cortar) break;
    const ref = S.refs.get(slug) || S.carrito.find((i) => i.slug === slug);
    try {
      const r = await api.af.ficha({ slug, idL: ref.idL, patron: ref.patron, forzar: true });
      for (const it of S.carrito.filter((i) => i.slug === slug)) {
        // La presentación se reconoce por su descripción: es lo único estable
        // que tiene. Si el Manual la sacó, el ítem queda marcado, no borrado.
        const p = r.datos.presentaciones.find((x) => x.descripcion === it.presentacion);
        if (p) Object.assign(it, fotoDe(p, r.deCache ? r.edad : 0), { perdido: false });
        else it.perdido = true;
      }
    } catch {
      S.refresco.fallos += 1;
    }
    S.refresco.hechos += 1;
    pintarCarrito();
  }

  const { cortar, fallos } = S.refresco;
  S.refresco = null;
  await guardarCarrito();
  pintarCarrito();
  updateChrome();
  Toast.show({
    title: cortar ? 'Actualización interrumpida' : 'Precios actualizados',
    text: fallos ? `${plural(fallos, 'producto', 'productos')} no se pudo consultar.` : 'El total ya está con los precios de hoy.',
    icon: fallos ? 'alert' : 'check',
  });
}

async function vaciarCarrito() {
  const ok = await Modal.confirm({
    title: '¿Vaciar el carrito?',
    sub: 'Se quitan todos los ítems. Los favoritos y el historial no se tocan.',
    confirmLabel: 'Vaciar',
    danger: true,
  });
  if (!ok) return;
  S.carrito = [];
  await guardarCarrito();
  updateChrome();
  registerCommands();
  Router.refresh();
  Toast.show({ title: 'Carrito vacío', icon: 'carrito' });
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
          ? presentacionesHTML(f.presentaciones, slug)
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

function presentacionesHTML(lista, slug) {
  const d = descuento();

  return `
    <table class="ox-table">
      <thead>
        <tr>
          <th>Presentación</th>
          <th class="ox-td--num">${d.activo ? 'Lista' : 'Precio'}</th>
          ${d.activo ? `<th class="ox-td--num">Con ${d.porcentaje}%</th><th class="ox-td--num">Ahorro</th>` : ''}
          <th class="ox-td--num">Vigente</th>
          <th class="ox-td--tight"></th>
        </tr>
      </thead>
      <tbody>
        ${lista.map((p, i) => {
          const c = conDescuento(p.precio);
          const en = enCarrito(slug, p.descripcion);
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
              <td class="ox-td--tight">
                <button class="ox-iconbtn ox-flashable${en ? ' is-active' : ''}" data-carrito="${i}"
                  data-tip="${en ? `En el carrito (×${en.cantidad}) · agregar otra` : 'Agregar al carrito'}">
                  ${Icons.svg('carrito')}</button>
              </td>
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

/* ══ Vista: Carrito ══════════════════════════════════════════════════════════
   Una tabla donde cada fila decide lo suyo (cantidad, PAMI o particular,
   descuento sí o no) y abajo la cuenta. Las filas se actualizan EN SU LUGAR,
   nunca repintando la tabla: repintar mataría el stepper que el usuario está
   aguantando y el viaje de la cápsula del segmentado. */

function viewCarrito() {
  pintarCarrito();
}

function pintarCarrito() {
  if (Router.name !== 'carrito') return;
  const n = S.carrito.length;

  paint(head({
    title: 'Carrito',
    sub: 'Lo que vas a comprar, y cuánto va a salir en el mostrador',
    actions: n ? `${refrescoHTML()}
      <button class="ox-btn ox-btn--ghost ox-flashable" data-action="vaciar-carrito">
        ${Icons.svg('trash')} Vaciar</button>` : '',
  }) + `<div class="ox-scroll ox-grow">${n ? carritoHTML() : carritoVacioHTML()}</div>`);

  wireCarrito();
}

function carritoVacioHTML() {
  return empty({
    icon: 'carrito',
    title: 'El carrito está vacío',
    text: 'En la ficha de un producto, el carrito al final de cada presentación la agrega acá. Después elegís cuántas, si va por PAMI o particular, y si lleva descuento.',
    actions: `<button class="ox-btn ox-btn--secondary ox-flashable" data-goto="buscar">
      ${Icons.svg('search')} Ir a buscar</button>`,
  });
}

/** El control de "Actualizar precios": invita, informa o deja cortar. */
function refrescoHTML() {
  if (S.refresco) {
    const pct = Math.round((S.refresco.hechos / S.refresco.total) * 100);
    return `
      <div class="ox-row" style="gap:10px;align-items:center">
        <div class="ox-meter" style="--ox-pct:${pct};width:120px"><div class="ox-meter__fill"></div></div>
        <span class="ox-meta ox-num">${S.refresco.hechos}/${S.refresco.total}</span>
        <button class="ox-btn ox-btn--ghost ox-btn--sm ox-flashable" data-action="cortar-refresco">Cortar</button>
      </div>`;
  }
  return `
    <button class="ox-btn ox-btn--secondary ox-flashable" data-action="refrescar-carrito"
      data-tip="Vuelve a consultar la ficha de cada producto, de a uno y espaciado">
      ${Icons.svg('retry')} Actualizar precios</button>`;
}

function carritoHTML() {
  const d = descuento();

  return `
    <div class="ox-card" style="margin-bottom:20px"><div class="ox-card__body">
      <div class="ox-row" style="gap:16px;align-items:center;flex-wrap:wrap">
        <span class="ox-label">${Icons.svg('porcentaje', 'ox-icon--sm')} Descuento de la farmacia</span>
        <div class="ox-stepper" id="st-desc-carrito" style="width:110px">
          <input class="ox-input ox-num" type="number" min="0" max="100" step="1"
                 value="${d.porcentaje}" aria-label="Porcentaje de descuento">
          <div class="ox-stepper__btns">
            <button class="ox-stepper__btn" data-step="up" tabindex="-1"><i data-icon="chevronUp"></i></button>
            <button class="ox-stepper__btn" data-step="down" tabindex="-1"><i data-icon="chevronDown"></i></button>
          </div>
        </div>
        <span class="ox-meta">Corre en las filas con el tilde. Es el mismo porcentaje que en la ficha.</span>
        <div class="ox-spacer"></div>
        ${vigenciaHTML()}
      </div>
    </div></div>

    <table class="ox-table">
      <thead>
        <tr>
          <th>Producto</th>
          <th class="ox-td--tight">Cantidad</th>
          <th class="ox-td--tight">Va por</th>
          <th class="ox-td--tight" style="text-align:center">Desc.</th>
          <th class="ox-td--num">Unitario</th>
          <th class="ox-td--num">Subtotal</th>
          <th class="ox-td--num">Vigente</th>
          <th class="ox-td--tight"></th>
        </tr>
      </thead>
      <tbody>${S.carrito.map(filaCarrito).join('')}</tbody>
    </table>

    <div id="carrito-totales" style="margin-top:20px">${totalesHTML()}</div>`;
}

/** De cuándo son los precios con los que se está sumando. No se omite. */
function vigenciaHTML() {
  const viejo = vigenciaCarrito();
  if (!viejo) return '';
  return `<span class="ox-meta" data-tip="La foto más vieja del carrito. Actualizar precios las renueva todas.">
    ${Icons.svg('clock', 'ox-icon--sm')} precios tomados ${esc(relTime(viejo))}</span>`;
}

function filaCarrito(it) {
  const id = esc(it.id);
  const tienePami = it.pami != null;

  return `
    <tr class="ox-tr" data-item="${id}">
      <td>
        <div class="ox-row" style="gap:8px;align-items:center;flex-wrap:wrap">
          <span class="ox-copyable" style="font-weight:var(--ox-w-medium);color:var(--ox-text)"
                data-open="${esc(it.slug)}" data-tip="Abrir la ficha">${esc(it.nombre)}</span>
          ${it.perdido ? `<span class="ox-chip ox-chip--danger">${Icons.svg('alert', 'ox-icon--sm')} ya no está en el Manual</span>` : ''}
        </div>
        <div class="ox-meta">${esc(it.presentacion)}${it.laboratorio ? ` · ${esc(it.laboratorio)}` : ''}</div>
      </td>
      <td class="ox-td--tight">
        <div class="ox-stepper" data-cantidad="${id}" style="width:72px">
          <input class="ox-input ox-num" type="number" min="1" max="99" step="1"
                 value="${Number(it.cantidad) || 1}" aria-label="Cantidad">
          <div class="ox-stepper__btns">
            <button class="ox-stepper__btn" data-step="up" tabindex="-1"><i data-icon="chevronUp"></i></button>
            <button class="ox-stepper__btn" data-step="down" tabindex="-1"><i data-icon="chevronDown"></i></button>
          </div>
        </div>
      </td>
      <td class="ox-td--tight">
        ${tienePami ? `
          <div class="ox-segmented" data-modo="${id}">
            <button class="ox-segmented__opt${it.modo !== 'pami' ? ' is-active' : ''}" data-value="particular">Particular</button>
            <button class="ox-segmented__opt${it.modo === 'pami' ? ' is-active' : ''}" data-value="pami">PAMI</button>
          </div>`
        : `<span class="ox-meta" data-tip="El Manual no lista cobertura PAMI para esta presentación">Particular</span>`}
      </td>
      <td class="ox-td--tight" style="text-align:center">
        <button class="ox-check${it.descuento ? ' is-on' : ''}" data-desc="${id}" aria-label="Aplicar descuento"
          data-tip="${it.descuento ? 'Con descuento · click para sacarlo' : 'Sin descuento · click para aplicarlo'}">
          ${Icons.svg('check')}</button>
      </td>
      <td class="ox-td--num" data-cell="unit">${unitarioHTML(it)}</td>
      <td class="ox-td--num ox-num ox-copyable" data-cell="sub"
          style="font-weight:var(--ox-w-semi);color:var(--ox-text)">${subtotalHTML(it)}</td>
      <td class="ox-td--num ox-meta">${it.fecha ? esc(fechaCorta(it.fecha)) : '—'}</td>
      <td class="ox-td--tight">
        <div class="ox-rowactions">
          <button class="ox-iconbtn ox-flashable" data-quitar="${id}" data-tip="Quitar del carrito">${Icons.svg('close')}</button>
        </div>
      </td>
    </tr>`;
}

/** El precio por unidad y, cuando no es el de lista, el de lista debajo para
    que se vea de dónde salió. */
function unitarioHTML(it) {
  const u = unitario(it);
  if (u == null) return '<span class="ox-meta">sin precio</span>';
  const distintoDeLista = it.precio != null && Math.abs(u - it.precio) > 0.005;
  return `
    <div class="ox-col" style="gap:2px;align-items:flex-end">
      <span class="ox-num ox-copyable">${esc(fmtPesos(u))}</span>
      ${distintoDeLista ? `<span class="ox-meta ox-num">lista ${esc(fmtPesos(it.precio))}</span>` : ''}
    </div>`;
}

function subtotalHTML(it) {
  const u = unitario(it);
  return u == null ? '—' : esc(fmtPesos(u * (Number(it.cantidad) || 0)));
}

function totalesHTML() {
  const t = totalesCarrito();
  const mixto = t.pami > 0 && t.particular > 0;

  return `
    <div class="ox-card"><div class="ox-card__body">
      <div class="ox-row" style="gap:36px;align-items:flex-end;flex-wrap:wrap">
        <div class="ox-stat">
          <span class="ox-stat__value ox-copyable" style="font-size:var(--ox-fs-26)">${esc(fmtPesos(t.total))}</span>
          <span class="ox-stat__label">Total a pagar</span>
        </div>
        ${mixto ? `
          <div class="ox-stat">
            <span class="ox-stat__value ox-copyable">${esc(fmtPesos(t.particular))}</span>
            <span class="ox-stat__label">Particular</span>
          </div>
          <div class="ox-stat">
            <span class="ox-stat__value ox-copyable">${esc(fmtPesos(t.pami))}</span>
            <span class="ox-stat__label">Por PAMI</span>
          </div>` : ''}
        <div class="ox-stat">
          <span class="ox-stat__value ox-dim">${esc(fmtPesos(t.lista))}</span>
          <span class="ox-stat__label">A precio de lista</span>
        </div>
        <div class="ox-stat">
          <span class="ox-stat__value ox-copyable">${esc(fmtPesos(t.ahorro))}</span>
          <span class="ox-stat__label">Te ahorrás</span>
        </div>
        <div class="ox-spacer"></div>
        <span class="ox-meta">${plural(t.unidades, 'unidad', 'unidades')} en ${plural(S.carrito.length, 'ítem', 'ítems')}${
          t.sinPrecio ? ` · ${t.sinPrecio} sin precio` : ''}</span>
      </div>
    </div></div>`;
}

/** Repinta las celdas de una fila que dependen de cantidad, modo o descuento. */
function actualizarFila(it) {
  const tr = document.querySelector(`tr[data-item="${it.id}"]`);
  if (!tr) return;
  tr.querySelector('[data-cell="unit"]').innerHTML = unitarioHTML(it);
  tr.querySelector('[data-cell="sub"]').innerHTML = subtotalHTML(it);
}

function pintarTotales() {
  const caja = document.getElementById('carrito-totales');
  if (!caja) return;
  caja.innerHTML = totalesHTML();
  Icons.mount(caja);
}

/** Todos los listeners van sobre nodos que mueren con el repintado. */
function wireCarrito() {
  const acotar = (v, min, max) => Math.min(max, Math.max(min, Math.round(Number(v)) || min));

  /* Cambio del porcentaje: toca el ajuste compartido con la ficha y refresca
     todas las filas, porque el unitario de cada una depende de él. `change`
     y no el callback del stepper: así también cuenta lo que se escribe a mano. */
  document.getElementById('st-desc-carrito')?.addEventListener('change', async (e) => {
    await guardarDescuento({ porcentaje: acotar(e.target.value, 0, 100) });
    S.carrito.forEach(actualizarFila);
    pintarTotales();
  });
  const stDesc = document.getElementById('st-desc-carrito');
  if (stDesc) bindStepper(stDesc);

  document.querySelectorAll('[data-cantidad]').forEach((el) => {
    bindStepper(el);
    el.addEventListener('change', (e) => {
      const n = acotar(e.target.value, 1, 99);
      e.target.value = n;
      cambiarItem(el.dataset.cantidad, { cantidad: n });
    });
  });

  document.querySelectorAll('[data-modo]').forEach((el) => {
    bindSwitcher(el, (valor) => cambiarItem(el.dataset.modo, { modo: valor }));
  });

  document.querySelectorAll('[data-desc]').forEach((b) => {
    b.addEventListener('click', () => {
      const it = S.carrito.find((i) => i.id === b.dataset.desc);
      if (!it) return;
      const on = !it.descuento;
      b.classList.toggle('is-on', on);
      b.dataset.tip = on ? 'Con descuento · click para sacarlo' : 'Sin descuento · click para aplicarlo';
      cambiarItem(it.id, { descuento: on });
    });
  });
}

/* ══ Actualizaciones ═════════════════════════════════════════════════════════
   Tres pasos explícitos —buscar, descargar, instalar— y ninguno pasa solo.
   Bajar noventa megas o reiniciar la app en medio de una consulta son cosas
   que decide el usuario, no la app. */

const FASE = {
  inactivo: 'Sin verificar',
  buscando: 'Buscando…',
  'al-dia': 'Estás en la última versión',
  disponible: 'Hay una versión nueva',
  descargando: 'Descargando…',
  lista: 'Lista para instalar',
  error: 'No se pudo verificar',
};

function updateHTML() {
  const u = S.update || { fase: 'inactivo', versionActual: S.info?.version, soportado: true };
  const buscar = `<button class="ox-btn ox-btn--secondary ox-flashable" data-action="buscar-update">
      ${Icons.svg('retry')} Buscar actualizaciones</button>`;

  let accion = buscar;
  if (u.fase === 'buscando') {
    accion = `<span class="ox-meta">${Icons.spinner()} Buscando…</span>`;
  } else if (u.fase === 'disponible') {
    accion = `<button class="ox-btn ox-btn--primary ox-flashable" data-action="bajar-update">
      ${Icons.svg('download')} Descargar ${esc(u.version || '')}</button>`;
  } else if (u.fase === 'descargando') {
    accion = `<div class="ox-row" style="gap:10px;align-items:center">
      <div class="ox-meter" style="--ox-pct:${u.progreso};width:170px"><div class="ox-meter__fill"></div></div>
      <span class="ox-meta ox-num">${u.progreso}%</span></div>`;
  } else if (u.fase === 'lista') {
    accion = `<button class="ox-btn ox-btn--primary ox-flashable" data-action="instalar-update">
      ${Icons.svg('zap')} Reiniciar e instalar ${esc(u.version || '')}</button>`;
  }

  /* Corriendo desde el código fuente no hay con qué compararse. Decirlo es
     mejor que mostrar un botón que no puede hacer nada. */
  const nota = u.soportado === false
    ? 'Las actualizaciones funcionan en la app instalada. Corriendo desde el código, actualizás con git.'
    : 'Se busca sola al abrir la app, pero descargar e instalar los decidís vos.';

  return `
    <div class="ox-section">
      <div class="ox-section__head"><span class="ox-section__title">Actualizaciones</span></div>
      <div class="ox-card"><div class="ox-card__body">
        <div class="ox-kv">
          <span class="ox-kv__k">Instalada</span>
          <span class="ox-kv__v ox-mono">${esc(u.versionActual || S.info?.version || '—')}</span>
          <span class="ox-kv__k">Estado</span>
          <span class="ox-kv__v">${esc(FASE[u.fase] || FASE.inactivo)}${
            u.fase === 'disponible' && u.version ? `: <b>${esc(u.version)}</b>` : ''}</span>
          ${u.error ? `<span class="ox-kv__k">Detalle</span>
            <span class="ox-kv__v ox-danger">${esc(u.error)}</span>` : ''}
        </div>
        <div class="ox-row" style="gap:12px;align-items:center;margin-top:16px;flex-wrap:wrap">${accion}</div>
        <span class="ox-field__hint" style="margin-top:12px;display:block">${esc(nota)}</span>
      </div></div>
    </div>`;
}

/** Repinta SOLO la caja de actualizaciones. Repintar Ajustes entera en cada
    aviso de progreso le robaría el foco al campo de horas mientras escribís. */
function pintarUpdate() {
  if (Router.name !== 'ajustes') return;
  const caja = document.getElementById('caja-update');
  if (!caja) return;
  caja.innerHTML = updateHTML();
  Icons.mount(caja);
}

async function accionUpdate(a) {
  if (a === 'buscar-update') {
    S.update = await attempt(() => api.update.buscar(), { errorTitle: 'No se pudo buscar' });
    pintarUpdate();
    return;
  }

  if (a === 'bajar-update') {
    // La descarga informa su progreso por el evento; acá solo se dispara.
    api.update.descargar();
    return;
  }

  if (a === 'instalar-update') {
    const ok = await Modal.confirm({
      title: '¿Instalar y reiniciar?',
      sub: 'Pharos se va a cerrar para instalar la versión nueva y va a volver a abrirse sola. Tus favoritos, el historial y los ajustes quedan como están.',
      confirmLabel: 'Instalar',
    });
    if (ok) api.update.instalar();
  }
}

/** Un aviso discreto cuando aparece una versión nueva, una sola vez por
    versión: repetirlo en cada arranque sería una app que te reta. */
function avisarDeVersion(u) {
  if (u.fase !== 'disponible' || !u.version || S.avisadoDe === u.version) return;
  S.avisadoDe = u.version;
  Toast.show({
    title: `Hay una versión nueva (${u.version})`,
    text: 'Está en Ajustes, cuando quieras.',
    icon: 'zap',
    duration: 6000,
  });
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

      <div id="caja-update">${updateHTML()}</div>

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
  carrito: { view: viewCarrito },
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

    const alCarro = e.target.closest('[data-carrito]');
    if (alCarro) { agregarAlCarrito(alCarro.dataset.carrito); return; }

    const quitar = e.target.closest('[data-quitar]');
    if (quitar) {
      quitarDelCarrito(quitar.dataset.quitar).then(() => Router.refresh());
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
  if (a === 'vaciar-carrito') vaciarCarrito();
  if (a === 'refrescar-carrito') refrescarCarrito();
  if (a === 'cortar-refresco' && S.refresco) S.refresco.cortar = true;
  if (a.endsWith('-update')) accionUpdate(a);
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

  const cc = document.querySelector('[data-view="carrito"] .ox-navitem__count');
  if (cc) cc.textContent = S.carrito.length;

  // El total del carrito siempre a la vista: es el número por el que existe.
  const sc = document.querySelector('#stat-carrito .ox-statusbar__value');
  if (sc) {
    const t = totalesCarrito();
    sc.textContent = S.carrito.length ? `${fmtPesos(t.total)} · ${plural(t.unidades, 'unidad', 'unidades')}` : 'carrito vacío';
  }

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
    {
      id: 'nav-carrito', group: 'Ir a', icon: 'carrito', label: 'Carrito',
      hint: S.carrito.length ? `${plural(S.carrito.length, 'ítem', 'ítems')} · ${fmtPesos(totalesCarrito().total)}` : 'vacío',
      run: () => Router.go('carrito'),
    },
    { id: 'nav-hist', group: 'Ir a', icon: 'clock', label: 'Historial', run: () => Router.go('historial') },
    { id: 'nav-ajustes', group: 'Ir a', icon: 'settings', label: 'Ajustes', run: () => Router.go('ajustes') },
    { id: 'nav-piezas', group: 'Ir a', icon: 'layers', label: 'Piezas', hint: 'sistema visual', run: () => Router.go('piezas') },
    {
      id: 'buscar-update', group: 'La app', icon: 'retry', label: 'Buscar actualizaciones',
      run: () => { Router.go('ajustes'); accionUpdate('buscar-update'); },
    },
    {
      id: 'salir', group: 'La app', icon: 'salir', label: 'Salir de Pharos',
      hint: 'cerrar la ventana la deja en la bandeja',
      run: () => api?.quit(),
    },
    ...(S.carrito.length ? [{
      id: 'vaciar-carrito', group: 'Carrito', icon: 'trash', label: 'Vaciar el carrito',
      run: () => vaciarCarrito(),
    }] : []),
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

  /* El actualizador avisa por su cuenta cómo va. Se escucha UNA sola vez, acá:
     suscribirse dentro de la vista de Ajustes dejaría un listener más por cada
     visita, y a la tercera el progreso repintaría tres veces por aviso. */
  S.update = await api.update.estado().catch(() => null);
  api.update.on((u) => {
    S.update = u;
    avisarDeVersion(u);
    pintarUpdate();
  });

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
