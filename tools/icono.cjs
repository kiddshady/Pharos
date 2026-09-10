/* ═══════════════════════════════════════════════════════════════════════════
   Genera build/icon.png (512×512), del que electron-builder saca el .ico
   multi-resolución de Windows.

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

       node tools/icono.cjs        (necesita Electron: usa su canvas)
   ═══════════════════════════════════════════════════════════════════════════ */

const { app, BrowserWindow } = require('electron');
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

  app.exit(0);
});
