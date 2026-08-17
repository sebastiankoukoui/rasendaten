/* Kleine SVG-Chart-Bibliothek - keine Abhaengigkeiten.
 * Marken-Specs: duenne Marken, 4px runde Datenenden, 2px Flaechenluecken,
 * 2px Ring auf Punkten, haarfeine durchgezogene Gitterlinien. */

const NS = 'http://www.w3.org/2000/svg';
const tipEl = () => document.getElementById('tooltip');

export function showTip(html, x, y) {
  const t = tipEl();
  t.innerHTML = html;
  t.style.left = `${x}px`;
  t.style.top = `${y}px`;
  t.dataset.open = 'true';
}

export function hideTip() {
  tipEl().dataset.open = 'false';
}

const el = (name, attrs = {}, children = []) => {
  const node = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined) continue;
    node.setAttribute(k, String(v));
  }
  for (const c of [].concat(children)) node.append(c);
  return node;
};

const text = (str, attrs = {}) => {
  const node = el('text', attrs);
  node.textContent = str;
  return node;
};

/** Rechteck mit abgerundetem Datenende (oben bzw. rechts). */
function barPath(x, y, w, h, r, dir = 'up') {
  const rad = Math.max(0, Math.min(r, h / 2, w / 2));
  if (h <= 0.5) return `M${x} ${y + h}h${w}`;
  if (dir === 'up') {
    return `M${x} ${y + h}V${y + rad}a${rad} ${rad} 0 0 1 ${rad} ${-rad}h${w - 2 * rad}a${rad} ${rad} 0 0 1 ${rad} ${rad}V${y + h}Z`;
  }
  // dir === 'right'
  return `M${x} ${y}h${w - rad}a${rad} ${rad} 0 0 1 ${rad} ${rad}v${h - 2 * rad}a${rad} ${rad} 0 0 1 ${-rad} ${rad}H${x}Z`;
}

/** Rendert bei jeder Breitenaenderung neu, damit Text nie verzerrt. */
export function responsive(container, render) {
  const draw = () => {
    const w = container.clientWidth;
    if (!w) return;
    container.replaceChildren(render(w));
  };
  draw();
  if (!container._ro) {
    const ro = new ResizeObserver(() => {
      clearTimeout(container._t);
      container._t = setTimeout(draw, 90);
    });
    ro.observe(container);
    container._ro = ro;
  }
}

const niceTicks = (max, count = 4) => {
  if (max <= 0) return [0];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? mag * 10;
  const ticks = [];
  for (let v = 0; v <= max + step * 0.001; v += step) ticks.push(+v.toFixed(6));
  return ticks;
};

/** Runde Achsenwerte innerhalb eines beliebigen Bereichs (nicht ab 0). */
const rangeTicks = (min, max, count = 4) => {
  const span = max - min || 1;
  const mag = 10 ** Math.floor(Math.log10(span / count));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= count) ?? mag * 10;
  const ticks = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) ticks.push(+v.toFixed(6));
  return ticks.length ? ticks : [min, max];
};

/* ------------------------------------------------------------------ Saeulen */

/**
 * Gruppiertes Saeulendiagramm.
 * data: [{ label, values: [n, ...] }], series: [{ name, color }]
 */
