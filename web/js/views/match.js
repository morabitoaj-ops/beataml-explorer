/* Profile match — describe a patient with dropdowns, then rank inhibitors by
   how they performed on cohort patients who look the same.

   Two classes of field, treated differently on purpose:

     Genomic markers   define the MATCHED group (must match to be included)
     Clinical details  restrict BOTH groups, so matched and reference are
                       compared like-for-like rather than confounded

   Every restriction costs sample size, so the funnel card shows what each one
   removed. That is the guard against confidently ranking drugs on n = 3.
*/
import {
  db, auc, mannWhitney, quantile, effectScore, AUC_MAX, ensureDrugInfo,
} from '../data.js';
import {
  h, el, fmt, fmtPapprox, tableView, legend, hoverable, barPath,
} from '../charts.js';
import { waterfall, viability } from '../charts2.js';
import { drugCard } from '../drugcard.js';

/* Plain-English confidence bands. These are the same q-value thresholds the
   numbers already carry — the words are a reading aid, not a second test, and
   the number stays visible beside them. */
function confidence(q) {
  if (q == null) return { word: '—', tone: 'muted' };
  if (q < 0.001) return { word: 'Very strong', tone: 'good' };
  if (q < 0.01) return { word: 'Strong', tone: 'good' };
  if (q < 0.05) return { word: 'Moderate', tone: 'good' };
  if (q < 0.2) return { word: 'Weak', tone: 'warn' };
  return { word: 'Could be chance', tone: 'muted' };
}
const TONE = {
  good: 'var(--status-good)', warn: 'var(--status-warning)', muted: 'var(--text-muted)',
};

/* Consensus clinical calls — these live as fields on each patient, so they can
   be matched positive OR negative, which a checkbox cannot express. */
const MARKERS = [
  { key: 'flt3itd', label: 'FLT3-ITD' },
  { key: 'npm1c', label: 'NPM1' },
  { key: 'tp53c', label: 'TP53' },
  { key: 'runx1c', label: 'RUNX1' },
  { key: 'asxl1c', label: 'ASXL1' },
];

const AGE_BANDS = [
  ['', 'Any age'],
  ['0-19', 'Under 20'],
  ['20-39', '20 – 39'],
  ['40-59', '40 – 59'],
  ['60-74', '60 – 74'],
  ['75-120', '75 and over'],
];

const blankProfile = () => ({
  // clinical / demographic — restrict the comparison population
  sex: '', ageBand: '', eln: '', stage: '', specimen: '',
  denovo: '', transformed: '', priorMDS: '', fab: '', fusion: '',
  // genomic — define the matched group
  markers: Object.fromEntries(MARKERS.map((m) => [m.label, ''])),  // '' | 'pos' | 'neg'
  genes: new Set(),
});

/* `draft` is what the form currently shows; `applied` is what the results were
   computed from. They diverge as soon as the user touches a dropdown, and only
   the Search button copies one into the other. Nothing recomputes in between —
   the results on screen always correspond to a profile the user submitted. */
let draft = blankProfile();
let applied = null;

const cloneProfile = (p) => ({ ...p, markers: { ...p.markers }, genes: new Set(p.genes) });
const asKey = (p) => (p ? JSON.stringify({ ...p, markers: p.markers, genes: [...p.genes].sort() }) : '');
const isDirty = () => asKey(draft) !== asKey(applied);
const hasInput = (p) => p && (Object.values(p.markers).some(Boolean) || p.genes.size
  || p.sex || p.ageBand || p.eln || p.stage || p.specimen || p.fab || p.fusion
  || p.denovo || p.transformed || p.priorMDS);

let lastResults = null;
let detailDrug = null;
let showMatchedIds = false;
let seeded = false;

function seedFromUrl() {
  if (seeded) return;
  seeded = true;
  const q = new URLSearchParams(location.search);
  const raw = q.get('profile');
  if (raw) {
    for (const tok of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
      const m = MARKERS.find((x) => x.label === tok || `${x.label} (clinical)` === tok);
      if (m) draft.markers[m.label] = 'pos';
      else if (db.mutByGene.has(tok)) draft.genes.add(tok);
    }
  }
  if (q.get('sex')) draft.sex = q.get('sex');
  if (q.get('age')) draft.ageBand = q.get('age');
  if (q.get('eln')) draft.eln = q.get('eln');
  // a shared link is an explicit request for these results, so run it
  if (genomicSteps(draft).length) applied = cloneProfile(draft);
  if (q.get('drug')) detailDrug = q.get('drug');
}

// short labels so the selected value plus its count still fits the box
const TRI = [['', 'Not entered'], ['pos', 'Mutated'], ['neg', 'Wild type']];
const YESNO = [['', 'Not entered'], ['yes', 'Yes'], ['no', 'No']];

function triMatch(value, patientVal) {
  if (!value) return true;                 // not entered -> no constraint
  if (patientVal === null || patientVal === undefined) return false;
  return value === 'pos' ? patientVal === true : patientVal === false;
}

function inBand(age, band) {
  if (!band) return true;
  if (age == null) return false;
  const [lo, hi] = band.split('-').map(Number);
  return age >= lo && age <= hi;
}

/** Every clinical constraint, as a named predicate, so the funnel can attribute
 *  the loss at each step instead of just reporting a final number. */
function clinicalSteps(profile) {
  const steps = [];
  const q = profile;   // always the passed snapshot, never the live form
  if (q.sex) steps.push({ label: `Sex = ${q.sex}`, fn: (p) => p.sex === q.sex });
  if (q.ageBand) {
    const t = AGE_BANDS.find((b) => b[0] === q.ageBand);
    steps.push({ label: `Age ${t ? t[1] : q.ageBand}`, fn: (p) => inBand(p.age, q.ageBand) });
  }
  if (q.eln) steps.push({ label: `ELN ${q.eln}`, fn: (p) => p.eln === q.eln });
  if (q.stage) steps.push({ label: `Stage = ${q.stage}`, fn: (p) => p.stage === q.stage });
  if (q.specimen) steps.push({ label: `Specimen = ${q.specimen}`, fn: (p) => p.specimenType === q.specimen });
  if (q.fab) steps.push({ label: `FAB ${q.fab}`, fn: (p) => p.fab === q.fab });
  if (q.fusion) steps.push({ label: `Fusion ${q.fusion}`, fn: (p) => p.fusion === q.fusion });
  if (q.denovo) steps.push({ label: `De novo = ${q.denovo}`, fn: (p) => p.isDenovo === (q.denovo === 'yes') });
  if (q.transformed) steps.push({ label: `Transformed = ${q.transformed}`, fn: (p) => p.isTransformed === (q.transformed === 'yes') });
  if (q.priorMDS) steps.push({ label: `Prior MDS = ${q.priorMDS}`, fn: (p) => p.priorMDS === (q.priorMDS === 'yes') });
  return steps;
}

function genomicSteps(profile) {
  const steps = [];
  for (const m of MARKERS) {
    const v = profile.markers[m.label];
    if (!v) continue;
    steps.push({
      label: `${m.label} ${v === 'pos' ? 'positive' : 'negative'}`,
      fn: (p) => triMatch(v, p[m.key]),
    });
  }
  for (const g of profile.genes) {
    const carriers = db.mutByGene.get(g) || new Set();
    steps.push({ label: `${g} mutated`, fn: (p) => carriers.has(p.id) });
  }
  return steps;
}

