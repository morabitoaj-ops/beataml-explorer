/* Genomics — oncoprint, co-mutation structure, mutation burden. */
import {
  db, filters, emitFilterChange, selection, VC_COLOR, VC_ORDER,
} from '../data.js';
import {
  h, el, fmt, fmtP, legend, tableView, histogram, heatmap, divScale,
  hoverable, showTip, hideTip, rampLegend, barPath,
} from '../charts.js';
import { tabIntro } from '../tabintro.js';

let nGenes = 25;

/* ELN risk is an ordered severity, so it takes the reserved status palette
   rather than categorical hues — and always ships with its text label. */
const ELN_COLOR = {
  Favorable: 'var(--status-good)',
  FavorableOrIntermediate: 'var(--status-good)',
  Intermediate: 'var(--status-warning)',
  IntermediateOrAdverse: 'var(--status-serious)',
  Adverse: 'var(--status-critical)',
};

function memoSort(patients, genes) {
  const rank = new Map();
  patients.forEach((p) => {
    const set = db.genesByPatient.get(p.id) || new Set();
    let key = '';
    for (const g of genes) key += set.has(g) ? '1' : '0';
    rank.set(p.id, key);
  });
  return patients.slice().sort((a, b) => {
    const ka = rank.get(a.id), kb = rank.get(b.id);
    if (ka !== kb) return ka < kb ? 1 : -1;
    return a.id - b.id;
  });
}

