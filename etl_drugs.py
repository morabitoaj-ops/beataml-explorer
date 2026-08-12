#!/usr/bin/env python3
"""Build web/data/druginfo.json — a reference card for every inhibitor.

Two sources, kept separate in the output so the app can label them honestly:

  "chem"  — molecular facts fetched live from PubChem (formula, weight, SMILES,
            InChIKey, CID). Authoritative and verifiable; a link to the PubChem
            page is emitted so any claim can be checked in one click.

  "curated" — developer / mechanism / other uses, from web/data/drug_curated.json.
            This is human-written reference text, NOT part of the BeatAML
            release and NOT machine-verified. Drugs with no curated entry are
            emitted without one rather than guessed at.

  "targets" — the genes each drug hits, taken from the BeatAML release's own
            drug_gene sheet. Authoritative, and already used elsewhere in the app.
"""

import json
import re
import time
import subprocess
import urllib.parse
from pathlib import Path

import pandas as pd

RAW = Path("data/raw")
OUT = Path("web/data")
PUBCHEM = "https://pubchem.ncbi.nlm.nih.gov/rest/pug"
PROPS = "MolecularFormula,MolecularWeight,CanonicalSMILES,InChIKey"
CACHE = Path("data/pubchem_cache.json")


def primary_name(label: str) -> list[str]:
    """BeatAML labels look like 'Quizartinib (AC220)' or 'AZD1152-HQPA (AZD2811)'.
    Return the candidate query strings, best first."""
    label = label.strip()
    out = []
    m = re.match(r"^(.*?)\s*\(([^)]+)\)\s*$", label)
    if m:
        head, paren = m.group(1).strip(), m.group(2).strip()
        out += [head, paren]
    out.append(label)
    # strip trailing salt/form annotations
    out.append(re.sub(r"\s*-\s*(HQPA|HCl|mesylate|maleate)$", "", label, flags=re.I))
    seen, uniq = set(), []
    for o in out:
        if o and o.lower() not in seen:
            seen.add(o.lower())
            uniq.append(o)
    return uniq


def fetch(name: str):
    """Fetch via curl rather than urllib.

    This machine sits behind a TLS-intercepting proxy whose CA is in the system
    keychain but not in Python's bundled certifi store, so urllib fails with
    CERTIFICATE_VERIFY_FAILED while curl succeeds. Shelling out keeps full
    certificate verification — the alternative (ssl._create_unverified_context)
    would silently accept any certificate, which is not worth it for a build
    script that fetches public data.
    """
    url = f"{PUBCHEM}/compound/name/{urllib.parse.quote(name)}/property/{PROPS}/JSON"
    try:
        res = subprocess.run(
            ["curl", "-sSf", "--max-time", "25", url],
            capture_output=True, text=True, check=True,
        )
        js = json.loads(res.stdout)
        p = js["PropertyTable"]["Properties"][0]
        return {
            "cid": p.get("CID"),
            "formula": p.get("MolecularFormula"),
            "weight": p.get("MolecularWeight"),
            "smiles": p.get("ConnectivitySMILES") or p.get("CanonicalSMILES"),
            "inchikey": p.get("InChIKey"),
            "matchedName": name,
        }
    except (subprocess.CalledProcessError, json.JSONDecodeError, KeyError, IndexError):
        return None


def main():
    drugs = json.loads((OUT / "drugs.json").read_text())["drugs"]
    dgene = pd.read_excel(RAW / "beataml_drug_families.xlsx", sheet_name="drug_gene")

    targets = (
        dgene.dropna(subset=["Symbol"])
        .groupby("inhibitor")["Symbol"]
        .apply(lambda s: sorted(set(s.astype(str))))
        .to_dict()
    )
    descs = (
        dgene.dropna(subset=["Symbol", "description"])
        .drop_duplicates("Symbol")
        .set_index("Symbol")["description"].to_dict()
    )

    cache = json.loads(CACHE.read_text()) if CACHE.exists() else {}
    curated_path = OUT / "drug_curated.json"
    curated = json.loads(curated_path.read_text()) if curated_path.exists() else {}

    out, hits = {}, 0
    for i, d in enumerate(drugs, 1):
        label = d["name"]
        chem = cache.get(label, "MISS")
        if chem == "MISS":
            chem = None
            for cand in primary_name(label):
                chem = fetch(cand)
                if chem:
                    break
                time.sleep(0.25)          # PubChem asks for <= 5 requests/second
            cache[label] = chem
            time.sleep(0.22)
        if chem:
            hits += 1
        tg = targets.get(label, [])
        out[label] = {
            "targets": tg[:14],
            "targetDesc": {g: descs[g] for g in tg[:14] if g in descs},
            "family": d.get("family"),
            "chem": chem,
            "curated": curated.get(label) or curated.get(primary_name(label)[0]),
        }
        if i % 25 == 0:
            print(f"  {i}/{len(drugs)} … {hits} with PubChem data")
            CACHE.write_text(json.dumps(cache))

    CACHE.write_text(json.dumps(cache))
    (OUT / "druginfo.json").write_text(json.dumps(out, separators=(",", ":")))
    n_cur = sum(1 for v in out.values() if v["curated"])
    print(f"\n  {len(out)} drugs")
    print(f"  {hits} matched in PubChem ({hits / len(out) * 100:.0f}%)")
    print(f"  {n_cur} have a curated write-up")
    print(f"  wrote druginfo.json  {(OUT / 'druginfo.json').stat().st_size / 1e3:.0f} KB")


if __name__ == "__main__":
    main()
