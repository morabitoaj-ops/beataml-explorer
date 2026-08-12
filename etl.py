#!/usr/bin/env python3
"""Build compact JSON payloads for the BeatAML2 explorer from the published
BeatAML 2.0 release files.

Source: https://biodev.github.io/BeatAML2/  (CC-BY-4.0)

Grain note: the clinical table is one row per *specimen* (942 rows, 805
patients). The drug table is keyed by subject, the mutation table by DNA-seq
sample. This script collapses everything to one record per patient:
  - clinical  -> the "index" specimen (initial diagnosis if available)
  - mutations -> union across all of that patient's DNA-seq samples
  - drug AUC  -> median across that patient's assayed specimens
"""

import json
import math
import re
from pathlib import Path

import numpy as np
import pandas as pd
from scipy import stats

RAW = Path("data/raw")
OUT = Path("web/data")
OUT.mkdir(parents=True, exist_ok=True)

# Genes carried into the oncoprint / association tests. Frequency-driven, but
# capped so the matrix stays legible.
N_ONCOPRINT_GENES = 40
MIN_GENE_PATIENTS = 5


def clean(v):
    """NaN/NaT -> None, numpy scalars -> python scalars."""
    if v is None:
        return None
    if isinstance(v, float) and math.isnan(v):
        return None
    if pd.isna(v):
        return None
    if isinstance(v, (np.integer,)):
        return int(v)
    if isinstance(v, (np.floating,)):
        return float(v)
    if isinstance(v, (np.bool_,)):
        return bool(v)
    s = str(v).strip()
    return s if s else None


def norm_unknown(v):
    v = clean(v)
    if v is None:
        return None
    return "Unknown" if str(v).strip().lower() in ("unknown", "n/a", "na") else v


def num(v):
    """Coerce to float, tolerating the free-text entries in the release."""
    v = clean(v)
    if v is None:
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        # values like ">100" or "<0.5" appear in a handful of lab fields
        m = re.search(r"-?\d+\.?\d*", str(v))
        return float(m.group()) if m else None


def rnd(v, n=1):
    v = num(v)
    return None if v is None else round(v, n)


# --------------------------------------------------------------------------
# Load
# --------------------------------------------------------------------------
print("reading clinical ...")
clin = pd.read_excel(RAW / "beataml_wv1to4_clinical.xlsx", sheet_name="summary")
print("reading mutations ...")
mut = pd.read_csv(RAW / "beataml_wes_wv1to4_mutations_dbgap.txt", sep="\t", low_memory=False)
print("reading drug response ...")
drug = pd.read_csv(RAW / "beataml_probit_curve_fits_v4_dbgap.txt", sep="\t", low_memory=False)
fam = pd.read_excel(RAW / "beataml_drug_families.xlsx", sheet_name="drug_family")
dgene = pd.read_excel(RAW / "beataml_drug_families.xlsx", sheet_name="drug_gene")

# --------------------------------------------------------------------------
# Patients: pick one index specimen per subject
# --------------------------------------------------------------------------
stage_rank = {
    "Initial Diagnosis": 0,
    "Relapse": 1,
    "Residual": 2,
    "Remission": 3,
    "Unknown": 4,
}
clin["_rank"] = clin["diseaseStageAtSpecimenCollection"].map(stage_rank).fillna(5)
clin = clin.sort_values(["dbgap_subject_id", "_rank"])
index_spec = clin.groupby("dbgap_subject_id", as_index=False).first()

# every DNA-seq sample belonging to a subject (mutations are unioned over these)
dna_by_subject = (
    clin.dropna(subset=["dbgap_dnaseq_sample"])
    .groupby("dbgap_subject_id")["dbgap_dnaseq_sample"]
    .apply(list)
    .to_dict()
)

DX_SHORT = {
    "ACUTE MYELOID LEUKAEMIA (AML) AND RELATED PRECURSOR NEOPLASMS": "AML",
    "MYELODYSPLASTIC SYNDROMES": "MDS",
    "MYELODYSPLASTIC/MYELOPROLIFERATIVE NEOPLASMS": "MDS/MPN",
    "ACUTE LEUKAEMIAS OF AMBIGUOUS LINEAGE": "Ambiguous lineage",
    "MYELOPROLIFERATIVE NEOPLASMS": "MPN",
    "MATURE B-CELL NEOPLASMS": "B-cell neoplasm",
}


