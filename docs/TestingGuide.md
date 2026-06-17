# End-to-End Testing Guide

**Project:** Automated Google Drive Access Revocation for Internship Offboarding
**Document type:** Test Procedure
**Status:** For operator use
**Last updated:** 2026-06-16
**Test workbook:** `https://docs.google.com/spreadsheets/d/1AOjCbe6WL41I-jUa7R762Y4D-5AAc3VnIfM7qrsmAkU/edit`
**Test subject (intern):** Nannapat Puripatpun / `rujimoralalita@gmail.com`
**Test folder:** `https://drive.google.com/drive/folders/1pr74bePbS-2UVheswybHPLHbBNDRxvbs`

---

## How to use this guide

Work top to bottom. Each section assumes the previous one is complete.
Wherever you see **ACTION REQUIRED:**, stop and perform the steps
before continuing — the script cannot be tested without them.

The guide is keyed to the code committed in `src/` at the time of
writing. Function names, log column names, and outcome codes are
quoted verbatim from the implementation.

---

## 0. ACTION REQUIRED items (read first)

These are blockers. Each is restated in context below; this section
is a single-glance summary.

> **ACTION REQUIRED 1 — Bind an Apps Script project to the production workbook.**
> Without this step there is nowhere to run the code.
> **Steps:** Open the workbook → **Extensions → Apps Script**. The
> default project contains one `Code.gs` file. Delete it and create
> one script file per `src/*.gs` (config, sheetService, driveService,
> logService, main, triggerService, testHelpers). Paste each file's
> contents from your local `src/` directory. Save the project
> (`Ctrl/Cmd + S`) and name it (e.g. `InternshipAccessRevocation`).

> **ACTION REQUIRED 2 — Confirm the script owner account.**
> Per confirmed assumption #7, the dev/test owner is
> `nannapat.pu@ku.th`. The account you use to open the Apps Script
> editor IS the account that will own the triggers and that must
> hold Editor access on every intern folder. Log in to Apps Script
> as this account before continuing.
> **Why it matters:** `DriveApp.getFolderById(...).getEditors()` and
> `removeEditor(...)` only succeed when the calling account has
> Manager / Editor permission on the folder. A different account
> will see `FOLDER_NOT_ACCESSIBLE` on every test.

> **ACTION REQUIRED 3 — Grant the script owner Editor access to the test folder.**
> Open the test folder in Drive → **Share** → add
> `nannapat.pu@ku.th` as **Editor**. The owner of the folder does
> not need to change.
> **Verify:** Re-open the folder as `nannapat.pu@ku.th` and confirm
> the **Share** dialog shows that account as Editor.

> **ACTION REQUIRED 4 — Confirm `rujimoralalita@gmail.com` currently has access to the test folder.**
> Open the test folder → **Share**. The intern email must be listed
> as **Editor**, **Viewer**, or **Commenter**. If it is missing, the
> revocation test will return `ALREADY_REVOKED` instead of `REVOKED`
> — which is still a successful test of the no-op path, but does not
> prove that removal works.
> **Steps:** Add `rujimoralalita@gmail.com` as **Editor** now if it
> is not already present.

> **ACTION REQUIRED 5 — Confirm the Supervisor sheet exists in the live workbook.**
> The local `Internship Application.xlsx` has it; the live workbook
> must too, or the dynamic supervisor allowlist will silently come
> back empty (not an error, but the safety net is inactive).
> **Verify:** Open the workbook and confirm a tab named **Supervisor**
> exists with an **EMAIL** header in row 1 (typically column D).

> **ACTION REQUIRED 6 — Confirm Timeline headers match `COLUMN_MAPPING` exactly.**
> Required headers (must be present, exact text, trimmed):
> `NAME`, `END`, `EMAIL`, `INTERNSHIP STATUS`, `FOLDER LINK`.
> Optional but expected for full feature support: `POSITION`,
> `NICKNAME`, `START`, `TEL`, `LINE`, `UNIVERSITY`, `WORKMODE`,
> `FIRST DAY WORK MODE`, `TRACKING STATUS`, `EMAIL STATUS`.
> **Verify:** Click the **Timeline** tab. Read row 1. Compare
> character-by-character against the list above. A trailing space
> or different capitalisation will cause
> `Source sheet is missing required column headers`.

> **ACTION REQUIRED 7 — Place the test row in Timeline.**
> Add (or confirm) a row whose required fields match the test data
> in §1.3 below. The exact row number is not important; the system
> finds columns by header text, not position.

---

## 1. Pre-Test Validation

Goal: prove the workbook and test row are in a state the pipeline
will accept, BEFORE touching Apps Script.

### 1.1 Verify required sheets exist

Open the workbook. Confirm the following tabs are visible:

| Sheet                   | Required?                                  |
| ----------------------- | ------------------------------------------ |
| `Timeline`              | **Yes** — source of truth.                 |
| `Supervisor`            | **Yes** for supervisor allowlist to work.  |
| `AccessRevocationLog`   | No — auto-created on first `flush()`.      |

### 1.2 Verify required headers in Timeline

Click the **Timeline** tab. The header row (row 1) must contain
these strings exactly (case-sensitive, no leading/trailing
whitespace):

