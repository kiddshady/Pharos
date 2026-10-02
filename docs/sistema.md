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
| `--ox-s4` | Lo más alto: lo que flota sobre todo |

La croma crece con la luminancia: un plano claro necesita más temperatura que
uno oscuro para no verse lavado.

**`--ox-surface` es «la superficie sobre la que estoy».** La declara cada plano
que aloja contenido —la base (`--ox-bg`), `.ox-card` (`--ox-s2`),
`.ox-inspector` (`--ox-s1`), `.ox-modal` (`--ox-s3`)— en el mismo renglón
donde pinta su fondo, y pinta con ella, así las dos no se pueden desencontrar. La
lee lo que necesita ser opaco del color de su entorno sin saber dónde cayó: hoy,
el encabezado sticky de `.ox-table`. Si armás un plano nuevo que pueda alojar
contenido, declarala.

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
ítem de un flex (menús) funcionaba igual, y por eso el agujero pasó
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
pie, inspector contra el suyo, vista contra la statusbar y contra un encabezado
con línea, modal contra su pie. **El menú no esfuma nunca** — su hairline lo cierra por
los cuatro lados, y como máscara y borde viven en el mismo elemento, el fade le
comía el propio hairline. El tamaño lo da `--ox-fade`, y el contenedor lleva
padding ≥ ese valor para que en reposo la banda no coma el primer ni el último
ítem.

`.ox-title` · `.ox-subtitle` · `.ox-display` · `.ox-label` · `.ox-meta` ·
`.ox-eyebrow` (versalita espaciada) · `.ox-mono` · `.ox-num` (tabular) ·
`.ox-dim` · `.ox-dim2` · `.ox-danger`

`.ox-copyable` — marca contenido como seleccionable. Ante la duda, ponelo.

`.ox-icon` con `--sm` / `--lg` / `--xl` / `--fill`.

**Un ícono adentro de `.ox-meta` o `.ox-label` va en el renglón.** Los dos son
texto en línea y todo `svg` es `display: block`, así que el ícono se iba solo a
un renglón de arriba: «de la red», «guardado hace…», «Aplicar descuento» salían
con el ícono flotando encima del texto. Con `:has(> .ox-icon)` pasan a
`inline-flex` solo los que llevan ícono. El de humo lo mide (8-nonies).

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

Los `.ox-wincontrol` se clickean en todo el alto de la titlebar (maximizada,
la esquina acierta la cruz), pero se ven como una pastilla de 28 px adentro:
hover, press y el anillo de foco no llegan al canto de la ventana, donde se
cortaban. Si la titlebar tiene otras piezas al lado, `--ox-wincontrol-nudge`
corre la pastilla en vertical para alinearla.

### El anillo de foco no se corta

El anillo de `base.css` sale **3.5px por fuera** del elemento. Todo lo que
pueda recibir foco necesita ese aire hasta cualquier cosa que recorte (un
`.ox-scroll`, el borde de la ventana) y hasta el canto de la superficie que lo
contiene. Donde no lo hay, el anillo va **hacia adentro**: así lo llevan el
`.ox-segmented__opt` (2px de carril) y la `.ox-tr` con tabindex (va de borde a
borde, muchas veces de una card). El rail deja `--ox-2` arriba del nav por lo
mismo. `npm run smoke` lo mide en cada vista (9-bis): si sumás una pieza que
pega su anillo contra un borde, falla ahí.

### Dentro de la vista

`head({ title, sub, crumbs, actions, linea })` de `ui.js` arma el
`.ox-viewhead`. Con `linea: true` el encabezado se cierra con su hairline en vez
de cortar al aire, y el shell le apaga solo el esfumado de arriba al scroll de
esa vista: la línea ya es el límite. Con inspector no hace falta pedirla: el
shell la pone solo.

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

**La cápsula del segmentado copia la geometría real de la opción activa**
(`--seg-x` / `--seg-w`, como el subrayado de los tabs), no `ancho / n`. Y el
control lleva `width: max-content` para que las opciones midan lo mismo
también adentro de una celda de tabla: el `1fr` reparte parejo solo con ancho
indefinido, y una celda `.ox-td--tight` le da un ancho definido igual a su
mínimo, sin espacio libre que repartir. Se descubrió en el carrito de Pharos:
"Particular" salía de 71px y "PAMI" de 50, y la cápsula caía 10px corrida de su
texto. El contrapeso es `max-width: 100%`: en un contenedor más angosto que la
suma de las opciones el control se acota y el `1fr` reparte lo que hay (las
columnas quedan desparejas solo cuando no entra otra cosa, y la cápsula —que
mide— las sigue). El de humo mide el centro del texto contra el centro de la
cápsula, en el flex del buscador y en la tabla.

### Un botón nuevo declara SU padding

