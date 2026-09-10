'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   PHAROS — actualizaciones
   Mira los releases del repo en GitHub y, si hay una versión nueva, la ofrece.

   ── Dos decisiones que no son el default ───────────────────────────────────

   1. NO descarga sola. `autoDownload` viene en true, y eso significa bajar ~90
      MB apenas abrís la app, sin avisar y sin importar dónde estés parado.
      Acá se avisa y baja recién cuando lo pedís.

   2. NO instala al cerrar. `autoInstallOnAppQuit` también viene en true: la
      app se actualizaría sola la próxima vez que la cierres, y al volver a
      abrirla sería otra versión sin que nadie lo haya decidido. Con precios de
      por medio, que la herramienta cambie sin aviso no es aceptable.

   El resultado es que actualizar son tres pasos explícitos —buscar, descargar,
   instalar— y cada uno lo dispara el usuario desde Ajustes.

   ── El estado es uno solo ──────────────────────────────────────────────────
   Todo lo que la vista necesita saber viaja en un objeto: en qué fase está,
   qué versión hay del otro lado y cuánto lleva descargado. Se emite entero en
   cada cambio, así el renderer nunca tiene que reconstruirlo a partir de
   eventos sueltos ni adivinar en qué quedó si se pierde uno.
   ═══════════════════════════════════════════════════════════════════════════ */

const { app } = require('electron');

/* Fases: inactivo · buscando · al-dia · disponible · descargando · lista · error */
let estado = {
  fase: 'inactivo',
  versionActual: app.getVersion(),
  version: null,
  notas: null,
  progreso: 0,
  error: null,
  soportado: app.isPackaged,
};

let ventana = null;
let updater = null;

function emitir(patch) {
  estado = { ...estado, ...patch };
  if (ventana && !ventana.isDestroyed()) {
    ventana.webContents.send('update:estado', estado);
  }
}

/** electron-updater se carga tarde a propósito: en desarrollo no hace falta y
    su import tiene efectos (lee app-update.yml, arma el logger). */
function cargar() {
  if (updater) return updater;
  const { autoUpdater } = require('electron-updater');

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;

  /* Sin esto, cada búsqueda escupe su propio log a un archivo. Los errores que
     importan ya viajan en el estado y se ven en la app. */
  autoUpdater.logger = null;

  autoUpdater.on('checking-for-update', () => emitir({ fase: 'buscando', error: null }));

  autoUpdater.on('update-available', (info) => emitir({
    fase: 'disponible',
    version: info?.version || null,
    /* Las notas vienen como string o como lista de entradas. Se guardan pero
       NO se pintan: es HTML escrito en un release de GitHub, y meterlo en la
       vista sería inyectar markup de afuera en la interfaz. */
    notas: typeof info?.releaseNotes === 'string' ? info.releaseNotes : null,
    progreso: 0,
  }));

  autoUpdater.on('update-not-available', () => emitir({ fase: 'al-dia', version: null, progreso: 0 }));

  autoUpdater.on('download-progress', (p) => emitir({
    fase: 'descargando',
    progreso: Math.min(100, Math.max(0, Math.round(p?.percent || 0))),
  }));

  autoUpdater.on('update-downloaded', (info) => emitir({
    fase: 'lista',
    version: info?.version || estado.version,
    progreso: 100,
  }));

  autoUpdater.on('error', (err) => emitir({
    fase: 'error',
    // El mensaje crudo de electron-updater es de bajo nivel; se traduce.
    error: traducir(err),
    progreso: 0,
  }));

  updater = autoUpdater;
  return updater;
}

/** Los fallos que de verdad pasan, dichos en castellano. */
function traducir(err) {
  const m = String(err?.message || err || '');
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|net::/i.test(m)) return 'No hay conexión con GitHub';
  if (/404|Cannot find latest|No published versions/i.test(m)) return 'Todavía no hay ninguna versión publicada';
  if (/403|rate limit/i.test(m)) return 'GitHub está limitando las consultas; probá más tarde';
  if (/signature|signed/i.test(m)) return 'La firma del instalador no se pudo verificar';
  /* Sin app-update.yml no hay a dónde ir a buscar. Pasa si la app se corre
     desde una carpeta empaquetada a mano en vez de instalada. El mensaje
     crudo trae la ruta absoluta de quien compiló, que no le sirve a nadie. */
  if (/ENOENT.*app-update\.yml/i.test(m)) return 'Esta copia no está preparada para actualizarse: instalá la app desde el instalador';
  return m.split('\n')[0] || 'Falló la actualización';
}

function init(win) {
  ventana = win;
}

/** Devuelve el estado actual sin tocar nada. */
const actual = () => estado;

/**
 * Busca una versión nueva.
 * En desarrollo no hay nada que buscar: la app corre desde el código fuente y
 * no tiene con qué compararse. Se dice, en vez de fallar con un error raro.
 */
async function buscar() {
  if (!app.isPackaged) {
    emitir({ fase: 'al-dia', soportado: false, error: null });
    return estado;
  }
  try {
    await cargar().checkForUpdates();
  } catch (err) {
    emitir({ fase: 'error', error: traducir(err) });
  }
  return estado;
}

/** Baja el instalador. Solo tiene sentido con una versión ya detectada. */
async function descargar() {
  if (estado.fase !== 'disponible') return estado;
  try {
    emitir({ fase: 'descargando', progreso: 0 });
    await cargar().downloadUpdate();
  } catch (err) {
    emitir({ fase: 'error', error: traducir(err) });
  }
  return estado;
}

/** Cierra la app y lanza el instalador. Solo con la descarga terminada. */
function instalar() {
  if (estado.fase !== 'lista') return false;
  setImmediate(() => cargar().quitAndInstall(false, true));
  return true;
}

module.exports = { init, actual, buscar, descargar, instalar };