| Header                | Required | Column (typical) | Notes |
| --------------------- | -------- | ---------------- | ----- |
| `NAME`                | Yes      | B                | Intern identifier for log. |
| `END`                 | Yes      | E                | Drives eligibility. |
| `EMAIL`               | Yes      | H                | Drive permission identity. |
| `INTERNSHIP STATUS`   | Yes      | K                | Must be `Completed` or `Withdraw`. |
| `FOLDER LINK`         | Yes      | L                | Must match the folder URL regex. |
| `START`               | No       | D                | Audit context only. |
| `TRACKING STATUS`     | No       | N                | `Access Shared` upgrades no-op to `ALREADY_REVOKED_PROVISIONED`. |
| `POSITION`            | No       | A                | Audit context only. |
| `NICKNAME`            | No       | C                | Audit context only. |
| `TEL`, `LINE`         | No       | F, G             | Not used by pipeline. |
| `UNIVERSITY`          | No       | I                | Audit context only. |
| `WORKMODE`            | No       | J                | Audit context only. |
| `FIRST DAY WORK MODE` | No       | M                | Not used by pipeline. |
| `EMAIL STATUS`        | No       | O                | Not used by pipeline. |

> **Header mismatch?** The system throws on first run with a message
> like `Source sheet is missing required column headers: NAME
> (expected column B, for internal field "fullName")`. Fix the
> header text in the sheet — do **not** change `COLUMN_MAPPING` to
> match a typo in the sheet.

### 1.3 Verify the test row

| Field              | Expected value                                                         |
| ------------------ | ---------------------------------------------------------------------- |
| `POSITION`         | `Fullstack Developer Trainee`                                          |
| `NAME`             | `Nannapat Puripatpun`                                                  |
| `START`            | `2025-09-01` (or `Sep 1, 2025`)                                        |
| `END`              | `2025-12-05` (or `Dec 5, 2025`)                                        |
| `TEL`              | `0620863010`                                                           |
| `LINE`             | `nanna`                                                                |
| `EMAIL`            | `rujimoralalita@gmail.com`                                             |
| `UNIVERSITY`       | `Kasetsart University`                                                 |
| `WORKMODE`         | `WFH`                                                                  |
| `INTERNSHIP STATUS`| `Completed`                                                            |
| `FOLDER LINK`      | `https://drive.google.com/drive/folders/1pr74bePbS-2UVheswybHPLHbBNDRxvbs?usp=share_link` |
| `TRACKING STATUS`  | `Access Shared`                                                        |

Note on the `Supervisor: Pim` field from your brief: there is no
`SUPERVISOR` column in `COLUMN_MAPPING`, so this field — if you
added it to the sheet — is silently ignored. The supervisor
allowlist is sourced from the separate **Supervisor** sheet's
`EMAIL` column, not from a per-intern supervisor field in Timeline.

### 1.4 Verify Folder Link format

The system accepts URLs that match
`^https://drive\.google\.com/drive/folders/([\w-]+)`. The test URL:

```
https://drive.google.com/drive/folders/1pr74bePbS-2UVheswybHPLHbBNDRxvbs?usp=share_link
```

- Matches the prefix `https://drive.google.com/drive/folders/` ✓
- Folder ID `1pr74bePbS-2UVheswybHPLHbBNDRxvbs` is captured ✓
- The `?usp=share_link` query string is left intact in the URL but
  ignored by the ID extraction ✓

A quick mental check: any URL that starts with
`https://drive.google.com/drive/folders/` and is followed by at
least 8 characters of letters/digits/underscores/hyphens will
parse. The `open?id=` form and the `/file/d/` form are both
rejected with `INVALID_FOLDER_URL_FORMAT`.

### 1.5 Verify Email format

`rujimoralalita@gmail.com` matches the email regex
`^[^\s@]+@[^\s@]+\.[^\s@]+$`. The reader canonicalises to
trim + lowercase on input, so accidental leading whitespace or
capital letters are tolerated.

### 1.6 Verify eligibility (manual trace)

Walking through `_computeEligibility_` in `sheetService.gs`:

| Check                                              | Result for this row |
| -------------------------------------------------- | ------------------- |
| Required fields all present?                        | Yes                 |
| Email on exception allowlist?                       | No (gmail address, not in Supervisor sheet) |
| Status in `STATUS_ACTIVE` (`Interning`, `Pending`)? | No (`Completed`)    |
| Status in `STATUS_OFFBOARDED`?                      | Yes                 |
| `endDate < today - GRACE_PERIOD_DAYS`?              | Yes (Dec 5 2025 < Jun 16 2026 − 0 days) |

**Expected eligibility outcome: `ELIGIBLE`.**

### 1.7 Verify supervisor whitelist behaviour

Open the **Supervisor** tab. Confirm the `EMAIL` column contains
at least:

- `aranya.k@vannessplus.com`
- `sirapat.p@vannessplus.com`
- `nabhassorn@vannessplus.com`

The test email `rujimoralalita@gmail.com` must NOT appear here. If
it does, the test will return `SKIPPED_EXCEPTION_USER` and the
revocation will be blocked.

---

## 2. Google Drive Validation

Goal: capture the pre-test sharing state of the test folder so you
can compare against the post-test state.

### 2.1 Open the test folder

