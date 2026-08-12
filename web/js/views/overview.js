/* Cohort overview — what is in the current slice. */
import { db, filters, emitFilterChange, selection } from '../data.js';
import { h, barChartH, histogram, fmt, tableView } from '../charts.js';
import { tabIntro } from '../tabintro.js';

function statTile(parent, label, value, sub) {
  const c = h('div', { class: 'card stat' }, parent);
  h('div', { class: 'label', text: label }, c);
  h('div', { class: 'value', text: value }, c);
  if (sub) h('div', { class: 'sub', text: sub }, c);
  return c;
}

function counts(rows, key, fallback = 'Not reported') {
  const m = new Map();
  for (const r of rows) {
    const v = r[key] == null ? fallback : r[key];
    m.set(v, (m.get(v) || 0) + 1);
  }
  return [...m.entries()].map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value);
}

export function render(root) {
  root.textContent = '';
  tabIntro(root, 'overview');
  const sel = selection();
  const ids = new Set(sel.map((p) => p.id));

  const withWes = sel.filter((p) => db.sequenced.has(p.id)).length;
  const withDrug = sel.filter((p) => db.drugPtIndex.has(p.id)).length;
  const ages = sel.map((p) => p.age).filter((v) => v != null).sort((a, b) => a - b);
  const medAge = ages.length ? ages[Math.floor(ages.length / 2)] : null;
  const dead = sel.filter((p) => p.vital === 'Dead').length;
  const osVals = sel.map((p) => p.os).filter((v) => v != null).sort((a, b) => a - b);
  const medOS = osVals.length ? osVals[Math.floor(osVals.length / 2)] : null;

  const tiles = h('div', { class: 'grid c4' }, root);
  statTile(tiles, 'Patients shown', fmt(sel.length),
    sel.length === db.patients.length ? 'everyone in the study' : `of ${fmt(db.patients.length)} total`);
  statTile(tiles, 'Had their DNA read', fmt(withWes),
    `${(withWes / Math.max(1, sel.length) * 100).toFixed(0)}% — so we know which genes are broken`);
  statTile(tiles, 'Had drugs tested', fmt(withDrug),
    `${(withDrug / Math.max(1, sel.length) * 100).toFixed(0)}% — their cells were exposed to 166 drugs`);
  statTile(tiles, 'Median age', medAge == null ? '—' : `${medAge}`, 'years at diagnosis');
  statTile(tiles, 'Died during the study', fmt(dead),
    `${(dead / Math.max(1, sel.length) * 100).toFixed(0)}% of those shown`);
  statTile(tiles, 'Typical survival', medOS == null ? '—' : `${(medOS / 365.25).toFixed(1)} yr`,
    medOS == null ? '' : `half lived longer, half shorter (${fmt(medOS)} days)`);

  const g2 = h('div', { class: 'grid c2', style: 'margin-top:14px' }, root);

  // --- age
  {
    const c = h('div', { class: 'card' }, g2);
    h('h3', { text: 'Age at diagnosis' }, c);
    h('p', { class: 'hint', text: `${ages.length} patients with a recorded age` }, c);
    histogram(c, ages, { bins: 22, xLabel: 'Years' });
    tableView(c, [
      { key: 'stat', label: 'Statistic' }, { key: 'v', label: 'Years' },
    ], [
      { stat: 'Minimum', v: ages[0] ?? '—' },
      { stat: '25th percentile', v: ages[Math.floor(ages.length * 0.25)] ?? '—' },
      { stat: 'Median', v: medAge ?? '—' },
      { stat: '75th percentile', v: ages[Math.floor(ages.length * 0.75)] ?? '—' },
      { stat: 'Maximum', v: ages[ages.length - 1] ?? '—' },
    ], { label: 'summary' });
  }

  // --- ELN risk (click to filter)
  {
    const c = h('div', { class: 'card' }, g2);
    h('h3', { text: 'How risky the disease looked' }, c);
    h('p', { class: 'hint', text: 'Click a bar to narrow the whole website to those patients' }, c);
    const data = counts(sel, 'eln');
    barChartH(c, data, {
      labelW: 140,
      onClick: (d) => {
        if (filters.eln.has(d.label)) filters.eln.delete(d.label);
        else filters.eln.add(d.label);
        emitFilterChange();
      },
      highlight: filters.eln.size ? (d) => filters.eln.has(d.label) : null,
      unit: 'patients',
    });
    tableView(c, [{ key: 'label', label: 'Risk' }, { key: 'value', label: 'Patients' }], data);
  }

  // --- disease stage
  {
    const c = h('div', { class: 'card' }, g2);
    h('h3', { text: 'When the sample was taken' }, c);
    h('p', { class: 'hint', text: 'Click a bar to filter' }, c);
    const data = counts(sel, 'stage');
    barChartH(c, data, {
      labelW: 128,
      onClick: (d) => {
        if (filters.stage.has(d.label)) filters.stage.delete(d.label);
        else filters.stage.add(d.label);
        emitFilterChange();
      },
      highlight: filters.stage.size ? (d) => filters.stage.has(d.label) : null,
      unit: 'patients',
    });
    tableView(c, [{ key: 'label', label: 'Stage' }, { key: 'value', label: 'Patients' }], data);
  }

  // --- response to induction
  {
    const c = h('div', { class: 'card' }, g2);
    h('h3', { text: 'Did the first chemotherapy work?' }, c);
    h('p', { class: 'hint', text: '“Complete response” means no cancer was detectable afterwards' }, c);
    const data = counts(sel, 'response', 'Not recorded');
    barChartH(c, data, { labelW: 140, unit: 'patients' });
    tableView(c, [{ key: 'label', label: 'Response' }, { key: 'value', label: 'Patients' }], data);
  }

  // --- top mutated genes
  {
    const c = h('div', { class: 'card' }, g2);
    h('h3', { text: 'Genes broken most often' }, c);
    const nSeq = sel.filter((p) => db.sequenced.has(p.id)).length;
    h('p', { class: 'hint', text: `Out of the ${nSeq} patients here whose DNA was read · click a bar to narrow to them` }, c);
    const data = [];
    for (const { gene } of db.geneFreq) {
      let n = 0;
      for (const pid of db.mutByGene.get(gene)) if (ids.has(pid)) n++;
      if (n > 0) data.push({ gene, label: gene, value: n, sub: `${(n / Math.max(1, nSeq) * 100).toFixed(1)}% of sequenced` });
    }
    data.sort((a, b) => b.value - a.value);
    const top = data.slice(0, 25);
    barChartH(c, top, {
      labelW: 80,
      onClick: (d) => { filters.gene = filters.gene === d.gene ? '' : d.gene; emitFilterChange(); },
      highlight: filters.gene ? (d) => d.gene === filters.gene : null,
      valueFmt: (v) => fmt(v),
      unit: 'patients',
    });
    tableView(c, [
      { key: 'label', label: 'Gene' },
      { key: 'value', label: 'Patients' },
      { key: 'pct', label: '% sequenced', fmt: (v) => `${v.toFixed(1)}%` },
    ], data.map((d) => ({ ...d, pct: d.value / Math.max(1, nSeq) * 100 })), { label: 'all genes' });
  }

  // --- specimen + sex composition
  {
    const c = h('div', { class: 'card' }, g2);
    h('h3', { text: 'Where samples came from, and sex' }, c);
    h('p', { class: 'hint', text: 'Make-up of the patients currently shown' }, c);
    const data = counts(sel, 'specimenType').concat(counts(sel, 'sex'));
    barChartH(c, data, { labelW: 140, unit: 'patients' });
    tableView(c, [{ key: 'label', label: 'Category' }, { key: 'value', label: 'Patients' }], data);
  }
}
