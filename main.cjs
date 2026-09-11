'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   ONYX — proceso principal
   Acá pasa lo único de una app Electron que no se puede resolver con CSS: que
   la ventana aparezca SIN un solo frame blanco.

   ── El problema ────────────────────────────────────────────────────────────
   Hay dos destellos blancos distintos y se arreglan distinto:

   A) Flash de contenido (FOUC). Antes de que el renderer pinte, Chromium
      muestra el fondo por defecto de la ventana. Se mata con `show:false` +
      `backgroundColor` oscuro + `paintWhenInitiallyHidden` + el splash inline
      del index.html.

   B) Flash del compositor (DWM). Cuando el HWND pasa de oculto a visible,
      el compositor de Windows pinta su backdrop POR ENCIMA del swap chain de
      Chromium. Ningún CSS lo alcanza. No se puede evitar: se puede PROVOCAR
      donde nadie lo vea. Por eso la ventana nace en x:-20000, hace su primer
      show() ahí, y recién 200 ms después se mueve a su lugar.

   Si el destello se ve en vivo pero NO en una grabación de pantalla, es el B.

   ── Los números no son arbitrarios ─────────────────────────────────────────
   · -20000  → fuera de cualquier monitor, incluso en setups multi-pantalla.
   · 200 ms  → lo que tarda DWM en asentar la superficie off-screen. Con 120
               el flash vuelve de forma intermitente. Si ves un destello "a
               veces sí, a veces no", es este número, no otra cosa.
   · Electron ≥ 40 → desde la 40, el frame fantasma de minimizar→restaurar se
               pinta con el `backgroundColor` de la ventana. En la 33 y
               anteriores es blanco hardcodeado y no hay forma de taparlo.
   ═══════════════════════════════════════════════════════════════════════════ */

const { app, BrowserWindow, ipcMain, screen, shell, Tray, Menu, nativeImage } = require('electron');
const path = require('path');

/* ── Dónde viven los datos ───────────────────────────────────────────────────
   En desarrollo, `data/` al lado del código: se ve, se abre con un editor y se
   arregla a mano. Instalada, esa carpeta queda ADENTRO del asar —que es de
   solo lectura— y encima colgando de Program Files, donde una app de usuario
   no escribe. Ahí los datos van al userData del sistema.

   Esto tiene que correr ANTES del require de store.cjs: su ROOT se resuelve
   una sola vez, cuando el módulo se carga. Puesto después, la variable llega
   tarde y la app instalada intenta escribir adentro del paquete. */
if (app.isPackaged && !process.env.PHAROS_DATA) {
  process.env.PHAROS_DATA = path.join(app.getPath('userData'), 'data');
}

const ipc = require('./src/ipc.cjs');
const store = require('./src/store.cjs');
const updater = require('./src/updater.cjs');

/* Color base de arranque. Tiene que coincidir con --ox-bg de tokens.css.
   Como --ox-bg es oklch y Electron solo entiende hex, el renderer se lo vuelve
   a mandar ya resuelto apenas carga (win.setBackground en app.js): si cambiás
   el matiz o la temperatura, no hace falta tocar este valor a mano. Este hex
   solo cubre los primeros milisegundos, antes de que exista el renderer. */
const BG = '#0c0a09';

const DEFAULT_W = 1280;
const DEFAULT_H = 820;
const MIN_W = 900;
const MIN_H = 600;

/* El de la bandeja es un .ico con una entrada por escala de Windows (ver
   tools/icono.cjs). Si faltara, el ícono grande de la app escalado es feo
   pero se ve; una bandeja sin ícono es una app que no se puede encontrar. */
const TRAY_ICON = path.join(__dirname, 'build', 'tray.ico');
const APP_ICON = path.join(__dirname, 'build', 'icon.png');

/** @type {BrowserWindow | null} */
let win = null;

/* Con bandeja, cerrar la ventana la ESCONDE en vez de matar la app. Solo se
   sale de verdad cuando esta bandera está prendida: la prende el menú de la
   bandeja, el comando "Salir" de la paleta, o el propio Electron en
   `before-quit` (que es por donde pasa también el instalador de una
   actualización, así que quitAndInstall no se queda trabado en el close). */
let isQuitting = false;