function oncoprint(card, sel, genes) {
  const pts = memoSort(sel.filter((p) => db.sequenced.has(p.id)), genes);
  if (!pts.length) { h('div', { class: 'empty', text: 'No sequenced patients in this slice.' }, card); return; }

  const cw = 5, gap = 1, rowH = 15, labelW = 122, pctW = 8;
  const trackH = 11, trackGap = 3;
  const tracks = [
    { key: 'eln', label: 'ELN 2017' },
    { key: 'flt3itd', label: 'FLT3-ITD' },
    { key: 'npm1c', label: 'NPM1 (clinical)' },
  ];
  const gridW = pts.length * cw;
  const gridH = genes.length * rowH;
  const totalW = labelW + gridW + pctW + 8;
  const totalH = gridH + 10 + tracks.length * (trackH + trackGap) + 22;

  const box = h('div', { class: 'scroll-x' }, card);
  const svg = el('svg', {
    width: totalW, height: totalH, class: 'wide', viewBox: `0 0 ${totalW} ${totalH}`, role: 'img',
    'aria-label': `Oncoprint of ${genes.length} genes across ${pts.length} patients`,
  }, box);
  const g = el('g', { transform: `translate(${labelW},0)` }, svg);

  // gene rows
  genes.forEach((gene, i) => {
    const carriers = db.mutByGene.get(gene) || new Set();
    let n = 0;
    for (const p of pts) if (carriers.has(p.id)) n++;
    // name and frequency both sit in the frozen left block, so they stay
    // readable however far the matrix is scrolled
    el('text', {
      x: -44, y: i * rowH + rowH / 2 + 3.5, 'text-anchor': 'end', class: 'axis-label',
      style: 'cursor:pointer', 'font-weight': filters.gene === gene ? 700 : 400,
    }, g).textContent = gene;
    el('text', {
      x: -7, y: i * rowH + rowH / 2 + 3.5, 'text-anchor': 'end', class: 'mark-label',
    }, g).textContent = `${(n / pts.length * 100).toFixed(0)}%`;

    // clickable label strip -> gene filter
    const lab = el('rect', { x: -labelW, y: i * rowH, width: labelW, height: rowH, class: 'hit' }, g);
    hoverable(lab, gene, () => [
      { value: fmt(n), label: `of ${pts.length} sequenced (${(n / pts.length * 100).toFixed(1)}%)` },
    ], () => { filters.gene = filters.gene === gene ? '' : gene; emitFilterChange(); });

    // background lane
    el('rect', {
      x: 0, y: i * rowH + 1, width: gridW, height: rowH - 2, fill: 'var(--wash)',
    }, g);
  });

  // cells
  pts.forEach((p, j) => {
    const muts = db.mutByPatient.get(p.id) || [];
    const byGene = new Map();
    for (const m of muts) {
      if (!byGene.has(m.g)) byGene.set(m.g, []);
      byGene.get(m.g).push(m);
    }
    genes.forEach((gene, i) => {
      const list = byGene.get(gene);
      if (!list) return;
      // one cell per gene; if a patient carries several classes, the most
      // functionally severe is drawn and all are listed in the tooltip
      const order = ['Truncating', 'In-frame indel', 'Missense', 'Other'];
      const grp = order.find((o) => list.some((m) => m.grp === o)) || 'Other';
      el('path', {
        d: barPath(j * cw, i * rowH + 2, cw - gap, rowH - 4, 1.5, 'right'),
        fill: VC_COLOR[grp],
      }, g);
    });
  });

  // per-patient hit columns (full height, so thin columns stay hittable)
  pts.forEach((p, j) => {
    const hit = el('rect', { x: j * cw - 1.5, y: 0, width: cw + 3, height: totalH, class: 'hit' }, g);
    hit.addEventListener('pointerenter', (e) => {
      const muts = db.mutByPatient.get(p.id) || [];
      const shown = muts.filter((m) => genes.includes(m.g));
      showTip(e, `Patient ${p.id}`, [
        { value: `${shown.length}`, label: `mutations in the ${genes.length} displayed genes` },
        { value: `${muts.length}`, label: 'total coding mutations' },
        { value: p.eln || '—', label: 'ELN 2017' },
        ...shown.slice(0, 8).map((m) => ({
          value: m.g, label: `${m.hp || m.c}`, color: VC_COLOR[m.grp],
        })),
        ...(shown.length > 8 ? [{ value: `+${shown.length - 8}`, label: 'more — click to open patient' }] : []),
      ]);
    });
    hit.addEventListener('pointermove', (e) => {
      const t = document.getElementById('tooltip');
      t.style.left = `${Math.min(e.clientX + 14, window.innerWidth - t.offsetWidth - 6)}px`;
      t.style.top = `${Math.min(e.clientY + 14, window.innerHeight - t.offsetHeight - 6)}px`;
    });
    hit.addEventListener('pointerleave', hideTip);
    hit.style.cursor = 'pointer';
    hit.addEventListener('click', () => {
      window.dispatchEvent(new CustomEvent('goto-patient', { detail: p.id }));
    });
  });

  // annotation tracks
  let ty = gridH + 10;
  for (const tr of tracks) {
    el('text', {
      x: -7, y: ty + trackH / 2 + 3.5, 'text-anchor': 'end', class: 'axis-label',
    }, g).textContent = tr.label;
    pts.forEach((p, j) => {
      const v = p[tr.key];
      let fill = 'var(--wash)';
      if (tr.key === 'eln') fill = ELN_COLOR[v] || 'var(--wash)';
      else if (v === true) fill = 'var(--series-1)';
      el('rect', {
        x: j * cw, y: ty, width: cw - gap, height: trackH, fill, rx: 1,
      }, g);
    });
    ty += trackH + trackGap;
  }
  el('text', { x: -7, y: ty + 10, 'text-anchor': 'end', class: 'axis-label' }, g)
    .textContent = `${pts.length} patients →`;

  const lg = h('div', { class: 'legend' }, card);
  for (const k of VC_ORDER) {
    const i = h('span', { class: 'item' }, lg);
    const sw = h('span', { class: 'swatch' }, i);
    sw.style.background = VC_COLOR[k];
    h('span', { text: k }, i);
  }
  const sep = h('span', { class: 'item', text: '│' }, lg);
  sep.style.color = 'var(--grid)';
  for (const [k, c] of [['Favorable', ELN_COLOR.Favorable], ['Intermediate', ELN_COLOR.Intermediate],
    ['Adverse', ELN_COLOR.Adverse], ['Marker positive', 'var(--series-1)']]) {
    const i = h('span', { class: 'item' }, lg);
    const sw = h('span', { class: 'swatch' }, i);
    sw.style.background = c;
    h('span', { text: k }, i);
  }
  return pts;
}

