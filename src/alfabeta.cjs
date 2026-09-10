'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   PHAROS — cliente de alfabeta.net
   Vive en el proceso principal a propósito: el renderer no tiene red (la CSP
   del index.html es `default-src 'self'`), así que todo lo que salga a
   internet pasa por acá y el renderer solo ve datos ya parseados.

   ── Cómo funciona el sitio ─────────────────────────────────────────────────
   Es un JSP viejo y previsible: formularios que hacen POST a /precio/srv, sin
   login, sin JS, sin tokens. Hay tres índices y dos formas de resultado:

     src=prs&mde=pat   patrón → PRODUCTOS   (resultado final)
     src=drgs          patrón → DROGAS      (índice: hay que dar un paso más)
     src=labs          patrón → LABORATORIOS(ídem)

     src=prs&mde=drg&idD=N  → los productos de esa droga
     src=prs&mde=lab&idL=N  → los productos de ese laboratorio

   Y la ficha de un producto es un POST a su propio slug:
     /precio/<slug>.html  con  src=pr&idL=N&patron=<NOMBRE>

   La diferencia entre "índice" y "producto" se lee en el `action` del form:
   si termina en `.html` es un producto; si es `srv`, es un índice.

   ── Dos trampas del sitio ──────────────────────────────────────────────────
   1. Viene en ISO-8859-1, no en UTF-8. Sin decodificar bien, "Bagó" llega
      como "Bag?" y "Analgésico" como "Analg?sico". El Content-Type lo declara
      pero fetch() no lo aplica solo: hay que leer el buffer y decodificarlo.
   2. Mezcla texto crudo con entidades HTML (&aacute;, &#149;, &nbsp;). Hay
      que decodificar DESPUÉS de sacar los tags, o se pierden los separadores.
   ═══════════════════════════════════════════════════════════════════════════ */

const BASE = 'https://www.alfabeta.net/precio/';

/* Un User-Agent honesto: dice qué es esto y para qué. Mentir diciendo ser
   Chrome sería trivial, pero un sitio que quiera bloquear un cliente
   automático tiene derecho a poder identificarlo. */
const UA = 'Pharos/1.0 (app de escritorio; consulta personal de precios)';

/* Tiempo máximo por request. El sitio responde en ~1s; 20 es holgado y evita
   que la UI quede colgada esperando para siempre si la red se cae a la mitad. */
const TIMEOUT = 20000;

/* Intervalo mínimo entre requests. No es opcional: la app podría disparar
   veinte búsquedas en un segundo y eso es maltratar un servidor ajeno.
   Serializar + espaciar cuesta imperceptible para una persona y le ahorra el
   pico al de enfrente. */
const INTERVALO = 650;

/* ══ Cortesía: una cola serial con espaciado ═════════════════════════════════
   Todas las peticiones pasan por acá, así que nunca hay dos en vuelo ni dos
   más juntas que INTERVALO. */

let cola = Promise.resolve();
let ultimo = 0;

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

function encolar(fn) {
  const turno = cola.then(async () => {
    const espera = INTERVALO - (Date.now() - ultimo);
    if (espera > 0) await dormir(espera);
    try {
      return await fn();
    } finally {
      ultimo = Date.now();
    }
  });
  // La cola sigue viva aunque un turno falle: si no, un error deja la app muda.
  cola = turno.then(() => {}, () => {});
  return turno;
}

/* ══ Sesión ══════════════════════════════════════════════════════════════════
   El sitio entrega un JSESSIONID. No hace falta para consultar, pero mandarlo
   de vuelta es lo que haría un navegador y evita que el servidor abra una
   sesión nueva por cada búsqueda. */

let cookie = null;

function recordarCookie(res) {
  const raw = res.headers.get('set-cookie');
  if (!raw) return;
  const par = raw.split(';')[0];
  if (par.includes('=')) cookie = par;
}

/* ══ HTTP ════════════════════════════════════════════════════════════════════ */

/**
 * Un POST de formulario al sitio, devuelto como texto ya decodificado.
 * @param {string} ruta   relativa a /precio/ ('srv' o 'algo.html')
 * @param {object} campos pares que van como application/x-www-form-urlencoded
 */
async function pedir(ruta, campos) {
  return encolar(async () => {
    const ctrl = new AbortController();
    const reloj = setTimeout(() => ctrl.abort(), TIMEOUT);

    try {
      const res = await fetch(BASE + ruta, {
        method: 'POST',
        signal: ctrl.signal,
        headers: {
          'User-Agent': UA,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'es-AR,es;q=0.9',
          'Referer': BASE,
          ...(cookie ? { Cookie: cookie } : {}),
        },
        body: new URLSearchParams(campos).toString(),
      });

      if (!res.ok) throw new Error(`alfabeta.net respondió ${res.status}`);
      recordarCookie(res);

      /* Acá está la trampa #1: el sitio es ISO-8859-1. Leer con res.text()
         asume UTF-8 y rompe cada acento del país. */
      const buf = await res.arrayBuffer();
      return new TextDecoder('iso-8859-1').decode(buf);
    } catch (err) {
      if (err.name === 'AbortError') throw new Error('alfabeta.net tardó demasiado en responder');
      // Sin red, el mensaje de fetch es "fetch failed", que no le dice nada a nadie.
      if (/fetch failed|ENOTFOUND|ECONNREFUSED|EAI_AGAIN/i.test(err.message)) {
        throw new Error('No hay conexión con alfabeta.net');
      }
      throw err;
    } finally {
      clearTimeout(reloj);
    }
  });
}

/* ══ Texto ═══════════════════════════════════════════════════════════════════ */

const ENTIDADES = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú',
  Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú',
  ntilde: 'ñ', Ntilde: 'Ñ', uuml: 'ü', Uuml: 'Ü', deg: '°',
  ordm: 'º', ordf: 'ª', laquo: '«', raquo: '»', hellip: '…',
  mdash: '—', ndash: '–', bull: '•', middot: '·', reg: '®', copy: '©',
};

