'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   PHAROS — caché de consultas
   Guarda en disco lo que ya se le preguntó a alfabeta.net. Existe por dos
   razones, y la segunda importa más que la primera:

     1. Que volver a un producto que miraste hace un rato sea instantáneo.
     2. Que la app no le pida veinte veces lo mismo a un servidor ajeno.

   Cada consulta es un archivo JSON en `data/cache/`, nombrado por el hash de
   sus parámetros. Un archivo por entrada (y no un mapa gigante) significa que
   guardar una búsqueda no reescribe las otras, y que vaciar el caché es
   borrar una carpeta.

   Lo cacheado NUNCA se sirve en silencio como si fuera de ahora: cada
   respuesta dice de dónde salió y qué antigüedad tiene, y la UI lo muestra.
   Un precio viejo presentado como actual es peor que no tener el precio.
   ═══════════════════════════════════════════════════════════════════════════ */

const crypto = require('crypto');
const fsp = require('fs/promises');
const path = require('path');
const store = require('./store.cjs');

const DIR = path.join(store.ROOT, 'cache');

/** Por defecto, media jornada: los precios del Manual se mueven por día. */
const TTL_DEFECTO = 12 * 60 * 60 * 1000;

/** Clave estable para un conjunto de parámetros. Las claves del objeto se
    ordenan para que {a,b} y {b,a} den el mismo archivo. */
function clave(tipo, params) {
  const norm = JSON.stringify(params, Object.keys(params || {}).sort());
  return crypto.createHash('sha1').update(`${tipo}|${norm}`).digest('hex').slice(0, 32);
}

const archivo = (k) => path.join(DIR, `${k}.json`);

async function leer(k) {
  return store.readJSON(archivo(k), null);
}

async function escribir(k, datos) {
  await fsp.mkdir(DIR, { recursive: true });
  await store.writeJSON(archivo(k), { guardadoEn: Date.now(), datos });
}

/**
 * Corre `fn` salvo que haya una respuesta guardada y todavía fresca.
 *
 * @param {string}  tipo    familia de consulta ('buscar', 'ficha'…)
 * @param {object}  params  identifican la consulta
 * @param {number}  ttl     ms de vigencia; 0 fuerza ir a la red
 * @param {Function} fn     la consulta real
 * @returns {{datos:any, deCache:boolean, edad:number}}
 */
async function conCache(tipo, params, ttl, fn) {
  const k = clave(tipo, params);
  const vigencia = Number.isFinite(ttl) ? ttl : TTL_DEFECTO;

  if (vigencia > 0) {
    const hit = await leer(k);
    if (hit && Date.now() - hit.guardadoEn < vigencia) {
      return { datos: hit.datos, deCache: true, edad: Date.now() - hit.guardadoEn };
    }
  }

  const datos = await fn();

  /* Si el guardado falla (disco lleno, permisos), la consulta ya salió bien y
     el usuario tiene que ver su resultado igual. El caché es una optimización,
     no una condición para funcionar. */
  await escribir(k, datos).catch((err) => console.error('[cache] no se pudo guardar:', err.message));

  return { datos, deCache: false, edad: 0 };
}

/** Cuánto ocupa y cuántas entradas tiene. Para mostrarlo en Ajustes. */
async function estado() {
  try {
    const files = (await fsp.readdir(DIR)).filter((f) => f.endsWith('.json'));
    let bytes = 0;
    for (const f of files) {
      const st = await fsp.stat(path.join(DIR, f)).catch(() => null);
      if (st) bytes += st.size;
    }
    return { entradas: files.length, bytes, dir: DIR };
  } catch (err) {
    if (err.code === 'ENOENT') return { entradas: 0, bytes: 0, dir: DIR };
    throw err;
  }
}

/** Vacía el caché. Devuelve cuántas entradas borró. */
async function vaciar() {
  try {
    const files = (await fsp.readdir(DIR)).filter((f) => f.endsWith('.json'));
    for (const f of files) await fsp.unlink(path.join(DIR, f)).catch(() => {});
    return files.length;
  } catch (err) {
    if (err.code === 'ENOENT') return 0;
    throw err;
  }
}

module.exports = { conCache, estado, vaciar, clave, TTL_DEFECTO, DIR };
