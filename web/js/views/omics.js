/* Transcriptomics — the expression layer, and how it lines up with genotype
   and drug response. */
import {
  db, selection, ensureExpr, ensureBiomarkers, exprRow, exprZ,
  auc, mannWhitney, quantile,
} from '../data.js';
import {
  h, el, fmt, fmtP, fmtPapprox, legend, tableView, boxPlot, seqScale, rampLegend, heatmap,
  hoverable,
} from '../charts.js';
import { scatter } from '../charts2.js';
import { tabIntro } from '../tabintro.js';

let colorBy = 'ELN 2017 risk';
let colorGene = 'FLT3';
let colorDrug = 'Venetoclax';
let bioGene = null;
let bioDrug = null;
let exprGene = 'HOXA9';
let exprMarker = 'NPM1 (clinical)';
let hideSexLinked = true;

/* Sex-chromosome genes are genuinely the most variable genes in any mixed-sex
   cohort, which crowds out the leukemia biology in a "most variable" ranking.
   Excluded by default, with the toggle exposed rather than hidden. */
const SEX_LINKED = new Set([
  'RPS4Y1', 'KDM5D', 'DDX3Y', 'UTY', 'USP9Y', 'EIF1AY', 'ZFY', 'NLGN4Y', 'TXLNGY',
  'TMSB4Y', 'PRKY', 'RPS4Y2', 'XIST', 'TSIX', 'KDM5C', 'ZFX', 'DDX3X',
]);

/* Exactly three ordered severities -> the reserved status palette, which is
   what an ordered risk scale should wear. */
const ELN_C = {
  Favorable: 'var(--status-good)',
  Intermediate: 'var(--status-warning)',
  Adverse: 'var(--status-critical)',
};

function markerCarriers(key) {
  if (key === 'FLT3-ITD') return new Set(db.patients.filter((p) => p.flt3itd === true).map((p) => p.id));
  if (key === 'NPM1 (clinical)') return new Set(db.patients.filter((p) => p.npm1c === true).map((p) => p.id));
  if (key === 'TP53 (clinical)') return new Set(db.patients.filter((p) => p.tp53c === true).map((p) => p.id));
  return db.mutByGene.get(key) || new Set();
}

function sel2(parent, values, current, onChange, style = '') {
  const s = h('select', {
    style: 'font:inherit;font-size:12.5px;padding:4px 7px;border-radius:6px;'
      + `border:1px solid var(--border);background:var(--plane);color:var(--text-primary);${style}`,
  }, parent);
  for (const v of values) {
    const o = h('option', { value: v, text: v }, s);
    if (v === current) o.selected = true;
  }
  s.addEventListener('change', () => onChange(s.value));
  return s;
}