export function columnChart(container, opts) {
  const {
    data,
    series,
    height = 190,
    formatValue = (v) => v,
    labelValues = false,
    yLabel = null,
  } = opts;

  responsive(container, (width) => {
    const pad = { top: 14, right: 8, bottom: 26, left: 34 };
    const w = Math.max(240, width);
    const innerW = w - pad.left - pad.right;
    const innerH = height - pad.top - pad.bottom;
    const max = Math.max(1, ...data.flatMap((d) => d.values));
    const ticks = niceTicks(max);
    const top = ticks[ticks.length - 1];
    const y = (v) => pad.top + innerH - (v / top) * innerH;

    const svg = el('svg', {
      class: 'chart',
      viewBox: `0 0 ${w} ${height}`,
      width: '100%',
      height,
      role: 'img',
    });

    for (const t of ticks) {
      svg.append(
        el('line', {
          class: 'grid-line',
          x1: pad.left,
          x2: w - pad.right,
          y1: y(t),
          y2: y(t),
        }),
        text(formatValue(t), { x: pad.left - 7, y: y(t) + 3.5, 'text-anchor': 'end' }),
      );
    }
    if (yLabel) svg.append(text(yLabel, { x: pad.left - 7, y: pad.top - 4, 'text-anchor': 'end' }));

    const band = innerW / data.length;
    const gap = 2; // Flaechenluecke
    const groupW = Math.min(band - 10, 24 * series.length + gap * (series.length - 1));
    const barW = (groupW - gap * (series.length - 1)) / series.length;

    data.forEach((d, i) => {
      const bx = pad.left + band * i + (band - groupW) / 2;
      d.values.forEach((v, s) => {
        const x = bx + s * (barW + gap);
        const h = (v / top) * innerH;
        const path = el('path', {
          d: barPath(x, y(v), barW, h, 4, 'up'),
          fill: series[s].color,
        });
        const hit = el('rect', {
          x: bx,
          y: pad.top,
          width: groupW,
          height: innerH,
          fill: 'transparent',
        });
        hit.addEventListener('pointerenter', (e) => {
          const rows = d.values
            .map((val, k) => `${series[k].name}: <b>${formatValue(val)}</b>`)
            .join('<br>');
          showTip(`<b>${d.label}</b><br>${rows}`, e.clientX, e.clientY);
        });
        hit.addEventListener('pointerleave', hideTip);
        svg.append(path);
        if (s === 0) svg.append(hit);
        if (labelValues && v > 0) {
          svg.append(
            text(formatValue(v), {
              x: x + barW / 2,
              y: y(v) - 5,
              'text-anchor': 'middle',
              class: 'label-strong',
            }),
          );
        }
      });
      svg.append(
        text(d.label, {
          x: pad.left + band * i + band / 2,
          y: height - 8,
          'text-anchor': 'middle',
        }),
      );
    });

    svg.append(
      el('line', {
        class: 'axis-line',
        x1: pad.left,
        x2: w - pad.right,
        y1: y(0),
        y2: y(0),
      }),
    );
    return svg;
  });
}

/* ----------------------------------------------------------- Liniendiagramm */

/**
 * Mehrere Linien, aber nur eine hervorgehoben - der ehrliche Weg, wenn es
 * mehr Serien gibt als es unterscheidbare Farben geben darf.
 * series: [{ key, name, points: [{x, y}] }]
 */
