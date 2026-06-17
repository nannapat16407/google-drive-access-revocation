/**
 * @fileoverview Centralised configuration for the Google Drive Access
 * Revocation system.
 *
 * This file is the single source of truth for every tunable parameter.
 * Business logic in other modules MUST NOT hard-code IDs, schedules,
 * thresholds, or column letters — it reads them from here.
 *
 * Operators can change behaviour (point at a different workbook, flip
 * dry-run mode, adjust the grace period, add an exception user) by
 * editing this file alone, with no logic changes elsewhere.
 *
 * Confirmed assumptions for this revision (from project supervisor):
 *   - Source sheet          : Timeline
 *   - Permission type       : Direct Share (by email)
 *   - Folder scope          : Main folder only (no recursive walk)
 *   - Email notifications   : None
 *   - Trigger cadence       : Daily
 *
 * Sections:
 *   1. Workbook identity
 *   2. Sheet names
 *   3. Column mapping (spreadsheet header  ->  internal field)
 *   4. Status enums
 *   5. Validation constants (regexes, prefixes)
 *   6. Date handling
 *   7. Error codes (controlled vocabulary — log-sheet filter keys)
 *   8. Eligibility enum
 *   9. Operational parameters
 *  10. Trigger schedule (constants only; triggerService.gs is not yet
 *      implemented)
 */

// =============================================================================
// 1. Workbook identity
// =============================================================================

/**
 * Google Sheets file ID of the production workbook. Extracted from the
 * sheet's URL:  https://docs.google.com/spreadsheets/d/<ID>/edit
 * @type {string}
 */
const SPREADSHEET_ID = '1AOjCbe6WL41I-jUa7R762Y4D-5AAc3VnIfM7qrsmAkU';

// =============================================================================
// 2. Sheet names
// =============================================================================

/**
 * Name of the sheet treated as the source of truth for internship records.
 * Per confirmed assumption: `Timeline`.
 *
 * Do not change without also updating COLUMN_MAPPING below and re-running
 * the schema check performed by sheetService._buildColumnIndex_().
 * @type {string}
 */
const SOURCE_SHEET_NAME = 'Timeline';

/**
 * Name of the sheet used for execution logs (one row per intern per run,
 * plus one summary row per run). The sheet is created lazily by the
 * log service (not yet implemented) if it does not exist.
 * @type {string}
 */
const LOG_SHEET_NAME = 'AccessRevocationLog';

// =============================================================================
// 3. Column mapping
// =============================================================================

/**
 * Maps each internal field name to its spreadsheet column.
 *
 *   - `header`   : exact text expected in row 1 of the sheet.
 *   - `column`   : column letter, used as a fallback if `header` lookup
 *                  fails AND as documentation of expected position.
 *   - `required` : whether the revocation pipeline needs this field
 *                  populated to consider the row for processing.
 *
 * Keep this in sync with docs/DataDictionary.md §1 and §2. Any change
 * here is a schema change and should be reflected in the docs.
 * @type {Object<string, {header: string, column: string, required: boolean}>}
 */
const COLUMN_MAPPING = {
  position:            { header: 'POSITION',            column: 'A', required: false },
  fullName:            { header: 'NAME',                column: 'B', required: true  },
  nickname:            { header: 'NICKNAME',            column: 'C', required: false },
  internshipStartDate: { header: 'START',               column: 'D', required: false },
  internshipEndDate:   { header: 'END',                 column: 'E', required: true  },
  phone:               { header: 'TEL',                 column: 'F', required: false },
  lineId:              { header: 'LINE',                column: 'G', required: false },
  internEmail:         { header: 'EMAIL',               column: 'H', required: true  },
  university:          { header: 'UNIVERSITY',          column: 'I', required: false },
  workMode:            { header: 'WORKMODE',            column: 'J', required: false },
  internshipStatus:    { header: 'INTERNSHIP STATUS',   column: 'K', required: true  },
  folderLink:          { header: 'FOLDER LINK',         column: 'L', required: true  },
  firstDayWorkMode:    { header: 'FIRST DAY WORK MODE', column: 'M', required: false },
  trackingStatus:      { header: 'TRACKING STATUS',     column: 'N', required: false },
  emailStatus:         { header: 'EMAIL STATUS',        column: 'O', required: false }
};

// =============================================================================
// 4. Status enums
// =============================================================================

