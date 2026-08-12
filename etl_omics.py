#!/usr/bin/env python3
"""Second-stage ETL: dose-response curves and the RNA-seq layer.

Adds to web/data/:
  fits.json          probit parameters per patient x inhibitor -> exact fitted curves
  dose/<subject>.json  measured viability points, sharded per patient (lazy-loaded)
  expr.json          curated expression matrix (genes x patients) + PCA coordinates
  biomarkers.json    gene-expression vs drug-AUC correlations

Curve model, verified against the release's own IC25/IC50/AUC columns:
    viability(c) = Phi(intercept + beta * log10(c))
    AUC          = 100 * integral of viability d(log10 c) over [min_conc, max_conc]
"""

import json
import math
from pathlib import Path

import numpy as np
import pandas as pd
from scipy import stats

RAW = Path("data/raw")
OUT = Path("web/data")
DOSE = OUT / "dose"
DOSE.mkdir(parents=True, exist_ok=True)

N_VARIABLE_GENES = 1400          # top-variance protein-coding genes
MIN_PATIENTS_FOR_CORR = 120      # gene x drug correlation needs a decent overlap

print("reading clinical ...")
clin = pd.read_excel(RAW / "beataml_wv1to4_clinical.xlsx", sheet_name="summary")
print("reading probit fits ...")
fits = pd.read_csv(RAW / "beataml_probit_curve_fits_v4_dbgap.txt", sep="\t", low_memory=False)
print("reading raw dose-response ...")
raw = pd.read_csv(RAW / "beataml_wv1to4_raw_inhibitor_v4_dbgap.txt", sep="\t", low_memory=False)
print("reading drug targets ...")
dgene = pd.read_excel(RAW / "beataml_drug_families.xlsx", sheet_name="drug_gene")

cohort = json.loads((OUT / "cohort.json").read_text())
drugs_payload = json.loads((OUT / "drugs.json").read_text())
drug_names = [d["name"] for d in drugs_payload["drugs"]]
drug_pts = drugs_payload["patients"]
dn_index = {d: i for i, d in enumerate(drug_names)}
dp_index = {p: i for i, p in enumerate(drug_pts)}
patient_ids = {p["id"] for p in cohort["patients"]}

# ---------------------------------------------------------------------------
# 1. Probit fit parameters per patient x drug
# ---------------------------------------------------------------------------
print("building curve fits ...")
f = fits[fits["dbgap_subject_id"].isin(dp_index)].copy()
f = f[f["converged"] == True]  # noqa: E712 - pandas mask
agg = f.groupby(["dbgap_subject_id", "inhibitor"]).agg(
    intercept=("intercept", "median"),
    beta=("beta", "median"),
    min_conc=("min_conc", "median"),
    max_conc=("max_conc", "median"),
).reset_index()

n_p, n_d = len(drug_pts), len(drug_names)
inter = [[None] * n_d for _ in range(n_p)]
beta = [[None] * n_d for _ in range(n_p)]
conc_range = {}
for r in agg.itertuples(index=False):
    i, j = dp_index[int(r.dbgap_subject_id)], dn_index.get(r.inhibitor)
    if j is None:
        continue
    if not (np.isfinite(r.intercept) and np.isfinite(r.beta)):
        continue
    inter[i][j] = round(float(r.intercept), 4)
    beta[i][j] = round(float(r.beta), 4)
    conc_range.setdefault(r.inhibitor, [float(r.min_conc), float(r.max_conc)])

(OUT / "fits.json").write_text(json.dumps({
    "intercept": inter, "beta": beta,
    "conc": {k: [round(v[0], 5), round(v[1], 5)] for k, v in conc_range.items()},
}, separators=(",", ":")))
print(f"  fits.json {(OUT / 'fits.json').stat().st_size / 1e6:.2f} MB")

