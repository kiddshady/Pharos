/* ═══════════════════════════════════════════════════════════════════════════
   El parser de alfabeta.net, contra HTML real guardado.

   Los fixtures de `test/fixtures/` son respuestas de verdad del sitio, con sus
   bytes originales en ISO-8859-1. Se leen igual que en producción —buffer +
   TextDecoder— así que este test cubre todo el camino menos el fetch.

   Existe porque el parser ya se equivocó dos veces de formas que NO rompen
   nada a la vista:

     1. Los enlaces `rlab` (el laboratorio impreso al lado de cada producto) se
        contaban como resultados propios. Buscar "ibupirac" devolvía 17 items
        para 16 coincidencias declaradas, y el de más se llamaba "Pfizer".

     2. Las presentaciones se cortaban con un regex no-greedy que se cerraba en
        el `</table>` de la tabla de coberturas ANIDADA. Los precios salían
        perfectos y las coberturas quedaban vacías — el tipo de error que nadie
        nota hasta que le cobra de menos a alguien.

   Los dos daban verde con cualquier test que solo preguntara "¿parseó algo?".
   Por eso acá se comparan CANTIDADES y VALORES concretos.
   ═══════════════════════════════════════════════════════════════════════════ */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { _internos } = require('../src/alfabeta.cjs');
const { parseResultados, parseFicha, texto, precio, fecha, desentidad } = _internos;

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

/** Igual que en el cliente: el sitio es ISO-8859-1, no UTF-8. */
const fixture = (n) =>
  new TextDecoder('iso-8859-1').decode(fs.readFileSync(path.join(DIR, `${n}.html`)));

let pass = 0;
let fail = 0;
const ok = (n, c, x = '') => {
  if (c) { pass++; console.log(`  ok   ${n}`); }
  else { fail++; console.log(`  FALLA ${n} ${x}`); }
};

/* ── Texto y números ──────────────────────────────────────────────────────── */

console.log('\n1. Texto, precios y fechas');

ok('los tags se van y las entidades se resuelven',
  texto('<b>Analg&eacute;sico</b>&nbsp;Antiinflam.') === 'Analgésico Antiinflam.',
  texto('<b>Analg&eacute;sico</b>&nbsp;Antiinflam.'));

ok('las entidades numéricas también',
  desentidad('a&#149;b&#x2022;c') === 'a•b•c', desentidad('a&#149;b&#x2022;c'));

/* El formato argentino es punto de miles y coma decimal. parseFloat() directo
   sobre "14.189,89" da 14.18: mil veces menos, y encima un número plausible. */
ok('un precio argentino se lee entero', precio('$14.189,89') === 14189.89, String(precio('$14.189,89')));
ok('y uno sin miles también', precio('$973,29') === 973.29, String(precio('$973,29')));
ok('un precio vacío es null, no cero', precio('') === null, String(precio('')));

ok('la fecha queda ordenable', fecha('(03/09/26)') === '2026-09-03', String(fecha('(03/09/26)')));
ok('una fecha ilegible es null', fecha('sin fecha') === null, String(fecha('sin fecha')));

/* ── Búsqueda de productos ────────────────────────────────────────────────── */

console.log('\n2. Búsqueda por nombre de producto');

const prods = parseResultados(fixture('busqueda-producto'));

ok('parsea las 16 coincidencias que el sitio declara',
  prods.length === 16, `parseados=${prods.length}`);
ok('y ninguna es el laboratorio colado como resultado',
  !prods.some((p) => p.nombre === 'Pfizer'),
  JSON.stringify(prods.filter((p) => p.nombre === 'Pfizer')));
ok('todos son productos', prods.every((p) => p.tipo === 'producto'));
ok('cada uno trae con qué abrir su ficha',
  prods.every((p) => p.slug?.endsWith('.html') && p.patron),
  JSON.stringify(prods.find((p) => !p.slug?.endsWith('.html')) || ''));
ok('el laboratorio viaja al lado del producto',
  prods[0].nombre === 'IBUPIRAC 400 MG' && prods[0].laboratorio === 'Pfizer',
  `${prods[0].nombre} | ${prods[0].laboratorio}`);

/* ── Índices de droga y laboratorio ───────────────────────────────────────── */

console.log('\n3. Índices de droga y laboratorio');

