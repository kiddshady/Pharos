/* ═══════════════════════════════════════════════════════════════════════════
   ONYX — motion (runtime)
   La mitad JS del sistema de movimiento. Su trabajo más importante es el que
   más se olvida: que lo que se va del DOM TERMINE su animación de salida antes
   de irse. Sin esto los overlays parpadean al cerrarse y la app se siente rota.
   ═══════════════════════════════════════════════════════════════════════════ */

/** Dos frames: garantiza que el navegador ya aplicó los estilos iniciales. */
export function raf2(fn) {
  requestAnimationFrame(() => requestAnimationFrame(fn));
}

/* ── Cambios de contenido ───────────────────────────────────────────────────
   Las transiciones CSS cubren estados que conservan el mismo nodo (hover,
   switch, segmentado). Las vistas de una app real también reemplazan texto o
   markup después de una consulta. Esos cambios necesitan una entrada breve:
   si no, el dato nuevo aparece en un solo frame aunque el control que lo
   produjo se haya movido con toda suavidad.

   Se usa Web Animations y no una clase temporal porque dos actualizaciones
   seguidas —un progreso, un stepper apretado— tienen que cancelar la anterior
   limpiamente. Nunca se acumulan animaciones ni listeners. */

const running = new WeakMap();
const EASE = 'cubic-bezier(.16, 1, .3, 1)';

const FRAMES = {
  fade: [
    { opacity: .22 },
    { opacity: 1 },
  ],
  rise: [
    { opacity: .18, transform: 'translateY(5px)' },
    { opacity: 1, transform: 'translateY(0)' },
  ],
  glide: [
    { opacity: 0, transform: 'translateX(-10px)' },
    { opacity: 1, transform: 'translateX(0)' },
  ],
  tick: [
    { opacity: .3, transform: 'translateY(2px)' },
    { opacity: 1, transform: 'translateY(0)' },
  ],
  /* Las dos de abajo arrancan de CERO y son para después de un relevo (swap):
     lo viejo ya se fue entero, así que no hay nada que "refrescar" desde .22 —
     un contenido nuevo que nace a un cuarto de luz se lee como un pestañeo. */
  appear: [
    { opacity: 0 },
    { opacity: 1 },
  ],
  lift: [
    { opacity: 0, transform: 'translateY(6px)' },
    { opacity: 1, transform: 'translateY(0)' },
  ],
};

/** in-out: la curva de lo que se va con alguien esperando detrás. */
const EASE_BOTH = 'cubic-bezier(.65, 0, .35, 1)';

function reduceMotion() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

/** Hace entrar un nodo ya actualizado, cancelando cualquier entrada anterior. */
export function animateIn(el, { kind = 'fade', duration, delay = 0 } = {}) {
  if (!el || reduceMotion() || typeof el.animate !== 'function') return null;
  running.get(el)?.cancel();
  const ms = duration ?? ({ glide: 420, rise: 280, tick: 220, lift: 280 }[kind] || 180);
  const animation = el.animate(FRAMES[kind] || FRAMES.fade, {
    duration: ms,
    delay,
    easing: EASE,
    fill: 'both',
  });
  running.set(el, animation);
  animation.finished.catch(() => {}).finally(() => {
    if (running.get(el) === animation) {
      running.delete(el);
      // `fill:both` sirve durante el viaje; al terminar, el estilo base ya es
      // idéntico al último frame. Cancelarla evita acumular efectos terminados.
      animation.cancel();
    }
  });
  return animation;
}

/**
 * El HTML tal como lo va a devolver el navegador al leerlo. Comparar el texto
 * de una plantilla con `innerHTML` directo falla aunque sean lo mismo: el
 * navegador reescribe `<path/>` como `<path></path>`, normaliza espacios y
 * comillas. Con la comparación cruda, todo lo que llevara un SVG «cambiaba»
 * siempre: el nombre de la titlebar se volvía a fundir en cada toque del
 * carrito, aunque dijera lo mismo.
 */
