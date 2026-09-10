# Onyx — referencia del sistema

La versión que se toca está adentro de la app, en **Piezas**. Esto es para
buscar mientras escribís.

Todo lleva el prefijo `ox-`. Los modificadores van con `--`, los elementos con
`__`, y los estados son clases `is-*` o atributos `data-state`.

---

## Tokens

Todos en [`renderer/css/tokens.css`](../renderer/css/tokens.css). Ningún
componente escribe un valor crudo.

### Superficies — escalera de elevación

| Token | Para qué |
|---|---|
| `--ox-sunken` | Hundido: campos, consola, lienzo |
| `--ox-bg` | Base de la ventana |
| `--ox-s1` | Rail, statusbar |
| `--ox-s2` | Card, panel, fila elevada |
| `--ox-s3` | Menú, modal, popover, tooltip |
| `--ox-s4` | Paleta de comandos, lo más alto |

La croma crece con la luminancia: un plano claro necesita más temperatura que
uno oscuro para no verse lavado.

### Texto — escalera de énfasis

`--ox-text` (primario, nunca blanco puro) · `--ox-text-2` (secundario) ·
`--ox-text-3` (muted: metadatos, labels) · `--ox-text-4` (faint: deshabilitado,
placeholder).

### Acento

`--ox-accent` y sus derivados: `--ox-wash-1` (hover sutil), `--ox-wash-2` (hover
fuerte / seleccionado), `--ox-wash-3` (activo / presionado), `--ox-ring` (focus),
`--ox-select` (`::selection`). Todos salen de `--ox-accent-rgb`: cambiar el
triplete los re-tinta a todos.

`--ox-accent-ink` es la tinta **sobre** el acento. Con un acento oscuro o muy
saturado hay que subirla.

### Rojo

`--ox-danger`, `--ox-danger-dim`, `--ox-danger-wash`, `--ox-danger-ring`.
Reservados al fallo. Si el rojo aparece decorando, deja de significar.

### Hairlines, elevación, radios

`--ox-line` / `-2` / `-3` para divisores finos — **siempre como
`box-shadow: inset 0 0 0 1px`**, porque un `border` real deja hilacha en las
esquinas redondeadas con `overflow:hidden`. `--ox-hairline` ya viene armado.

Sombras: `--ox-e1` a `--ox-e4`. Radios: `--ox-r-xs` (4) a `--ox-r-xl` (16), más
`--ox-r-pill`.

### Espaciado y tipografía

Escala de 4: `--ox-1` (4px) a `--ox-10` (72px). Tamaños: `--ox-fs-10` a
`--ox-fs-26`. Pesos: `--ox-w-regular` / `-medium` / `-semi`. Tracking:
`--ox-track-tight` para lo grande, `--ox-track-caps` para versalitas.

`--ox-font` es la sans (sale del sistema). `--ox-mono` es la monoespaciada y es
una **perilla**: apunta a un token `--ox-mono-*`, nunca directo a una familia.
Las empaquetadas viven en `renderer/fonts/` y se declaran en `fonts.css`.

```
node tools/retint.mjs --mono sistema     # roboto | sistema
```

Para sumar una: el `.woff2` en `renderer/fonts/`, su `@font-face` en
`fonts.css`, y su token en `tokens.css`. **Declará todos los pesos que uses** —
si falta el 500, el navegador engorda el 400 a mano y en una monoespaciada se
nota. Aparece sola en **Piezas**, que descubre los tokens leyendo las hojas de
estilo.

### Movimiento

| Token | Curva | Para |
|---|---|---|
| `--ox-ease` | expo-out | El default. Sale rápido, frena largo |
| `--ox-ease-soft` | cubic-out | Micro-hovers |
| `--ox-ease-both` | in-out | Lo que va y vuelve |
| `--ox-ease-in` | in | Salidas |

Duraciones: `--ox-t-1` (110ms, hover) · `--ox-t-2` (180ms, el default) ·
`--ox-t-3` (280ms, overlays) · `--ox-t-4` (420ms, vistas).

