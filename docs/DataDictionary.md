# Data Dictionary & Spreadsheet Mapping

**Project:** Automated Google Drive Access Revocation for Internship Offboarding
**Document type:** Implementation-ready data specification
**Status:** Draft v0.1 — pending supervisor review
**Last updated:** 2026-06-16
**Source of truth for this document:** `Timeline` sheet of the production workbook.

---

## Confirmed assumptions for this document

The following assumptions, taken from the project supervisor, govern every
design choice below. They override the open options in
`OpenQuestions.md` for the purposes of this document.

| Assumption            | Value                       | Affected design choice                                   |
| --------------------- | --------------------------- | -------------------------------------------------------- |
| Source sheet          | `Timeline`                  | Column mapping and header names below.                   |
| Permission type       | Direct Share (by email)     | One Drive permission lookup per intern, by email.        |
| Folder scope          | Main folder only            | No recursive subfolder / file walk. One Drive call per intern. |
| Email notifications   | None                        | No notification fields in the JSON contract; no Mail scope. |
| Trigger               | Daily time-driven trigger   | Read → validate → revoke → log, must fit one invocation. |

---

## Table of Contents

1. [Data Dictionary](#1-data-dictionary)
2. [Spreadsheet Mapping](#2-spreadsheet-mapping)
3. [Sample JSON Structure](#3-sample-json-structure)
4. [Validation Specification](#4-validation-specification)

---

## 1. Data Dictionary

Column letters refer to the column's position in the `Timeline` sheet.
"Required" means **the revocation pipeline needs this field to process
the row**. Optional columns may still be read for audit context.

### 1.1 `A` — `POSITION`

| Attribute          | Value                                                              |
| ------------------ | ------------------------------------------------------------------ |
| Description        | The intern's role / job title during the internship.               |
| Data type          | Text (string). May contain English or Thai characters.             |
| Required           | No (audit context only).                                           |
| Sample values      | `Programmer Trainee`, `HR Trainee`, `UXUI Designer Trainee`.       |
| Validation rules   | Trim leading/trailing whitespace. No length limit enforced. Store as-is. |
| Used by pipeline   | No (log enrichment only).                                           |

### 1.2 `B` — `NAME`

| Attribute          | Value                                                              |
| ------------------ | ------------------------------------------------------------------ |
| Description        | Full name of the intern.                                           |
| Data type          | Text (string). May contain English, Thai, or mixed scripts.        |
| Required           | **Yes** (used as the human-readable identifier in logs).           |
| Sample values      | `Anantachai Khankang`, `ปณิธิ วนสุวานิช`, `วิยุดา นนตรี (Wiyuda Nontri)`. |
| Validation rules   | Trim whitespace. Reject if empty after trim → mark row `INVALID_MISSING_NAME`. |
| Used by pipeline   | Log rows and run summary.                                          |

### 1.3 `C` — `NICKNAME`

| Attribute          | Value                                                              |
| ------------------ | ------------------------------------------------------------------ |
| Description        | Short name / preferred name.                                       |
| Data type          | Text (string).                                                     |
| Required           | No.                                                                |
| Validation rules   | Trim whitespace. May be empty.                                     |
| Used by pipeline   | No (log enrichment only).                                          |

### 1.4 `D` — `START`

| Attribute          | Value                                                              |
| ------------------ | ------------------------------------------------------------------ |
| Description        | Internship start date.                                             |
| Data type          | Date. In the live sheet this is a native Google Sheets datetime;  |
|                    | the reader must also tolerate text dates as a fallback.            |
| Required           | No (pipeline uses `END` for eligibility; `START` is audit context).|
| Sample values      | `2025-08-01`, `2025-11-03`.                                        |
| Validation rules   | Accept `Date` object directly. If the cell is a string, attempt    |
|                    | ISO `YYYY-MM-DD`, then `"MMM D, YYYY"` (e.g. `Jan 5, 2026`).       |
|                    | If parsing fails, set to `null` and record `INVALID_START_DATE`.   |
|                    | Reject ambiguous `DD/MM` vs `MM/DD` forms — never guess.           |
| Used by pipeline   | Log enrichment only.                                               |

### 1.5 `E` — `END`

| Attribute          | Value                                                              |
| ------------------ | ------------------------------------------------------------------ |
| Description        | Internship end date. Drives revocation eligibility.                |
| Data type          | Date. Native datetime in the live sheet; reader tolerates text.    |
| Required           | **Yes** (central to the eligibility rule).                         |
| Sample values      | `2025-11-30`, `2026-04-10`.                                        |
| Validation rules   | Same parsing rules as `START`. If missing or unparseable →         |
|                    | mark row `INVALID_END_DATE`, skip from candidate set.              |
|                    | Must be a calendar date; time-of-day component is ignored.         |
| Used by pipeline   | Eligibility: `endDate < today - GRACE_PERIOD_DAYS`.                |

### 1.6 `F` — `TEL`

| Attribute          | Value                                                              |
| ------------------ | ------------------------------------------------------------------ |
| Description        | Phone contact.                                                     |
| Data type          | String or number (sheet has both — e.g. `'062-318-9418'` and       |
|                    | `981054073.0`).                                                    |
| Required           | No.                                                                |
| Validation rules   | Coerce to string. Trim. May be empty. Do not validate format.      |
| Used by pipeline   | No.                                                                |

### 1.7 `G` — `LINE`

| Attribute          | Value                                                              |
| ------------------ | ------------------------------------------------------------------ |
| Description        | LINE messenger ID.                                                 |
| Data type          | String or number (mixed in source).                                |
| Required           | No.                                                                |
| Validation rules   | Coerce to string. Trim. May be empty.                              |
| Used by pipeline   | No.                                                                |

### 1.8 `H` — `EMAIL`

| Attribute          | Value                                                              |
| ------------------ | ------------------------------------------------------------------ |
| Description        | The intern's email address. **The identity used to match the Drive |
|                    | permission under Direct Share.**                                    |
| Data type          | Text (string).                                                     |
| Required           | **Yes** (critical — without it, no revocation is possible).        |
| Sample values      | `antcpozxc@gmail.com`, `chutumon.p65@rsu.ac.th`, `65011211057@msu.ac.th`. |
| Validation rules   | Must match `^[^\s@]+@[^\s@]+\.[^\s@]+$` after trim and lower-casing. |
|                    | Reject if empty → `INVALID_MISSING_EMAIL`.                         |
|                    | Reject if malformed → `INVALID_EMAIL_FORMAT`.                      |
|                    | Store canonicalised (trim + lowercase).                            |
| Used by pipeline   | Direct lookup against Drive permission `emailAddress` field.       |

### 1.9 `I` — `UNIVERSITY`

| Attribute          | Value                                                              |
| ------------------ | ------------------------------------------------------------------ |
| Description        | Intern's university.                                               |
| Data type          | Text (English or Thai).                                            |
| Required           | No.                                                                |
| Validation rules   | Trim. May be empty.                                                |
| Used by pipeline   | No (log enrichment only).                                          |

### 1.10 `J` — `WORKMODE`

| Attribute          | Value                                                              |
| ------------------ | ------------------------------------------------------------------ |
| Description        | Working arrangement for the internship.                            |
| Data type          | Enum string.                                                       |
| Required           | No.                                                                |
| Allowed values     | `Hybrid`, `WFO`, `WFH`.                                            |
| Validation rules   | Trim + canonical case (`Hybrid`, `WFO`, `WFH`). Unknown values     |
|                    | pass through unchanged and are logged at `WARN`, not rejected.     |
| Used by pipeline   | No.                                                                |

### 1.11 `K` — `INTERNSHIP STATUS`

| Attribute          | Value                                                              |
| ------------------ | ------------------------------------------------------------------ |
| Description        | Current status of the internship. **Drives the eligibility rule.** |
| Data type          | Enum string.                                                       |
| Required           | **Yes**.                                                           |
| Allowed values     | `Completed`, `Interning`, `Pending`, `Withdraw`.                   |
| Pipeline meaning   | `Completed` and `Withdraw` → eligible for revocation (subject to   |
|                    | date and grace-period checks). `Interning` and `Pending` → never   |
|                    | eligible.                                                          |
| Validation rules   | Trim + canonical case. Empty → `INVALID_MISSING_STATUS`. Unknown   |
|                    | value → `INVALID_STATUS_VALUE` (skip, log).                        |
| Used by pipeline   | Eligibility filter.                                                |

### 1.12 `L` — `FOLDER LINK`

| Attribute          | Value                                                              |
| ------------------ | ------------------------------------------------------------------ |
| Description        | URL of the intern's assigned Google Drive folder. **The target of |
|                    | the revocation under Folder Scope = Main Folder Only.**            |
| Data type          | URL string.                                                        |
| Required           | **Yes**.                                                           |
| Accepted forms     | `https://drive.google.com/drive/folders/{id}`                      |
|                    | `https://drive.google.com/drive/folders/{id}?usp=sharing`          |
| Rejected forms     | `https://drive.google.com/file/d/{id}` (file, not folder)          |
|                    | `https://drive.google.com/open?id={id}`     (ambiguous, requires extra resolution) |
| Validation rules   | Must start with `https://drive.google.com/drive/folders/`.         |
|                    | Extract the segment immediately after `/folders/` as the folder ID |
|                    | (strip any `?usp=…` query). Empty cell → `INVALID_MISSING_FOLDER`. |
|                    | Non-folder URL → `INVALID_FOLDER_URL_FORMAT`.                      |
| Used by pipeline   | Direct input to `DriveApp.getFolderById(folderId)`.                |

### 1.13 `M` — `FIRST DAY WORK MODE`

| Attribute          | Value                                                              |
| ------------------ | ------------------------------------------------------------------ |
| Description        | Work mode on the intern's first day.                               |
| Data type          | Enum string.                                                       |
| Required           | No.                                                                |
| Validation rules   | Trim. May be empty.                                                |
| Used by pipeline   | No.                                                                |

### 1.14 `N` — `TRACKING STATUS`

| Attribute          | Value                                                              |
| ------------------ | ------------------------------------------------------------------ |
| Description        | Operational state of access provisioning.                          |
| Data type          | Enum string.                                                       |
| Required           | No.                                                                |
| Allowed values     | `Access Shared`, empty.                                            |
| Pipeline meaning   | Rows with `Access Shared` are expected to have a revokable         |
|                    | permission. Rows where this is empty **may** have never been       |
|                    | provisioned; treat Drive "no permission found" as success for      |
|                    | these rows (see Validation Specification §4.4).                    |
| Validation rules   | Trim. Unknown values pass through at `WARN`.                       |
| Used by pipeline   | Soft hint only — does not gate eligibility.                        |

### 1.15 `O` — `EMAIL STATUS`

| Attribute          | Value                                                              |
| ------------------ | ------------------------------------------------------------------ |
| Description        | Whether the access-share notification email was sent.              |
| Data type          | Enum string.                                                       |
| Required           | No.                                                                |
| Allowed values     | `Success`, empty.                                                  |
| Validation rules   | Trim. Unknown values pass through at `WARN`.                       |
| Used by pipeline   | No.                                                                |

---

## 2. Spreadsheet Mapping

Maps each `Timeline` column to its internal field name in the JSON
contract returned by `sheetService.readInternRecords()`. Internal
names are `lowerCamelCase`.

| Column | Header              | Internal field              | Required | Used by pipeline |
| ------ | ------------------- | --------------------------- | -------- | ---------------- |
| A      | `POSITION`          | `position`                  | No       | No (audit)       |
| B      | `NAME`              | `fullName`                  | Yes      | Yes (log)        |
| C      | `NICKNAME`          | `nickname`                  | No       | No               |
| D      | `START`             | `internshipStartDate`       | No       | No (audit)       |
| E      | `END`               | `internshipEndDate`         | Yes      | Yes (eligibility)|
| F      | `TEL`               | `phone`                     | No       | No               |
| G      | `LINE`              | `lineId`                    | No       | No               |
| H      | `EMAIL`             | `internEmail`               | Yes      | Yes (Drive lookup) |
| I      | `UNIVERSITY`        | `university`                | No       | No               |
| J      | `WORKMODE`          | `workMode`                  | No       | No               |
| K      | `INTERNSHIP STATUS` | `internshipStatus`          | Yes      | Yes (eligibility)|
| L      | `FOLDER LINK`       | `folderLink`                | Yes      | Yes (target)     |
| M      | `FIRST DAY WORK MODE` | `firstDayWorkMode`        | No       | No               |
| N      | `TRACKING STATUS`   | `trackingStatus`            | No       | Soft hint only   |
| O      | `EMAIL STATUS`      | `emailStatus`               | No       | No               |

Two additional fields are produced by the reader (not read from the
sheet):

| Internal field     | Source                         | Purpose                                  |
| ------------------ | ------------------------------ | ---------------------------------------- |
| `rowNumber`        | 1-based sheet row index.       | Write-back addressing and log correlation. |
| `validation`       | Computed by the reader.        | Per-record validity flag and reason codes (see §4). |

---

## 3. Sample JSON Structure

`sheetService.readInternRecords()` returns the following shape. Dates
are ISO-8601 calendar strings (`YYYY-MM-DD`); the time-of-day
component is intentionally discarded.

### 3.1 Top-level wrapper

```json
{
  "source": {
    "spreadsheetId": "1AOjCbe6WL41I-jUa7R762Y4D-5AAc3VnIfM7qrsmAkU",
    "sheetName": "Timeline",
    "snapshotAt": "2026-06-16T02:00:00.000+07:00",
    "rowCount": 58
  },
  "records": [ /* InternRecord[] — see §3.2 */ ],
  "summary": {
    "total": 58,
    "valid": 56,
    "invalid": 2,
    "skippedReasons": {
      "INVALID_MISSING_FOLDER": 2
    }
  }
}
```

### 3.2 `InternRecord` — valid example

```json
{
  "rowNumber": 2,
  "position": "Programmer Trainee",
  "fullName": "Anantachai Khankang",
  "nickname": "Po",
  "internEmail": "antcpozxc@gmail.com",
  "internshipStartDate": "2025-08-01",
  "internshipEndDate": "2025-11-30",
  "internshipStatus": "Completed",
  "folderLink": "https://drive.google.com/drive/folders/1k7YCLeriyu-fEJhz3cQHL-oSidvGmFgx",
  "folderId": "1k7YCLeriyu-fEJhz3cQHL-oSidvGmFgx",
  "phone": "062-318-9418",
  "lineId": null,
  "university": "Kasetsart University",
  "workMode": "Hybrid",
  "firstDayWorkMode": "WFH",
  "trackingStatus": "Access Shared",
  "emailStatus": null,
  "validation": {
    "isValid": true,
    "eligibility": "ELIGIBLE",
    "errors": [],
    "warnings": []
  }
}
```

### 3.3 `InternRecord` — invalid example (missing folder link)

```json
{
  "rowNumber": 42,
  "position": "Data Analytics Trainee",
  "fullName": "Pratchaya Tangsomsuk",
  "nickname": "Kik",
  "internEmail": "pratchaya.tss@gmail.com",
  "internshipStartDate": "2025-11-03",
  "internshipEndDate": "2026-02-20",
  "internshipStatus": "Completed",
  "folderLink": null,
  "folderId": null,
  "phone": null,
  "lineId": "kik1627384950",
  "university": "University of Phayao",
  "workMode": "WFO",
  "firstDayWorkMode": "WFH",
  "trackingStatus": "Access Shared",
  "emailStatus": null,
  "validation": {
    "isValid": false,
    "eligibility": "INELIGIBLE_INVALID",
    "errors": [
      {
        "code": "INVALID_MISSING_FOLDER",
        "field": "FOLDER LINK",
        "message": "Folder link is required but the cell is empty."
      }
    ],
    "warnings": []
  }
}
```

### 3.4 `eligibility` controlled vocabulary

Every `InternRecord.validation.eligibility` is one of:

| Value                    | Meaning                                                              |
| ------------------------ | -------------------------------------------------------------------- |
| `ELIGIBLE`               | All required fields valid, end date in the past beyond grace period, status is `Completed` or `Withdraw`. |
| `INELIGIBLE_NOT_ENDED`   | Required fields valid but end date is still in the future or within the grace period. |
| `INELIGIBLE_ACTIVE`      | Required fields valid but status is `Interning` or `Pending`.         |
| `INELIGIBLE_ALREADY`     | Status column already shows access revoked (idempotency, see Q-04).   |
| `INELIGIBLE_EXCEPTION`   | Email is on the `EXCEPTION_EMAILS` allowlist.                         |
| `INELIGIBLE_INVALID`     | At least one required field failed validation.                        |

---

## 4. Validation Specification

The reader is the single place where raw cells are converted to typed
fields, so all validation lives in `sheetService`. Every validation
failure produces:

1. A controlled-vocabulary `code` from the table in §4.6.
2. A human-readable `message`.
3. A `field` name (spreadsheet header) for traceability.
4. An `eligibility` of `INELIGIBLE_INVALID` on the record.
5. A log row at run time.

A record can carry multiple errors (e.g. missing email **and** missing
folder); each is appended to `validation.errors`.

### 4.1 Required fields

The following four columns are required for a row to be considered
valid. Missing any of them marks the record `INELIGIBLE_INVALID` and
excludes it from the candidate set:

| Column | Header              | Reason it is required                                 |
| ------ | ------------------- | ----------------------------------------------------- |
| B      | `NAME`              | Audit-log identifier; without it the log row is meaningless. |
| E      | `END`               | Drives the eligibility rule.                          |
| H      | `EMAIL`             | Without it, the Drive permission cannot be matched.   |
| K      | `INTERNSHIP STATUS` | Determines whether the row is in scope at all.        |
| L      | `FOLDER LINK`       | Without it, there is no target to revoke.             |

All other columns are optional. Missing values become `null` in the
JSON (or empty string for free-text columns where the consumer expects
a string).

### 4.2 Invalid values

A value is **invalid** when it is present but fails its validation
rule:

| Field              | Failure mode                                       | Code                          |
| ------------------ | -------------------------------------------------- | ------------------------------ |
| `EMAIL`            | Fails the regex match.                             | `INVALID_EMAIL_FORMAT`         |
| `END`              | Unparseable string, or ambiguous `DD/MM` form.    | `INVALID_END_DATE`             |
| `START`            | Unparseable string, or ambiguous `DD/MM` form.    | `INVALID_START_DATE`           |
| `INTERNSHIP STATUS`| Not in the allowed enum.                           | `INVALID_STATUS_VALUE`         |
| `FOLDER LINK`      | URL does not match the `/drive/folders/` form.     | `INVALID_FOLDER_URL_FORMAT`    |
| `FOLDER LINK`      | URL parses but the embedded ID has invalid length. | `INVALID_FOLDER_ID`            |

Invalid records are excluded from the candidate set and logged with
the controlled vocabulary code. The run continues.

### 4.3 Missing folder link handling

The most common failure observed in the live data (2 of 58 rows).

- An empty `FOLDER LINK` cell → record marked `INELIGIBLE_INVALID`
  with error code `INVALID_MISSING_FOLDER`.
- The record is still included in the returned `records[]` array so
  that operators can see it in the run summary; it is simply excluded
  from the candidate set passed to `driveService`.
- `folderLink` and `folderId` in the JSON are both `null`.
- Run summary increments `summary.skippedReasons.INVALID_MISSING_FOLDER`.

### 4.4 Invalid email handling

Two sub-cases:

- **Empty email cell** → error code `INVALID_MISSING_EMAIL`.
- **Non-empty but malformed** (fails `^[^\s@]+@[^\s@]+\.[^\s@]+$`) →
  error code `INVALID_EMAIL_FORMAT`.

In both cases the record is marked `INELIGIBLE_INVALID` and excluded
from the candidate set. The pipeline **does not** fall back to
matching by name or phone — email is the only identity used for
Direct Share revocation.

If `driveService.revokeAccess()` later finds no Drive permission for
the (valid) email, that is handled separately at execution time (see
§4.7), not at read time.

### 4.5 Invalid date handling

Three sub-cases:

- **Native datetime cell** (the common case in `Timeline`) → accepted
  as-is; only the calendar `YYYY-MM-DD` is retained.
- **String cell matching `YYYY-MM-DD`** → parsed directly.
- **String cell matching `"MMM D, YYYY"`** (e.g. `Jan 5, 2026`, seen
  in the `Intern list` sheet) → parsed with an explicit locale
  (`en_US`) so month names resolve consistently.

Any other format, or a date-only string with ambiguous day/month
ordering (e.g. `05/04/2026`), is **rejected** rather than guessed,
producing `INVALID_END_DATE` or `INVALID_START_DATE`. Rationale: a
wrong guess silently revokes access up to a month early or a month
late (Risk R-03).

### 4.6 Error code table (controlled vocabulary)

| Code                          | Field                | Meaning                                                       |
| ----------------------------- | -------------------- | ------------------------------------------------------------- |
| `INVALID_MISSING_NAME`        | `NAME`               | Name cell is empty after trimming.                            |
| `INVALID_MISSING_EMAIL`       | `EMAIL`              | Email cell is empty after trimming.                           |
| `INVALID_EMAIL_FORMAT`        | `EMAIL`              | Email present but fails the regex.                            |
| `INVALID_END_DATE`            | `END`                | End date missing or unparseable.                              |
| `INVALID_START_DATE`          | `START`              | Start date missing or unparseable.                            |
| `INVALID_MISSING_STATUS`      | `INTERNSHIP STATUS`  | Status cell is empty after trimming.                          |
| `INVALID_STATUS_VALUE`        | `INTERNSHIP STATUS`  | Status not in allowed enum.                                   |
| `INVALID_MISSING_FOLDER`      | `FOLDER LINK`        | Folder link cell is empty after trimming.                     |
| `INVALID_FOLDER_URL_FORMAT`   | `FOLDER LINK`        | URL is not a `/drive/folders/` form.                          |
| `INVALID_FOLDER_ID`           | `FOLDER LINK`        | URL form is correct but the embedded ID is malformed.         |

Codes are stable identifiers. Operators filter the log sheet by them;
they must never be reworded without a coordinated log-sheet migration.

### 4.7 Execution-time outcome codes

These are produced by `driveService`, not by the reader, but they
are part of the same controlled vocabulary and are listed here for
completeness so the log sheet has one consistent vocabulary across
read and revoke phases.

| Code                       | Phase    | Meaning                                                              |
| -------------------------- | -------- | -------------------------------------------------------------------- |
| `REVOKED`                  | Revoke   | Permission was found and successfully removed.                       |
| `ALREADY_REVOKED`          | Revoke   | No permission found for the email; treated as success.               |
| `ALREADY_REVOKED_PROVISIONED` | Revoke | Same as above, but row's `TRACKING STATUS` was `Access Shared` → flagged at `WARN` for follow-up because the permission was expected to exist. |
| `SKIPPED_EXCEPTION_USER`   | Revoke   | Email matched `EXCEPTION_EMAILS`; no action taken.                   |
| `DRIVE_API_ERROR`          | Revoke   | Drive call failed after bounded retries; see error message.          |
| `FOLDER_NOT_ACCESSIBLE`    | Revoke   | The script owner cannot read the folder's permissions.               |
| `DRY_RUN`                  | Revoke   | `DRY_RUN = true`; computed the action but performed no Drive call.   |

### 4.8 Whitespace and case normalisation

| Field              | Normalisation                                                                |
| ------------------ | ---------------------------------------------------------------------------- |
| All text fields    | Trim leading/trailing whitespace on read.                                     |
| `EMAIL`            | Trim + lowercase.                                                             |
| `INTERNSHIP STATUS`| Trim + canonical case (e.g. `completed` → `Completed`).                       |
| `WORKMODE`         | Trim + canonical case. Unknown values preserved as-is, logged at `WARN`.      |
| `FOLDER LINK`      | Trim only. URL is otherwise left intact (query string, trailing slash).       |

### 4.9 Row-level skip rules (blank rows, header rows)

- A row whose cells are **all empty after trimming** is silently
  skipped (not included in `records[]`, not counted in `summary.total`).
- The header row (row 1) is always skipped.
- No other implicit skip rules. Every non-empty data row produces a
  record, valid or invalid, so that the run summary is auditable.

---

## 5. Open items still gated on `OpenQuestions.md`

Although the assumptions at the top of this document are sufficient to
implement against, the following `OpenQuestions.md` items still affect
secondary behaviour and should be confirmed before go-live:

- **Q-04** — whether a per-intern status column may be written back.
  Affects whether `eligibility = INELIGIBLE_ALREADY` is ever produced
  by the reader (idempotency check) or only by `driveService`.
- **Q-05** — grace period length. Affects the boundary between
  `ELIGIBLE` and `INELIGIBLE_NOT_ENDED`.
- **Q-06** — contents of `EXCEPTION_EMAILS`. Affects which rows become
  `INELIGIBLE_EXCEPTION`.