function normal(html) {
  const t = document.createElement('template');
  t.innerHTML = html;
  return t.innerHTML;
}

/** Reemplaza markup solo si cambió y materializa el resultado con suavidad. */
export function replaceHTML(el, html, options) {
  if (!el || el.innerHTML === html || el.innerHTML === normal(html)) return false;
  el.innerHTML = html;
  animateIn(el, options);
  return true;
}

/** Actualiza una etiqueta sin hacer parpadear los valores que no cambiaron.
    Por defecto el valor nuevo se escribe en el lugar y destella en el acento
    (`tick`), sin apagarse: antes arrancaba de 30 % de opacidad, y un número
    que cambia seguido —el stepper apretado— parpadeaba sin parar. Con
    `options = false` no hace ni eso: es para un progreso, que se mueve varias
    veces por segundo. Con `{ kind }` hace esa entrada de animateIn. */
export function setText(el, value, options = 'valor') {
  if (!el) return false;
  const text = String(value ?? '');
  if (el.textContent === text) return false;
  el.textContent = text;
  if (options === 'valor') { if (!reduceMotion()) tick(el); }
  else if (options) animateIn(el, options);
  return true;
}

/** Lo mismo que setText para un valor con markup (un precio con su unidad):
    se reescribe en el lugar y destella en el acento, sin apagarse. */
export function cambiarValor(el, html) {
  if (!el || el.innerHTML === html || el.innerHTML === normal(html)) return false;
  el.innerHTML = html;
  if (!reduceMotion()) tick(el);
  return true;
}

/**
 * Relevo de un bloque chico EN EL LUGAR: lo viejo se esfuma en un calco
 * encima (que copia el acomodo del contenedor, así que no se mueve mientras se
 * va) y lo nuevo asoma desde cero cuando lo viejo ya va por un tercio.
 *
 * Es lo que reemplaza a `replaceHTML` con bloques. Aquel ponía lo nuevo en el
 * mismo cuadro arrancando de 18 % de opacidad: el bloque entero se apagaba y
 * se volvía a prender, también lo que no había cambiado. Medido en la caja de
 * actualizaciones: dos caídas a 18 % por cada «Buscar».
 *
 * Es para cosas chicas sobre el mismo fondo (un estado, una fila de acciones,
 * una lista de resultados); una vista entera va con el fundido del router.
 * Los textos sueltos se envuelven en un <span> para poder animarlos.
 * `escalonar`: un selector de lo que entra escalonado (las filas de una lista)
 * en vez de todo junto.
 *
 * El calco conserva la caja que tenía lo viejo (su ancho, su alto y dónde
 * caía), no la del contenedor ya con lo nuevo. Antes copiaba la nueva: una
 * frase que se iba dentro de una caja más angosta se partía en dos renglones
 * mientras se esfumaba (el «Mostrando precios con 40 % menos» de la ficha al
 * apagar el descuento), y una más ancha se corría.
 *
 * `fundido`: para un bloque grande (una tabla que gana o pierde columnas). La
 * espera del relevo destapa: a mitad de camino lo viejo va por la mitad y lo
 * nuevo por un tercio, y la tabla entera queda a media luz —se lee como un
 * parpadeo—. Con fundido, el calco lleva el fondo opaco de lo que tiene
 * detrás y lo nuevo está entero y quieto debajo desde el primer cuadro: lo
 * único que se mueve es cuánto se ve del calco.
 */
const RELEVO_SALIDA = 160;
const RELEVO_ESPERA = 70;
const FUNDIDO = 180;