Transiciones ya compuestas: `--tr-color`, `--tr-move`, `--tr-fade`,
`--tr-surface`. **Nunca `transition: all`** — anima propiedades que no querías
y cuesta caro en repaints.

---

## Utilidades

`.ox-row` · `.ox-col` · `.ox-grow` · `.ox-spacer` · `.ox-truncate` · `.ox-path` ·
`.ox-scroll` (con esfumado) · `.ox-scroll-x` · `.ox-hr` · `.ox-vr`

**Recortar tiene dos formas.** `.ox-truncate` corta por la cola, que es lo que
corresponde a un nombre: el final es lo primero que deja de importar. Una
**ruta** es al revés — el principio lo comparten todas y el final es lo único
que la identifica — así que va con `.ox-path`, que recorta por el MEDIO. El
builder `path()` de `ui.js` arma el markup; el recorte lo decide el CSS, que
sabe cuánto entra:

```js
`<div class="ox-mono" data-tip="${esc(dir)}">${path(dir)}</div>`
// C:\Users\fulano\AppData\… → C:\Users\f…\Onyx\data
```

`.ox-truncate` lleva `display: block` a propósito: sobre un elemento **inline**
—un `<span>` suelto dentro de un div— `overflow` y `text-overflow` no aplican, y
sin eso la clase no hace nada y el texto se corta al aire. Donde el span ya es
ítem de un flex (menús, paleta) funcionaba igual, y por eso el agujero pasó
desapercibido tanto tiempo.

El esfumado de `.ox-scroll` va **solo donde el corte es al aire**. Si de ese lado
hay una línea — la statusbar, el pie de un panel, el hairline del propio bloque —
esa línea ya es el límite: el fade encima la ensucia, y además miente, porque el
contenido no se pierde en la nada sino que muere contra un borde.

```html
<div class="ox-scroll ox-scroll--line-bottom">…</div>
```

Modificadores: `--line-top` · `--line-bottom` (y `--line-left` · `--line-right`
en `.ox-scroll-x`). El shell ya los aplica donde corresponde, y con `:has()`, así
que si sacás la pieza que cerraba ese lado el fade vuelve solo: rail contra su
pie, inspector contra el suyo, vista contra la statusbar, paleta entre buscador y
pie, modal contra su pie. **El menú no esfuma nunca** — su hairline lo cierra por
los cuatro lados, y como máscara y borde viven en el mismo elemento, el fade le
comía el propio hairline. El tamaño lo da `--ox-fade`, y el contenedor lleva
padding ≥ ese valor para que en reposo la banda no coma el primer ni el último
ítem.

`.ox-title` · `.ox-subtitle` · `.ox-display` · `.ox-label` · `.ox-meta` ·
`.ox-eyebrow` (versalita espaciada) · `.ox-mono` · `.ox-num` (tabular) ·
`.ox-dim` · `.ox-dim2` · `.ox-danger`

`.ox-copyable` — marca contenido como seleccionable. Ante la duda, ponelo.

`.ox-icon` con `--sm` / `--lg` / `--xl` / `--fill`.

---

## Shell

```html
<div class="ox-app">
  <header class="ox-titlebar">
    <div class="ox-brand ox-no-drag">…</div>
    <div class="ox-titlebar__context" id="titlebar-context"></div>
    <div class="ox-wincontrols">
      <button class="ox-wincontrol">…</button>
      <button class="ox-wincontrol ox-wincontrol--close">…</button>
    </div>
  </header>
  <div class="ox-body">
    <nav class="ox-rail">
      <div class="ox-rail__top">…</div>
      <div class="ox-rail__nav ox-scroll">
        <div class="ox-rail__group">
          <div class="ox-rail__group-label">Sección</div>
          <button class="ox-navitem" data-view="x">… <span class="ox-navitem__count">3</span></button>
        </div>
      </div>
      <div class="ox-rail__foot">…</div>
    </nav>
    <main class="ox-main" id="view"></main>
  </div>
  <footer class="ox-statusbar">
    <div class="ox-statusbar__item"><span class="ox-statusbar__value">…</span></div>
  </footer>
</div>
<div id="ox-layer"></div>
```

