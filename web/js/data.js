/* Data loading, indexing, and the global filter store. */

export const VC_GROUP = {
  Missense: 'Missense',
  Frameshift: 'Truncating',
  Nonsense: 'Truncating',
  Splice: 'Truncating',
  'In-frame del': 'In-frame indel',
  'In-frame ins': 'In-frame indel',
  Other: 'Other',
};

/* Three all-pairs-validated hues + a neutral. Colour follows the variant class
   (the entity), never its frequency rank. */
export const VC_COLOR = {
  Missense: 'var(--vc-missense)',
  Truncating: 'var(--vc-truncating)',
  'In-frame indel': 'var(--vc-inframe)',
  Other: 'var(--vc-other)',
};
export const VC_ORDER = ['Missense', 'Truncating', 'In-frame indel', 'Other'];

export const db = {
  patients: [], byId: new Map(),
  mutations: [], mutByPatient: new Map(), mutByGene: new Map(),
  genesByPatient: new Map(),
  sequenced: new Set(),
  geneFreq: [], topGenes: [], pairs: [],
  drug: null, drugPtIndex: new Map(), drugNameIndex: new Map(),
  fusions: [],
  // lazily populated (see ensureFits / ensureExpr / ensureBiomarkers)
  fits: null, expr: null, exprGene: null, exprPt: null, biomarkers: null,
  drugInfo: null,
};

export async function loadAll() {
  const [cohort, mutations, drugs] = await Promise.all([
    fetch('data/cohort.json').then((r) => r.json()),
    fetch('data/mutations.json').then((r) => r.json()),
    fetch('data/drugs.json').then((r) => r.json()),
  ]);

  db.patients = cohort.patients;
  db.geneFreq = cohort.geneFreq;
  db.topGenes = cohort.topGenes;
  db.pairs = cohort.pairs;
  db.sequenced = new Set(cohort.sequenced);
  for (const p of db.patients) db.byId.set(p.id, p);

  db.mutations = mutations;
  for (const m of mutations) {
    m.grp = VC_GROUP[m.c] || 'Other';
    if (!db.mutByPatient.has(m.p)) db.mutByPatient.set(m.p, []);
    db.mutByPatient.get(m.p).push(m);
    if (!db.mutByGene.has(m.g)) db.mutByGene.set(m.g, new Set());
    db.mutByGene.get(m.g).add(m.p);
    if (!db.genesByPatient.has(m.p)) db.genesByPatient.set(m.p, new Set());
    db.genesByPatient.get(m.p).add(m.g);
  }

  db.drug = drugs;
  drugs.patients.forEach((p, i) => db.drugPtIndex.set(p, i));
  drugs.drugs.forEach((d, i) => db.drugNameIndex.set(d.name, i));

  db.fusions = [...new Set(db.patients.map((p) => p.fusion).filter(Boolean))].sort();

  // Per-drug distribution stats over the full cohort, used to place an
  // individual patient against the population.
  for (const d of drugs.drugs) {
    const j = db.drugNameIndex.get(d.name);
    const vals = [];
    for (let i = 0; i < drugs.auc.length; i++) {
      const v = drugs.auc[i][j];
      if (v != null) vals.push(v);
    }
    vals.sort((a, b) => a - b);
    d.sorted = vals;
    const n = vals.length;
    d.mean = n ? vals.reduce((s, v) => s + v, 0) / n : null;
    d.sd = n > 1 ? Math.sqrt(vals.reduce((s, v) => s + (v - d.mean) ** 2, 0) / (n - 1)) : null;
  }
  return db;
}

/* ------------------------------------------------- lazy secondary payloads
   These are big and only some views need them, so they load on demand and the
   view re-renders when they arrive. */
const lazy = {};
function once(key, url, after) {
  if (!lazy[key]) {
    lazy[key] = fetch(url).then((r) => {
      if (!r.ok) throw new Error(`${url}: ${r.status}`);
      return r.json();
    }).then((json) => { after(json); return json; });
  }
  return lazy[key];
}

export const ensureFits = () => once('fits', 'data/fits.json', (j) => { db.fits = j; });

