/* ═══════════════════════════════════════════════════════════════════════════
   Genera los dos íconos de la app:

     build/icon.png   512×512, del que electron-builder saca el .ico
                      multi-resolución de Windows (ventana, taskbar, instalador).
     build/tray.ico   el de la bandeja del sistema: 16, 20, 24 y 32 px (lo que
                      Windows pide a 100/125/150/200 % de escala) más 40, 48
                      y 64 por si algún menú lo muestra grande.

   ── Por qué el ícono NO es el mismo dibujo que la marca de la titlebar ──────
   La marca de la UI está dibujada para 16px: ahí cualquier detalle se
   convierte en barro, así que es una silueta pelada de torre y dos haces. El
   ícono de la app vive entre 24 y 256px, y a ese tamaño esa misma silueta se
   lee como una antena o una torre de alta tensión — le falta lo único que
   dice "faro", que es el techo.

   Así que esta es la versión con detalle de la MISMA marca: la torre y la
   base son las de siempre, más el remate del techo, la lámpara y los haces en
   abanico. Es lo que hace cualquier set de íconos serio: una versión por
   rango de tamaño, no un escalado.

   Y el trazo va más fino que el 1.5 del set base por la misma razón: escalar
   1.5 de una grilla de 16 hasta 512 da un trazo de 30px que cierra todos los
   huecos del dibujo.

   ── Y por qué el de la bandeja es OTRO archivo ──────────────────────────────
   La bandeja vive en 16px: ahí va la marca de la titlebar, que es la versión
   hecha para ese tamaño, sin fondo (un cuadrado oscuro sobre la barra de
   tareas oscura desaparece) y en ámbar, que se ve tanto sobre barra oscura
   como clara. Va en .ico y no en .png porque Windows elige la entrada según
   la escala del monitor: un solo PNG de 32 lo reescala él, y a 16 queda
   borroso. Electron carga el .ico con LoadImage al tamaño que pide la
   bandeja, así que cada escala recibe su dibujo rasterizado a medida.

       node tools/icono.cjs        (necesita Electron: usa su canvas)
   ═══════════════════════════════════════════════════════════════════════════ */