Paste the folder URL into Drive. Make sure you are logged in as
`nannapat.pu@ku.th` (the script owner).

### 2.2 Confirm `rujimoralalita@gmail.com` currently has access

Click the **Share** button (top-right). The dialog that opens
lists every account with access.

**Expected observations:**

- `rujimoralalita@gmail.com` appears in the list.
- The role badge next to it reads **Editor**, **Viewer**, or
  **Commenter**.
- Take a screenshot or note the exact role — you will compare
  against this in §4.6 (after dry run, must be unchanged) and §5.5
  (after live run, must be gone).

### 2.3 Confirm the script owner has Editor / Manager permission

In the same **Share** dialog:

- `nannapat.pu@ku.th` must appear with **Editor** (or **Manager**
  on a shared drive).
- If the account is **Viewer** or **Commenter**, every test will
  fail with `FOLDER_NOT_ACCESSIBLE` because the script cannot
  enumerate or remove permissions.

### 2.4 Other accounts on the folder

Note (do not change) any other accounts already on the folder.
The pipeline only ever removes the one email it is given; the
other accounts should be unchanged after every test.

---

## 3. Apps Script project setup

(After completing **ACTION REQUIRED 1** in §0.)

### 3.1 Open the Apps Script editor

From the spreadsheet: **Extensions → Apps Script**. A new browser
tab opens showing the project bound to this workbook.

### 3.2 Confirm all seven source files are present

In the left-hand file panel you should see:

- `config.gs`
- `sheetService.gs`
- `driveService.gs`
- `logService.gs`
- `main.gs`
- `triggerService.gs`
- `testHelpers.gs`

If `appsscript.json` is not visible, enable **View → Show manifest
file**. You do not need to edit it for these tests.

### 3.3 Confirm `SPREADSHEET_ID` is correct

Open `config.gs`. The constant `SPREADSHEET_ID` should equal
`1AOjCbe6WL41I-jUa7R762Y4D-5AAc3VnIfM7qrsmAkU` — this is the ID
in the test workbook URL. If the test workbook is a different file,
update this constant.

### 3.4 Confirm `DRY_RUN = true`

In `config.gs`, line ~283:

```js
const DRY_RUN = true;
```

All initial tests run in dry-run mode. You will change this to
`false` only for the live revocation test in §5, then change it
back.

### 3.5 Authorise the OAuth scopes (first run only)

The first time you run any function, Apps Script prompts for OAuth
authorisation. The flow is:

1. Click **Run**.
2. A dialog reads **"Authorization required".** Click
   **Review permissions**.
3. Select the `nannapat.pu@ku.th` account.
4. A warning may read **"Google hasn't verified this app".** Click
   **Advanced → Go to InternshipAccessRevocation (unsafe)**. This
   is normal for an unreviewed internal script.
5. The consent screen lists the scopes the script is requesting:
   - View and manage spreadsheets that this application is
     authorized to access.
   - View and manage the files in your Google Drive.
6. Click **Allow**.

After the first run, subsequent runs do not re-prompt unless scopes
change.

---

## 4. Dry Run Test

Goal: prove the pipeline produces the correct candidate set, log
rows, and summary **without** modifying any Drive permission.

### 4.1 Function to execute

In the Apps Script editor:

1. From the function dropdown at the top, select **`runSampleDryRun`**
   (defined in `testHelpers.gs`).
2. Click **Run**.

`runSampleDryRun` calls `main.runRevocationPipelineDry()`, which
calls `runRevocationPipeline('DRY_RUN_MANUAL', { dryRunOverride: true })`.
The `dryRunOverride` flag forces dry-run mode even if you later
flip `DRY_RUN = false` in config.

### 4.2 Expected console output

The **Execution Log** panel (bottom of the screen) should show
three lines:

```
runSampleDryRun: starting dry-run pipeline...
runSampleDryRun: complete. Summary:
{
  "runId": "R-20260616T...-xxxx",
  "triggerSource": "DRY_RUN_MANUAL",
  "dryRun": true,
  "startedAt": "2026-06-16T...+07:00",
  "endedAt": "2026-06-16T...+07:00",
  "durationMs": <number>,
  "totalCandidates": 1,
  "revoked": 0,
  "alreadyRevoked": 0,
  "skipped": 1,
  "failed": 0,
  "aborted": false
}
```

`runId` will differ (timestamp + random suffix). `durationMs` will
differ (typically a few hundred ms to a few seconds). All other
fields should match exactly.

> **Note on counters:** the bucketing in `_bumpCounters_` puts
> `DRY_RUN` outcomes into the `skipped` counter. This is a known
> design choice — in dry-run mode every candidate lands in
> `skipped`. The per-intern log row carries the distinguishing
> message ("would have removed editor" vs. "no permission found").

### 4.3 Expected Log Sheet entries

Switch to the spreadsheet. A new tab named **`AccessRevocationLog`**
should now exist (created automatically on first flush). Open it.

You should see **two rows** below the header:

**Row 2 — INTERN row:**