export const ensureExpr = () => once('expr', 'data/expr.json', (j) => {
  db.expr = j;
  db.exprGene = new Map(j.genes.map((g, i) => [g, i]));
  db.exprPt = new Map(j.patients.map((p, i) => [p, i]));
});

export const ensureBiomarkers = () => once('bio', 'data/biomarkers.json', (j) => {
  db.biomarkers = j;
});

export const ensureDrugInfo = () => once('drugInfo', 'data/druginfo.json', (j) => {
  db.drugInfo = j;
});

const doseCache = new Map();
/** Measured dose-response points for one patient: {drug: [[conc, viability%]]} */
export function loadDose(patientId) {
  if (!doseCache.has(patientId)) {
    doseCache.set(patientId, fetch(`data/dose/${patientId}.json`)
      .then((r) => (r.ok ? r.json() : {}))
      .catch(() => ({})));
  }
  return doseCache.get(patientId);
}

/** Probit parameters for one patient x drug, or null. */
export function curveFit(patientId, drugName) {
  if (!db.fits) return null;
  const i = db.drugPtIndex.get(patientId);
  const j = db.drugNameIndex.get(drugName);
  if (i === undefined || j === undefined) return null;
  const a = db.fits.intercept[i][j], b = db.fits.beta[i][j];
  if (a == null || b == null) return null;
  return { intercept: a, beta: b, conc: db.fits.conc[drugName] || [0.0137, 10] };
}

/** Normalised expression for a patient/gene, and its cohort z-score. */
export function exprValue(patientId, gene) {
  if (!db.expr) return null;
  const gi = db.exprGene.get(gene), pi = db.exprPt.get(patientId);
  if (gi === undefined || pi === undefined) return null;
  return db.expr.values[gi][pi];
}
export function exprZ(patientId, gene) {
  const v = exprValue(patientId, gene);
  if (v == null) return null;
  const gi = db.exprGene.get(gene);
  const sd = db.expr.sd[gi];
  return sd ? (v - db.expr.mean[gi]) / sd : null;
}
/** All cohort values for a gene, as a plain array aligned to db.expr.patients. */
export function exprRow(gene) {
  if (!db.expr) return null;
  const gi = db.exprGene.get(gene);
  return gi === undefined ? null : db.expr.values[gi];
}

/* --------------------------------------------------------- effect score
   AUC is the field-standard number, but it runs "backwards" (lower = the drug
   worked better) and tops out at an arbitrary-looking 286.33. That trips up
   every reader who has not been told. effectScore is a plain rescaling of the
   same value onto 0–100 with the intuitive direction, so a reader can be given
   "83 out of 100" and a researcher can still be given the AUC. It is exactly
   reversible — no information is added or lost. */
export const AUC_MAX = 286.33;   // 100 * log10(max_conc / min_conc) for this assay
export const effectScore = (a) => (a == null || Number.isNaN(a)
  ? null
  : Math.max(0, Math.min(100, Math.round(100 * (1 - a / AUC_MAX)))));

/* ------------------------------------------------------------------ AUC */
export function auc(patientId, drugName) {
  const i = db.drugPtIndex.get(patientId);
  const j = db.drugNameIndex.get(drugName);
  if (i === undefined || j === undefined) return null;
  return db.drug.auc[i][j];
}

export function ic50(patientId, drugName) {
  const i = db.drugPtIndex.get(patientId);
  const j = db.drugNameIndex.get(drugName);
  if (i === undefined || j === undefined) return null;
  return db.drug.ic50[i][j];
}

/** Percentile of a patient's AUC within the cohort for that drug (0-100).
 *  Low percentile = unusually sensitive. */
export function aucPercentile(value, drugMeta) {
  const a = drugMeta.sorted;
  if (!a || !a.length || value == null) return null;
  let lo = 0, hi = a.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (a[mid] < value) lo = mid + 1; else hi = mid; }
  return (lo / a.length) * 100;
}

/* --------------------------------------------------------------- filters */
export const filters = {
  eln: new Set(), stage: new Set(), sex: '', specimen: '',
  gene: '', fusion: '', ageMin: null, ageMax: null,
};