function bh(ps) {
  const idx = ps.map((p, i) => [p, i]).sort((a, b) => a[0] - b[0]);
  const q = new Array(ps.length);
  let prev = 1;
  for (let k = idx.length - 1; k >= 0; k--) {
    const [p, i] = idx[k];
    prev = Math.min(prev, p * ps.length / (k + 1));
    q[i] = prev;
  }
  return q;
}

function parseProfile(text) {
  const known = new Map();
  for (const d of db.geneFreq) known.set(d.gene.toUpperCase(), d.gene);
  const tokens = text.toUpperCase().split(/[^A-Z0-9\-]+/).filter(Boolean);
  const found = new Set(); const unknown = new Set();
  for (const t of tokens) {
    if (known.has(t)) found.add(known.get(t));
    else if (/^[A-Z][A-Z0-9]{2,9}$/.test(t)) unknown.add(t);
  }
  const up = text.toUpperCase();
  if (/FLT3[\s-]*ITD|INTERNAL TANDEM/.test(up)) draft.markers['FLT3-ITD'] = 'pos';
  for (const m of MARKERS) {
    if (m.label === 'FLT3-ITD') continue;
    if (new RegExp(`\\b${m.label}\\b`).test(up)) draft.markers[m.label] = 'pos';
  }
  for (const g of found) draft.genes.add(g);
  return { found, unknown };
}

/* ------------------------------------------------------------------ scoring */
function runMatch() {
  if (!applied) return { needProfile: true, clin: [] };
  const gen = genomicSteps(applied);
  const clin = clinicalSteps(applied);
  if (!gen.length) return { needProfile: true, clin };

  const screened = db.patients.filter((p) => db.drugPtIndex.has(p.id));

  // funnel: apply clinical restrictions one at a time, recording the cost
  const funnel = [{ label: 'Everyone tested with drugs', n: screened.length, drop: 0 }];
  let eligible = screened;
  for (const s of clin) {
    const before = eligible.length;
    eligible = eligible.filter(s.fn);
    funnel.push({ label: s.label, n: eligible.length, drop: before - eligible.length, kind: 'clinical' });
  }
  const eligibleN = eligible.length;

  let matched = eligible;
  for (const s of gen) {
    const before = matched.length;
    matched = matched.filter(s.fn);
    funnel.push({ label: s.label, n: matched.length, drop: before - matched.length, kind: 'genomic' });
  }

  let mode = 'sharing every gene change';
  // if the exact profile is too thin, fall back to "any marker" rather than
  // silently reporting a ranking built on a handful of people
  if (matched.length < 10 && gen.length > 1) {
    matched = eligible.filter((p) => gen.some((s) => s.fn(p)));
    mode = 'sharing at least one gene change';
    funnel.push({ label: 'Relaxed to: at least one marker', n: matched.length, drop: 0, kind: 'relax' });
  }

  const matchedIds = new Set(matched.map((p) => p.id));
  const reference = eligible.filter((p) => !matchedIds.has(p.id));

  const rows = [];
  for (const d of db.drug.drugs) {
    const a = [], b = [];
    for (const p of matched) { const v = auc(p.id, d.name); if (v != null) a.push(v); }
    for (const p of reference) { const v = auc(p.id, d.name); if (v != null) b.push(v); }
    if (a.length < 8 || b.length < 20) continue;
    a.sort((x, y) => x - y); b.sort((x, y) => x - y);
    const medA = quantile(a, 0.5), medB = quantile(b, 0.5);
    const mw = mannWhitney(a, b);
    const entered = [
      ...MARKERS.filter((m) => applied.markers[m.label] === 'pos').map((m) => m.label),
      ...applied.genes,
    ];
    const evidence = db.drug.assoc.filter(
      (x) => x.q < 0.05 && x.drug === d.name
        && entered.some((e) => x.marker === e || x.marker === `${e} (clinical)`),
    );
    rows.push({
      drug: d.name, family: d.family || '—', targets: d.targets || [],
      nMatched: a.length, nRef: b.length,
      medMatched: medA, medRef: medB, delta: medA - medB,
      // human-facing: 0-100, higher = drug killed more cells, positive = better
      scoreMatched: effectScore(medA), scoreRef: effectScore(medB),
      scoreDelta: effectScore(medA) - effectScore(medB),
      p: mw.p, spread: (d.q3 ?? 0) - (d.q1 ?? 0), evidence,
    });
  }
  if (rows.length) {
    const qs = bh(rows.map((r) => r.p));
    rows.forEach((r, i) => { r.q = qs[i]; });
    rows.sort((a, b) => b.scoreDelta - a.scoreDelta);
  }
  return { rows, matched, reference, mode, funnel, eligibleN, clin, gen };
}

/* ------------------------------------------------------------- explainer
   Everything a reader needs before the first chart makes sense, shown once and
   collapsible. The dose–response picture is the important part: "lower AUC is
   better" is the single idea people get wrong, and a sentence does not fix it. */