export function relevo(el, html, { montar, entrada = 'appear', escalonar = null, fundido = false } = {}) {
  if (!el) return false;
  const vivos = [...el.childNodes].filter((n) => !(n.nodeType === 1 && n.classList.contains('ox-relevo-calco')));
  const caja = document.createElement('div');
  caja.append(...vivos.map((n) => n.cloneNode(true)));
  const actual = caja.innerHTML;
  if (actual === html || actual === normal(html) || actual === normal(envolverTextos(html))) return false;

  const habia = vivos.some((n) => n.nodeType === 1 || n.textContent.trim());
  const animar = !reduceMotion() && typeof el.animate === 'function';

  let calco = null;
  let antes = null;
  if (habia && animar) {
    running.get(el)?.cancel();
    const r = el.getBoundingClientRect();
    antes = { left: r.left, top: r.top, w: el.clientWidth, h: el.clientHeight };
    calco = document.createElement('div');
    calco.className = 'ox-relevo-calco';
    calco.inert = true;
    calco.setAttribute('aria-hidden', 'true');
    calco.append(...vivos);
    for (const x of calco.querySelectorAll('[id]')) x.removeAttribute('id');
    if (getComputedStyle(el).position === 'static') el.classList.add('ox-relevo-host');
    // Y por encima del encabezado sticky de la tabla nueva (z-index 2): si no,
    // el título nuevo se ve desde el primer cuadro sobre las cifras viejas. Solo
    // en el fundido: un relevo chico adentro de una celda tiene que seguir
    // pasando por DEBAJO del encabezado clavado de su tabla.
    if (fundido) Object.assign(calco.style, { background: fondoDetras(el), zIndex: 3 });
    el.prepend(calco);
    // Lo que todavía estaba entrando se da por entrado: el calco se va desde
    // donde lo agarró, no vuelve a arrancar adentro (lo que gira, sigue).
    for (const a of calco.getAnimations({ subtree: true })) {
      if (a.effect?.getTiming().iterations !== Infinity) a.finish();
    }
    // In-out y no ease-in: hay alguien esperando detrás.
    const salida = calco.animate([{ opacity: 1 }, { opacity: 0 }], {
      duration: fundido ? FUNDIDO : RELEVO_SALIDA, easing: EASE_BOTH, fill: 'forwards',
    });
    salida.finished.catch(() => {}).then(() => calco.remove());
  } else {
    vivos.forEach((n) => n.remove());
  }

  const tpl = document.createElement('template');
  tpl.innerHTML = envolverTextos(html);
  const nuevos = [...tpl.content.children];
  el.append(tpl.content);
  montar?.(el);

  // El calco, clavado en la caja vieja: medida ya con lo nuevo adentro.
  if (calco) {
    const r = el.getBoundingClientRect();
    Object.assign(calco.style, {
      inset: 'auto',
      left: `${antes.left - r.left - el.clientLeft}px`,
      top: `${antes.top - r.top - el.clientTop}px`,
      width: `${antes.w}px`,
      height: `${antes.h}px`,
    });
  }
  if (!animar || (fundido && habia)) return true;

  // Si no había nada, lo nuevo entra sin esperar: la espera es solo para relevar.
  const espera = habia ? RELEVO_ESPERA : 0;
  const filas = escalonar ? [...el.querySelectorAll(escalonar)] : [];
  for (const n of nuevos) {
    if (filas.some((f) => n === f || n.contains(f))) continue;
    animateIn(n, { kind: entrada, delay: espera });
  }
  // Las filas, una detrás de otra; después de la décima entran juntas, que
  // una lista larga no tarde en terminar de llegar.
  filas.forEach((f, i) => animateIn(f, { kind: 'lift', delay: espera + Math.min(i, 10) * 24 }));
  return true;
}

/** El primer fondo opaco hacia arriba: lo que el calco de un fundido tiene que
    llevar para tapar lo nuevo sin que se note un parche. */
function fondoDetras(el) {
  for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
    const bg = getComputedStyle(n).backgroundColor;
    if (alfaDe(bg) >= 1) return bg;
  }
  return getComputedStyle(document.body).backgroundColor;
}

