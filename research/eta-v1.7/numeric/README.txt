ETA preprint: numeric reproduction supplement v1.1
Research release: 24 October 2026.
https://github.com/kinchinglam66-alt/codex-progress-hud/releases/tag/research-release-2026-10-24
Publication revision of the reviewed v1 candidate: unchanged numerical files
and reproduction code, with licensing and public access information added.

SCOPE
This packet checks the main raw comparisons in Tables 2-5 and the fixed-support
timing means used in Figure 3. It also checks the component signed-bias and
Pearson values underlying Figure 2. It does not recreate the graphical layout
or every correlation-difference interval, the delivery integration in Table 9,
the historical calibrated appendices, or the full experiment ledger.

This is arithmetic reproduction from author-supplied derived numerical data,
not independent experimental replication, transcript recovery, an input-validity
audit, proof of causality, or evidence that every recorded source is qualified.

RUN
Use an existing Python 3.10+ installation. No third-party modules, model account,
credentials, network, package installation, or external file paths are needed.
From this directory run:
    python reproduce.py
The script runs focused self-tests, recomputes metrics, and compares unrounded
results with the retained reference values. It writes verification.json here.
The expected successful result contains 436 numeric comparisons.

FILES
numeric-data.json: 1,192 recorded rows in the selected main-line cells; 1,168
eligible and 24 explicitly excluded. Excluded records are not replaced by zero
errors. This is a deliberately bounded extract, not all starts or all studies.
expected-results.json: unrounded archived results for exact arithmetic checks.
reproduce.py: a standalone standard-library implementation, not a model runner.
verification.json: observed local result; rerunning regenerates this report.

DATA DICTIONARY AND WEIGHTING
cell: dataset|role|environment|anchor|condition|model. Model names are recorded
service identifiers, not immutable snapshots. E's base comparator is the
archived Timing condition; G's full label denotes canonical +Content, not the
legacy Full package or the deployed plugin. Dataset/condition labels in this
analysis file are not new prediction inputs.
task, repository, trajectory: opaque consistent pseudonyms. Cross-study reuse
is retained, including G's reuse of F normal trajectories. Repeated forecasts
and anchors are not independent tasks. Do not pool studies into a total N.
prediction, truth: raw remaining seconds and independently recorded remaining
seconds, respectively. There is no fitted multiplier or coefficient in this run.
repeat: archived repetition identity; paired differences use common repeats.
eligible, exclusion, status, usageKnown: inherited recording/qualification
flags. They do not describe omitted historical failures or certify all billing.

Average absolute errors within a task before averaging tasks. Do not substitute
the absolute error of the mean forecast. Signed bias averages signed errors.
Pearson correlates task-mean forecasts with task truth within the same cell.
MARE excludes tasks with less than 60 seconds remaining; it is a ratio, not
100 minus an accuracy percentage. Fixed-support profiles use the same 16 B
tasks at all four anchors, whereas Table 4 uses 19 tasks for MAE and the stated
anchor-specific eligibility for MARE. Fractional anchors use final duration
retrospectively and are not validated online triggers.

Unadjusted 95% percentile intervals use 10,000 repository-cluster bootstrap
draws, seed 20261024, retaining within-cluster task weights and encounter order.
The generator is a 32-bit LCG with multiplier 1664525 and increment 1013904223.
Bounds use floor(.025*(n-1)) and ceil(.975*(n-1)). Interactions retain later or
candidate cluster order, so exact finite-draw endpoints match the archived run.
Small numbers of clusters limit inference. A zero-crossing interval is not
equivalence. These are retrospective raw results, not replacement preregistered
primaries. Original inconclusive calibrated tests remain in the manuscript.

PRIVACY AND RIGHTS
No prompts, source code from benchmark repositories, execution output, local
paths, server identities, credentials, private pseudonym map, or raw transcripts
are included. Numerical records may still be linkable through external evidence;
pseudonymization is not a guarantee of anonymity. Program code is Apache-2.0;
derived numerical data and documentation are CC BY 4.0, to the extent of the
author's rights. See LICENSE-SCOPE.txt and LICENSES/ for the complete texts.

BOUNDARIES
This packet does not resolve legacy Full/Activity packaging confounds, source
selection, scheduling amendments, hardware changes, anchor changes, historical
reuse, retrospective analysis selection, or limited independent confirmation.
Its passing checks establish numerical consistency, not scientific validity.
