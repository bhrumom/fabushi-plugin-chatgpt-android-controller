# fabushi-plugin-chatgpt-android-controller — Agent Instructions

These instructions apply repository-wide to AI-assisted development in `bhrumom/fabushi-plugin-chatgpt-android-controller`.

## CRITICAL: Spec-first development — No Spec, No Code

Before product-affecting implementation, verify repository ownership and read the applicable durable specification. If no usable specification exists, create or repair it before implementation. Do not use chat memory as the only persistent requirement source.

## CRITICAL: Standard end-to-end development lifecycle

All AI-assisted development must follow this fail-closed lifecycle unless a newer explicit user instruction or applicable Spec defines a stricter/task-specific requirement:

**Discover → Confirm Goal → Spec → Current-State Verification → Architecture → Task Decomposition → Test Design → Implement → Layered Verification → Failure/Recovery Verification → Exact-HEAD CI → Packaged Acceptance → Independent Acceptance → Spec Compliance Review → Protected Integration → Canonical-Main Verification → Release → Post-Release Smoke Test → Evidence Archive → COMPLETE**

1. **Discover / Goal:** read repository instructions; verify current code/GitHub state; identify the real problem, target outcome, scope and non-goals.
2. **Spec:** read the durable Spec completely; create/repair it before implementation if missing/stale/incomplete; define requirements, edge cases, tests, acceptance criteria and Definition of Done. Spec is durable truth, not a minute-by-minute work log.
3. **Current State / Architecture:** verify canonical branch/SHA, active PR head, actual ownership/dependencies/versions/CI/release facts; derive ownership boundaries, interfaces, data/control flow, failure handling, migration and observability.
4. **Tasks / Test Design:** split non-trivial work into traceable tasks mapped to requirement IDs; define applicable verification before coding: Static/Architecture → Unit → Contract → Integration → E2E → Regression → Failure/Recovery → Packaged App → Release/Update Acceptance.
5. **Implement:** code against the Spec and verified source; stay in scope; do not weaken requirements to make checks pass; update durable records with intentional design/behavior changes.
6. **Verify:** run required layers from narrow to broad, including abnormal/recovery paths when applicable. Behavioral test scope follows the latest explicit user instruction and applicable Spec; waived tests are recorded as waived/not run, never as passed.
7. **Exact-HEAD CI:** bind authoritative CI evidence to the exact accepted SHA and record workflow run IDs/URLs; earlier-SHA evidence becomes stale after head changes.
8. **Packaged Acceptance:** when required, verify the actual installable/deployable artifact, integrity/signing/metadata, install/launch and required critical flows. Source build success alone is not packaged acceptance.
9. **Independent Acceptance:** for non-trivial/release/high-risk work, independently compare **Spec ↔ Final Diff/Code ↔ Exact-Source CI ↔ Required Packaged Behavior ↔ Evidence**.
10. **Spec Compliance:** mark every applicable requirement/AC as `passed` with evidence, `blocked` with reason, or `not-applicable` with reason.
11. **Protected Integration:** development branch → PR → exact-HEAD required CI → required packaged acceptance → review/independent acceptance → Spec compliance → protected merge → canonical main.
12. **Canonical Main / Release:** treat the merge SHA as a new integrated source identity; verify release workflows bind to it; release only from accepted canonical source and satisfy applicable version/build/package/signing/metadata/checksum/publication/rollback gates.
13. **Post-Release / Evidence:** when required, validate the artifact from the real distribution channel; archive final SHA, PR/merge, workflow runs, release/tag, artifacts/checksums, tests, screenshots/video, logs/traces and known limitations.
14. **COMPLETE:** only when every applicable requirement and required delivery gate is evidence-backed.

> **No Spec, No Code.**
>
> **No Evidence, No Complete.**
>
> **No required exact-source verification, No Acceptance.**
>
> **No required canonical-main packaged/release verification, No Release Complete.**