| Column           | Expected value                                                           |
| ---------------- | ------------------------------------------------------------------------ |
| ROW TYPE         | `INTERN`                                                                 |
| RUN ID           | Matches the runId from §4.2                                              |
| TIMESTAMP        | ISO-8601 in ICT                                                          |
| TRIGGER SOURCE   | `DRY_RUN_MANUAL`                                                         |
| DRY RUN          | `true`                                                                   |
| FULL NAME        | `Nannapat Puripatpun`                                                    |
| ROW NUMBER       | The Timeline row index of the test row (e.g. `2`)                        |
| INTERN EMAIL     | `rujimoralalita@gmail.com`                                               |
| FOLDER ID        | `1pr74bePbS-2UVheswybHPLHbBNDRxvbs`                                      |
| ACTION           | `DRY_RUN`                                                                |
| OUTCOME          | `success`                                                                |
| MESSAGE          | `Dry-run: would have removed editor permission.` (or `viewer`)           |
| STARTED AT … FAILED | (blank — these are summary-row columns)                               |

**Row 3 — RUN_SUMMARY row:**

| Column               | Expected value                                  |
| -------------------- | ----------------------------------------------- |
| ROW TYPE             | `RUN_SUMMARY`                                   |
| RUN ID               | Same as row 2                                   |
| TIMESTAMP            | ISO-8601 in ICT                                 |
| TRIGGER SOURCE       | `DRY_RUN_MANUAL`                                |
| DRY RUN              | `true`                                          |
| FULL NAME … MESSAGE  | (blank — these are intern-row columns)          |
| STARTED AT           | Same as row 2's TIMESTAMP (within rounding)     |
| ENDED AT             | Same as this row's TIMESTAMP                    |
| DURATION (MS)        | `<number>` — should be modest (a few seconds)   |
| TOTAL CANDIDATES     | `1`                                             |
| REVOKED              | `0`                                             |
| ALREADY REVOKED      | `0`                                             |
| SKIPPED              | `1`                                             |
| FAILED               | `0`                                             |

### 4.4 What should NOT happen during a dry run

- The Drive folder's sharing dialog must show no change to
  `rujimoralalita@gmail.com`'s access.
- The Timeline row itself must not be modified (no write-back is
  implemented yet).
- The Execution Log must not contain any line starting with
  `onScheduledRun FAILED` (that would indicate an uncaught
  exception).

### 4.5 Verify the Drive folder is unchanged

Open the test folder in Drive. Click **Share**. Compare against
your notes from §2.2.

**Expected:** `rujimoralalita@gmail.com` is still listed with the
same role. If it was an Editor before the dry run, it must still
be an Editor now.

---

## 5. Real Revocation Test

Goal: prove the pipeline actually removes the permission when
`DRY_RUN = false`.

### 5.1 Switch DRY_RUN to false

In `config.gs`, change:

```js
const DRY_RUN = false;
```

Save the file (`Ctrl/Cmd + S`).

> **Revert reminder:** change `DRY_RUN` back to `true` immediately
> after §5.5. Leaving it `false` risks an unintended live run if
> the trigger is already installed.

### 5.2 Function to execute

In the Apps Script editor:

1. From the function dropdown, select **`runRevocationPipeline`**
   (defined in `main.gs`). Do **not** select `runRevocationPipelineDry`
   — that one forces dry-run mode regardless of the config flag.
2. Click **Run**.

> **Alternative without editing config:** add a one-line helper to
> `testHelpers.gs`:
>
> ```js
> function runSampleLiveRun() {
>   return runRevocationPipeline('MANUAL', { dryRunOverride: false });
> }
> ```
>
> Then run `runSampleLiveRun` from the IDE. This avoids touching
> `DRY_RUN` and removes the revert risk.

### 5.3 Expected results on success

The **Execution Log** will not print a JSON summary (that's done
by `runSampleDryRun`, not by the bare pipeline function). Instead
the function returns the summary object, which the Apps Script IDE
shows in the **Return value** panel.

Expected return value:

```json
{
  "runId": "R-20260616T...-xxxx",
  "triggerSource": "MANUAL",
  "dryRun": false,
  "startedAt": "...",
  "endedAt": "...",
  "durationMs": <number>,
  "totalCandidates": 1,
  "revoked": 1,
  "alreadyRevoked": 0,
  "skipped": 0,
  "failed": 0,
  "aborted": false
}
```

Note the differences from §4.2:

- `triggerSource`: `MANUAL` (not `DRY_RUN_MANUAL`)
- `dryRun`: `false`
- `revoked`: `1` (not `0`)
- `skipped`: `0` (not `1`)

### 5.4 Expected Log Sheet entries

A new pair of rows (rows 4 and 5, appended after the dry-run rows
from §4) appears in **`AccessRevocationLog`**.

**INTERN row:**

| Column         | Expected value                                  |
| -------------- | ----------------------------------------------- |
| ROW TYPE       | `INTERN`                                        |
| TRIGGER SOURCE | `MANUAL`                                        |
| DRY RUN        | `false`                                         |
| ACTION         | `REVOKED`                                       |
| OUTCOME        | `success`                                       |
| MESSAGE        | (blank — no error message on clean success)     |

**RUN_SUMMARY row:**

| Column               | Expected value                                  |
| -------------------- | ----------------------------------------------- |
| TRIGGER SOURCE       | `MANUAL`                                        |
| DRY RUN              | `false`                                         |
| TOTAL CANDIDATES     | `1`                                             |
| REVOKED              | `1`                                             |
| SKIPPED              | `0`                                             |
| FAILED               | `0`                                             |