/** La opacidad de un color computado: `rgba(…, a)`, `oklch(… / a)` o sin alfa. */
function alfaDe(color) {
  if (!color || color === 'transparent') return 0;
  const barra = color.match(/\/\s*([\d.]+)(%?)\s*\)$/);
  if (barra) return Number(barra[1]) / (barra[2] ? 100 : 1);
  const rgba = color.match(/^rgba\((?:[^,]+,){3}\s*([\d.]+)\s*\)$/);
  return rgba ? Number(rgba[1]) : 1;
}

/** Un texto suelto entre elementos no se puede animar: va en un <span>. */
function envolverTextos(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  for (const n of [...tpl.content.childNodes]) {
    if (n.nodeType !== 3 || !n.textContent.trim()) continue;
    const s = document.createElement('span');
    n.replaceWith(s);
    s.append(n);
  }
  return tpl.innerHTML;
}

/**
 * Relevo EN EL MISMO LUGAR para contenido que cambia de FORMA (una lista que
 * pasa a estado vacío, un botón que pasa a barra de progreso, el nombre de la
 * titlebar). Es relevo() con la firma de siempre: `kind` elige la entrada y
 * devuelve una promesa por compatibilidad.
 *
 * Antes era un relevo EN FILA: lo viejo terminaba de irse (120 ms) y recién
 * después entraba lo nuevo desde cero, así que en el medio había un instante
 * sin nada. Ahora lo viejo se esfuma en un calco encima mientras lo nuevo ya
 * asoma, y lo nuevo existe desde el primer cuadro (quien lo busque para
 * actualizarlo lo encuentra).
 */
const ENTRADA = { fade: 'appear', rise: 'lift', appear: 'appear', lift: 'lift' };

export function swap(el, html, { kind = 'fade', montar } = {}) {
  return Promise.resolve(relevo(el, html, { montar, entrada: ENTRADA[kind] || 'appear' }));
}

/**
 * Salida para un nodo que va a dejar de existir. A diferencia de exit(), no
 * exige que el elemento haya nacido con una clase ox-in-*.
 *
 * `collapse`: lo que venía DEBAJO no salta a ocupar el hueco, se desliza. Sin
 * esto, sacar una fila del medio de una lista era una salida suave seguida de
 * un salto seco de todas las de abajo —y del total, que vive fuera de la
 * tabla—. Se hace con FLIP (se mide antes, se saca, se mide después y cada uno
 * viaja con transform desde donde estaba), así que no se anima ningún alto.
 * Se mueve todo lo que sigue al nodo dentro de su scroll: sus hermanos y los
 * hermanos de cada ancestro hasta ahí. Y como hay quien espera, la salida pasa
 * a in-out.
 */
export function leave(el, { kind = 'rise', duration = 150, remove = false, collapse = false } = {}) {
  if (!el) return Promise.resolve();
  if (reduceMotion() || typeof el.animate !== 'function') {
    if (remove) el.remove();
    return Promise.resolve();
  }
  running.get(el)?.cancel();
  const from = kind === 'glide'
    ? { opacity: 1, transform: 'translateX(0)' }
    : { opacity: 1, transform: 'translateY(0)' };
  const to = kind === 'glide'
    ? { opacity: 0, transform: 'translateX(7px)' }
    : { opacity: 0, transform: 'translateY(4px)' };
  const animation = el.animate([from, to], {
    duration,
    easing: collapse ? EASE_BOTH : 'cubic-bezier(.55, 0, 1, .45)',
    fill: 'forwards',
  });
  running.set(el, animation);
  return animation.finished.catch(() => {}).then(() => {
    if (running.get(el) === animation) running.delete(el);
    if (remove) {
      const siguen = collapse ? debajoDe(el) : [];
      const antes = siguen.map((n) => n.getBoundingClientRect().top);
      el.remove();
      siguen.forEach((n, i) => {
        const dy = antes[i] - n.getBoundingClientRect().top;
        if (Math.abs(dy) < 0.5) return;
        n.animate([{ transform: `translateY(${dy}px)` }, { transform: 'translateY(0)' }], {
          duration: 240, easing: EASE,
        });
      });
    }
    animation.cancel();
  });
}

