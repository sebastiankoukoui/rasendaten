import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CHROME_CANDIDATES = [
  process.env.SFV_CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  path.join(os.homedir(), 'AppData/Local/Google/Chrome/Application/chrome.exe'),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);

function findChrome() {
  for (const c of CHROME_CANDIDATES) if (fs.existsSync(c)) return c;
  throw new Error(
    'Chrome nicht gefunden. Pfad ueber die Umgebungsvariable SFV_CHROME setzen.',
  );
}

async function cdpReady(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) return await r.json();
    } catch {
      /* noch nicht da */
    }
    await sleep(400);
  }
  return null;
}

/**
 * Leser fuer das SFV-Matchcenter.
 *
 * Wichtig: matchcenter.* liegt hinter einem Cloudflare-Bot-Filter. Klassische
 * HTTP-Clients und ein per Automations-Flags gestarteter Browser bekommen 403
 * ("Ein maschineller Zugriff ist nicht erlaubt"). Diese Klasse steuert deshalb
 * einen ganz normal gestarteten Chrome ueber das DevTools-Protokoll fern -
 * also den Browser, den auch eine Person benutzt.
 *
 * Das ersetzt KEINE Datenfreigabe: fuer den regelmaessigen, automatisierten
 * Bezug ist eine Vereinbarung mit dem SFV noetig (clubservices@football.ch).
 * Siehe README, Abschnitt "Datenquelle und Rechtliches".
 */
export class MatchcenterSession {
  constructor(options = {}) {
    this.origin = options.origin ?? 'https://matchcenter.ifv.ch';
    this.delayMs = options.delayMs ?? 1500;
    this.jitterMs = options.jitterMs ?? 700;
    this.retries = options.retries ?? 3;
    this.cacheDir = options.cacheDir ?? null;
    // Wenn gesetzt, gewinnt der Plattencache auch gegen `force` - damit laesst
    // sich die Auswertung ohne einen einzigen Netzwerkzugriff wiederholen.
    this.preferCache = options.preferCache ?? false;
    this.port = options.port ?? Number(process.env.SFV_CDP_PORT ?? 9222);
    this.profileDir =
      options.profileDir ?? path.join(os.tmpdir(), 'sfv-dashboard-chrome-profile');
    this.log = options.log ?? (() => {});
    this.stats = { fetched: 0, cached: 0, retried: 0, bytes: 0 };
    this._lastAt = 0;
    this._spawned = null;
  }

  async open() {
    let info = await cdpReady(this.port, 1500);
    if (!info) {
      const exe = findChrome();
      fs.mkdirSync(this.profileDir, { recursive: true });
      this.log(`Starte Chrome (Profil: ${this.profileDir})`);
      this._spawned = spawn(
        exe,
        [
          `--remote-debugging-port=${this.port}`,
          `--user-data-dir=${this.profileDir}`,
          '--no-first-run',
          '--no-default-browser-check',
          this.origin + '/',
        ],
        { detached: true, stdio: 'ignore' },
      );
      this._spawned.unref();
      info = await cdpReady(this.port, 30000);
      if (!info) throw new Error(`Chrome antwortet nicht auf Port ${this.port}`);
    } else {
      this.log(`Verbinde mit laufendem Chrome auf Port ${this.port}`);
    }

    this.browser = await chromium.connectOverCDP(`http://127.0.0.1:${this.port}`);
    this.context = this.browser.contexts()[0] ?? (await this.browser.newContext());
    this.page = this.context.pages()[0] ?? (await this.context.newPage());

    const resp = await this.page.goto(this.origin + '/', {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });
    if (!resp || resp.status() !== 200) {
      throw new Error(`Konnte ${this.origin} nicht oeffnen (Status ${resp?.status()}).`);
    }
    await this._injectParsers();
    this.log(`Session offen auf ${this.origin}`);
    return this;
  }

  async _injectParsers() {
    const file = new URL('../browser/parsers.js', import.meta.url);
    await this.page.addScriptTag({ content: fs.readFileSync(file, 'utf8') });
  }

  _cachePath(url) {
    if (!this.cacheDir) return null;
    const key = crypto.createHash('sha1').update(url).digest('hex').slice(0, 16);
    return path.join(this.cacheDir, `${key}.html.gz`);
  }

  readCache(url) {
    const p = this._cachePath(url);
    if (!p || !fs.existsSync(p)) return null;
    return zlib.gunzipSync(fs.readFileSync(p)).toString('utf8');
  }

  writeCache(url, html) {
    const p = this._cachePath(url);
    if (!p) return;
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, zlib.gzipSync(Buffer.from(html, 'utf8')));
  }

  async _throttle() {
    const wait = this.delayMs + Math.random() * this.jitterMs - (Date.now() - this._lastAt);
    if (wait > 0) await sleep(wait);
    this._lastAt = Date.now();
  }

  /** Ein Dokument holen. Nutzt den Plattencache, ausser `force` ist gesetzt. */
  async html(url, { force = false } = {}) {
    if (!force || this.preferCache) {
      const hit = this.readCache(url);
      if (hit) {
        this.stats.cached++;
        return hit;
      }
    }

    const absolute = url.startsWith('http') ? url : this.origin + url;
    let lastErr;
    for (let attempt = 1; attempt <= this.retries; attempt++) {
      await this._throttle();
      try {
        const resp = await this.page.goto(absolute, {
          waitUntil: 'domcontentloaded',
          timeout: 60000,
          referer: this._lastUrl ?? this.origin + '/',
        });
        if (!resp) throw new Error('keine Antwort');
        if (resp.status() !== 200) throw new Error(`HTTP ${resp.status()}`);

        const body = await this.page.content();
        if (/Ein maschineller Zugriff ist nicht erlaubt/i.test(body)) {
          throw new Error('Bot-Sperre ausgeloest');
        }
        if (body.length < 2000) throw new Error(`Antwort zu kurz (${body.length} B)`);

        this._lastUrl = absolute;
        this.stats.fetched++;
        this.stats.bytes += body.length;
        this.writeCache(url, body);
        return body;
      } catch (err) {
        lastErr = err;
        this.stats.retried++;
        this.log(`  ! ${url} -> ${err.message} (Versuch ${attempt}/${this.retries})`);
        await sleep(4000 * attempt);
      }
    }
    throw new Error(`Fehlgeschlagen: ${url} (${lastErr?.message})`);
  }

  /** Dokument holen und mit einem der window.SFV-Parser auswerten. */
  async parse(parser, url, arg, opts) {
    const html = await this.html(url, opts);
    // Jede Navigation verwirft das injizierte Skript - bei Bedarf neu setzen.
    if (!(await this.page.evaluate(() => !!window.SFV))) await this._injectParsers();
    return this.page.evaluate(
      ([name, body, extra]) => window.SFV[name](body, extra),
      [parser, html, arg ?? null],
    );
  }

  async close() {
    // Nur die CDP-Verbindung trennen; der Browser gehoert der Benutzerin.
    await this.browser?.close().catch(() => {});
  }
}
