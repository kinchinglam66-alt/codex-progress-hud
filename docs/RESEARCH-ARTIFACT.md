# Research artifact and version map

## Software snapshot

Identifier: `research-release-2026-10-24`.
Upstream repository: `kinchinglam66-alt/codex-progress-hud`.
Upstream source commit: `40b81e6bb8f23cd25bcfac3f7c5106b0d3ad58f7`.
Embedded package and plugin version: `0.2.1`.

The preparation revises documentation and adds an offline countdown example.
Runtime, estimator instructions, account logic, and scoring are preserved from
the upstream commit. The original project repository and its development history
are retained in this public release. Historical engineering notes describe their
own revisions and do not supersede the current documentation. Personal evaluation
archives and account records are not added to the repository.

The Release's `RELEASE-MANIFEST.json` and `SHA256SUMS.txt` identify the source and
supplement archives. Git may normalize checkout line endings according to
`.gitattributes`; use exact release assets for archive-byte verification.

## Manuscript

Lam Kin Ching. *Execution Information and Estimation Timing for Coding Agent ETA:
An Empirical Study and a Delivery-Aware Framework*. Preprint revision 1.7,
editorial revision r2, 24 October 2026. At preparation time the manuscript is a
local publication candidate, without an assigned DOI or public archive URL.

The software implements the observation, prefix construction, prediction,
delivery, and evaluation concepts in RQ3. It is a framework reference, rather
than a declaration that one checkout was the executable for every experiment.

## Separate empirical artifacts

| Artifact | Version evidence | Relationship to this snapshot |
| --- | --- | --- |
| Framework source | Upstream commit above plus prepared file manifest | Inspect implementation and offline components |
| Raw numeric supplement v1.1 | [Numeric files](../research/eta-v1.7/numeric/README.txt), package hashes in the Release | Licensed publication of the reviewed numeric v1 candidate; data and scoring code unchanged, 436 comparisons |
| Methods and validity supplement v1.1 | [Methods files](../research/eta-v1.7/methods/README.txt), package hashes in the Release | Actual prompt/schema, builders, complete G structural inventories, prior E/F audit metadata and protocol disclosures |
| G canonical builder | `canonical.mjs` SHA256 `20b5477a95fc762d761f1deaef53864e83086106e4b30aa48ecfa7966ad48e51` | Study-specific +Content builder, not the complete plugin input path |
| G initial preparation | `prepare.mjs` SHA256 `45a754afb6222728270c4fb13c6e31728258e15b76c0a464fe12ef888dd9cac1` | Initial preparation identity; execution amendments have separate records |
| G execution runtime | Pin `2ed1805cad1dd25f7e048f2c33843bdd37ed912ba82ec30a89c41d7fa04b467f` | Runtime-manifest identity, not a Git commit or package version |
| F controlled delay | Cohort `7c44739e75415a9be61403cbac90b342ad5c557009613a53aeea803ae8beb18b`; protocol `d622948d02229e92dee42ddc95108d18ee4306a6420e2ccf9890c4c0af3c02f1` | Separate controller, inputs, and experiment |
| Earlier A–E collections | Individual study source contracts and frozen manifests | No single checkout identity asserted for all studies |

Original input/runtime hashes identify author-held provenance, not public access
to the underlying private records. The numeric supplement does not reconstruct
readable histories. The methods package includes the canonical builder and synthetic
examples; structural records omit actual task/command/output text. They permit
consistency checks but do not establish independent semantic verification.

Both supplements are available from the
[versioned research release](https://github.com/kinchinglam66-alt/codex-progress-hud/releases/tag/research-release-2026-10-24).
Their v1.1 revision adds publication licensing, version information and access
instructions to the local v1 candidates; original numbers, prompt/schema and
canonical builder bytes are retained. Full experimental evidence is not released.

## Included example

After `npm ci` and `npm run build`, run `node examples/offline-countdown.mjs`.
It imports `dist/ui/countdown.js`, built from `src/ui/countdown.ts`, and demonstrates
aging, a frozen tracking clock, overrun, and completion with synthetic data.
It makes no model request and does not reproduce a paper accuracy result.

## Citation

Use `CITATION.cff` for this source snapshot and record its actual published commit
or archive identifier when available. Cite the manuscript and numeric supplement
separately for empirical results. A Git tag, plugin directory listing, and signed
installer are distinct release events; none follows from version `0.2.1` alone.