`base.css` pone `button { padding: 0 }`. No lo saques y no confíes en el padding
de fábrica: Chromium le da `1px 6px` a todo `<button>`, y con `box-sizing:
border-box` eso se come el interior de los controles chicos. En un `.ox-check`
de 15px dejaba una caja de contenido de 3px para un ícono de 11 — el ícono
desbordaba, y **un ítem de grid que desborda su área cae de `center` a
`start`**, así que el tilde salía 4px a la derecha y recortado contra el borde.
El `.ox-iconbtn` tenía lo mismo en chico (1,5px), invisible de a uno y presente
en toda la app.

El mismo reset saca el borde: el UA le pone a todo `<button>` un `outset` de
2px que sobrevive aunque el componente declare fondo y hairline, y toda tarjeta
o tecla hecha con `<button>` salía biselada.

El de humo lo vigila: recorre Piezas y falla si algún botón de solo ícono tiene
el SVG corrido más de medio píxel o desbordando.

---

## Superficies

`.ox-card` con `__head` / `__body` / `__foot`; `--interactive` le agrega hover.
`.ox-section` con `__head` / `__title`. `.ox-sunken` para lo hundido.

`.ox-list` + `.ox-listitem` con `__main` / `__title` / `__sub` / `__aside`.
Las acciones van en `.ox-rowactions` (aparecen con el hover o con el foco de
teclado; el clic no las deja pegadas). En una `.ox-tr` también aparecen cuando
el foco de teclado está en una de ellas: si no, tabular hasta el «Quitar» del
carrito dejaba el botón enfocado pero invisible.

`.ox-table` + `.ox-tr`; `.ox-td--num` alinea a la derecha con cifras tabulares,
`.ox-td--tight` achica el padding. El `<th>` es sticky y por eso opaco: pinta
`--ox-surface`, la superficie donde cayó la tabla, y no un plano fijo. Dentro de
un `.ox-scroll` se clava con `top: -var(--ox-fade)`: el sticky se engancha al
borde del contenido, y sin eso quedaba debajo del padding del esfumado con las
filas pasando por arriba. Mientras está clavado, el scroller lleva
`.is-stuck-head` y no esfuma arriba: la hairline ya es el límite. Una `.ox-tr`
con `tabindex="0"` lleva el anillo de foco hacia adentro, pintado encima de las
celdas.

**`.ox-td--num` va también en el `<th>`, no solo en las celdas.** Si el
encabezado no la lleva, el título se queda a la izquierda mientras los números
van a la derecha y la columna se lee corrida — los valores no caen debajo de su
propio título. Y ojo, que la clase esté puesta no alcanzaba: `.ox-table th`
trae `text-align: left` con especificidad (0,1,1) y le ganaba a `.ox-td--num`
(0,1,0), así que el `<th>` marcado seguía alineando mal. Por eso existe la
regla `.ox-table th.ox-td--num`. Se descubrió en la tabla de presentaciones con
el descuento puesto, que tiene cuatro columnas numéricas: 82px de desfase. El
de humo lo mide.

`.ox-kv` para pares clave/valor (`__k` / `__v`). El valor va en **una línea** y
lo que no entra se elipsa; el que tiene que envolver —un SMILES, un hash largo—
lo pide con `.ox-kv__v--wrap`. `.ox-stat` para una cifra grande (`__value` /
`__unit` / `__label`).

`.ox-chip` (+ `--mono` / `--outline` / `--danger`) · `.ox-avatar` (+ `--lg`) ·
`.ox-empty` (`__title` / `__text`) · `.ox-skeleton` · `.ox-iconcell`.

