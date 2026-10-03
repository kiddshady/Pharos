/* ═══════════════════════════════════════════════════════════════════════════
   Humo del renderer: monta la app de verdad y la recorre.

   Se corre con `npm run smoke` (necesita Electron, por eso no está en el
   `npm test`, que es node pelado).

   Lo que busca es lo que un test de unidad NO ve: overlays que aterrizan fuera
   de pantalla, vistas que no montan, animaciones que se quedan quietas donde no
   se las ve, glifos unicode que se colaron. La regla que lo guía: **medí dónde
   CAE una cosa, no solo si existe**. El bug más caro de este sistema fue un
   modal que renderizaba en top:-281px — presente en el DOM, correcto en el
   HTML, e inalcanzable con el mouse.
   ═══════════════════════════════════════════════════════════════════════════ */

const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const W = 1440; const H = 900;

/* El backgroundColor que main.cjs le pone a la ventana. El renderer se lo
   vuelve a mandar ya resuelto desde los tokens, y los dos tienen que coincidir:
   si no, el que se ve mientras el contenido no cubre la ventana es el otro. */
const BG_MAIN = (fs.readFileSync(path.join(ROOT, 'main.cjs'), 'utf8')
  .match(/const BG = '(#[0-9a-f]{6})'/i)?.[1] || '').toLowerCase();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0; let fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FALLA ${n} ${x}`); } };
const bail = (w, e) => { console.log(`ABORTADO ${w}`, e?.stack || e || ''); app.exit(3); };
process.on('unhandledRejection', (e) => bail('rechazo', e));
process.on('uncaughtException', (e) => bail('excepción', e));
setTimeout(() => bail('timeout de 180s'), 180000);

app.whenReady().then(async () => {
  require(path.join(ROOT, 'src', 'ipc.cjs')).register();

  /* El carrito se siembra ANTES de arrancar la app, porque se lee una sola vez
     al iniciar: escribirlo después deja a la app con lo que tenía en memoria.
     Un ítem con PAMI inventado alcanza para probar la vista sin red, y lo que
     había se guarda para devolverlo al final. */
  const store = require(path.join(ROOT, 'src', 'store.cjs'));
  const previoCarrito = await store.doc('carrito', { items: [] }).read();
  const SEMBRADO = {
    id: 'smoke-pami', slug: 'smoke-pami.html', idL: '0', patron: 'SMOKE', nombre: 'SMOKE 500', laboratorio: 'Prueba',
    presentacion: 'comp.x 30', precio: 10000, pami: 3000, fecha: '2026-09-01', consultado: Date.now(),
    cantidad: 1, modo: 'particular', descuento: false, agregadoEn: Date.now(),
  };
  await store.doc('carrito').write({ items: [SEMBRADO] });

  const win = new BrowserWindow({
    x: -20000, y: -20000, width: W, height: H,
    frame: false, show: false, paintWhenInitiallyHidden: true, backgroundColor: '#000',
    webPreferences: { preload: path.join(ROOT, 'preload.cjs'), contextIsolation: true },
  });
  const errores = [];
  win.webContents.on('console-message', (e) => { if (e.level >= 2) errores.push(`${e.level}: ${e.message}`); });
  await win.loadFile(path.join(ROOT, 'renderer', 'index.html'));
  win.show();
  await sleep(2200);

  const js = (c) => win.webContents.executeJavaScript(c);
  // La foto viaja al renderer como literal JSON; estas la envuelven.
  const antesFavs = () => previo.favoritos;
  const antesSettings = () => previo.settings;
  const antesHist = () => previo.historial;
  // Clickear sin explotar si el selector no existe: un elemento faltante tiene
  // que reportarse como falla del test, no como excepción que aborta todo.
  const click = (sel) => js(`(() => { const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return false; el.click(); return true; })()`);
  // Un click real es pointerdown → pointerup → click, y varios overlays se
  // cierran en pointerdown. Con `el.click()` solo, el orden nunca se prueba.
  const tap = (sel) => js(`(() => { const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return false;
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true }));
    el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, composed: true }));
    el.click(); return true; })()`);
  // Una tecla de verdad, por el canal de entrada de la ventana. Misma razón por
  // la que `tap` existe al lado de `click`: un evento fabricado a mano prueba el
  // manejador, no el camino que recorre la tecla hasta llegar a él.
  const escape = () => win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });

  /* ── Una foto de los datos, antes de tocar nada ────────────────────────────
     Este test corre sobre la carpeta de datos REAL de la app, no sobre una de
     juguete: guarda un favorito, escribe en el historial y cambia ajustes. Si
     al terminar borrara "todo lo que hay", se llevaría puestos los favoritos
     de quien la esté usando.

     Por eso se anota qué había ANTES y al final se restaura exactamente eso,
     borrando únicamente lo que el test haya creado. */
  const previo = {
    settings: await js(`window.onyx.settings.get()`),
    historial: await js(`window.onyx.doc.read('historial', [])`),
    favoritos: await js(`window.onyx.col('favoritos').list().then((l) => l.map((f) => f.id))`),
  };

  /* La cápsula de un segmentado tiene que caer SOBRE su opción activa: se
     compara el centro del texto (un Range, no la celda) con el centro de la
     cápsula (el ::before). El bug que caza: en una celda de tabla las opciones
     no medían lo mismo y la cápsula, calculada como ancho/n, caía 10px corrida
     — el texto parecía descentrado. */
  const capsula = (sel) => js(`(() => {
    const seg = document.querySelector(${JSON.stringify(sel)});
    if (!seg) return null;
    const s = seg.getBoundingClientRect();
    const cs = getComputedStyle(seg, '::before');
    const x = new DOMMatrixReadOnly(cs.transform).m41 + parseFloat(cs.left);
    const centroCapsula = x + parseFloat(cs.width) / 2;
    const act = seg.querySelector('.ox-segmented__opt.is-active');
    const r = document.createRange(); r.selectNodeContents(act);
    const t = r.getBoundingClientRect();
    const centroTexto = (t.left + t.right) / 2 - s.left;
    const anchos = [...seg.querySelectorAll('.ox-segmented__opt')].map((o) => +o.getBoundingClientRect().width.toFixed(1));
    return { txt: act.textContent.trim(), desfase: +Math.abs(centroCapsula - centroTexto).toFixed(2), anchos };
  })()`);

  console.log('\n1. Arranque');
  ok('el splash se fue', !(await js(`!!document.getElementById('boot-splash')`)));
  ok('el shell está montado', await js(`!!document.querySelector('.ox-titlebar') && !!document.querySelector('.ox-rail')`));
  ok('los <i data-icon> se reemplazaron por SVG', !(await js(`!!document.querySelector('i[data-icon]')`)));
  ok('la vista inicial pintó algo', (await js(`document.getElementById('view').children.length`)) > 0);

  console.log('\n2. El buscador');
  ok('el campo arranca con el foco', await js(`document.activeElement && document.activeElement.id === 'campo'`));
  ok('están los tres índices',
    (await js(`document.querySelectorAll('#seg-modo .ox-segmented__opt').length`)) === 3);

  /* El buscador arranca SIEMPRE en droga: el índice no se guarda entre
     sesiones. Y cambiar de índice tiene que mover la cápsula y la pista del
     campo a la vez. */
  let cap = await capsula('#seg-modo');
  ok('arranca en "Droga", con la cápsula centrada', cap && cap.txt === 'Droga' && cap.desfase <= 1, JSON.stringify(cap));
  ok('y su pista habla de drogas',
    (await js(`document.getElementById('campo').placeholder`)).includes('droga'));
  await click('#seg-modo [data-value="producto"]');
  await sleep(600);
  ok('la pista del campo sigue al índice',
    (await js(`document.getElementById('campo').placeholder`)).includes('comercial'));
  cap = await capsula('#seg-modo');
  ok('la cápsula cae centrada sobre "Producto"', cap && cap.txt === 'Producto' && cap.desfase <= 1, JSON.stringify(cap));
  await click('#seg-modo [data-value="droga"]');
  await sleep(500);
  cap = await capsula('#seg-modo');
  ok('y vuelve centrada sobre "Droga"', cap && cap.txt === 'Droga' && cap.desfase <= 1, JSON.stringify(cap));

  console.log('\n3. Todas las vistas montan');
  for (const v of ['favoritos', 'historial', 'ajustes', 'buscar']) {
    await click(`[data-view="${v}"]`);
    await sleep(700);
    const hijos = await js(`document.getElementById('view').children.length`);
    const activo = await js(`!!document.querySelector('[data-view="${v}"].is-active')`);
    ok(`${v}: pinta y queda activa en el rail`, hijos > 0 && activo, `hijos=${hijos} activo=${activo}`);
  }

  console.log('\n3-bis. La sección de actualizaciones');
  await click('[data-view="ajustes"]');
  await sleep(800);
  ok('la caja de actualizaciones está', await js(`!!document.getElementById('caja-update')`));
  /* Contra la versión que la app REPORTA, no contra un literal: así el test
     no hay que tocarlo en cada release, y de paso prueba lo que importa —que
     lo que se muestra sea lo que la app cree ser. */
  const version = await js(`window.onyx.info().then((i) => i.version)`);
  ok('y muestra la versión que la app reporta',
    (await js(`document.getElementById('caja-update').textContent`)).includes(version),
    `version=${version}`);

  /* Corriendo desde el código fuente no hay contra qué compararse. Lo que se
     prueba acá es que la app lo DIGA, en vez de ofrecer un botón que no puede
     hacer nada o —peor— tirar un error de electron-updater sin traducir. */
  await click('[data-action="buscar-update"]');
  await sleep(1500);
  const upd = await js(`window.onyx.update.estado()`);
  ok('en desarrollo se declara no soportado, y sin error',
    upd && upd.soportado === false && !upd.error, JSON.stringify(upd));
  ok('y la caja lo explica en castellano',
    (await js(`document.getElementById('caja-update').textContent`)).includes('app instalada'));

  /* ── 3-ter. El carrito, con el ítem sembrado ───────────────────────────────
     Sin red: la fila sale del archivo. Se prueba lo que la ficha real no
     garantiza (que haya PAMI) y la geometría del segmentado adentro de la
     tabla, que es donde se rompía. */
  console.log('\n3-ter. El carrito, con el ítem sembrado');
  const num = (t) => Number(String(t).replace(/[^0-9,]/g, '').replace(',', '.'));
  await click('[data-view="carrito"]');
  await sleep(800);
  ok('la fila sembrada está', (await js(`document.querySelectorAll('tr[data-item="smoke-pami"]').length`)) === 1);
  ok('con su segmentado Particular/PAMI', await js(`!!document.querySelector('[data-modo="smoke-pami"]')`));
  cap = await capsula('[data-modo="smoke-pami"]');
  ok('las dos opciones miden lo mismo también en la tabla',
    cap && cap.anchos.length === 2 && Math.abs(cap.anchos[0] - cap.anchos[1]) <= 0.5, JSON.stringify(cap));
  ok('y la cápsula cae centrada sobre "Particular"', cap && cap.txt === 'Particular' && cap.desfase <= 1, JSON.stringify(cap));
  /* No alcanza con mirar dónde terminó: el bug reportado era justamente que
     llegaba al estado correcto, pero en un solo frame. Se toma la foto en el
     MISMO task del click, mientras cápsula, precios y totales siguen viajando. */
  const movimientoPami = await js(`(() => {
    const seg = document.querySelector('[data-modo="smoke-pami"]');
    const unit = document.querySelector('tr[data-item="smoke-pami"] [data-cell="unit"]');
    const total = document.getElementById('carrito-totales');
    seg.querySelector('[data-value="pami"]').click();
    return {
      capsula: seg.getAnimations({ subtree: true }).length,
      precio: unit.getAnimations().length,
      // Los totales cambian cifra por cifra: la que anima es la de adentro.
      totales: total.getAnimations({ subtree: true }).length,
    };
  })()`);
  ok('Particular → PAMI queda animándose, no cambia en un frame',
    movimientoPami.capsula > 0 && movimientoPami.precio > 0 && movimientoPami.totales > 0,
    JSON.stringify(movimientoPami));
  await sleep(600);
  cap = await capsula('[data-modo="smoke-pami"]');
  ok('al pasar a PAMI la cápsula cae centrada sobre "PAMI"', cap && cap.txt === 'PAMI' && cap.desfase <= 1, JSON.stringify(cap));
  const unitPami = await js(`document.querySelector('tr[data-item="smoke-pami"] [data-cell="unit"]').textContent.trim().split('lista')[0]`);
  ok('por PAMI cobra lo que paga el afiliado (3000)', Math.abs(num(unitPami) - 3000) < 0.02, unitPami);
  await click('[data-quitar="smoke-pami"]');
  await sleep(900);
  ok('quitar el sembrado deja el carrito vacío',
    (await js(`document.querySelectorAll('tr[data-item]').length`)) === 0 && (await js(`!!document.querySelector('.ox-empty')`)));

  // De vuelta a Buscar: lo que sigue necesita el campo de búsqueda.
  await click('[data-view="buscar"]');
  await sleep(700);

  /* ── 4. El flujo real, de punta a punta ────────────────────────────────────
     Buscar → abrir la ficha → aplicar un descuento y verificar la aritmética
     en la tabla pintada. Esto SÍ sale a internet, y por eso se saltea solo
     cuando no hay red: un smoke que falla en un tren no dice nada útil.

     Es una búsqueda y una ficha por corrida, y las dos quedan cacheadas. */
  console.log('\n4. El flujo real contra alfabeta.net');
  const sonda = await js(`window.onyx.af.buscar({ modo: 'producto', patron: 'ibupirac' })
    .then((r) => ({ n: r.datos.items.length })).catch((e) => ({ error: e.message }))`);

  if (sonda.error) {
    console.log(`  --   salteado (${sonda.error})`);
  } else {
    ok('la consulta trae productos', sonda.n > 0, JSON.stringify(sonda));

    // Ibupirac es una marca: el buscador arranca en droga, así que se cambia.
    await click('#seg-modo [data-value="producto"]');
    await sleep(400);
    await js(`(() => { document.getElementById('campo').value = 'ibupirac'; return true; })()`);
    await click('[data-action="buscar"]');
    await sleep(2600);
    const filas = await js(`document.querySelectorAll('.ox-listitem').length`);
    ok('la lista de resultados se pinta', filas > 0, `filas=${filas}`);

    await click('.ox-listitem');
    await sleep(3200);
    const presentaciones = await js(`document.querySelectorAll('.ox-table .ox-tr').length`);
    ok('la ficha abre con sus presentaciones', presentaciones > 0, `presentaciones=${presentaciones}`);
    ok('la titlebar muestra el producto abierto',
      (await js(`document.getElementById('titlebar-context').textContent.trim().length`)) > 0);

    /* Cambiar el descuento NO repinta la ficha: el stepper que uno tiene
       apretado sigue siendo el mismo nodo, el encabezado no se toca, y en la
       tabla cambian solo las cifras. Antes cada flecha rehacía la vista entera
       —pestañeaba completa y el control moría debajo del mouse—. Se espera a
       que la cifra de la tabla cambie (el save + la actualización), no una
       demora fija que dependa del disco. */
    await click('[data-pct="20"]');
    await sleep(500);
    const clickDescuento = await js(`(async () => {
      const st = document.getElementById('st-descuento');
      const cabeza = document.querySelector('#view > .ox-viewhead');
      const th = () => document.querySelector('[data-k="h-final"]')?.textContent || '';
      const antes = Number(st.querySelector('input').value);
      const thAntes = th();
      st.querySelector('[data-step="up"]').dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true, pointerId: 73, pointerType: 'mouse', button: 0, buttons: 1,
      }));
      for (let i = 0; i < 30 && th() === thAntes; i++) await new Promise((r) => setTimeout(r, 10));
      st.querySelector('[data-step="up"]').dispatchEvent(new PointerEvent('pointerup', {
        bubbles: true, pointerId: 73, pointerType: 'mouse', button: 0, buttons: 0,
      }));
      await new Promise((r) => setTimeout(r, 850));
      return {
        antes,
        despues: Number(document.querySelector('#st-descuento input').value),
        mismoStepper: document.getElementById('st-descuento') === st,
        mismaCabeza: document.querySelector('#view > .ox-viewhead') === cabeza,
        th: th(),
      };
    })()`);
    ok('el stepper sobrevive al cambio (la ficha no se repinta)',
      clickDescuento.mismoStepper && clickDescuento.mismaCabeza, JSON.stringify(clickDescuento));
    ok('un click corto en el descuento suma exactamente uno y se detiene',
      clickDescuento.despues === clickDescuento.antes + 1, JSON.stringify(clickDescuento));
    ok('y la tabla ya lo muestra', clickDescuento.th.includes(`${clickDescuento.antes + 1}%`),
      JSON.stringify(clickDescuento));

    /* Escribir el número a mano también cuenta. Antes solo lo aplicaban las
       flechas y los botones de porcentaje: escribir 25 y salir del campo no
       cambiaba nada. */
    const escrito = await js(`(async () => {
      const input = document.querySelector('#st-descuento input');
      input.value = '25';
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 400));
      return { th: document.querySelector('[data-k="h-final"]')?.textContent || '',
               guardado: (await window.onyx.settings.get()).descuento.porcentaje };
    })()`);
    ok('escribir el porcentaje a mano lo aplica', escrito.guardado === 25 && escrito.th.includes('25%'),
      JSON.stringify(escrito));

    /* El switch viaja: es el MISMO nodo antes y después, así su bolita se
       desliza en vez de nacer ya del otro lado. */
    const viaje = await js(`(async () => {
      const sw = document.getElementById('sw-descuento');
      sw.click();
      await new Promise((r) => setTimeout(r, 400));
      const mismo = document.getElementById('sw-descuento') === sw;
      const apagado = !sw.classList.contains('is-on');
      sw.click();
      await new Promise((r) => setTimeout(r, 400));
      return { mismo, apagado, prendido: sw.classList.contains('is-on') };
    })()`);
    ok('el switch del descuento es el mismo nodo ida y vuelta',
      viaje.mismo && viaje.apagado && viaje.prendido, JSON.stringify(viaje));

    /* El descuento, medido sobre lo que se VE. Leer el estado interno no
       probaría nada: el bug que importa es que la tabla muestre un número que
       no es el que corresponde. */
    /* De 25 a 20 cambia la cifra, no la frase: relevar «Mostrando precios con
       N % menos» entera la apagaba y la prendía en cada flecha del stepper. */
    const soloCifra = await js(`(async () => {
      const meta = document.getElementById('desc-meta');
      const b = [...meta.children].find((n) => n.tagName === 'B');
      let calco = false;
      const mo = new MutationObserver(() => { calco ||= !!meta.querySelector('.ox-relevo-calco'); });
      mo.observe(meta, { childList: true, subtree: true });
      document.querySelector('[data-pct="20"]').click();
      await new Promise((r) => setTimeout(r, 400));
      mo.disconnect();
      return { calco, mismaCifra: !!b && b.isConnected, dice: b?.textContent };
    })()`);
    ok('cambiar el porcentaje cambia solo la cifra de la frase, sin relevarla',
      !soloCifra.calco && soloCifra.mismaCifra && soloCifra.dice === '20%', JSON.stringify(soloCifra));
    await sleep(300);

    const columnas = await js(`document.querySelectorAll('.ox-table thead th').length`);
    // Presentación · Lista · Con % · Ahorro · Vigente · (carrito)
    ok('al aplicar el descuento aparecen las columnas de con-descuento y ahorro',
      columnas === 6, `columnas=${columnas}`);

    const calc = await js(`(() => {
      const tr = document.querySelector('.ox-table .ox-tr');
      if (!tr) return null;
      // "$3.806,53" y "−$761,31" → número. El punto es separador de miles acá.
      const num = (t) => Number(String(t).replace(/[^0-9,]/g, '').replace(',', '.'));
      const td = [...tr.querySelectorAll('td')];
      if (td.length < 4) return { error: 'faltan celdas', n: td.length };
      return { lista: num(td[1].textContent), conDesc: num(td[2].textContent), ahorro: num(td[3].textContent) };
    })()`);

    ok('el 20% está bien calculado',
      calc && !calc.error && Math.abs(calc.conDesc - calc.lista * 0.8) < 0.02, JSON.stringify(calc));
    ok('el ahorro cierra con la resta',
      calc && !calc.error && Math.abs(calc.ahorro - (calc.lista - calc.conDesc)) < 0.02, JSON.stringify(calc));

    /* ── Los títulos de las columnas caen sobre sus cifras ──────────────────
       Se mide el borde derecho del TEXTO con un Range, no el de la celda: el
       rect de la celda abarca la columna entera y daría el mismo número
       estuviera el texto donde estuviera — justo el defecto que se busca.

       El bug: `.ox-table th` trae text-align:left y su especificidad (0,1,1)
       le gana a `.ox-td--num` (0,1,0), así que el encabezado se quedaba a la
       izquierda mientras los números iban a la derecha. Con el descuento
       puesto son cuatro columnas numéricas y se lee todo corrido. */
    const desfase = await js(`(() => {
      const t = document.querySelector('.ox-table');
      const ths = [...t.querySelectorAll('thead th')];
      const tds = [...t.querySelector('tbody tr').querySelectorAll('td')];
      const derecha = (el) => {
        const r = document.createRange();
        r.selectNodeContents(el);
        return Math.round(r.getBoundingClientRect().right);
      };
      return ths.map((th, i) => (th.classList.contains('ox-td--num') && tds[i]
        ? { col: th.textContent.trim(), d: Math.abs(derecha(th) - derecha(tds[i])) }
        : null)).filter(Boolean);
    })()`);
    ok('los títulos numéricos caen sobre sus cifras',
      desfase.length >= 3 && desfase.every((c) => c.d <= 2), JSON.stringify(desfase));
    ok('el descuento queda guardado',
      (await js(`window.onyx.settings.get().then((s) => s.descuento.porcentaje)`)) === 20);

    /* Y se puede apagar sin perder el número, que es el motivo de que exista el
       switch. Se apaga muestreando cada cuadro, porque los dos bugs que hubo
       acá vivían a mitad del movimiento:
       - la frase vieja se esfumaba dentro de la caja de la nueva, más angosta,
         y se partía en dos renglones («Mostrando precios con / 40% menos»);
       - la tabla cambiaba de columnas con el relevo de los bloques chicos y
         pasaba entera a media luz: la nueva tiene que estar entera debajo desde
         el primer cuadro (fundido). */
    const apagando = await js(`(async () => {
      const meta = document.getElementById('desc-meta');
      const alto = meta.getBoundingClientRect().height;
      const tabla = document.getElementById('ficha-presentaciones');
      document.getElementById('sw-descuento').click();
      const r = { altoFrase: alto, calcoFrase: 0, tablaNueva: 1, vioCalcoTabla: false };
      const t0 = performance.now();
      while (performance.now() - t0 < 400) {
        await new Promise((ok) => requestAnimationFrame(ok));
        const cm = meta.querySelector('.ox-relevo-calco');
        if (cm) r.calcoFrase = Math.max(r.calcoFrase, cm.getBoundingClientRect().height, cm.scrollHeight);
        if (tabla.querySelector(':scope > .ox-relevo-calco')) r.vioCalcoTabla = true;
        for (const n of tabla.children) {
          if (!n.classList.contains('ox-relevo-calco')) r.tablaNueva = Math.min(r.tablaNueva, +getComputedStyle(n).opacity);
        }
      }
      return r;
    })()`);
    ok('al apagar, la frase que se va no se parte en dos renglones',
      apagando.calcoFrase > 0 && apagando.calcoFrase <= apagando.altoFrase + 1, JSON.stringify(apagando));
    ok('y la tabla nueva está entera debajo de la vieja (fundido, sin media luz)',
      apagando.vioCalcoTabla && apagando.tablaNueva === 1, JSON.stringify(apagando));
    await sleep(300);
    const apagado = await js(`window.onyx.settings.get().then((s) => s.descuento)`);
    ok('apagarlo conserva el porcentaje',
      apagado && apagado.activo === false && apagado.porcentaje === 20, JSON.stringify(apagado));
    ok('y la tabla vuelve a tres columnas (más la del carrito)',
      (await js(`document.querySelectorAll('.ox-table thead th').length`)) === 4);

    // El favorito, por la UI: la estrella no puede abrir el producto de paso.
    await click('[data-view="buscar"]');
    await sleep(700);
    await js(`(() => { window.__campo = document.getElementById('campo'); window.__lista = document.querySelector('#resultados-buscar .ox-list'); return true; })()`);
    await click('.ox-listitem [data-fav]');
    await sleep(900);
    const favs = await js(`window.onyx.col('favoritos').list().then((l) => l.length)`);
    ok('la estrella guarda en favoritos', favs > 0, `favoritos=${favs}`);
    ok('y la estrella no navega al producto',
      (await js(`!!document.getElementById('campo')`)), 'se fue de la vista Buscar');
    /* Y no repinta nada: antes cada estrella volvía a montar la vista entera, y
       el buscador nacía de nuevo (sin el foco ni lo que tenía el campo). */
    ok('ni rehace el buscador ni la lista: solo se rellena la estrella',
      await js(`document.getElementById('campo') === window.__campo
        && document.querySelector('#resultados-buscar .ox-list') === window.__lista
        && document.querySelector('.ox-listitem [data-fav]').classList.contains('is-fav')`));

    /* ── 4-ter. El carrito ──────────────────────────────────────────────────
       Agregar desde la ficha, y en el carrito decidir por fila: PAMI o
       particular, descuento sí o no, cantidad. Todo se mide sobre lo que se
       VE en la tabla, contra la foto que quedó en disco. */
    console.log('\n4-ter. El carrito, desde la ficha real');
    await click('.ox-listitem');
    await sleep(3200);
    ok('la ficha tiene el botón de carrito en cada presentación',
      (await js(`document.querySelectorAll('[data-carrito]').length`)) > 0);

    await click('[data-carrito="0"]');
    await sleep(900);
    let carro = await js(`window.onyx.doc.read('carrito', { items: [] })`);
    ok('agregar guarda un ítem con la foto de su precio',
      carro.items.length === 1 && carro.items[0].precio > 0 && carro.items[0].cantidad === 1
        && carro.items[0].consultado > 0, JSON.stringify(carro.items[0]));
    ok('el rail cuenta el ítem',
      (await js(`document.querySelector('[data-view="carrito"] .ox-navitem__count').textContent`)) === '1');
    ok('y el botón de la ficha queda marcado',
      await js(`document.querySelector('[data-carrito="0"]').classList.contains('is-active')`));

    await click('[data-carrito="0"]');
    await sleep(900);
    carro = await js(`window.onyx.doc.read('carrito', { items: [] })`);
    ok('agregar la misma presentación suma cantidad, no fila',
      carro.items.length === 1 && carro.items[0].cantidad === 2, JSON.stringify(carro.items.map((i) => i.cantidad)));
    const item = carro.items[0];

    await click('[data-view="carrito"]');
    await sleep(800);
    const leerFila = () => js(`(() => {
      const tr = document.querySelector('tr[data-item]');
      if (!tr) return null;
      return { unit: tr.querySelector('[data-cell="unit"]').textContent.trim().split('lista')[0],
               sub: tr.querySelector('[data-cell="sub"]').textContent,
               total: document.querySelector('#carrito-totales .ox-stat__value').textContent,
               cant: tr.querySelector('[data-cantidad] input').value };
    })()`);
    let fila = await leerFila();
    ok('el carrito pinta la fila con su cantidad', fila && fila.cant === '2', JSON.stringify(fila));
    ok('el unitario es el precio de lista (particular, sin descuento)',
      fila && Math.abs(num(fila.unit) - item.precio) < 0.02, `${fila && fila.unit} vs ${item.precio}`);
    ok('el subtotal es unitario × cantidad',
      fila && Math.abs(num(fila.sub) - item.precio * 2) < 0.02, JSON.stringify(fila));
    ok('y el total del carrito es ese subtotal',
      fila && Math.abs(num(fila.total) - num(fila.sub)) < 0.02, JSON.stringify(fila));

    // El descuento, por fila. El porcentaje vigente es el 20 que dejó la ficha.
    await click('[data-desc]');
    await sleep(500);
    fila = await leerFila();
    ok('el tilde aplica el 20% a esa fila',
      fila && Math.abs(num(fila.unit) - item.precio * 0.8) < 0.02, `${fila && fila.unit} vs ${item.precio * 0.8}`);
    ok('sin tocar el ajuste global (que sigue apagado)',
      (await js(`window.onyx.settings.get().then((s) => s.descuento.activo)`)) === false);

    if (item.pami != null) {
      await click('[data-modo] [data-value="pami"]');
      await sleep(500);
      fila = await leerFila();
      ok('por PAMI se cobra lo que paga el afiliado, con el 20%',
        fila && Math.abs(num(fila.unit) - item.pami * 0.8) < 0.02, `${fila && fila.unit} vs ${item.pami * 0.8}`);
    } else {
      ok('sin cobertura PAMI la fila lo dice en vez de ofrecer el segmentado',
        !(await js(`!!document.querySelector('[data-modo]')`)));
    }

    // La cantidad, con la flecha del stepper (pointerdown, no click).
    await tap('[data-cantidad] [data-step="up"]');
    await sleep(700);
    fila = await leerFila();
    ok('la flecha sube la cantidad a 3', fila && fila.cant === '3', JSON.stringify(fila));
    ok('y el subtotal la sigue sin repintar la tabla',
      fila && Math.abs(num(fila.sub) - num(fila.unit) * 3) < 0.05, JSON.stringify(fila));
    carro = await js(`window.onyx.doc.read('carrito', { items: [] })`);
    ok('todo lo decidido queda en disco',
      carro.items[0].cantidad === 3 && carro.items[0].descuento === true
        && (item.pami == null || carro.items[0].modo === 'pami'), JSON.stringify(carro.items[0]));
    ok('la statusbar muestra el total',
      (await js(`document.querySelector('#stat-carrito .ox-statusbar__value').textContent`)).includes('$'));

    await click('[data-quitar]');
    await sleep(900);
    ok('quitar deja el carrito vacío, con su estado vacío',
      (await js(`document.querySelectorAll('tr[data-item]').length`)) === 0
        && (await js(`!!document.querySelector('.ox-empty')`)));
  }

  /* ── 4-bis. La paleta de comandos ya no existe ─────────────────────────────
     La ausencia también es contrato: no tiene que quedar ni el botón ni el
     atajo global. Piezas sigue como vitrina interna y el smoke entra por el
     router para verificar los primitivos sin reintroducir una puerta de UI. */
  console.log('\n4-bis. Sin paleta de comandos');
  ok('la barra no ofrece una paleta de comandos',
    !(await js(`document.querySelector('#btn-palette')`)));
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'K', modifiers: ['control'] });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'K', modifiers: ['control'] });
  await sleep(300);
  ok('Ctrl+K tampoco abre una paleta de comandos',
    !(await js(`document.querySelector('.ox-palette')`)));

  await js(`import('./js/router.js').then(({ default: Router }) => Router.go('piezas'))`);
  await sleep(1000);
  ok('la vitrina interna sigue disponible para el smoke',
    await js(`!!document.getElementById('demo-stepper')`));

  console.log('\n5. Overlays: dónde caen, no solo si existen');
  await click('#demo-menu');
  await sleep(400);
  const menu = await js(`(() => { const m=document.querySelector('.ox-menu'); if(!m) return null;
    const r=m.getBoundingClientRect(); return {t:Math.round(r.top),l:Math.round(r.left),b:Math.round(r.bottom),rt:Math.round(r.right)}; })()`);
  ok('el menú abre dentro de la ventana',
    menu && menu.t >= 0 && menu.l >= 0 && menu.b <= H && menu.rt <= W, JSON.stringify(menu));

  /* ── El item peligroso se pinta entero, y en los tres estados ──────────────
     El ícono venía perdiendo por especificidad contra el resaltado: pasabas el
     mouse por Eliminar, el texto y el fondo se ponían rojos, y el tachito se
     quedaba gris —el ícono decía una cosa y el resto de la fila otra—. Con el
     resaltado del teclado se caía hasta el texto.

     Se mide comparando el ícono contra el color del PROPIO item, no contra un
     literal: lo que tiene que ser cierto es que digan lo mismo, sea cual sea el
     rojo del tema. Y aparte se exige que ese color SEA el token de peligro,
     porque «los dos grises» también empatan y no es lo que se quiere.

     Ojo con el cuándo: estas propiedades tienen transición declarada, así que
     leerlas apenas cambia el estado devuelve el valor de ARRANQUE y el chequeo
     da verde con el bug puesto. Cada lectura espera a que la transición
     termine; sin esa espera, esto no prueba nada. */
  const pintaDanger = async (estado) => {
    await sleep(500);
    return js(`(() => {
      const it = document.querySelector('.ox-menuitem--danger');
      if (!it) return null;
      const sonda = document.createElement('span');
      sonda.style.color = getComputedStyle(document.documentElement).getPropertyValue('--ox-danger');
      document.body.appendChild(sonda);
      const rojo = getComputedStyle(sonda).color;
      sonda.remove();
      return { estado: ${JSON.stringify(estado)}, rojo,
               texto: getComputedStyle(it).color,
               icono: getComputedStyle(it.querySelector('.ox-icon')).color };
    })()`);
  };
  const lejos = () => win.webContents.sendInputEvent({ type: 'mouseMove', x: 4, y: H - 4 });
  const donde = await js(`(() => { const it=document.querySelector('.ox-menuitem--danger'); if(!it) return null;
    const r=it.getBoundingClientRect(); return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}; })()`);
  lejos();
  const reposo = await pintaDanger('en reposo');
  await js(`document.querySelector('.ox-menuitem--danger').classList.add('is-active'); true`);
  const teclado = await pintaDanger('resaltado por teclado');
  await js(`document.querySelector('.ox-menuitem--danger').classList.remove('is-active'); true`);
  await sleep(400);
  win.webContents.sendInputEvent({ type: 'mouseMove', x: donde.x, y: donde.y });
  const mouse = await pintaDanger('con el mouse encima');
  lejos();
  for (const e of [reposo, teclado, mouse]) {
    ok(`Eliminar es de color peligro ${e?.estado}`, !!e && e.texto === e.rojo, JSON.stringify(e));
    ok(`y su tachito también ${e?.estado}`, !!e && e.icono === e.rojo, JSON.stringify(e));
  }
  await js(`document.body.click(); true`); await sleep(300);

  await click('#demo-modal');
  await sleep(600);
  const modal = await js(`(() => { const m=document.querySelector('.ox-modal'); if(!m) return null;
    const r=m.getBoundingClientRect(); return {cx:Math.round(r.left+r.width/2),cy:Math.round(r.top+r.height/2),t:Math.round(r.top)}; })()`);
  ok('el modal queda CENTRADO en la ventana',
    modal && Math.abs(modal.cx - W / 2) < 4 && Math.abs(modal.cy - H / 2) < 4 && modal.t > 0, JSON.stringify(modal));
  await click('[data-dismiss]'); await sleep(400);

  // El toggle del menú. Volver a tocar el botón que lo abrió TIENE que cerrarlo.
  // Si no, se ve como un rebote: el manejador de click-afuera deja pasar al
  // ancla, el handler del botón vuelve a llamar a show(), y cierra+reabre en el
  // mismo gesto. Por eso acá va `tap` y no `click`: reproduce el orden real.
  const abierto = () => js(`!!document.querySelector('.ox-menu')`);
  await tap('#demo-select');
  await sleep(400);
  ok('el select abre su menú', await abierto());
  await tap('#demo-select');
  await sleep(500);
  ok('volver a tocarlo lo CIERRA (no rebota)', !(await abierto()));
  ok('y el ancla suelta el estado abierto', !(await js(`!!document.querySelector('#demo-select.is-open')`)));

  await tap('#demo-select');
  await sleep(400);
  await js(`document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); true`);
  await sleep(500);
  ok('y un click afuera también lo cierra', !(await abierto()));

  /* ── 5-bis. Escape con un menú abierto encima de un modal ──────────────────
     Modal y Menu escuchan los dos el keydown en `document` y en CAPTURA. Para
     el mismo nodo y la misma fase gana el que se registró primero, y ese es
     siempre el modal, que abrió antes. Resultado: desplegar un select adentro
     de un diálogo y arrepentirse con Escape cerraba el DIÁLOGO ENTERO y se
     perdía todo lo tipeado, en vez de cerrar solo el menú.

     Es un bug de orden de registro: no se ve leyendo ninguno de los dos módulos
     por separado —cada manejador, solo, es correcto— y vuelve apenas alguien
     reordene los overlays. Por eso se prueba acá y no en unidad: hace falta que
     los dos estén vivos al mismo tiempo.

     El modal de la vitrina no trae un select adentro, así que el escenario se
     arma: se abre el modal y se dispara el menú del select que quedó atrás. Que
     ese botón esté tapado por el scrim da igual — lo que se prueba es el estado
     «menú abierto encima de un modal», no dónde se puede clickear. */
  console.log('\n5-bis. Escape se lleva el menú, no el diálogo de atrás');
  await click('#demo-modal');
  await sleep(600);
  await click('#demo-select');
  await sleep(400);
  const hayModal = () => js(`!!document.querySelector('.ox-modal')`);
  ok('con el diálogo abierto, el menú abre encima', (await abierto()) && (await hayModal()));

  escape();
  await sleep(600);
  ok('el primer Escape cierra SOLO el menú', !(await abierto()));
  ok('y el diálogo sigue en pie', await hayModal());

  escape();
  await sleep(600);
  ok('el segundo Escape sí cierra el diálogo', !(await hayModal()));

  /* ── 6. El medidor indeterminado ───────────────────────────────────────────
     Una pista vacía se lee como un componente roto, no como «esperando». Se
     muestrea el recorrido entero en vez de mirar un instante.

     SE MIDE LA RACHA, NO LAS MUESTRAS SUELTAS, y la diferencia importa. La
     barra recorre de -100% a 294% de su propio ancho, así que en el empalme del
     bucle queda un frame exactamente al filo de la pista: medido con
     requestAnimationFrame sobre dos ciclos completos —226 frames— el solape
     mínimo es 0.43 px, aparece UNA vez y no se repite nunca dos frames
     seguidos. Es el diseño, y está escrito así arriba de la animación.

     La versión anterior exigía «más de 1 px SIEMPRE», lo que convertía ese
     frame invisible en una falla y dejaba el resultado librado a dónde cayera
     el muestreo. Lo que de verdad hay que prohibir es que la pista quede vacía
     un RATO —lo único que un ojo alcanza a ver— y eso es una racha. */
  console.log('\n6. El medidor indeterminado nunca deja la pista vacía');
  const pista = await js(`(async () => {
    const m = document.querySelector('.ox-meter--indeterminate');
    const f = m && m.querySelector('.ox-meter__fill');
    if (!f) return { error: 'no existe' };
    const muestras = [];
    for (let i = 0; i < 40; i++) {
      const p = m.getBoundingClientRect(); const r = f.getBoundingClientRect();
      muestras.push(Math.min(r.right, p.right) - Math.max(r.left, p.left));
      await new Promise(res => setTimeout(res, 50));
    }
    let racha = 0; let peor = 0;
    for (const v of muestras) { if (v < 1) { racha++; peor = Math.max(peor, racha); } else racha = 0; }
    return { peor, min: Math.round(Math.min(...muestras) * 100) / 100, n: muestras.length };
  })()`);
  ok('la barra nunca falta dos muestras seguidas',
    pista && !pista.error && pista.peor <= 1, JSON.stringify(pista));

  console.log('\n6-bis. El campo numérico y sus flechas');
  /* Lo que se mide no es que el botón exista: es que el VALOR cambie, que el
     evento salga (los listeners de las apps escuchan al input, no al botón), y
     que el spinner de Chromium no esté asomando por debajo. */
  const paso = await js(`(async () => {
    const root = document.getElementById('demo-stepper');
    if (!root) return { error: 'no existe el stepper' };
    const input = root.querySelector('input[type="number"]');
    const arriba = root.querySelector('[data-step="up"]');
    const abajo = root.querySelector('[data-step="down"]');

    let cambios = 0;
    input.addEventListener('change', () => cambios++);

    const tocar = (b) => {
      const o = { bubbles: true, pointerId: 1, pointerType: 'mouse' };
      b.dispatchEvent(new PointerEvent('pointerdown', o));
      b.dispatchEvent(new PointerEvent('pointerup', o));
    };

    input.value = '1';
    input.dispatchEvent(new Event('input', { bubbles: true }));

    tocar(arriba);
    const trasSubir = input.value;
    tocar(abajo); tocar(abajo);
    const trasBajar = input.value;

    // Al mínimo (1) la flecha de abajo tiene que quedar apagada.
    const abajoApagado = abajo.disabled;

    // Y al máximo (12), la de arriba.
    for (let i = 0; i < 20; i++) tocar(arriba);
    const tope = input.value;
    const arribaApagado = arriba.disabled;

    const spinner = getComputedStyle(input, '::-webkit-inner-spin-button');
    return {
      trasSubir, trasBajar, tope, cambios, abajoApagado, arribaApagado,
      spinnerOculto: spinner.appearance === 'none' || spinner.display === 'none',
      apariencia: getComputedStyle(input).appearance,
    };
  })()`);
  ok('subir suma uno', paso.trasSubir === '2', JSON.stringify(paso));
  ok('bajar no pasa del mínimo', paso.trasBajar === '1', paso.trasBajar);
  ok('y ahí la flecha de abajo se apaga', paso.abajoApagado === true);
  ok('no pasa del máximo', paso.tope === '12', paso.tope);
  ok('y ahí se apaga la de arriba', paso.arribaApagado === true);
  /* 1→2, 2→1 (el segundo click no mueve nada), y 11 subidas hasta 12. */
  ok('cada paso real despacha change', paso.cambios === 13, `${paso.cambios}`);
  ok('el input no muestra el control nativo', paso.apariencia === 'textfield', paso.apariencia);

  console.log('\n7. La fuente empaquetada carga de verdad');
  /* Éste es el chequeo que evita el fracaso silencioso: con CSP estricta y
     protocolo file://, un @font-face con la ruta mal puesta no tira error —
     el navegador cae a la de respaldo y todo "se ve bien". Por eso no alcanza
     con preguntar por --ox-mono: hay que confirmar que la familia cargó Y que
     realmente cambia el ancho del texto. */
  const fuente = await js(`(async () => {
    await document.fonts.ready;
    const cargadas = [...document.fonts].filter(f => f.status === 'loaded').map(f => f.family + ':' + f.weight);
    const medir = (fam) => { const s = document.createElement('span');
      s.style.cssText = 'position:fixed;left:-9999px;font-size:64px;white-space:pre;font-family:' + fam;
      s.textContent = 'MMMiiilll0O1'; document.body.appendChild(s);
      const w = s.getBoundingClientRect().width; s.remove(); return Math.round(w); };
    return {
      cargadas,
      declarada: getComputedStyle(document.documentElement).getPropertyValue('--ox-mono').trim(),
      roboto: medir("'Roboto Mono'"), serif: medir('serif'),
      disponible: document.fonts.check('400 13px "Roboto Mono"'),
    };
  })()`);
  ok('el @font-face resolvió a archivos reales', fuente.cargadas.length > 0, JSON.stringify(fuente.cargadas));
  ok('Roboto Mono está disponible para pintar', fuente.disponible, JSON.stringify(fuente));
  ok('y NO está cayendo a la de respaldo', fuente.roboto !== fuente.serif, `roboto=${fuente.roboto} serif=${fuente.serif}`);
  // Ojo: getComputedStyle RESUELVE el var(), así que acá se ve la familia final
  // y no la indirección. Que --ox-mono apunte a un token se verifica sobre el
  // texto del CSS, en tokens.test.mjs.
  ok('la familia efectiva es la empaquetada', fuente.declarada.includes('Roboto Mono'), fuente.declarada);

  const monos = await js(`document.querySelectorAll('#knob-mono [data-mono]').length`);
  ok('la vitrina descubrió las monos declaradas', monos >= 2, `${monos}`);
  const antesMono = await js(`getComputedStyle(document.querySelector('#mono-sample')).fontFamily`);
  await click('#knob-mono [data-mono="sistema"]');
  await sleep(300);
  ok('cambiar la mono cambia lo que se pinta',
    (await js(`getComputedStyle(document.querySelector('#mono-sample')).fontFamily`)) !== antesMono);

  console.log('\n8. Las perillas re-tintan de verdad');
  const antes = await js(`getComputedStyle(document.body).backgroundColor`);
  await js(`(() => { const h=document.getElementById('knob-hue'); h.value=30; h.dispatchEvent(new Event('input')); return true; })()`);
  await sleep(300);
  ok('cambiar el matiz cambia el fondo', (await js(`getComputedStyle(document.body).backgroundColor`)) !== antes);
  await click('#knob-reset');
  await sleep(300);
  ok('el reset vuelve al original', (await js(`getComputedStyle(document.body).backgroundColor`)) === antes);

  /* El color que el renderer le manda a la ventana.
     Va acá y no en tokens.test.mjs porque ese test compara ARCHIVOS: verifica
     que el hex de main.cjs derive del token. Este mide lo que pasa en tiempo
     de ejecución, que es otra cosa y es donde estuvo el bug — el renderer
     pisaba el backgroundColor correcto con uno mal traducido. */
  console.log('\n8-bis. El color que va a la ventana');
  const colorVentana = await js(`(async () => {
    const { colorToken, aHex } = await import('./js/ui.js');
    const computado = (() => {
      const p = document.createElement('span');
      p.style.cssText = 'position:fixed;left:-9999px;color:var(--ox-bg)';
      document.body.appendChild(p);
      const c = getComputedStyle(p).color;
      p.remove();
      return c;
    })();
    return {
      computado,
      hex: colorToken('--ox-bg'),
      // El regex viejo, para dejar constancia de qué habría devuelto.
      conRegexViejo: (() => {
        const n = computado.match(/[0-9]+/g);
        return n ? '#' + n.slice(0, 3).map((x) => Number(x).toString(16).padStart(2, '0')).join('') : null;
      })(),
      // aHex tiene que dar lo mismo pase lo que pase por la notación.
      desdeRgb: aHex('rgb(10, 11, 13)'),
      desdeHex: aHex('#0a0b0d'),
    };
  })()`);
  ok('el token resuelve a un hex de 6 dígitos',
    /^#[0-9a-f]{6}$/i.test(colorVentana.hex || ''), JSON.stringify(colorVentana));
  ok('coincide con el backgroundColor de main.cjs',
    colorVentana.hex.toLowerCase() === BG_MAIN, `${colorVentana.hex} vs ${BG_MAIN}`);
  /* La red de seguridad de verdad: que el fondo NO sea un color saturado. El
     bug daba #009500 —un hex perfectamente válido— así que validar la FORMA no
     alcanza; hay que mirar el color. */
  ok('y no es un verde/magenta salido de parsear mal el oklch', (() => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(colorVentana.hex.slice(i, i + 2), 16));
    return Math.max(r, g, b) - Math.min(r, g, b) < 40;
  })(), `${colorVentana.hex} (el regex viejo daba ${colorVentana.conRegexViejo})`);
  ok('aHex normaliza cualquier notación',
    colorVentana.desdeRgb === '#0a0b0d' && colorVentana.desdeHex === '#0a0b0d',
    JSON.stringify(colorVentana));

  /* ── Botones de solo ícono ─────────────────────────────────────────────────
     Un botón que solo lleva un SVG tiene que tenerlo centrado. Suena obvio y no
     lo era: Chromium le da `padding: 1px 6px` a todo `<button>` y este reset no
     lo tocaba. En los controles chicos eso deja la caja de contenido más
     angosta que el ícono; el ícono desborda, y un ítem de grid que desborda su
     área cae de `center` a `start`. El tilde del `.ox-check` salía 4px a la
     derecha y recortado contra el borde; el `.ox-iconbtn`, 1,5px — invisible de
     a uno y repetido en la titlebar, el rail y cada fila.

     Corre sobre Piezas, que es donde están todos los primitivos juntos. */
  console.log('\n8-ter. Los botones de solo ícono centran su contenido');
  const descentrados = await js(`(() => {
    const malos = [];
    for (const b of document.querySelectorAll('button')) {
      // Solo ícono: un único hijo elemento, que es un svg, y sin texto.
      if (b.children.length !== 1 || b.textContent.trim()) continue;
      const hijo = b.firstElementChild;
      if (hijo.tagName.toLowerCase() !== 'svg') continue;
      const rb = b.getBoundingClientRect();
      const rh = hijo.getBoundingClientRect();
      if (!rb.width || !rh.width) continue;
      const d = ((rh.left + rh.right) / 2) - ((rb.left + rb.right) / 2);
      const desborda = rh.right > rb.right + 0.5 || rh.left < rb.left - 0.5;
      if (Math.abs(d) > 0.51 || desborda) {
        malos.push({ clase: b.className.slice(0, 34), corrimiento: +d.toFixed(2), desborda });
      }
    }
    return { malos, revisados: [...document.querySelectorAll('button')].length };
  })()`);
  ok('ninguno tiene el ícono corrido ni desbordado',
    descentrados.malos.length === 0, JSON.stringify(descentrados.malos));
  ok('y había botones que revisar', descentrados.revisados > 10, `${descentrados.revisados}`);

  /* ── La tarjeta sin encabezado ──────────────────────────────────────────────
     `.ox-card__body` llevaba `padding-top: 0` para no repetir el aire que el
     `__head` ya pone. Con head quedaba perfecto; SIN head el contenido se
     pegaba al borde de arriba — 0 px contra 16 abajo.

     Vivió tanto porque esta misma vitrina mostraba UNA tarjeta y con `padding`
     inline: el único lugar que existe para ver las piezas era el único donde la
     pieza rota no se veía. */
  console.log('\n8-quater. Las dos formas de la tarjeta');

  const tarjetas = await js(`(() => [...document.querySelectorAll('.ox-card__body')].map((b) => {
    const s = getComputedStyle(b);
    const head = b.previousElementSibling?.classList.contains('ox-card__head');
    const arriba = b.getBoundingClientRect().top - b.closest('.ox-card').getBoundingClientRect().top;
    return {
      head: !!head,
      top: parseFloat(s.paddingTop),
      bottom: parseFloat(s.paddingBottom),
      // Lo que de verdad separa al contenido del filo: el padding del cuerpo
      // MÁS lo que haya arriba de él.
      aire: +(arriba + parseFloat(s.paddingTop)).toFixed(1),
    };
  }))()`);

  const sinHead = tarjetas.filter((t) => !t.head);
  const conHead = tarjetas.filter((t) => t.head);

  ok('la vitrina muestra las dos formas', sinHead.length > 0 && conHead.length > 0,
    JSON.stringify(tarjetas));
  ok('sin encabezado, el cuerpo pone su propio aire arriba',
    sinHead.every((t) => t.top > 0 && t.top === t.bottom), JSON.stringify(sinHead));
  /* Y el arreglo NO puede romper el caso que ya estaba bien: con head, repetir
     el padding separaría el cuerpo de su propio título. */
  ok('con encabezado, el cuerpo NO lo repite', conHead.every((t) => t.top === 0),
    JSON.stringify(conHead));
  ok('pero el contenido igual queda separado del filo',
    tarjetas.every((t) => t.aire >= 12), JSON.stringify(tarjetas.map((t) => t.aire)));

  /* ── 8-octies. El encabezado de la tabla es del color de donde está ────────
     (Traído de Onyx.) El <th> es sticky y por eso opaco. Pintaba --ox-bg fijo,
     y dentro de una card quedaba una banda más oscura que sus propias filas.
     Ahora lee --ox-surface, que declara cada plano donde pinta su fondo. Se
     mide sobre la vista y en un clon dentro de una card armado acá. */
  console.log('\n8-octies. El encabezado de la tabla es del color de donde está');
  const fondos = await js(`(() => {
    const t = document.querySelector('.ox-table');
    if (!t) return { error: 'no hay tabla en la vitrina' };
    const bg = (el) => getComputedStyle(el).backgroundColor;
    const card = document.createElement('div');
    card.className = 'ox-card';
    card.appendChild(t.cloneNode(true));
    t.after(card);
    const out = {
      vista: { th: bg(t.querySelector('th')), plano: bg(document.querySelector('.ox-main')) },
      card: { th: bg(card.querySelector('th')), plano: bg(card) },
    };
    card.remove();
    return out;
  })()`);
  ok('sobre la vista, el th pinta el fondo de la vista',
    fondos.vista && fondos.vista.th === fondos.vista.plano, JSON.stringify(fondos));
  ok('dentro de una card, el th pinta la card',
    fondos.card && fondos.card.th === fondos.card.plano, JSON.stringify(fondos));

  /* ── 8-nonies. Un ícono dentro de un dato chico va en el renglón ───────────
     `.ox-meta` y `.ox-label` son texto en línea y todo svg es display:block:
     el ícono se iba solo a un renglón de arriba. Pasaba en «de la red»,
     «guardado hace…», «precios tomados…» y «Aplicar descuento». Se arman los
     dos casos y se mide que ícono y texto compartan renglón. */
  console.log('\n8-nonies. Un ícono dentro de un dato chico va en el renglón');
  const renglon = await js(`(async () => {
    const { Icons } = await import('./js/icons.js');
    const caja = document.createElement('div');
    caja.innerHTML = '<span class="ox-meta">' + Icons.svg('clock', 'ox-icon--sm') + ' guardado hace 2 h</span>'
      + '<div><span class="ox-label">' + Icons.svg('porcentaje', 'ox-icon--sm') + ' Aplicar descuento</span></div>';
    document.querySelector('.ox-main .ox-scroll').prepend(caja);
    const medir = (el) => {
      const i = el.querySelector('svg').getBoundingClientRect();
      const r = document.createRange(); r.selectNodeContents(el.lastChild);
      const t = r.getBoundingClientRect();
      return { dy: +Math.abs((i.top + i.bottom) / 2 - (t.top + t.bottom) / 2).toFixed(1), alto: Math.round(el.getBoundingClientRect().height) };
    };
    const out = { meta: medir(caja.querySelector('.ox-meta')), label: medir(caja.querySelector('.ox-label')) };
    caja.remove();
    return out;
  })()`);
  ok('en .ox-meta el ícono va al lado del texto', renglon.meta.dy <= 2 && renglon.meta.alto < 20, JSON.stringify(renglon));
  ok('y en .ox-label también', renglon.label.dy <= 2 && renglon.label.alto < 22, JSON.stringify(renglon));

  console.log('\n9. Las reglas de oro');
  const glifos = await js(`(() => {
    const malo = /[\\u2190-\\u21FF\\u2300-\\u23FF\\u25A0-\\u27BF\\u2B00-\\u2BFF\\uFE0F\\u{1F300}-\\u{1FAFF}]/u;
    const out = []; const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n; while ((n = w.nextNode())) if (malo.test(n.nodeValue)) out.push(n.nodeValue.trim().slice(0, 40));
    return out;
  })()`);
  ok('cero emojis y glifos unicode en la UI', glifos.length === 0, JSON.stringify(glifos));
  ok('cero title= nativo', (await js(`document.querySelectorAll('[title]').length`)) === 0);
  const reglas = await js(`(() => { const r = [...document.styleSheets].flatMap(ss => { try { return [...ss.cssRules] } catch { return [] } })
      .map(x => x.selectorText).filter(Boolean).join(' ');
    return { scrollbar: r.includes('::-webkit-scrollbar'), seleccion: r.includes('::selection'), focus: r.includes(':focus-visible') }; })()`);
  ok('scrollbar propia', reglas.scrollbar);
  ok('::selection propia', reglas.seleccion);
  ok('focus ring propio (:focus-visible)', reglas.focus);

  /* ── 9-bis. Ningún anillo de foco se corta ─────────────────────────────────
     (Traído de Onyx.) El anillo de base.css sale 3.5px por fuera del elemento.
     Si esos 3.5px caen afuera de algo que recorta (un .ox-scroll, el borde de
     la ventana) o encima del canto de una superficie (una card, el carril del
     segmentado), con Tab se ve cortado. Cada elemento se enfoca como con
     teclado y se mide su anillo real (solo las sombras duras: una difusa es
     elevación), así los que van hacia adentro cuentan cero. */
  console.log('\n9-bis. Ningún anillo de foco se corta');
  const AUDITAR_ANILLOS = `((scope) => {
  if (!document.getElementById('aud-notr')) document.head.insertAdjacentHTML('beforeend', '<style id="aud-notr">*,*::before{transition:none!important}</style>');
  const extent = (el) => {
    el.focus({ focusVisible: true, preventScroll: true });
    const s = getComputedStyle(el);
    let m = 0;
    for (const part of s.boxShadow.split(/,(?![^(]*\\))/)) {
      if (part.includes('inset') || part.trim() === 'none') continue;
      const nums = part.replace(/rgba?\\([^)]*\\)|oklch\\([^)]*\\)/g, '').match(/-?[\\d.]+px/g) || [];
      const [x = 0, y = 0, blur = 0, spread = 0] = nums.map(parseFloat);
      if (blur > 0) continue;
      m = Math.max(m, spread + Math.max(Math.abs(x), Math.abs(y)));
    }
    if (s.outlineStyle !== 'none' && !/rgba\\(0, 0, 0, 0\\)/.test(s.outlineColor)) m = Math.max(m, parseFloat(s.outlineWidth) + parseFloat(s.outlineOffset));
    el.blur();
    return m;
  };
  const SEL = 'a[href],button:not([disabled]):not([tabindex="-1"]),input:not([disabled]):not([type=hidden]),select,textarea,[tabindex]:not([tabindex="-1"]),[contenteditable="true"]';
  const name = (el) => {
    const id = el.id ? '#' + el.id : '';
    const cls = [...el.classList].slice(0, 2).map((c) => '.' + c).join('');
    const txt = (el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 24);
    return el.tagName.toLowerCase() + id + cls + (txt ? ' «' + txt + '»' : '');
  };
  const out = [];
  for (const el of scope.querySelectorAll(SEL)) {
    if (el.closest('[inert],[hidden],[aria-hidden="true"]')) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    const R = extent(el);
    if (R <= 0.5) continue;
    const boxes = [{ who: 'ventana', l: 0, t: 0, r: innerWidth, b: innerHeight }];
    for (let a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) {
      const s = getComputedStyle(a);
      if (s.overflowX !== 'visible' || s.overflowY !== 'visible' || s.clipPath !== 'none' || /paint|strict|content/.test(s.contain)) {
        const ar = a.getBoundingClientRect();
        const l = ar.left + a.clientLeft; const t = ar.top + a.clientTop;
        boxes.push({ who: name(a), l, t, r: l + a.clientWidth, b: t + a.clientHeight });
      }
    }
    const e = 0.5;
    for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
      const s = getComputedStyle(a);
      const surf = (s.backgroundColor !== 'rgba(0, 0, 0, 0)' || s.boxShadow !== 'none') && parseFloat(s.borderTopLeftRadius) > 0;
      if (!surf) continue;
      const ar = a.getBoundingClientRect();
      const g = [r.left - ar.left, r.top - ar.top, ar.right - r.right, ar.bottom - r.bottom];
      if (g.some((x) => x < -e)) continue;
      const det = g.map((x, i) => ['izq', 'arriba', 'der', 'abajo'][i] + ' ' + x.toFixed(1)).filter((_, i) => g[i] < R - e);
      if (det.length) { out.push(name(el) + '  roza ' + name(a) + '  [' + det.join(', ') + ']'); break; }
    }
    for (const bx of boxes) {
      const inside = r.left >= bx.l - e && r.top >= bx.t - e && r.right <= bx.r + e && r.bottom <= bx.b + e;
      if (!inside) break;
      const lados = [];
      if (r.left - R < bx.l - e) lados.push('izq ' + (r.left - bx.l).toFixed(1));
      if (r.top - R < bx.t - e) lados.push('arriba ' + (r.top - bx.t).toFixed(1));
      if (r.right + R > bx.r + e) lados.push('der ' + (bx.r - r.right).toFixed(1));
      if (r.bottom + R > bx.b + e) lados.push('abajo ' + (bx.b - r.bottom).toFixed(1));
      if (lados.length) { out.push(name(el) + '  ← ' + bx.who + '  [' + lados.join(', ') + ']'); break; }
    }
  }
  document.querySelectorAll('.ox-scroll, .ox-main, [class*="scroll"]').forEach((s) => { s.scrollTop = 0; s.scrollLeft = 0; });
  return out;
})(document)`;
  /* Sin foco en la ventana, :focus-visible no se aplica y todo anillo mide
     cero: la auditoría pasaría sin haber medido nada. Así pasó acá la primera
     vez que se trajo de Onyx (allá el foco venía de casualidad de otra prueba,
     que en Pharos no existe). Se pide explícito y se exige. */
  win.focus();
  win.webContents.focus();
  await sleep(150);
  ok('la ventana tiene el foco (si no, no hay anillos que medir)', await js('document.hasFocus()'));
  for (const v of ['buscar', 'favoritos', 'carrito', 'historial', 'ajustes', 'piezas']) {
    await click(`[data-view="${v}"]`);
    await sleep(700);
    const cortes = await js(AUDITAR_ANILLOS);
    ok(`${v}: ningún anillo de foco se corta ni roza un canto`, cortes.length === 0, '\n      ' + cortes.join('\n      '));
  }
  await js(`document.getElementById('aud-notr')?.remove()`);

  /* ── 10. El movimiento, medido ─────────────────────────────────────────────
     Cada arreglo de la auditoría de transiciones con su prueba: se muestrea
     CADA CUADRO en la página (rAF) y se mide lo que antes fallaba. Con
     cualquiera de los arreglos deshecho, su prueba falla:
     · navegar destapaba la pantalla (la vista vieja se iba de golpe y la nueva
       subía desde 0);
     · la mCaja de actualizaciones se apagaba entera a 18 % en cada fase, y el
       alto saltaba;
     · el porcentaje de la descarga parpadeaba en cada aviso;
     · el detalle del error aparecía de golpe;
     · los toasts de arriba caían de golpe cuando se iba uno;
     · el indicador del rail no viajaba;
     · la mPista del campo cambiaba en seco. */
  console.log('\n10. El movimiento, medido');
  await js(`(() => {
    window.__ef = (el) => { let o = 1; for (let n = el; n && n.nodeType === 1; n = n.parentElement) o *= +getComputedStyle(n).opacity; return o; };
    window.__curva = (ms, medir) => new Promise((ok) => {
      const filas = []; const t0 = performance.now();
      const loop = () => { const t = performance.now() - t0; filas.push(medir(t)); if (t < ms) requestAnimationFrame(loop); else ok(filas); };
      requestAnimationFrame(loop);
    });
    return 0;
  })()`);
  const mMinimo = (xs) => Math.min(...xs);

  /* El calco de relevo() mide la caja con decimales. La primera versión
     usaba clientWidth, que redondea: a una frase de 105,06 px le tocaban 105
     y se partía en dos renglones igual (salió en Finway). El letter-spacing
     asegura un ancho fraccionario. */
  const fraccion = await js(`(async () => {
    const { relevo } = await import('./js/motion.js');
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:40px;top:40px;width:420px;display:flex;z-index:50';
    host.innerHTML = '<div style="flex:1"></div><span class="ox-meta" style="letter-spacing:.0137px">Mostrando precios con <b>40%</b> menos</span>';
    document.body.append(host);
    const frase = host.lastElementChild;
    const alto = frase.getBoundingClientRect().height;
    relevo(frase, 'Mostrando precios de lista');
    const calco = frase.querySelector(':scope > .ox-relevo-calco');
    const r = { alto, calco: calco ? calco.scrollHeight : null };
    host.remove();
    return r;
  })()`);
  ok('el calco mide con decimales: una frase de ancho fraccionario no se parte',
    fraccion.calco != null && fraccion.calco <= fraccion.alto + 1, JSON.stringify(fraccion));

  // 10.1 Navegar: la pantalla tapada en todo momento, la nueva quieta.
  await click('[data-view="buscar"]');
  await sleep(700);
  const mNavCurva = js(`window.__curva(320, () => {
    const v = document.getElementById('view');
    const c = document.querySelector('.ox-main--saliente');
    const nuevo = +getComputedStyle(v).opacity;
    const viejo = c ? +getComputedStyle(c).opacity : 0;
    return { tapado: Math.round((viejo + (1 - viejo) * nuevo) * 100), quieta: getComputedStyle(v).transform === 'none',
             ind: (() => { const i = document.querySelector('.ph-rail-ind'); return i ? getComputedStyle(i).transform : ''; })() };
  })`);
  await click('[data-view="historial"]');
  const mNav = await mNavCurva;
  ok('al navegar la pantalla nunca queda destapada (≥ 97 %)', mMinimo(mNav.map((f) => f.tapado)) >= 97,
    mNav.map((f) => f.tapado).join(' '));
  ok('y la vista nueva no se corre', mNav.every((f) => f.quieta));
  await sleep(300);
  ok('y el calco de la vieja se va', !(await js(`!!document.querySelector('.ox-main--saliente')`)));
  ok('el rail tiene UN indicador', (await js(`document.querySelectorAll('.ph-rail-ind').length`)) === 1);
  ok('y viaja de un ítem al otro (pasa por posiciones intermedias)',
    new Set(mNav.map((f) => f.ind)).size >= 4, `${new Set(mNav.map((f) => f.ind)).size} posiciones`);

  // 10.2 La mPista del campo se apaga para cambiar de texto.
  await click('[data-view="buscar"]');
  await sleep(700);
  const mPistaCurva = js(`(() => {
    const c = document.getElementById('campo'); c.value = '';
    const alfa = (col) => { const cx = document.createElement('canvas').getContext('2d'); cx.fillStyle = col; cx.fillRect(0, 0, 1, 1); return cx.getImageData(0, 0, 1, 1).data[3]; };
    return window.__curva(400, () => ({ a: alfa(getComputedStyle(c, '::placeholder').color), txt: c.placeholder }));
  })()`);
  await click('#seg-modo [data-value="laboratorio"]');
  const mPista = await mPistaCurva;
  const mCambio = mPista.findIndex((f, i) => i && f.txt !== mPista[i - 1].txt);
  ok('la pista cambia de texto con el campo apagado, no en seco',
    mCambio > 0 && mPista[mCambio].a < 25 && mPista[mCambio - 1].a < 25, mPista.map((f) => f.a).join(' '));
  ok('y vuelve a prenderse', mPista[mPista.length - 1].a > 200);
  await click('#seg-modo [data-value="droga"]');

  // 10.3 La mCaja de actualizaciones: estructura fija, solo cambia lo que cambia.
  await click('[data-view="ajustes"]');
  await sleep(800);
  const mEnviar = (u) => win.webContents.send('update:estado', { versionActual: version, soportado: true, error: null, ...u });
  mEnviar({ fase: 'inactivo' });
  await sleep(400);
  await js(`window.__btn = document.querySelector('[data-update-accion] > [data-action="buscar-update"]'); 0`);
  const mCajaCurva = js(`window.__curva(900, () => {
    const c = document.getElementById('caja-update');
    const b = c.querySelector('[data-update-accion] > [data-action="buscar-update"]');
    return { titulo: window.__ef(c.querySelector('.ox-section__title')), alto: Math.round(c.querySelector('.ox-card').getBoundingClientRect().height),
             boton: b ? window.__ef(b) : 0, ocupado: !!b?.disabled && !!b.querySelector('.ph-ocupable.is-ocupado') };
  })`);
  mEnviar({ fase: 'buscando' });
  await sleep(350);
  mEnviar({ fase: 'al-dia' });
  const mCaja = await mCajaCurva;
  ok('buscar: el título y la versión no se apagan', mMinimo(mCaja.map((f) => f.titulo)) > 0.99,
    `mínimo ${mMinimo(mCaja.map((f) => f.titulo)).toFixed(2)}`);
  ok('el botón no se reemplaza ni se apaga: se pone a trabajar',
    mMinimo(mCaja.map((f) => f.boton)) > 0.99 && mCaja.some((f) => f.ocupado)
    && (await js(`document.querySelector('[data-update-accion] > [data-action="buscar-update"]') === window.__btn`)));
  ok('y vuelve a quedar libre', !mCaja[mCaja.length - 1].ocupado);
  ok('el alto de la caja no salta', new Set(mCaja.map((f) => f.alto)).size === 1, [...new Set(mCaja.map((f) => f.alto))].join(' '));

  mEnviar({ fase: 'disponible', version: '9.9.9' });
  await sleep(400);
  mEnviar({ fase: 'descargando', progreso: 0 });
  await sleep(400);
  const mPctCurva = js(`window.__curva(700, () => { const p = document.querySelector('[data-update-progreso]'); return p ? window.__ef(p) : 1; })`);
  for (let p = 5; p <= 60; p += 5) { mEnviar({ fase: 'descargando', progreso: p }); await sleep(55); }
  const mPct = await mPctCurva;
  ok('el porcentaje de la descarga cambia sin parpadear', mMinimo(mPct) > 0.99, `mínimo ${mMinimo(mPct).toFixed(2)}`);

  mEnviar({ fase: 'al-dia' });
  await sleep(500);
  const mErrCurva = js(`window.__curva(400, () => Math.round(document.querySelector('#caja-update .ox-card').getBoundingClientRect().height))`);
  mEnviar({ fase: 'error', error: 'Sin conexión' });
  const mErr = await mErrCurva;
  ok('el detalle del error se despliega (el alto pasa por el medio)',
    new Set(mErr).size >= 4 && mErr[mErr.length - 1] > mErr[0], [...new Set(mErr)].join(' '));
  win.webContents.send('update:estado', await js('window.onyx.update.estado()'));
  await sleep(400);

  // 10.4 Toasts: cuando se va el de abajo, los de arriba se deslizan.
  await js(`import('./js/router.js').then(({ default: Router }) => Router.go('piezas'))`);
  await sleep(800);
  await click('#demo-toast');
  await sleep(300);
  await click('#demo-toast');
  await sleep(500);
  const mToastCurva = js(`(() => {
    const arriba = document.querySelectorAll('.ox-toasts .ox-toast')[1];
    return window.__curva(500, () => Math.round(arriba.getBoundingClientRect().top));
  })()`);
  await js(`document.querySelector('.ox-toasts .ox-toast [data-close]').click()`);
  const mToast = await mToastCurva;
  const mSalto = Math.max(...mToast.slice(1).map((y, i) => Math.abs(y - mToast[i])));
  ok('cuando un toast se va, el de arriba se desliza (sin saltos de más de 24 px por cuadro)',
    mSalto <= 24 && mToast[mToast.length - 1] > mToast[0], `y: ${[...new Set(mToast)].join(' ')}`);
  await js(`document.querySelectorAll('.ox-toasts [data-close]').forEach((b) => b.click())`);
  await sleep(400);

  /* Devolver todo como estaba: los ajustes y el historial se restauran con la
     foto del principio, y de los favoritos se borran SOLO los que agregó el
     test. Nada de vaciar colecciones enteras. */
  const creados = await js(`window.onyx.col('favoritos').list()
    .then((l) => l.map((f) => f.id).filter((x) => !${JSON.stringify(antesFavs())}.includes(x)))`);
  for (const fid of creados) {
    await js(`window.onyx.col('favoritos').remove(${JSON.stringify(fid)})`);
  }
  await js(`window.onyx.settings.save(${JSON.stringify(antesSettings())})`);
  await js(`window.onyx.doc.write('historial', ${JSON.stringify(antesHist())})`);
  await store.doc('carrito').write(previoCarrito);
  ok('el test no dejó huella en los datos',
    (await js(`window.onyx.col('favoritos').list().then((l) => l.length)`)) === previo.favoritos.length,
    `creados y borrados: ${creados.length}`);

  console.log(`\n═══ ${pass} ok · ${fail} fallas ═══`);
  console.log(errores.length ? `CONSOLA:\n  ${errores.join('\n  ')}` : 'CONSOLA: limpia');
  app.exit(fail || errores.length ? 1 : 0);
});