def norm_response(v):
    v = clean(v)
    if v is None:
        return None
    low = v.lower()
    if low.startswith("complete response i"):
        return "CR (indeterminate)"
    if low.startswith("complete response"):
        return "Complete Response"
    if low.startswith("refractory"):
        return "Refractory"
    return "Unknown"


def tri(v):
    """TRUE/FALSE/unknown text -> bool or None."""
    v = clean(v)
    if v is None:
        return None
    low = str(v).lower()
    if low in ("true", "yes", "y", "1", "positive"):
        return True
    if low in ("false", "no", "n", "0", "negative"):
        return False
    return None


def has_text(v):
    """Truthy when a cell carries a variant description rather than a blank."""
    v = clean(v)
    return v is not None and str(v).strip().lower() not in ("", "nan", "none", "n/a")


# FLT3-ITD and NPM1 are recorded as explicit positive/negative. RUNX1, ASXL1 and
# TP53 are not: those columns hold a variant description (e.g. "TP53 (p.R175H;
# 43.2%)") when mutated and are blank otherwise, so they need presence-of-text
# semantics. Parsing them as yes/no silently yields null for every patient.
curated_markers = {
    int(r["dbgap_subject_id"]): {
        "RUNX1": has_text(r["RUNX1"]),
        "ASXL1": has_text(r["ASXL1"]),
        "TP53": has_text(r["TP53"]),
    }
    for _, r in index_spec.iterrows()
}

patients = []
for _, r in index_spec.iterrows():
    os_days = num(r["overallSurvival"])
    patients.append(
        {
            "id": int(r["dbgap_subject_id"]),
            "sex": clean(r["consensus_sex"]),
            "age": rnd(r["ageAtDiagnosis"], 0),
            "race": norm_unknown(r["reportedRace"]),
            "ethnicity": norm_unknown(r["reportedEthnicity"]),
            "eln": clean(r["ELN2017"]),
            "dx": DX_SHORT.get(clean(r["dxAtInclusion"]), clean(r["dxAtInclusion"])),
            "specificDx": clean(r["specificDxAtInclusion"]),
            "stage": norm_unknown(r["diseaseStageAtSpecimenCollection"]),
            "specimenType": clean(r["specimenType"]),
            "cohort": clean(r["cohort"]),
            "isDenovo": tri(r["isDenovo"]),
            "isRelapse": tri(r["isRelapse"]),
            "isTransformed": tri(r["isTransformed"]),
            "priorMDS": tri(r["priorMDS"]),
            "vital": norm_unknown(r["vitalStatus"]),
            # -1 is used as a missing sentinel in the release
            "os": None if os_days is None or os_days < 0 else int(os_days),
            "causeOfDeath": norm_unknown(r["causeOfDeath"]),
            "response": norm_response(r["responseToInductionTx"]),
            "fusion": clean(r["consensusAMLFusions"]),
            "karyotype": clean(r["karyotype"]),
            "fab": clean(r["fabBlastMorphology"]),
            # consensus clinical calls (independent of the WES table)
            "flt3itd": tri(r["FLT3-ITD"]),
            "npm1c": tri(r["NPM1"]),
            "runx1c": tri(r["RUNX1"]),
            "asxl1c": tri(r["ASXL1"]),
            "tp53c": tri(r["TP53"]),
            "cebpaBi": clean(r["CEBPA_Biallelic"]),
            "allelicRatio": rnd(r["allelic_ratio"], 3),
            "blastsBM": rnd(r["%.Blasts.in.BM"]),
            "blastsPB": rnd(r["%.Blasts.in.PB"]),
            "wbc": rnd(r["wbcCount"]),
            "hgb": rnd(r["hemoglobin"]),
            "plt": rnd(r["plateletCount"]),
            "ldh": rnd(r["LDH"]),
        }
    )

