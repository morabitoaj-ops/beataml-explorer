/* Per-patient view — clinical picture, mutations, and this patient's drug
   response placed against the cohort. */
import {
  db, selection, VC_COLOR, VC_ORDER, aucPercentile, auc, ic50,
  ensureFits, ensureExpr, loadDose, curveFit, exprZ, exprValue,
} from '../data.js';
import {
  h, el, fmt, fmtP, legend, tableView, hoverable, barPath, histogram, seqScale,
  showTip, hideTip, ordinal,
} from '../charts.js';
import { doseCurve } from '../charts2.js';
import { tabIntro } from '../tabintro.js';

let current = null;
let drugMode = 'sensitive';

export function setPatient(id) { current = id; }

function pill(parent, eln) {
  const cls = eln === 'Adverse' ? 'adverse'
    : eln === 'Favorable' ? 'favorable'
      : eln === 'Intermediate' ? 'intermediate' : '';
  return h('span', { class: `pill ${cls}`, text: eln || 'ELN not assigned' }, parent);
}

function kv(parent, pairs) {
  const dl = h('dl', { class: 'kv' }, parent);
  for (const [k, v] of pairs) {
    h('dt', { text: k }, dl);
    h('dd', { text: v == null || v === '' ? '—' : String(v) }, dl);
  }
  return dl;
}

/* --------------------------------------------------------------- lollipop */
function lollipops(card, muts) {
  const byGene = new Map();
  for (const m of muts) {
    if (!byGene.has(m.g)) byGene.set(m.g, []);
    byGene.get(m.g).push(m);
  }
  const genes = [...byGene.entries()].sort((a, b) => b[1].length - a[1].length);
  if (!genes.length) { h('div', { class: 'empty', text: 'No coding mutations called for this patient.' }, card); return; }

  const W = 620, ROW = 66, PAD_L = 82, PAD_R = 46;
  const svg = el('svg', {
    width: '100%', style: `max-width:${W}px`, viewBox: `0 0 ${W} ${genes.length * ROW + 14}`, role: 'img',
    'aria-label': 'Mutation positions along each protein, stem height showing variant allele fraction',
  }, card);

  genes.forEach(([gene, list], i) => {
    const y0 = i * ROW + 10;
    const trackY = y0 + 44;          // protein backbone
    const plen = Math.max(...list.map((m) => m.plen || 0), 100);
    const x = d3.scaleLinear().domain([0, plen]).range([PAD_L, W - PAD_R]);

    el('text', { x: PAD_L - 9, y: trackY + 4, 'text-anchor': 'end', class: 'axis-label', 'font-weight': 600 }, svg)
      .textContent = gene;

    // backbone
    el('rect', { x: PAD_L, y: trackY - 3, width: W - PAD_R - PAD_L, height: 6, rx: 3, fill: 'var(--grid)' }, svg);
    el('text', { x: W - PAD_R + 6, y: trackY + 4, class: 'axis-label' }, svg)
      .textContent = list[0].plen ? `${plen} aa` : '';

    // stems: height encodes VAF
    const vafH = d3.scaleLinear().domain([0, 1]).range([0, 32]);
    list.forEach((m) => {
      const px = m.pp != null ? x(m.pp) : PAD_L + (W - PAD_R - PAD_L) / 2;
      const hgt = vafH(m.vaf ?? 0.3);
      el('line', {
        x1: px, x2: px, y1: trackY - 3, y2: trackY - 3 - hgt,
        stroke: 'var(--axis)', 'stroke-width': 1,
      }, svg);
      // 2px surface ring keeps overlapping heads legible
      el('circle', {
        cx: px, cy: trackY - 3 - hgt, r: 5.5,
        fill: VC_COLOR[m.grp], stroke: 'var(--surface-1)', 'stroke-width': 2,
      }, svg);
      const hit = el('circle', { cx: px, cy: trackY - 3 - hgt, r: 13, class: 'hit' }, svg);
      hoverable(hit, `${gene} ${m.hp || ''}`.trim(), () => [
        { value: m.c, label: 'consequence', color: VC_COLOR[m.grp] },
        { value: m.vaf == null ? '—' : `${(m.vaf * 100).toFixed(0)}%`, label: 'variant allele fraction' },
        { value: m.pp == null ? '—' : `${m.pp}${m.plen ? ` / ${m.plen}` : ''}`, label: 'codon' },
        { value: `chr${m.chr}:${fmt(m.pos)}`, label: `${m.ref}>${m.alt}` },
        { value: m.rd == null ? '—' : fmt(m.rd), label: 'read depth' },
        ...(m.cos ? [{ value: 'In COSMIC', label: '' }] : []),
      ]);
    });

    // label the highest-VAF variant directly; the rest live in the tooltip/table
    const top = list.slice().sort((a, b) => (b.vaf ?? 0) - (a.vaf ?? 0))[0];
    if (top && top.hp) {
      const px = top.pp != null ? x(top.pp) : PAD_L + (W - PAD_R - PAD_L) / 2;
      const hgt = vafH(top.vaf ?? 0.3);
      el('text', {
        x: Math.min(px, W - PAD_R - 4), y: trackY - 3 - hgt - 10,
        'text-anchor': px > W - 140 ? 'end' : 'middle', class: 'mark-label',
      }, svg).textContent = top.hp;
    }
  });

  const foot = h('div', { class: 'hint', style: 'margin-top:6px' }, card);
  foot.textContent = 'Stem height = variant allele fraction (0–100%). Position along the bar = codon within the protein.';
  legend(card, VC_ORDER.map((k) => ({ label: k, color: VC_COLOR[k] })));
}