/** Todo lo que sigue a `el` en su contenedor de scroll (o en su padre, si no hay). */
function debajoDe(el) {
  const tope = el.closest('.ox-scroll') || el.parentElement;
  const out = [];
  for (let n = el; n && n !== tope; n = n.parentElement) {
    for (let s = n.nextElementSibling; s; s = s.nextElementSibling) out.push(s);
  }
  return out;
}

/**
 * Saca un elemento del DOM DESPUÉS de su animación de salida.
 * Marca data-state="closing" (el CSS engancha ahí) y espera al animationend,
 * con un timeout de red por si el elemento no tiene animación declarada.
 */
export function exit(el, { fallback = 400, onDone, sacar } = {}) {
  if (!el || el.dataset.state === 'closing') return Promise.resolve();
  el.dataset.state = 'closing';

  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      el.removeEventListener('animationend', onAnim);
      if (sacar) sacar(el); else el.remove();
      onDone?.();
      resolve();
    };
    // Solo nos importa la animación del propio elemento, no la de sus hijos.
    const onAnim = (e) => { if (e.target === el) finish(); };
    el.addEventListener('animationend', onAnim);
    const timer = setTimeout(finish, fallback);
  });
}

/**
 * La vista que se va no desaparece de un cuadro al otro: su contenido pasa a
 * un calco con la misma clase de `.ox-main` (y por eso su mismo fondo opaco),
 * en la misma celda de la grilla, ENCIMA de la nueva, y se esfuma. La nueva
 * está entera y quieta debajo desde el primer cuadro, así que la pantalla
 * está tapada en todo momento: lo único que cambia es cuánto se ve de cada
 * una. Antes la vieja se iba de golpe y la nueva subía desde transparente,
 * corrida 10 px: medido, la vista pasaba por opacidad 0 en cada navegación.
 * Portado de Onyx (2540ba6). Lo usan el router al navegar y paint() al
 * repintar la misma vista (de «Cargando…» a la ficha, por ejemplo).
 *
 * El calco va sin ids (nadie tiene que encontrar un #campo que se está yendo),
 * inerte, y conserva su scroll. Si la vista vieja todavía estaba entrando, el
 * calco arranca desde la opacidad y el corrimiento en que la agarró.
 */
export function calcar(host) {
  if (!host || !host.firstChild || !host.parentElement) return null;
  const cs = getComputedStyle(host);
  const calco = document.createElement(host.tagName);
  calco.className = host.className;
  calco.classList.add('ox-main--saliente');
  calco.setAttribute('aria-hidden', 'true');
  calco.inert = true;
  calco.style.opacity = cs.opacity;
  if (cs.transform !== 'none') calco.style.transform = cs.transform;
  // Lo que la vista vieja estuviera animando sobre sí misma (la entrada del
  // arranque, un repintado) ya quedó copiado en el calco: la nueva no lo hereda.
  host.getAnimations().forEach((a) => a.cancel());

  const scrolls = [...host.querySelectorAll('*')]
    .filter((el) => el.scrollTop || el.scrollLeft)
    .map((el) => [el, el.scrollTop, el.scrollLeft]);
  calco.append(...host.childNodes);
  for (const el of calco.querySelectorAll('[id]')) el.removeAttribute('id');
  host.after(calco);
  for (const [el, top, left] of scrolls) { el.scrollTop = top; el.scrollLeft = left; }

  // Mover un nodo en el DOM le REINICIA las animaciones CSS: lo que tenía su
  // propia entrada volvería a entrar desde cero adentro del calco que se va.
  // Se dan por terminadas; lo que gira para siempre (un spinner) sigue.
  for (const a of calco.getAnimations({ subtree: true })) {
    if (a.effect?.getTiming().iterations !== Infinity) a.finish();
  }

  exit(calco, { fallback: 260 });
  host.__calcadoEn = performance.now();
  return calco;
}