La titlebar entera es zona de arrastre; lo que sea clickeable lleva
`.ox-no-drag`. `#ox-layer` es donde se portalean todos los overlays.

### Dentro de la vista

`head({ title, sub, crumbs, actions })` de `ui.js` arma el `.ox-viewhead`.

Hay dos layouts. El simple, que es el 90% de las vistas:

```html
<div class="ox-scroll ox-grow">…</div>
```

Y el de dos paneles:

```html
<div class="ox-viewbody">
  <div class="ox-viewbody__main">…</div>
  <aside class="ox-inspector">
    <div class="ox-inspector__head">…</div>
    <div class="ox-inspector__body ox-scroll">…</div>
    <div class="ox-inspector__foot">…</div>
  </aside>
</div>
```

**La sangría lateral la pone el shell, en los dos.** No le agregues padding
horizontal a tu contenedor: el contenido arranca en la misma columna que el
título de la vista, y el número sale de un solo lugar. Lo que va de borde a
borde —un lienzo, un mapa— lleva `.ox-bleed`.

`.ox-inspector.is-collapsed` lo cierra con transición. `.ox-viewbody__main` es
`position:relative` para anclar controles flotantes: si viven dentro del
contenedor que scrollea, se van de pantalla con el contenido.

---

## Controles

### Botones

`.ox-btn` + una variante: `--primary` (uno solo por pantalla) · `--secondary` ·
`--ghost` · `--danger` · `--danger-solid` (lo que no tiene vuelta atrás).
Tamaños `--sm` / `--lg`. `.ox-iconbtn` (+`--sm`) para los de solo ícono.

Agregá `.ox-flashable` para el velo de luz al presionar. Se cablea solo con
`initClickFlash()`.

### Campos

```html
<div class="ox-field">
  <label class="ox-field__label">Nombre</label>
  <input class="ox-input" spellcheck="false">
  <span class="ox-field__hint">Ayuda</span>
</div>
```

`.ox-input.is-invalid` + `.ox-field__hint--error` para el error.
`.ox-textarea`, `--mono` en ambos. `.ox-inputwrap` para meter un ícono adentro.

### Los que no son nativos

| Clase | Notas |
|---|---|
| `.ox-select` | Es un `<button>`. Abre un `Menu` propio, no un `<select>` |
| `.ox-stepper` | Envuelve un `<input type=number>` y le pone flechas propias. Cablealo con `bindStepper()` |
| `.ox-switch` | `.is-on` lo prende |
| `.ox-check` | `.is-on`; el tilde se dibuja con `stroke-dashoffset` |
| `.ox-slider` | `<input type=range>` estilado; seteale `--ox-pct` |
| `.ox-segmented` | La cápsula viaja. Cablealo con `bindSwitcher()` |
| `.ox-kbd` | Una tecla |

`bindSwitcher(el, onChange)` de `motion.js` sirve para `.ox-segmented` y
`.ox-tabs`: maneja el activo, hace viajar el indicador y reajusta al
redimensionar.

### Un botón nuevo declara SU padding

`base.css` pone `button { padding: 0 }`. No lo saques y no confíes en el padding
de fábrica: Chromium le da `1px 6px` a todo `<button>`, y con `box-sizing:
border-box` eso se come el interior de los controles chicos. En un `.ox-check`
de 15px dejaba una caja de contenido de 3px para un ícono de 11 — el ícono
desbordaba, y **un ítem de grid que desborda su área cae de `center` a
`start`**, así que el tilde salía 4px a la derecha y recortado contra el borde.
El `.ox-iconbtn` tenía lo mismo en chico (1,5px), invisible de a uno y presente
en toda la app.

El de humo lo vigila: recorre Piezas y falla si algún botón de solo ícono tiene
el SVG corrido más de medio píxel o desbordando.

---

## Superficies

`.ox-card` con `__head` / `__body` / `__foot`; `--interactive` le agrega hover.
`.ox-section` con `__head` / `__title`. `.ox-sunken` para lo hundido.