# sanity check: reconstruct IC50 and compare with the published column
# The release clamps IC values to the tested concentration range, so only
# in-range IC50s are a valid check on the reconstruction.
chk = f.dropna(subset=["ic50", "intercept", "beta", "min_conc", "max_conc"])
recon = 10 ** (-chk["intercept"] / chk["beta"])
inside = (chk["ic50"] > chk["min_conc"] * 1.001) & (chk["ic50"] < chk["max_conc"] * 0.999)
ok = np.isclose(recon, chk["ic50"], rtol=0.02)
print(f"  IC50 reconstruction matches {ok[inside].mean() * 100:.1f}% of the "
      f"{int(inside.sum())} in-range fits ({int((~inside).sum())} clamped to the assay range)")

# ---------------------------------------------------------------------------
# 2. Measured dose-response points, sharded per patient
# ---------------------------------------------------------------------------
print("sharding measured dose-response points ...")
raw = raw[raw["passed_qc"] == True]  # noqa: E712
raw = raw[raw["dbgap_subject_id"].isin(dp_index)]
raw = raw.dropna(subset=["well_concentration", "normalized_viability"])
# average replicates at the same concentration
pts = (raw.groupby(["dbgap_subject_id", "inhibitor", "well_concentration"])
       ["normalized_viability"].mean().reset_index())

written = 0
for subj, grp in pts.groupby("dbgap_subject_id"):
    out = {}
    for inh, g2 in grp.groupby("inhibitor"):
        g2 = g2.sort_values("well_concentration")
        out[inh] = [[round(float(c), 5), round(float(v), 1)]
                    for c, v in zip(g2["well_concentration"], g2["normalized_viability"])]
    (DOSE / f"{int(subj)}.json").write_text(json.dumps(out, separators=(",", ":")))
    written += 1
sizes = [p.stat().st_size for p in DOSE.glob("*.json")]
print(f"  {written} shards, median {np.median(sizes) / 1e3:.0f} KB, total {sum(sizes) / 1e6:.1f} MB")

# ---------------------------------------------------------------------------
# 3. Expression matrix
# ---------------------------------------------------------------------------
print("reading expression (this takes a moment) ...")
expr = pd.read_csv(RAW / "beataml_waves1to4_norm_exp_dbgap.txt", sep="\t", low_memory=False)
meta_cols = ["stable_id", "display_label", "description", "biotype"]
sample_cols = [c for c in expr.columns if c not in meta_cols]

# RNA-seq sample -> subject
rna_map = (clin.dropna(subset=["dbgap_rnaseq_sample"])
           .drop_duplicates("dbgap_rnaseq_sample")
           .set_index("dbgap_rnaseq_sample")["dbgap_subject_id"].to_dict())
usable = [c for c in sample_cols if rna_map.get(c) in patient_ids]
subjects = [int(rna_map[c]) for c in usable]
# one specimen per subject (first occurrence)
seen, keep_cols, keep_subj = set(), [], []
for c, s in zip(usable, subjects):
    if s in seen:
        continue
    seen.add(s)
    keep_cols.append(c)
    keep_subj.append(s)
print(f"  {len(keep_cols)} RNA-seq samples mapped to distinct patients")

pc = expr[expr["biotype"] == "protein_coding"].copy()
mat = pc[keep_cols].to_numpy(dtype=np.float32)
symbols = pc["display_label"].astype(str).to_numpy()

# gene selection: high-variance genes + every druggable target + AML drivers
var = np.nanvar(mat, axis=1)
top_var = set(np.argsort(-var)[:N_VARIABLE_GENES].tolist())
targets = set(dgene["Symbol"].dropna().astype(str))
drivers = set(cohort["topGenes"]) | {d["gene"] for d in cohort["geneFreq"]}
wanted = targets | drivers
extra = {i for i, s in enumerate(symbols) if s in wanted}
idx = sorted(top_var | extra)
# drop duplicate symbols, keeping the higher-variance copy
by_symbol = {}
for i in idx:
    s = symbols[i]
    if s not in by_symbol or var[i] > var[by_symbol[s]]:
        by_symbol[s] = i
idx = sorted(by_symbol.values())
genes = [str(symbols[i]) for i in idx]
sub = mat[idx, :]
print(f"  {len(genes)} genes selected ({len(top_var)} by variance, "
      f"{len(extra & set(idx))} drug targets / drivers folded in)")

values = [[None if not np.isfinite(v) else round(float(v), 2) for v in row] for row in sub]
mu = np.nanmean(sub, axis=1)
sd = np.nanstd(sub, axis=1)

