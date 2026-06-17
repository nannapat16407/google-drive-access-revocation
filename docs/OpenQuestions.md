# Questions Requiring Stakeholder Confirmation

**Project:** Automated Google Drive Access Revocation for Internship Offboarding
**Document type:** Open Questions register
**Status:** Draft v0.1 — pending supervisor review
**Last updated:** 2026-06-16

> Implementation cannot safely begin until every question below has a
> confirmed owner-decision recorded in the **Decision** column. Each
> open question maps to one or more requirements or risks in
> `Requirement.md` so that the impact of a decision is visible.

---

## How to use this document

- Each question has a stable ID (`Q-NN`).
- **Decision** is captured in one short sentence.
- **Owner** is the role accountable for the decision.
- **Impact** lists the requirement IDs (`FR-NN`, `NFR-NN`) and risk
  IDs (`R-NN`) the decision affects.
- **Status** is one of `Open`, `Proposed`, `Confirmed`.

When a decision is confirmed, also update `Requirement.md` and
`SystemDesign.md` to reflect it, then mark the question `Confirmed`.

---

## Question register

### Q-01 — Which sheet is the source of truth?

**Context.** The workbook contains multiple sheets that hold
internship data, each with different conventions:

| Sheet          | Has dedicated `FOLDER LINK` col? | Has `INTERNSHIP STATUS` col? | Date format    | Approx. data rows |
| -------------- | -------------------------------- | ---------------------------- | -------------- | ----------------- |
| `Intern list`  | No (folder URL in `DOCUMENT LINK`, plus other Drive links in `TEST LINK`, `RESUME`) | No                           | Text / ranges  | ~3,000+ applicants |
| `Timeline`     | Yes                              | Yes                          | Native datetime | ~58 active records |
| `Dashboard`    | Yes                              | Yes                          | Native datetime | ~58 (mirror of Timeline) |
| `Result`       | Partial (`DOCUMENT LINK` only)  | No (has `STATUS(RESULT)` = Pass/Fail) | Native datetime | ~978 |

`Timeline` is the operationally cleanest source: native dates, a
single dedicated `FOLDER LINK` column, and a dedicated
`INTERNSHIP STATUS` column. `Intern list` is the raw applicant feed
and contains many candidates who never became interns.

**Question.** Which sheet should the revocation pipeline read from?

**Impact.** FR-01, FR-02, FR-04, R-01, R-07.

**Owner.** Internship Program Lead.

**Decision.** _Open._ Recommended: `Timeline`.

**Status.** Open.

---

### Q-02 — Which `INTERNSHIP STATUS` values trigger revocation?

**Context.** The `Timeline` and `Dashboard` sheets use these status
values:

- `Completed`
- `Interning`
- `Pending`
- `Withdraw`

**Question.** Which of these values should be treated as
"offboarded" for the purpose of revocation?

- Working assumption: `Completed` and `Withdraw`.
- `Interning` and `Pending` are never revoked.

**Follow-up.** Is there a `Terminated` status that does not appear in
the current sample but may exist in production?

**Impact.** FR-03, R-01.

**Owner.** Internship Program Lead / HR.

**Decision.** _Open._

**Status.** Open.

---

### Q-03 — Should revocation propagate to subfolders and files?

**Context.** Each intern has a parent folder (`FOLDER LINK`). The
folder typically contains subfolders for documents, tests, work
products. If access was granted only on the parent, removing the
parent permission cascades automatically. If access was granted
independently on each child, each must be revoked separately.

**Question.** When the parent folder permission is removed, are
children guaranteed to inherit the removal, or must the system walk
the tree and revoke each child explicitly?

**Follow-ups.**

- Is access ever granted on a child without being granted on the
  parent?
- If tree-walk is required, how deep should it go (immediate
  children only, or recursive)?

**Impact.** FR-05, NFR-P1, R-04.

**Owner.** IT / Security reviewer.

**Decision.** _Open._ Recommended: confirm inheritance by inspecting
a sample folder, then default to parent-only.

**Status.** Open.

---

### Q-04 — May the system write a status column back to the source sheet?