/* ------------------------------------------------------------ drug profile */
function drugProfile(card, pid) {
  if (!db.drugPtIndex.has(pid)) {
    h('div', { class: 'empty', text: 'This patient has no ex vivo drug screen.' }, card);
    return;
  }
  const rows = [];
  for (const d of db.drug.drugs) {
    const v = auc(pid, d.name);
    if (v == null) continue;
    rows.push({
      drug: d.name, family: d.family || '—', auc: v,
      pct: aucPercentile(v, d), med: d.med, ic50: ic50(pid, d.name), n: d.n,
    });
  }
  if (!rows.length) { h('div', { class: 'empty', text: 'No fitted curves for this patient.' }, card); return; }

  const sorted = rows.slice().sort((a, b) => (drugMode === 'sensitive' ? a.pct - b.pct : b.pct - a.pct));
  const top = sorted.slice(0, 18);

  const head = h('div', { style: 'display:flex;gap:10px;align-items:center;margin-bottom:8px;flex-wrap:wrap' }, card);
  h('span', { class: 'hint', style: 'margin:0', text: `${rows.length} inhibitors tested on this patient` }, head);
  h('span', { style: 'flex:1' }, head);
  const btnS = h('button', { class: `btn ${drugMode === 'sensitive' ? 'primary' : ''}`, type: 'button', text: 'Most sensitive' }, head);
  const btnR = h('button', { class: `btn ${drugMode === 'resistant' ? 'primary' : ''}`, type: 'button', text: 'Most resistant' }, head);
  btnS.addEventListener('click', () => { drugMode = 'sensitive'; render(card.closest('.view')); });
  btnR.addEventListener('click', () => { drugMode = 'resistant'; render(card.closest('.view')); });

  // percentile bars: 0 = most sensitive patient in the cohort for that drug
  const W = 620, ROW = 24, LAB = 190, RIGHT = 92;
  const svg = el('svg', { width: '100%', style: `max-width:${W}px`, viewBox: `0 0 ${W} ${top.length * ROW + 26}`, role: 'img' }, card);
  const x = d3.scaleLinear().domain([0, 100]).range([LAB, W - RIGHT]);
  const ramp = seqScale([100, 0]); // dark = low percentile = sensitive

  for (const t of [0, 25, 50, 75, 100]) {
    el('line', { x1: x(t), x2: x(t), y1: 12, y2: top.length * ROW + 12, class: 'gridline' }, svg);
    el('text', { x: x(t), y: 8, 'text-anchor': 'middle', class: 'axis-label' }, svg).textContent = `${t}`;
  }
  el('text', { x: (x(0) + x(100)) / 2, y: top.length * ROW + 24, 'text-anchor': 'middle', class: 'axis-title' }, svg)
    .textContent = 'Percentile of this patient’s AUC within the cohort (0 = most sensitive)';

  top.forEach((r, i) => {
    const y = i * ROW + 14;
    el('text', { x: LAB - 9, y: y + 12, 'text-anchor': 'end', class: 'axis-label' }, svg)
      .textContent = r.drug.length > 26 ? `${r.drug.slice(0, 25)}…` : r.drug;
    const w = Math.max(2, x(r.pct) - x(0));
    el('path', { d: barPath(x(0), y + 3, w, 15, 4, 'right'), fill: ramp(r.pct) }, svg);
    el('text', { x: W - RIGHT + 7, y: y + 15, class: 'mark-label' }, svg)
      .textContent = `AUC ${fmt(r.auc, 0)}`;
    const hit = el('rect', { x: 0, y, width: W, height: ROW, class: 'hit' }, svg);
    hoverable(hit, r.drug, () => [
      { value: fmt(r.auc, 1), label: 'this patient’s AUC' },
      { value: fmt(r.med, 1), label: `cohort median (n=${r.n})` },
      { value: ordinal(r.pct), label: 'percentile (lower = more sensitive)' },
      { value: r.ic50 == null ? '—' : `${r.ic50} µM`, label: 'IC50' },
      { value: r.family, label: 'target family' },
    ]);
  });

  tableView(card, [
    { key: 'drug', label: 'Inhibitor' },
    { key: 'family', label: 'Target family' },
    { key: 'auc', label: 'AUC', fmt: (v) => fmt(v, 1) },
    { key: 'med', label: 'Cohort median', fmt: (v) => fmt(v, 1) },
    { key: 'pct', label: 'Percentile', fmt: (v) => `${v.toFixed(0)}` },
    { key: 'ic50', label: 'IC50 (µM)', fmt: (v) => (v == null ? '—' : String(v)) },
  ], rows, { label: 'all inhibitor results' });
}

