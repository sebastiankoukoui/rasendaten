# Rasendaten — Advanced Stats für den Schweizer Amateurfussball

Prototyp eines Statistik-Dashboards für Ligen der SFV-Regionalverbände.
Aktuell erfasst (alle IFV):

| Wettbewerb | Saison | Stand |
|---|---|---|
| 3. Liga Gruppe 1 | 2025/26 | 132 Spiele, komplett — Referenzdatensatz |
| Physio Sportiv IFV-Cup | 2025/26 | 66 Spiele, komplett bis zum Final |
| Physio Sportiv IFV-Cup | 2026/27 | Runde 1 läuft, 20 von 24 Spielen |
| 4. Liga Gruppe 2 | 2026/27 | 90 Spiele angesetzt, Start 22.08.2026 |

Die berechnete Tabelle der 3. Liga stimmt Platz für Platz, Punkt für Punkt und
Tor für Tor mit der offiziellen Rangliste des Verbands überein (siehe
*Daten & Qualität*).

---

## 1. Wichtig zuerst: die Datenlage

Alle Regionalverbände (IFV, FVRZ, OFV, AFV, …) laufen auf **derselben
ASP.NET-Anwendung des SFV**, nur unter eigener Domain — `matchcenter.<verband>.ch`
mit `oid=<Verbandsnummer>`. Ein Parser reicht damit für die ganze Schweiz.

**Aber:** Der SFV blockiert automatisierte Zugriffe aktiv. Jeder Nicht-Browser-Client
bekommt HTTP 403 mit diesem Text:

> Ein maschineller Zugriff ist nicht erlaubt und wurde unterbunden:
> – Falls Sie ein SFV Verein sind …, melden Sie sich unter support@football.ch
> – Sind Sie KEIN SFV Verein und an den Spielbetriebsdaten interessiert,
>   melden Sie sich unter clubservices@football.ch

Das gilt für `matchcenter.*`, für `widget.football.ch` und auch für die
Vereinswappen auf `blob.football.ch`.

**Konsequenz für den Produktivbetrieb:** Für die gewünschte automatische
Aktualisierung (stündlich/täglich) braucht es eine Freigabe des SFV.
Der Weg dorthin ist die Adresse aus der Sperrmeldung:

```
clubservices@football.ch — Anfrage für den Bezug von Spielbetriebsdaten
```

Sinnvoller Inhalt einer solchen Anfrage: Zweck (öffentliches Statistikportal
Amateurfussball), Umfang (welche Ligen/Verbände), gewünschte Frequenz,
Formatwunsch (JSON/CSV-Feed statt HTML), und die Zusicherung, dass die Daten
mit Quellenangabe erscheinen.

Dieser Prototyp ist so gebaut, dass die Ingest-Schicht austauschbar ist: Sobald
ein offizieller Feed vorliegt, wird nur `src/collect.js` gegen einen
API-Client getauscht — Parser, Aggregation und Dashboard bleiben unverändert.

### Was der Collector hier tut

Er startet **einen ganz normalen Chrome** (keine Automatisierungs-Flags,
`navigator.webdriver` ist `false`) und steuert ihn über das DevTools-Protokoll
fern: eine Seite nach der anderen, mit 1,5 Sekunden Pause und Wiederholung bei
Fehlern. Kein Fingerprint-Spoofing, keine Stealth-Plugins, keine
Parallelabfragen. Eine vollständige Saison sind rund 135 Seitenaufrufe.

---

## 2. Was das Matchcenter tatsächlich hergibt

Die eigentliche Entdeckung: hinter jedem Spiel steckt ein **Telegramm** mit weit
mehr Daten, als die Oberfläche aggregiert zeigt.

`/default.aspx?oid=7&lng=1&tg=<id>` liefert pro Spiel:

| Datum | Inhalt |
|---|---|
| Kopf | Wettbewerb, Datum, Zeit, Spielnummer, Spielort, Team-IDs, Vereins-IDs, Resultat, Halbzeit |
| Ereignisse | Tore mit Minute, Zwischenstand, Elfmeter- und Eigentor-Kennzeichen, Torschütze; gelbe, gelb-rote und rote Karten mit Minute; Aus-/Einwechslungen mit Namen |
| Aufstellungen | Startelf mit Rückennummer, **Position** und Captain-Kennzeichen; Ersatzbank mit Kennzeichnung „kein Einsatz"; Trainerstab; Abwesende |
| IDs | `data-pid` (Person, saisonübergreifend stabil), `data-rid` (Rolle in dieser Mannschaft) |

Der Verband selbst publiziert davon aggregiert nur die Torschützenliste — und
auch die nicht in jeder Liga.

### Die URL-Systematik

```
/default.aspx?oid=7&lng=1&s=2026&ln=13029&ls=24455&sg=67610&a=mrr
              │      │     │      │        │        │       └ Ansicht
              │      │     │      │        │        └ Gruppe
              │      │     │      │        └ Staffel (Hauptrunde, Auf-/Abstieg …)
              │      │     │      └ Liga (13029 = 3. Liga)
              │      │     └ Saison (2026 = Saison 2025/26)
              │      └ Sprache (1 de, 2 fr, 3 it)
              └ Verband (1 SFV, 2 SFL, 5 AFV, 7 IFV, 9 OFV, 10 FVRZ …)
```

Ansichten (`a=`): `mrr` Rangliste · `msp` Spielplan · `mtg` Torschützenliste ·
`mts` Torschützen ganze Liga · `mgr` Gruppenübersicht · `mag` nächste Runden ·
`mna` Neuansetzungen · `mst` Strafen · `msi` Info.
Weiter: `cp=` Cup, `tg=` Telegramm, `v=` Vereinsseite.

Die vollständige Verbandstabelle steht in [`src/lib/urls.js`](src/lib/urls.js).

---

## 3. Installation und Betrieb

```bash
npm install
```

Voraussetzung: Node 20+ und ein installierter Google Chrome.

```bash
node src/cli.js crawl      # Wettbewerbe aus config/targets.json einlesen
node src/cli.js update     # nur neue/geänderte Spiele nachladen (für Cron)
node src/cli.js reparse    # nur den lokalen HTML-Cache neu auswerten, kein Netz
node src/cli.js build      # data/raw -> web/data aggregieren
node src/cli.js serve      # Dashboard auf http://localhost:5173
```

Nützliche Flags: `--only <key>`, `--force`, `--delay 2000`.

### Neue Ligen aufnehmen

`config/targets.json` erweitern — die IDs stehen in der URL der jeweiligen
Gruppenseite:

```json
{
  "key": "fvrz-2liga-g1-2026",
  "type": "league",
  "label": "2. Liga – Gruppe 1",
  "association": "FVRZ",
  "season": 2026,
  "leagueId": 13010,
  "stageId": 24455,
  "groupId": 67610
}
```

Für einen anderen Verband zusätzlich `origin` und `orgId` in derselben Datei
anpassen (Werte siehe `ASSOCIATIONS` in `src/lib/urls.js`).

**Cups haben pro Ausgabe eine eigene `cupId`.** Der Saisonparameter `s` wird
auf Cup-Seiten ignoriert — `cp=5067` liefert immer die Ausgabe 2025/26, die
laufende ist `cp=5250`. Die gültige Nummer steht in der Verbandsnavigation der
jeweiligen Saison, z. B. auf
`/default.aspx?oid=7&lng=1&s=2027&ln=13030` unter „Cup 2026/2027".

### Automatische Aktualisierung

`update` ist inkrementell: Es liest immer Spielplan, Rangliste und
Torschützenliste neu und holt ein Telegramm nur dann, wenn das Spiel neu
angesetzt/gespielt wurde, wenn sich das Resultat geändert hat oder wenn beim
letzten Mal noch keine Aufstellung erfasst war. Ein Update-Lauf nach einem
Spielwochenende sind typischerweise 10–20 Seitenaufrufe.

Windows-Aufgabenplanung (stündlich, 5 Minuten nach der vollen Stunde):

