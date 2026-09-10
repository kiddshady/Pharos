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
setTimeout(() => bail('timeout de 120s'), 120000);

app.whenReady().then(async () => {
  require(path.join(ROOT, 'src', 'ipc.cjs')).register();

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

  console.log('\n1. Arranque');
  ok('el splash se fue', !(await js(`!!document.getElementById('boot-splash')`)));
  ok('el shell está montado', await js(`!!document.querySelector('.ox-titlebar') && !!document.querySelector('.ox-rail')`));
  ok('los <i data-icon> se reemplazaron por SVG', !(await js(`!!document.querySelector('i[data-icon]')`)));
  ok('la vista inicial pintó algo', (await js(`document.getElementById('view').children.length`)) > 0);

  console.log('\n2. El buscador');
  ok('el campo arranca con el foco', await js(`document.activeElement && document.activeElement.id === 'campo'`));
  ok('están los tres índices',
    (await js(`document.querySelectorAll('#seg-modo .ox-segmented__opt').length`)) === 3);

  /* Cambiar de índice tiene que hacer DOS cosas: cambiar la pista del campo y
     quedar guardado. Probar solo que la cápsula se mueve dejaría pasar un
     cambio que no persiste, que es el bug que se nota al día siguiente. */
  await click('#seg-modo [data-value="droga"]');
  await sleep(600);
  ok('la pista del campo sigue al índice',
    (await js(`document.getElementById('campo').placeholder`)).includes('ibuprofeno'));
  ok('el índice elegido persiste en disco',
    (await js(`window.onyx.settings.get().then((s) => s.modo)`)) === 'droga');
  await click('#seg-modo [data-value="producto"]');
  await sleep(500);

  console.log('\n3. Todas las vistas montan');
  for (const v of ['favoritos', 'historial', 'ajustes', 'buscar']) {
    await click(`[data-view="${v}"]`);
    await sleep(700);
    const hijos = await js(`document.getElementById('view').children.length`);
    const activo = await js(`!!document.querySelector('[data-view="${v}"].is-active')`);
    ok(`${v}: pinta y queda activa en el rail`, hijos > 0 && activo, `hijos=${hijos} activo=${activo}`);
  }

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

    /* El descuento, medido sobre lo que se VE. Leer el estado interno no
       probaría nada: el bug que importa es que la tabla muestre un número que
       no es el que corresponde. */
    await click('[data-pct="20"]');
    await sleep(700);

    const columnas = await js(`document.querySelectorAll('.ox-table thead th').length`);
    ok('al aplicar el descuento aparecen las columnas de con-descuento y ahorro',
      columnas === 5, `columnas=${columnas}`);

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
    ok('el descuento queda guardado',
      (await js(`window.onyx.settings.get().then((s) => s.descuento.porcentaje)`)) === 20);

    // Y se puede apagar sin perder el número, que es el motivo de que exista el switch.
    await click('#sw-descuento');
    await sleep(600);
    const apagado = await js(`window.onyx.settings.get().then((s) => s.descuento)`);
    ok('apagarlo conserva el porcentaje',
      apagado && apagado.activo === false && apagado.porcentaje === 20, JSON.stringify(apagado));
    ok('y la tabla vuelve a tres columnas',
      (await js(`document.querySelectorAll('.ox-table thead th').length`)) === 3);

    // El favorito, por la UI: la estrella no puede abrir el producto de paso.
    await click('[data-view="buscar"]');
    await sleep(700);
    await click('.ox-listitem [data-fav]');
    await sleep(900);
    const favs = await js(`window.onyx.col('favoritos').list().then((l) => l.length)`);
    ok('la estrella guarda en favoritos', favs > 0, `favoritos=${favs}`);
    ok('y la estrella no navega al producto',
      (await js(`!!document.getElementById('campo')`)), 'se fue de la vista Buscar');
  }

  /* ── 4-bis. La paleta de comandos ──────────────────────────────────────────
     Pharos no usa el layout de dos paneles, así que acá no hay inspector que
     medir. Lo que sí hay que probar es la paleta, porque es el único camino a
     la vitrina —Piezas no está en el rail— y porque las secciones que siguen
     corren todas sobre ella. */
  console.log('\n4-bis. La paleta de comandos');
  await click('#btn-palette');
  await sleep(600);
  ok('la paleta abre', await js(`!!document.querySelector('.ox-palette')`));

  const caja = await js(`(() => { const p = document.querySelector('.ox-palette');
    if (!p) return null; const r = p.getBoundingClientRect();
    return { t: Math.round(r.top), l: Math.round(r.left), b: Math.round(r.bottom), rt: Math.round(r.right) }; })()`);
  ok('y cae dentro de la ventana',
    caja && caja.t >= 0 && caja.l >= 0 && caja.b <= H && caja.rt <= W, JSON.stringify(caja));

  await js(`(() => { const i = document.querySelector('.ox-palette__input');
    if (!i) return false; i.value = 'piezas';
    i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await sleep(500);
  ok('filtra por lo escrito',
    (await js(`document.querySelectorAll('.ox-palette__item').length`)) > 0);

  await click('.ox-palette__item');
  await sleep(1000);
  ok('y navega a donde se le pidió', await js(`!!document.getElementById('demo-stepper')`));

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

  await click('#btn-palette');
  await sleep(500);
  const pal = await js(`(() => { const p=document.querySelector('.ox-palette'); if(!p) return null;
    const r=p.getBoundingClientRect(); return {t:Math.round(r.top),cx:Math.round(r.left+r.width/2)}; })()`);
  ok('la paleta abre centrada y visible', pal && pal.t > 0 && Math.abs(pal.cx - W / 2) < 4, JSON.stringify(pal));

  /* Y el campo vacío no promete cosas de otra app. Estuvo diciendo «Buscar
     comandos, pipelines, agentes…» —vocabulario de aquella para la que se
     escribió esta paleta— y viajó con la plantilla hasta un editor de química,
     donde ofrecía dos features que no existen. Un texto que solo se lee con el
     campo en blanco es de los que nadie vuelve a mirar: que lo mire esto. */
  const ph = await js(`document.querySelector('.ox-palette__input')?.placeholder || ''`);
  ok('con una pista en el campo vacío', ph.length > 3, ph);
  ok('y sin vocabulario prestado de otra app', !/pipeline|agente/i.test(ph), ph);

  await click('.ox-scrim'); await sleep(400);

  await click('[data-view="piezas"]');
  await sleep(900);
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
  ok('el test no dejó huella en los datos',
    (await js(`window.onyx.col('favoritos').list().then((l) => l.length)`)) === previo.favoritos.length,
    `creados y borrados: ${creados.length}`);

  console.log(`\n═══ ${pass} ok · ${fail} fallas ═══`);
  console.log(errores.length ? `CONSOLA:\n  ${errores.join('\n  ')}` : 'CONSOLA: limpia');
  app.exit(fail || errores.length ? 1 : 0);
});