function explainer(parent) {
  const open = localStorage.getItem('beataml-explainer-open') !== 'no';
  const c = h('div', { class: 'card' }, parent);
  const head = h('div', {
    style: 'display:flex;gap:10px;align-items:center;cursor:pointer',
  }, c);
  h('h3', { text: 'How to read this page', style: 'margin:0' }, head);
  h('span', { style: 'flex:1' }, head);
  const chev = h('span', {
    class: 'hint', style: 'margin:0', text: open ? 'hide' : 'show',
  }, head);
  const body = h('div', {}, c);
  body.hidden = !open;
  head.addEventListener('click', () => {
    body.hidden = !body.hidden;
    chev.textContent = body.hidden ? 'show' : 'hide';
    localStorage.setItem('beataml-explainer-open', body.hidden ? 'no' : 'yes');
  });

  const grid = h('div', {
    style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(255px,1fr));gap:18px;margin-top:12px',
  }, body);

  const block = (title, lines) => {
    const b = h('div', {}, grid);
    h('div', {
      style: 'font-size:12.5px;font-weight:650;margin-bottom:5px',
      text: title,
    }, b);
    for (const t of lines) {
      h('p', {
        style: 'font-size:12.5px;line-height:1.62;color:var(--text-secondary);margin:0 0 7px',
        text: t,
      }, b);
    }
    return b;
  };

  block('1. Where the data comes from', [
    'Researchers collected leukemia cells from 805 patients. For each patient they '
      + 'grew the cells in a dish and dripped on 166 different cancer drugs, one at a time, '
      + 'at several strengths.',
    'Then they counted how many cancer cells were still alive. That is the whole experiment.',
  ]);

  // 2. the measurement, with a picture
  const b2 = block('2. How we score a drug', [
    'Each curve below shows cells dying as the drug gets stronger. A curve that dives '
      + 'means the drug worked; a flat curve means the cells shrugged it off.',
  ]);
  const W = 250, H = 132;
  const m = { l: 30, r: 8, t: 8, b: 26 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const svg = el('svg', {
    width: '100%', style: `max-width:${W}px`, viewBox: `0 0 ${W} ${H}`, role: 'img',
    'aria-label': 'Two dose-response curves: one drug works, one does not',
  }, b2);
  const g = el('g', { transform: `translate(${m.l},${m.t})` }, svg);
  const x = d3.scaleLog().domain([0.0137, 10]).range([0, iw]);
  const y = d3.scaleLinear().domain([0, 105]).range([ih, 0]);
  for (const t of [0, 50, 100]) {
    el('line', { x1: 0, x2: iw, y1: y(t), y2: y(t), class: 'gridline' }, g);
    el('text', { x: -6, y: y(t) + 3.5, 'text-anchor': 'end', class: 'axis-label' }, g)
      .textContent = `${t}`;
  }
  el('line', { x1: 0, x2: iw, y1: ih, y2: ih, class: 'baseline' }, g);
  const curve = (a, bta, color, dashed) => {
    const pts = [];
    for (let i = 0; i <= 40; i++) {
      const cc = 10 ** (Math.log10(0.0137) + (1 - Math.log10(0.0137)) * (i / 40));
      pts.push([x(cc), y(viability(cc, a, bta) * 100)]);
    }
    el('path', {
      d: `M${pts[0][0]},${y(0)} ` + pts.map((p) => `L${p[0]},${p[1]}`).join(' ')
        + ` L${pts[pts.length - 1][0]},${y(0)} Z`,
      fill: color, 'fill-opacity': 0.13,
    }, g);
    el('path', {
      d: `M${pts.map((p) => p.join(',')).join(' L')}`,
      fill: 'none', stroke: color, 'stroke-width': 2, 'stroke-linecap': 'round',
      ...(dashed ? {} : {}),
    }, g);
  };
  curve(3.2, -0.35, 'var(--series-2)');   // resistant: stays high
  curve(0.1, -2.1, 'var(--series-1)');    // sensitive: dives
  el('text', {
    x: iw - 2, y: y(92), 'text-anchor': 'end', class: 'mark-label',
  }, g).textContent = 'score 18';
  el('text', {
    x: iw - 2, y: y(18), 'text-anchor': 'end', class: 'mark-label',
  }, g).textContent = 'score 86';
  el('text', {
    x: -22, y: -1, class: 'axis-label',
  }, g).textContent = '% cells alive';
  el('text', {
    x: iw / 2, y: ih + 20, 'text-anchor': 'middle', class: 'axis-label',
  }, g).textContent = 'drug strength →';
  h('p', {
    style: 'font-size:12.5px;line-height:1.62;color:var(--text-secondary);margin:8px 0 0',
    text: 'We turn each curve into one number: the drug effect score, 0 to 100. '
      + 'Higher = more cancer cells killed. Blue scores 86, orange scores 18.',
  }, b2);
  h('p', {
    style: 'font-size:11.5px;line-height:1.55;color:var(--text-muted);margin:6px 0 0',
    text: `(Papers call this AUC and run it backwards — AUC 0 is the best, ${AUC_MAX} the worst. `
      + 'Score = 100 − AUC/2.86, so it is the same number pointed the intuitive way. Both are shown.)',
  }, b2);

  block('3. What "matched patients" means', [
    'You describe a patient on the left. The tool finds the patients in this group of 805 '
      + 'who have the same gene changes — those are the "matched" patients.',
    'Everyone else becomes the comparison group. Then it asks, drug by drug: did this drug '
      + 'do better on the matched patients than on everybody else?',
  ]);

  block('4. What the confidence words mean', [
    'Any two groups differ a bit by luck alone, so each result gets a number called q. '
      + 'It estimates how often a finding this strong would be a false alarm.',
    'q = 0.01 means about 1 in 100 would be a fluke — labelled "Strong". '
      + 'q = 0.5 means half of them would be — labelled "Could be chance". Lower q, more trustworthy.',
    'Small groups are the main danger. If only 8 patients match, even a big difference is '
      + 'easy to get by luck, so the page warns you.',
  ]);

  return c;
}

/* ------------------------------------------------------- plain-words summary */
/** Turn the result into sentences. The charts below say the same thing, but a
 *  reader should not have to decode them to learn what was found. */
function plainWords(res) {
  const out = [];
  const sig = res.rows.filter((r) => r.q < 0.05);
  const sens = sig.filter((r) => r.scoreDelta > 0);
  const top = sens[0] || res.rows[0];
  const n = res.matched.length;

  // 1. who was compared
  const entered = res.gen.map((s) => s.label).join(', ');
  out.push({
    tone: 'plain',
    text: `You described a patient with ${entered}. ${n} of the 805 patients here have the same gene `
      + `change${n === 1 ? '' : 's'}. The other ${res.reference.length} are the comparison group.`,
  });

  // 2. confidence, stated before the finding rather than after it
  if (n < 20) {
    out.push({
      tone: 'warn',
      text: `${n} is a small number of people. Treat everything below as a hint worth checking, not a result. `
        + `If you set age, sex or other clinical fields, clearing them will usually give you a lot more patients `
        + `— and in this cohort those fields barely affect drug response anyway.`,
    });
  } else if (!sens.length) {
    out.push({
      tone: 'warn',
      text: 'No drug worked convincingly better on these patients than on everyone else. That is a real '
        + 'answer, not a broken search — for some gene changes, nothing in these 166 drugs stands out.',
    });
  }

  // 3. the finding
  if (sens.length) {
    const sM = effectScore(top.medMatched), sR = effectScore(top.medRef);
    out.push({
      tone: 'good',
      text: `${sens.length} drug${sens.length === 1 ? '' : 's'} worked better on matched patients than on `
        + `everyone else. The strongest is ${top.drug}. It scored ${sM} out of 100 on matched patients `
        + `versus ${sR} on the comparison group — ${sM - sR} points better. `
        + `Confidence: ${confidence(top.q).word.toLowerCase()} (q = ${fmtPapprox(top.q)}).`,
    });
    // Do the top hits converge on a shared target gene? That is a far more
    // legible coherence signal than the release's kinase-group family names.
    const counts = {};
    for (const r of sens.slice(0, 8)) {
      for (const t of new Set(r.targets)) counts[t] = (counts[t] || 0) + 1;
    }
    const [domTarget, domN] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0] || [];
    if (domN >= 3) {
      const carried = applied.genes.has(domTarget)
        || MARKERS.some((m) => m.label === domTarget && applied.markers[m.label] === 'pos')
        || (domTarget === 'FLT3' && applied.markers['FLT3-ITD'] === 'pos');
      out.push({
        tone: carried ? 'good' : 'plain',
        text: `${domN} of the top 8 hits target ${domTarget}`
          + (carried
            ? ` — the gene this patient is altered in. Independent drugs converging on the altered gene is the `
              + `strongest pattern this tool can show you.`
            : `, even though that is not a gene you entered. Worth a look at why.`),
      });
    }
  } else if (res.rows.length) {
    out.push({
      tone: 'plain',
      text: `The biggest gap was ${top.drug}, scoring `
        + `${effectScore(top.medMatched) - effectScore(top.medRef)} points better on matched patients — `
        + `but with q = ${fmtPapprox(top.q)} that is the kind of gap luck produces on its own.`,
    });
  }

  // 4. potency reality check
  if (sens.length) {
    const weak = sens.slice(0, 5).filter((r) => r.medMatched > 180).length;
    if (weak >= 2) {
      out.push({
        tone: 'warn',
        text: 'Careful: several of the top drugs only look good *compared with the other group*. Their own '
          + 'scores are still low, meaning most cancer cells survived them. "Better than average" is not '
          + 'the same as "works well".',
      });
    }
  }
  return out;
}

