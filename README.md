# Pharos

Precios de medicamentos del **Manual Farmacéutico** (alfabeta.net), sin los
anuncios de por medio. Buscás por nombre, por droga o por laboratorio, y ves lo
único que importa: qué cuesta, en qué presentación, de cuándo es ese precio y
qué cubre la obra social.

Construida sobre **Onyx**, la plantilla de apps de escritorio del autor.

```
npm run dev     # con la consola del renderer en la terminal
npm start
npm test        # tokens, almacenamiento, formato y el parser del sitio
npm run smoke   # monta la app con Electron y la recorre entera
```

---

## Lo que hace

**Tres índices.** Producto (`Ibupirac`), droga (`ibuprofeno`) o laboratorio
(`Bagó`). Los dos últimos son de dos pasos: primero elegís la entrada del
índice y después ves todos sus productos. Buscar por droga es lo que sirve para
comparar — devuelve todas las marcas del mismo principio activo juntas.

**Traer precios.** La lista de resultados de alfabeta no trae precios: hay que
abrir la ficha de cada producto. El botón *Traer precios* lo hace de a uno,
espaciado, con progreso y se puede cortar. Es una acción explícita a propósito:
comparar 48 marcas de amoxicilina son 48 consultas a un servidor ajeno, y eso
no puede pasar sin que vos lo pidas.

**Descuento.** Un porcentaje que se aplica a toda la ficha y se guarda entre
sesiones: se escribe una vez, no una por consulta. Muestra el precio de lista,
el precio con descuento y cuánto te ahorrás, y también recalcula lo que paga el
afiliado en cada cobertura. El switch lo apaga sin perder el número, para poder
comparar con y sin en dos clicks.

**Favoritos e historial.** La estrella de cualquier producto lo deja a un
click; las búsquedas quedan anotadas y se repiten tocándolas.

---

## Cómo funciona

El sitio es un JSP viejo y previsible: formularios que hacen POST a
`/precio/srv`, sin login, sin JavaScript, sin tokens.

```
src=prs&mde=pat        patrón → productos       (resultado final)
src=drgs               patrón → drogas          (índice)
src=labs               patrón → laboratorios    (índice)
src=prs&mde=drg&idD=N  → los productos de esa droga
src=prs&mde=lab&idL=N  → los productos de ese laboratorio
/precio/<slug>.html    → la ficha, con src=pr&idL=N&patron=<NOMBRE>
```

```
src/
  alfabeta.cjs   El cliente: cola con espaciado, parseo, encoding.
  cache.cjs      Las respuestas guardadas en disco, con vigencia.
  ipc.cjs        Qué puede pedir el renderer.
  store.cjs      Ajustes, favoritos e historial en JSON atómico.
renderer/js/
  app.js         Las vistas. No habla con internet: le pide a window.onyx.af.
test/
  alfabeta.test.mjs  El parser, contra HTML real de test/fixtures/.
```

**El renderer no tiene red.** Su CSP es `default-src 'self'`, así que todo lo
que sale a internet pasa por el proceso principal y la vista solo recibe datos
ya parseados.

### Las tres trampas del sitio

Están las tres cubiertas por tests, y las tres son de la clase que no rompe
nada a la vista:

1. **Viene en ISO-8859-1.** Sin decodificar el buffer a mano, "Bagó" llega como
   "Bag?" y "Analgésico" como "Analg?sico".

2. **Los códigos 128–159 son Windows-1252, no Unicode.** `&#149;` no es un
   control invisible: es el bullet. HTML5 estandarizó esa reinterpretación
   justamente porque la web está llena de páginas así. Sin la tabla, un
   apóstrofo tipográfico (`&#146;`) mete un carácter invisible adentro de un
   nombre de producto.

3. **Las coberturas viven en una tabla ANIDADA.** Un regex no-greedy que busca
   `</table>` se cierra en la interna: los precios salen perfectos y las
   coberturas quedan vacías. Por eso las presentaciones se parten por su celda
   contenedora (`<td class="dproducto">`) y no por la tabla de adentro.

Y una del propio parser: los enlaces `rlab` —el laboratorio impreso al lado de
cada producto— no son resultados. Sin filtrarlos, buscar "ibupirac" devolvía 17
items para 16 coincidencias declaradas, y el sobrante se llamaba "Pfizer".

### Ser buen vecino

Esto consulta el servidor de otro. El cliente **serializa** todas las
peticiones y deja **650 ms** entre una y la siguiente (`INTERVALO` en
`alfabeta.cjs`), manda un User-Agent que dice qué es, y guarda en disco lo que
ya preguntó: por defecto una respuesta vale 12 horas, configurable en Ajustes.
Nada de eso es opcional ni conviene "optimizarlo".