/* Los códigos 128-159 no son lo que dicen ser.
   El sitio declara ISO-8859-1, donde ese rango son caracteres de control
   invisibles. Pero lo que quiso escribir —y lo que cualquier navegador
   muestra— es Windows-1252: ahí viven el bullet, las comillas tipográficas,
   los guiones largos y el apóstrofo curvo. HTML5 estandarizó justamente esa
   reinterpretación porque la web está llena de páginas así.

   Sin esta tabla, `&#149;` (el separador que alfabeta usa entre el producto y
   su laboratorio) se convierte en U+0095: un control invisible que se cuela en
   el texto sin que nada se vea roto. Con `&#146;` sería peor todavía, porque
   ese apóstrofo aparece adentro de nombres. */
const CP1252 = {
  128: '€', 130: '‚', 131: 'ƒ', 132: '„', 133: '…', 134: '†', 135: '‡',
  136: 'ˆ', 137: '‰', 138: 'Š', 139: '‹', 140: 'Œ', 142: 'Ž', 145: '\u2018',
  146: '\u2019', 147: '\u201C', 148: '\u201D', 149: '•', 150: '–', 151: '—',
  152: '˜', 153: '™', 154: 'š', 155: '›', 156: 'œ', 158: 'ž', 159: 'Ÿ',
};

const codigo = (n) => (n in CP1252 ? CP1252[n] : String.fromCodePoint(n));