/* --------------------------------------------------------------- field help
   Plain-language definitions, shown on double-click (or on the ⓘ, or on
   keyboard focus of the button — double-click alone is not discoverable and is
   unreachable without a mouse). */
const HELP = {
  Age: 'The patient’s age when the leukemia was diagnosed. Setting this only narrows who the '
    + 'patient is compared against — it does not decide who counts as a match. In this data, age '
    + 'has almost no effect on how cells respond to drugs, so setting it mostly just shrinks the '
    + 'number of patients you have to learn from.',
  Sex: 'Male or female. Like age, this only narrows the comparison group, and it barely affects '
    + 'drug response here. Leave it on "Any" unless you have a specific reason.',
  'ELN 2017 risk': 'A standard risk rating doctors give AML patients — Favorable, Intermediate or '
    + 'Adverse. It is based on which chromosome and gene changes the leukemia has, and it predicts '
    + 'how likely treatment is to work. Favorable patients live substantially longer on average.',
  'Disease stage': 'When the cell sample was taken: at first diagnosis, after the disease came back '
    + '(relapse), while disease was still present after treatment (residual), or during remission. '
    + 'This matters a lot — relapsed leukemia is usually harder to kill.',
  Specimen: 'Where the cells came from: bone marrow (inside the bone, where blood is made), '
    + 'peripheral blood (a normal blood draw), or leukapheresis (a machine that filters white cells '
    + 'out of blood).',
  'FAB morphology': 'An older way of classifying AML by what the cancer cells look like under a '
    + 'microscope, labelled M0 through M7. It describes which blood cell type the leukemia resembles.',
  'De novo': 'Yes means the leukemia arose on its own, with no earlier blood disorder and no prior '
    + 'cancer treatment. No means something came before it. De novo cases generally respond better.',
  Transformed: 'Yes means this leukemia developed out of a different blood disorder the patient '
    + 'already had, rather than starting fresh. Transformed AML is typically harder to treat.',
  'Prior MDS': 'Whether the patient previously had myelodysplastic syndrome — a condition where the '
    + 'bone marrow makes defective blood cells. It often precedes AML and signals a tougher disease.',
  Fusion: 'A fusion happens when two chromosomes break and join, welding two genes into one new '
    + 'hybrid gene that drives the cancer. Specific fusions like PML-RARA or CBFB-MYH11 strongly '
    + 'shape prognosis and treatment.',
  'FLT3-ITD': 'FLT3 is a gene that tells blood cells to grow. An ITD (internal tandem duplication) '
    + 'is a chunk of it accidentally copied twice, jamming the growth signal permanently on. It is '
    + 'one of the most important markers in AML, and drugs exist that target it directly.',
  NPM1: 'NPM1 is a gene whose protein normally works inside the cell nucleus. When mutated, the '
    + 'protein gets stuck in the wrong part of the cell. On its own this usually predicts a better '
    + 'outcome, and it is one of the most common AML mutations.',
  TP53: 'TP53 makes the protein that normally forces damaged cells to self-destruct — it is often '
    + 'called the guardian of the genome. When it is broken, damaged cells survive and resist '
    + 'treatment. TP53-mutant AML is the hardest kind to treat.',
  RUNX1: 'RUNX1 is a master switch controlling how blood cells mature. Mutations block cells from '
    + 'growing up properly, leaving immature cells that pile up. It generally signals higher risk.',
  ASXL1: 'ASXL1 helps control which genes are switched on and off. Mutations scramble that control. '
    + 'It is more common in older patients and usually signals higher risk.',
  'Other mutated genes': 'Any other gene found mutated in this patient’s leukemia. Pick from the '
    + 'list — the number beside each name is how many of the 805 patients here carry it, so bigger '
    + 'numbers mean more evidence to compare against.',
};

function helpFor(parent, label) {
  const text = HELP[label];
  if (!text) return null;
  const panel = h('div', {
    style: 'grid-column:1/-1;font-size:12px;line-height:1.6;color:var(--text-secondary);'
      + 'background:var(--wash);border-radius:8px;padding:9px 11px;margin-top:4px',
  }, parent);
  panel.hidden = true;
  h('b', { text: `${label}: `, style: 'color:var(--text-primary)' }, panel);
  h('span', { text }, panel);
  return panel;
}

/* ------------------------------------------------------------ live counts
   For every dropdown option: how many screened patients would still match if
   you picked it, given everything else currently set. This is the answer to
   "which choices leave me enough people to learn from", shown before the
   click rather than discovered after it. */
function countWith(patch) {
  const trial = cloneProfile(draft);
  Object.assign(trial, patch);
  if (patch.markers) trial.markers = { ...draft.markers, ...patch.markers };
  const gen = genomicSteps(trial);
  const clin = clinicalSteps(trial);
  let pool = db.patients.filter((p) => db.drugPtIndex.has(p.id));
  for (const st of clin) pool = pool.filter(st.fn);
  for (const st of gen) pool = pool.filter(st.fn);
  return pool.length;
}

/** Decorate option labels with the resulting patient count. */
function withCounts(options, patchFor) {
  return options.map(([v, t]) => {
    const n = countWith(patchFor(v));
    return [v, `${t} — ${n}`];
  });
}

/* -------------------------------------------------------------------- form */
function field(parent, label, options, current, onChange) {
  const wrap = h('div', { style: 'display:flex;flex-direction:column;gap:3px;min-width:0' }, parent);
  const lab = h('label', {
    style: 'font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;'
      + 'color:var(--text-muted);font-weight:600;display:flex;align-items:center;gap:5px',
  }, wrap);
  h('span', { text: label }, lab);
  const help = HELP[label] ? h('button', {
    type: 'button', text: 'ⓘ', 'aria-label': `What does ${label} mean?`,
    style: 'border:none;background:none;cursor:pointer;padding:0;font-size:11px;'
      + 'color:var(--text-muted);line-height:1',
  }, lab) : null;
  const s = h('select', {
    style: 'font:inherit;font-size:12.5px;padding:5px 7px;border-radius:7px;width:100%;'
      + 'border:1px solid var(--border);background:var(--plane);color:var(--text-primary)',
  }, wrap);
  for (const [v, t] of options) {
    const o = h('option', { value: v, text: t }, s);
    if (v === current) o.selected = true;
  }
  if (current) s.style.borderColor = 'var(--series-1)';
  s.addEventListener('change', () => onChange(s.value));

  // double-click the dropdown (or click the ⓘ) for a plain-language definition
  const panel = helpFor(parent, label);
  if (panel) {
    const toggle = () => {
      panel.hidden = !panel.hidden;
      if (help) help.style.color = panel.hidden ? 'var(--text-muted)' : 'var(--series-1)';
    };
    s.addEventListener('dblclick', toggle);
    if (help) help.addEventListener('click', toggle);
  }
  return s;
}

const uniq = (key) => [...new Set(db.patients.map((p) => p[key]).filter(Boolean))].sort();