Los precios son públicos y esto es una herramienta de consulta personal, no un
espejo del Manual: no reempaqueta ni redistribuye la base.

**Y nunca se muestra un precio viejo como si fuera de ahora.** Cada consulta
devuelve `{datos, deCache, edad}` y la vista siempre dice de dónde salió el
dato y qué antigüedad tiene. Es el peor error que podría cometer esta app.

---

## Compilar el instalador

```
npm run icono    # regenera build/icon.png (solo si cambió la marca o el acento)
npm run dist     # → dist/Pharos-<versión>-instalador.exe
```

Instalador NSIS **por usuario**: va a `%LOCALAPPDATA%\Programs\Pharos` y no pide
permisos de administrador. Desinstalar no se lleva los datos.

**Instalada, los datos no viven al lado del código.** `data/` quedaría adentro
del asar —que es de solo lectura— y encima colgando de una carpeta donde una
app de usuario no escribe, así que `main.cjs` redirige a `%APPDATA%\Pharos\data`
cuando `app.isPackaged`. En desarrollo sigue siendo la carpeta del proyecto.
Eso se decide **antes** del `require` de `store.cjs`: su raíz se resuelve una
sola vez, al cargarse el módulo.

**El .exe no está firmado.** La primera vez, Windows SmartScreen va a decir
"Windows protegió tu PC": *Más información* → *Ejecutar de todas formas*.
Firmarlo de verdad necesita un certificado de code signing pago.

El ícono de la app no es el mismo dibujo que la marca de la titlebar, y es a
propósito: la de la UI está hecha para 16px y a 256 se lee como una antena.
`tools/icono.cjs` tiene la versión con detalle y explica por qué.

---

## Actualizaciones

La app mira los *releases* de este repo. El chequeo es automático a los cinco
segundos de abrirla; **descargar e instalar no**, y eso es a propósito:

- `autoDownload` viene en `true` de fábrica, o sea bajar ~90 MB apenas abrís la
  app, sin avisar y estés donde estés. Acá se avisa y baja cuando lo pedís.
- `autoInstallOnAppQuit` también viene en `true`: la app se actualizaría sola al
  cerrarla y volvería a abrirse siendo otra versión sin que nadie lo decidiera.
  Con precios de por medio, que la herramienta cambie sin aviso no va.

Los tres pasos están en **Ajustes → Actualizaciones**, y el estado completo
viaja al renderer en cada cambio (`update:estado`) en vez de mandar diferencias:
así la vista se dibuja con lo último que llegó y no tiene que reconstruir nada
si se pierde un aviso.

Publicar una versión nueva:

```
npm version patch          # o minor / major
npm run dist              # compila el instalador
npm run publicar          # lo sube como release de GitHub
```

`GH_TOKEN` tiene que estar en el entorno para publicar (`gh auth token` lo da).

**Sin firma de código, `verifyUpdateCodeSignature` va en `false`.** electron-
updater valida por defecto que el instalador descargado esté firmado por el
mismo editor; sin certificado, rechazaría su propia actualización.

---

## Los datos

Archivos JSON legibles, uno por cosa: se abren con un editor, se leen y se
arreglan a mano. En desarrollo viven en `data/`, al lado del código; instalada,
en `%APPDATA%\Pharos\data` (ver arriba). `PHAROS_DATA` manda sobre las dos.

```
data/settings.json    descuento, vigencia del caché, último índice usado
data/historial.json   las últimas búsquedas
data/favoritos/       un archivo por producto guardado
data/cache/           una respuesta de alfabeta por archivo
```

Vaciar el caché desde Ajustes no toca favoritos ni historial.

---

## Del sistema visual

Todo lo de Onyx sigue valiendo: solo oscuro, cada símbolo es un SVG propio,
nada nativo de Chromium, y todo cambio de estado va animado. La referencia está
en [docs/sistema.md](docs/sistema.md) y la vitrina viva adentro de la app, en
**Piezas** — no está en el rail, se llega por la paleta (`Ctrl K`).

Los íconos del dominio (faro, píldora, escudo, matraz, porcentaje, estrella) se
suman con `Icons.add()` en `app.js`, nunca editando `icons.js`: así traerse una
versión nueva del set base de Onyx no los pisa.

El acento es ámbar porque la marca es un faro y el acento es su luz. Se cambia
con `node tools/retint.mjs --accent verde` (y **solo** así: hay dos copias del
color base en hex que el script mantiene en sincronía, y `npm test` lo
verifica).