export function lineChart(container, opts) {
  const {
    series,
    height = 260,
    highlight = null,
    invertY = false,
    yTicks = null,
    xLabel = (v) => v,
    yFormat = (v) => v,
    tip = null,
    onPick = null,
  } = opts;

  responsive(container, (width) => {
    const pad = { top: 12, right: 54, bottom: 26, left: 36 };
    const w = Math.max(280, width);
    const innerW = w - pad.left - pad.right;
    const innerH = height - pad.top - pad.bottom;

    const xs = series.flatMap((s) => s.points.map((p) => p.x));
    const ys = series.flatMap((s) => s.points.map((p) => p.y));
    const xMin = Math.min(...xs);
    const xMax = Math.max(...xs);
    const yMin = opts.yMin ?? Math.min(...ys);
    const yMax = opts.yMax ?? Math.max(...ys);
    const spanY = yMax - yMin || 1;

    const X = (v) => pad.left + ((v - xMin) / (xMax - xMin || 1)) * innerW;
    const Y = (v) =>
      invertY
        ? pad.top + ((v - yMin) / spanY) * innerH
        : pad.top + innerH - ((v - yMin) / spanY) * innerH;

    const svg = el('svg', {
      class: 'chart',
      viewBox: `0 0 ${w} ${height}`,
      width: '100%',
      height,
      role: 'img',
    });

    const ticks = yTicks ?? rangeTicks(yMin, yMax);
    for (const t of ticks) {
      svg.append(
        el('line', { class: 'grid-line', x1: pad.left, x2: w - pad.right, y1: Y(t), y2: Y(t) }),
        text(yFormat(t), { x: pad.left - 7, y: Y(t) + 3.5, 'text-anchor': 'end' }),
      );
    }

    const xStep = Math.max(1, Math.round((xMax - xMin) / 8));
    for (let v = xMin; v <= xMax; v += xStep) {
      svg.append(text(xLabel(v), { x: X(v), y: height - 8, 'text-anchor': 'middle' }));
    }

    const line = (pts) => pts.map((p, i) => `${i ? 'L' : 'M'}${X(p.x)} ${Y(p.y)}`).join('');

    // Hintergrundserien zuerst, damit die hervorgehobene obenauf liegt.
    const ordered = [...series].sort((a) => (a.key === highlight ? 1 : -1));
    for (const s of ordered) {
      const isHi = s.key === highlight;
      const path = el('path', {
        d: line(s.points),
        fill: 'none',
        stroke: isHi ? 'var(--series-1)' : 'var(--line-strong)',
        'stroke-width': isHi ? 2 : 1.25,
        'stroke-linejoin': 'round',
        'stroke-linecap': 'round',
        opacity: isHi ? 1 : 0.55,
        style: onPick ? 'cursor:pointer' : '',
      });
      path.addEventListener('pointerenter', (e) => {
        if (tip) showTip(tip(s), e.clientX, e.clientY);
      });
      path.addEventListener('pointerleave', hideTip);
      if (onPick) path.addEventListener('click', () => onPick(s.key));
      svg.append(path);

      if (isHi) {
        const last = s.points[s.points.length - 1];
        svg.append(
          el('circle', {
            cx: X(last.x),
            cy: Y(last.y),
            r: 4.5,
            fill: 'var(--series-1)',
            stroke: 'var(--surface)',
            'stroke-width': 2,
          }),
          text(s.name, {
            x: X(last.x) + 9,
            y: Y(last.y) + 3.5,
            class: 'label-strong',
            'text-anchor': 'start',
          }),
        );
      }
    }

    svg.append(
      el('line', {
        class: 'axis-line',
        x1: pad.left,
        x2: w - pad.right,
        y1: pad.top + innerH,
        y2: pad.top + innerH,
      }),
    );
    return svg;
  });
}

/* --------------------------------------------------- gestapelte Zeilenbalken */

/**
 * Horizontale, gestapelte Balken pro Zeile (z. B. Minuten in Führung /
 * ausgeglichen / Rückstand). segments: [{ name, color }]
 */
export function stackedRows(container, opts) {
  const { rows, segments, formatValue = (v) => v, rowHeight = 26, labelWidth = 132 } = opts;

  responsive(container, (width) => {
    const w = Math.max(280, width);
    const height = rows.length * rowHeight + 10;
    const trackX = labelWidth;
    const trackW = w - labelWidth - 8;
    const max = Math.max(1, ...rows.map((r) => r.values.reduce((a, b) => a + b, 0)));

    const svg = el('svg', {
      class: 'chart',
      viewBox: `0 0 ${w} ${height}`,
      width: '100%',
      height,
      role: 'img',
    });

    rows.forEach((row, i) => {
      const y = i * rowHeight + 4;
      const h = rowHeight - 10;
      svg.append(
        text(row.label, {
          x: trackX - 10,
          y: y + h / 2 + 4,
          'text-anchor': 'end',
          class: row.strong ? 'label-strong' : '',
        }),
      );
      const total = row.values.reduce((a, b) => a + b, 0) || 1;
      let x = trackX;
      row.values.forEach((v, s) => {
        const segW = (v / max) * trackW;
        if (segW > 0.5) {
          const isLast = s === row.values.length - 1;
          const node = el('path', {
            d: barPath(x, y, Math.max(segW - (isLast ? 0 : 2), 1), h, isLast ? 4 : 0, 'right'),
            fill: segments[s].color,
          });
          node.addEventListener('pointerenter', (e) =>
            showTip(
              `<b>${row.label}</b><br>${segments[s].name}: <b>${formatValue(v)}</b> · ${Math.round(
                (v / total) * 100,
              )}%`,
              e.clientX,
              e.clientY,
            ),
          );
          node.addEventListener('pointerleave', hideTip);
          svg.append(node);
        }
        x += (v / max) * trackW;
      });
    });
    return svg;
  });
}

