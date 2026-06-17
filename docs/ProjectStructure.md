# Project Structure

**Document type:** Setup specification
**Status:** Draft, pending supervisor review
**Last updated:** 2026-06-16

---

## 1. Overview

This document describes the recommended file and folder layout for the
**Automated Google Drive Access Revocation System**. The layout is designed
to keep business logic, configuration, services, and documentation cleanly
separated so that:

- Operators can change behaviour by editing a single configuration file.
- Each external dependency (Sheets, Drive, Triggers) is wrapped in one
  service module, so a future migration or refactor stays local.
- Reviewers and future maintainers can locate intent (docs/) and behaviour
  (src/) without grepping across the whole project.

The repository currently contains **header-only stubs** for every source
file. No business logic has been implemented yet — this is intentional and
matches the project's current phase (requirement sign-off).

---

## 2. Repository layout

```
google-drive-access-revocation/
├── README.md                       Project abstract (existing).
├── Internship Application.xlsx     Local copy of the workbook used for
│                                   analysis only. Production reads from
│                                   the live Google Sheet (see Requirement.md).
├── src/                            Google Apps Script source files (.gs).
│   ├── config.gs                   Configuration constants.
│   ├── sheetService.gs             Sheets reader / writer wrapper.
│   ├── driveService.gs             Drive permission revocation wrapper.
│   ├── logService.gs               Structured execution logging.
│   ├── triggerService.gs           Time-driven trigger management.
│   └── main.gs                     Pipeline orchestrator.
├── docs/                           Project documentation.
│   ├── ProjectStructure.md         This file.
│   ├── Requirement.md              Functional & non-functional requirements.
│   ├── SystemDesign.md             Architecture and component design.
│   ├── OpenQuestions.md            Items pending stakeholder confirmation.
│   ├── UserManual.md               Operator runbook (to be written in a
│   │                               later phase).
│   └── DeveloperDocumentation.md   Developer guide (to be written in a
│                                   later phase).
└── appsscript.json                 Apps Script manifest (created when the
                                    project is linked via clasp / Apps Script
                                    IDE; not present in the initial commit).
```

---

## 3. Source file responsibilities (`src/`)

### 3.1 `config.gs`

The **single source of truth for tunable parameters**. Every other module
reads constants from here; nothing else hard-codes IDs, schedules, or
thresholds. Keeping configuration isolated means the same code can be
pointed at a test workbook, run in dry-run mode, or have its schedule
adjusted without modifying logic.

Expected contents: spreadsheet ID, source sheet name, column mapping,
trigger schedule, dry-run flag, grace-period days, exception email list,
notification recipients, log sheet name.

### 3.2 `sheetService.gs`

**All access to the internship workbook goes through this file.** It
translates raw rows into typed `InternRecord` objects, hides the
formatting inconsistencies observed in the live data (text dates like
`"Jan 5, 2026"`, mixed Drive link types, multilingual name fields), and
provides one write-back entry point for status updates and log rows.

Expected functions: `readInternRecords()`, `writeRevocationStatus(rows)`,
`appendLogEntries(entries)`.

### 3.3 `driveService.gs`

**All Drive mutations go through this file.** It resolves a folder URL to
a Drive ID, enumerates permissions, matches them to an intern email, and
removes the matching permission. It also enforces the exception-user
allowlist so supervisors and IT admins are never accidentally revoked.

Expected functions: `revokeAccess(folderUrl, internEmail)`,
`listPermissions(folderUrl)`, `isExceptionUser(email)`.

### 3.4 `logService.gs`

**Audit trail.** Persists one row per intern processed and one summary row
per run, into a dedicated log sheet. Uses an in-memory buffer and flushes
once per invocation to stay within Sheets API quota.

Expected functions: `startRun()`, `recordInternResult(entry)`,
`endRun(summary)`, `flush()`.

### 3.5 `triggerService.gs`

**Automation entry point.** Installs, updates, and removes the
time-driven trigger that calls `main.gs` on the configured schedule, and
guards against duplicate installations.

Expected functions: `installTrigger()`, `uninstallTrigger()`,
`onScheduledRun()`.

### 3.6 `main.gs`

**Pipeline orchestrator.** Reads records, filters to the candidate set,
calls `driveService` for each candidate, writes results back through
`sheetService`, and emits log entries through `logService`. Centralises
error handling so a single intern's failure cannot abort the whole run.
Honours the dry-run flag.

Expected functions: `runRevocationPipeline()`,
`runRevocationPipelineDry()`.

---

## 4. Documentation responsibilities (`docs/`)

| File                      | Audience              | Purpose                                                                  |
| ------------------------- | --------------------- | ------------------------------------------------------------------------ |
| `ProjectStructure.md`     | Developers, supervisor | Explains the file layout and the responsibility of each module.          |
| `Requirement.md`          | Supervisor, stakeholders | Functional and non-functional requirements, scope, assumptions, risks. |
| `SystemDesign.md`         | Supervisor, developers | Architecture overview, component responsibilities, workflow, future work. |
| `OpenQuestions.md`        | Supervisor, stakeholders | Decisions that must be confirmed before implementation begins.        |
| `UserManual.md`           | Operators (HR / IT)   | How to run, monitor, and troubleshoot the system. *(Later phase.)*       |
| `DeveloperDocumentation.md` | Developers          | Local setup, testing, and contribution guide. *(Later phase.)*           |

`UserManual.md` and `DeveloperDocumentation.md` are intentionally listed
in the structure but **not yet written**. They depend on decisions that
are still open in `OpenQuestions.md` and will be produced once the
requirements in this review cycle are signed off.

---

## 5. Tooling and project linking

The source files in `src/` are plain `.gs` text files. To turn them into
a runnable Google Apps Script project, one of the following paths will be
used (decision deferred to the build phase):

1. **clasp** — the official Google Apps Script CLI. Pushes `src/*.gs` to
   a script project bound to the production spreadsheet. Recommended for
   version control.
2. **Direct copy / paste** — manually paste each `.gs` file into the
   Apps Script editor attached to the Google Sheet. Acceptable if the
   project remains small.

Either way, the manifest file `appsscript.json` will be created by the
chosen tooling at link time. It is intentionally absent from the initial
commit because it contains the script ID and OAuth scopes that come from
the Apps Script project itself.

---

## 6. Status

- [x] Repository skeleton created.
- [x] `src/` populated with header-only stubs.
- [x] `docs/` populated with `ProjectStructure.md`, `Requirement.md`,
      `SystemDesign.md`, and `OpenQuestions.md`.
- [ ] Stakeholder sign-off on `Requirement.md` and `OpenQuestions.md`.
- [ ] `UserManual.md` and `DeveloperDocumentation.md` (later phase).
- [ ] `appsscript.json` and clasp linkage (later phase).
- [ ] Business logic implementation (later phase).