`.ox-list` + `.ox-listitem` con `__main` / `__title` / `__sub` / `__aside`.
Las acciones van en `.ox-rowactions` (aparecen con el hover).

`.ox-table` + `.ox-tr`; `.ox-td--num` alinea a la derecha con cifras tabulares,
`.ox-td--tight` achica el padding.

`.ox-kv` para pares clave/valor (`__k` / `__v`). El valor va en **una línea** y
lo que no entra se elipsa; el que tiene que envolver —un SMILES, un hash largo—
lo pide con `.ox-kv__v--wrap`. `.ox-stat` para una cifra grande (`__value` /
`__unit` / `__label`).

`.ox-chip` (+ `--mono` / `--outline` / `--danger`) · `.ox-avatar` (+ `--lg`) ·
`.ox-empty` (`__title` / `__text`) · `.ox-skeleton` · `.ox-iconcell`.

`.ox-meter` + `.ox-meter__fill`, con `--ox-pct`. `--danger` lo pinta rojo,
`--indeterminate` lo hace recorrer la pista.

`.ox-log` para consolas: `__line` (+`--error` / `--muted`), `__time`, `__src`,
`__msg`.

### Estado

```html
<span class="ox-mark ox-mark--square" data-state="running">
  <span class="ox-mark__halo"></span><span class="ox-mark__core"></span>
</span>
```

Usá los helpers de `ui.js`: `mark(state, shape)` y `status(state, {shape, label})`.

**Formas:** `circle` (el default) · `square`. Hubo un rombo y un hexágono y se
sacaron: la punta y la silueta de seis lados no pegan con el redondeo sutil del
resto. Una forma nueva tiene que salir de la misma familia, no de sumar aristas.
**Estados:** `idle` · `queued` · `running` · `waiting` · `done` · `skipped` ·
`failed`.

La forma dice **qué es** la cosa, la luminancia si **está viva**, y el
movimiento (el halo que respira) es exclusivo de `running`. Renombrá las
palabras con `setStateLabels({...})`; las claves conviene dejarlas.

---

## Overlays

Todos se portalean a `#ox-layer` y todos entran **y salen** animados.

```js
Tooltip.init();                         // una vez, al arrancar
Toast.show({ title, text, icon, tone, duration });
Toast.error(title, text);
Menu.show(anchorEl, items, { align: 'end' });
await Modal.show({ title, sub, body, actions, width, dismissible });
await Modal.confirm({ title, sub, confirmLabel, danger });
Palette.init(); Palette.register([...]); Palette.toggle();
```

**Tooltips**: declarativos. `data-tip="texto"`, opcionalmente `data-tip-side`
(`top`|`bottom`|`left`|`right`) y `data-tip-key` para el atajo. Nunca `title=`.

**Menu items**: `{ label, icon, key, danger, selected, disabled, onSelect }`,
más `{ sep: true }` y `{ groupLabel }`.

**Modal**: devuelve una promesa con el `value` del botón que se apretó (`null`
si se cerró). El `body` puede ser HTML o un `Node` — si es un nodo, podés leer
sus campos después de que cierre. Atrapa el foco y cierra con Escape.

**Palette**: comandos `{ id, label, group, icon, hint, run }`. Match por
subsecuencia: "rndg" encuentra "Research Digest". Re-registrá cuando cambien
los datos (`Palette.clear()` primero).

---

## Movimiento (JS)

```js
exit(el, { fallback: 300 })    // saca del DOM DESPUÉS de la animación de salida
raf2(fn)                       // dos frames: los estilos iniciales ya se aplicaron
stagger(container)             // escalona los hijos con --i
initClickFlash(root)
initScrollFades(root)          // cablea todo .ox-scroll
scrollFade(el)                 // uno solo
bindSwitcher(el, onChange)
bindStepper(el, onChange)      // las flechas de un .ox-stepper; repiten al aguantar
toggleReveal(el, open)         // alto con grid 0fr → 1fr, sin animar height
countTo(el, n, { format })     // un número que corre en vez de saltar
tick(el)                       // destella un valor que acaba de cambiar
```