/* ------------------------------------------------- dose-response curves */
function doseCurves(card, pid) {
  const box = h('div', {}, card);
  h('div', { class: 'hint', text: 'Loading measured dose–response points…' }, box);

  Promise.all([ensureFits(), loadDose(pid)]).then(([, measured]) => {
    box.textContent = '';
    const rows = [];
    for (const d of db.drug.drugs) {
      const v = auc(pid, d.name);
      const fit = curveFit(pid, d.name);
      if (v == null || !fit) continue;
      rows.push({ drug: d.name, auc: v, pct: aucPercentile(v, d), fit, meta: d });
    }
    if (!rows.length) {
      h('div', { class: 'empty', text: 'No converged curve fits for this patient.' }, box);
      return;
    }
    rows.sort((a, b) => a.auc - b.auc);
    const show = rows.slice(0, 12);

    const grid = h('div', {
      style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:12px;margin-top:4px',
    }, box);
    for (const r of show) {
      const cell = h('div', {}, grid);
      const head = h('div', { style: 'display:flex;justify-content:space-between;align-items:baseline;gap:6px' }, cell);
      h('b', { style: 'font-size:12.5px', text: r.drug.length > 24 ? `${r.drug.slice(0, 23)}…` : r.drug }, head);
      h('span', { class: 'hint', style: 'margin:0', text: `AUC ${fmt(r.auc, 0)}` }, head);
      doseCurve(cell, [{
        label: 'this patient', color: 'var(--series-1)',
        intercept: r.fit.intercept, beta: r.fit.beta,
        points: (measured[r.drug] || []),
      }], {
        width: 280, height: 180, conc: r.fit.conc, shadeAuc: true, compact: true,
      });
      h('div', {
        class: 'hint', style: 'margin:2px 0 0',
        text: `${ordinal(r.pct)} percentile · cohort median AUC ${fmt(r.meta.med, 0)}`,
      }, cell);
    }
    h('p', {
      class: 'hint', style: 'margin-top:10px',
      text: 'Line = the probit model fitted in the release; dots = the measured normalised viability at each '
        + 'tested concentration. Shaded area is the AUC quoted everywhere else in this app — that is literally '
        + 'what the number means.',
    }, box);

    tableView(box, [
      { key: 'drug', label: 'Inhibitor' },
      { key: 'auc', label: 'AUC', fmt: (v) => fmt(v, 1) },
      { key: 'pct', label: 'Percentile', fmt: (v) => v.toFixed(0) },
      { key: 'ic50', label: 'IC50 (µM)', fmt: (v) => (v == null ? '—' : String(v)) },
      { key: 'npts', label: 'Measured points' },
    ], rows.map((r) => ({
      drug: r.drug, auc: r.auc, pct: r.pct, ic50: ic50(pid, r.drug),
      npts: (measured[r.drug] || []).length,
    })), { label: `all ${rows.length} fitted curves` });
  }).catch((e) => {
    box.textContent = '';
    h('div', { class: 'empty', text: `Could not load curve data: ${e.message}` }, box);
  });
}

