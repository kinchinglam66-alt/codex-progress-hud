# Coding-agent ETA research materials

Lam Kin Ching · Independent Researcher, Hong Kong, China ·
[ORCID 0009-0009-4254-0631](https://orcid.org/0009-0009-4254-0631)

Companion materials for *Execution Information and Estimation Timing for Coding
Agent ETA: An Empirical Study and a Delivery-Aware Framework*, manuscript v1.7,
editorial revision r2. The manuscript is being prepared for preprint publication;
this release publishes its supporting software and bounded empirical artifacts.

## Download and reproduce

Download the v1.1 numeric and methods ZIPs, source archive, release manifest and
checksums from [research-release-2026-10-24](https://github.com/kinchinglam66-alt/codex-progress-hud/releases/tag/research-release-2026-10-24).
The same supplement contents are browsable in this directory.

| Package | Contents | Offline verification |
| --- | --- | --- |
| [Numeric supplement](numeric/README.txt) | 1,192 selected rows, including 1,168 eligible and 24 excluded; selected raw comparisons, timing and bias/correlation components | From `numeric`, run `python reproduce.py`: 436 comparisons |
| [Methods and validity](methods/README.txt) | Archived estimator prompt/schema, canonical builder, 72 G input records, 36 paired structures, 144 call records, prior E/F audit metadata and protocol disclosures | From `methods`, run `python verify.py --numeric ../numeric/numeric-data.json`; Node.js 24+ runs `node --test builders/canonical.test.mjs` |

Python checks require only an existing Python 3.10+ installation. There are no
account requirements, package installations or new model calls. The methods demo
uses synthetic data: `node builders/demo.mjs`.

The v1.1 publication revisions add licensing, versioning and access statements to
the reviewed local v1 candidates. Numerical data, original reproduction code,
prompt/schema and canonical builder remain unchanged. Package manifests identify
the exact distributed files.

## Scope and interpretation

The numeric extract reproduces selected main-line tables and figure components,
not every analysis, delivery integration or calibrated appendix. The methods
package supports input-structure and implementation review. Complete historical
task text, commands and stdout/stderr remain private; structural inventories and
hashes do not independently establish their semantic validity.

G's `full` label is canonical **+Content** and differs from legacy Full and the
deployed plugin pipeline. Its eight evaluation trajectories reuse F normal
executions. Repeats, anchors and reused trajectories do not create independent
task samples. Original inconclusive calibrated results, retrospective selection
of the raw presentation, and scheduling/storage amendments remain disclosed.
See [methods](methods/METHODS.txt) and [validity and amendments](methods/VALIDITY-AND-AMENDMENTS.txt).

## License and citation

Code and schema definitions are Apache-2.0. Author-held derived numerical data,
prompt text and explanatory materials in these supplements are CC BY 4.0, with
the exact allocation in each package's `LICENSE-SCOPE.txt`. Omitted third-party
content and the manuscript are not licensed by this directory.

Cite Lam Kin Ching, *Coding-agent ETA research materials*, versions 1.1, 2026,
and include the release URL and exact commit or archive checksum. The framework's
software citation is in the repository-root `CITATION.cff`. There is no assigned
manuscript DOI in this release.