const listeners = new Set();
export function onFilterChange(fn) { listeners.add(fn); }
export function emitFilterChange() { for (const fn of listeners) fn(); }

export function resetFilters() {
  filters.eln.clear();
  filters.stage.clear();
  filters.sex = ''; filters.specimen = ''; filters.gene = ''; filters.fusion = '';
  filters.ageMin = null; filters.ageMax = null;
}

export function passes(p) {
  if (filters.eln.size && !filters.eln.has(p.eln)) return false;
  if (filters.stage.size && !filters.stage.has(p.stage)) return false;
  if (filters.sex && p.sex !== filters.sex) return false;
  if (filters.specimen && p.specimenType !== filters.specimen) return false;
  if (filters.fusion && p.fusion !== filters.fusion) return false;
  if (filters.ageMin != null && (p.age == null || p.age < filters.ageMin)) return false;
  if (filters.ageMax != null && (p.age == null || p.age > filters.ageMax)) return false;
  if (filters.gene) {
    const s = db.genesByPatient.get(p.id);
    if (!s || !s.has(filters.gene)) return false;
  }
  return true;
}

/** The current cohort slice — every view renders against this. */
export function selection() {
  return db.patients.filter(passes);
}

export function activeChips() {
  const out = [];
  for (const v of filters.eln) out.push({ key: 'eln', value: v, label: `ELN: ${v}` });
  for (const v of filters.stage) out.push({ key: 'stage', value: v, label: `Stage: ${v}` });
  if (filters.sex) out.push({ key: 'sex', label: `Sex: ${filters.sex}` });
  if (filters.specimen) out.push({ key: 'specimen', label: `Specimen: ${filters.specimen}` });
  if (filters.gene) out.push({ key: 'gene', label: `${filters.gene} mutated` });
  if (filters.fusion) out.push({ key: 'fusion', label: `Fusion: ${filters.fusion}` });
  if (filters.ageMin != null) out.push({ key: 'ageMin', label: `Age ≥ ${filters.ageMin}` });
  if (filters.ageMax != null) out.push({ key: 'ageMax', label: `Age ≤ ${filters.ageMax}` });
  return out;
}

/* ------------------------------------------------------------ statistics */

/** Kaplan-Meier estimate. events: [{time, dead}] */
export function kaplanMeier(rows) {
  const pts = rows.filter((r) => r.time != null && r.time >= 0).sort((a, b) => a.time - b.time);
  let n = pts.length, s = 1;
  const curve = [{ t: 0, s: 1, atRisk: n, events: 0 }];
  let i = 0;
  while (i < pts.length) {
    const t = pts[i].time;
    let d = 0, c = 0;
    while (i < pts.length && pts[i].time === t) { pts[i].dead ? d++ : c++; i++; }
    if (d > 0 && n > 0) { s *= (1 - d / n); curve.push({ t, s, atRisk: n, events: d }); }
    n -= (d + c);
  }
  return curve;
}

/** Median survival from a KM curve (first time S <= 0.5), or null if not reached. */
export function medianSurvival(curve) {
  for (const pt of curve) if (pt.s <= 0.5) return pt.t;
  return null;
}

/** Log-rank test across k groups. groups: [[{time,dead}], ...] -> {chi2, df, p} */
export function logRank(groups) {
  const k = groups.length;
  if (k < 2) return null;
  const times = [...new Set(groups.flat().filter((r) => r.dead).map((r) => r.time))].sort((a, b) => a - b);
  const O = new Array(k).fill(0), E = new Array(k).fill(0);
  let V = 0;
  for (const t of times) {
    const nj = groups.map((g) => g.filter((r) => r.time >= t).length);
    const dj = groups.map((g) => g.filter((r) => r.time === t && r.dead).length);
    const n = nj.reduce((a, b) => a + b, 0);
    const d = dj.reduce((a, b) => a + b, 0);
    if (n <= 1 || d === 0) continue;
    for (let i = 0; i < k; i++) { O[i] += dj[i]; E[i] += d * nj[i] / n; }
    // variance of the first group's observed count (used for the 2-group form)
    V += d * (n - d) / (n - 1) * (nj[0] / n) * (1 - nj[0] / n);
  }
  let chi2;
  if (k === 2 && V > 0) {
    chi2 = (O[0] - E[0]) ** 2 / V;
  } else {
    chi2 = 0;
    for (let i = 0; i < k; i++) if (E[i] > 0) chi2 += (O[i] - E[i]) ** 2 / E[i];
  }
  return { chi2, df: k - 1, p: chiSqP(chi2, k - 1), O, E };
}