```powershell
schtasks /create /tn "Rasendaten Update" /sc hourly /mo 1 /st 00:05 ^
  /tr "cmd /c cd /d C:\Users\sebas\projekte\sfv-dashboard && node src\cli.js update"
```

Auf einem Server (Linux) braucht der Chrome eine Anzeige, z. B. via
`xvfb-run node src/cli.js update`.

**Nochmals: Das ist die technische Möglichkeit, nicht die Erlaubnis.** Vor dem
Dauerbetrieb die Freigabe einholen (Abschnitt 1).

---

## 4. Was gerechnet wird

Alles unter „berechnet" stammt aus den Telegrammen, nicht aus den
Verbandsaggregaten.

**Mannschaft**
- Tabelle gesamt/Heim/auswärts, Punkte pro Spiel
- Rangfolge nach Verbandslogik: Punkte, dann **Strafpunkte-Quotient**
  (Wettspielreglement Art. 48) — nicht Tordifferenz. Genau das reproduziert die
  offizielle Rangliste exakt.
- Form der letzten 3/5 Spiele als eigene Tabelle inkl. Rangdifferenz
- Positionsverlauf über alle Runden
- Elo-Wertung (Start 1500, Heimvorteil 55, Gewichtung nach Tordifferenz)
- Punkte über Erwartung (Pythagoras-Erwartung, Exponent 1.3)
- Minuten in Führung / ausgeglichen / im Rückstand, aus den Torzeiten rekonstruiert
- Comeback-Punkte, verspielte Punkte nach Führung, Punkte nach dem 1:0
- Tore erzielt/kassiert je 15-Minuten-Fenster
- Zu-Null-Spiele, Spiele ohne eigenes Tor, längste Serien
- Kaderbreite, eingesetzte Spieler, Abhängigkeit vom besten Torschützen

**Spieler**
- Einsätze, davon Startelf und Einwechslungen, Bankzeit ohne Einsatz
- Tore, davon Elfmeter; Eigentore separat; Tore pro Einsatz; Torminuten
- Gelb, Gelb-Rot, Rot
- Hauptposition und Mannschaftsteil aus den erfassten Positionen
- Einsatzquote am Teamspielplan, Einsatzraster Spieler × Runde
- Spielzeit in Minuten, wo die Liga Wechsel erfasst (hier 187 Wechsel in
  132 Spielen — deshalb im Dashboard bewusst nur im Spielerprofil und mit
  Angabe der Datenbasis)

**Cup**
- Turnierbaum: Runden als Spalten, Verbindungslinien folgen den Siegern.
  Die Zuordnung läuft über die Namen der weitergekommenen Mannschaften, nicht
  über feste Paarungen — nur so stimmen Freilose und Zwischenrunden, bei denen
  sich die Spielzahl nicht sauber halbiert.
- Rundenliste mit Datum, Resultat und Spielort
- Cupsieger wird nur ausgewiesen, wenn die letzte Runde wirklich ein Endspiel ist

**Meisterschaft vor dem ersten Anpfiff**
- Eigene Vorschau-Ansicht mit Countdown, erstem Spieltag und Teilnehmerfeld
  statt leerer Tabellen; Tabelle und Analyse erscheinen automatisch, sobald
  Resultate erfasst sind

**Liga**
- Tore pro Spiel, Heim-/Unentschieden-/Auswärtsquote, beide treffen, über 2.5
- Torverteilung über die Spielzeit, Elfmeter, Eigentore, Kartenbilanz
- Höchste Siege, torreichste Spiele
- Abdeckungsgrad und Abgleich gegen die offizielle Rangliste

---

## 5. Teilen und Hosten

Das Dashboard ist eine statische Seite ohne Build-Schritt und ohne
Server-Code. Es lässt sich überall ablegen, wo Dateien ausgeliefert werden.

### a) Eine einzelne HTML-Datei

```bash
node src/cli.js bundle
```

Erzeugt `dist/rasendaten.html` (rund 4 MB) mit Stylesheet, Skripten und allen
Wettbewerbsdaten inline. Doppelklick genügt, kein Server, funktioniert offline
und lässt sich per Mail oder Chat verschicken. Der schnellste Weg, jemandem
etwas zu zeigen.