export function render(root) {
  root.textContent = '';
  tabIntro(root, 'genetics');
  const sel = selection();
  const ids = new Set(sel.map((p) => p.id));
  const seqCount = sel.filter((p) => db.sequenced.has(p.id)).length;

  // rank genes within the current slice, then take the top N
  const ranked = db.geneFreq.map(({ gene }) => {
    let n = 0;
    for (const pid of db.mutByGene.get(gene)) if (ids.has(pid)) n++;
    return { gene, n };
  }).filter((d) => d.n > 0).sort((a, b) => b.n - a.n);
  const genes = ranked.slice(0, nGenes).map((d) => d.gene);

  // ---------------------------------------------------------------- oncoprint
  {
    const c = h('div', { class: 'card' }, root);
    const head = h('div', { style: 'display:flex;gap:12px;align-items:baseline;flex-wrap:wrap' }, c);
    h('h3', { text: 'Oncoprint', style: 'margin:0' }, head);
    h('span', {
      class: 'hint', style: 'margin:0',
      text: `${seqCount} patients whose DNA was read. One column per patient, one row per gene — a coloured block means that gene was broken. Click a column to open that patient, or a gene name to narrow the site to people who have it.`,
    }, head);
    const spacer = h('span', { style: 'flex:1' }, head);
    const sel2 = h('select', { style: 'font:inherit;font-size:12px;padding:3px 6px;border-radius:6px;border:1px solid var(--border);background:var(--plane);color:var(--text-primary)' }, head);
    for (const n of [10, 15, 25, 40]) {
      const o = h('option', { value: String(n), text: `top ${n} genes` }, sel2);
      if (n === nGenes) o.selected = true;
    }
    sel2.addEventListener('change', () => { nGenes = +sel2.value; render(root); });

    if (!genes.length) h('div', { class: 'empty', text: 'No mutations in this slice.' }, c);
    else oncoprint(c, sel, genes);

    tableView(c, [
      { key: 'gene', label: 'Gene' },
      { key: 'n', label: 'Patients mutated' },
      { key: 'pct', label: '% of sequenced', fmt: (v) => `${v.toFixed(1)}%` },
    ], ranked.map((d) => ({ ...d, pct: d.n / Math.max(1, seqCount) * 100 })), { label: 'gene frequency table' });
  }

  const g2 = h('div', { class: 'grid c2', style: 'margin-top:14px' }, root);

  // ------------------------------------------------- co-occurrence heatmap
  {
    const c = h('div', { class: 'card' }, g2);
    h('h3', { text: 'Which broken genes travel together' }, c);
    h('p', {
      class: 'hint',
      text: 'Log2 odds ratio from Fisher exact tests on the full cohort (not the current slice). Red = co-occurring, blue = mutually exclusive. A dot marks q < 0.05.',
    }, c);

    const top = db.topGenes.slice(0, 18);
    const lookup = new Map();
    for (const pr of db.pairs) lookup.set(`${pr.a}|${pr.b}`, pr);
    const get = (a, b) => lookup.get(`${a}|${b}`) || lookup.get(`${b}|${a}`);
    const scale = divScale(3);

    const cell = 17, labelW = 78, colH = 82;
    const width = labelW + top.length * cell + 10;
    const height = colH + top.length * cell + 8;
    const box = h('div', { class: 'scroll-x' }, c);
    const svg = el('svg', { width, height, class: 'wide', viewBox: `0 0 ${width} ${height}`, role: 'img' }, box);
    const g = el('g', { transform: `translate(${labelW},${colH})` }, svg);

    top.forEach((gn, j) => {
      el('text', {
        transform: `translate(${j * cell + cell / 2 + 3.5},-6) rotate(-90)`,
        class: 'axis-label', 'text-anchor': 'start',
      }, g).textContent = gn;
    });
    top.forEach((gn, i) => {
      el('text', {
        x: -7, y: i * cell + cell / 2 + 3.5, 'text-anchor': 'end', class: 'axis-label',
      }, g).textContent = gn;
    });

    top.forEach((a, i) => top.forEach((b, j) => {
      if (i === j) {
        el('rect', { x: j * cell + 1, y: i * cell + 1, width: cell - 2, height: cell - 2, rx: 2, fill: 'var(--wash)' }, g);
        return;
      }
      const pr = get(a, b);
      const lor = pr && pr.or ? Math.log2(Math.max(0.03, pr.or)) : 0;
      const node = el('rect', {
        x: j * cell + 1, y: i * cell + 1, width: cell - 2, height: cell - 2, rx: 2,
        fill: pr ? scale(lor) : 'var(--wash)',
      }, g);
      if (pr && pr.q < 0.05) {
        el('circle', {
          cx: j * cell + cell / 2, cy: i * cell + cell / 2, r: 2,
          fill: 'var(--text-primary)', 'fill-opacity': 0.75,
        }, g);
      }
      hoverable(node, `${a} × ${b}`, () => [
        { value: pr ? fmt(pr.both) : '0', label: 'patients with both' },
        { value: pr && pr.or != null ? fmt(pr.or, 2) : '—', label: 'odds ratio' },
        { value: pr ? fmtP(pr.q) : '—', label: 'q (BH-adjusted)' },
        { value: pr ? (pr.dir === 'co' ? 'co-occurring' : 'mutually exclusive') : '—', label: '' },
      ]);
    }));

    const lgw = h('div', { style: 'display:flex;gap:16px;align-items:center;flex-wrap:wrap;margin-top:6px' }, c);
    rampLegend(lgw, scale, [-3, 3], '', (v) => (v > 0 ? `+${v}` : `${v}`));
    h('span', { class: 'hint', style: 'margin:0', text: 'log2 odds ratio · exclusive ← → co-occurring' }, lgw);

    const sig = db.pairs.filter((p) => p.q < 0.05).sort((a, b) => a.q - b.q);
    tableView(c, [
      { key: 'a', label: 'Gene A' }, { key: 'b', label: 'Gene B' },
      { key: 'both', label: 'Both' },
      { key: 'or', label: 'Odds ratio', fmt: (v) => (v == null ? '—' : v.toFixed(2)) },
      { key: 'q', label: 'q', fmt: (v) => fmtP(v) },
      { key: 'dir', label: 'Direction', fmt: (v) => (v === 'co' ? 'co-occurring' : 'exclusive') },
    ], sig, { label: `${sig.length} significant pairs` });
  }

  // ---------------------------------------------------- mutation burden
  {
    const c = h('div', { class: 'card' }, g2);
    h('h3', { text: 'How many genes were broken per person' }, c);
    h('p', {
      class: 'hint',
      text: 'Some patients had more of their DNA read than others, so the long tail is partly about testing depth, not just biology.',
    }, c);
    const burden = sel.filter((p) => db.sequenced.has(p.id))
      .map((p) => (db.mutByPatient.get(p.id) || []).length);
    histogram(c, burden, { bins: 24, xLabel: 'Mutations called' });

    const sorted = burden.slice().sort((a, b) => a - b);
    tableView(c, [{ key: 'stat', label: 'Statistic' }, { key: 'v', label: 'Mutations' }], [
      { stat: 'Patients', v: burden.length },
      { stat: 'Median', v: sorted[Math.floor(sorted.length / 2)] ?? '—' },
      { stat: 'Mean', v: burden.length ? (burden.reduce((a, b) => a + b, 0) / burden.length).toFixed(1) : '—' },
      { stat: 'Maximum', v: sorted[sorted.length - 1] ?? '—' },
    ], { label: 'summary' });
  }

  // ------------------------------------------------------- variant classes
  {
    const c = h('div', { class: 'card' }, g2);
    h('h3', { text: 'Kinds of damage found' }, c);
    h('p', { class: 'hint', text: 'What each colour in the grid above actually means' }, c);
    const m = new Map();
    for (const p of sel) {
      for (const mu of db.mutByPatient.get(p.id) || []) {
        const k = `${mu.grp}|${mu.c}`;
        m.set(k, (m.get(k) || 0) + 1);
      }
    }
    const rows = [...m.entries()].map(([k, n]) => {
      const [grp, detail] = k.split('|');
      return { grp, detail, n };
    }).sort((a, b) => b.n - a.n);
    const total = rows.reduce((s, r) => s + r.n, 0) || 1;

    const svgw = h('div', {}, c);
    const W = 420, RH = 24;
    const svg = el('svg', { width: '100%', style: `max-width:${W}px`, viewBox: `0 0 ${W} ${rows.length * RH + 8}`, role: 'img' }, svgw);
    const maxN = Math.max(...rows.map((r) => r.n), 1);
    const xs = d3.scaleLinear().domain([0, maxN]).range([0, W - 200]);
    rows.forEach((r, i) => {
      const y = i * RH + 4;
      el('text', { x: 120, y: y + 13, 'text-anchor': 'end', class: 'axis-label' }, svg)
        .textContent = r.detail;
      const w = Math.max(1, xs(r.n));
      el('path', { d: barPath(128, y + 3, w, 14, 4, 'right'), fill: VC_COLOR[r.grp] }, svg);
      el('text', { x: 128 + w + 7, y: y + 14, class: 'mark-label' }, svg)
        .textContent = `${fmt(r.n)} (${(r.n / total * 100).toFixed(1)}%)`;
      const hit = el('rect', { x: 0, y: i * RH, width: W, height: RH, class: 'hit' }, svg);
      hoverable(hit, r.detail, () => [
        { value: fmt(r.n), label: 'variants', color: VC_COLOR[r.grp] },
        { value: r.grp, label: 'oncoprint class' },
      ]);
    });
    legend(c, VC_ORDER.map((k) => ({ label: k, color: VC_COLOR[k] })));
    tableView(c, [
      { key: 'detail', label: 'Consequence' }, { key: 'grp', label: 'Class' },
      { key: 'n', label: 'Variants' },
    ], rows);
  }
}
