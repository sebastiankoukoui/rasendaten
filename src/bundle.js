import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './lib/io.js';

const WEB = path.join(ROOT, 'web');
const DIST = path.join(ROOT, 'dist');

/** JSON so einbetten, dass es den <script>-Kontext nicht sprengen kann. */
const safeJson = (value) =>
  JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');

/**
 * Baut das Dashboard zu einer einzigen HTML-Datei zusammen: Stylesheet,
 * beide ES-Module und alle Wettbewerbsdaten inline. Die Datei laeuft ohne
 * Server - Doppelklick genuegt, und sie laesst sich per Mail verschicken.
 */
export function bundle({ log = console.log } = {}) {
  const dataDir = path.join(WEB, 'data');
  if (!fs.existsSync(path.join(dataDir, 'index.json'))) {
    throw new Error('web/data/index.json fehlt - zuerst "node src/cli.js build" ausfuehren.');
  }

  const data = {};
  for (const file of fs.readdirSync(dataDir).filter((f) => f.endsWith('.json'))) {
    data[`data/${file}`] = JSON.parse(fs.readFileSync(path.join(dataDir, file), 'utf8'));
  }

  const css = fs.readFileSync(path.join(WEB, 'styles.css'), 'utf8');
  // Beide Module zu einem Skript verketten: `export` entfernen, Import loeschen.
  const charts = fs.readFileSync(path.join(WEB, 'charts.js'), 'utf8').replace(/^export\s+/gm, '');
  const app = fs
    .readFileSync(path.join(WEB, 'app.js'), 'utf8')
    .replace(/^import\s+\{[^}]*\}\s+from\s+'\.\/charts\.js';\s*$/m, '')
    .replace(/^export\s+/gm, '');

  let html = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');
  html = html
    .replace('<link rel="stylesheet" href="styles.css" />', `<style>\n${css}\n</style>`)
    .replace(
      '<script type="module" src="app.js"></script>',
      `<script>window.__RASENDATEN__ = ${safeJson(data)};</script>\n` +
        `<script type="module">\n${charts}\n${app}\n</script>`,
    );

  fs.mkdirSync(DIST, { recursive: true });
  const out = path.join(DIST, 'rasendaten.html');
  fs.writeFileSync(out, html, 'utf8');

  const mb = (fs.statSync(out).size / 1048576).toFixed(1);
  log(
    `Einzeldatei gebaut: dist/rasendaten.html (${mb} MB, ` +
      `${Object.keys(data).length - 1} Wettbewerbe)`,
  );
  return out;
}