/** Decodifica entidades HTML, con nombre o numéricas (&#149; &#x2022;). */
function desentidad(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => codigo(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => codigo(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => (n in ENTIDADES ? ENTIDADES[n] : m));
}

/** Saca los tags, decodifica entidades y normaliza los espacios. En ese orden:
    si se decodificara antes, un `&lt;b&gt;` del contenido se comería como tag. */
function texto(html) {
  return desentidad(String(html).replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * "$14.189,89" → 14189.89
 * El sitio escribe en formato argentino: punto de miles, coma decimal.
 * Parsear esto con parseFloat() directo da 14.18 — un error de mil veces que
 * además parece un número plausible, que es lo peligroso.
 */
function precio(s) {
  const limpio = String(s).replace(/[^\d.,]/g, '');
  if (!limpio) return null;
  const n = Number(limpio.replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

/** "(03/09/26)" → "2026-09-03", o null si no se entiende. */
function fecha(s) {
  const m = String(s).match(/(\d{2})\/(\d{2})\/(\d{2,4})/);
  if (!m) return null;
  const [, d, mes, a] = m;
  const anio = a.length === 2 ? `20${a}` : a;
  return `${anio}-${mes}-${d}`;
}

/* ══ Parsers ═════════════════════════════════════════════════════════════════ */

/** Los campos ocultos de un <form>, como objeto. */
function ocultos(formHtml) {
  const out = {};
  const re = /<input[^>]*type=["']hidden["'][^>]*>/gi;
  let m;
  while ((m = re.exec(formHtml))) {
    const nombre = m[0].match(/name=["']([^"']*)["']/i)?.[1];
    const valor = m[0].match(/value=["']([^"']*)["']/i)?.[1];
    if (nombre) out[nombre] = desentidad(valor ?? '');
  }
  return out;
}

/**
 * Mapa nombreDeForm → { clase, texto, index } de las anclas que disparan forms.
 *
 * Cada resultado del sitio es un <form> y, más abajo, un <a> que lo submitea.
 * Recorrer las anclas UNA vez e indexarlas por el form que disparan es lo que
 * ata el texto visible a sus parámetros, y de paso da la clase — que es el
 * único dato que separa un resultado de verdad del sello del fabricante:
 *
 *   <a class="rprod" href="…pr1.submit()">IBUPIRAC 400 MG</a>  ← un resultado
 *   <a class="rlab"  href="…lab1.submit()">Pfizer</a>          ← su laboratorio
 *
 * Sin esa distinción, cada producto encontrado sumaba a su laboratorio como si
 * fuera un segundo resultado: 16 coincidencias declaradas, 17 en pantalla.
 */
function anclas(html) {
  const mapa = new Map();
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const disparo = /document\.(\w+)\.submit/.exec(m[1]);
    if (!disparo) continue;
    // El primero gana: si un form tuviera dos anclas, la de arriba es la buena.
    if (mapa.has(disparo[1])) continue;
    mapa.set(disparo[1], {
      clase: /class=["']([^"']*)["']/i.exec(m[1])?.[1] || '',
      texto: texto(m[2]),
      index: m.index,
    });
  }
  return mapa;
}

/** El "N coincidencias" del encabezado. Sirve para saber si hubo recorte. */
function totalDeclarado(html) {
  const m = html.match(/<b>(\d+)<\/b>\s*coincidencias/i);
  return m ? Number(m[1]) : null;
}

/**
 * Lee una página de resultados. Devuelve items de dos clases:
 *   { tipo:'producto', nombre, laboratorio, slug, idL, patron }
 *   { tipo:'indice',   nombre, idD|idL, patron, mde }
 *
 * Cada resultado del sitio es un <form> seguido de su <a>. Se recorren los
 * forms en orden y se busca el ancla que los dispara (document.prN.submit()),
 * que es lo único que ata el nombre visible a sus parámetros.
 */
function parseResultados(html) {
  const items = [];
  const disparadas = anclas(html);
  const re = /<form\s+name=["'](\w+)["']\s+action=["']([^"']+)["'][^>]*>([\s\S]*?)<\/form>/gi;
  let m;

  while ((m = re.exec(html))) {
    const [, nombreForm, action, cuerpo] = m;
    const campos = ocultos(cuerpo);

    // Los forms del buscador y del menú también matchean; se descartan por
    // no tener el par de campos que sí tiene un resultado.
    if (!campos.patron) continue;

    // El ancla que dispara ESTE form. Sin esto no se sabe qué texto le toca.
    const ancla = disparadas.get(nombreForm);
    if (!ancla) continue;

    // `rlab` es el laboratorio impreso al lado de un producto, no un resultado
    // propio. Sin este filtro, buscar "ibupirac" devuelve también "Pfizer".
    if (!ancla.clase.split(' ').includes('rprod')) continue;

    const nombre = ancla.texto;
    if (!nombre) continue;

    if (/\.html$/i.test(action)) {
      // Un producto. El laboratorio va en el <a class="rlab"> que lo sigue.
      const cola = html.slice(ancla.index, ancla.index + 400);
      const lab = /<a class=["']rlab["'][^>]*>([\s\S]*?)<\/a>/i.exec(cola);
      items.push({
        tipo: 'producto',
        nombre,
        laboratorio: lab ? texto(lab[1]) : null,
        slug: action,
        idL: campos.idL || null,
        patron: campos.patron,
      });
    } else if (campos.mde === 'drg' || campos.mde === 'lab') {
      items.push({
        tipo: 'indice',
        mde: campos.mde,
        nombre,
        idD: campos.idD || null,
        idL: campos.idL || null,
        patron: campos.patron,
      });
    }
  }

  // El mismo producto puede aparecer repetido cuando el patrón pega por varios
  // lados; se deduplica por su destino real, no por nombre.
  const vistos = new Set();
  return items.filter((it) => {
    const clave = `${it.tipo}|${it.slug || it.mde}|${it.idD || it.idL || ''}|${it.nombre}`;
    if (vistos.has(clave)) return false;
    vistos.add(clave);
    return true;
  });
}

/**
 * La ficha de un producto: cabecera + presentaciones con precio y coberturas.
 */
function parseFicha(html) {
  const nombre = texto(/<span class=["']tproducto["'][^>]*>([\s\S]*?)<\/span>/i.exec(html)?.[1] || '');

  // La cabecera son dos filas: la del producto (nombre | laboratorio) y la
  // del contenido (droga | acción terapéutica).
  const filaLab = /<tr class=["']lproducto["'][^>]*>([\s\S]*?)<\/tr>/i.exec(html)?.[1] || '';
  const laboratorio = texto(/<td class=["']textor["'][^>]*>([\s\S]*?)<\/td>/i.exec(filaLab)?.[1] || '') || null;

  const filaSub = /<tr class=["']sproducto["'][^>]*>([\s\S]*?)<\/tr>/i.exec(html)?.[1] || '';
  const droga = texto(/<td class=["']textoe["'][^>]*>([\s\S]*?)<\/td>/i.exec(filaSub)?.[1] || '') || null;
  const accion = texto(/<td class=["']textor["'][^>]*>([\s\S]*?)<\/td>/i.exec(filaSub)?.[1] || '') || null;

  /* Presentaciones.
     Se parten por su CELDA contenedora (<td class="dproducto">) y no por la
     <table class="presentacion"> de adentro. La diferencia no es cosmética:
     una presentación con obra social lleva una <table class="coberturas">
     ANIDADA, y un regex no-greedy que busca "</table>" se cierra en la interna.
     Eso dejaba la ficha de IBUPIRAC sin la cobertura de IOMA — con el precio
     bien y las coberturas vacías, que es la clase de error que nadie nota.

     Cortando por dproducto, cada bloque termina justo donde arranca el
     siguiente, así que las coberturas caen siempre en la presentación que las
     tiene y el último bloque se queda con las suyas y nada más. */
  const presentaciones = [];

  for (const bloque of html.split(/<td class=["']dproducto["'][^>]*>/i).slice(1)) {
    const desc = /<td class=["']tddesc["'][^>]*>([\s\S]*?)<\/td>/i.exec(bloque);
    if (!desc) continue;

    const precioTxt = texto(/<td class=["']tdprecio["'][^>]*>([\s\S]*?)<\/td>/i.exec(bloque)?.[1] || '');
    const fechaTxt = texto(/<td class=["']tdfecha["'][^>]*>([\s\S]*?)<\/td>/i.exec(bloque)?.[1] || '');

    presentaciones.push({
      descripcion: texto(desc[1]),
      precio: precio(precioTxt),
      precioTexto: precioTxt || null,
      fecha: fecha(fechaTxt),
      coberturas: parseCoberturas(bloque),
    });
  }

  return { nombre, laboratorio, droga, accion, presentaciones };
}

/**
 * Las coberturas de obra social de una presentación.
 * Van de a pares de filas: nombre + tipo, y después los importes (OS lo que
 * cubre la obra social, AF lo que paga el afiliado).
 */
function parseCoberturas(bloque) {
  const tabla = /<table class=["']coberturas["'][^>]*>([\s\S]*?)<\/table>/i.exec(bloque)?.[1];
  if (!tabla) return [];

  const out = [];
  const filas = tabla.split(/<tr class=["']finobra["']/i);

  for (const f of filas) {
    const nombre = texto(/<td class=["']obrasn["'][^>]*>([\s\S]*?)<\/td>/i.exec(f)?.[1] || '');
    if (!nombre) continue;

    const detalle = texto(/<td class=["']obrasd["'][^>]*>([\s\S]*?)<\/td>/i.exec(f)?.[1] || '');
    const importes = texto(/<td class=["']importesi["'][^>]*>([\s\S]*?)<\/td>/i.exec(f)?.[1] || '');

    // "OS $973,29 AF $6.663,91"
    const os = /OS\s*\$?\s*([\d.,]+)/i.exec(importes);
    const af = /AF\s*\$?\s*([\d.,]+)/i.exec(importes);

    out.push({
      obra: nombre,
      detalle: detalle || null,
      cubre: os ? precio(os[1]) : null,
      paga: af ? precio(af[1]) : null,
    });
  }
  return out;
}

/* ══ API ═════════════════════════════════════════════════════════════════════ */

const MODOS = {
  producto: { src: 'prs', mde: 'pat' },
  droga: { src: 'drgs' },
  laboratorio: { src: 'labs' },
};

/**
 * Busca en uno de los tres índices.
 * Con modo 'producto' el resultado ya son productos; con 'droga' o
 * 'laboratorio' son entradas de índice que hay que expandir con productosDe().
 */
async function buscar({ modo = 'producto', patron } = {}) {
  const termino = String(patron || '').trim();
  if (termino.length < 2) throw new Error('Escribí al menos dos letras');

  const cfg = MODOS[modo];
  if (!cfg) throw new Error(`modo desconocido: ${modo}`);

  const html = await pedir('srv', { patron: termino, ...cfg });
  return {
    modo,
    patron: termino,
    total: totalDeclarado(html),
    items: parseResultados(html),
    consultadoEn: Date.now(),
  };
}

/** Todos los productos de una droga o de un laboratorio. */
async function productosDe({ mde, id, patron } = {}) {
  if (mde !== 'drg' && mde !== 'lab') throw new Error(`mde desconocido: ${mde}`);
  if (!id) throw new Error('falta el id');

  const campos = { src: 'prs', mde, patron: String(patron || '') };
  campos[mde === 'drg' ? 'idD' : 'idL'] = String(id);

  const html = await pedir('srv', campos);
  return {
    modo: mde === 'drg' ? 'droga' : 'laboratorio',
    patron: campos.patron,
    total: totalDeclarado(html),
    items: parseResultados(html).filter((i) => i.tipo === 'producto'),
    consultadoEn: Date.now(),
  };
}

/** La ficha completa de un producto, con precios y coberturas. */
async function ficha({ slug, idL, patron } = {}) {
  if (!slug || !patron) throw new Error('falta el producto');

  /* El slug viene del propio sitio, pero llega desde el renderer: si algo lo
     manipulara, un '../' apuntaría a otra ruta del dominio. Se acota a un
     nombre de archivo simple. */
  const limpio = String(slug).split('/').pop();
  if (!/^[\w.%+-]+\.html$/i.test(limpio)) throw new Error(`ruta inválida: ${slug}`);

  const html = await pedir(limpio, {
    src: 'pr',
    idL: String(idL || ''),
    patron: String(patron),
  });

  const datos = parseFicha(html);
  if (!datos.nombre) throw new Error('alfabeta.net no devolvió la ficha del producto');

  return { ...datos, slug: limpio, idL: idL || null, patron, consultadoEn: Date.now() };
}

module.exports = {
  buscar, productosDe, ficha,
  // Exportados para los tests: son la parte con lógica real y frágil.
  _internos: { texto, precio, fecha, desentidad, parseResultados, parseFicha, parseCoberturas },
};