/**
 * INTERNSHIP STATUS values that mark an intern as offboarded and
 * therefore potentially eligible for revocation (subject to the date
 * and grace-period checks). See docs/DataDictionary.md §1.11.
 * @type {string[]}
 */
const STATUS_OFFBOARDED = ['Completed', 'Withdraw'];

/**
 * INTERNSHIP STATUS values that mark an intern as still active. These
 * records are never revoked, regardless of end date.
 * @type {string[]}
 */
const STATUS_ACTIVE = ['Interning', 'Pending'];

/**
 * Allowed values for the INTERNSHIP STATUS column. Union of the two
 * sets above. Used by sheetService for enum validation.
 * @type {string[]}
 */
const ALLOWED_INTERNSHIP_STATUSES = STATUS_OFFBOARDED.concat(STATUS_ACTIVE);

/**
 * Allowed values for the WORKMODE column. Unknown values are passed
 * through unchanged and logged at WARN, not rejected.
 * @type {string[]}
 */
const ALLOWED_WORKMODES = ['Hybrid', 'WFO', 'WFH'];

/**
 * Allowed values for the TRACKING STATUS column. Empty is also valid.
 * @type {string[]}
 */
const ALLOWED_TRACKING_STATUSES = ['Access Shared'];

/**
 * Allowed values for the EMAIL STATUS column. Empty is also valid.
 * @type {string[]}
 */
const ALLOWED_EMAIL_STATUSES = ['Success'];

// =============================================================================
// 5. Validation constants
// =============================================================================

/**
 * Regex for a basic but sufficient email shape check. Matches the rule
 * documented in docs/DataDictionary.md §1.8.
 *
 * The pipeline canonicalises stored emails to trimmed lowercase before
 * matching, so the regex itself is case-sensitive.
 * @type {RegExp}
 */
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Prefix shared by every accepted Drive folder URL. Used for cheap
 * pre-screening before running the regex.
 * @type {string}
 */
const FOLDER_URL_PREFIX = 'https://drive.google.com/drive/folders/';

/**
 * Regex that matches a Drive folder URL and captures the folder ID
 * (the segment immediately after `/folders/`, terminated by `?`, `/`,
 * or end-of-string). Folder IDs may contain letters, digits,
 * underscores, and hyphens.
 *
 * File URLs (`/file/d/`) and the legacy `open?id=` form are
 * intentionally NOT matched — they are rejected with
 * INVALID_FOLDER_URL_FORMAT per docs/DataDictionary.md §1.12.
 * @type {RegExp}
 */
const FOLDER_URL_REGEX = /^https:\/\/drive\.google\.com\/drive\/folders\/([\w\-]+)/;

// =============================================================================
// 6. Date handling
// =============================================================================

/**
 * IANA timezone for calendar-date comparisons. The production workbook
 * is maintained from Thailand, so we evaluate end dates in ICT to avoid
 * off-by-one revocations near midnight.
 *
 * Used by Utilities.formatDate() when converting native Date objects to
 * YYYY-MM-DD strings.
 * @type {string}
 */
const SCRIPT_TIMEZONE = 'Asia/Bangkok';

/**
 * Calendar-date format used for serialisation in the JSON contract.
 * Discards any time-of-day component.
 * @type {string}
 */
const DATE_FORMAT_ISO = 'yyyy-MM-dd';

/**
 * Human-readable text-date formats the parser will attempt, in order,
 * before rejecting a string cell. Locale is forced to en_US so month
 * names resolve consistently regardless of the script's runtime locale.
 * @type {string[]}
 */
const TEXT_DATE_FORMATS = ['MMM d, yyyy', 'MMMM d, yyyy'];

// =============================================================================
// 7. Error codes (controlled vocabulary — log-sheet filter keys)
// =============================================================================

/**
 * Stable identifiers for every per-record validation failure. These
 * strings are persisted verbatim into the log sheet and used by
 * operators to filter — they MUST NOT be reworded without a
 * coordinated log-sheet migration.
 *
 * Source of truth: docs/DataDictionary.md §4.6.
 * @enum {string}
 */
const ERROR_CODES = {
  MISSING_NAME:        'INVALID_MISSING_NAME',
  MISSING_EMAIL:       'INVALID_MISSING_EMAIL',
  EMAIL_FORMAT:        'INVALID_EMAIL_FORMAT',
  END_DATE:            'INVALID_END_DATE',
  START_DATE:          'INVALID_START_DATE',
  MISSING_STATUS:      'INVALID_MISSING_STATUS',
  STATUS_VALUE:        'INVALID_STATUS_VALUE',
  MISSING_FOLDER:      'INVALID_MISSING_FOLDER',
  FOLDER_URL_FORMAT:   'INVALID_FOLDER_URL_FORMAT',
  FOLDER_ID:           'INVALID_FOLDER_ID'
};