/**
 * Saca un nodo y DESLIZA a sus hermanos desde donde estaban hasta su lugar
 * nuevo (FLIP: se mide antes, se saca, se mide después, y cada uno viaja con
 * transform). Es para pilas como la de los toasts: sin esto, cuando uno se
 * iba, los de arriba caían de golpe a ocupar el hueco.
 * `composite: 'add'` suma el viaje a la animación que el hermano ya tenga
 * (un toast que todavía está entrando), en vez de pisársela.
 */
export function sacarDeslizando(el, { duration = 240 } = {}) {
  const otros = el.parentElement ? [...el.parentElement.children].filter((n) => n !== el) : [];
  const antes = otros.map((n) => n.getBoundingClientRect().top);
  el.remove();
  if (reduceMotion()) return;
  otros.forEach((n, i) => {
    const dy = antes[i] - n.getBoundingClientRect().top;
    if (Math.abs(dy) < 0.5) return;
    n.animate([{ transform: `translateY(${dy}px)` }, { transform: 'translateY(0)' }], {
      duration, easing: EASE, composite: 'add',
    });
  });
}

/** Escalona los hijos de un contenedor seteando --i (el CSS lo usa de delay). */
export function stagger(container, selector = ':scope > *', step = 1) {
  container.querySelectorAll(selector).forEach((el, i) => {
    el.style.setProperty('--i', String(i * step));
  });
}

/* ── Click-flash ────────────────────────────────────────────────────────────
   Un velo de luz que nace con el press y decae. No viaja como un ripple de
   Material: solo confirma que el click llegó, y se limpia solo. */
export function initClickFlash(root = document) {
  root.addEventListener('pointerdown', (e) => {
    const target = e.target.closest?.('.ox-flashable');
    if (!target || target.disabled) return;
    const flash = document.createElement('span');
    flash.className = 'ox-flash';
    target.appendChild(flash);
    flash.addEventListener('animationend', () => flash.remove(), { once: true });
  });
}

/* ── Esfumado del scroll ────────────────────────────────────────────────────
   Apaga el fade del lado donde no hay nada recortado: pegado arriba no se
   esfuma arriba. Sin esto el primer item vive a media luz sin razón. */
export function scrollFade(el) {
  if (!el || el.__vcFade) return;
  el.__vcFade = true;

  const update = () => {
    const slack = el.scrollHeight - el.clientHeight;
    if (slack <= 1) {                       // no hay nada que recortar
      el.classList.add('is-top', 'is-bottom');
      el.classList.remove('is-stuck-head');
      return;
    }
    el.classList.toggle('is-top', el.scrollTop <= 1);
    el.classList.toggle('is-bottom', el.scrollTop >= slack - 1);
    // Un encabezado de tabla clavado contra el borde: su tabla ya empezó arriba
    // del borde y todavía no terminó. Ahí la línea es el límite y el fade sobra.
    const top = el.getBoundingClientRect().top;
    const stuck = [...el.querySelectorAll('.ox-table')].some((t) => {
      if (t.closest('.ox-scroll') !== el) return false;
      const r = t.getBoundingClientRect();
      return r.top < top - 1 && r.bottom > top;
    });
    el.classList.toggle('is-stuck-head', stuck);
  };

  el.addEventListener('scroll', update, { passive: true });
  new ResizeObserver(update).observe(el);
  // El contenido puede cambiar de alto sin que cambie el del contenedor.
  new MutationObserver(update).observe(el, { childList: true, subtree: true });
  update();
}

