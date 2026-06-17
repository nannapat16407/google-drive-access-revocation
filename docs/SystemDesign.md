# System Design

**Project:** Automated Google Drive Access Revocation for Internship Offboarding
**Document type:** Preliminary System Design
**Status:** Draft v0.1 — pending supervisor review
**Last updated:** 2026-06-16

> This document is **preliminary**. It captures architectural intent and
> component responsibilities at a level sufficient for stakeholder
> review. Detailed API signatures, data contracts, and sequence
> diagrams will be produced in the next phase, after the open
> questions in `OpenQuestions.md` are resolved.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [System Components](#2-system-components)
3. [High-Level Workflow](#3-high-level-workflow)
4. [Data Flow](#4-data-flow)
5. [Cross-Cutting Concerns](#5-cross-cutting-concerns)
6. [Future Enhancements](#6-future-enhancements)

---

## 1. Architecture Overview

The system is a single Google Apps Script project bound to the
production spreadsheet. It runs entirely inside Google's scripting
runtime; there is no external server, no database, and no third-party
service. All integration is via Google's first-party services
(Sheets, Drive, Mail).

```
+--------------------------+      +----------------------------+
|  Google Sheets workbook  |      |   Google Drive             |
|  (Internship Application)|      |   (per-intern folders)     |
|                          |      |                            |
|  - Intern list           |      |  /intern-A/   (editor: A)  |
|  - Timeline              |      |  /intern-B/   (editor: B)  |
|  - Result / Dashboard    |      |  /intern-C/   (editor: C)  |
|  - Log sheet (output)    |      |        ...                 |
+-----------+--------------+      +-------------^--------------+
            |                                   |
            | read                              | revoke
            v                                   |
+-----------------------+        +---------------------------+
|   sheetService.gs     |        |     driveService.gs       |
|   (read + write-back) |        |     (permission removal)  |
+-----------+-----------+        +-------------^-------------+
            |                                  |
            |       intern records             |  per-intern
            |       + candidates               |  revocation calls
            v                                  |
+-------------------------------------------------------+
|                     main.gs                           |
|   (pipeline orchestrator: filter, dispatch, report)   |
+---+------------------------+----------------------+---+
    |                        |                      |
    v                        v                      v
+-----------------+   +----------------+   +-----------------+
|  config.gs      |   | logService.gs  |   | triggerService  |
|  (constants)    |   | (audit log)    |   | .gs (schedule)  |
+-----------------+   +----------------+   +--------+--------+
                                                    |
                                                    | scheduled invocation
                                                    v
                                          +-------------------+
                                          | Time-driven       |
                                          | trigger (Apps     |
                                          | Script runtime)   |
                                          +-------------------+
                                                    |
                                                    | run summary
                                                    v
                                          +-------------------+
                                          | Mail / notify     |
                                          | recipients        |
                                          +-------------------+
```

**Conceptual flow.**

```
Google Sheets  ->  Google Apps Script  ->  Google Drive
                                              permission management
                                            |
                                            v
                                          Logging  ->  Mail (summary)
```

---

## 2. System Components

### 2.1 Main Controller — `main.gs`

**Role.** Orchestrates a single run end-to-end. This is the only
module that knows the order of operations.

**Responsibilities.**

1. Initialise a run context (run ID, started-at timestamp, dry-run
   flag) via `logService.startRun()`.
2. Read all intern records via `sheetService.readInternRecords()`.
3. Apply the candidate filter (FR-03) to produce the candidate list.
4. For each candidate, call `driveService.revokeAccess()`.
5. Capture per-intern results and forward them to `logService`.
6. Write back the per-intern status via `sheetService`.
7. Emit a run summary via `logService.endRun()` and send a
   notification email.

**Error boundary.** The main controller wraps every per-intern call
in a try/catch so that a single failure cannot abort the run (NFR-R1).
Only failures that prevent the run from continuing at all (e.g.
source sheet unreachable) propagate to the trigger-level handler.

### 2.2 Sheet Service — `sheetService.gs`

**Role.** Sole owner of all read/write access to the spreadsheet.

**Responsibilities.**

- Open the source sheet by `SPREADSHEET_ID` / `SOURCE_SHEET_NAME`.
- Translate raw rows into typed `InternRecord` objects, normalising
  formatting inconsistencies (text dates, mixed link types).
- Provide the write-back entry point for the per-intern status
  column.
- Provide the append entry point for log rows.

**Why a dedicated service.** Wrapping Sheets access in one module
means a future schema change, or a switch to a different workbook,
requires edits here and in `config.gs` only.

### 2.3 Drive Service — `driveService.gs`

**Role.** Sole owner of all Drive permission mutations.

**Responsibilities.**

- Resolve a folder URL to a folder ID.
- Enumerate permissions on a folder.
- Match permission entries to the intern's email.
- Remove the matching permission, with bounded retry on transient
  errors.
- Enforce the exception allowlist (`config.EXCEPTION_EMAILS`).

**Why a dedicated service.** Centralises the OAuth scope surface
(NFR-S1) and makes the system's security-relevant behaviour easy to
audit in one place.

### 2.4 Logging Service — `logService.gs`

**Role.** Sole owner of all log writes.

**Responsibilities.**

- Allocate a run context (run ID, started-at).
- Buffer per-intern log rows in memory and flush them once per run
  (NFR-R3 quota efficiency).
- Append the per-run summary row.
- Expose a read-only "last run" view for the notification email.

**Why a dedicated service.** Batching, formatting, and retention live
in one place; future changes to the log schema (e.g. writing to a
separate workbook, or exporting to Cloud Logging) stay local.

### 2.5 Trigger Service — `triggerService.gs`

**Role.** Installs, uninstalls, and identifies the time-driven
trigger.

**Responsibilities.**

- Provide `installTrigger()` and `uninstallTrigger()` entry points.
- Guard against duplicate installations.
- Expose `onScheduledRun()` — the function the trigger calls — which
  simply delegates to `main.runRevocationPipeline()`.

**Why a dedicated service.** Trigger lifecycle is operationally
distinct from business logic; keeping it separate means operators
can manage the schedule without touching the pipeline.

### 2.6 Configuration — `config.gs`

**Role.** Holds every tunable parameter. Pure constants; no functions.

**Responsibilities.**

- Identity of the production workbook and source sheet.
- Column mapping (logical field name → column letter / header).
- Trigger schedule.
- Dry-run flag.
- Grace period.
- Exception allowlist.
- Notification recipients.
- Log sheet name.

### 2.7 Operator

A human (HR / IT) who maintains `config.gs`, installs / uninstalls
triggers, monitors run summaries, and reacts to failures.

---

## 3. High-Level Workflow

The end-to-end flow for a single scheduled run.

```
[1] Trigger fires at the configured schedule
        |
        v
[2] triggerService.onScheduledRun()
    --> main.runRevocationPipeline()
        |
        v
[3] logService.startRun()
    - allocate run ID
    - record started-at, trigger source, dry-run flag
        |
        v
[4] sheetService.readInternRecords()
    - open workbook
    - read source sheet
    - normalise each row into an InternRecord
        |
        |--- if sheet unopenable --> log abort --> notify --> end
        |
        v
[5] main: filter to candidate set (FR-03)
    - end date passed (+ grace period)
    - status in offboarded set
    - email not in exception allowlist
    - not already marked revoked
    - folder URL present and parseable
        |
        v
[6] for each candidate (with per-item try/catch):
        |
        v
    [6a] driveService.revokeAccess(folderUrl, email)
         - resolve URL -> folder ID
         - list permissions
         - find match for email
         - if DRY_RUN: log "would have revoked"
         - else: remove permission (with bounded retry)
         - if email in exception list: skip + log
        |
        v
    [6b] logService.recordInternResult(result)
        |
        v
    [6c] sheetService.writeRevocationStatus(row, 'Revoked')
        |
        +--- on error: log + continue to next candidate
        |
        v
[7] logService.endRun(summary)
    - total candidates, revoked, already-revoked,
      skipped, failed
    - ended-at, duration
        |
        v
[8] send run-summary email to NOTIFICATION_RECIPIENTS
        |
        v
[9] done
```

### Manual invocation paths

Operators can also invoke:

- `main.runRevocationPipelineDry()` — same flow as above with
  `DRY_RUN = true`, regardless of the config flag, for preview.
- `triggerService.installTrigger()` / `uninstallTrigger()` — for
  schedule management.

---

## 4. Data Flow

### 4.1 Read path (sheet → memory)

1. `sheetService.readInternRecords()` performs one `getValues()` call
   to fetch the used range of the source sheet.
2. Each row is mapped through `COLUMN_MAPPING` into a typed
   `InternRecord`:

   ```
   InternRecord {
     rowNumber:        number      // 1-based, for write-back
     name:             string
     email:            string
     startDate:        Date | null
     endDate:          Date | null
     status:           string
     folderUrl:        string
     alreadyRevoked:   boolean     // from the status column
   }
   ```

3. Records with unparseable critical fields (email, end date, folder
   URL) are retained but flagged, so the main controller can decide
   whether to log them as skipped.

### 4.2 Revocation path (memory → Drive)

For each candidate, `driveService.revokeAccess(folderUrl, email)`
returns:

```
RevocationResult {
  folderId:       string
  action:         'revoked' | 'already-revoked' | 'skipped'
                                    | 'dry-run'   | 'exception'
  outcome:        'success' | 'failure'
  errorMessage:   string | null
}
```

### 4.3 Write-back path (memory → sheet)

- One batched write per run for the status column (sparse update of
  only the rows that changed).
- One batched append per run for the log sheet.

---

## 5. Cross-Cutting Concerns

### 5.1 Error handling

Three layers, as specified in FR-08:

- **Per-intern** — caught around `driveService.revokeAccess()`,
  logged, and continued.
- **Per-run** — caught around the read / filter phases; if the source
  cannot be read, the run is aborted with a notification.
- **Trigger-level** — relies on the Apps Script runtime's failure
  notifications; supplement with explicit try/catch in
  `onScheduledRun()`.

### 5.2 Idempotency

Re-running on the same data must be safe (NFR-S5). Achieved by:

- Reading the per-intern status column before processing; skip rows
  already marked `Revoked`.
- Treating "permission not found" in Drive as success, not error.
- Including the run ID in every log row so duplicates are visible.

### 5.3 Quota management

- Sheets: batched reads (`getValues()`), batched writes
  (`setValues()` on a sparse range).
- Drive: bounded retries with exponential back-off on 429/5xx.
- Mail: at most one summary email per run.

### 5.4 Security

- Scopes declared explicitly in `appsscript.json` (to be added at
  project-link time):
  - `https://www.googleapis.com/auth/spreadsheets`
  - `https://www.googleapis.com/auth/drive`
  - `https://www.googleapis.com/auth/script.send_mail`
- Exception allowlist enforced inside `driveService`.
- The trigger is owned by a dedicated operator / service account, not
  by an intern-facing user.

### 5.5 Observability

- Run-summary email (FR-10).
- Structured log sheet (FR-06) with controlled-vocabulary reason
  fields.
- Run ID correlation across summary + per-intern rows.

---

## 6. Future Enhancements

These are explicitly **out of scope** for the initial release but
recorded here so that the architecture does not preclude them.

1. **Resume-on-failure.** Persist a checkpoint after each intern so
   an interrupted run can resume rather than restart.
2. **Beyond-6-minute runs.** For very large candidate sets, split
   work across chained invocations using a continuation token.
3. **Web dashboard.** A small Apps Script web app showing run
   history, per-intern status, and a "run now" button.
4. **Google Group support.** If interns are granted access via a
   Google Group rather than direct shares, add group-membership
   revocation as a separate code path.
5. **Onboarding automation.** Symmetric pipeline that grants access
   to new interns whose start date has arrived.
6. **Slack / LINE notification.** In addition to email, post
   summaries to the team chat.
7. **Log retention / archival.** Auto-archive log rows older than a
   threshold to a separate workbook to keep the log sheet fast.
8. **Schema-change detection.** Compare column headers against a
   known snapshot; abort and notify if they drift.
9. **Multi-tenant configuration.** Support multiple workbooks (e.g.
   different internship programs) with one deployment per workbook.
10. **Pre-flight check report.** A separate function that audits the
    workbook for missing emails, ambiguous dates, and broken folder
    URLs — producing a "data hygiene" report independent of
    revocation.

---

## 7. Open design questions

The architectural choices above are conditional on the answers to
several stakeholder questions. See [`OpenQuestions.md`](./OpenQuestions.md)
for the controlling list. The most architecturally consequential
are:

- **Q-01** (source sheet) — affects the column mapping and the amount
  of date-format normalisation required.
- **Q-03** (subfolder propagation) — affects whether `driveService`
  performs one Drive call per intern or a recursive walk.
- **Q-08** (Google Group vs. direct share) — affects whether a
  separate group-management code path is required.