### 5.5 Verify the email was actually removed

Open the test folder in Drive. Click **Share**.

**Expected:** `rujimoralalita@gmail.com` is **no longer** in the
list. The role they previously held (Editor / Viewer / Commenter)
is gone.

If other accounts were on the folder (§2.4), they must be
unchanged.

### 5.6 Re-grant access for subsequent tests (optional)

If you want to re-run the live test or test other scenarios that
need the permission present:

1. Click **Share** on the folder.
2. Add `rujimoralalita@gmail.com` as **Editor**.
3. Save.

### 5.7 ACTION REQUIRED — revert DRY_RUN

In `config.gs`, change `DRY_RUN` back to `true`. Save.

---

## 6. Error Scenario Testing

Goal: confirm the system handles each documented failure mode
predictably. Eight scenarios.

### 6.1 The two-tier error model (read this first)

Your pipeline catches errors at **two different layers**, and they
show up differently in the log:

| Layer            | Where caught                                              | What appears in the log sheet                                                |
| ---------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------- |
| **Sheet-read**   | `sheetService._mapRowToRecord_` marks the record invalid. | The record is filtered out by `getEligibleCandidates()`. **No INTERN log row is written.** Only the wrapper's `summary.skippedReasons` count reflects it. |
| **Drive-revoke** | `main.runRevocationPipeline` try/catch + `driveService.revokeAccess` retry. | An **INTERN log row IS written** with the action / outcome code.             |

This means scenarios 6.2 – 6.5 (invalid / missing / Interning) are
**silent at the per-intern log level** — they only show up as
counters in the read wrapper. Scenarios 6.6 – 6.9 produce
individual INTERN log rows.

If you want to see the read-layer counts, change
`runRevocationPipeline` temporarily to call `readInternRecords()`
instead of `getEligibleCandidates()` and log the wrapper. Or
inspect the wrapper returned by `readInternRecords()` directly
from a test helper.

### 6.2 Scenario A — Invalid Folder Link (URL form)

**Setup.** In the test row, change `FOLDER LINK` to:

```
https://drive.google.com/open?id=1pr74bePbS-2UVheswybHPLHbBNDRxvbs
```

**Run.** `runSampleDryRun` (or `runRevocationPipeline`).

**Expected outcome.**

- **Eligibility:** `INELIGIBLE_INVALID`.
- **Error code:** `INVALID_FOLDER_URL_FORMAT`.
- **Per-intern log row:** NONE (filtered out before revoke).
- **Wrapper summary.skippedReasons:** `{ "INVALID_FOLDER_URL_FORMAT": 1 }`.
- **Pipeline summary:** `totalCandidates: 0`, all counters `0`.

**System behavior.** No Drive call. Run completes successfully.
Abort = false.

**Restore.** Revert `FOLDER LINK` to the original URL.

### 6.3 Scenario B — Missing Folder Link (empty cell)

**Setup.** Clear the `FOLDER LINK` cell for the test row.

**Expected outcome.**

- **Eligibility:** `INELIGIBLE_INVALID`.
- **Error code:** `INVALID_MISSING_FOLDER`.
- **Per-intern log row:** NONE.
- **Wrapper summary.skippedReasons:** `{ "INVALID_MISSING_FOLDER": 1 }`.

**System behavior.** Same as Scenario A.

**Restore.** Re-enter the original URL.

### 6.4 Scenario C — Missing Email (empty cell)

**Setup.** Clear the `EMAIL` cell for the test row.

**Expected outcome.**

- **Eligibility:** `INELIGIBLE_INVALID`.
- **Error code:** `INVALID_MISSING_EMAIL`.
- **Per-intern log row:** NONE.
- **Wrapper summary.skippedReasons:** `{ "INVALID_MISSING_EMAIL": 1 }`.

**Restore.** Re-enter `rujimoralalita@gmail.com`.

### 6.5 Scenario D — Internship Status = `Interning`

**Setup.** Change `INTERNSHIP STATUS` to `Interning`. Keep all
other fields valid.

**Expected outcome.**

- **Eligibility:** `INELIGIBLE_ACTIVE`.
- **Error code:** none (this is not an error, just an inactive
  status).
- **Per-intern log row:** NONE.
- **Wrapper summary.skippedReasons:** `{ "INELIGIBLE_ACTIVE": 1 }`.

**System behavior.** No Drive call. Active interns are never
revoked regardless of end date.

**Restore.** Change status back to `Completed`.

### 6.6 Scenario E — Supervisor email in whitelist

**Setup.** Two options:

1. **Modify the test row's email** to a supervisor email from the
   Supervisor sheet (e.g. `aranya.k@vannessplus.com`). Requires
   the matching account to currently have access to the test
   folder, or the result will be `ALREADY_REVOKED` not
   `SKIPPED_EXCEPTION_USER`.
2. **Add `rujimoralalita@gmail.com` to the Supervisor sheet's
   `EMAIL` column.** This is cleaner — the test row stays intact.

Use option 2 if you can.

**Run.** `runSampleDryRun` (dry-run is fine — the exception check
fires before the dry-run short-circuit).