pt_index = {p["id"]: i for i, p in enumerate(patients)}
print(f"  {len(patients)} patients")

# --------------------------------------------------------------------------
# Mutations
# --------------------------------------------------------------------------
sample_to_subject = {}
for subj, samples in dna_by_subject.items():
    for s in samples:
        sample_to_subject[s] = int(subj)

mut = mut[mut["dbgap_sample_id"].isin(sample_to_subject)].copy()
mut["subject"] = mut["dbgap_sample_id"].map(sample_to_subject)

CLASS_SHORT = {
    "missense_variant": "Missense",
    "frameshift_variant": "Frameshift",
    "stop_gained": "Nonsense",
    "inframe_deletion": "In-frame del",
    "inframe_insertion": "In-frame ins",
    "splice_acceptor_variant": "Splice",
    "splice_donor_variant": "Splice",
    "protein_altering_variant": "Other",
    "start_lost": "Other",
    "stop_lost": "Other",
    "stop_retained_variant": "Other",
    "coding_sequence_variant": "Other",
}


def prot_pos(v):
    v = clean(v)
    if v is None:
        return None
    m = re.match(r"(\d+)", str(v).split("/")[0])
    return int(m.group(1)) if m else None


mutations = []
for _, r in mut.iterrows():
    subj = int(r["subject"])
    if subj not in pt_index:
        continue
    mutations.append(
        {
            "p": subj,
            "g": clean(r["symbol"]),
            "c": CLASS_SHORT.get(clean(r["variant_classification"]), "Other"),
            "hp": clean(r["hgvsp_short"]),
            "vaf": rnd(r["t_vaf"], 3),
            "chr": clean(r["seqnames"]),
            "pos": clean(r["pos_start"]),
            "ref": clean(r["ref"]),
            "alt": clean(r["alt"]),
            "pp": prot_pos(r["protein_position"]),
            "plen": (
                int(str(r["protein_position"]).split("/")[1])
                if clean(r["protein_position"]) and "/" in str(r["protein_position"])
                and str(r["protein_position"]).split("/")[1].isdigit()
                else None
            ),
            "sift": clean(r["sift"]),
            "poly": clean(r["polyphen"]),
            "cos": bool(re.search("COSM", str(r["existing_variation"] or ""))),
            "rd": clean(r["total_reads"]),
        }
    )
mutations = [m for m in mutations if m["g"]]
print(f"  {len(mutations)} mutations across {len({m['p'] for m in mutations})} patients")

# gene-level frequency (patient counts)
gene_pts = {}
for m in mutations:
    gene_pts.setdefault(m["g"], set()).add(m["p"])
gene_freq = sorted(
    ({"gene": g, "n": len(s)} for g, s in gene_pts.items() if len(s) >= MIN_GENE_PATIENTS),
    key=lambda d: -d["n"],
)
top_genes = [d["gene"] for d in gene_freq[:N_ONCOPRINT_GENES]]

# patients with any WES data at all (so "not mutated" != "not sequenced")
sequenced = sorted({int(s) for s in mut["subject"].unique() if int(s) in pt_index})
print(f"  {len(sequenced)} patients with WES/targeted sequencing")

# Resolve the three presence-of-text markers now that the WES calls are indexed:
# positive if the curated column names a variant OR the WES table called one;
# negative if the patient was sequenced and neither did; unknown otherwise.
seq_set_for_markers = set(sequenced)
for p in patients:
    for gene, key in (("RUNX1", "runx1c"), ("ASXL1", "asxl1c"), ("TP53", "tp53c")):
        curated = curated_markers.get(p["id"], {}).get(gene, False)
        called = p["id"] in gene_pts.get(gene, set())
        if curated or called:
            p[key] = True
        elif p["id"] in seq_set_for_markers:
            p[key] = False
        else:
            p[key] = None
for gene, key in (("RUNX1", "runx1c"), ("ASXL1", "asxl1c"), ("TP53", "tp53c")):
    pos = sum(1 for p in patients if p[key] is True)
    print(f"  {gene}: {pos} positive after merging curated calls with WES")