const { app, BrowserWindow, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

const RAIZ = path.join(__dirname, '..');
const LADO = 512;

/* Los tokens de la app, literales: esto corre fuera del renderer, así que no
   hay CSS del que leerlos. Si cambiás el acento con retint.mjs, actualizá el
   ÁMBAR de acá y volvé a correr esto. */
const FONDO = '#0c0a09';    // --ox-bg
const AMBAR = '#fbbf24';    // --ox-accent

const TORRE = 'M6.2 13.9 7 6.6h2l.8 7.3zM4.3 13.9h7.4M6.6 6.6V4.4h2.8v2.2M6.9 4.4 8 2.6l1.1 1.8';
const LAMPARA = 'M7.3 5.2h1.4';
const LUZ = 'M5.6 3.2 3.4 2.1M10.4 3.2l2.2-1.1M4.9 5.5 2.4 5.1M11.1 5.5l2.5-.4';

const GROSOR = 0.95;   // en unidades de la grilla de 16
const ESCALA = 0.68;   // cuánto del lienzo ocupa la grilla

/* La marca de la titlebar, tal cual está en index.html e icons.js (`faro`).
   Si cambia ahí, cambia acá: la bandeja tiene que ser el mismo dibujo. */
const MARCA_TORRE = 'M6.5 13.7 7.1 6.7h1.8l.6 7zM6.7 6.7V4.5h2.6v2.2M4.6 13.7h6.8';
const MARCA_LUZ = 'M5.2 3.4 3 2.3M10.8 3.4 13 2.3';
const TAMANOS_BANDEJA = [16, 20, 24, 32, 40, 48, 64];

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 640, height: 640, show: false });
  await win.loadURL(`data:text/html,<canvas id="c" width="${LADO}" height="${LADO}"></canvas>`);
  await new Promise((r) => setTimeout(r, 300));

  const dataURL = await win.webContents.executeJavaScript(`(() => {
    const S = ${LADO};
    const c = document.getElementById('c');
    const ctx = c.getContext('2d');

    /* Fondo con las esquinas de Windows 11. Quedan TRANSPARENTES, no blancas:
       sobre la barra de tareas un cuadrado sin redondear se ve pegado. */
    const r = S * 0.219;
    ctx.beginPath();
    ctx.moveTo(r, 0);
    ctx.arcTo(S, 0, S, S, r);
    ctx.arcTo(S, S, 0, S, r);
    ctx.arcTo(0, S, 0, 0, r);
    ctx.arcTo(0, 0, S, 0, r);
    ctx.closePath();
    ctx.fillStyle = ${JSON.stringify(FONDO)};
    ctx.fill();

    // Algo de luz detrás: el ícono es un faro.
    const halo = ctx.createRadialGradient(S / 2, S * 0.40, S * 0.015, S / 2, S * 0.40, S * 0.48);
    halo.addColorStop(0, 'rgba(251,191,36,.18)');
    halo.addColorStop(1, 'rgba(251,191,36,0)');
    ctx.fillStyle = halo;
    ctx.fill();

    const esc = (S / 16) * ${ESCALA};
    ctx.translate((S - 16 * esc) / 2, (S - 16 * esc) / 2);
    ctx.scale(esc, esc);
    ctx.lineWidth = ${GROSOR};
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = ${JSON.stringify(AMBAR)};

    ctx.stroke(new Path2D(${JSON.stringify(TORRE)}));
    ctx.stroke(new Path2D(${JSON.stringify(LAMPARA)}));
    ctx.globalAlpha = 0.5;                       // la luz, más tenue que la torre
    ctx.stroke(new Path2D(${JSON.stringify(LUZ)}));

    return c.toDataURL('image/png');
  })()`);

  const dir = path.join(RAIZ, 'build');
  fs.mkdirSync(dir, { recursive: true });
  const destino = path.join(dir, 'icon.png');
  fs.writeFileSync(destino, Buffer.from(dataURL.split(',')[1], 'base64'));
  console.log(`  icono → ${destino} (${Math.round(fs.statSync(destino).size / 1024)} kB)`);

  /* ── La bandeja ──────────────────────────────────────────────────────────
     Cada tamaño se rasteriza aparte desde el vector, nunca escalando otro:
     a 16px un trazo de 1.5 son píxeles contados y el reescalado los embarra.
     El trazo es el del set base (1.5 sobre la grilla de 16) porque ESTE sí es
     el tamaño para el que la marca fue dibujada. La luz va más presente que
     en la titlebar (.34): a 16px, con .34 desaparece y queda solo la torre. */
  const pngs = await win.webContents.executeJavaScript(`(() => {
    const out = {};
    for (const size of ${JSON.stringify(TAMANOS_BANDEJA)}) {
      const c = document.createElement('canvas');
      c.width = c.height = size;
      const ctx = c.getContext('2d');
      ctx.scale(size / 16, size / 16);
      ctx.lineWidth = 1.5;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = ${JSON.stringify(AMBAR)};
      ctx.stroke(new Path2D(${JSON.stringify(MARCA_TORRE)}));
      ctx.globalAlpha = 0.6;
      ctx.stroke(new Path2D(${JSON.stringify(MARCA_LUZ)}));
      out[size] = c.toDataURL('image/png').split(',')[1];
    }
    return out;
  })()`);

  const ico = empaquetarIco(TAMANOS_BANDEJA.map((size) => ({ size, png: Buffer.from(pngs[size], 'base64') })));
  const destinoIco = path.join(dir, 'tray.ico');
  fs.writeFileSync(destinoIco, ico);

  // Que lo lea Electron con la misma llamada que va a usar la bandeja: si el
  // contenedor quedó mal armado, mejor enterarse acá que con un ícono vacío.
  const prueba = nativeImage.createFromPath(destinoIco);
  if (prueba.isEmpty()) throw new Error('tray.ico se escribió pero Electron no lo puede leer');
  console.log(`  bandeja → ${destinoIco} (${Math.round(fs.statSync(destinoIco).size / 1024)} kB, ${TAMANOS_BANDEJA.join('/')} px)`);

  app.exit(0);
}).catch((err) => {
  console.error(`  falló: ${err.message}`);
  app.exit(1);
});

/* Un .ico es un directorio de imágenes: cabecera de 6 bytes, una entrada de
   16 por imagen, y después las imágenes una atrás de otra. Cada imagen va
   como PNG entero (Windows lo acepta así desde Vista), que es lo que evita
   tener que escribir BMPs con máscara a mano. */
function empaquetarIco(imagenes) {
  const cabecera = Buffer.alloc(6);
  cabecera.writeUInt16LE(0, 0);                 // reservado
  cabecera.writeUInt16LE(1, 2);                 // 1 = ícono (2 sería cursor)
  cabecera.writeUInt16LE(imagenes.length, 4);

  const entradas = [];
  let offset = 6 + 16 * imagenes.length;
  for (const { size, png } of imagenes) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0);    // ancho (0 significa 256)
    e.writeUInt8(size >= 256 ? 0 : size, 1);    // alto
    e.writeUInt8(0, 2);                         // colores de paleta: ninguno
    e.writeUInt8(0, 3);                         // reservado
    e.writeUInt16LE(1, 4);                      // planos
    e.writeUInt16LE(32, 6);                     // bits por píxel
    e.writeUInt32LE(png.length, 8);             // tamaño de la imagen
    e.writeUInt32LE(offset, 12);                // dónde empieza
    entradas.push(e);
    offset += png.length;
  }
  return Buffer.concat([cabecera, ...entradas, ...imagenes.map((i) => i.png)]);
}