`exit()` es el más importante y el que más se olvida: sin él, todo lo que se va
del DOM parpadea.

### Clases de animación

Entradas: `.ox-in-fade` · `.ox-in-rise` · `.ox-in-glide` · `.ox-in-pop`.
Estado: `.ox-spinning` · `.ox-breathing` · `.ox-shaking` · `.ox-skeleton` ·
`.ox-ticked`. `.ox-view` es la transición de vista (la aplica el router).
`.ox-reveal` con `.is-open` para el alto.

---

## Router

```js
Router.define({
  inicio: { view: viewInicio },
  item:   { view: viewItem, nav: 'inicio' },   // qué ítem del rail se ilumina
}, document.getElementById('view'));

Router.go('item', 'n-0003');
Router.refresh();                 // remonta la actual
Router.onLeave(store.onEvent(f)); // limpieza de la vista que se está montando
Router.onChange((a, desde) => {});
Router.current / .name / .param
```

`onLeave` es el que evita la fuga: las vistas que se suscriben a algo tienen que
soltarlo al navegar, o cada navegación deja basura escuchando y la app se
degrada sola.

---

## Helpers de vista

```js
paint(html)                        // innerHTML + monta íconos + cablea fades
head({ title, sub, crumbs, actions })
empty({ icon, title, text, actions })
esc(str)                           // TODO dato de afuera pasa por acá
mark(state, shape) / status(state, opts)
await attempt(fn, { errorTitle })  // el error se ve, no se traga
await copy(texto)

colorToken('--ox-bg')              // un token de color, resuelto a #rrggbb
aHex('oklch(.149 .0046 258)')      // cualquier color CSS, a #rrggbb
```

**Para pasarle un color a Electron, usá `colorToken()` y nunca un regex.** Desde
Chromium 144 el valor computado de una var en oklch se devuelve tal cual
(`"oklch(0.149 0.0046 258)"`), y sacarle los números con `.match(/\d+/g)` toma
el `0.149` del lightness como si fuera el canal verde: arma `#009500` y la app
arranca con medio segundo de pantalla **verde**. Es un hex válido, así que
ninguna validación de forma lo agarra. `colorToken()` pinta el color en un
canvas de 1×1 y lee el píxel, que funciona con cualquier notación presente y
futura. El caso completo está en
`C:\tools\electron-dev-docs\METODO-Flash-Verde-Arranque-Electron-Win11.md`.

Y de `format.js`: `fmtDur` · `fmtNum` · `fmtBytes` · `fmtMoney` · `fmtClock` ·
`fmtDate` · `relTime` · `monogram` · `plural` · `ellipsize`.

Todos escriben el decimal según `locale.tag` (por defecto `es-AR`, o sea coma).
**No uses `toFixed()` para nada que vaya a pantalla**: escribe siempre con punto
y deja la app diciendo "2.1 MB" al lado de "209,9 mm". Si necesitás un número
con decimales que no encaja en ninguna de estas funciones, sumale una a
`format.js` en vez de formatearlo a mano en la vista.

---

## Íconos

```js
Icons.svg('play')                       // string SVG
Icons.svg('play', 'ox-icon--sm')
Icons.spinner()
Icons.mount(root)                       // reemplaza <i data-icon="…">
Icons.add({ miIcono: '<path d="…"/>' }) // los de tu dominio
```

El set base tiene 72, todos sobre grilla de 16, trazo 1.5, puntas redondeadas —
por eso se ven de la misma familia. Miralos todos en **Piezas**; click en
cualquiera copia su etiqueta.

Dibujá los tuyos con la misma receta: `viewBox="0 0 16 16"`, contenido entre 1.8
y 14.2, sin `fill` salvo para puntos macizos (ahí va
`fill="currentColor" stroke="none"`).

**No edites `icons.js` para agregar los tuyos.** Usá `Icons.add()` — así podés
traerte una versión nueva del set base sin pisar tu trabajo.
