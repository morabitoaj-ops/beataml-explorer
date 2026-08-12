/* Survival — Kaplan–Meier curves for any stratification of the current slice. */
import {
  db, selection, kaplanMeier, medianSurvival, logRank, auc, quantile,
} from '../data.js';
import {
  h, fmt, fmtP, legend, tableView, kmChart,
} from '../charts.js';
import { tabIntro } from '../tabintro.js';

let strat = 'ELN 2017 risk';
let stratDrug = null;

/* Categorical slots 1-4, assigned by stratum identity in a fixed order so a
   stratum keeps its colour when other strata drop out of the slice. */
const SLOTS = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)'];

function stratify(sel, key) {
  const rows = (list) => list
    .filter((p) => p.os != null)
    .map((p) => ({ time: p.os, dead: p.vital === 'Dead', id: p.id }));

  if (key === 'ELN 2017 risk') {
    const order = ['Favorable', 'Intermediate', 'Adverse'];
    return order.map((lvl) => ({ label: lvl, rows: rows(sel.filter((p) => p.eln === lvl)) }));
  }
  if (key === 'Sex') {
    return ['Female', 'Male'].map((s) => ({ label: s, rows: rows(sel.filter((p) => p.sex === s)) }));
  }
  if (key === 'Age group') {
    return [
      { label: '< 60 years', rows: rows(sel.filter((p) => p.age != null && p.age < 60)) },
      { label: '≥ 60 years', rows: rows(sel.filter((p) => p.age != null && p.age >= 60)) },
    ];
  }
  if (key === 'Disease stage') {
    const order = ['Initial Diagnosis', 'Relapse', 'Residual', 'Remission'];
    return order.map((s) => ({ label: s, rows: rows(sel.filter((p) => p.stage === s)) }));
  }
  if (key === 'FLT3-ITD') {
    return [
      { label: 'FLT3-ITD positive', rows: rows(sel.filter((p) => p.flt3itd === true)) },
      { label: 'FLT3-ITD negative', rows: rows(sel.filter((p) => p.flt3itd === false)) },
    ];
  }
  if (key === 'NPM1 (clinical)') {
    return [
      { label: 'NPM1 mutated', rows: rows(sel.filter((p) => p.npm1c === true)) },
      { label: 'NPM1 wild type', rows: rows(sel.filter((p) => p.npm1c === false)) },
    ];
  }
  if (key === 'Ex vivo sensitivity tertile') {
    if (!stratDrug) return [];
    const vals = [];
    for (const p of sel) { const v = auc(p.id, stratDrug); if (v != null && p.os != null) vals.push(v); }
    if (vals.length < 12) return [];
    vals.sort((a, b) => a - b);
    const t1 = quantile(vals, 1 / 3), t2 = quantile(vals, 2 / 3);
    const bucket = (v) => (v <= t1 ? 0 : v <= t2 ? 1 : 2);
    const labels = ['Most sensitive third', 'Middle third', 'Most resistant third'];
    const out = labels.map((l) => ({ label: l, rows: [] }));
    for (const p of sel) {
      const v = auc(p.id, stratDrug);
      if (v == null || p.os == null) continue;
      out[bucket(v)].rows.push({ time: p.os, dead: p.vital === 'Dead', id: p.id });
    }
    return out;
  }
  // a gene
  const carriers = db.mutByGene.get(key) || new Set();
  const seq = sel.filter((p) => db.sequenced.has(p.id));
  return [
    { label: `${key} mutated`, rows: rows(seq.filter((p) => carriers.has(p.id))) },
    { label: `${key} wild type`, rows: rows(seq.filter((p) => !carriers.has(p.id))) },
  ];
}