# --------------------------------------------------------------------------
# Co-occurrence / mutual exclusivity among top genes
# --------------------------------------------------------------------------
seq_set = set(sequenced)
gset = {g: gene_pts[g] & seq_set for g in top_genes}
pairs = []
N = len(seq_set)
for i, a in enumerate(top_genes):
    for b in top_genes[i + 1 :]:
        A, B = gset[a], gset[b]
        n11 = len(A & B)
        n10 = len(A) - n11
        n01 = len(B) - n11
        n00 = N - n11 - n10 - n01
        odds, p = stats.fisher_exact([[n11, n10], [n01, n00]])
        pairs.append(
            {
                "a": a,
                "b": b,
                "both": n11,
                "or": None if not np.isfinite(odds) else round(float(odds), 3),
                "p": float(p),
                "dir": "co" if odds > 1 else "ex",
            }
        )
# Benjamini-Hochberg
ps = np.array([d["p"] for d in pairs])
order = np.argsort(ps)
qs = np.empty_like(ps)
m_tests = len(ps)
prev = 1.0
for rank, idx in enumerate(order[::-1]):
    k = m_tests - rank
    prev = min(prev, ps[idx] * m_tests / k)
    qs[idx] = prev
for d, q in zip(pairs, qs):
    d["p"] = float(f"{d['p']:.3g}")
    d["q"] = float(f"{q:.3g}")
print(f"  {len(pairs)} gene pairs tested, {sum(d['q'] < 0.05 for d in pairs)} at q<0.05")

# --------------------------------------------------------------------------
# Drug response
# --------------------------------------------------------------------------
drug = drug[drug["dbgap_subject_id"].isin(pt_index)].copy()
# median across specimens for patients assayed more than once
auc = (
    drug.groupby(["dbgap_subject_id", "inhibitor"])["auc"]
    .median()
    .reset_index()
)
ic50 = (
    drug.groupby(["dbgap_subject_id", "inhibitor"])["ic50"]
    .median()
    .reset_index()
)

drug_pts = sorted(auc["dbgap_subject_id"].unique().tolist())
drug_names = sorted(auc["inhibitor"].unique().tolist())
dp_index = {int(p): i for i, p in enumerate(drug_pts)}
dn_index = {d: i for i, d in enumerate(drug_names)}

mat = [[None] * len(drug_names) for _ in drug_pts]
for _, r in auc.iterrows():
    mat[dp_index[int(r["dbgap_subject_id"])]][dn_index[r["inhibitor"]]] = round(float(r["auc"]), 1)

ic_mat = [[None] * len(drug_names) for _ in drug_pts]
for _, r in ic50.iterrows():
    v = r["ic50"]
    if pd.notna(v):
        ic_mat[dp_index[int(r["dbgap_subject_id"])]][dn_index[r["inhibitor"]]] = float(f"{v:.4g}")

fam_map = dict(zip(fam["inhibitor"], fam["family"]))
targets = (
    dgene.dropna(subset=["Symbol"])
    .groupby("inhibitor")["Symbol"]
    .apply(lambda s: sorted(set(s))[:12])
    .to_dict()
)

drugs_meta = []
for d in drug_names:
    col = np.array(
        [mat[i][dn_index[d]] for i in range(len(drug_pts))], dtype=object
    )
    vals = np.array([v for v in col if v is not None], dtype=float)
    drugs_meta.append(
        {
            "name": d,
            "family": clean(fam_map.get(d)),
            "targets": targets.get(d, []),
            "n": int(len(vals)),
            "med": round(float(np.median(vals)), 1) if len(vals) else None,
            "q1": round(float(np.percentile(vals, 25)), 1) if len(vals) else None,
            "q3": round(float(np.percentile(vals, 75)), 1) if len(vals) else None,
            "min": round(float(vals.min()), 1) if len(vals) else None,
            "max": round(float(vals.max()), 1) if len(vals) else None,
        }
    )
print(f"  {len(drug_pts)} patients x {len(drug_names)} inhibitors")

