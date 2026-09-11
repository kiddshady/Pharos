/* ═══════════════════════════════════════════════════════════════════════════
   Publica una versión: compila el instalador y lo sube como release de
   GitHub, con título, notas y los tres archivos en UN solo release.

   ── Por qué existe ─────────────────────────────────────────────────────────
   `electron-builder --publish always` a secas crea DOS drafts para el mismo
   tag y reparte los archivos entre los dos: el .blockmap en uno, el .exe y
   el latest.yml en el otro. Es una carrera adentro de app-builder-lib
   (PublishManager.getOrCreatePublisher): consulta su caché de publishers,
   hace `await createPublisher(...)` y recién DESPUÉS lo guarda. El .exe y su
   .blockmap disparan `artifactCreated` en el mismo tick, así que el segundo
   llega mientras el primero está en el await, ve la caché vacía y crea otro
   publisher — y cada publisher, al no encontrar release para el tag, crea el
   suyo. Está en la 26.15.3 y sigue en la última.

   La salida es no competir: el release se crea ACÁ, como draft y ANTES de
   compilar. GitHubPublisher, cuando encuentra un draft con el tag, lo
   reutiliza (gitHubPublisher.js → getOrCreateRelease), así que los dos
   publishers de la carrera suben al mismo lugar. Y ya que el release lo
   creamos nosotros, lleva título y notas desde el principio.

   ── Lo que hace, en orden ──────────────────────────────────────────────────
     1. Verifica que no haya cambios sin commitear y que el tag vX.Y.Z apunte
        a HEAD (lo crea `npm version`).
     2. Corre `npm test`.
     3. Pushea la rama y el tag: el release tiene que apuntar al commit real.
     4. Busca releases con ese tag: uno publicado aborta; drafts sobrantes de
        una corrida anterior se borran y se reutiliza el primero; si no hay,
        lo crea con título y notas.
     5. Compila y sube (electron-builder --win --publish always).
     6. Verifica en GitHub que estén el .exe, el .blockmap y latest.yml, con
        el tamaño local, y que el sha512 del .exe coincida con latest.yml.
     7. Publica (draft → release, marcado como latest) si hubo notas y no se
        pidió --draft. Sin notas, queda como draft: un release sin notas no
        sale.

   Uso:
     npm version patch                          # o minor / major
     npm run publicar -- --notas notas.md
     npm run publicar -- --notas notas.md --draft   # sube todo, no publica
     node tools/publicar.mjs --dir C:\otra\app      # sobre otra app Onyx

   `GH_TOKEN` en el entorno, o `gh auth token` si está el CLI logueado.
   ═══════════════════════════════════════════════════════════════════════════ */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execFileSync, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

/* ── Argumentos ────────────────────────────────────────────────────────── */
const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const valor = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : null; };