**Expected outcome.**

- **Eligibility:** `ELIGIBLE` (passes sheet validation; the
  supervisor check is enforced at revoke time).
- **Per-intern log row:** YES.
- **ACTION:** `SKIPPED_EXCEPTION_USER`.
- **OUTCOME:** `success`.
- **MESSAGE:** (blank).
- **Pipeline summary:** `skipped: 1`.

**System behavior.** No Drive mutation, even in live mode. The
exception check is the first thing `revokeAccess` does after
input validation.

**Restore.** Remove the email from the Supervisor sheet.

### 6.7 Scenario F — Folder access already removed

**Setup.** Make sure the test row is fully valid (email, folder
link, status = `Completed`, end date in the past). Manually remove
`rujimoralalita@gmail.com` from the test folder via **Share →
remove**.

**Run.** `runRevocationPipeline` (live, `DRY_RUN = false`). Or
use dry-run; both produce equivalent outcome codes for this
scenario, but live mode is more representative.

**Expected outcome.**

- **Per-intern log row:** YES.
- **ACTION:** `ALREADY_REVOKED_PROVISIONED` (because `TRACKING
  STATUS` = `Access Shared`).
- **OUTCOME:** `success`.
- **MESSAGE:** `No permission found, but TRACKING STATUS was
  "Access Shared" — expected a permission to exist.`
- **Pipeline summary:** `alreadyRevoked: 1`.

> **Variant:** if you also clear `TRACKING STATUS`, the action
> becomes `ALREADY_REVOKED` (no `_PROVISIONED` suffix) and the
> message becomes blank.

**System behavior.** Treated as success — idempotent. No error.

**Restore.** Re-add the email as Editor if you want to re-run
other tests.

### 6.8 Scenario G — Folder does not exist

**Setup.** Change the `FOLDER LINK` to a URL whose ID does not
exist. Use a plausible-looking but fake ID, e.g.:

```
https://drive.google.com/drive/folders/00000000000000000000000000000000000
```

(The 33-character zero string is syntactically valid but does not
resolve to any folder.)

**Run.** `runRevocationPipeline` (live, `DRY_RUN = false`). In
dry-run, the dry-run short-circuit fires before the folder open,
so you would not see `FOLDER_NOT_ACCESSIBLE`.

**Expected outcome.**

- **Per-intern log row:** YES.
- **ACTION:** `FOLDER_NOT_ACCESSIBLE`.
- **OUTCOME:** `failure`.
- **MESSAGE:** Contains the underlying Drive error text (something
  like `getFolderById failed after 4 attempts: ... not found ...`).
- **Pipeline summary:** `failed: 1`.

**System behavior.** The run continues — one failure does not
abort the pipeline. The retry loop in `_withRetry_` attempts the
open up to `DRIVE_MAX_RETRIES + 1` = 4 times before giving up.

**Restore.** Revert `FOLDER LINK`.

### 6.9 Scenario H — Permission not found (folder exists, email never had access)

**Setup.** Use a different folder (any folder the script owner can
access) that `rujimoralalita@gmail.com` has never been added to.
Place its URL in the test row's `FOLDER LINK`.

**Run.** `runRevocationPipeline` (live).

**Expected outcome.**

- **Per-intern log row:** YES.
- **ACTION:** `ALREADY_REVOKED_PROVISIONED` (because `TRACKING
  STATUS` = `Access Shared`, signalling the system expected a
  permission to be there).
- **OUTCOME:** `success`.
- **MESSAGE:** `No permission found, but TRACKING STATUS was
  "Access Shared" — expected a permission to exist.`
- **Pipeline summary:** `alreadyRevoked: 1`.

**System behavior.** Same idempotent path as Scenario F.

**Restore.** Revert `FOLDER LINK` to the test folder.

---

## 7. Trigger Testing

Goal: confirm the daily time-driven trigger installs and uninstalls
cleanly, and that `onScheduledRun` delegates correctly.

### 7.1 `testTriggerInstall`

This is the safest starting point — it installs the trigger and
then lists every project trigger so you can verify.

**Run.** In the Apps Script editor, select **`testTriggerInstall`**
from the function dropdown. Click **Run**.

**Expected console output:**

```
testTriggerInstall: installing (or confirming) trigger...
testTriggerInstall: result={"installed":true,"existingTriggerId":null}
testTriggerInstall: current project triggers:
[
  {
    "handler": "onScheduledRun",
    "type": "CLOCK",
    "id": "<some-long-id>"
  }
]
```

(Run it again and the first line of `result` becomes
`{"installed":false,"existingTriggerId":"<id>"}` — the duplicate
guard is working.)

### 7.2 Verify in the Apps Script UI

Open the project's triggers page: in the Apps Script editor, click
the **Triggers** icon (clock symbol) in the left sidebar, or go to
**sidebar → Triggers**.

You should see one row:

| Function         | Event source | Type   | Time of day      |
| ---------------- | ------------ | ------ | ---------------- |
| `onScheduledRun` | Time-driven  | Day    | `2:00 AM to 3:00 AM` (or similar; `nearMinute` widens the window) |

The timezone shown is the script project's timezone (set in the
Apps Script IDE or `appsscript.json`), which should match
`SCRIPT_TIMEZONE = 'Asia/Bangkok'`.