/* ── Estado de la ventana ────────────────────────────────────────────────────
   Recordar tamaño y posición entre sesiones. La trampa: si el monitor donde
   estaba ya no existe, la posición guardada deja la ventana en la nada. Por
   eso se valida contra las pantallas actuales antes de usarla. */
const winState = store.doc('window', null);

function visibleOn(x, y, w, h) {
  return screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    // Con que se vea una esquina razonable alcanza para poder agarrarla.
    return x + w > a.x + 40 && x < a.x + a.width - 40
        && y + h > a.y && y < a.y + a.height - 40;
  });
}

function centered(w, h) {
  const a = screen.getPrimaryDisplay().workArea;
  return { x: Math.round(a.x + (a.width - w) / 2), y: Math.round(a.y + (a.height - h) / 2) };
}

async function loadWindowState() {
  const s = await winState.read().catch(() => null);
  const w = Math.max(MIN_W, Number(s?.width) || DEFAULT_W);
  const h = Math.max(MIN_H, Number(s?.height) || DEFAULT_H);
  const hasPos = Number.isFinite(s?.x) && Number.isFinite(s?.y) && visibleOn(s.x, s.y, w, h);
  return { width: w, height: h, maximized: !!s?.maximized, ...(hasPos ? { x: s.x, y: s.y } : centered(w, h)) };
}

let saveTimer = null;
function saveWindowState() {
  if (!win || win.isDestroyed()) return;
  clearTimeout(saveTimer);
  // Debounce: arrastrar una ventana emite decenas de eventos por segundo.
  saveTimer = setTimeout(() => {
    if (!win || win.isDestroyed()) return;
    const maximized = win.isMaximized();
    // Guardar el bounds NORMAL: si guardás el maximizado, al desmaximizar la
    // próxima vez la ventana queda del tamaño de la pantalla y sin poder volver.
    const b = win.getNormalBounds();
    winState.write({ x: b.x, y: b.y, width: b.width, height: b.height, maximized })
      .catch((err) => console.error('[window] no se pudo guardar el estado:', err.message));
  }, 400);
}

function createWindow(state) {
  win = new BrowserWindow({
    // Nace fuera de pantalla: el flash del compositor ocurre donde nadie lo ve.
    x: -20000,
    y: -20000,
    width: state.width,
    height: state.height,
    minWidth: MIN_W,
    minHeight: MIN_H,
    frame: false,
    show: false,
    paintWhenInitiallyHidden: true,
    backgroundColor: BG,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  /* Las actualizaciones necesitan la ventana para contarle al renderer en qué
     van. El chequeo automático espera a que la app esté arriba: al arrancar
     hay cosas más urgentes que hacer con la red, y un aviso de GitHub no puede
     llegar antes que la app. Solo busca; descargar e instalar los decide el
     usuario desde Ajustes. */
  updater.init(win);
  if (app.isPackaged) setTimeout(() => updater.buscar(), 5000);

  win.once('ready-to-show', () => {
    win.show();
    setTimeout(() => {
      if (!win || win.isDestroyed()) return;
      win.setPosition(state.x, state.y);
      if (state.maximized) win.maximize();
    }, 200);
  });

  // En dev, la consola del renderer sale por la terminal: si un módulo no carga
  // o una vista revienta, se ve acá sin tener que abrir devtools.
  if (process.argv.includes('--dev')) {
    win.webContents.on('console-message', (e) => {
      const level = ['debug', 'info', 'warn', 'error'][e.level] ?? e.level;
      console.log(`[renderer:${level}] ${e.message}`);
    });
    win.webContents.on('did-fail-load', (_e, code, desc, url) => {
      console.error(`[renderer] no cargó (${code} ${desc}) → ${url}`);
    });
  }

  const pushMaximized = () => {
    if (win && !win.isDestroyed()) win.webContents.send('win:maximized', win.isMaximized());
  };
  win.on('maximize', () => { pushMaximized(); saveWindowState(); });
  win.on('unmaximize', () => { pushMaximized(); saveWindowState(); });
  win.on('resize', saveWindowState);
  win.on('move', saveWindowState);

  // Nada de navegación fuera de la app; los links externos van al navegador.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  /* Cerrar NO cierra: esconde a la bandeja. La app sigue viva ahí, con el
     caché caliente y la vista donde quedó, y volver es instantáneo en vez de
     un arranque entero de Electron. Se destruye de verdad solo al salir. */
  win.on('close', (e) => {
    if (isQuitting) return;
    e.preventDefault();
    win.hide();
  });

  win.on('closed', () => { win = null; });
}

/* Trae la ventana al frente desde donde esté: escondida en la bandeja,
   minimizada o tapada por otra app. Es lo que hace el ícono de la bandeja,
   el acceso directo cuando la app ya corre, y el `activate` de macOS. Si no
   hay ventana (solo pasa si algo la destruyó de verdad), la vuelve a crear. */
async function showWindow() {
  if (!win || win.isDestroyed()) { createWindow(await loadWindowState()); return; }
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  win.focus();
}

/** Salir de verdad: la bandera primero, para que el close no lo frene. */
function quit() {
  isQuitting = true;
  app.quit();
}

/* ── Bandeja ─────────────────────────────────────────────────────────────────
   Pharos se consulta muchas veces al día y de a ratos. Cerrar la ventana la
   deja acá en vez de matar el proceso, así la siguiente consulta no paga un
   arranque entero. Salir es una decisión explícita: este menú o la paleta. */
let tray = null;

function createTray() {
  let img = nativeImage.createFromPath(TRAY_ICON);
  if (img.isEmpty()) {
    console.error('[tray] no se pudo leer build/tray.ico; va el ícono de la app (corré `npm run icono`)');
    img = nativeImage.createFromPath(APP_ICON);
  }
  tray = new Tray(img);
  tray.setToolTip('Pharos');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Abrir Pharos', click: () => showWindow() },
    { type: 'separator' },
    { label: 'Salir', click: () => quit() },
  ]));
  // Un click trae la ventana. No hay toggle a propósito: en Windows un doble
  // click llega como dos clicks, y con toggle la ventana se mostraría y
  // escondería en el mismo gesto. Mostrar dos veces no hace nada raro.
  tray.on('click', () => showWindow());
}