/* ------------------------------------------------------- divergierende Balken */

/** Balken um eine Nulllinie: blau = positiv, rot = negativ. */
export function divergingBars(container, opts) {
  const { rows, formatValue = (v) => v, rowHeight = 25, labelWidth = 132 } = opts;

  responsive(container, (width) => {
    const w = Math.max(280, width);
    const height = rows.length * rowHeight + 14;
    const trackX = labelWidth;
    const trackW = w - labelWidth - 48;
    const max = Math.max(0.1, ...rows.map((r) => Math.abs(r.value)));
    const mid = trackX + trackW / 2;
    const scale = (v) => (v / max) * (trackW / 2);

    const svg = el('svg', {
      class: 'chart',
      viewBox: `0 0 ${w} ${height}`,
      width: '100%',
      height,
      role: 'img',
    });

    svg.append(
      el('line', { class: 'axis-line', x1: mid, x2: mid, y1: 2, y2: height - 12 }),
    );

    rows.forEach((row, i) => {
      const y = i * rowHeight + 4;
      const h = rowHeight - 10;
      const len = Math.abs(scale(row.value));
      const positive = row.value >= 0;
      const x = positive ? mid : mid - len;
      svg.append(
        text(row.label, { x: trackX - 10, y: y + h / 2 + 4, 'text-anchor': 'end' }),
      );
      if (len > 0.5) {
        const d = positive
          ? barPath(x, y, len, h, 4, 'right')
          : `M${x + len} ${y}H${x + 4}a4 4 0 0 0 -4 4v${h - 8}a4 4 0 0 0 4 4h${len - 4}Z`;
        const node = el('path', { d, fill: positive ? 'var(--series-1)' : 'var(--bad)' });
        node.addEventListener('pointerenter', (e) =>
          showTip(`<b>${row.label}</b><br>${row.tip ?? formatValue(row.value)}`, e.clientX, e.clientY),
        );
        node.addEventListener('pointerleave', hideTip);
        svg.append(node);
      }
      svg.append(
        text(formatValue(row.value), {
          x: positive ? mid + len + 7 : mid - len - 7,
          y: y + h / 2 + 4,
          'text-anchor': positive ? 'start' : 'end',
          class: 'label-strong',
        }),
      );
    });
    return svg;
  });
}

/* ------------------------------------------------------------------ sparkline */

export function sparkline(values, { width = 74, height = 20, color = 'var(--series-1)' } = {}) {
  const svg = el('svg', { class: 'chart', viewBox: `0 0 ${width} ${height}`, width, height });
  if (!values.length) return svg;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const X = (i) => (i / Math.max(1, values.length - 1)) * (width - 4) + 2;
  const Y = (v) => height - 3 - ((v - min) / span) * (height - 6);
  svg.append(
    el('path', {
      d: values.map((v, i) => `${i ? 'L' : 'M'}${X(i)} ${Y(v)}`).join(''),
      fill: 'none',
      stroke: color,
      'stroke-width': 1.6,
      'stroke-linejoin': 'round',
      'stroke-linecap': 'round',
    }),
    el('circle', {
      cx: X(values.length - 1),
      cy: Y(values[values.length - 1]),
      r: 2.4,
      fill: color,
      stroke: 'var(--surface)',
      'stroke-width': 1.6,
    }),
  );
  return svg;
}