### 7.3 Test `onScheduledRun` directly (without waiting for 02:00)

You do not need to wait for the schedule to fire. You can simulate
it from the IDE.

**Run.** Select **`onScheduledRun`** from the function dropdown.
Click **Run**.

**Expected console output:**

```
onScheduledRun completed: {"runId":"R-...","triggerSource":"SCHEDULED","dryRun":true,"totalCandidates":1,"skipped":1,"aborted":false,...}
```

Note `triggerSource: SCHEDULED` — this is what a real scheduled
invocation will look like in the log sheet. A new pair of
INTERN + RUN_SUMMARY rows is appended with `TRIGGER SOURCE =
SCHEDULED`.

### 7.4 What a real scheduled run will do

Once the trigger is installed, at the next 02:00 ICT Apps Script
will automatically invoke `onScheduledRun`. The function:

1. Calls `runRevocationPipeline(TRIGGER_SOURCE.SCHEDULED)`.
2. Logs the summary on success, OR logs and re-throws on failure
   (so the Apps Script runtime records the failure and emails the
   script owner).

You will not be at the IDE when this happens. The artefact to
inspect afterward is the `AccessRevocationLog` sheet — look for
rows where `TRIGGER SOURCE = SCHEDULED`.

### 7.5 Remove the trigger

**Run.** Select **`uninstallTrigger`** from the function dropdown.
Click **Run**.

**Expected console output:**

```
uninstallTrigger: removed 1 trigger(s).
```

**Verify.** Refresh the **Triggers** page in the Apps Script IDE.
The list should be empty.

### 7.6 `installTrigger` directly

You can also call `installTrigger` directly (without
`testTriggerInstall`). The difference:

- `installTrigger` only installs; it does not list triggers.
- `testTriggerInstall` calls `installTrigger` then lists all
  project triggers, so you can see what else is registered.

For day-to-day use, `installTrigger` is the production entry
point.

---

## 8. Final Acceptance Checklist

Fill the **Actual Result** and **Pass/Fail** columns as you work
through each section. The **Expected Result** column is the
single-sentence definition of done for that test.

| #   | Test Case                                              | Expected Result                                                                 | Actual Result | Pass/Fail |
| --- | ------------------------------------------------------ | ------------------------------------------------------------------------------- | ------------- | --------- |
| 1   | Workbook has `Timeline` and `Supervisor` tabs          | Both tabs present                                                               |               |           |
| 2   | Timeline headers match `COLUMN_MAPPING`                | All 5 required headers present and exact                                        |               |           |
| 3   | Test row is `ELIGIBLE` per §1.6 manual trace           | All checks pass                                                                 |               |           |
| 4   | Test folder accessible by script owner as Editor       | Share dialog lists `nannapat.pu@ku.th` as Editor                                |               |           |
| 5   | `rujimoralalita@gmail.com` currently on folder         | Share dialog lists the intern email                                             |               |           |
| 6   | Apps Script project bound, 7 source files pasted       | All files visible in left panel                                                 |               |           |
| 7   | OAuth scopes authorised                                | First run completes without permission error                                    |               |           |
| 8   | Dry run via `runSampleDryRun`                          | Summary returns `totalCandidates: 1, skipped: 1, dryRun: true`                  |               |           |
| 9   | Dry-run INTERN log row                                 | `ACTION: DRY_RUN`, `OUTCOME: success`, correct folder ID                        |               |           |
| 10  | Dry-run RUN_SUMMARY log row                            | Counts match §4.3                                                               |               |           |
| 11  | Drive folder unchanged after dry run                   | `rujimoralalita@gmail.com` still on folder with same role                       |               |           |
| 12  | Live run via `runRevocationPipeline` (DRY_RUN=false)   | Summary returns `totalCandidates: 1, revoked: 1, dryRun: false`                 |               |           |
| 13  | Live-run INTERN log row                                | `ACTION: REVOKED`, `OUTCOME: success`, blank message                            |               |           |
| 14  | Live-run RUN_SUMMARY log row                           | Counts match §5.4                                                               |               |           |
| 15  | Drive folder updated after live run                    | `rujimoralalita@gmail.com` no longer in Share dialog                            |               |           |
| 16  | `DRY_RUN` reverted to `true` after live test           | config.gs line 283 reads `const DRY_RUN = true;`                                |               |           |
| 17  | Scenario A: Invalid Folder Link                        | `INVALID_FOLDER_URL_FORMAT` in wrapper; no INTERN row                           |               |           |
| 18  | Scenario B: Missing Folder Link                        | `INVALID_MISSING_FOLDER` in wrapper; no INTERN row                              |               |           |
| 19  | Scenario C: Missing Email                              | `INVALID_MISSING_EMAIL` in wrapper; no INTERN row                               |               |           |
| 20  | Scenario D: Status = Interning                         | `INELIGIBLE_ACTIVE` in wrapper; no INTERN row                                   |               |           |
| 21  | Scenario E: Supervisor in whitelist                    | INTERN row, `ACTION: SKIPPED_EXCEPTION_USER`                                    |               |           |
| 22  | Scenario F: Folder access already removed              | INTERN row, `ACTION: ALREADY_REVOKED_PROVISIONED`                               |               |           |
| 23  | Scenario G: Folder does not exist                      | INTERN row, `ACTION: FOLDER_NOT_ACCESSIBLE`, `OUTCOME: failure`                 |               |           |
| 24  | Scenario H: Permission not found                       | INTERN row, `ACTION: ALREADY_REVOKED_PROVISIONED`                               |               |           |
| 25  | `testTriggerInstall` creates one CLOCK trigger         | Console shows `installed: true` + one row in trigger list                       |               |           |
| 26  | `testTriggerInstall` is idempotent                     | Second run shows `installed: false, existingTriggerId: <id>`                    |               |           |
| 27  | `onScheduledRun` runs end-to-end                       | New log rows with `TRIGGER SOURCE: SCHEDULED`                                   |               |           |
| 28  | `uninstallTrigger` removes the trigger                 | Console shows `removed: 1`; trigger list empty                                  |               |           |

