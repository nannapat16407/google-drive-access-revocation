# Project Status Report

**Project:** Automated Google Drive Access Revocation for Internship Offboarding
**Document type:** Project Status Report
**Report date:** 2026-06-16
**Reported by:** Project author (pending supervisor sign-off)
**Source of truth:** `docs/ProjectStructure.md`, `docs/Requirement.md`, `docs/SystemDesign.md`, `docs/OpenQuestions.md`, `docs/DataDictionary.md`, and source files under `src/`

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Completed Work](#2-completed-work)
3. [Spreadsheet Analysis Summary](#3-spreadsheet-analysis-summary)
4. [Remaining Work](#4-remaining-work)
5. [Development Progress](#5-development-progress)
6. [Open Questions Requiring Confirmation](#6-open-questions-requiring-confirmation)
7. [Recommended Next Steps](#7-recommended-next-steps)
8. [Project Readiness Assessment](#8-project-readiness-assessment)

---

## 1. Project Overview

### 1.1 Objective

Build an automated, auditable Google Apps Script solution that reads
internship data from the production Google Sheets workbook
(`Internship Application`) and removes Google Drive folder access for
interns whose engagement has ended, on a defined schedule, with
structured logging and dry-run support.

### 1.2 Problem Being Solved

Today, when an intern's engagement ends (completion, withdrawal, or
early termination), their Drive access is removed manually. This causes
four documented problems:

- **Latency.** Access often remains active for days or weeks after an
  internship ends.
- **Inconsistency.** Different supervisors follow different workflows.
- **No audit trail.** There is no reliable record of who revoked what
  and when.
- **Scale.** With overlapping cohorts, manual tracking no longer
  scales.

### 1.3 Intended Outcome

A single Google Apps Script project, bound to the production
spreadsheet, that:

- Reads intern records from the `Timeline` sheet (recommended source
  of truth).
- Identifies interns whose end date has passed and whose status is
  `Completed` or `Withdraw`.
- Removes their edit / view / comment permission on their assigned
  Drive folder via Direct Share lookup by email.
- Persists a per-intern log row and a per-run summary row to a
  dedicated log sheet.
- Runs on a daily time-driven trigger.
- Supports a dry-run mode that produces complete logs without mutating
  any Drive permission.

### 1.4 Confirmed Assumptions (from project supervisor)

The following assumptions have been confirmed verbally by the project
supervisor and now govern implementation. They are recorded in
`docs/DataDictionary.md` §"Confirmed assumptions for this document":

| Assumption          | Value                       |
| ------------------- | --------------------------- |
| Source sheet        | `Timeline`                  |
| Permission type     | Direct Share (by email)     |
| Folder scope        | Main folder only            |
| Email notifications | None                        |
| Trigger             | Daily time-driven trigger   |

> **Note:** `docs/OpenQuestions.md` still lists several of these
> items (Q-01, Q-02, Q-03, Q-07, Q-08) as `Open`. The corresponding
> entries in `OpenQuestions.md` should be updated to `Confirmed` so
> the documentation set is internally consistent. See Section 6.

---

## 2. Completed Work

### 2.1 Repository Skeleton

| Attribute         | Value                                                              |
| ----------------- | ----------------------------------------------------------------- |
| Deliverable name  | Repository skeleton (`README.md`, `src/`, `docs/`)                |
| Purpose           | Provide a navigable, maintainable home for source and docs.       |
| Summary of contents | `README.md` abstract; six `.gs` files under `src/`; five `.md` files under `docs/`; local copy of the workbook for analysis (`Internship Application.xlsx`). |
| Completion status | **Done.** |

### 2.2 `docs/ProjectStructure.md`

| Attribute         | Value                                                              |
| ----------------- | ----------------------------------------------------------------- |
| Deliverable name  | Project Structure specification                                   |
| Purpose           | Document the recommended file / folder layout and the responsibility of each module. |
| Summary of contents | Repository layout; per-module responsibility for each `src/*.gs` file; documentation responsibilities for each `docs/*.md` file; tooling notes (clasp vs. direct paste); project status checklist. |
| Completion status | **Done (Draft, pending supervisor review).** Last updated 2026-06-16. |

### 2.3 `docs/Requirement.md`

| Attribute         | Value                                                              |
| ----------------- | ----------------------------------------------------------------- |
| Deliverable name  | Software Requirements Specification (SRS)                         |
| Purpose           | Define functional and non-functional requirements, scope, assumptions, and risks. |
| Summary of contents | 10 functional requirements (FR-01 … FR-10); 5 categories of non-functional requirements (Security, Reliability, Maintainability, Usability, Performance); data model (input columns, output surfaces, reference data); 7 assumptions (A-01 … A-07); 12 risks (R-01 … R-12); cross-reference to Open Questions. |
| Completion status | **Done (Draft v0.1, pending supervisor sign-off).** Sign-off block at the end is empty. |

### 2.4 `docs/SystemDesign.md`

| Attribute         | Value                                                              |
| ----------------- | ----------------------------------------------------------------- |
| Deliverable name  | Preliminary System Design                                         |
| Purpose           | Communicate architecture intent and component responsibilities at a level sufficient for stakeholder review. |
| Summary of contents | Architecture overview (single Apps Script project bound to the workbook); 7 components (`main.gs`, `sheetService.gs`, `driveService.gs`, `logService.gs`, `triggerService.gs`, `config.gs`, Operator); end-to-end workflow for a scheduled run; data flow (read path, revocation path, write-back path); cross-cutting concerns (error handling, idempotency, quota, security, observability); 10 future enhancements. |
| Completion status | **Done (Preliminary Draft v0.1, pending supervisor review).** Detailed API signatures and sequence diagrams explicitly deferred. |

### 2.5 `docs/OpenQuestions.md`

| Attribute         | Value                                                              |
| ----------------- | ----------------------------------------------------------------- |
| Deliverable name  | Open Questions register                                            |
| Purpose           | Track every decision that must be confirmed by a stakeholder before implementation can safely go live, with explicit ownership and impact mapping. |
| Summary of contents | 15 questions (Q-01 … Q-15) covering source sheet, status values, subfolder propagation, write-back column, grace period / schedule, exception allowlist, notification recipients, group vs. direct share, script owner, log retention, no-permission-found behaviour, local `.xlsx` hygiene, regulatory constraints, re-grant support, and test-link / resume scope. Each carries `Context`, `Question`, `Impact`, `Owner`, `Decision`, `Status`. |
| Completion status | **Done as a register (Draft v0.1). All 15 questions are still `Open` in the document, although a subset has been verbally confirmed by the supervisor — see Section 6.** |

### 2.6 `docs/DataDictionary.md`

| Attribute         | Value                                                              |
| ----------------- | ----------------------------------------------------------------- |
| Deliverable name  | Data Dictionary & Spreadsheet Mapping                             |
| Purpose           | Provide an implementation-ready specification of every column the pipeline reads, its data type, validation rule, and the JSON contract returned by the sheet reader. |
| Summary of contents | Per-column dictionary for all 15 columns of `Timeline` (A … O); spreadsheet-to-internal-field mapping; sample JSON structures for valid and invalid records; full validation specification including required fields, invalid-value table, missing-folder / invalid-email / invalid-date handling, controlled-vocabulary error codes (`INVALID_*`), execution-time outcome codes (`REVOKED`, `ALREADY_REVOKED`, …), whitespace / case normalisation, and row-level skip rules. |
| Completion status | **Done (Draft v0.1).** Implementation-ready; only secondary behaviours gated on Q-04 / Q-05 / Q-06 remain. |

### 2.7 `src/config.gs`

| Attribute         | Value                                                              |
| ----------------- | ----------------------------------------------------------------- |
| Deliverable name  | Centralised configuration constants                               |
| Purpose           | Single source of truth for every tunable parameter; operators change behaviour by editing this file only. |
| Summary of contents | 10 sections: workbook identity (`SPREADSHEET_ID`); sheet names (`SOURCE_SHEET_NAME`, `LOG_SHEET_NAME`); column mapping for all 15 columns with `header` / `column` / `required`; status enums (`STATUS_OFFBOARDED`, `STATUS_ACTIVE`, allowed workmodes, tracking statuses, email statuses); validation constants (`EMAIL_REGEX`, `FOLDER_URL_PREFIX`, `FOLDER_URL_REGEX`); date handling (`SCRIPT_TIMEZONE`, `DATE_FORMAT_ISO`, `TEXT_DATE_FORMATS`); controlled-vocabulary error codes (`ERROR_CODES`); eligibility enum (`ELIGIBILITY`); operational parameters (`GRACE_PERIOD_DAYS = 0`, `DRY_RUN = true`, `EXCEPTION_EMAILS = []`, `NOTIFICATION_RECIPIENTS = []`); trigger schedule constants (`TRIGGER_HOUR = 2`, `TRIGGER_MINUTE = 0`). |
| Completion status | **Done.** Ready for use by other modules. |

### 2.8 `src/sheetService.gs` (read path)

| Attribute         | Value                                                              |
| ----------------- | ----------------------------------------------------------------- |
| Deliverable name  | Sheet reader: `Timeline` → typed `InternRecord[]`                 |
| Purpose           | Sole owner of read access to the production workbook; translate raw rows into typed, validated records per `docs/DataDictionary.md`. |
| Summary of contents | `readInternRecords()` and `getEligibleCandidates()` public API; internal helpers for sheet access, column-index building (with required-header enforcement), row-to-record mapping, typed cell readers (text, email, date, enum, status, folder link), eligibility computation (`_computeEligibility_`), exception-user check, end-date-vs-grace-period check, run-summary builder, ISO / text date parsers, and blank-row / blank-value detection. |
| Completion status | **Read path: Done. Write-back path (writeRevocationStatus, appendLogEntries): Not started.** The write-back entry points are declared in `docs/SystemDesign.md` §2.2 and `docs/ProjectStructure.md` §3.2 but not yet implemented. |

### 2.9 `src/driveService.gs`

| Attribute         | Value                                                              |
| ----------------- | ----------------------------------------------------------------- |
| Deliverable name  | Drive permission revocation wrapper                               |
| Purpose           | Sole owner of all Drive permission mutations; enforce exception allowlist; bounded retry on transient errors; idempotent. |
| Summary of contents | `revokeAccess(folderUrlOrId, internEmail, opts)`, `listPermissions(folderUrlOrId)`, `isExceptionUser(email)` public API; tunable retry constants (`DRIVE_MAX_RETRIES = 3`, `DRIVE_RETRY_BASE_MS = 500`, `DRIVE_FOLDER_ID_MIN_LENGTH = 8`); internal helpers for folder-ID resolution, email canonicalisation, Drive calls with exponential-back-off retry (`_openFolderWithRetry_`, `_listWithRetry_`, `_removeWithRetry_`, `_withRetry_`), user-by-email matching, `RevocationResult` construction, idempotent "no permission found" handling (with `ALREADY_REVOKED_PROVISIONED` escalation when `trackingStatus` was `Access Shared`), and error classification (access errors vs. transient errors). Returns the full outcome-code vocabulary from `docs/DataDictionary.md` §4.7. |
| Completion status | **Done.** Covers all Direct-Share, main-folder-only behaviour per the confirmed assumptions. Does not implement Google Group membership or recursive subfolder walks (both out of scope). |

### 2.10 `src/logService.gs`

| Attribute         | Value                                                              |
| ----------------- | ----------------------------------------------------------------- |
| Deliverable name  | Structured execution logging                                      |
| Purpose           | Persist one row per intern processed plus one summary row per run; batch writes to respect Sheets API quota. |
| Summary of contents | File-level header docstring only. Public API (`startRun`, `recordInternResult`, `endRun`, `flush`) and dependencies are documented as expected, but **no business logic is implemented**. |
| Completion status | **Placeholder.** |

### 2.11 `src/triggerService.gs`

| Attribute         | Value                                                              |
| ----------------- | ----------------------------------------------------------------- |
| Deliverable name  | Time-driven trigger management                                    |
| Purpose           | Install / uninstall / identify the daily trigger; expose the `onScheduledRun` entry point that delegates to `main.gs`. |
| Summary of contents | File-level header docstring only. Public API (`installTrigger`, `uninstallTrigger`, `onScheduledRun`) is documented but **no business logic is implemented**. |
| Completion status | **Placeholder.** |

### 2.12 `src/main.gs`

| Attribute         | Value                                                              |
| ----------------- | ----------------------------------------------------------------- |
| Deliverable name  | Pipeline orchestrator                                             |
| Purpose           | Compose services into a single coherent pipeline: read → filter → revoke → write back → log; centralise per-intern error handling; honour the dry-run flag. |
| Summary of contents | File-level header docstring only. Public API (`runRevocationPipeline`, `runRevocationPipelineDry`) is documented but **no business logic is implemented**. |
| Completion status | **Placeholder.** |

---

## 3. Spreadsheet Analysis Summary

The analysis below is drawn from direct inspection of
`Internship Application.xlsx`, documented in `docs/Requirement.md`
§5.1 and `docs/DataDictionary.md`.

### 3.1 Sheets discovered

| Sheet          | Dedicated `FOLDER LINK` col?         | Has `INTERNSHIP STATUS` col? | Date format     | Approx. data rows   |
| -------------- | ------------------------------------ | ---------------------------- | --------------- | ------------------- |
| `Intern list`  | No (`DOCUMENT LINK`, plus other Drive links in `TEST LINK`, `RESUME`) | No                           | Text / ranges   | ~3,000+ applicants  |
| `Timeline`     | Yes                                  | Yes                          | Native datetime | ~58 active records  |
| `Dashboard`    | Yes                                  | Yes                          | Native datetime | ~58 (mirror of Timeline) |
| `Result`       | Partial (`DOCUMENT LINK` only)       | No (has `STATUS(RESULT)` = Pass/Fail) | Native datetime | ~978                |
| `Requirement`  | Position catalog (reference data, not consumed by the pipeline) | — | — | — |
| `Supervisor`   | Supervisor directory (may feed `EXCEPTION_EMAILS`, see Q-06) | — | — | — |

### 3.2 Recommended source sheet

**`Timeline`** — confirmed by the project supervisor (see `docs/DataDictionary.md` confirmed-assumptions table) and reflected in `config.gs` (`SOURCE_SHEET_NAME = 'Timeline'`).

Rationale:

- Native Google Sheets datetime values in `START` (D) and `END` (E) — minimises parsing risk (R-03).
- Single dedicated `FOLDER LINK` (L) column.
- Dedicated `INTERNSHIP STATUS` (K) column with a clean enum (`Completed`, `Interning`, `Pending`, `Withdraw`).
- Approximately 58 active records — well within the Apps Script 6-minute execution limit (NFR-P1).

### 3.3 Important columns

| Column | Header              | Required | Role in pipeline |
| ------ | ------------------- | -------- | ---------------- |
| B      | `NAME`              | Yes      | Audit-log identifier. |
| E      | `END`               | Yes      | Drives eligibility (`endDate < today - GRACE_PERIOD_DAYS`). |
| H      | `EMAIL`             | Yes      | Identity used to match the Drive permission under Direct Share. |
| K      | `INTERNSHIP STATUS` | Yes      | Gates eligibility (`Completed` / `Withdraw` ⇒ offboarded). |
| L      | `FOLDER LINK`       | Yes      | Target of the revocation (resolved to a folder ID). |
| N      | `TRACKING STATUS`   | No       | Soft hint; `Access Shared` escalates "no permission found" to `ALREADY_REVOKED_PROVISIONED`. |
| D      | `START`             | No       | Audit context only. |
| A, C, F, G, I, J, M, O | Various       | No       | Audit / log enrichment only. |

### 3.4 Data quality findings

- **Missing folder link.** ~2 of 58 rows on `Timeline` have an empty `FOLDER LINK` cell. The pipeline handles this with `INVALID_MISSING_FOLDER` and excludes the row from the candidate set.
- **Multilingual content.** `NAME`, `POSITION`, `UNIVERSITY` mix English and Thai text. Readers coerce all cells to trimmed strings; no language-specific logic required.
- **Mixed phone formats.** `TEL` (F) and `LINE` (G) contain both string (`'062-318-9418'`) and numeric (`981054073.0`) values. Readers coerce both to string and do not validate format.
- **Mixed date formats between sheets.** `Timeline` uses native datetime; `Intern list` uses text / ranges (e.g. `"05/01/2026 - 10/04/2026"`). The reader accepts native Date, ISO `YYYY-MM-DD`, and `"MMM d, yyyy"`; ambiguous `DD/MM/YYYY` forms are rejected (R-03 mitigation).
- **Two URL forms in the wild.** `https://drive.google.com/drive/folders/{id}` (accepted) and `https://drive.google.com/open?id={id}` (rejected as ambiguous, logged with `INVALID_FOLDER_URL_FORMAT`).
- **No anonymous / header-only rows.** Header row is row 1; fully blank rows are silently skipped per `docs/DataDictionary.md` §4.9.

### 3.5 Risks identified

The full risk register lives in `docs/Requirement.md` §7 (R-01 … R-12). The most operationally consequential are:

- **R-01 (High / Medium).** Wrong source sheet selected ⇒ access revoked for active interns. Mitigated by confirmed assumption `Timeline` and by `DRY_RUN = true` as the shipped default.
- **R-02 (High / Medium).** Email mismatch (personal vs. university account). Mitigated by `ALREADY_REVOKED_PROVISIONED` escalation when `TRACKING STATUS = Access Shared` but no permission is found.
- **R-03 (High / Low).** Date parsing swaps day and month. Mitigated by the strict date parser that rejects ambiguous forms.
- **R-04 (High / Medium).** Subfolders / files retain access after parent is revoked. Mitigated by the confirmed assumption "Main folder only" pending Q-03 confirmation.
- **R-07 (Medium / Medium).** Schema drift (column rename / reorder). Mitigated by centralised `COLUMN_MAPPING` and the `_buildColumnIndex_` required-header check.

---

## 4. Remaining Work

### 4.1 Documentation Tasks

| ID  | Description                                                                          | Priority | Dependency                                            | Effort   |
| --- | ------------------------------------------------------------------------------------ | -------- | ----------------------------------------------------- | -------- |
| D-1 | Reconcile `OpenQuestions.md` with the supervisor-confirmed assumptions (move Q-01, Q-02, Q-03, Q-07, Q-08 from `Open` to `Confirmed`). | High     | None — content is already known.                      | 0.5 day  |
| D-2 | Collect sign-off on `Requirement.md` and `OpenQuestions.md` from the four named roles. | High     | Stakeholder review meeting.                           | 1–2 days (elapsed; ~0.5 day active) |
| D-3 | Write `docs/UserManual.md` — operator runbook: install / uninstall trigger, change config, read the log sheet, react to common failure codes. | Medium   | Implementation of `main.gs`, `triggerService.gs`.     | 1 day    |
| D-4 | Write `docs/DeveloperDocumentation.md` — local setup, clasp linkage, test approach, contribution guide, requirement-to-function traceability (NFR-M4). | Medium   | Implementation complete; clasp decision (D-9).        | 1 day    |
| D-5 | Update `docs/SystemDesign.md` to remove the "Preliminary" caveat and add detailed API signatures + sequence diagrams. | Low      | All open questions resolved.                          | 1 day    |
| D-6 | Decide on the fate of the local `Internship Application.xlsx` (Q-12: keep, move to `samples/`, or delete). | Low      | Supervisor decision.                                  | 0.25 day |

### 4.2 Development Tasks

| ID  | Description                                                                          | Priority | Dependency                                            | Effort    |
| --- | ------------------------------------------------------------------------------------ | -------- | ----------------------------------------------------- | --------- |
| Dev-1 | Implement `logService.gs`: `startRun()`, `recordInternResult(entry)`, `endRun(summary)`, `flush()`. Create `LOG_SHEET_NAME` lazily with the documented headers. Buffer rows in memory and flush once per run (NFR-R3). | High     | `config.gs` (done).                                   | 1.5 days  |
| Dev-2 | Implement `sheetService.writeRevocationStatus(rows)` — sparse write-back of the per-intern status column. Pending Q-04 stakeholder approval; if denied, fall back to log-only idempotency. | High     | Q-04 decision.                                        | 0.5–1 day |
| Dev-3 | Implement `sheetService.appendLogEntries(entries)` — batched append to the log sheet, delegating schema to `logService`. | High     | `logService.gs` (Dev-1).                              | 0.5 day   |
| Dev-4 | Implement `main.gs`: `runRevocationPipeline()` and `runRevocationPipelineDry()`. Compose the services in the order documented in `docs/SystemDesign.md` §3. Wrap per-intern calls in try/catch (FR-08 Layer 1). Honour `DRY_RUN`. | High     | All services implemented.                             | 1.5 days  |
| Dev-5 | Implement `triggerService.gs`: `installTrigger()` with duplicate-guard, `uninstallTrigger()`, and `onScheduledRun()` delegating to `main.runRevocationPipeline()`. Use `TRIGGER_HOUR` / `TRIGGER_MINUTE` / `SCRIPT_TIMEZONE`. | High     | `main.gs` (Dev-4).                                    | 0.5 day   |
| Dev-6 | Create `appsscript.json` manifest with the three required OAuth scopes (`spreadsheets`, `drive`, `script.send_mail` — the last only if notifications are re-enabled). | Medium   | clasp / Apps Script IDE project link.                 | 0.25 day  |
| Dev-7 | Link the project via clasp (recommended) or paste-in; record the chosen path in `docs/ProjectStructure.md` §5. | Medium   | Q-09 script-owner decision.                           | 0.5 day   |
| Dev-8 | Populate `EXCEPTION_EMAILS` in `config.gs` with the supervisor / IT allowlist once Q-06 is resolved. | High     | Q-06 decision.                                        | 0.25 day  |
| Dev-9 | If Q-07 re-enables notifications, populate `NOTIFICATION_RECIPIENTS` and add a `mailService` (or inline) send step in `main.gs`. Currently empty by confirmed assumption. | Low      | Q-07 decision.                                        | 0.5 day   |

### 4.3 Testing Tasks

| ID  | Description                                                                          | Priority | Dependency                                            | Effort   |
| --- | ------------------------------------------------------------------------------------ | -------- | ----------------------------------------------------- | -------- |
| T-1 | Unit tests for `sheetService` typed readers: every error code in `ERROR_CODES` is reproducible from a synthetic row; locale-independent date parsing; required-header enforcement throws clearly. | High     | `sheetService.gs` (done).                             | 1 day    |
| T-2 | Unit tests for `driveService`: outcome codes `REVOKED`, `ALREADY_REVOKED`, `ALREADY_REVOKED_PROVISIONED`, `SKIPPED_EXCEPTION_USER`, `DRY_RUN`, `FOLDER_NOT_ACCESSIBLE`, `DRIVE_API_ERROR`. Use a test workbook with throwaway folders and test accounts. | High     | `driveService.gs` (done); test fixture accounts.      | 1 day    |
| T-3 | Integration test for the dry-run path: `runRevocationPipelineDry()` produces complete logs and mutates no Drive permissions. | High     | Dev-1, Dev-3, Dev-4.                                  | 0.5 day  |
| T-4 | Idempotency test: running the pipeline twice on the same snapshot produces no duplicate `REVOKED` rows. | Medium   | Dev-2 (or Q-04 fallback) and Dev-4.                   | 0.5 day  |
| T-5 | Performance sanity check: a dry run against the live `Timeline` snapshot completes within the 6-minute Apps Script budget (NFR-P1). | Medium   | Project linked to Apps Script (Dev-7).                | 0.25 day |
| T-6 | Failure-injection test: simulate a Drive API 429 / 5xx and confirm bounded retry + correct outcome code. | Low      | `driveService.gs` (done).                             | 0.5 day  |

> **Note on Apps Script testing:** Apps Script has no first-party
> unit-test runner. The pragmatic approach is either (a) a separate
> `test/` sheet that drives `Assert`-style helpers, or (b) a small
> Node + clasp setup using `gas-test` / `gas-local`. The chosen
> approach should be recorded in `docs/DeveloperDocumentation.md`
> (D-4).

### 4.4 Deployment / Configuration Tasks

| ID  | Description                                                                          | Priority | Dependency                                            | Effort   |
| --- | ------------------------------------------------------------------------------------ | -------- | ----------------------------------------------------- | -------- |
| C-1 | Create or designate the script-owner account (recommended: a dedicated functional account per Q-09). Grant it Editor access to every intern folder. | High     | Q-09 decision; IT provisioning.                       | 1–2 days elapsed |
| C-2 | Create the Apps Script project bound to the production spreadsheet; push `src/*.gs` via clasp. | High     | C-1, Dev-7.                                           | 0.5 day  |
| C-3 | Authorise the script's OAuth scopes from the script-owner account; confirm the scopes in `appsscript.json` match NFR-S1 (least privilege). | High     | C-2.                                                  | 0.25 day |
| C-4 | Run a dry-run invocation from the Apps Script IDE; inspect the log sheet; verify counts and outcome codes. | High     | C-3, T-3.                                             | 0.5 day  |
| C-5 | Populate `EXCEPTION_EMAILS` and (if enabled) `NOTIFICATION_RECIPIENTS` in the production `config.gs`. | High     | Q-06, Q-07.                                           | 0.25 day |
| C-6 | Set production `DRY_RUN = false` only after two consecutive dry runs produce the expected candidate set. | High     | C-4.                                                  | 0.25 day |
| C-7 | Install the time-driven trigger via `triggerService.installTrigger()`; verify the first scheduled invocation fires and produces a run-summary row. | High     | Dev-5, C-6.                                           | 0.5 day  |
| C-8 | Communicate the go-live to HR / IT; document the support contact and the rollback procedure (uninstall trigger + set `DRY_RUN = true`). | Medium   | C-7.                                                  | 0.25 day |

---

## 5. Development Progress

The estimates below are calculated against the scope defined in
`docs/Requirement.md` and `docs/SystemDesign.md`. Each phase is
weighted by its share of overall effort.

| Phase                    | Estimated completion | Rationale |
| ------------------------ | --------------------- | --------- |
| Requirement Phase        | **90%**               | `Requirement.md` is draft-complete with FRs, NFRs, data model, assumptions, risks, and sign-off block. The remaining 10% is stakeholder sign-off and reconciliation with `OpenQuestions.md`. |
| Design Phase             | **80%**               | `SystemDesign.md` covers architecture, components, workflow, data flow, and cross-cutting concerns at a preliminary level. The remaining 20% is detailed API signatures, sequence diagrams, and removal of the "Preliminary" caveat — all gated on open-question resolution. |
| Development Phase        | **45%**               | Three of six source modules (`config.gs`, `sheetService.gs` read path, `driveService.gs`) are complete and self-consistent. Three modules (`logService.gs`, `main.gs`, `triggerService.gs`) are header-only stubs, and the sheet write-back path is unimplemented. |
| Testing Phase            | **0%**                | No tests have been written; the testing approach itself is not yet chosen (see note under §4.3). |
| Documentation Phase      | **60%**               | Core engineering docs (Project Structure, Requirement, System Design, Open Questions, Data Dictionary) are draft-complete. The operator manual and developer guide are deferred to later phases per `docs/ProjectStructure.md`. |

### Overall project completion

**Approximately 50%.**

The project is **documentation-heavy by design** — the supervisor
review cycle is the next gating event. Implementation is roughly
half-finished, with the read path and the Drive mutation path done
and the orchestration / logging / scheduling / write-back path still
to build.

---

## 6. Open Questions Requiring Confirmation

All 15 questions in `docs/OpenQuestions.md` are recorded as `Open`.
However, **five of them have been verbally confirmed by the project
supervisor** and are reflected in `docs/DataDictionary.md`'s
confirmed-assumptions table and in `config.gs`. The documentation
itself is therefore inconsistent and must be reconciled (task D-1
above).

### 6.1 Questions that are effectively decided (need paperwork only)

| ID  | Topic                                  | Confirmed answer                 | Impact on implementation |
| --- | -------------------------------------- | -------------------------------- | ------------------------ |
| Q-01 | Source sheet                           | `Timeline`                       | Drives column mapping in `config.gs` (already set). |
| Q-02 | Status values that trigger revocation  | `Completed`, `Withdraw`          | Encoded in `STATUS_OFFBOARDED` (already set). |
| Q-03 | Subfolder / file propagation           | Parent-only                      | `driveService.gs` already main-folder-only. |
| Q-07 | Notification recipients                | None (no email notifications)    | `NOTIFICATION_RECIPIENTS = []` and no MailApp call. |
| Q-08 | Direct share vs. Google Group          | Direct Share                     | `driveService.gs` uses `removeEditor` / `removeViewer` (already implemented). |

### 6.2 Questions that are genuinely open and block production go-live

| ID  | Topic                                  | Owner                            | Affects implementation |
| --- | -------------------------------------- | -------------------------------- | ---------------------- |
| Q-04 | Write-back status column on `Timeline` | Internship Program Lead          | Whether `sheetService.writeRevocationStatus(rows)` is built (Dev-2) and whether `eligibility = INELIGIBLE_ALREADY` is ever produced by the reader. **Recommendation: approve; idempotency and operator visibility both depend on it.** |
| Q-05 | Grace period length + trigger schedule | Internship Program Lead / IT     | The boundary between `ELIGIBLE` and `INELIGIBLE_NOT_ENDED`. `GRACE_PERIOD_DAYS = 0` is the current default; confirm or override. Trigger time is `02:00 Asia/Bangkok` (`TRIGGER_HOUR = 2`). |
| Q-06 | Exception allowlist contents           | Internship Program Lead / IT     | Whether `EXCEPTION_EMAILS` is hand-curated or read dynamically from the `Supervisor` sheet. Until resolved, `EXCEPTION_EMAILS = []` and the safety net (NFR-S2) is inactive. **This is the single biggest safety gap before go-live.** |
| Q-09 | Script / trigger owner account         | IT / Security reviewer           | Whether a personal supervisor account or a dedicated functional account owns the script. Affects provisioning lead time (C-1) and resilience to staff changes (R-05). |
| Q-10 | Log retention policy                   | Internship Program Lead / IT     | Whether rows are archived at 12 months or another threshold (R-09). Does not block initial go-live but should be set before the log sheet reaches ~1,000 rows. |
| Q-11 | "No permission found" behaviour        | IT / Security reviewer           | Confirms the `ALREADY_REVOKED` vs. `ALREADY_REVOKED_PROVISIONED` distinction. Already implemented per `docs/DataDictionary.md` §4.7; needs stakeholder awareness. |
| Q-12 | Local `.xlsx` in repo                  | Project supervisor               | Repository hygiene only; no runtime impact. |
| Q-13 | Regulatory / data-residency constraints | Legal / compliance or supervisor | Affects log-sheet location, retention, and whether interns must be notified. |
| Q-14 | Re-grant support                       | Internship Program Lead / IT     | Confirms the revocation-only scope. Recommended: keep re-grant manual. |
| Q-15 | Test-link / resume file scope          | Internship Program Lead / HR     | Confirms folder-only scope. Recommended: folder-only for initial release. |

### 6.3 Most consequential open questions

- **Q-06** (exception allowlist). Without it, the system has no
  safety net against accidentally revoking a supervisor or IT admin.
- **Q-04** (write-back column). Without it, idempotency relies on
  log-sheet inspection only, which is more fragile and slower.
- **Q-09** (script owner). Without a named owner account, the
  trigger-ownership hand-off is undefined and the project cannot be
  deployed.

---

## 7. Recommended Next Steps

A prioritised action plan for the next 3–5 working days. The plan
front-loads safety (Q-06) and consistency (D-1), then unblocks the
remaining implementation work in parallel with stakeholder
sign-off.

### Day 1 — Reconcile docs and unblock safety

1. **D-1 (0.5 day).** Update `OpenQuestions.md`: move Q-01, Q-02,
   Q-03, Q-07, Q-08 to `Confirmed` with the supervisor's decision
   recorded and the date.
2. **D-2 (kickoff).** Send `Requirement.md`, `SystemDesign.md`,
   `DataDictionary.md`, and the updated `OpenQuestions.md` to the four
   named sign-off roles. Calendar a review meeting for Day 3.
3. **Q-06 (0.25 day).** Request the supervisor / IT allowlist
   explicitly. Even in draft form, this lets `EXCEPTION_EMAILS` be
   populated for the upcoming dry runs.

### Day 2 — Build the logging backbone

4. **Dev-1 (1.5 days, started Day 2).** Implement `logService.gs` per
   `docs/SystemDesign.md` §2.4 and `docs/Requirement.md` FR-06.
   Create `LOG_SHEET_NAME` lazily with the headers defined by
   `docs/DataDictionary.md` §4.7 (controlled vocabulary).

### Day 3 — Build the write-back path and the orchestrator

5. **Dev-3 (0.5 day).** Implement `sheetService.appendLogEntries()`
   once `logService` is in place.
6. **Dev-2 (0.5–1 day, conditional).** If Q-04 is approved (expected),
   implement `sheetService.writeRevocationStatus(rows)`. If Q-04 is
   denied, document the log-only idempotency fallback in
   `SystemDesign.md` §5.2 instead.
7. **Dev-4 (1.5 days, started Day 3).** Implement `main.gs`. Compose
   the services in the order documented in `docs/SystemDesign.md` §3.
   Add the per-intern try/catch (FR-08 Layer 1).

### Day 4 — Trigger, manifest, and first local integration test

8. **Dev-5 (0.5 day).** Implement `triggerService.gs` with the
   duplicate-install guard.
9. **Dev-6 + Dev-7 (0.75 day).** Create `appsscript.json` and link the
   project via clasp.
10. **T-1 + T-2 (parallel, 1 day each).** Start unit-test construction
    for `sheetService` and `driveService`. These can run concurrently
    with Dev-4 / Dev-5 because the modules under test are already
    complete.

### Day 5 — Dry run against production data

11. **C-4 (0.5 day).** Authorise scopes from the script-owner
    account, run `runRevocationPipelineDry()` from the Apps Script IDE,
    and inspect the log sheet. Verify the candidate set, the
    `DRY_RUN` outcome codes, and the summary counts.
12. **T-3 (0.5 day).** Convert the Day-5 dry run into a repeatable
    integration test.

**Out of scope for this 5-day window** (but scheduled next):

- Stakeholder sign-off meeting outcome and follow-ups (D-2).
- `docs/UserManual.md` and `docs/DeveloperDocumentation.md` (D-3,
  D-4).
- Production `DRY_RUN = false` switch (C-6) and trigger installation
  (C-7).
- Performance sanity check (T-5), failure-injection test (T-6).

---

## 8. Project Readiness Assessment

### 8.1 What can be implemented immediately

The following work requires **no further stakeholder input** and can
start today:

- `logService.gs` (Dev-1) — public API and schema are fully specified
  in `docs/SystemDesign.md` §2.4 and `docs/DataDictionary.md` §4.7.
- `sheetService.appendLogEntries()` (Dev-3) — depends only on Dev-1.
- `main.gs` dry-run path (Dev-4) — orchestration order is documented
  in `docs/SystemDesign.md` §3; `DRY_RUN = true` is already the
  shipped default.
- `triggerService.gs` (Dev-5) — `TRIGGER_HOUR`, `TRIGGER_MINUTE`,
  `SCRIPT_TIMEZONE` are already defined.
- Unit tests for `sheetService` and `driveService` (T-1, T-2) — both
  modules are complete and self-contained.

### 8.2 What is blocked pending stakeholder feedback

| Blocker | Blocks | Workaround if deferred |
| ------- | ------ | ---------------------- |
| Q-04 (write-back column) | Dev-2 (`sheetService.writeRevocationStatus`). | Fall back to log-only idempotency; document in `SystemDesign.md` §5.2. |
| Q-06 (exception allowlist) | Safe production go-live (C-6). The pipeline will still run in dry-run mode without it. | Ship with `EXCEPTION_EMAILS = []` but keep `DRY_RUN = true` until populated. |
| Q-09 (script-owner account) | Deployment (C-1, C-2, C-3). | Use a supervisor's personal account for the first dry runs only; never go live without the long-term owner decision. |
| Q-05 (grace period + schedule) | Final tuning of `GRACE_PERIOD_DAYS` and `TRIGGER_HOUR` / `TRIGGER_MINUTE`. | Ship with the recommended defaults (0 days; 02:00 ICT); adjust after first month of operation. |
| Sign-off on `Requirement.md` | Go-live (C-6). | Continue development against the current draft; treat any post-sign-off change as a change request. |

### 8.3 Risks to timeline

- **Stakeholder availability.** Sign-off requires four roles
  (Internship Program Lead, HR Manager, IT / Security reviewer,
  Project supervisor). Scheduling the review meeting is the largest
  non-engineering critical path.
- **Provisioning lead time.** Creating a dedicated functional account
  (Q-09) and granting it Editor access to every intern folder may
  take longer than the engineering work itself. Start the IT request
  on Day 1.
- **Apps Script testing approach.** No first-party test runner means
  the testing approach must be chosen and proved (T-1) before the
  team can rely on it. Allow a half-day spike on Day 2 if the
  preferred toolchain does not work out.
- **Data drift on `Timeline`.** The schema is stable today, but a
  column rename / reorder during the build window would force a
  `COLUMN_MAPPING` update and a re-run of T-1. The
  `_buildColumnIndex_` required-header check makes this fail loudly,
  not silently (R-07 mitigation), but it still costs time.
- **Drive permission model edge cases.** Direct Share is confirmed,
  but if a single intern folder turns out to have been shared via a
  Google Group, `removeEditor` / `removeViewer` will report
  `ALREADY_REVOKED_PROVISIONED` and the operator will need to
  investigate manually. This is handled correctly by the code but
  may surface as operational noise.

### 8.4 Recommended go-forward approach

1. **Treat the supervisor-confirmed assumptions as binding.** Lock
   `Timeline`, Direct Share, main-folder-only, no notifications, and
   daily trigger into the documentation today (D-1). These are
   already encoded in `config.gs`; making the docs match the code
   removes the largest source of confusion for new reviewers.
2. **Build inside-out.** Continue from the already-implemented
   leaves (`sheetService` read, `driveService`) inward to
   `logService` → `main` → `triggerService`. Each layer depends only
   on the previous one, so integration risk stays low.
3. **Run dry, then run damp, then run live.** Plan three gated
   milestones:
   - **Dry** (`DRY_RUN = true`): end of Day 5 (C-4). No Drive
     mutation; verify candidate set and logs.
   - **Damp** (still `DRY_RUN = true`, but `EXCEPTION_EMAILS`
     populated and Q-04 / Q-05 / Q-06 resolved): within ~5 working
     days of sign-off. Re-verify nothing changes.
   - **Live** (`DRY_RUN = false`, trigger installed): only after two
     consecutive dry / damp runs produce the expected candidate set.
4. **Keep the safety nets on by default.** `DRY_RUN = true` and an
   empty `EXCEPTION_EMAILS` are the correct shipped defaults.
   Switch each off only as part of a deliberate, recorded change
   with stakeholder sign-off — never as an incidental edit.
5. **Write the operator manual before the trigger is installed
   (C-7).** The person who will run the system in steady state must
   be able to (a) read the log sheet, (b) recognise the common
   `INVALID_*` and outcome codes, and (c) uninstall the trigger in
   an emergency. `docs/UserManual.md` (D-3) is the artifact for
   this; do not skip it to save a day.

---

## Appendix — Document cross-reference

| Cross-reference question | Answer |
| ------------------------ | ------ |
| Where is the source-of-truth sheet documented? | `docs/DataDictionary.md` §1, §2; `config.gs` §2. |
| Where are the controlled-vocabulary error codes defined? | `docs/DataDictionary.md` §4.6, §4.7; `config.gs` §7; emitted by `sheetService.gs` and `driveService.gs`. |
| Where is the eligibility rule encoded? | `docs/DataDictionary.md` §3.4, §4; implemented in `sheetService._computeEligibility_`. |
| Where is the retry policy tuned? | `docs/Requirement.md` NFR-R2; implemented in `driveService._withRetry_`. Constants in `driveService.gs` (`DRIVE_MAX_RETRIES`, `DRIVE_RETRY_BASE_MS`). |
| Where is the dry-run flag honoured? | `docs/Requirement.md` FR-09; `config.gs` `DRY_RUN`; `driveService.revokeAccess` (and, when implemented, `main.runRevocationPipelineDry`). |
| Where are open questions tracked? | `docs/OpenQuestions.md` (controlling list); summarised in `docs/Requirement.md` §8. |