export function render(root) {
  root.textContent = '';
  tabIntro(root, 'survival');
  const sel = selection();

  const card = h('div', { class: 'card' }, root);
  const head = h('div', { style: 'display:flex;gap:10px;align-items:center;flex-wrap:wrap' }, card);
  h('h3', { text: 'How long patients lived', style: 'margin:0' }, head);
  h('span', { style: 'flex:1' }, head);
  h('span', { class: 'hint', style: 'margin:0', text: 'Split patients by' }, head);

  const ssel = h('select', { style: 'font:inherit;font-size:12.5px;padding:4px 7px;border-radius:6px;border:1px solid var(--border);background:var(--plane);color:var(--text-primary)' }, head);
  const options = ['ELN 2017 risk', 'Age group', 'Sex', 'Disease stage', 'FLT3-ITD',
    'NPM1 (clinical)', 'Ex vivo sensitivity tertile', ...db.topGenes.slice(0, 20)];
  for (const o of options) {
    const opt = h('option', { value: o, text: o }, ssel);
    if (o === strat) opt.selected = true;
  }
  ssel.addEventListener('change', () => { strat = ssel.value; render(root); });

  if (strat === 'Ex vivo sensitivity tertile') {
    const dsel = h('select', { style: 'font:inherit;font-size:12.5px;padding:4px 7px;border-radius:6px;border:1px solid var(--border);background:var(--plane);color:var(--text-primary);max-width:230px' }, head);
    const pool = db.drug.drugs.filter((d) => d.n >= 200);
    if (!stratDrug) stratDrug = pool[0]?.name || null;
    for (const d of pool) {
      const o = h('option', { value: d.name, text: d.name }, dsel);
      if (d.name === stratDrug) o.selected = true;
    }
    dsel.addEventListener('change', () => { stratDrug = dsel.value; render(root); });
  }

  h('p', {
    class: 'hint',
    text: 'Survival is measured from specimen collection. Patients recorded as alive are treated as censored at last follow-up. '
      + 'Curves are descriptive: no adjustment for treatment, age, or the multiple comparisons implied by trying many stratifications.',
  }, card);

  let groups = stratify(sel, strat).filter((g) => g.rows.length >= 5);
  if (groups.length > 4) groups = groups.slice(0, 4);

  if (groups.length < 1) {
    h('div', { class: 'empty', text: 'Not enough patients with outcome data for this stratification in the current slice.' }, card);
    return;
  }

  const series = groups.map((g, i) => ({
    label: g.label, rows: g.rows, color: SLOTS[i],
    curve: kaplanMeier(g.rows),
  }));

  kmChart(card, series, { width: 640, height: 330 });
  legend(card, series.map((s) => ({ label: s.label, color: s.color })), 'line');

  const lr = groups.length >= 2 ? logRank(groups.map((g) => g.rows)) : null;
  const summary = series.map((s) => {
    const med = medianSurvival(s.curve);
    const events = s.rows.filter((r) => r.dead).length;
    return {
      group: s.label, n: s.rows.length, events,
      medDays: med, medYears: med == null ? null : med / 365.25,
      alive: s.rows.length - events,
    };
  });

  if (lr) {
    h('p', {
      class: 'hint', style: 'margin-top:8px',
      text: `Log-rank χ² = ${lr.chi2.toFixed(2)} on ${lr.df} df, p = ${fmtP(lr.p)}`
        + `${groups.length > 2 ? ' (across all shown strata)' : ''}.`,
    }, card);
  }

  tableView(card, [
    { key: 'group', label: 'Group' },
    { key: 'n', label: 'Patients' },
    { key: 'events', label: 'Deaths' },
    { key: 'alive', label: 'Still alive at last check' },
    { key: 'medDays', label: 'Half had died by (days)', fmt: (v) => (v == null ? 'not reached' : fmt(v)) },
    { key: 'medYears', label: 'Half had died by (years)', fmt: (v) => (v == null ? 'not reached' : v.toFixed(2)) },
  ], summary, { open: true, label: 'summary' });

  // ------------------------------------------------------ context tiles
  const g2 = h('div', { class: 'grid c2', style: 'margin-top:14px' }, root);
  {
    const c = h('div', { class: 'card' }, g2);
    h('h3', { text: 'Who was included, and who was left out' }, c);
    h('p', { class: 'hint', text: 'Anyone missing the information being split on, or missing an outcome, is left out of the curves above.' }, c);
    const withOutcome = sel.filter((p) => p.os != null).length;
    const used = groups.reduce((s, g) => s + g.rows.length, 0);
    tableView(c, [
      { key: 'k', label: 'Population' }, { key: 'v', label: 'Patients' },
    ], [
      { k: 'Patients currently shown', v: sel.length },
      { k: 'With survival data', v: withOutcome },
      { k: 'Included in the curves', v: used },
      { k: 'Left out (information missing)', v: withOutcome - used },
    ], { open: true, label: 'accounting' });
  }
  {
    const c = h('div', { class: 'card' }, g2);
    h('h3', { text: 'Reading these curves' }, c);
    const ul = h('ul', { style: 'font-size:12.5px;color:var(--text-secondary);padding-left:18px;margin:8px 0 0;line-height:1.7' }, c);
    for (const t of [
      'Each step down is a death; the flat runs between steps are follow-up time.',
      'Hovering anywhere on the plot reads out every stratum at that time point, with the number still at risk.',
      '"Not reached" means more than half the stratum was still alive at last follow-up.',
      'BeatAML specimens were collected at varying points in the disease course, so mixing initial-diagnosis and relapse samples will flatter or worsen a curve independently of the variable being tested — filter Disease stage to compare like with like.',
    ]) h('li', { text: t }, ul);
  }
}