/* ------------------------------------- genotype -> drug evidence for this patient */
function implications(card, pid) {
  const mutated = db.genesByPatient.get(pid) || new Set();
  const p = db.byId.get(pid);
  const markers = new Set([...mutated]);
  if (p.flt3itd) markers.add('FLT3-ITD');
  if (p.npm1c) markers.add('NPM1 (clinical)');
  if (p.tp53c) markers.add('TP53 (clinical)');

  // 1. cohort associations whose marker this patient carries
  const evidence = new Map();
  for (const a of db.drug.assoc) {
    if (a.q >= 0.05 || !markers.has(a.marker)) continue;
    const v = auc(pid, a.drug);
    const meta = db.drug.drugs[db.drugNameIndex.get(a.drug)];
    const key = a.drug;
    const prev = evidence.get(key);
    const rec = {
      drug: a.drug, marker: a.marker, delta: a.delta, q: a.q,
      auc: v, pct: v == null ? null : aucPercentile(v, meta),
      family: meta?.family || '—',
      why: `${a.marker} carriers are ${a.delta < 0 ? 'more' : 'less'} sensitive (Δ ${a.delta > 0 ? '+' : ''}${a.delta} AUC)`,
      direction: a.delta < 0 ? 'sensitising' : 'resistance',
    };
    if (!prev || Math.abs(a.delta) > Math.abs(prev.delta)) evidence.set(key, rec);
  }

  // 2. drugs that directly target a gene this patient has mutated
  const targeted = [];
  for (const d of db.drug.drugs) {
    const hits = (d.targets || []).filter((t) => mutated.has(t));
    if (!hits.length) continue;
    const v = auc(pid, d.name);
    targeted.push({
      drug: d.name, genes: hits.join(', '), family: d.family || '—',
      auc: v, pct: v == null ? null : aucPercentile(v, d),
    });
  }

  const byPct = (a, b) => (a.pct ?? 999) - (b.pct ?? 999);
  const sensitising = [...evidence.values()].filter((e) => e.direction === 'sensitising').sort(byPct);
  const resistance = [...evidence.values()].filter((e) => e.direction === 'resistance')
    .sort((a, b) => a.q - b.q);
  // the target list can run to dozens of same-family inhibitors; show the ones
  // this patient actually responded to and leave the rest to the table
  targeted.sort(byPct);
  const targetedShown = targeted.slice(0, 8);
  const targetedRest = targeted.length - targetedShown.length;

  if (!sensitising.length && !resistance.length && !targeted.length) {
    h('div', {
      class: 'empty',
      text: 'None of this patient’s mutations match a significant cohort association or a drug target in the panel.',
    }, card);
    return;
  }

  const carried = [...markers].filter((m) => db.drug.assoc.some((a) => a.marker === m && a.q < 0.05));
  h('p', {
    class: 'hint',
    text: carried.length
      ? `Markers this patient carries that have a significant cohort association: ${carried.join(', ')}.`
      : 'This patient carries no marker with a significant cohort-level drug association.',
  }, card);

  const renderList = (title, list, tone) => {
    if (!list.length) return;
    h('div', {
      style: 'font-size:12px;font-weight:650;margin:12px 0 4px;color:var(--text-secondary)',
      text: title,
    }, card);
    for (const e of list) {
      const row = h('div', {
        style: 'display:flex;gap:10px;align-items:baseline;padding:6px 0;border-bottom:1px solid var(--grid)',
      }, card);
      const dot = h('span', {}, row);
      dot.style.cssText = `width:8px;height:8px;border-radius:50%;flex:none;background:${tone}`;
      h('b', { style: 'min-width:170px;font-size:12.5px', text: e.drug }, row);
      h('span', { class: 'hint', style: 'margin:0;flex:1', text: e.why || `targets ${e.genes}` }, row);
      const obs = h('span', { style: 'font-size:12.5px;white-space:nowrap' }, row);
      if (e.auc == null) {
        obs.textContent = 'not screened';
        obs.style.color = 'var(--text-muted)';
      } else {
        obs.textContent = `AUC ${fmt(e.auc, 0)} · ${ordinal(e.pct)} pct`;
        obs.style.color = e.pct < 25 ? 'var(--status-good)'
          : e.pct > 75 ? 'var(--status-critical)' : 'var(--text-secondary)';
      }
    }
  };

  renderList('Cohort evidence points to sensitivity', sensitising, 'var(--series-1)');
  renderList('Cohort evidence points to resistance', resistance, 'var(--series-2)');
  renderList(
    targetedRest > 0
      ? `Directly targets a gene mutated in this patient — 8 most sensitive of ${targeted.length}`
      : 'Directly targets a gene mutated in this patient',
    targetedShown, 'var(--series-3)',
  );

  h('p', {
    class: 'hint', style: 'margin-top:10px',
    text: 'Colour on the right compares this patient with the cohort for that drug: green = in the most sensitive '
      + 'quartile, red = the most resistant. Association direction comes from the whole cohort; the AUC is this '
      + 'patient’s own measurement, so the two can disagree — that disagreement is the interesting part.',
  }, card);

  tableView(card, [
    { key: 'drug', label: 'Inhibitor' },
    { key: 'basis', label: 'Basis' },
    { key: 'delta', label: 'Cohort Δ AUC', fmt: (v) => (v == null ? '—' : (v > 0 ? `+${v}` : String(v))) },
    { key: 'q', label: 'q', fmt: (v) => (v == null ? '—' : fmtP(v)) },
    { key: 'auc', label: 'This patient AUC', fmt: (v) => (v == null ? 'not screened' : fmt(v, 1)) },
    { key: 'pct', label: 'Percentile', fmt: (v) => (v == null ? '—' : v.toFixed(0)) },
  ], [
    ...[...evidence.values()].map((e) => ({ ...e, basis: `${e.marker} association` })),
    ...targeted.map((t) => ({ ...t, basis: `targets ${t.genes}`, delta: null, q: null })),
  ], { label: 'evidence table' });
}

