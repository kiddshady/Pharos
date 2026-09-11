'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   ONYX — preload
   La única puerta entre el renderer y el sistema. Todo lo que NO esté acá, el
   renderer no lo puede hacer: no tiene require, ni fs, ni acceso al proceso
   principal. Esa es la idea.

   Regla: exponé funciones, nunca objetos de Electron. `ipcRenderer` en el
   window anula por completo el aislamiento de contexto.
   ═══════════════════════════════════════════════════════════════════════════ */

const { contextBridge, ipcRenderer } = require('electron');

/** Desenvuelve {ok,data|error} y convierte el error en una excepción real. */
const call = async (channel, ...args) => {
  const res = await ipcRenderer.invoke(channel, ...args);
  if (!res?.ok) throw new Error(res?.error || `Falló ${channel}`);
  return res.data;
};

contextBridge.exposeInMainWorld('onyx', {
  info: () => call('app:info'),
  /** Salir de verdad. `win.close` no sale: esconde la ventana en la bandeja. */
  quit: () => ipcRenderer.send('app:quit'),

  win: {
    minimize: () => ipcRenderer.send('win:minimize'),
    toggleMaximize: () => ipcRenderer.send('win:toggle-maximize'),
    /** Con bandeja, "cerrar" es esconder: la app sigue corriendo atrás. */
    close: () => ipcRenderer.send('win:close'),
    isMaximized: () => ipcRenderer.invoke('win:is-maximized'),
    /** El renderer le pasa a la ventana su color base ya resuelto (ver app.js). */
    setBackground: (hex) => ipcRenderer.send('win:set-bg', hex),
    onMaximized: (cb) => {
      const handler = (_e, value) => cb(value);
      ipcRenderer.on('win:maximized', handler);
      return () => ipcRenderer.off('win:maximized', handler);
    },
  },

  settings: {
    get: () => call('settings:get'),
    save: (patch) => call('settings:save', patch),
  },

  /** Documento suelto: un borrador, un caché, el último estado de la UI. */
  doc: {
    read: (name, fallback = null) => call('doc:read', name, fallback),
    write: (name, data) => call('doc:write', name, data),
  },

  /** Colección: una carpeta con un archivo por ítem. */
  col: (name) => ({
    list: () => call('col:list', name),
    get: (id) => call('col:get', name, id),
    save: (item) => call('col:save', name, item),
    remove: (id) => call('col:remove', name, id),
    nextId: (prefix) => call('col:next-id', name, prefix),
  }),

  /* ── alfabeta.net ────────────────────────────────────────────────────────
     El renderer NO habla con internet: su CSP es `default-src 'self'` y no
     tiene fetch hacia afuera. Le pide a estas tres funciones y recibe datos
     ya parseados.

     Las tres devuelven {datos, deCache, edad} — nunca solo los datos. Que la
     vista sepa si un precio salió de la red o de un archivo de hace horas no
     es un detalle: mostrar un precio viejo como si fuera de ahora es el peor
     error que puede cometer esta app. */
  af: {
    /** Busca en un índice: 'producto' | 'droga' | 'laboratorio'. */
    buscar: (opts) => call('af:buscar', opts),
    /** Expande una droga ('drg') o un laboratorio ('lab') a sus productos. */
    productos: (opts) => call('af:productos', opts),
    /** La ficha de un producto, con presentaciones, precios y coberturas. */
    ficha: (opts) => call('af:ficha', opts),
  },

  cache: {
    estado: () => call('cache:estado'),
    vaciar: () => call('cache:vaciar'),
  },

  /* ── Actualizaciones ──────────────────────────────────────────────────────
     Buscar, descargar e instalar son tres pasos separados a propósito: bajar
     ~90 MB o reiniciar la app son cosas que decide el usuario, no la app.

     `on` entrega el estado completo en cada cambio (no un diff), así la vista
     se dibuja con lo último que llegó sin llevar cuenta de nada. Devuelve la
     función para desuscribirse: sin eso, cada vez que se monta Ajustes queda
     un listener más escuchando. */
  update: {
    estado: () => call('update:estado'),
    buscar: () => call('update:buscar'),
    descargar: () => call('update:descargar'),
    instalar: () => call('update:instalar'),
    on: (cb) => {
      const handler = (_e, estado) => cb(estado);
      ipcRenderer.on('update:estado', handler);
      return () => ipcRenderer.off('update:estado', handler);
    },
  },
});