// =============================================================================
// 8. Eligibility enum
// =============================================================================

/**
 * Stable identifiers for the per-record eligibility outcome. Persisted
 * into the log sheet; do not reword.
 *
 * Source of truth: docs/DataDictionary.md §3.4.
 * @enum {string}
 */
const ELIGIBILITY = {
  ELIGIBLE:      'ELIGIBLE',
  NOT_ENDED:     'INELIGIBLE_NOT_ENDED',
  ACTIVE:        'INELIGIBLE_ACTIVE',
  ALREADY:       'INELIGIBLE_ALREADY',
  EXCEPTION:     'INELIGIBLE_EXCEPTION',
  INVALID:       'INELIGIBLE_INVALID'
};

// =============================================================================
// 9. Operational parameters
// =============================================================================

/**
 * Number of days to wait after an intern's END date before revoking
 * access. Provides a buffer for late handovers, appeals, or supervisor
 * overrides.
 *
 * A value of 0 means access is revoked the day AFTER the end date
 * (records whose endDate is strictly before today are eligible).
 *
 * Pending stakeholder confirmation in docs/OpenQuestions.md Q-05.
 * @type {number}
 */
const GRACE_PERIOD_DAYS = 0;

/**
 * When true, the pipeline computes the candidate set and produces
 * complete logs but performs NO Drive mutations. Recommended true for
 * first deployments and any time the column mapping or source sheet
 * changes.
 *
 * The driveService module (not yet implemented) MUST honour this flag.
 * @type {boolean}
 */
const DRY_RUN = true;

/**
 * Allowlist of email addresses that must NEVER be revoked, regardless
 * of input data. Matches after canonicalisation (trim + lowercase).
 *
 * Pending stakeholder confirmation in docs/OpenQuestions.md Q-06.
 * Populate with supervisor / IT-admin addresses before going live.
 * @type {string[]}
 */
const EXCEPTION_EMAILS = [];

/**
 * Email addresses to receive run-summary notifications. Per the
 * confirmed project assumption "No Notifications", this is empty —
 * the notification code path (when implemented) will be a no-op.
 *
 * If notifications are later enabled via docs/OpenQuestions.md Q-07,
 * populate this array.
 * @type {string[]}
 */
const NOTIFICATION_RECIPIENTS = [];

// =============================================================================
// 10. Trigger schedule (constants only; triggerService.gs not yet implemented)
// =============================================================================

/**
 * Hours of the day, in SCRIPT_TIMEZONE, at which the daily trigger
 * fires. Recommended 02:00 (off-hours, low Drive API contention).
 *
 * Used by the future triggerService.installTrigger() to build a
 * ScriptApp.newTrigger() time-based trigger.
 * @type {number}
 */
const TRIGGER_HOUR = 2;

/**
 * Minutes past TRIGGER_HOUR for the daily fire time. Picked off the
 * half-hour / quarter-hour marks to spread load across the script
 * runtime fleet.
 * @type {number}
 */
const TRIGGER_MINUTE = 0;

// =============================================================================
// 11. Supervisor sheet (source for the dynamic exception allowlist)
// =============================================================================

/**
 * Name of the sheet that lists program supervisors. Used by
 * sheetService.readSupervisorEmails() to populate the dynamic exception
 * allowlist that supplements EXCEPTION_EMAILS above. main.gs merges the
 * two lists and publishes them to driveService via setExceptionEmails()
 * at the start of every run.
 *
 * Verified against the production workbook on 2026-06-16: the sheet
 * exists with headers `NAME`, `NICKNAME`, `JOB TITLE`, `EMAIL`, `TEL`
 * and contains 3 supervisor rows.
 * @type {string}
 */
const SUPERVISOR_SHEET_NAME = 'Supervisor';

/**
 * Header text used to locate the email column in the Supervisor sheet.
 * Matching is by exact trimmed text, case-sensitive. If the header is
 * absent, readSupervisorEmails() returns an empty array rather than
 * throwing — supervisors are a safety net, not a hard dependency.
 * @type {string}
 */
const SUPERVISOR_EMAIL_HEADER = 'EMAIL';