---

## 9. Deployment Readiness Review

### 9.1 What is ready for supervisor demonstration

The implementation is functionally complete and ready for a
**dry-run demonstration** to the supervisor. Specifically:

- The full pipeline runs end-to-end: read → validate → filter →
  (skip | revoke | report) → log → flush.
- Sheet-read validation correctly excludes records with missing or
  malformed required fields.
- Drive-revoke correctly distinguishes `REVOKED`,
  `ALREADY_REVOKED`, `ALREADY_REVOKED_PROVISIONED`,
  `SKIPPED_EXCEPTION_USER`, `FOLDER_NOT_ACCESSIBLE`, `DRIVE_API_ERROR`,
  and `DRY_RUN`.
- Per-intern failures are isolated — one bad row never aborts a run.
- The dynamic supervisor allowlist loads from the Supervisor sheet
  on every run and is enforced inside `revokeAccess`, so the safety
  net is active even when invoked outside the pipeline.
- The log sheet is auto-created with a stable, documented schema.
- The time-driven trigger installs idempotently and uninstalls
  cleanly.

### 9.2 Conditions for the demonstration

Before showing this to a supervisor, confirm:

1. All 28 checklist items in §8 are **Pass**.
2. `DRY_RUN = true` in config (default state).
3. `EXCEPTION_EMAILS` is either empty (the supervisor sheet covers
   it) OR populated with the static allowlist per Q-06.
4. The supervisor who will see the demonstration has at least
   Commenter access to the workbook so they can read
   `AccessRevocationLog`.

### 9.3 What is NOT ready for production go-live

Three items from `docs/OpenQuestions.md` remain genuinely open and
block a production live deployment (NOT a dry-run demo):

| Open item | Why it blocks production live |
| --------- | ----------------------------- |
| **Q-04** — per-intern write-back column on Timeline | Without it, idempotency depends on the log sheet alone. Adequate for a dry-run demo; tighter idempotency wanted before daily live runs. |
| **Q-06** — full exception allowlist contents | The Supervisor sheet covers supervisors. IT admin accounts and any other non-revokable accounts still need to be confirmed and added (either to `EXCEPTION_EMAILS` or to the Supervisor sheet). |
| **Q-09** — long-term script-owner account | `nannapat.pu@ku.th` is fine for dev/test. A dedicated functional account should own the script before daily live runs so a single person leaving does not break the schedule (R-05). |

None of these block a dry-run demonstration. They block flipping
`DRY_RUN = false` in production.

### 9.4 Risks specific to the supervisor demonstration

| Risk                                                                | Likelihood | Mitigation                                                                          |
| ------------------------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------- |
| OAuth consent screen confuses the supervisor ("Google hasn't verified this app") | High       | Pre-walk them through the consent screen; explain that internal scripts are not reviewed by Google. |
| Wrong Google account is selected when the IDE opens, so the folder open fails with `FOLDER_NOT_ACCESSIBLE` | Medium     | Confirm the account avatar in the top-right of the Apps Script IDE before clicking Run. |
| `DRY_RUN` is accidentally `false` during the demo                   | Low        | Use `runSampleDryRun` (forces dry-run regardless of config) rather than `runRevocationPipeline`. |
| The `AccessRevocationLog` sheet has accumulated many test rows      | Low        | Right-click the tab → Delete before the demo. It will be recreated on first run.   |
| The trigger fires mid-demo (if installed earlier and you forgot to uninstall) | Low        | Run `uninstallTrigger` before the demo, or accept it as a feature demonstration.   |
| Drive API rate-limit mid-run (unlikely at single-intern scale)      | Very low   | Already mitigated by exponential back-off in `_withRetry_`. Will surface as `DRIVE_API_ERROR` with a clear message. |

### 9.5 Recommended go-forward

1. Complete every checklist item in §8.
2. Schedule a dry-run demonstration with the supervisor. Walk
   through one dry run, then the resulting log sheet.
3. After the demo, collect decisions on Q-04, Q-06, and Q-09.
4. Implement write-back (per Q-04) and the long-term owner
   provisioning (per Q-09).
5. Re-run §4 and §5 against a known-staging workbook before
   flipping `DRY_RUN = false` in production.

The implementation is at the "demonstration-ready" threshold.
Production live is one supervisor meeting away.