const drogas = parseResultados(fixture('busqueda-droga'));
ok('la droga devuelve entradas de índice, no productos',
  drogas.length === 16 && drogas.every((d) => d.tipo === 'indice'),
  `n=${drogas.length}`);
ok('con el id que hace falta para expandirlas',
  drogas[0].idD === '654' && drogas[0].mde === 'drg',
  JSON.stringify(drogas[0]));
ok('y los acentos llegan bien desde ISO-8859-1',
  drogas.some((d) => d.nombre === 'amoxicilina+acetilcisteína'),
  drogas.map((d) => d.nombre).join(' · '));

const labs = parseResultados(fixture('busqueda-laboratorio'));
ok('el laboratorio también devuelve índice',
  labs.length === 5 && labs.every((l) => l.tipo === 'indice' && l.mde === 'lab'),
  `n=${labs.length}`);
ok('con su idL y el acento en su lugar',
  labs[0].idL === '21' && labs[0].nombre === 'Bagó',
  JSON.stringify(labs[0]));

/* ── La ficha ─────────────────────────────────────────────────────────────── */

console.log('\n4. La ficha de un producto');

const f = parseFicha(fixture('ficha-producto'));

ok('la cabecera sale entera',
  f.nombre === 'IBUPIRAC 400 MG' && f.laboratorio === 'Pfizer'
  && f.droga === 'ibuprofeno' && f.accion === 'Analgésico Antiinflam.',
  JSON.stringify({ n: f.nombre, l: f.laboratorio, d: f.droga, a: f.accion }));

ok('están las tres presentaciones', f.presentaciones.length === 3, `n=${f.presentaciones.length}`);

const [p12, p24, p60] = f.presentaciones;
ok('con su descripción, su precio y su fecha',
  p12.descripcion === 'comp.x 12 (VL)' && p12.precio === 3806.53 && p12.fecha === '2026-09-03',
  JSON.stringify(p12));
ok('y los precios de las otras dos',
  p24.precio === 7637.20 && p60.precio === 14189.89,
  `${p24.precio} / ${p60.precio}`);

/* Éste es el chequeo que caza el bug de la tabla anidada. Que la de 12 NO
   tenga cobertura es parte de la prueba: si el parser se llevara la cobertura
   de la presentación siguiente, acá aparecería una. */
console.log('\n5. Coberturas de obra social (el bug de la tabla anidada)');

ok('la presentación sin cobertura no hereda la de la siguiente',
  p12.coberturas.length === 0, JSON.stringify(p12.coberturas));
ok('la de 24 trae su cobertura', p24.coberturas.length === 1, JSON.stringify(p24.coberturas));
ok('la de 60 trae la suya', p60.coberturas.length === 1, JSON.stringify(p60.coberturas));

const c24 = p24.coberturas[0];
ok('con obra, detalle y los dos importes',
  c24.obra === 'IOMA' && c24.detalle === 'Cobertura Monto Fijo'
  && c24.cubre === 973.29 && c24.paga === 6663.91,
  JSON.stringify(c24));

/* Lo que cubre la obra social más lo que pone el afiliado tiene que dar el
   precio de lista. Si alguna vez se cruzaran las columnas OS y AF, el total
   seguiría cerrando pero los roles estarían dados vuelta — por eso además se
   compara cuál es el más grande. */
ok('cubre + paga da el precio de la presentación',
  Math.abs((c24.cubre + c24.paga) - p24.precio) < 0.01,
  `${c24.cubre} + ${c24.paga} vs ${p24.precio}`);
ok('y el afiliado es el que pone la parte grande, no la obra social',
  c24.paga > c24.cubre, `paga=${c24.paga} cubre=${c24.cubre}`);

/* ── Robustez ─────────────────────────────────────────────────────────────── */

console.log('\n6. Basura adentro, nada de excepciones');

ok('una página vacía no explota', parseResultados('').length === 0);
ok('una ficha vacía devuelve la forma esperada',
  parseFicha('').presentaciones.length === 0 && parseFicha('').nombre === '');
ok('HTML cortado a la mitad tampoco',
  parseFicha(fixture('ficha-producto').slice(0, 15000)).presentaciones.length >= 0);

console.log(`\n═══ ${pass} ok · ${fail} fallas ═══`);
process.exit(fail ? 1 : 0);
