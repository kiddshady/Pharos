'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   PHAROS — puente IPC
   El renderer no tiene fs, ni require, ni red: `contextIsolation` está activo.
   Todo lo que necesite del sistema pasa por acá, y acá se decide qué se puede
   pedir. Es la superficie de ataque de la app: todo lo que agregues es una
   puerta más.

   Convención: cada handler devuelve {ok:true, data} o {ok:false, error}. El
   preload la desenvuelve y convierte el error en una excepción real, así el
   renderer escribe try/catch normal en vez de chequear banderas.
   ═══════════════════════════════════════════════════════════════════════════ */

const { ipcMain, app } = require('electron');
const store = require('./store.cjs');
const alfabeta = require('./alfabeta.cjs');
const cache = require('./cache.cjs');

/* Las colecciones que el renderer puede tocar. Es una lista blanca a
   propósito: sin ella, cualquier bug en el renderer puede crear carpetas
   sueltas en tu directorio de datos. Agregá las tuyas acá. */
const COLLECTIONS = ['favoritos'];

function coll(name) {
  if (!COLLECTIONS.includes(name)) throw new Error(`colección no permitida: ${name}`);
  return store.collection(name);
}

/** Envuelve un handler para que un throw viaje como error y no como crash. */
function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (err) {
      console.error(`[ipc] ${channel}:`, err);
      return { ok: false, error: err?.message || String(err) };
    }
  });
}

/** El TTL vigente, en ms. Sale de los ajustes para que se pueda cambiar sin
    tocar código; `forzar` lo pone en cero y manda la consulta a la red sí o sí. */
async function ttl(forzar) {
  if (forzar) return 0;
  const s = await store.loadSettings();
  const horas = Number(s?.cacheHoras);
  return Number.isFinite(horas) && horas >= 0 ? horas * 3600000 : cache.TTL_DEFECTO;
}

function register() {
  handle('app:info', () => ({
    name: app.getName(),
    version: app.getVersion(),
    dataDir: store.ROOT,
    electron: process.versions.electron,
  }));

  handle('settings:get', () => store.loadSettings());
  handle('settings:save', (patch) => store.saveSettings(patch));

  handle('doc:read', (name, fallback = null) => store.doc(name, fallback).read());
  handle('doc:write', (name, data) => store.doc(name).write(data).then(() => true));

  handle('col:list', (name) => coll(name).list());
  handle('col:get', (name, id) => coll(name).get(id));
  handle('col:save', (name, item) => coll(name).save(item));
  handle('col:remove', (name, id) => coll(name).remove(id).then(() => true));
  handle('col:next-id', (name, prefix) => coll(name).nextId(prefix));

  /* ── alfabeta.net ──────────────────────────────────────────────────────────────
     Las tres consultas pasan por el caché. Cada respuesta viene envuelta en
     {datos, deCache, edad}: la vista necesita saber si lo que muestra salió
     de la red recién o de un archivo de hace horas. */

  handle('af:buscar', async ({ modo, patron, forzar } = {}) =>
    cache.conCache('buscar', { modo, patron }, await ttl(forzar),
      () => alfabeta.buscar({ modo, patron })));

  handle('af:productos', async ({ mde, id, patron, forzar } = {}) =>
    cache.conCache('productos', { mde, id }, await ttl(forzar),
      () => alfabeta.productosDe({ mde, id, patron })));

  handle('af:ficha', async ({ slug, idL, patron, forzar } = {}) =>
    cache.conCache('ficha', { slug, idL, patron }, await ttl(forzar),
      () => alfabeta.ficha({ slug, idL, patron })));

  handle('cache:estado', () => cache.estado());
  handle('cache:vaciar', () => cache.vaciar());
}

module.exports = { register, COLLECTIONS };