/** Upper tail of the chi-square distribution (regularized incomplete gamma). */
export function chiSqP(x, df) {
  if (x <= 0 || !isFinite(x)) return 1;
  return gammaQ(df / 2, x / 2);
}

function gammaLn(z) {
  const g = [76.18009172947146, -86.50532032941677, 24.01409824083091,
    -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let x = z, y = z, tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) ser += g[j] / ++y;
  return -tmp + Math.log(2.5066282746310005 * ser / x);
}

function gammaQ(a, x) {
  if (x < a + 1) {
    // series representation of P(a,x)
    let ap = a, sum = 1 / a, del = sum;
    for (let n = 0; n < 500; n++) {
      ap++; del *= x / ap; sum += del;
      if (Math.abs(del) < Math.abs(sum) * 1e-12) break;
    }
    return 1 - sum * Math.exp(-x + a * Math.log(x) - gammaLn(a));
  }
  // continued fraction for Q(a,x)
  let b = x + 1 - a, c = 1e300, d = 1 / b, h = d;
  for (let i = 1; i < 500; i++) {
    const an = -i * (i - a);
    b += 2; d = an * d + b; if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c; if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d; const del = d * c; h *= del;
    if (Math.abs(del - 1) < 1e-12) break;
  }
  return h * Math.exp(-x + a * Math.log(x) - gammaLn(a));
}

/** Two-sided Mann-Whitney U with a normal approximation and tie correction. */
export function mannWhitney(a, b) {
  const n1 = a.length, n2 = b.length;
  if (!n1 || !n2) return null;
  const all = a.map((v) => ({ v, g: 0 })).concat(b.map((v) => ({ v, g: 1 })));
  all.sort((x, y) => x.v - y.v);
  let i = 0; const ties = [];
  while (i < all.length) {
    let j = i;
    while (j + 1 < all.length && all[j + 1].v === all[i].v) j++;
    const rank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) all[k].r = rank;
    if (j > i) ties.push(j - i + 1);
    i = j + 1;
  }
  let r1 = 0;
  for (const o of all) if (o.g === 0) r1 += o.r;
  const u1 = r1 - n1 * (n1 + 1) / 2;
  const n = n1 + n2;
  const mu = n1 * n2 / 2;
  const tieSum = ties.reduce((s, t) => s + (t ** 3 - t), 0);
  const sd = Math.sqrt((n1 * n2 / 12) * ((n + 1) - tieSum / (n * (n - 1))));
  if (!sd) return { u: u1, p: 1 };
  const z = (Math.abs(u1 - mu) - 0.5) / sd;
  // Use the upper tail directly. Computing 2*(1 - cdf) cancels to exactly 0
  // once z is large, which then prints as "0e+0".
  return { u: u1, z, p: Math.min(1, 2 * normTail(Math.abs(z))) };
}

/** Upper tail of the standard normal, Abramowitz & Stegun 7.1.26.
 *  Absolute accuracy ~7.5e-8 — see NORM_TAIL_FLOOR before reporting a p-value. */
export function normTail(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp(-z * z / 2);
  const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 +
    t * (-1.821255978 + t * 1.330274429))));
  return z >= 0 ? p : 1 - p;
}

/** Below this the approximation above carries no real information, so p-values
 *  computed in the browser are reported as "< 1e-7" rather than as a number.
 *  (The q-values baked in by the ETL come from scipy and are exact.) */
export const NORM_TAIL_FLOOR = 1e-7;

export function normCdf(z) {
  return z >= 0 ? 1 - normTail(z) : normTail(-z);
}

export function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