# PCA on standardised expression -> a patient similarity map with no runtime cost
Z = (sub - mu[:, None]) / np.where(sd == 0, 1, sd)[:, None]
Z = np.nan_to_num(Z)
Zc = Z - Z.mean(axis=1, keepdims=True)
# eigen-decompose the sample-by-sample covariance; sample scores on PC k are
# eigenvector_k * sqrt(eigenvalue_k)
cov = Zc.T @ Zc / max(1, Zc.shape[0] - 1)
U, S, _ = np.linalg.svd(cov)
proj = U[:, :3] * np.sqrt(np.maximum(S[:3], 0))
var_explained = (S[:3] / S.sum() * 100).tolist()

(OUT / "expr.json").write_text(json.dumps({
    "genes": genes,
    "patients": keep_subj,
    "values": values,
    "mean": [round(float(v), 3) for v in mu],
    "sd": [round(float(v), 3) for v in sd],
    "pca": [[round(float(proj[i, k]), 3) for k in range(3)] for i in range(len(keep_subj))],
    "pcaVar": [round(v, 1) for v in var_explained],
}, separators=(",", ":")))
print(f"  expr.json {(OUT / 'expr.json').stat().st_size / 1e6:.2f} MB")

# ---------------------------------------------------------------------------
# 4. Expression <-> drug response correlations
# ---------------------------------------------------------------------------
print("correlating expression with drug response ...")
auc = np.array([[np.nan if v is None else v for v in row] for row in drugs_payload["auc"]],
               dtype=np.float64)                      # patients x drugs
expr_pt_index = {p: i for i, p in enumerate(keep_subj)}
shared = [p for p in drug_pts if p in expr_pt_index]
ei = [expr_pt_index[p] for p in shared]
di = [dp_index[p] for p in shared]
E = np.array(values, dtype=np.float64)[:, ei]         # genes x shared
A = auc[di, :]                                        # shared x drugs
print(f"  {len(shared)} patients have both expression and drug data")

# rank-transform once, then correlate by matrix product (Spearman)
def rank_rows(M):
    out = np.empty_like(M)
    for i in range(M.shape[0]):
        row = M[i]
        ok = ~np.isnan(row)
        r = np.full(row.shape, np.nan)
        r[ok] = stats.rankdata(row[ok])
        out[i] = r
    return out

Er = rank_rows(E)
Ar = rank_rows(A.T)                                   # drugs x shared

def z(M):
    m = np.nanmean(M, axis=1, keepdims=True)
    s = np.nanstd(M, axis=1, keepdims=True)
    s[s == 0] = 1
    return np.nan_to_num((M - m) / s)

Ez, Az = z(Er), z(Ar)
valid_e = (~np.isnan(Er)).astype(float)
valid_a = (~np.isnan(Ar)).astype(float)
n_obs = valid_e @ valid_a.T                           # genes x drugs
R = (Ez @ Az.T) / np.maximum(n_obs, 1)
R[n_obs < MIN_PATIENTS_FOR_CORR] = np.nan

# keep the strongest hits only
flat = []
gi, dj = np.where(np.isfinite(R) & (np.abs(R) >= 0.30))
for g, d in zip(gi, dj):
    n = int(n_obs[g, d])
    r = float(R[g, d])
    t = r * math.sqrt(max(1, n - 2)) / math.sqrt(max(1e-12, 1 - r * r))
    p = 2 * stats.t.sf(abs(t), max(1, n - 2))
    flat.append({"gene": genes[g], "drug": drug_names[d], "rho": round(r, 3),
                 "n": n, "p": float(f"{p:.3g}")})
flat.sort(key=lambda d: -abs(d["rho"]))
flat = flat[:4000]
print(f"  {len(flat)} gene-drug pairs with |rho| >= 0.30")

(OUT / "biomarkers.json").write_text(json.dumps({
    "pairs": flat, "sharedPatients": shared,
}, separators=(",", ":")))
print(f"  biomarkers.json {(OUT / 'biomarkers.json').stat().st_size / 1e6:.2f} MB")
print("done.")