**Context.** Idempotency (NFR-S5) and operator visibility both
benefit from a per-intern `ACCESS REVOKED` column written back to
the source sheet. This requires modifying the existing sheet.

**Question.** May the system add and maintain a status column on the
source sheet?

- If yes: which column letter / header name is acceptable?
- If no: how should idempotency be tracked (e.g. consult the log
  sheet only)?

**Impact.** FR-06, NFR-S5, R-07.

**Owner.** Internship Program Lead.

**Decision.** _Open._

**Status.** Open.

---

### Q-05 — What are the grace period and the trigger schedule?

**Context.** FR-03 introduces a configurable grace period
(`GRACE_PERIOD_DAYS`) so that access is not revoked on the literal
end date if a handover extension is in progress. FR-07 requires a
trigger schedule.

**Question.** Please confirm:

- Grace period length (recommended: 0 to 3 days).
- Trigger cadence (recommended: once per day, e.g. 02:00 ICT).
- Trigger timezone.

**Impact.** FR-03, FR-07, NFR-P1.

**Owner.** Internship Program Lead / IT.

**Decision.** _Open._

**Status.** Open.

---

### Q-06 — Who is on the exception allowlist?

**Context.** `EXCEPTION_EMAILS` (NFR-S2) prevents the system from
ever revoking specific accounts. Obvious candidates are the
supervisors already listed in the `Supervisor` sheet
(`aranya.k@…`, `sirapat.p@…`, `nabhassorn@…`) plus any IT admins.

**Question.** Please provide the full list of emails that must be on
the exception allowlist.

**Follow-up.** Should the system read this list dynamically from the
`Supervisor` sheet, or keep it as a static list in `config.gs`?

**Impact.** FR-05, NFR-S2, R-08.

**Owner.** Internship Program Lead / IT.

**Decision.** _Open._

**Status.** Open.

---

### Q-07 — Who receives the run-summary notification?

**Context.** FR-10 sends an email after each run.

**Question.** Which email addresses should receive run summaries?

**Follow-up.** Should failure-only notifications go to a different
(potentially wider) list than routine success summaries?

**Impact.** FR-08, FR-10.

**Owner.** Internship Program Lead.

**Decision.** _Open._

**Status.** Open.

---

### Q-08 — Are interns granted access via a Google Group or via direct share?

**Context.** If interns are added to a Google Group and the group is
shared on each folder, removing the intern means removing them from
the group, not removing a per-folder permission. The two paths
require completely different API calls and scopes.

**Question.** Which model is in use today?

- Direct share by email (the assumption in A-01).
- Google Group membership.
- A mix.

**Impact.** FR-05, NFR-S1, R-02, future enhancement #4.

**Owner.** IT / Security reviewer.

**Decision.** _Open._

**Status.** Open.

---

### Q-09 — Which account owns the script and the trigger?

**Context.** The script/trigger owner must have edit access to every
intern folder (A-02). If the owner leaves the company or loses
access, the trigger stops running (R-05).

**Question.** Which account should own the script and the trigger?

- A personal supervisor account?
- A dedicated service / functional account (e.g.
  `internship-automation@…`)?

**Impact.** FR-07, NFR-S4, R-05, R-12.

**Owner.** IT / Security reviewer.

**Decision.** _Open._ Recommended: a dedicated functional account.

**Status.** Open.

---

### Q-10 — What is the retention policy for the log sheet?

**Context.** The log sheet grows by one row per intern processed per
run plus one summary row per run. At the current scale this is
trivial, but at projected scale it will eventually slow the
workbook (R-09).

**Question.** How long should log rows be retained before archival?

- Recommended: 12 months online, then archive to a separate
  workbook.

**Impact.** FR-06, R-09, future enhancement #7.

**Owner.** Internship Program Lead / IT.

**Decision.** _Open._

**Status.** Open.

---

### Q-11 — What happens when an intern's email does not match any Drive permission?

**Context.** When `driveService.revokeAccess()` is called and finds
no permission for the intern's email, two interpretations are
possible:

- The intern was already revoked manually (treat as success).
- The intern was granted access under a different email (treat as
  unresolved; surface in the run summary).

**Question.** Which interpretation is correct, and how should
unresolved cases be surfaced to operators?

**Impact.** FR-05, FR-10, R-02.