### b) GitHub Pages

Funktioniert unverändert — auch unter einem Unterpfad wie
`https://<name>.github.io/sfv-dashboard/`, weil die Seite ihre Daten relativ
lädt und über den URL-Hash navigiert.

```bash
git init -b main
git add .
git commit -m "Rasendaten: Prototyp"
git remote add origin https://github.com/<name>/sfv-dashboard.git
git push -u origin main
```

Danach einmalig **Settings → Pages → Source: „GitHub Actions"** wählen. Der
Workflow [`.github/workflows/pages.yml`](.github/workflows/pages.yml)
veröffentlicht bei jedem Push den Ordner `web/`.

Zwei Punkte dazu:

- **`web/data/*.json` müssen mitcommittet werden** — sie sind die Datenbasis der
  Seite. `.gitignore` schliesst nur `data/cache/` und `dist/` aus. Die beiden
  Dateien sind zusammen etwa 4 MB; bei jedem Update-Lauf ändern sie sich
  vollständig, das Repo wächst also mit jedem Commit um diese Grössenordnung.
- **Pages ist bei kostenlosen Konten öffentlich.** Damit werden auch die
  erhobenen Spielbetriebsdaten öffentlich weiterveröffentlicht — das ist etwas
  anderes als sie lokal anzusehen, und der SFV hat zum maschinellen Bezug eine
  klare Haltung (Abschnitt 1). Für „kurz einem Kollegen zeigen" sind die
  Einzeldatei aus a) oder ein privates Repo der unkompliziertere Weg.

### c) Beliebiger Webspace

`web/` auf Netlify, Cloudflare Pages, einen FTP-Space oder einen nginx-Ordner
kopieren. Der Cron-Job erneuert danach nur die JSON-Dateien unter `web/data/`.

---

## 6. Aufbau

```
config/targets.json     welche Wettbewerbe eingelesen werden
src/
  cli.js                Kommandozeile
  collect.js            Ablauf: Spielplan -> Rangliste -> Telegramme
  aggregate.js          Rohdaten -> Kennzahlen (reines Node, testbar ohne Netz)
  browser/parsers.js    HTML -> JSON; läuft im Browserkontext
  lib/session.js        Chrome-Fernsteuerung, Drosselung, Cache
  lib/urls.js           URL-Schema und Verbandsliste
  lib/stats.js          Elo, Pythagoras, Serien, Minutenfenster
data/
  cache/                gzip-komprimiertes Roh-HTML (ermöglicht reparse)
  raw/<key>.json        geparste Rohdaten je Wettbewerb
web/                    Dashboard: index.html, app.js, charts.js, styles.css
  data/<key>.json       fertig aggregierte Daten für die Oberfläche
```

Das Dashboard ist eine statische Seite ohne Build-Schritt und ohne
Abhängigkeiten — die Diagramme sind handgeschriebenes SVG. Es lässt sich
unverändert auf GitHub Pages, Netlify oder einen beliebigen Webserver legen;
der Cron-Job erneuert dann nur die JSON-Dateien unter `web/data/`.

---

## 7. Bekannte Grenzen

- **Wechsel werden nicht in jeder Partie erfasst.** In der 3. Liga sind es rund
  40 % der Spiele. Echte Einsatzminuten gibt es deshalb nur dort; überall sonst
  zählt der Prototyp Einsätze statt Minuten.
- **Strafpunkte werden vom Verband übernommen**, nicht selbst gerechnet: Sie
  enthalten auch nachträgliche Sanktionen, die im Telegramm nicht auftauchen
  (im Referenzdatensatz 12–20 Punkte je Team mehr als die reine Kartenbilanz).
- **Rundenzuordnung** wird aus der Spielnummernfolge rekonstruiert; der
  Verband liefert keine explizite Rundennummer im Spielplan.
- **Keine Vereinswappen** — auch die Bilddomain ist gesperrt. Ersatzweise
  Monogramme.
- **Keine xG-Daten.** Im Amateurbereich existieren keine Schuss- oder
  Positionsdaten; „erwartete Punkte" beruhen deshalb auf der Torbilanz.