/* ------------------------------------------------------------------- view */
export function render(root) {
  root.textContent = '';
  seedFromUrl();

  const layout = h('div', {
    style: 'display:grid;grid-template-columns:minmax(310px,360px) 1fr;gap:14px;align-items:start',
  }, root);
  if (window.innerWidth < 860) layout.style.gridTemplateColumns = '1fr';

  const rerender = () => render(root);

  /* ---------------------------------------------------------- intake form */
  const form = h('div', { class: 'card' }, layout);
  h('h3', { text: 'Patient details' }, form);
  h('p', {
    class: 'hint',
    text: 'Describe the patient. Genomic markers decide which cohort patients count as a match; '
      + 'clinical details restrict who they are compared against.',
  }, form);
  h('p', {
    class: 'hint',
    style: 'margin-top:-4px',
    text: 'The number after each option is how many screened patients you would be left with if you '
      + 'picked it. Keep it above 20 — below that the results are too noisy to trust.',
  }, form);

  const section = (title, note) => {
    h('div', {
      style: 'font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--text-secondary);'
        + 'font-weight:700;margin:16px 0 2px;padding-top:10px;border-top:1px solid var(--grid)',
      text: title,
    }, form);
    if (note) h('div', { class: 'hint', style: 'margin:0 0 8px', text: note }, form);
    return h('div', {
      style: 'display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:6px',
    }, form);
  };

  // --- demographics
  const g1 = section('Demographics', 'Restricts the comparison group.');
  field(g1, 'Age', withCounts(AGE_BANDS, (v) => ({ ageBand: v })), draft.ageBand,
    (v) => { draft.ageBand = v; rerender(); });
  field(g1, 'Sex', withCounts([['', 'Any'], ['Male', 'Male'], ['Female', 'Female']],
    (v) => ({ sex: v })), draft.sex, (v) => { draft.sex = v; rerender(); });

  // --- disease
  const g2 = section('Disease', 'Also restricts the comparison group.');
  field(g2, 'ELN 2017 risk', withCounts([['', 'Any'],
    ...['Favorable', 'Intermediate', 'Adverse'].map((v) => [v, v])], (v) => ({ eln: v })),
  draft.eln, (v) => { draft.eln = v; rerender(); });
  field(g2, 'Disease stage', withCounts([['', 'Any'], ...uniq('stage').map((v) => [v, v])],
    (v) => ({ stage: v })), draft.stage, (v) => { draft.stage = v; rerender(); });
  field(g2, 'Specimen', withCounts([['', 'Any'], ...uniq('specimenType').map((v) => [v, v])],
    (v) => ({ specimen: v })), draft.specimen, (v) => { draft.specimen = v; rerender(); });
  field(g2, 'FAB morphology', withCounts([['', 'Any'], ...uniq('fab').map((v) => [v, v])],
    (v) => ({ fab: v })), draft.fab, (v) => { draft.fab = v; rerender(); });
  field(g2, 'De novo', withCounts(YESNO, (v) => ({ denovo: v })), draft.denovo,
    (v) => { draft.denovo = v; rerender(); });
  field(g2, 'Transformed', withCounts(YESNO, (v) => ({ transformed: v })), draft.transformed,
    (v) => { draft.transformed = v; rerender(); });
  field(g2, 'Prior MDS', withCounts(YESNO, (v) => ({ priorMDS: v })), draft.priorMDS,
    (v) => { draft.priorMDS = v; rerender(); });
  field(g2, 'Fusion', withCounts([['', 'Any'], ...db.fusions.map((v) => [v, v])],
    (v) => ({ fusion: v })), draft.fusion, (v) => { draft.fusion = v; rerender(); });

  // --- genomics
  const g3 = section('Genomic markers', 'These define a match. "Negative" matches too.');
  for (const m of MARKERS) {
    field(g3, m.label, withCounts(TRI, (v) => ({ markers: { [m.label]: v } })),
      draft.markers[m.label], (v) => { draft.markers[m.label] = v; rerender(); });
  }

  // other mutated genes
  const ogLab = h('div', {
    style: 'font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;color:var(--text-muted);'
      + 'font-weight:600;margin:12px 0 3px;display:flex;align-items:center;gap:5px',
  }, form);
  h('span', { text: 'Other mutated genes' }, ogLab);
  const ogHelp = h('button', {
    type: 'button', text: 'ⓘ', 'aria-label': 'What does Other mutated genes mean?',
    style: 'border:none;background:none;cursor:pointer;padding:0;font-size:11px;'
      + 'color:var(--text-muted);line-height:1',
  }, ogLab);
  const gsel = h('select', {
    style: 'width:100%;font:inherit;font-size:12.5px;padding:5px 7px;border-radius:7px;'
      + 'border:1px solid var(--border);background:var(--plane);color:var(--text-primary)',
  }, form);
  h('option', { value: '', text: 'add a gene…' }, gsel);
  for (const d of db.geneFreq) {
    if (MARKERS.some((m) => m.label === d.gene)) continue;
    // count with this gene added to whatever is already selected
    const trial = cloneProfile(draft);
    trial.genes = new Set(draft.genes).add(d.gene);
    const gen = genomicSteps(trial); const clin = clinicalSteps(trial);
    let pool = db.patients.filter((q) => db.drugPtIndex.has(q.id));
    for (const st of clin) pool = pool.filter(st.fn);
    for (const st of gen) pool = pool.filter(st.fn);
    h('option', { value: d.gene, text: `${d.gene} — ${pool.length}` }, gsel);
  }
  const ogPanel = helpFor(form, 'Other mutated genes');
  const ogToggle = () => {
    ogPanel.hidden = !ogPanel.hidden;
    ogHelp.style.color = ogPanel.hidden ? 'var(--text-muted)' : 'var(--series-1)';
  };
  ogHelp.addEventListener('click', ogToggle);
  gsel.addEventListener('dblclick', ogToggle);
  gsel.addEventListener('change', () => {
    if (gsel.value) { draft.genes.add(gsel.value); rerender(); }
  });
  if (draft.genes.size) {
    const chips = h('div', { style: 'display:flex;gap:6px;flex-wrap:wrap;margin-top:7px' }, form);
    for (const g of draft.genes) {
      const chip = h('span', { class: 'chip' }, chips);
      h('span', { text: g }, chip);
      const x = h('button', { type: 'button', text: '×', 'aria-label': `Remove ${g}` }, chip);
      x.addEventListener('click', () => { draft.genes.delete(g); rerender(); });
    }
  }

  // --- paste
  h('div', {
    style: 'font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;color:var(--text-muted);'
      + 'font-weight:600;margin:14px 0 3px',
    text: 'Or paste a variant list',
  }, form);
  const ta = h('textarea', {
    rows: '3', placeholder: 'FLT3-ITD, NPM1, DNMT3A, IDH2',
    style: 'width:100%;font-size:12px;font-family:var(--mono);padding:7px;'
      + 'border:1px solid var(--border);border-radius:7px;background:var(--plane);'
      + 'color:var(--text-primary);resize:vertical',
  }, form);
  const note = h('div', { class: 'hint', style: 'margin:5px 0 0' }, form);
  const readBtn = h('button', { class: 'btn', type: 'button', text: 'Read variant list', style: 'margin-top:7px' }, form);
  readBtn.addEventListener('click', () => {
    const { found, unknown } = parseProfile(ta.value);
    note.textContent = found.size
      ? `Added ${found.size} gene(s).${unknown.size ? ` Not in this dataset: ${[...unknown].slice(0, 6).join(', ')}.` : ''}`
      : 'No recognised gene symbols in that text.';
    lastResults = null;
    rerender();
  });

  // ---- Search: the only thing that computes results
  const bar = h('div', {
    style: 'position:sticky;bottom:0;margin:16px -16px -16px;padding:12px 16px;'
      + 'background:var(--surface-1);border-top:1px solid var(--border);'
      + 'border-radius:0 0 var(--radius) var(--radius)',
  }, form);
  const ready = genomicSteps(draft).length > 0;
  const search = h('button', {
    type: 'button',
    text: applied && !isDirty() ? 'Search again' : 'Search',
    style: 'width:100%;font:inherit;font-size:14px;font-weight:600;padding:10px 14px;'
      + 'border-radius:9px;border:1px solid transparent;'
      + `background:${ready ? 'var(--series-1)' : 'var(--wash)'};`
      + `color:${ready ? '#fff' : 'var(--text-muted)'};`
      + `cursor:${ready ? 'pointer' : 'not-allowed'};`,
  }, bar);
  search.disabled = !ready;
  search.addEventListener('click', () => {
    applied = cloneProfile(draft);
    lastResults = null;
    detailDrug = null;
    rerender();
  });
  h('div', {
    class: 'hint', style: 'margin:7px 0 0;text-align:center',
    text: !ready ? 'Set at least one genomic marker to search'
      : isDirty() && applied ? 'You have changed the form — press Search to update the results'
        : applied ? 'Results below match this form' : 'Press Search when the form is filled in',
  }, bar);

  if (hasInput(draft)) {
    const clr = h('button', {
      class: 'btn', type: 'button', text: 'Clear the form',
      style: 'width:100%;margin-top:8px',
    }, bar);
    clr.addEventListener('click', () => {
      draft = blankProfile();
      applied = null; lastResults = null; detailDrug = null;
      rerender();
    });
  }

  /* ---------------------------------------------------------------- output */
  const out = h('div', { style: 'min-width:0;display:flex;flex-direction:column;gap:14px' }, layout);
  explainer(out);
  if (applied && isDirty()) {
    const st = h('div', { class: 'card' }, out);
    st.style.borderColor = 'var(--status-warning)';
    st.style.padding = '11px 14px';
    h('div', {
      style: 'font-size:13px;color:var(--text-primary)',
      text: 'The form has changed since these results were calculated. Press Search to update them.',
    }, st);
  }
  const res = lastResults || runMatch();
  lastResults = res;

  if (!applied) {
    const c = h('div', { class: 'card' }, out);
    h('h3', { text: hasInput(draft) ? 'Ready when you are' : 'Describe a patient to begin' }, c);
    h('p', {
      class: 'hint',
      text: hasInput(draft)
        ? 'Your details are entered. Press the blue Search button at the bottom of the form to see which '
          + 'drugs worked best on patients like this one.'
        : 'Fill in the dropdowns on the left — at minimum one genomic marker such as FLT3-ITD, NPM1 or '
          + 'TP53 — then press Search. Nothing is calculated until you do.',
    }, c);
    return;
  }

  if (res.needProfile) {
    const c = h('div', { class: 'card' }, out);
    h('h3', { text: 'Start by entering a gene change' }, c);
    h('p', {
      class: 'hint',
      text: 'Age, sex and the clinical fields decide who the patient is compared against, but they do not '
        + 'define a match on their own — in this cohort they barely move ex vivo drug response at all '
        + '(sex p ≈ 0.09–0.11, age p ≈ 0.07–0.92, versus p ≈ 5e-16 for FLT3-ITD). Set FLT3-ITD, NPM1, TP53, '
        + 'or add a mutated gene to get a ranking.',
    }, c);
    if (res.clin.length) {
      h('p', {
        class: 'hint',
        text: `Clinical details entered so far: ${res.clin.map((s) => s.label).join(', ')}.`,
      }, c);
    }
    return;
  }

  // --- plain-words summary, first thing on the page
  if (res.rows.length) {
    const c = h('div', { class: 'card' }, out);
    c.style.borderLeft = '3px solid var(--series-1)';
    h('h3', { text: 'In plain words' }, c);
    for (const line of plainWords(res)) {
      const row = h('div', {
        style: 'display:flex;gap:9px;align-items:flex-start;margin-top:9px',
      }, c);
      const dot = h('span', {}, row);
      dot.style.cssText = 'width:7px;height:7px;border-radius:50%;flex:none;margin-top:6px;background:'
        + (line.tone === 'warn' ? 'var(--status-warning)'
          : line.tone === 'good' ? 'var(--status-good)' : 'var(--text-muted)');
      h('span', {
        style: `font-size:13.5px;line-height:1.6;color:var(--text-${line.tone === 'plain' ? 'secondary' : 'primary'})`,
        text: line.text,
      }, row);
    }
  }

  // --- the headline answer: top 2 picks, with the full write-up on each
  if (res.rows.length) {
    const MIN_N = 20;   // a headline pick should not rest on a handful of people
    const all = res.rows.filter((r) => r.q < 0.05 && r.scoreDelta > 0);
    const solid = all.filter((r) => r.nMatched >= MIN_N);
    // fall back to the thin ones only if there is nothing better, and say so
    const eligible = solid.length >= 2 ? solid : all;
    const thinFallback = solid.length < 2 && all.length > 0;
    /* Rank-sum over two criteria rather than an invented weighted formula:
       how well the drug worked in absolute terms, and how much better it did on
       matched patients than on everyone else. A drug has to place well on both,
       which is what keeps a merely-better-than-a-bad-field drug off the list. */
    const byAbs = eligible.slice().sort((a, b) => b.scoreMatched - a.scoreMatched);
    const byDelta = eligible.slice().sort((a, b) => b.scoreDelta - a.scoreDelta);
    const rank = new Map();
    eligible.forEach((r) => rank.set(r.drug, byAbs.indexOf(r) + byDelta.indexOf(r)));
    const picks = eligible.slice().sort((a, b) => rank.get(a.drug) - rank.get(b.drug)).slice(0, 2);

    const c = h('div', { class: 'card' }, out);
    c.style.borderLeft = '3px solid var(--status-good)';
    h('h3', { text: picks.length ? `Top ${picks.length} recommended drug${picks.length > 1 ? 's' : ''}` : 'No drug stands out' }, c);

    if (!picks.length) {
      h('p', {
        class: 'hint',
        text: 'No drug both beat the comparison group convincingly and killed a meaningful share of cells. '
          + 'For this profile the honest answer is that nothing in the 166-drug panel stands out.',
      }, c);
    } else {
      h('p', {
        class: 'hint',
        text: 'Ranked on two things together: how many cancer cells the drug killed, and how much better it '
          + 'did on patients matching this profile than on everyone else. Both have to be strong to appear here. '
          + 'This is what the data suggests to look at — it is not medical advice.',
      }, c);

      picks.forEach((r, i) => {
        const block = h('div', {
          style: `margin-top:${i ? 18 : 12}px;padding-top:${i ? 18 : 0}px;`
            + `${i ? 'border-top:1px solid var(--grid);' : ''}`,
        }, c);
        const head = h('div', {
          style: 'display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:8px',
        }, block);
        const badge = h('span', {
          text: `#${i + 1}`,
          style: 'font-size:13px;font-weight:700;color:#fff;background:var(--status-good);'
            + 'border-radius:999px;padding:2px 10px;flex:none',
        }, head);
        h('span', { style: 'font-size:16px;font-weight:650', text: r.drug }, head);
        // druginfo.json may still be in flight, so reserve the slot and fill
        // it when the fetch lands rather than reading db.drugInfo synchronously
        const pill = h('span', { class: 'pill' }, head);
        pill.hidden = true;
        ensureDrugInfo().then(() => {
          const st = db.drugInfo?.[r.drug]?.curated?.status;
          if (!st) return;
          pill.textContent = st;
          pill.hidden = false;
          const tone = st === 'Approved' ? 'var(--status-good)'
            : st === 'Investigational' ? 'var(--status-warning)' : 'var(--text-muted)';
          pill.style.borderColor = tone;
          pill.style.color = tone;
        });
        h('span', { style: 'flex:1' }, head);
        const conf = confidence(r.q);
        const stat = h('span', {
          class: 'hint', style: 'margin:0',
          text: `Killed ${r.scoreMatched}/100 · ${r.scoreDelta > 0 ? '+' : ''}${r.scoreDelta} better than the `
            + `comparison group · confidence ${conf.word.toLowerCase()} · ${r.nMatched} matched patients`,
        }, head);
        stat.style.color = TONE[conf.tone];
        if (r.nMatched < MIN_N) {
          const warn = h('p', { class: 'hint', style: 'margin:0 0 8px' }, block);
          warn.style.color = 'var(--status-warning)';
          warn.textContent = `Only ${r.nMatched} matched patients were actually screened against this drug, `
            + 'so this ranking rests on a small sample — treat it as a lead, not a finding.';
        }
        drugCard(block, r.drug, { header: false });
      });

      h('p', {
        class: 'hint', style: 'margin-top:14px',
        text: `Chosen from ${eligible.length} drugs that beat the comparison group with confidence`
          + `${thinFallback
            ? `, none of which reached ${MIN_N} screened matched patients — so the sample behind these is thin`
            : `, each screened on at least ${MIN_N} matched patients`}. The rest are in Step 2 below.`,
      }, c);
    }
  }

  // --- funnel
  {
    const c = h('div', { class: 'card' }, out);
    h('h3', { text: 'Step 1 · Who in the group looks like this patient' }, c);
    const thin = res.matched.length < 20;
    h('p', {
      class: 'hint',
      text: `${res.matched.length} patients match (${res.mode}). They are compared against the other `
        + `${res.reference.length} of the ${res.eligibleN} patients who fit the clinical details you set.`,
    }, c);

    const rows = res.funnel;
    const W = 560, ROW = 21;
    const svg = el('svg', {
      width: '100%', style: `max-width:${W}px`,
      viewBox: `0 0 ${W} ${rows.length * ROW + 10}`, role: 'img',
    }, c);
    const max = rows[0].n || 1;
    const x = d3.scaleLinear().domain([0, max]).range([0, W - 300]);
    rows.forEach((r, i) => {
      const y = i * ROW + 5;
      el('text', { x: 236, y: y + 12, 'text-anchor': 'end', class: 'axis-label' }, svg)
        .textContent = r.label.length > 34 ? `${r.label.slice(0, 33)}…` : r.label;
      const w = Math.max(1, x(r.n));
      el('path', {
        d: barPath(244, y + 3, w, 13, 4, 'right'),
        fill: r.kind === 'genomic' ? 'var(--series-2)'
          : r.kind === 'relax' ? 'var(--series-3)' : 'var(--series-1)',
        'fill-opacity': i === 0 ? 0.45 : 1,
      }, svg);
      el('text', { x: 244 + w + 7, y: y + 14, class: 'mark-label' }, svg)
        .textContent = r.drop ? `${r.n}  (−${r.drop})` : `${r.n}`;
    });
    legend(c, [
      { label: 'Removed by a clinical detail you set', color: 'var(--series-1)' },
      { label: 'Kept because the genes match', color: 'var(--series-2)' },
    ]);
    if (thin) {
      const warn = h('p', { class: 'hint' }, c);
      warn.style.color = 'var(--status-critical)';
      warn.textContent = 'Fewer than 20 patients match. With numbers this small, big differences turn up '
        + 'by luck all the time. Clearing an age, sex or disease dropdown usually gives you many more '
        + 'patients to work with.';
    }

    const tgl = h('button', {
      class: 'toggle-table', type: 'button',
      text: showMatchedIds ? 'Hide matched patients' : `Show the ${res.matched.length} matched patients`,
    }, c);
    tgl.addEventListener('click', () => { showMatchedIds = !showMatchedIds; rerender(); });
    if (showMatchedIds) {
      const strip = h('div', { style: 'display:flex;gap:6px;flex-wrap:wrap;margin-top:8px' }, c);
      for (const p of res.matched) {
        const b = h('button', {
          class: 'btn', type: 'button', text: `${p.id}`, style: 'padding:2px 8px;font-size:11.5px',
        }, strip);
        b.addEventListener('click', () => window.dispatchEvent(new CustomEvent('goto-patient', { detail: p.id })));
      }
    }
  }

  if (!res.rows.length) {
    const c = h('div', { class: 'card' }, out);
    h('h3', { text: 'Too few matching patients to say anything' }, c);
    h('p', {
      class: 'hint',
      text: 'Not enough patients match to compare anything reliably. Set fewer dropdowns and try again.',
    }, c);
    return;
  }

  // --- ranking
  {
    const c = h('div', { class: 'card' }, out);
    h('h3', { text: 'Step 2 · Which drugs did better on those patients' }, c);
    h('p', {
      class: 'hint',
      text: 'Bars to the RIGHT = the drug worked better on matched patients than on everyone else. '
        + 'Longer bar = bigger advantage, measured in score points out of 100. Faded bars could be chance. '
        + 'Click any row to see the individual patients behind it.',
    }, c);

    const top = res.rows.slice(0, 15);
    const W = 660, ROW = 26, LAB = 210;
    const svg = el('svg', {
      width: '100%', style: `max-width:${W}px`,
      viewBox: `0 0 ${W} ${top.length * ROW + 34}`, role: 'img',
    }, c);
    const maxAbs = Math.max(8, ...top.map((r) => Math.abs(r.scoreDelta)));
    const x = d3.scaleLinear().domain([-maxAbs, maxAbs]).range([LAB, W - 196]);
    for (const t of x.ticks(5)) {
      el('line', {
        x1: x(t), x2: x(t), y1: 16, y2: top.length * ROW + 16,
        class: t === 0 ? 'baseline' : 'gridline',
      }, svg);
      el('text', { x: x(t), y: 11, 'text-anchor': 'middle', class: 'axis-label' }, svg).textContent = fmt(t);
    }
    top.forEach((r, i) => {
      const y = i * ROW + 20;
      el('text', { x: LAB - 9, y: y + 12, 'text-anchor': 'end', class: 'axis-label' }, svg)
        .textContent = r.drug.length > 28 ? `${r.drug.slice(0, 27)}…` : r.drug;
      const x0 = Math.min(x(0), x(r.scoreDelta)), w = Math.abs(x(r.scoreDelta) - x(0));
      el('path', {
        d: barPath(x0, y + 2, Math.max(1.5, w), 15, 4, r.scoreDelta < 0 ? 'left' : 'right'),
        fill: r.scoreDelta > 0 ? 'var(--series-1)' : 'var(--series-2)',
        'fill-opacity': r.q < 0.05 ? 1 : 0.35,
      }, svg);
      el('text', { x: W - 190, y: y + 14, class: 'mark-label' }, svg)
        .textContent = `${r.scoreDelta > 0 ? '+' : ''}${r.scoreDelta}`;
      const conf = confidence(r.q);
      const ct = el('text', { x: W - 152, y: y + 14, class: 'mark-label' }, svg);
      ct.textContent = conf.word;
      // inline style, not a fill attribute: the .mark-label CSS rule outranks a
      // presentation attribute, so setAttribute('fill') would be ignored
      ct.style.fill = TONE[conf.tone];
      const hit = el('rect', { x: 0, y: i * ROW + 16, width: W, height: ROW, class: 'hit' }, svg);
      hoverable(hit, r.drug, () => [
        { value: `${r.scoreMatched}/100`, label: `score on the ${r.nMatched} matched patients`, color: 'var(--series-1)' },
        { value: `${r.scoreRef}/100`, label: `score on the ${r.nRef} others` },
        { value: `${r.scoreDelta > 0 ? '+' : ''}${r.scoreDelta}`, label: 'points better' },
        { value: confidence(r.q).word, label: `confidence (q = ${fmtPapprox(r.q)})` },
        { value: `${fmt(r.medMatched, 1)} vs ${fmt(r.medRef, 1)}`, label: 'AUC, for reference' },
        { value: r.family, label: 'target family' },
        ...(r.evidence.length ? [{ value: `${r.evidence.length}`, label: 'supporting cohort association(s)' }] : []),
      ], () => { detailDrug = r.drug; rerender(); });
    });
    el('text', {
      x: (x(-maxAbs) + x(maxAbs)) / 2, y: top.length * ROW + 30, 'text-anchor': 'middle', class: 'axis-title',
    }, svg).textContent = 'Score points better (right) or worse (left) than the comparison group';
    legend(c, [
      { label: 'Worked better on matched patients', color: 'var(--series-1)' },
      { label: 'Worked worse', color: 'var(--series-2)' },
    ]);

    tableView(c, [
      { key: 'drug', label: 'Drug' },
      { key: 'scoreMatched', label: 'Score on matched (0–100)' },
      { key: 'scoreRef', label: 'Score on others' },
      { key: 'scoreDelta', label: 'Points better', fmt: (v) => `${v > 0 ? '+' : ''}${v}` },
      { key: 'conf', label: 'Confidence' },
      { key: 'nMatched', label: 'Matched patients' },
      { key: 'family', label: 'Target family' },
      { key: 'medMatched', label: 'AUC (matched)', fmt: (v) => fmt(v, 1) },
      { key: 'q', label: 'q', fmt: (v) => fmtPapprox(v) },
    ], res.rows.map((r) => ({ ...r, conf: confidence(r.q).word })),
    { label: `all ${res.rows.length} drugs tested` });
  }

  // --- potency crosscheck
  {
    const c = h('div', { class: 'card' }, out);
    h('h3', { text: 'Step 3 · Did the drug actually work, or just beat a low bar?' }, c);
    h('p', {
      class: 'hint',
      text: 'Step 2 ranks drugs by how much BETTER they did on matched patients than on everyone else. '
        + 'That is not the same as working well — a drug can win a race in which everybody was slow. '
        + 'This table shows each drug\'s own score out of 100 beside its advantage. You want both to be high.',
    }, c);
    tableView(c, [
      { key: 'drug', label: 'Drug' },
      { key: 'scoreMatched', label: 'Its own score (0–100)' },
      { key: 'scoreDelta', label: 'Points better than others', fmt: (v) => `${v > 0 ? '+' : ''}${v}` },
      { key: 'verdict', label: 'What that means' },
    ], res.rows.slice(0, 15).map((r) => ({
      ...r,
      verdict: r.q >= 0.05 ? 'Gap could be chance — ignore for now'
        : r.scoreMatched >= 48 ? 'Killed most cells AND beat the comparison group'
          : r.scoreMatched >= 35 ? 'Beat the comparison group, killed a fair number of cells'
            : 'Beat the comparison group, but still killed few cells',
    })), { open: true, label: 'assessment' });
  }

  // --- per-drug detail
  if (detailDrug) {
    const r = res.rows.find((q) => q.drug === detailDrug);
    if (r) {
      // ---- reference card: what this drug actually is
      const ref = h('div', { class: 'card' }, out);
      ref.style.borderLeft = '3px solid var(--series-1)';
      h('h3', { text: 'About this drug' }, ref);
      drugCard(ref, r.drug);

      const c = h('div', { class: 'card' }, out);
      h('h3', { text: `${r.drug} — matched vs comparison group` }, c);
      const mset = new Set(res.matched.map((p) => p.id));
      const bars = [];
      for (const p of [...res.matched, ...res.reference]) {
        const v = auc(p.id, r.drug);
        if (v == null) continue;
        const m = mset.has(p.id);
        bars.push({
          id: p.id, value: v, color: m ? 'var(--series-2)' : 'var(--series-1)',
          title: `Patient ${p.id}`,
          rows: () => [
            { value: fmt(v, 1), label: `AUC — ${r.drug}`, color: m ? 'var(--series-2)' : 'var(--series-1)' },
            { value: m ? 'matches this profile' : 'comparison group', label: '' },
            { value: p.eln || '—', label: 'ELN 2017' },
          ],
        });
      }
      bars.sort((a, b) => a.value - b.value);
      waterfall(c, bars, {
        width: 620, height: 240, yLabel: `AUC — ${r.drug}`,
        onClick: (d) => window.dispatchEvent(new CustomEvent('goto-patient', { detail: d.id })),
        legendItems: [
          { label: 'Matches this profile', color: 'var(--series-2)' },
          { label: 'Comparison group', color: 'var(--series-1)' },
        ],
      });
      h('p', {
        class: 'hint',
        text: 'If the profile really predicts response, the orange bars cluster at the sensitive end. Scattered '
          + 'orange means the median difference is not something to act on for an individual.',
      }, c);
      if (r.evidence.length) {
        h('div', {
          style: 'font-size:12px;font-weight:650;margin:10px 0 4px;color:var(--text-secondary)',
          text: 'Supporting cohort-wide associations',
        }, c);
        for (const e of r.evidence) {
          h('div', {
            class: 'hint', style: 'margin:0',
            text: `${e.marker}: Δ ${e.delta > 0 ? '+' : ''}${e.delta} AUC, q = ${fmtPapprox(e.q)} `
              + `(${e.nPos} mutated vs ${e.nNeg} wild type, full cohort)`,
          }, c);
        }
      }
    }
  }

  // --- standing caveat
  {
    const c = h('div', { class: 'card' }, out);
    c.style.borderColor = 'var(--status-warning)';
    h('h3', { text: 'What this is not' }, c);
    const ul = h('ul', {
      style: 'font-size:12.5px;color:var(--text-secondary);padding-left:18px;line-height:1.7;margin:6px 0 0',
    }, c);
    for (const t of [
      'Not a treatment recommendation. This is an ex vivo screen — patient cells in a plate for three days, with '
        + 'no pharmacokinetics, no marrow microenvironment and no immune system.',
      'Most of these compounds are research tools, not approved therapies, and several that look potent here have '
        + 'failed in clinical trials.',
      'Matched-vs-comparison is observational. The two groups differ in more than what you entered — treatment '
        + 'history above all.',
      'Real therapy selection runs on ELN risk, patient fitness, and validated molecular findings, and is a '
        + 'clinical decision.',
    ]) h('li', { text: t }, ul);
  }
}
