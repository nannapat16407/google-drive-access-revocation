# Requirement

**Project:** Automated Google Drive Access Revocation for Internship Offboarding
**Document type:** Software Requirements Specification (SRS)
**Status:** Draft v0.1 — pending supervisor review
**Last updated:** 2026-06-16

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Scope](#2-scope)
3. [Functional Requirements](#3-functional-requirements)
4. [Non-Functional Requirements](#4-non-functional-requirements)
5. [Data Model](#5-data-model)
6. [Assumptions](#6-assumptions)
7. [Risks](#7-risks)
8. [Open Questions](#8-open-questions)

---

## 1. Project Overview

### 1.1 Background

The company runs a structured internship program with multiple parallel
cohorts. Each intern is assigned a dedicated Google Drive folder
(document submission, work products, evaluation material) and is granted
edit access to that folder for the duration of their internship.

Internship records are tracked in a central Google Sheets workbook
(`Internship Application`) that captures applicant data, evaluation
results, active assignments, and timelines across approximately
50,000+ raw applicant rows and dozens of active interns at any given
time.

### 1.2 Problem Statement

When an intern's engagement ends (completion, withdrawal, or early
termination), their Drive access **must be removed promptly**. Today
this is performed manually and exhibits the following problems:

- **Latency.** Access frequently remains active for days or weeks after
  an internship ends, exposing internal documents to former interns.
- **Inconsistency.** Different supervisors follow different workflows;
  some remove only the parent folder, others forget subfolders.
- **No audit trail.** There is no reliable record of when access was
  revoked, by whom, or whether the operation succeeded.
- **Scale.** With many overlapping cohorts, manual tracking no longer
  scales and is increasingly the source of offboarding incidents.

### 1.3 Objective

Build an automated, auditable Google Apps Script solution that reads
internship data from the production Google Sheet and removes Google
Drive access for interns whose engagement has ended, on a defined
schedule, with structured logging and dry-run support.

### 1.4 Expected Benefits

| Benefit                         | Description                                                                 |
| ------------------------------- | --------------------------------------------------------------------------- |
| Reduced offboarding latency     | Access is revoked within hours of an internship ending, not days or weeks. |
| Consistent policy enforcement   | Every offboarded intern is processed by the same rules.                     |
| Auditability                    | Every run produces an immutable log row per intern and a run-level summary. |
| Operator productivity           | HR / IT no longer spend manual cycles tracking offboarding checklists.     |
| Safer data handling             | Shortens the window during which sensitive material is reachable.          |
| Dry-run capability              | Operators can preview the candidate set before any permission is changed.   |

---

## 2. Scope

### 2.1 In Scope

The system **will**:

1. Read internship data from the production Google Sheets workbook.
2. Identify interns whose engagement end date has passed (subject to a
   configurable grace period).
3. Resolve the intern's assigned Google Drive folder URL from the
   spreadsheet.
4. Revoke the intern's edit / view / comment permission on that folder
   (and, optionally, on its subfolders and contained files — pending
   stakeholder confirmation; see `OpenQuestions.md`).
5. Respect an allowlist of exception users (e.g. supervisors, IT) who
   must never be revoked.
6. Write back a per-intern status and append structured execution logs.
7. Execute automatically on a time-driven trigger.
8. Support a dry-run mode that computes the candidate set and logs
   intent without mutating any Drive permissions.
9. Surface run summaries via email to configured recipients.

### 2.2 Out of Scope

The system **will not**:

1. Grant or modify access for new interns (onboarding is handled
   manually by HR / IT and remains out of scope).
2. Manage permissions on systems other than Google Drive
   (e.g. email accounts, chat, source control, VPN).
3. Re-evaluate or edit the internship data itself (start date, end
   date, status). The workbook is read-only with respect to those
   fields; only the dedicated status / log columns are written.
4. Provide a graphical user interface beyond the existing Google Sheet.
   A custom menu may be added later, but no web app is planned.
5. Recover permissions after revocation. Re-granting access, if needed,
   is a manual operation.
6. Synchronise identity across multiple email addresses owned by the
   same intern (e.g. personal vs. university accounts). The system
   operates strictly on the email recorded in the source sheet.
7. Handle Drive folders that were shared outside the documented
   process. Folders without a parseable URL in the spreadsheet are
   skipped and logged.

---

## 3. Functional Requirements

Each requirement has a stable identifier (`FR-NN`) so it can be traced
into the system design and test cases.

### FR-01 — Read internship data from Google Sheets

**Description.** The system shall read internship records from the
production Google Sheets workbook identified by `SPREADSHEET_ID` in
`config.gs`, on the sheet identified as the source of truth
(`SOURCE_SHEET_NAME`).

**Inputs.** None (driven by trigger or manual invocation).

**Outputs.** A list of `InternRecord` objects containing at minimum:
intern name, intern email, internship start date, internship end date,
internship status, and the assigned Google Drive folder URL.

**Acceptance criteria.**

- Reading succeeds even when rows contain multilingual content (Thai
  and English text).
- Reading succeeds when optional fields (e.g. LINE, university) are
  blank.
- Rows that are entirely blank are skipped silently.
- The system does not crash when the source sheet is renamed; it logs
  a descriptive error instead.

**Notes.** The choice of source sheet (`Timeline`, `Dashboard`, or
`Intern list`) is pending stakeholder confirmation — see
`OpenQuestions.md` question Q-01.

---

### FR-02 — Validate internship end date

**Description.** The system shall parse and validate the end date of
each intern record before evaluating revocation eligibility.

**Inputs.** A raw end-date value from the sheet.

**Outputs.** A typed `Date` object, or a parse error captured for
logging.

**Acceptance criteria.**

- Native Google Sheets datetime values are accepted as-is.
- Text dates of the form `"Jan 5, 2026"` are parsed correctly.
- Date ranges of the form `"05/01/2026 - 10/04/2026"` are parsed by
  extracting the second date.
- Empty or unparseable end dates are flagged; the record is skipped
  and logged, not processed.
- Date parsing is locale-independent (i.e. it does not silently
  swap day and month).

---

### FR-03 — Identify interns whose internship has ended

**Description.** The system shall determine, for each record, whether
the intern is a candidate for revocation.

**Eligibility rule.** A record is a candidate if **all** of the
following are true:

1. The intern's end date is in the past, or older than `NOW() -
   GRACE_PERIOD_DAYS`.
2. The internship status is one of the values configured as
   "offboarded" (default: `Completed`, `Withdraw`; pending confirmation
   in Q-02).
3. The intern's email is not in the exception allowlist
   (`EXCEPTION_EMAILS`).
4. The intern has not already been marked as revoked in the status
   column (idempotency — see FR-06).
5. The intern has a parseable Google Drive folder URL.

**Acceptance criteria.**

- Records that fail any criterion are skipped and logged with the
  reason.
- The candidate list is reproducible for a given snapshot of the
  sheet (same data in ⇒ same candidates out).

---

### FR-04 — Extract Google Drive folder information

**Description.** The system shall resolve the intern's assigned Google
Drive folder URL to a concrete folder ID usable with the Drive API.

**Inputs.** A URL string from the spreadsheet (e.g.
`https://drive.google.com/drive/folders/{id}`,
`https://drive.google.com/open?id={id}`).

**Outputs.** A Drive folder ID, or a resolution error captured for
logging.

**Acceptance criteria.**

- Both `/drive/folders/{id}` and `open?id={id}` forms are supported.
- File URLs (`/file/d/{id}`) are detected and skipped (logged), since
  the system targets folder permissions.
- URLs that 404 or that the running user cannot access are logged and
  skipped; the run continues.

---

### FR-05 — Revoke Google Drive access permissions

**Description.** The system shall remove the intern's permission on
the resolved folder.

**Inputs.** Folder ID, intern email.

**Outputs.** A `RevocationResult` describing whether the permission
was found, whether removal succeeded, and any error message.

**Acceptance criteria.**

- If the intern has permission on the folder via their recorded email,
  that permission is removed.
- If the intern has no permission on the folder (e.g. already
  removed manually), this is treated as success and logged as
  "already revoked", not as an error.
- If the intern's email is in `EXCEPTION_EMAILS`, the revocation is
  skipped and logged, even if all other criteria were met.
- Revocation failures (Drive API errors, permission denied, rate
  limits) are caught, logged with the API error message, and do not
  abort the run.
- When `DRY_RUN` is `true`, no permission is removed; the result is
  logged as "would have revoked".

**Notes.** Whether revocation propagates to subfolders and contained
files is pending stakeholder confirmation — see Q-03.

---

### FR-06 — Record execution logs

**Description.** The system shall persist a structured execution log
for every run, in a dedicated sheet (`LOG_SHEET_NAME`).

**Per-intern log row.** One row per intern processed, capturing:

- Run ID (correlates with the summary row).
- Timestamp.
- Intern identifier (name + row reference).
- Intern email.
- Folder URL / resolved folder ID.
- Action taken (revoked / already-revoked / skipped / dry-run).
- Reason (e.g. "completed + grace period expired", "exception user",
  "folder URL missing").
- Outcome (success / failure).
- Error message (if any).

**Run-summary log row.** One row per invocation, capturing:

- Run ID.
- Started-at, ended-at, duration.
- Trigger source (scheduled / manual).
- Dry-run flag.
- Total candidates, revoked, already-revoked, skipped, failed.

**Acceptance criteria.**

- Logs are appended, never overwritten.
- The log sheet grows in a way that does not require manual cleanup
  within the first 12 months of operation (see Risks R-09).
- Log writes are batched to stay within Sheets API quota.

---

### FR-07 — Support automatic execution via Trigger

**Description.** The system shall run automatically on a time-driven
trigger whose schedule is defined by `TRIGGER_SCHEDULE`.

**Acceptance criteria.**

- Installing the trigger does not create duplicates if it is already
  installed.
- The trigger calls `main.runRevocationPipeline()` (or a thin
  `onScheduledRun` wrapper) at the configured cadence.
- An operator can install and uninstall the trigger via dedicated
  functions without editing code.
- The trigger is owned by a service account or operator account whose
  Drive permissions cover every intern folder.

---

### FR-08 — Error handling

**Description.** The system shall handle errors at three layers without
aborting the overall run.

**Layer 1 — Per-intern errors.** A Drive API failure, a missing field,
or a permission-resolution error for one intern is caught, logged, and
skipped. The run continues with the next candidate.

**Layer 2 — Per-run errors.** If the source sheet cannot be opened, or
the workbook ID is wrong, or authentication has expired, the run is
aborted with a clear log entry and an email notification to
`NOTIFICATION_RECIPIENTS`.

**Layer 3 — Trigger-level errors.** If a scheduled invocation throws
uncaught, the Apps Script runtime's failure-notification channel
delivers an email to the script owner.

**Acceptance criteria.**

- A single intern's failure never prevents the others from being
  processed.
- Every caught error produces a log row containing the error message.
- Failure to open the source sheet triggers a notification email
  within the same invocation.

---

### FR-09 — Dry-run mode

**Description.** The system shall support a `DRY_RUN` flag that
computes the full candidate set and produces complete logs **without
mutating any Drive permission**.

**Acceptance criteria.**

- Dry-run log rows are clearly marked so they can be distinguished
  from real revocations.
- Switching between dry-run and live mode requires editing only
  `config.gs`.

---

### FR-10 — Run-summary notification

**Description.** At the end of each run, the system shall send an
email summary to `NOTIFICATION_RECIPIENTS`.

**Acceptance criteria.**

- The email contains the run ID, the counts from FR-06, and a link
  to the log sheet.
- Email is sent even when the run encountered per-intern failures.
- Email is sent on abort-level errors (FR-08 Layer 2).

---

## 4. Non-Functional Requirements

### 4.1 Security

- **NFR-S1 (Least privilege).** The script's OAuth scopes shall be
  limited to the minimum required: spreadsheets, drive (read/write on
  the relevant folders), and send-mail. No broader admin scopes.
- **NFR-S2 (Exception allowlist).** The system shall refuse to revoke
  any email in `EXCEPTION_EMAILS`, regardless of input data.
- **NFR-S3 (Auditability).** Every permission change shall be
  attributable to a run ID and a timestamp. The log sheet shall not
  be editable by interns.
- **NFR-S4 (Secret handling).** No credentials shall be embedded in
  source. Authentication uses the OAuth token of the script owner /
  trigger owner.
- **NFR-S5 (Idempotency).** Re-running on the same data shall not
  produce duplicate revocations or duplicate log writes for the same
  candidate within the same grace window.

### 4.2 Reliability

- **NFR-R1 (Per-intern isolation).** A failure on one intern's
  revocation shall not abort the run.
- **NFR-R2 (Retry on transient failure).** Transient Drive API
  errors (HTTP 5xx, rate-limit) shall be retried with bounded
  back-off before being logged as failed.
- **NFR-R3 (Quota awareness).** The system shall batch reads from
  Sheets and batch writes to logs to remain within Apps Script
  quotas.
- **NFR-R4 (Re-runnability).** Any run can be re-executed manually
  after a fix without producing harmful side effects.

### 4.3 Maintainability

- **NFR-M1 (Configuration isolation).** All tunable parameters live
  in `config.gs`. Business logic does not hard-code IDs, schedules,
  or thresholds.
- **NFR-M2 (Service boundaries).** Sheets, Drive, logging, and
  trigger concerns are isolated into their own modules with clear
  public function lists.
- **NFR-M3 (Documentation).** Every module shall carry a file-level
  header describing its responsibility, dependencies, and public
  functions.
- **NFR-M4 (Traceability).** Every function in `src/` shall be
  traceable to one or more requirements (FR-NN / NFR-NN) via the
  developer documentation (later phase).

### 4.4 Usability

- **NFR-U1 (Operator-friendly config).** A non-developer operator
  shall be able to enable dry-run mode, change the schedule, and add
  an exception email by editing `config.gs` alone.
- **NFR-U2 (Clear logs).** Log rows shall be human-readable; reason
  fields shall use a controlled vocabulary, not free text.
- **NFR-U3 (Notifications).** Run summaries shall be concise and
  link to the log sheet for detail.

### 4.5 Performance

- **NFR-P1 (Run duration).** A run processing the current active
  intern population (≤ 100 candidates) shall complete within the
  Apps Script 6-minute execution limit.
- **NFR-P2 (Scale path).** If the candidate set ever exceeds the
  6-minute budget, the system shall split work across chained
  invocations (deferred to a future phase — see SystemDesign.md
  §6 Future Enhancements).
- **NFR-P3 (Read efficiency).** Sheets reads shall use `getValues()`
  batch fetches, not per-cell reads.

---

## 5. Data Model

The system reads from the production workbook and writes to two
dedicated output surfaces. The exact source sheet is pending Q-01.

### 5.1 Input columns (read)

Based on direct inspection of `Internship Application.xlsx`, the
relevant fields are spread across several sheets. The columns below
are the ones the system actually needs:

| Logical field          | Column observed in `Timeline` / `Dashboard` | Column observed in `Intern list` | Notes |
| ---------------------- | -------------------------------------------- | -------------------------------- | ----- |
| Intern name            | `NAME` (B)                                   | `NAME` (C)                       | May contain Thai or English text. |
| Intern email           | `EMAIL` (H)                                  | `EMAIL` (F)                      | Identity used to match Drive permission. |
| Internship start date  | `START` (D) — datetime                       | `START` (O) — text               | Format differs between sheets. |
| Internship end date    | `END` (E) — datetime                         | `END` (P) — text / range         | Format differs between sheets. |
| Internship status      | `INTERNSHIP STATUS` (K)                      | (no equivalent column)           | Values seen: `Completed`, `Interning`, `Pending`, `Withdraw`. |
| Assigned folder URL    | `FOLDER LINK` (L)                            | `DOCUMENT LINK` (T)              | Two URL forms observed. |

The `Timeline` sheet is the cleaner operational source: it has native
datetime dates, a single dedicated `FOLDER LINK` column, and a
dedicated `INTERNSHIP STATUS` column. `Dashboard` mirrors `Timeline`
minus three tracking columns. `Intern list` is the raw applicant feed
and would require significantly more normalisation.

### 5.2 Output columns (write)

| Surface               | Purpose                                                            |
| --------------------- | ------------------------------------------------------------------ |
| Status column on the source sheet | Per-intern marker indicating `Access Revoked` with timestamp, to support idempotency. |
| Dedicated log sheet    | One row per intern processed, plus one summary row per run (see FR-06). |

Adding a status column to an existing sheet requires stakeholder
approval — see Q-04.

### 5.3 Reference data (read-only)

The workbook also contains `Requirement` (position catalog) and
`Supervisor` (supervisor directory) sheets. These are not directly
consumed by the revocation pipeline but may be used to populate the
exception allowlist (Q-06) and to enrich notification content.

---

## 6. Assumptions

The following assumptions are made in this draft. Each must be
confirmed with stakeholders before implementation begins.

- **A-01.** The intern's permission on their assigned Drive folder is
  granted via the email recorded in the `EMAIL` column. There is no
  separate "Drive account" identity to reconcile.
- **A-02.** The script owner / trigger-owning account has at least
  Manager / Editor permission on every intern folder, so that it can
  enumerate and remove permissions.
- **A-03.** The source-of-truth sheet is maintained manually and is
  accurate at the time of each run. Specifically, when an intern's
  engagement ends, a supervisor sets `INTERNSHIP STATUS` to
  `Completed` (or `Withdraw`) within a reasonable window.
- **A-04.** The intern folder URL stored in the sheet is the canonical
  entry point for that intern's access. Permissions on linked / shared
  drives are out of scope unless explicitly flagged for propagation.
- **A-05.** The volume of interns processed per run is small enough to
  fit within the Apps Script 6-minute execution limit.
- **A-06.** Operators have edit access to the script project so they
  can change `config.gs` and (un)install triggers.
- **A-07.** Drive access for interns was originally granted by sharing
  the folder by email, not via a Google Group. If groups are involved,
  revocation semantics differ (see Q-08).

---

## 7. Risks

Each risk is assigned an ID, an impact, a likelihood, and a mitigation.

| ID   | Risk                                                                                       | Impact | Likelihood | Mitigation                                                                                                            |
| ---- | ------------------------------------------------------------------------------------------ | ------ | ---------- | --------------------------------------------------------------------------------------------------------------------- |
| R-01  | Wrong source sheet selected, causing access to be revoked for interns still active.        | High   | Medium     | Default to dry-run on first deployment; require explicit sign-off on Q-01 before live mode.                            |
| R-02  | Email mismatch: intern's Drive permission was granted via a different email (personal vs. university). | High   | Medium     | Log "no permission found" rather than treating it as success; surface unresolved cases in the run summary.            |
| R-03  | Date parsing swaps day and month for ambiguous dates (e.g. `05/04/2026`).                  | High   | Low        | Use explicit format strings per source sheet; reject ambiguous values rather than guess.                              |
| R-04  | Subfolders / files retain access after parent is revoked.                                  | High   | Medium     | Pending decision in Q-03; default behaviour documented before go-live.                                                |
| R-05  | Script owner leaves the organisation; trigger stops running.                               | Medium | Medium     | Use a shared / service account where possible; monitor run summaries for missing invocations.                         |
| R-06  | Quota exhaustion mid-run leaves some interns unprocessed.                                  | Medium | Low        | Batch reads / writes; bounded retries; resume capability in a future phase.                                           |
| R-07  | The spreadsheet schema changes (column rename / reorder) without notice.                   | Medium | Medium     | Centralise column mapping in `config.gs`; fail loudly with a descriptive log on column-not-found.                     |
| R-08  | A supervisor adds an active intern to `EXCEPTION_EMAILS` to prevent accidental revocation, then forgets to remove them. | Low    | Medium     | Surface exception users in every run summary so they remain visible.                                                  |
| R-09  | The log sheet grows without bound and slows the workbook.                                  | Low    | Medium     | Define a retention policy (e.g. archive rows older than 12 months); implement in a future phase.                       |
| R-10  | Stakeholders revoke the script's access to a folder mid-run.                               | Medium | Low        | Catch the access error per folder; log and continue.                                                                  |
| R-11  | Drive API returns 429 / rate-limit due to concurrent Google Workspace activity.            | Medium | Low        | Exponential back-off with bounded retries (NFR-R2).                                                                   |
| R-12  | Misuse of the system to maliciously revoke access (insider threat).                        | High   | Low        | Restrict script edit access to named operators; maintain immutable audit log; alert on unexpected runs.               |

---

## 8. Open Questions

A consolidated list of decisions that must be confirmed before
implementation begins is maintained in
[`OpenQuestions.md`](./OpenQuestions.md). That document is the
controlling reference; the questions below are summarised here for
context:

- **Q-01** Which sheet is the source of truth?
- **Q-02** Which `INTERNSHIP STATUS` values trigger revocation?
- **Q-03** Should revocation propagate to subfolders and files?
- **Q-04** May the system write a status column back to the source sheet?
- **Q-05** What is the grace-period length and what is the trigger schedule?
- **Q-06** Which users are on the exception allowlist?
- **Q-07** Who receives run-summary notifications?
- **Q-08** Are interns granted access via a Google Group rather than direct sharing?
- **Q-09** Which account owns the script / trigger?
- **Q-10** What is the retention policy for the log sheet?

---

## 9. Sign-off

| Role                  | Name | Date       | Decision |
| --------------------- | ---- | ---------- | -------- |
| Internship Program Lead |      |            |          |
| HR Manager              |      |            |          |
| IT / Security reviewer  |      |            |          |
| Project supervisor      |      |            |          |