/** Aplica scrollFade a todo .ox-scroll que todavía no lo tenga. */
export function initScrollFades(root = document) {
  root.querySelectorAll('.ox-scroll').forEach(scrollFade);
}

/* ── Indicadores que viajan ─────────────────────────────────────────────────
   La cápsula del segmentado y el subrayado de los tabs se DESLIZAN entre
   opciones. Que viajen en vez de saltar es lo que los hace sentir físicos. */

/* La cápsula copia la geometría REAL de la opción activa, igual que el
   subrayado de los tabs. Antes se calculaba como ancho/n asumiendo opciones
   iguales, y en una celda de tabla no lo son: la cápsula caía corrida y el
   texto parecía descentrado. offsetLeft es relativo al segmentado (position:
   relative), así que ya incluye su padding. */
export function syncSegmented(seg) {
  const active = seg.querySelector('.ox-segmented__opt.is-active') || seg.querySelector('.ox-segmented__opt');
  if (!active) return;
  seg.style.setProperty('--seg-x', `${active.offsetLeft}px`);
  seg.style.setProperty('--seg-w', `${active.offsetWidth}px`);
}

export function syncTabs(tabs) {
  const active = tabs.querySelector('.ox-tab.is-active');
  if (!active) return;
  tabs.style.setProperty('--tab-x', `${active.offsetLeft}px`);
  tabs.style.setProperty('--tab-w', `${active.offsetWidth}px`);
}

/**
 * Cablea un grupo (segmentado o tabs) para que se comporte solo.
 * onChange recibe el value del botón elegido.
 */
export function bindSwitcher(root, onChange) {
  const isSeg = root.classList.contains('ox-segmented');
  const optSel = isSeg ? '.ox-segmented__opt' : '.ox-tab';
  const sync = () => (isSeg ? syncSegmented(root) : syncTabs(root));

  root.addEventListener('click', (e) => {
    const opt = e.target.closest(optSel);
    if (!opt || opt.classList.contains('is-active')) return;
    root.querySelectorAll(optSel).forEach((o) => o.classList.remove('is-active'));
    opt.classList.add('is-active');
    sync();
    onChange?.(opt.dataset.value, opt);
  });

  new ResizeObserver(sync).observe(root);
  raf2(sync);   // las fuentes pueden cambiar el ancho después del primer layout
  return sync;
}

/* ── Campo numérico ─────────────────────────────────────────────────────────
   El spinner de `<input type=number>` es de Chromium y está tapado en el CSS.
   Esto le devuelve las flechas, ya dibujadas por nosotros.

   El input NO se reemplaza: sigue siendo el dueño del valor, del foco y del
   teclado. Por eso cada paso despacha `input` Y `change` con bubbles — quien
   escuchaba al campo antes de tener flechas sigue funcionando sin tocar nada.

   Mantener apretado repite, y acelera: un campo de copias que llega a 50 de a
   un click por vez no lo usa nadie. */

const ESPERA = 380;    // antes de empezar a repetir: distingue click de aguante
const PASO_LENTO = 110;
const PASO_RAPIDO = 45;
const ACELERA_A = 1200;   // ms aguantando antes de pasar a rápido

/**
 * Cablea un `.ox-stepper` (input + dos flechas).
 * onChange recibe el valor numérico ya acotado a min/max.
 */
