ETA Methods and Validity Supplement v1.1
Prepared 24 October 2026 for ETA Preprint v1.7, editorial revision r2
https://github.com/kinchinglam66-alt/codex-progress-hud/releases/tag/research-release-2026-10-24
Licensed publication revision of the reviewed local v1 candidate.

PURPOSE
This supplement exposes the input construction, request contract and validity
boundaries behind the Full/Activity comparisons. Start with METHODS.txt and
VALIDITY-AND-AMENDMENTS.txt. Study G's paper label +Content is stored as full
in the original records; legacy Full and G +Content are different packages.

CONTENTS
prompts/: the actual archived G developer prompt and response schema, plus
request settings and correspondence to the prior F validation audit.
builders/: the unchanged frozen canonical builder and its original three tests;
the legacy F projection functions with one import adapted for standalone use;
and a synthetic example with three anchor pairs.
audit/: all 72 G frozen-input metadata records, 36 paired event structures,
144 G call records, and metadata selected from the prior E/F request audit.
protocols/: original F protocol and input addendum, a readable G design summary,
and the original calibration values. No factors were fitted for this release.
PROVENANCE.json: original source hashes and exact transformation boundaries.
MANIFEST.json: hashes of the files included in this supplement.

QUICK CHECK
Use an existing Python 3.10+ installation, with no third-party dependencies:
    python verify.py
Optionally check the join to the separate numeric supplement:
    python verify.py --numeric /path/to/numeric-supplement/numeric-data.json
Use Node.js 24+ to exercise the included input builder:
    node --test builders/canonical.test.mjs
    node builders/demo.mjs
The demo prints synthetic paired observations; it does not contact a model.
Neither command requires an account, network access or package installation.

WHAT CAN BE CHECKED PUBLICLY
File integrity; the complete published metadata population; matched activity
sequences and clock cutoffs; event identity uniqueness; input-size differences;
the developer instructions and response schema; the numerical join for all 96
G evaluation calls; and builder behavior on synthetic examples. The prior E/F
audit metadata exposes field/role/length and duplicate-wrapper differences.

WHAT STILL REQUIRES PRIVATE EVIDENCE
Exact historical task text, commands, stdout/stderr, native event streams and
receipts are not included. Public paired structures preserve identities, timing,
field names, lengths and selected failure flags, but omit textual content.
They are derived audit records, not the original inputs and not inputs used to
produce the reported forecasts. Synthetic examples are illustrative only.
Hashes bind the author's retained evidence; without the private bytes they do
not let a reader independently verify semantic content or its absence of leaks.
Full transcript redistribution rights and access arrangements remain unresolved.
No private pseudonym mapping, account files, session identifiers or server paths
are shipped. Pseudonyms do not guarantee anonymity against external linkage.

RELATION TO OTHER ARTIFACTS
ETA-Numeric-Supplement-v1 checks 436 numeric comparisons for selected main-line
tables and figure components. It does not reproduce every analysis in the paper.
This supplement adds methods and structural audit evidence; it does not expand
that arithmetic coverage or independently replicate the model experiment.
The separately prepared framework snapshot documents software behavior. Its
runtime version and this empirical packet do not establish deployed-plugin
accuracy, usefulness, or a correspondence of every historical runtime file.

LICENSE AND STATUS
Program code and the output-schema definition are Apache-2.0. Derived data,
prompt text and explanatory materials are CC BY 4.0 to the extent of the
author's rights. See LICENSE-SCOPE.txt and LICENSES/. These licenses do not
extend to omitted third-party task content or to the unpublished manuscript.
v1.1 adds licensing and release access statements; original scientific numbers,
prompt/schema and builder bytes are unchanged from the reviewed v1 candidate.
Author: Lam Kin Ching, Independent Researcher, Hong Kong, China.
ORCID: 0009-0009-4254-0631.