export function render(root) {
  root.textContent = '';
  tabIntro(root, 'omics');
  if (!db.expr) {
    h('div', { class: 'loading', text: 'Loading expression matrix (5.6 MB, once per session)…' }, root);
    ensureExpr().then(() => render(root)).catch((e) => {
      root.textContent = '';
      h('div', { class: 'empty', text: `Could not load expression data: ${e.message}` }, root);
    });
    return;
  }
  ensureBiomarkers().then(() => {
    if (bioGene == null && db.biomarkers?.pairs?.length) {
      bioGene = db.biomarkers.pairs[0].gene;
      bioDrug = db.biomarkers.pairs[0].drug;
      render(root);
    }
  });

  const sel = selection();
  const ids = new Set(sel.map((p) => p.id));
  const inSlice = db.expr.patients
    .map((pid, i) => ({ pid, i }))
    .filter((d) => ids.has(d.pid));

  h('p', {
    class: 'hint',
    style: 'margin:0 0 12px',
    text: `${db.expr.genes.length} genes × ${db.expr.patients.length} patients with RNA-seq `
      + `(${inSlice.length} in the current slice). Values are normalised log2 expression from the release; `
      + 'the gene set is the 1,400 most variable protein-coding genes plus every drug target and mutated driver.',
  }, root);

  // ------------------------------------------------------- PCA similarity map
  {
    const c = h('div', { class: 'card' }, root);
    const head = h('div', { style: 'display:flex;gap:10px;align-items:center;flex-wrap:wrap' }, c);
    h('h3', { text: 'Map of patients by gene activity', style: 'margin:0' }, head);
    h('span', { style: 'flex:1' }, head);
    h('span', { class: 'hint', style: 'margin:0', text: 'colour by' }, head);
    sel2(head, ['ELN 2017 risk', 'Sex', 'Mutated gene', 'Drug sensitivity'], colorBy,
      (v) => { colorBy = v; render(root); });
    if (colorBy === 'Mutated gene') {
      sel2(head, db.topGenes.slice(0, 25), colorGene, (v) => { colorGene = v; render(root); });
    }
    if (colorBy === 'Drug sensitivity') {
      const pool = db.drug.drugs.filter((d) => d.n >= 200).map((d) => d.name);
      if (!pool.includes(colorDrug)) colorDrug = pool[0];
      sel2(head, pool, colorDrug, (v) => { colorDrug = v; render(root); }, 'max-width:220px');
    }

    h('p', {
      class: 'hint',
      text: 'Each dot is one patient. Two dots close together means those two cancers are using a '
        + 'similar set of genes. The position comes from squashing over a thousand gene measurements '
        + 'per person down to two numbers, so only nearness matters — the axis values themselves do '
        + 'not. Click a dot to open that patient.',
    }, c);

    let carriers = null, ramp = null, aucDomain = null;
    if (colorBy === 'Mutated gene') carriers = markerCarriers(colorGene);
    if (colorBy === 'Drug sensitivity') {
      const vals = inSlice.map((d) => auc(d.pid, colorDrug)).filter((v) => v != null);
      aucDomain = vals.length ? [d3.max(vals), d3.min(vals)] : [286, 0];
      ramp = seqScale(aucDomain);   // dark = low AUC = the drug worked
    }

    const points = inSlice.map((d) => {
      const p = db.byId.get(d.pid);
      const xy = db.expr.pca[d.i];
      let color = 'var(--text-muted)';
      if (colorBy === 'ELN 2017 risk') color = ELN_C[p.eln] || 'var(--text-muted)';
      else if (colorBy === 'Sex') {
        color = p.sex === 'Female' ? 'var(--series-1)'
          : p.sex === 'Male' ? 'var(--series-2)' : 'var(--text-muted)';
      } else if (colorBy === 'Mutated gene') {
        color = carriers.has(d.pid) ? 'var(--series-2)' : 'var(--series-1)';
      } else if (colorBy === 'Drug sensitivity') {
        const v = auc(d.pid, colorDrug);
        color = v == null ? 'var(--wash)' : ramp(v);
      }
      return {
        x: xy[0], y: xy[1], color, pid: d.pid, p,
        title: `Patient ${d.pid}`,
        opacity: colorBy === 'Mutated gene' && !carriers.has(d.pid) ? 0.45 : 0.8,
      };
    });

    scatter(c, points, {
      width: 640, height: 420, r: 4,
      xLabel: `PC1 (${db.expr.pcaVar[0]}% of variance)`,
      yLabel: `PC2 (${db.expr.pcaVar[1]}%)`,
      onClick: (pt) => window.dispatchEvent(new CustomEvent('goto-patient', { detail: pt.pid })),
      tip: (pt) => [
        { value: pt.p.eln || '—', label: 'ELN 2017' },
        { value: pt.p.age == null ? '—' : `${pt.p.age}y`, label: pt.p.sex || '' },
        ...(colorBy === 'Mutated gene'
          ? [{ value: carriers.has(pt.pid) ? 'mutated' : 'wild type', label: colorGene, color: pt.color }] : []),
        ...(colorBy === 'Drug sensitivity'
          ? [{ value: fmt(auc(pt.pid, colorDrug), 1), label: `AUC — ${colorDrug}`, color: pt.color }] : []),
        { value: `${(db.mutByPatient.get(pt.pid) || []).length}`, label: 'coding mutations' },
      ],
    });

    if (colorBy === 'ELN 2017 risk') {
      const nOther = points.filter((p) => !ELN_C[p.p.eln]).length;
      legend(c, [
        ...Object.entries(ELN_C).map(([k, v]) => ({ label: k, color: v })),
        ...(nOther ? [{
          label: `Not assigned / NonInitial / NonAML (${nOther})`, color: 'var(--text-muted)',
        }] : []),
      ]);
    } else if (colorBy === 'Sex') {
      legend(c, [{ label: 'Female', color: 'var(--series-1)' }, { label: 'Male', color: 'var(--series-2)' }]);
    } else if (colorBy === 'Mutated gene') {
      legend(c, [
        { label: `${colorGene} mutated`, color: 'var(--series-2)' },
        { label: `${colorGene} wild type`, color: 'var(--series-1)' },
      ]);
    } else {
      const lgw = h('div', { style: 'display:flex;gap:14px;align-items:center;margin-top:6px;flex-wrap:wrap' }, c);
      rampLegend(lgw, ramp, aucDomain, '', (v) => fmt(v, 0));
      h('span', { class: 'hint', style: 'margin:0', text: `AUC — ${colorDrug} · resistant ← → sensitive` }, lgw);
    }
  }

  const g2 = h('div', { class: 'grid c2', style: 'margin-top:14px' }, root);

  // ------------------------------------------- expression vs drug response
  {
    const c = h('div', { class: 'card' }, g2);
    h('h3', { text: 'Does gene activity predict a drug?' }, c);
    const head = h('div', { style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:6px 0 8px' }, c);

    if (!db.biomarkers) {
      h('div', { class: 'empty', text: 'Loading biomarker correlations…' }, c);
    } else {
      const pairs = db.biomarkers.pairs;
      if (bioGene == null) { bioGene = pairs[0].gene; bioDrug = pairs[0].drug; }
      const geneOpts = [...new Set(pairs.map((p) => p.gene))].slice(0, 400);
      const drugOpts = [...new Set(pairs.map((p) => p.drug))];
      if (!geneOpts.includes(bioGene)) geneOpts.unshift(bioGene);
      if (!drugOpts.includes(bioDrug)) drugOpts.unshift(bioDrug);
      sel2(head, geneOpts, bioGene, (v) => { bioGene = v; render(root); }, 'max-width:150px');
      h('span', { class: 'hint', style: 'margin:0', text: 'vs' }, head);
      sel2(head, drugOpts, bioDrug, (v) => { bioDrug = v; render(root); }, 'max-width:210px');

      const row = exprRow(bioGene);
      const points = [];
      if (row) {
        for (const d of inSlice) {
          const a = auc(d.pid, bioDrug);
          const e = row[d.i];
          if (a == null || e == null) continue;
          const p = db.byId.get(d.pid);
          points.push({
            x: e, y: a, pid: d.pid, p, color: 'var(--series-1)',
            title: `Patient ${d.pid}`,
          });
        }
      }
      const rec = pairs.find((q) => q.gene === bioGene && q.drug === bioDrug);
      scatter(c, points, {
        width: 520, height: 330, trend: true,
        xLabel: `${bioGene} expression (log2)`,
        yLabel: `AUC — ${bioDrug}`,
        onClick: (pt) => window.dispatchEvent(new CustomEvent('goto-patient', { detail: pt.pid })),
        tip: (pt) => [
          { value: fmt(pt.y, 1), label: 'AUC (lower = sensitive)', color: pt.color },
          { value: fmt(pt.x, 2), label: `${bioGene} log2 expression` },
          { value: pt.p.eln || '—', label: 'ELN 2017' },
        ],
      });
      h('p', {
        class: 'hint',
        text: rec
          ? `Spearman ρ = ${rec.rho} across ${rec.n} patients with both assays (p = ${fmtP(rec.p)}, full cohort). `
            + `${rec.rho < 0 ? 'Higher expression tracks with lower AUC — more sensitive.' : 'Higher expression tracks with higher AUC — more resistant.'}`
          : `${points.length} patients in this slice have both values. This pair is below the |ρ| ≥ 0.30 reporting threshold.`,
      }, c);

      tableView(c, [
        { key: 'gene', label: 'Gene' }, { key: 'drug', label: 'Inhibitor' },
        { key: 'rho', label: 'Spearman ρ' }, { key: 'n', label: 'Patients' },
        { key: 'p', label: 'p', fmt: (v) => fmtP(v) },
      ], pairs, { label: `all ${fmt(pairs.length)} correlations at |ρ| ≥ 0.30` });
    }
  }

  // ------------------------------------------ expression by mutation status
  {
    const c = h('div', { class: 'card' }, g2);
    h('h3', { text: 'Does a broken gene change activity elsewhere?' }, c);
    const head = h('div', { style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:6px 0 8px' }, c);
    const geneOpts = db.expr.genes.slice().sort();
    sel2(head, geneOpts.includes(exprGene) ? geneOpts : [exprGene, ...geneOpts], exprGene,
      (v) => { exprGene = v; render(root); }, 'max-width:150px');
    h('span', { class: 'hint', style: 'margin:0', text: 'split by' }, head);
    sel2(head, ['NPM1 (clinical)', 'FLT3-ITD', 'TP53 (clinical)', ...db.topGenes.slice(0, 20)],
      exprMarker, (v) => { exprMarker = v; render(root); });

    const row = exprRow(exprGene);
    const carriers = markerCarriers(exprMarker);
    const pos = [], neg = [];
    if (row) {
      for (const d of inSlice) {
        const v = row[d.i];
        if (v == null) continue;
        (carriers.has(d.pid) ? pos : neg).push(v);
      }
    }
    if (pos.length < 3 || neg.length < 3) {
      h('div', { class: 'empty', text: 'Too few patients on one side of this split in the current slice.' }, c);
    } else {
      boxPlot(c, [
        { label: `${exprMarker} mutated`, values: pos },
        { label: 'Wild type', values: neg },
      ], { width: 520, height: 330, yLabel: `${exprGene} expression (log2)` });
      const mw = mannWhitney(pos, neg);
      const mp = quantile(pos.slice().sort((a, b) => a - b), 0.5);
      const mn = quantile(neg.slice().sort((a, b) => a - b), 0.5);
      h('p', {
        class: 'hint',
        text: `${exprGene} median ${fmt(mp, 2)} in mutated vs ${fmt(mn, 2)} in wild type `
          + `(${mp > mn ? 'higher' : 'lower'} in mutated). Mann–Whitney p = ${fmtPapprox(mw.p)}, `
          + 'computed on the current slice and unadjusted.',
      }, c);
      tableView(c, [
        { key: 'g', label: 'Group' }, { key: 'n', label: 'Patients' },
        { key: 'med', label: 'Median log2', fmt: (v) => fmt(v, 2) },
      ], [
        { g: `${exprMarker} mutated`, n: pos.length, med: mp },
        { g: 'Wild type', n: neg.length, med: mn },
      ]);
    }
  }

  // --------------------------------------------------- expression heatmap
  {
    const c = h('div', { class: 'card' }, root);
    c.style.marginTop = '14px';
    const hhead = h('div', { style: 'display:flex;gap:12px;align-items:center;flex-wrap:wrap' }, c);
    h('h3', { text: 'The genes that differ most between patients', style: 'margin:0' }, hhead);
    h('span', { style: 'flex:1' }, hhead);
    const lab = h('label', {
      style: 'display:flex;gap:6px;align-items:center;font-size:12px;color:var(--text-secondary);cursor:pointer',
    }, hhead);
    const cb = h('input', { type: 'checkbox' }, lab);
    cb.checked = hideSexLinked;
    cb.addEventListener('change', () => { hideSexLinked = cb.checked; render(root); });
    h('span', { text: 'exclude sex-chromosome genes' }, lab);

    h('p', {
      class: 'hint',
      text: 'The 40 most variable genes in this slice, z-scored per gene. Patients are ordered by PC1, '
        + 'so transcriptional neighbours sit next to each other and blocks of colour are co-expression modules. '
        + (hideSexLinked
          ? 'Y-linked and XIST genes are excluded — they top any mixed-sex variance ranking and tell you about sex, not leukemia.'
          : 'Sex-chromosome genes are included, and will dominate the top of the ranking.'),
    }, c);

    const cols = inSlice.slice().sort((a, b) => db.expr.pca[a.i][0] - db.expr.pca[b.i][0]);
    if (!cols.length) {
      h('div', { class: 'empty', text: 'No patients with expression in this slice.' }, c);
    } else {
      // rank genes by variance within the slice
      const stats = db.expr.genes.map((g, gi) => {
        if (hideSexLinked && SEX_LINKED.has(g)) return { gi, g, sd: -1 };
        const vals = [];
        for (const d of cols) { const v = db.expr.values[gi][d.i]; if (v != null) vals.push(v); }
        if (vals.length < 10) return { gi, g, sd: -1 };
        const mu = vals.reduce((s, v) => s + v, 0) / vals.length;
        const sd = Math.sqrt(vals.reduce((s, v) => s + (v - mu) ** 2, 0) / (vals.length - 1));
        return { gi, g, sd, mu };
      }).filter((d) => d.sd > 0).sort((a, b) => b.sd - a.sd).slice(0, 40);

      const div = d3.scaleLinear()
        .domain([-2.5, 0, 2.5])
        .range([
          getComputedStyle(document.documentElement).getPropertyValue('--div-neg').trim(),
          getComputedStyle(document.documentElement).getPropertyValue('--div-mid').trim(),
          getComputedStyle(document.documentElement).getPropertyValue('--div-pos').trim(),
        ]).clamp(true);

      const cell = 4, rowH = 13, labelW = 84;
      const W = labelW + cols.length * cell + 10;
      const H = stats.length * rowH + 24;
      const box = h('div', { class: 'scroll-x' }, c);
      const svg = el('svg', {
        width: W, height: H, class: 'wide', viewBox: `0 0 ${W} ${H}`, role: 'img',
        'aria-label': `Expression heatmap of ${stats.length} genes across ${cols.length} patients`,
      }, box);
      const g = el('g', { transform: `translate(${labelW},6)` }, svg);

      stats.forEach((s, r) => {
        el('text', {
          x: -7, y: r * rowH + rowH / 2 + 3.5, 'text-anchor': 'end', class: 'axis-label',
        }, g).textContent = s.g;
        cols.forEach((d, j) => {
          const v = db.expr.values[s.gi][d.i];
          const z = v == null ? null : (v - s.mu) / s.sd;
          el('rect', {
            x: j * cell, y: r * rowH + 1, width: cell, height: rowH - 2,
            fill: z == null ? 'var(--wash)' : div(z),
          }, g);
        });
        const hit = el('rect', {
          x: 0, y: r * rowH, width: cols.length * cell, height: rowH, class: 'hit',
        }, g);
        hoverable(hit, s.g, () => [
          { value: fmt(s.mu, 2), label: 'mean log2 in slice' },
          { value: fmt(s.sd, 2), label: 'standard deviation' },
        ]);
      });
      el('text', { x: -7, y: stats.length * rowH + 14, 'text-anchor': 'end', class: 'axis-label' }, g)
        .textContent = `${cols.length} patients →`;

      const lgw = h('div', { style: 'display:flex;gap:14px;align-items:center;margin-top:6px;flex-wrap:wrap' }, c);
      rampLegend(lgw, div, [-2.5, 2.5], '', (v) => (v > 0 ? `+${v}` : `${v}`));
      h('span', { class: 'hint', style: 'margin:0', text: 'z-score per gene · low ← → high' }, lgw);

      tableView(c, [
        { key: 'g', label: 'Gene' },
        { key: 'mu', label: 'Mean log2', fmt: (v) => fmt(v, 2) },
        { key: 'sd', label: 'SD', fmt: (v) => fmt(v, 2) },
      ], stats, { label: 'gene statistics' });
    }
  }
}