/* ------------------------------------------------- expression for this patient */
function exprPanel(card, pid) {
  const box = h('div', {}, card);
  h('div', { class: 'hint', text: 'Loading expression…' }, box);
  ensureExpr().then(() => {
    box.textContent = '';
    if (!db.exprPt.has(pid)) {
      h('div', { class: 'empty', text: 'This patient has no RNA-seq sample in the release.' }, box);
      return;
    }
    const mutated = [...(db.genesByPatient.get(pid) || new Set())];
    const targets = new Set();
    for (const d of db.drug.drugs) for (const t of d.targets || []) targets.add(t);

    const rows = [];
    for (const g of new Set([...mutated, ...db.topGenes])) {
      const z = exprZ(pid, g);
      if (z == null) continue;
      rows.push({
        gene: g, z, value: exprValue(pid, g),
        mutated: mutated.includes(g), target: targets.has(g),
      });
    }
    if (!rows.length) {
      h('div', { class: 'empty', text: 'None of this patient’s genes are in the expression panel.' }, box);
      return;
    }
    rows.sort((a, b) => b.z - a.z);
    const show = rows.slice(0, 9).concat(rows.slice(-9)).filter((v, i, arr) => arr.indexOf(v) === i);

    const W = 440, ROW = 20, LAB = 92;
    const svg = el('svg', {
      width: '100%', style: `max-width:${W}px`,
      viewBox: `0 0 ${W} ${show.length * ROW + 30}`, role: 'img',
    }, box);
    const x = d3.scaleLinear().domain([-3, 3]).clamp(true).range([LAB, W - 44]);
    for (const t of [-3, -2, -1, 0, 1, 2, 3]) {
      el('line', {
        x1: x(t), x2: x(t), y1: 14, y2: show.length * ROW + 14,
        class: t === 0 ? 'baseline' : 'gridline',
      }, svg);
      el('text', { x: x(t), y: 9, 'text-anchor': 'middle', class: 'axis-label' }, svg)
        .textContent = `${t}`;
    }
    show.forEach((r, i) => {
      const y = i * ROW + 14 + ROW / 2;
      el('text', {
        x: LAB - 8, y: y + 3.5, 'text-anchor': 'end', class: 'axis-label',
        'font-weight': r.mutated ? 700 : 400,
      }, svg).textContent = r.gene;
      el('line', {
        x1: x(0), x2: x(r.z), y1: y, y2: y, stroke: 'var(--axis)', 'stroke-width': 1.5,
      }, svg);
      el('circle', {
        cx: x(r.z), cy: y, r: 4.5,
        fill: r.mutated ? 'var(--series-2)' : 'var(--series-1)',
        stroke: 'var(--surface-1)', 'stroke-width': 2,
      }, svg);
      const hit = el('rect', { x: 0, y: i * ROW + 14, width: W, height: ROW, class: 'hit' }, svg);
      hoverable(hit, r.gene, () => [
        { value: `${r.z > 0 ? '+' : ''}${r.z.toFixed(2)}`, label: 'z-score vs cohort' },
        { value: fmt(r.value, 2), label: 'normalised log2 expression' },
        { value: r.mutated ? 'mutated in this patient' : 'not mutated', label: '' },
        ...(r.target ? [{ value: 'druggable target in this panel', label: '' }] : []),
      ]);
    });
    el('text', {
      x: (x(-3) + x(3)) / 2, y: show.length * ROW + 27, 'text-anchor': 'middle', class: 'axis-title',
    }, svg).textContent = 'Expression z-score vs the RNA-seq cohort';

    legend(box, [
      { label: 'Mutated in this patient', color: 'var(--series-2)' },
      { label: 'Not mutated', color: 'var(--series-1)' },
    ]);
    tableView(box, [
      { key: 'gene', label: 'Gene' },
      { key: 'z', label: 'z-score', fmt: (v) => `${v > 0 ? '+' : ''}${v.toFixed(2)}` },
      { key: 'value', label: 'log2 expression', fmt: (v) => fmt(v, 2) },
      { key: 'mut', label: 'Mutated' },
      { key: 'tgt', label: 'Drug target' },
    ], rows.map((r) => ({ ...r, mut: r.mutated ? 'yes' : '—', tgt: r.target ? 'yes' : '—' })),
    { label: 'all genes in panel' });
  });
}

