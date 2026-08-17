#!/usr/bin/env node
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { ROOT } from './lib/io.js';

const args = process.argv.slice(2);
const cmd = args[0] ?? 'help';
const flag = (name) => args.includes('--' + name);
const value = (name, fallback = null) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
};

async function serve(port) {
  const root = path.join(ROOT, 'web');
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent((req.url ?? '/').split('?')[0]);
    let file = path.join(root, url === '/' ? 'index.html' : url);
    if (!file.startsWith(root)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(root, 'index.html');
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    fs.createReadStream(file).pipe(res);
  });
  server.listen(port, () => console.log(`Dashboard: http://localhost:${port}`));
}

switch (cmd) {
  case 'crawl':
  case 'reparse':
  case 'update': {
    const fromCache = cmd === 'reparse' || flag('cache');
    const { collect } = await import('./collect.js');
    await collect({
      force: flag('force') || fromCache,
      fromCache,
      only: value('only') ? value('only').split(',') : null,
      delayMs: value('delay') ? Number(value('delay')) : null,
    });
    try {
      const { buildAll } = await import('./aggregate.js');
      buildAll();
    } catch (err) {
      console.error('Aggregation uebersprungen:', err.message);
    }
    break;
  }
  case 'build': {
    const { buildAll } = await import('./aggregate.js');
    buildAll();
    break;
  }
  case 'bundle': {
    const { bundle } = await import('./bundle.js');
    bundle();
    break;
  }
  case 'serve':
    await serve(Number(value('port', '5173')));
    break;
  default:
    console.log(`sfv-dashboard

  node src/cli.js crawl [--only key1,key2] [--force] [--delay 1500]
      Liest Spielplan, Rangliste und alle Match-Telegramme der konfigurierten
      Wettbewerbe (config/targets.json) und schreibt sie nach data/raw/.
      Danach wird automatisch neu aggregiert.

  node src/cli.js update
      Wie crawl, holt aber nur neue/geaenderte Spiele. Fuer den Cron-Job.

  node src/cli.js reparse
      Wertet ausschliesslich den lokalen HTML-Cache neu aus - kein Netzwerk.
      Nach Aenderungen an den Parsern der schnellste Weg.

  node src/cli.js build
      Aggregiert data/raw/ -> web/data/ ohne Netzwerkzugriff.

  node src/cli.js bundle
      Packt Dashboard und Daten in eine einzige HTML-Datei (dist/).
      Laeuft ohne Server, per Doppelklick oder Mailanhang.

  node src/cli.js serve [--port 5173]
      Statischer Server fuer das Dashboard.`);
}