/* ── Controles de ventana ────────────────────────────────────────────────────
   La titlebar es nuestra (frame:false), así que minimizar/maximizar/cerrar
   los tiene que cablear la app. */
ipcMain.on('win:minimize', () => win && win.minimize());
ipcMain.on('win:toggle-maximize', () => {
  if (!win) return;
  win.isMaximized() ? win.unmaximize() : win.maximize();
});
ipcMain.on('win:close', () => win && win.close());
ipcMain.handle('win:is-maximized', () => (win ? win.isMaximized() : false));
// Cerrar esconde (ver arriba); esto es lo otro: salir de verdad, desde la paleta.
ipcMain.on('app:quit', () => quit());

// El renderer manda su --ox-bg ya resuelto a hex. Es lo que hace que el frame
// fantasma del restore siga camuflado aunque cambies el matiz en tokens.css.
ipcMain.on('win:set-bg', (_e, hex) => {
  if (win && !win.isDestroyed() && /^#[0-9a-f]{6}$/i.test(String(hex))) {
    win.setBackgroundColor(hex);
  }
});

/* ── Una sola instancia ──────────────────────────────────────────────────────
   Con la app viviendo en la bandeja, "abrir Pharos" casi siempre significa
   que YA está abierta: el acceso directo tiene que traer la ventana que hay,
   no levantar otro proceso con su propio ícono en la bandeja y su propia
   copia del caché escribiendo sobre los mismos archivos. El que pierde el
   lock se va antes de hacer nada; el que lo tiene recibe `second-instance`
   cada vez que alguien intenta abrir otra, y responde trayendo la ventana. */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());

  app.whenReady().then(async () => {
    ipc.register();
    createWindow(await loadWindowState());
    createTray();
  });

  /* Con bandeja, la app sigue viva aunque no haya ventana: cerrar la esconde.
     Este evento solo llegaría si algo la destruyera de verdad, y aun así la
     bandeja la puede volver a crear. Salir es siempre explícito. */
  app.on('window-all-closed', () => { /* residente en la bandeja */ });

  app.on('before-quit', () => { isQuitting = true; });

  app.on('activate', () => showWindow());
}