const RAIZ = path.resolve(valor('dir') || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const pkg = JSON.parse(fs.readFileSync(path.join(RAIZ, 'package.json'), 'utf8'));

const VERSION = pkg.version;
const TAG = `v${VERSION}`;
const NOMBRE = pkg.build?.productName || pkg.name;
const TITULO = `${NOMBRE} ${VERSION}`;
const { owner, repo } = pkg.build?.publish?.[0] || {};
if (!owner || !repo) abortar('package.json no declara build.publish[0].owner/repo');
const REPO = `${owner}/${repo}`;
const DIST = path.join(RAIZ, pkg.build?.directories?.output || 'dist');

const notasArchivo = valor('notas');
const NOTAS = notasArchivo ? fs.readFileSync(path.resolve(notasArchivo), 'utf8') : null;
if (notasArchivo && !NOTAS?.trim()) abortar(`${notasArchivo} está vacío`);
const SOLO_DRAFT = flag('draft');

/* ── Herramientas ──────────────────────────────────────────────────────── */
function abortar(msg) {
  console.error(`\n  ✗ ${msg}\n`);
  process.exit(1);
}

function paso(msg) {
  console.log(`\n▸ ${msg}`);
}

/** Corre un comando y devuelve su salida; si falla, aborta con el stderr. */
function correr(cmd, cmdArgs, { env, silencioso = false } = {}) {
  try {
    return execFileSync(cmd, cmdArgs, {
      cwd: RAIZ, encoding: 'utf8', env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', silencioso ? 'pipe' : 'inherit'],
      maxBuffer: 64 * 1024 * 1024,
    }).trim();
  } catch (err) {
    abortar(`falló \`${cmd} ${cmdArgs.join(' ')}\`${err.stderr ? `\n${String(err.stderr).trim()}` : ''}`);
  }
}

const git = (...a) => correr('git', a);
const gh = (...a) => correr('gh', a);
const ghJson = (...a) => JSON.parse(gh(...a) || 'null');

/* Todo lo del release va por la API y por id, nunca por el tag: un draft no
   está asociado a su tag hasta que se publica. Dos trampas de GitHub que
   costaron una tarde:
     · Un PATCH a un draft SIN `tag_name` le borra el tag pendiente (queda
       "untagged-…"), y entonces electron-builder no lo encuentra y crea los
       suyos. Cada PATCH lo repite.
     · El listado de releases es de consistencia eventual: un draft recién
       creado puede no aparecer en la lectura siguiente. Como electron-builder
       lo busca por el listado, antes de compilar se espera a verlo ahí. */
const listarConTag = () => ghJson('api', `repos/${REPO}/releases?per_page=50`).filter((r) => r.tag_name === TAG);
const crearRelease = () => ghJson('api', '--method', 'POST', `repos/${REPO}/releases`,
  '-f', `tag_name=${TAG}`, '-f', `name=${TITULO}`, '-f', `body=${NOTAS || ''}`, '-F', 'draft=true');
const editarRelease = (id, ...campos) => ghJson('api', '--method', 'PATCH', `repos/${REPO}/releases/${id}`,
  '-f', `tag_name=${TAG}`, ...campos);
const leerRelease = (id) => ghJson('api', `repos/${REPO}/releases/${id}`);
const dormir = (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

/* ── 1. El árbol y el tag ──────────────────────────────────────────────── */
paso(`Publicar ${TITULO} (${REPO}, tag ${TAG})`);

if (git('status', '--porcelain')) abortar('hay cambios sin commitear: el release tiene que salir de un commit');

const head = git('rev-parse', 'HEAD');
const tagCommit = spawnSync('git', ['rev-parse', '-q', '--verify', `refs/tags/${TAG}^{commit}`], { cwd: RAIZ, encoding: 'utf8' });
if (tagCommit.status !== 0) abortar(`no existe el tag ${TAG}: corré \`npm version patch\` (o minor / major) primero`);
if (tagCommit.stdout.trim() !== head) abortar(`el tag ${TAG} no apunta a HEAD: hay commits después del bump. Volvé a versionar.`);
console.log(`  HEAD ${head.slice(0, 7)} = ${TAG}`);

const token = process.env.GH_TOKEN || correr('gh', ['auth', 'token'], { silencioso: true });
if (!token) abortar('sin token: exportá GH_TOKEN o logueá el CLI con `gh auth login`');

/* ── 2. Tests ──────────────────────────────────────────────────────────── */
paso('npm test');
const tests = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['test'],
  { cwd: RAIZ, stdio: 'inherit', shell: process.platform === 'win32' });
if (tests.status !== 0) abortar('los tests no pasan; no se publica así');

/* ── 3. Push ───────────────────────────────────────────────────────────── */
paso('Pusheando la rama y el tag');
git('push', '-q', 'origin', 'HEAD');
git('push', '-q', 'origin', TAG);
console.log('  al día');

/* ── 4. El release, creado por nosotros ────────────────────────────────── */
paso('El release en GitHub');
const releases = listarConTag();

const publicado = releases.find((r) => !r.draft);
if (publicado) abortar(`ya hay un release publicado para ${TAG}: ${publicado.html_url}. Subí la versión.`);

let release = releases[0] || null;
for (const sobrante of releases.slice(1)) {
  // Drafts de una corrida anterior que quedó a medias (o de la carrera).
  gh('api', '--method', 'DELETE', `repos/${REPO}/releases/${sobrante.id}`);
  console.log(`  borrado un draft sobrante (${sobrante.id})`);
}

if (release) {
  release = editarRelease(release.id, '-f', `name=${TITULO}`, ...(NOTAS ? ['-f', `body=${NOTAS}`] : []));
  console.log(`  reutilizando el draft existente (${release.id})`);
} else {
  release = crearRelease();
  if (!release?.id) abortar('GitHub no devolvió el draft creado');
  console.log(`  draft creado (${release.id})`);
}

// Que el listado ya lo muestre: es por donde lo va a buscar electron-builder.
for (let i = 0; ; i++) {
  if (listarConTag().some((r) => r.id === release.id)) break;
  if (i >= 15) abortar('el draft existe pero el listado de GitHub todavía no lo muestra; probá de nuevo en un rato');
  dormir(2000);
}
console.log(`  el listado ya lo muestra con el tag ${TAG}`);

/* ── 5. Compilar y subir ───────────────────────────────────────────────── */
paso('electron-builder --win --publish always');
const build = spawnSync(process.execPath,
  [path.join(RAIZ, 'node_modules', 'electron-builder', 'cli.js'), '--win', '--publish', 'always'],
  { cwd: RAIZ, stdio: 'inherit', env: { ...process.env, GH_TOKEN: token } });
if (build.status !== 0) abortar('electron-builder falló; el draft queda para reintentar con el mismo comando');

/* ── 6. Verificar lo subido ────────────────────────────────────────────── */
paso('Verificando lo que quedó en GitHub');
const latestLocal = fs.readFileSync(path.join(DIST, 'latest.yml'), 'utf8');
const exeNombre = /^path:\s*(.+)$/m.exec(latestLocal)?.[1]?.trim();
const shaDeclarado = /^sha512:\s*(.+)$/m.exec(latestLocal)?.[1]?.trim();
if (!exeNombre || !shaDeclarado) abortar('dist/latest.yml no tiene path/sha512: ¿compiló?');

const exeLocal = path.join(DIST, exeNombre);
const shaReal = crypto.createHash('sha512').update(fs.readFileSync(exeLocal)).digest('base64');
if (shaReal !== shaDeclarado) abortar(`el sha512 de ${exeNombre} no coincide con latest.yml: un actualizador rechazaría esta versión`);
console.log(`  sha512 del .exe coincide con latest.yml`);

const esperados = [exeNombre, `${exeNombre}.blockmap`, 'latest.yml'];
const remoto = leerRelease(release.id);
const assets = new Map(remoto.assets.map((a) => [a.name, a]));
for (const nombre of esperados) {
  const a = assets.get(nombre);
  const local = fs.statSync(path.join(DIST, nombre)).size;
  if (!a) abortar(`falta ${nombre} en el release`);
  if (a.state !== 'uploaded') abortar(`${nombre} quedó en estado "${a.state}"`);
  if (a.size !== local) abortar(`${nombre}: ${a.size} bytes en GitHub, ${local} en disco`);
  console.log(`  ${nombre.padEnd(exeNombre.length + 9)} ${a.size} bytes`);
}
const sobran = remoto.assets.filter((a) => !esperados.includes(a.name)).map((a) => a.name);
if (sobran.length) console.log(`  (además hay: ${sobran.join(', ')})`);

/* ── 7. Publicar ────────────────────────────────────────────────────────── */
if (SOLO_DRAFT || !NOTAS) {
  paso(`Queda como draft: ${SOLO_DRAFT ? 'se pidió --draft' : 'sin notas no se publica'}`);
  console.log(`  ${remoto.html_url}`);
  console.log(`  para publicarlo: gh release edit ${TAG} -R ${REPO} --draft=false --latest${NOTAS ? '' : ' --notes-file notas.md'}`);
} else {
  paso('Publicando');
  // Una 0.4.0-beta.1 sale como pre-release y no desplaza a la estable como "latest".
  const beta = /-/.test(VERSION);
  const final = editarRelease(release.id, '-F', 'draft=false', '-F', `prerelease=${beta}`, '-f', `make_latest=${!beta}`);
  if (final.draft) abortar('GitHub sigue diciendo que es draft');
  console.log(`  ${final.name} → ${final.html_url}`);
}
console.log('');