export function bindStepper(root, onChange) {
  const input = root?.querySelector('input[type="number"]');
  if (!input) return () => {};

  const num = (attr, fallback) => {
    const v = parseFloat(input.getAttribute(attr));
    return Number.isFinite(v) ? v : fallback;
  };

  const leer = () => {
    const v = parseFloat(input.value);
    return Number.isFinite(v) ? v : num('min', 0);
  };

  /** Los topes se releen en cada paso: el max suele depender de otra cosa. */
  const acotar = (v) => Math.min(num('max', Infinity), Math.max(num('min', -Infinity), v));

  const sync = () => {
    const v = leer();
    const arriba = root.querySelector('[data-step="up"]');
    const abajo = root.querySelector('[data-step="down"]');
    if (arriba) arriba.disabled = v >= num('max', Infinity);
    if (abajo) abajo.disabled = v <= num('min', -Infinity);
  };

  function mover(dir) {
    const antes = leer();
    const v = acotar(antes + dir * num('step', 1));
    if (v === antes) { sync(); return false; }
    input.value = String(v);
    sync();
    // bubbles: los listeners suelen estar en el contenedor, no en el input.
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    onChange?.(v, input);
    return true;
  }

  let timer = null;
  let puntero = null;

  /* El cambio puede repintar la vista y sacar `root` del DOM mientras el mouse
     todavía está abajo. En ese caso el pointerup ya no burbujea por este nodo:
     cae sobre el stepper nuevo y el timer viejo quedaba repitiendo solo. La
     ventana sobrevive al repintado, así que escucha la liberación durante cada
     pulsación y sirve como red de seguridad de la captura del puntero. */
  const dejarDeEscucharFin = () => {
    window.removeEventListener('pointerup', frenar, true);
    window.removeEventListener('pointercancel', frenar, true);
    window.removeEventListener('blur', frenar, true);
  };

  function frenar(e) {
    if (e?.pointerId != null && puntero != null && e.pointerId !== puntero) return;
    clearTimeout(timer);
    timer = null;
    puntero = null;
    dejarDeEscucharFin();
  }

  const escucharFin = () => {
    window.addEventListener('pointerup', frenar, true);
    window.addEventListener('pointercancel', frenar, true);
    window.addEventListener('blur', frenar, true);
  };

  function arrancar(dir, desde) {
    if (puntero == null) return;
    const transcurrido = Date.now() - desde;
    if (!mover(dir)) { frenar(); return; }
    timer = setTimeout(() => arrancar(dir, desde), transcurrido > ACELERA_A ? PASO_RAPIDO : PASO_LENTO);
  }

  root.addEventListener('pointerdown', (e) => {
    const btn = e.target.closest('[data-step]');
    if (!btn || btn.disabled) return;
    e.preventDefault();                 // que el campo no pierda el foco
    frenar();
    puntero = e.pointerId;
    escucharFin();
    const dir = btn.dataset.step === 'up' ? 1 : -1;
    mover(dir);
    const desde = Date.now();
    timer = setTimeout(() => arrancar(dir, desde), ESPERA);
    /* La captura del puntero es lo que hace que soltar CUENTE aunque el dedo se
       haya ido del botón. Sin esto, arrastrar afuera deja el contador corriendo
       para siempre. */
    try { btn.setPointerCapture?.(e.pointerId); } catch { /* eventos sintéticos */ }
  });

  for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    root.addEventListener(ev, frenar);
  }

  input.addEventListener('input', sync);
  sync();
  return sync;
}

/* ── Revelado de alto (grid 0fr → 1fr) ───────────────────────────────────── */
export function toggleReveal(el, open) {
  const next = open ?? !el.classList.contains('is-open');
  el.classList.toggle('is-open', next);
  return next;
}

/* ── Números que cuentan ────────────────────────────────────────────────────
   Un contador que salta de 0 a 1284 no se lee; uno que corre, sí. */
export function countTo(el, to, { from = 0, duration = 700, format = (n) => n } = {}) {
  const start = performance.now();
  const ease = (t) => 1 - Math.pow(1 - t, 3);
  const tick = (now) => {
    const t = Math.min(1, (now - start) / duration);
    el.textContent = format(Math.round(from + (to - from) * ease(t)));
    if (t < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/** Marca un valor que acaba de cambiar: destella y vuelve. */
export function tick(el) {
  el.classList.remove('ox-ticked');
  void el.offsetWidth;          // reinicia la animación
  el.classList.add('ox-ticked');
}