`.ox-iconcell` es la celda de una **vitrina** de íconos (con su propio hover y
su etiqueta). No va a la cabeza de una fila: adentro de un `.ox-listitem`, que
ya tiene su hover, se lee como un botón suelto. Para eso Pharos tiene su baldosa,
`.ph-lead`, en `css/pharos.css` —ahí viven las piezas propias de la app, con
prefijo `ph-`—.

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
Toast.show({ title, text, icon, tone, duration, action });  // action: { label, run }
Toast.error(title, text);
Menu.show(anchorEl, items, { align: 'end' });
await Modal.show({ title, sub, body, actions, width, dismissible });
await Modal.confirm({ title, sub, confirmLabel, danger });
```

**Tooltips**: declarativos. `data-tip="texto"`, opcionalmente `data-tip-side`
(`top`|`bottom`|`left`|`right`) y `data-tip-key` para el atajo. Nunca `title=`.

**Menu items**: `{ label, icon, key, danger, selected, disabled, onSelect }`,
más `{ sep: true }` y `{ groupLabel }`.

**Modal**: devuelve una promesa con el `value` del botón que se apretó (`null`
si se cerró). El `body` puede ser HTML o un `Node` — si es un nodo, podés leer
sus campos después de que cierre. Atrapa el foco y cierra con Escape.

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

### Lo que agrega Pharos

Una app de datos reemplaza contenido después de cada consulta, y eso también
tiene que moverse. La regla que ordena todo (salió de una auditoría con cada
cuadro medido, octubre 2026): **nada se apaga para volver a prenderse**. Antes
casi todo cambio ponía lo nuevo en el mismo cuadro arrancando de 18–30 % de
opacidad; no había corte, pero el bloque entero —también lo que no había
cambiado— se leía como un parpadeo. Las herramientas, según la escala:

```js
calcar(host)                         // una SUPERFICIE: fundido con calco opaco
relevo(el, html, { montar, escalonar }) // un BLOQUE chico: relevo en el lugar
swap(el, html, { kind, montar })     // lo mismo que relevo, con la firma vieja
cambiarValor(el, html)               // un VALOR con markup: en el lugar + destello
setText(el, valor)                   // un número suelto: en el lugar + destello
setText(el, valor, false)            // un progreso: en el lugar, sin nada
leave(el, { remove, collapse })      // una fila que se va; lo de abajo se desliza
sacarDeslizando(el)                  // saca un nodo y desliza a sus hermanos
```

- **Vistas (`calcar`).** Navegar y repintar la misma vista son un fundido: lo
  de antes pasa a un calco con el fondo opaco de `.ox-main`, en la misma celda
  y encima, y se esfuma (`--ox-t-2`, in-out). Lo nuevo está entero y quieto
  debajo desde el primer cuadro, así que la pantalla está tapada todo el
  tiempo, y lo que no cambió (el título) es idéntico en las dos capas y no se
  mueve. Lo usan el router y `paint()`. Portado de Onyx (2540ba6).
- **Bloques (`relevo`).** Lo viejo se esfuma en un calco encima que copia el
  acomodo del contenedor (no se corre mientras se va) y lo nuevo asoma desde
  cero 70 ms después, cuando lo viejo va por un tercio. Los textos sueltos se
  envuelven en un `<span>` para poder animarlos. Con `escalonar` las filas de
  una lista entran una detrás de otra. Es para cosas chicas sobre el mismo
  fondo: el estado de las actualizaciones, la lista de resultados, el nombre de
  la titlebar, una frase de la statusbar. Un contenedor que vive alineado a la
  derecha o centrado tiene que estarlo también por dentro (`justify-content`),
  así el calco deja lo que se va en su lugar.
- **Valores (`cambiarValor`, `setText`).** Un número que cambia no se apaga: se
  reescribe en su lugar y destella en el acento (`tick`). Con el stepper
  apretado queda «encendido» mientras cambia, en vez de parpadear en cada paso.
- **No mostrar lo que dura un instante.** «Cargando» aparece recién si la
  espera pasa de 160 ms (`empezarCarga` en app.js): con una respuesta guardada,
  el esqueleto se veía un solo cuadro. Y «Buscando…» de las actualizaciones se
  sostiene 600 ms: con la respuesta en el acto, el spinner era un parpadeo.
- **Un control que se pone a trabajar no se reemplaza.** El botón de buscar
  actualizaciones se deshabilita y su ícono pasa a ser el spinner
  (`.ph-ocupable`): mismo tamaño, mismo lugar.
- **Lo que se prende con `hidden` se pliega** (`.ox-plegable`, de Onyx): el
  detalle de un error se despliega en vez de empujar de golpe lo de abajo.
- **`leave(…, { collapse: true })`** mide todo lo que viene debajo (hermanos y
  hermanos de cada ancestro hasta el `.ox-scroll`), saca el nodo y hace viajar a
  cada uno desde donde estaba (FLIP). Los toasts hacen lo mismo con
  `sacarDeslizando` cuando se va uno de la pila.

Lo que se puede actualizar en su lugar se actualiza en su lugar: la estrella de
favorito, el switch y las cifras del descuento, el botón del carrito de cada
presentación. Un repintado mata los controles que el usuario tiene en la mano
(el stepper que está aguantando, la cápsula que viaja).

El smoke («10. El movimiento, medido») muestrea cada cuadro y falla si
cualquiera de estas cosas vuelve atrás: con el código anterior fallaban 11.

### Clases de animación

Entradas: `.ox-in-fade` · `.ox-in-rise` · `.ox-in-glide` · `.ox-in-pop`.
Estado: `.ox-spinning` · `.ox-breathing` · `.ox-shaking` · `.ox-skeleton` ·
`.ox-ticked`. `.ox-view` es la entrada de la primera vista; las demás llegan
con el fundido de `calcar()`. `.ox-plegable` para lo que se prende con `hidden`.
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
head({ title, sub, crumbs, actions, linea })
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