# --------------------------------------------------------------------------
# Drug x mutation associations (Mann-Whitney, lower AUC = more sensitive)
# --------------------------------------------------------------------------
assoc = []
marker_sets = {g: gene_pts[g] for g in top_genes}
# add the consensus clinical markers, which are not all in the WES table
for key, label in [("flt3itd", "FLT3-ITD"), ("npm1c", "NPM1 (clinical)"), ("tp53c", "TP53 (clinical)")]:
    marker_sets[label] = {p["id"] for p in patients if p.get(key) is True}

drug_pt_set = set(drug_pts)
for marker, carriers in marker_sets.items():
    carriers = carriers & drug_pt_set
    if len(carriers) < 8:
        continue
    idx_pos = [dp_index[p] for p in carriers]
    idx_neg = [dp_index[p] for p in drug_pt_set - carriers]
    for d in drug_names:
        j = dn_index[d]
        a = np.array([mat[i][j] for i in idx_pos if mat[i][j] is not None], dtype=float)
        b = np.array([mat[i][j] for i in idx_neg if mat[i][j] is not None], dtype=float)
        if len(a) < 8 or len(b) < 8:
            continue
        u, p = stats.mannwhitneyu(a, b, alternative="two-sided")
        assoc.append(
            {
                "marker": marker,
                "drug": d,
                "nPos": int(len(a)),
                "nNeg": int(len(b)),
                "medPos": round(float(np.median(a)), 1),
                "medNeg": round(float(np.median(b)), 1),
                "delta": round(float(np.median(a) - np.median(b)), 1),
                "p": float(p),
            }
        )
ps = np.array([d["p"] for d in assoc])
order = np.argsort(ps)
qs = np.empty_like(ps)
m_tests = len(ps)
prev = 1.0
for rank, idx in enumerate(order[::-1]):
    k = m_tests - rank
    prev = min(prev, ps[idx] * m_tests / k)
    qs[idx] = prev
for d, q in zip(assoc, qs):
    d["p"] = float(f"{d['p']:.3g}")
    d["q"] = float(f"{q:.3g}")
assoc.sort(key=lambda d: d["p"])
print(f"  {len(assoc)} drug-marker tests, {sum(d['q'] < 0.05 for d in assoc)} at q<0.05")

# --------------------------------------------------------------------------
# Drug-drug correlation (Spearman) on the most-assayed inhibitors
# --------------------------------------------------------------------------
well_assayed = [d["name"] for d in drugs_meta if d["n"] >= 200]
wi = [dn_index[d] for d in well_assayed]
M = np.array(
    [[mat[i][j] if mat[i][j] is not None else np.nan for j in wi] for i in range(len(drug_pts))],
    dtype=float,
)
corr = np.full((len(wi), len(wi)), np.nan)
for i in range(len(wi)):
    for j in range(i, len(wi)):
        ok = ~np.isnan(M[:, i]) & ~np.isnan(M[:, j])
        if ok.sum() >= 50:
            c = stats.spearmanr(M[ok, i], M[ok, j]).statistic
            corr[i, j] = corr[j, i] = c
corr_out = [[None if np.isnan(v) else round(float(v), 3) for v in row] for row in corr]
print(f"  drug-drug correlation on {len(well_assayed)} inhibitors")

# --------------------------------------------------------------------------
# Write
# --------------------------------------------------------------------------
def dump(name, obj):
    path = OUT / name
    path.write_text(json.dumps(obj, separators=(",", ":")))
    print(f"  wrote {name}  {path.stat().st_size/1e6:.2f} MB")


dump(
    "cohort.json",
    {
        "patients": patients,
        "sequenced": sequenced,
        "geneFreq": gene_freq,
        "topGenes": top_genes,
        "pairs": pairs,
        "source": "BeatAML 2.0 (Bottomly et al.), CC-BY-4.0",
    },
)
dump("mutations.json", mutations)
dump(
    "drugs.json",
    {
        "patients": [int(p) for p in drug_pts],
        "drugs": drugs_meta,
        "auc": mat,
        "ic50": ic_mat,
        "assoc": assoc,
        "corrDrugs": well_assayed,
        "corr": corr_out,
    },
)
print("done.")
