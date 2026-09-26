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

/** Actualiza una etiqueta sin hacer parpadear los valores que no cambiaron. */
export function setText(el, value, options = { kind: 'tick' }) {
  if (!el) return false;
  const text = String(value ?? '');
  if (el.textContent === text) return false;
  el.textContent = text;
  animateIn(el, options);
  return true;
}

/**
 * Relevo EN EL MISMO LUGAR: lo que hay se termina de ir y recién después entra
 * lo nuevo. Es para contenido que cambia de FORMA —una lista que pasa a estado
 * vacío, un botón que pasa a barra de progreso, el nombre de la titlebar—.
 * replaceHTML, en cambio, pone lo nuevo encima de lo viejo en el mismo cuadro:
 * perfecto para un número que cambia, pero con un bloque entero se lee como
 * un salto.
 *
 * La salida va en in-out y corta (hay alguien esperando detrás: con ease-in la
 * opacidad cae de golpe al final y el golpe se ve). Si no había nada, lo nuevo
 * entra sin esperar. Si llega otro swap a mitad de camino gana el último, sin
 * reiniciar la salida. `montar` corre apenas el HTML nuevo está puesto, antes
 * del primer cuadro de la entrada (para los <i data-icon>, por ejemplo).
 */
const swaps = new WeakMap();
const ENTRADA = { fade: 'appear', rise: 'lift', appear: 'appear', lift: 'lift' };

export function swap(el, html, { kind = 'fade', out = 120, montar } = {}) {
  if (!el) return Promise.resolve(false);
  const pendiente = swaps.get(el);
  if (pendiente) {
    Object.assign(pendiente, { html, kind, montar });
    return pendiente.promise;
  }
  if (el.innerHTML === html || el.innerHTML === normal(html)) return Promise.resolve(false);

  const entrar = (h, k, m) => {
    el.innerHTML = h;
    m?.(el);
    if (h) animateIn(el, { kind: ENTRADA[k] || 'appear' });
  };

  const vacio = !el.childElementCount && !el.textContent.trim();
  if (vacio || reduceMotion() || typeof el.animate !== 'function') {
    entrar(html, kind, montar);
    return Promise.resolve(true);
  }

  const estado = { html, kind, montar };
  estado.promise = (async () => {
    // Si todavía estaba entrando, la salida arranca desde donde iba y no desde
    // 1: cancelar primero lo haría saltar a opacidad plena por un cuadro.
    const desde = Number(getComputedStyle(el).opacity);
    running.get(el)?.cancel();
    const salida = el.animate([{ opacity: desde }, { opacity: 0 }], {
      duration: out, easing: EASE_BOTH, fill: 'forwards',
    });
    running.set(el, salida);
    await salida.finished.catch(() => {});
    swaps.delete(el);
    // La entrada se pone ANTES de soltar la salida: si se soltara primero,
    // habría un cuadro con lo nuevo a opacidad 1.
    entrar(estado.html, estado.kind, estado.montar);
    salida.cancel();
    if (running.get(el) === salida) running.delete(el);
    return true;
  })();
  swaps.set(el, estado);
  return estado.promise;
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
export function exit(el, { fallback = 400, onDone } = {}) {
  if (!el || el.dataset.state === 'closing') return Promise.resolve();
  el.dataset.state = 'closing';

  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      el.removeEventListener('animationend', onAnim);
      el.remove();
      onDone?.();
      resolve();
    };
    // Solo nos importa la animación del propio elemento, no la de sus hijos.
    const onAnim = (e) => { if (e.target === el) finish(); };
    el.addEventListener('animationend', onAnim);
    const timer = setTimeout(finish, fallback);
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