**Owner.** IT / Security reviewer.

**Decision.** _Open._ Recommended: log as `no permission found` and
surface in run summary; never silently treat as success.

**Status.** Open.

---

### Q-12 — Is the local `Internship Application.xlsx` a controlled artifact?

**Context.** A local copy of the workbook exists in the repository.
It was used for analysis during this documentation phase.

**Question.** Should this file remain in the repository, be moved to
a separate `samples/` directory, or be deleted to avoid confusion
with the production Google Sheet?

**Impact.** Repository hygiene; not a runtime concern.

**Owner.** Project supervisor.

**Decision.** _Open._

**Status.** Open.

---

### Q-13 — Are there regulatory / data-residency constraints?

**Context.** The system processes personal data (names, emails,
university affiliations) and writes an audit log.

**Question.** Are there any regulatory constraints (e.g. PDPA, GDPR)
that affect:

- Where the log sheet may live?
- How long logs may be retained?
- Whether interns must be notified when their access is revoked?

**Impact.** NFR-S3, R-09, Q-10.

**Owner.** Legal / compliance (if applicable) or Project supervisor.

**Decision.** _Open._

**Status.** Open.

---

### Q-14 — Should the system ever re-grant access?

**Context.** The system is revocation-only by design (out of scope
§2.2). However, offboarding occasionally needs to be reversed
(intern returns for an extension, revocation was mistaken).

**Question.** Should the system support a re-grant operation, or
will reversals always be performed manually by IT?

**Impact.** Out-of-scope statement in `Requirement.md` §2.2; future
enhancement #5.

**Owner.** Internship Program Lead / IT.

**Decision.** _Open._ Recommended: keep re-grant manual for the
initial release.

**Status.** Open.

---

### Q-15 — Should the system also handle test-link and resume Drive files?

**Context.** The `Intern list` sheet contains several Drive links
per intern: `DOCUMENT LINK` (folder), `TEST LINK` (file), `RESUME`
(file). The current scope is folder-only.

**Question.** Should revocation also cover test submissions and
resume copies once the engagement ends, or only the assigned work
folder?

**Impact.** FR-04, FR-05, scope statement in `Requirement.md` §2.1.

**Owner.** Internship Program Lead / HR.

**Decision.** _Open._ Recommended: folder-only for the initial
release; consider file-level revocation in a future phase.

**Status.** Open.

---

## Summary

| ID    | Topic                                            | Status | Recommended default                       |
| ----- | ------------------------------------------------ | ------ | ----------------------------------------- |
| Q-01  | Source sheet                                     | Open   | `Timeline`                                |
| Q-02  | Status values that trigger revocation            | Open   | `Completed`, `Withdraw`                   |
| Q-03  | Subfolder / file propagation                     | Open   | Parent-only (after confirming inheritance) |
| Q-04  | Write-back status column                         | Open   | Yes, dedicated column                     |
| Q-05  | Grace period + schedule                          | Open   | 1 day grace; daily 02:00 local            |
| Q-06  | Exception allowlist                              | Open   | Supervisors + IT                          |
| Q-07  | Notification recipients                          | Open   | Supervisors + IT                          |
| Q-08  | Direct share vs. Google Group                    | Open   | (Requires IT confirmation)                |
| Q-09  | Script / trigger owner                           | Open   | Dedicated functional account              |
| Q-10  | Log retention policy                             | Open   | 12 months online, then archive            |
| Q-11  | No-permission-found behaviour                    | Open   | Log + surface in summary                  |
| Q-12  | Local `.xlsx` in repo                            | Open   | Move to `samples/`                        |
| Q-13  | Regulatory / data-residency constraints          | Open   | (Requires legal confirmation)             |
| Q-14  | Re-grant support                                 | Open   | Manual for initial release                |
| Q-15  | Test-link / resume file scope                    | Open   | Folder-only for initial release           |

---

## Sign-off

| Role                    | Name | Date       | Decision |
| ----------------------- | ---- | ---------- | -------- |
| Internship Program Lead |      |            |          |
| HR Manager              |      |            |          |
| IT / Security reviewer  |      |            |          |
| Project supervisor      |      |            |          |