/* ---------------------------------------------------------- similar cases */
function similarPatients(card, pid) {
  const mine = db.genesByPatient.get(pid);
  if (!mine || !mine.size) {
    h('div', { class: 'empty', text: 'No mutations to match on.' }, card);
    return;
  }
  const scored = [];
  for (const [other, genes] of db.genesByPatient) {
    if (other === pid) continue;
    let inter = 0;
    for (const g of mine) if (genes.has(g)) inter++;
    if (!inter) continue;
    const union = mine.size + genes.size - inter;
    const p = db.byId.get(other);
    if (!p) continue;
    scored.push({
      id: other, shared: inter, jaccard: inter / union,
      genes: [...mine].filter((g) => genes.has(g)).join(', '),
      eln: p.eln || '—', os: p.os, vital: p.vital || '—',
    });
  }
  scored.sort((a, b) => b.jaccard - a.jaccard || b.shared - a.shared);
  const top = scored.slice(0, 12);
  if (!top.length) { h('div', { class: 'empty', text: 'No other patient shares a mutated gene.' }, card); return; }

  const list = h('div', {}, card);
  for (const s of top) {
    const row = h('div', {
      style: 'display:flex;gap:10px;align-items:baseline;padding:6px 0;border-bottom:1px solid var(--grid);cursor:pointer',
    }, list);
    row.addEventListener('click', () => {
      current = s.id;
      render(card.closest('.view'));
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
    h('b', { text: `Patient ${s.id}`, style: 'min-width:110px' }, row);
    h('span', { class: 'hint', style: 'margin:0;flex:1', text: s.genes }, row);
    h('span', { class: 'hint', style: 'margin:0', text: `${s.shared} shared · ${(s.jaccard * 100).toFixed(0)}% similarity` }, row);
  }
  tableView(card, [
    { key: 'id', label: 'Patient' },
    { key: 'shared', label: 'Shared genes' },
    { key: 'jaccard', label: 'Jaccard', fmt: (v) => v.toFixed(3) },
    { key: 'genes', label: 'Genes in common' },
    { key: 'eln', label: 'ELN' },
    { key: 'os', label: 'OS (days)', fmt: (v) => (v == null ? '—' : fmt(v)) },
    { key: 'vital', label: 'Vital status' },
  ], scored, { label: 'all overlapping patients' });
}

/* ------------------------------------------------------------------ view */
export function render(root) {
  root.textContent = '';
  tabIntro(root, 'patient');
  const sel = selection();
  if (!sel.length) { h('div', { class: 'empty', text: 'No patients match the current filters.' }, root); return; }
  if (current == null || !sel.some((p) => p.id === current)) {
    // open on a patient who actually has both data types, so the view is not
    // empty on first load
    const rich = sel.find((p) => db.drugPtIndex.has(p.id) && (db.mutByPatient.get(p.id) || []).length);
    current = (rich || sel[0]).id;
  }
  const p = db.byId.get(current);
  const muts = (db.mutByPatient.get(current) || []).slice()
    .sort((a, b) => (b.vaf ?? 0) - (a.vaf ?? 0));

  // ---- picker
  const bar = h('div', { class: 'card', style: 'display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap' }, root);
  const gsel = h('div', { class: 'fgroup', style: 'display:flex;flex-direction:column;gap:3px' }, bar);
  h('label', { text: 'Patient', style: 'font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;color:var(--text-muted);font-weight:600' }, gsel);
  const picker = h('select', { style: 'font:inherit;font-size:13px;padding:5px 8px;border-radius:7px;border:1px solid var(--border);background:var(--plane);color:var(--text-primary);min-width:290px' }, gsel);
  for (const q of sel) {
    const n = (db.mutByPatient.get(q.id) || []).length;
    const o = h('option', {
      value: String(q.id),
      text: `Patient ${q.id} · ${q.age ?? '?'}y ${q.sex ? q.sex[0] : '?'} · ${q.eln || 'no ELN'} · ${n} mut`,
    }, picker);
    if (q.id === current) o.selected = true;
  }
  picker.addEventListener('change', () => { current = +picker.value; render(root); });

  const idx = sel.findIndex((q) => q.id === current);
  const prev = h('button', { class: 'btn', type: 'button', text: '← Previous' }, bar);
  const next = h('button', { class: 'btn', type: 'button', text: 'Next →' }, bar);
  prev.disabled = idx <= 0;
  next.disabled = idx >= sel.length - 1;
  prev.addEventListener('click', () => { current = sel[idx - 1].id; render(root); });
  next.addEventListener('click', () => { current = sel[idx + 1].id; render(root); });
  h('span', { class: 'hint', style: 'margin:0 0 6px auto', text: `${idx + 1} of ${sel.length} in the current slice` }, bar);

  // ---- clinical summary
  const g2 = h('div', { class: 'grid c2', style: 'margin-top:14px' }, root);
  {
    const c = h('div', { class: 'card' }, g2);
    const head = h('div', { class: 'pt-head' }, c);
    h('span', { class: 'pid', text: `Patient ${p.id}` }, head);
    pill(head, p.eln);
    if (p.fusion) h('span', { class: 'pill', text: p.fusion }, head);
    h('div', { style: 'height:10px' }, c);

    const cols = h('div', { style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:14px' }, c);
    kv(cols, [
      ['Age at diagnosis', p.age == null ? null : `${p.age} years`],
      ['Sex', p.sex],
      ['Race', p.race], ['Ethnicity', p.ethnicity],
      ['Diagnosis', p.dx],
      ['Specific diagnosis', p.specificDx],
    ]);
    kv(cols, [
      ['Disease stage', p.stage],
      ['Specimen', p.specimenType],
      ['De novo', p.isDenovo == null ? null : (p.isDenovo ? 'Yes' : 'No')],
      ['Transformed', p.isTransformed == null ? null : (p.isTransformed ? 'Yes' : 'No')],
      ['Prior MDS', p.priorMDS == null ? null : (p.priorMDS ? 'Yes' : 'No')],
      ['FAB morphology', p.fab],
    ]);
    kv(cols, [
      ['Induction response', p.response],
      ['Vital status', p.vital],
      ['Overall survival', p.os == null ? null : `${fmt(p.os)} days (${(p.os / 365.25).toFixed(1)} yr)`],
      ['Cause of death', p.causeOfDeath],
      ['Cohort wave', p.cohort],
    ]);
    kv(cols, [
      ['Blasts in marrow', p.blastsBM == null ? null : `${p.blastsBM}%`],
      ['Blasts in blood', p.blastsPB == null ? null : `${p.blastsPB}%`],
      ['WBC count', p.wbc],
      ['Haemoglobin', p.hgb],
      ['Platelets', p.plt],
      ['LDH', p.ldh],
    ]);

    const markers = [];
    if (p.flt3itd) markers.push(`FLT3-ITD positive${p.allelicRatio != null ? ` (AR ${p.allelicRatio})` : ''}`);
    if (p.npm1c) markers.push('NPM1 mutated');
    if (p.runx1c) markers.push('RUNX1 mutated');
    if (p.asxl1c) markers.push('ASXL1 mutated');
    if (p.tp53c) markers.push('TP53 mutated');
    if (p.cebpaBi) markers.push(`CEBPA ${p.cebpaBi}allelic`);
    const mk = h('div', { style: 'margin-top:12px;display:flex;gap:6px;flex-wrap:wrap' }, c);
    h('span', { class: 'hint', style: 'margin:0;width:100%', text: 'Consensus clinical markers' }, mk);
    if (!markers.length) h('span', { class: 'hint', style: 'margin:0', text: 'None reported' }, mk);
    for (const m of markers) h('span', { class: 'pill', text: m }, mk);

    if (p.karyotype) {
      const ky = h('div', { style: 'margin-top:12px' }, c);
      h('div', { class: 'hint', style: 'margin:0', text: 'Karyotype' }, ky);
      h('div', { style: 'font-family:var(--mono);font-size:11.5px;color:var(--text-secondary);word-break:break-word', text: p.karyotype }, ky);
    }
  }

  // ---- mutations
  {
    const c = h('div', { class: 'card' }, g2);
    h('h3', { text: `Broken genes (${muts.length})` }, c);
    h('p', { class: 'hint', text: 'Each grey bar is one protein, drawn end to end. A dot marks where the damage landed; the taller its stem, the more of the cancer carried it.' }, c);
    lollipops(c, muts);
    tableView(c, [
      { key: 'g', label: 'Gene' },
      { key: 'hp', label: 'Protein change', fmt: (v) => v || '—' },
      { key: 'c', label: 'Consequence' },
      { key: 'vaf', label: 'VAF', fmt: (v) => (v == null ? '—' : `${(v * 100).toFixed(0)}%`) },
      { key: 'loc', label: 'Position' },
      { key: 'rd', label: 'Depth', fmt: (v) => (v == null ? '—' : fmt(v)) },
      { key: 'cosmic', label: 'COSMIC' },
    ], muts.map((m) => ({
      ...m, loc: `chr${m.chr}:${fmt(m.pos)} ${m.ref}>${m.alt}`, cosmic: m.cos ? 'yes' : '—',
    })), { label: 'variant table', open: false });
  }

  // ---- what the genotype implies (the actionable panel)
  {
    const c = h('div', { class: 'card' }, root);
    c.style.marginTop = '14px';
    h('h3', { text: 'What this patient’s broken genes suggest' }, c);
    h('p', {
      class: 'hint',
      text: 'Cross-references this patient’s mutations against the significant cohort-wide drug associations '
        + 'and the inhibitor target list, then shows what this patient actually measured.',
    }, c);
    implications(c, current);
  }

  // ---- drug response
  {
    const c = h('div', { class: 'card' }, root);
    c.style.marginTop = '14px';
    h('h3', { text: 'How this patient’s cells reacted to each drug' }, c);
    h('p', {
      class: 'hint',
      text: 'Each inhibitor ranked by where this patient falls in the cohort distribution. Lower AUC and lower percentile mean the sample was more sensitive.',
    }, c);
    drugProfile(c, current);
  }

  // ---- cohort context for one drug
  {
    const c = h('div', { class: 'card' }, root);
    c.style.marginTop = '14px';
    h('h3', { text: 'How this patient compares with everyone else' }, c);
    const head = h('div', { style: 'display:flex;gap:10px;align-items:center;margin:6px 0 10px' }, c);
    h('span', { class: 'hint', style: 'margin:0', text: 'Inhibitor' }, head);
    const dsel = h('select', { style: 'font:inherit;font-size:13px;padding:4px 8px;border-radius:7px;border:1px solid var(--border);background:var(--plane);color:var(--text-primary)' }, head);
    const tested = db.drug.drugs.filter((d) => auc(current, d.name) != null);
    const pool = tested.length ? tested : db.drug.drugs;
    for (const d of pool) h('option', { value: d.name, text: d.name }, dsel);
    const plot = h('div', {}, c);

    const drawOne = () => {
      plot.textContent = '';
      const name = dsel.value;
      const meta = db.drug.drugs[db.drugNameIndex.get(name)];
      const mine = auc(current, name);
      histogram(plot, meta.sorted, {
        bins: 26, xLabel: `AUC — ${name}`, width: 620, height: 220,
      });
      const svg = plot.querySelector('svg');
      if (svg && mine != null && meta.sorted.length) {
        // overlay the patient's own value on the cohort distribution
        const m = { left: 42, right: 12, top: 10, bottom: 34 };
        const innerW = 620 - m.left - m.right, innerH = 220 - m.top - m.bottom;
        const ext = d3.extent(meta.sorted);
        const x = d3.scaleLinear().domain(ext).nice(26).range([0, innerW]);
        const gg = el('g', { transform: `translate(${m.left},${m.top})` }, svg);
        const px = x(mine);
        el('line', {
          x1: px, x2: px, y1: -4, y2: innerH,
          stroke: 'var(--series-2)', 'stroke-width': 2, 'stroke-linecap': 'round',
        }, gg);
        el('circle', {
          cx: px, cy: -4, r: 4.5, fill: 'var(--series-2)',
          stroke: 'var(--surface-1)', 'stroke-width': 2,
        }, gg);
        const lbl = el('text', {
          x: px, y: -12, 'text-anchor': px > innerW - 60 ? 'end' : 'middle', class: 'mark-label',
        }, gg);
        lbl.textContent = `this patient ${fmt(mine, 0)}`;
      }
      const pctl = mine == null ? null : aucPercentile(mine, meta);
      const note = h('p', { class: 'hint', style: 'margin-top:6px' }, plot);
      note.textContent = mine == null
        ? `This patient was not screened against ${name}.`
        : `AUC ${fmt(mine, 1)} — ${pctl.toFixed(0)}th percentile of ${meta.n} screened patients `
          + `(cohort median ${fmt(meta.med, 1)}, IQR ${fmt(meta.q1, 1)}–${fmt(meta.q3, 1)}).`;
    };
    dsel.addEventListener('change', drawOne);
    drawOne();
  }

  // ---- dose-response curves
  {
    const c = h('div', { class: 'card' }, root);
    c.style.marginTop = '14px';
    h('h3', { text: 'The 12 drugs that worked best — raw measurements' }, c);
    h('p', {
      class: 'hint',
      text: 'This is the experiment itself. Each dot is a real measurement at one drug strength; the line is the curve fitted through them.',
    }, c);
    doseCurves(c, current);
  }

  // ---- expression
  {
    const c = h('div', { class: 'card' }, root);
    c.style.marginTop = '14px';
    h('h3', { text: 'Which genes are running hot or cold' }, c);
    h('p', {
      class: 'hint',
      text: 'How far this patient sits from the cohort for their mutated genes and the common AML drivers. '
        + 'A mutated gene that is also strongly over- or under-expressed is worth a second look.',
    }, c);
    exprPanel(c, current);
  }

  // ---- similar patients
  {
    const c = h('div', { class: 'card' }, root);
    c.style.marginTop = '14px';
    h('h3', { text: 'Patients whose cancer looks most like this one' }, c);
    h('p', { class: 'hint', text: 'Ranked by how many broken genes they share with this patient. Click a row to open them.' }, c);
    similarPatients(c, current);
  }
}
