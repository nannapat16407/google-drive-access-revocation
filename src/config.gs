/**
 * @fileoverview Central config for the Drive access revocation system.
 *
 * Confirmed assumptions:
 *   - Source sheet    : Timeline
 *   - Permission type : Direct Share (by email)
 *   - Folder scope    : Main folder only (no recursive walk)
 *   - Email notifications : None
 *   - Trigger cadence : Daily
 *
 * Sections:
 *   1. Workbook identity
 *   2. Sheet names
 *   3. Column mapping
 *   4. Status enums
 *   5. Validation constants
 *   6. Date handling
 *   7. Error codes
 *   8. Eligibility enum
 *   9. Operational parameters
 *  10. Trigger schedule
 */

// =============================================================================
// 1. Workbook identity
// =============================================================================

/**
 * Google Sheets ID for production workbook.
 * @type {string}
 */
const SPREADSHEET_ID = '1AOjCbe6WL41I-jUa7R762Y4D-5AAc3VnIfM7qrsmAkU';

// =============================================================================
// 2. Sheet names
// =============================================================================

/**
 * Source-of-truth sheet for internship records.
 * @type {string}
 */
const SOURCE_SHEET_NAME = 'Timeline';

/**
 * Sheet for execution logs. Created lazily if missing.
 * @type {string}
 */
const LOG_SHEET_NAME = 'AccessRevocationLog';

// =============================================================================
// 3. Column mapping
// =============================================================================

/**
 * Maps internal field names to spreadsheet columns.
 *   - `header`   : row-1 text to match.
 *   - `column`   : fallback letter / position doc.
 *   - `required` : whether the pipeline requires this field.
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
 * INTERNSHIP STATUS values marking an intern as offboarded (potentially eligible).
 * @type {string[]}
 */
const STATUS_OFFBOARDED = ['Completed', 'Withdraw'];

/**
 * INTERNSHIP STATUS values marking an intern as active. Never revoked.
 * @type {string[]}
 */
const STATUS_ACTIVE = ['Interning', 'Pending'];

/**
 * Allowed INTERNSHIP STATUS values (union of offboarded + active).
 * @type {string[]}
 */
const ALLOWED_INTERNSHIP_STATUSES = STATUS_OFFBOARDED.concat(STATUS_ACTIVE);

/**
 * Allowed WORKMODE values. Unknown values pass through with a WARN.
 * @type {string[]}
 */
const ALLOWED_WORKMODES = ['Hybrid', 'WFO', 'WFH'];

/**
 * Allowed TRACKING STATUS values. Empty is also valid.
 * @type {string[]}
 */
const ALLOWED_TRACKING_STATUSES = ['Access Shared'];

/**
 * Allowed EMAIL STATUS values. Empty is also valid.
 * @type {string[]}
 */
const ALLOWED_EMAIL_STATUSES = ['Success'];

// =============================================================================
// 5. Validation constants
// =============================================================================

/**
 * Email shape check. Case-sensitive; emails are lowercased before matching.
 * @type {RegExp}
 */
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Prefix shared by every accepted Drive folder URL.
 * @type {string}
 */
const FOLDER_URL_PREFIX = 'https://drive.google.com/drive/folders/';

/**
 * Matches a Drive folder URL and captures the folder ID.
 * File URLs (`/file/d/`) and `open?id=` are rejected with INVALID_FOLDER_URL_FORMAT.
 * @type {RegExp}
 */
const FOLDER_URL_REGEX = /^https:\/\/drive\.google\.com\/drive\/folders\/([\w\-]+)/;

// =============================================================================
// 6. Date handling
// =============================================================================

/**
 * IANA timezone for date comparisons (production workbook is maintained from Thailand).
 * @type {string}
 */
const SCRIPT_TIMEZONE = 'Asia/Bangkok';

/**
 * ISO date format for serialisation.
 * @type {string}
 */
const DATE_FORMAT_ISO = 'yyyy-MM-dd';

/**
 * Text-date formats the parser attempts, in order. Locale forced to en_US.
 * @type {string[]}
 */
const TEXT_DATE_FORMATS = ['MMM d, yyyy', 'MMMM d, yyyy'];

// =============================================================================
// 7. Error codes (controlled vocabulary — log-sheet filter keys)
// =============================================================================

/**
 * Stable per-record validation failure codes. Persisted to the log sheet —
 * do NOT reword without a coordinated migration.
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
 * Stable per-record eligibility outcomes. Persisted to the log sheet — do NOT reword.
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
 * Days to wait after END date before revoking. 0 = revoke the day after END.
 * @type {number}
 */
const GRACE_PERIOD_DAYS = 0;

/**
 * When true, computes candidates and writes logs but performs NO Drive mutations.
 * @type {boolean}
 */
const DRY_RUN = true;

/**
 * Emails that must NEVER be revoked. Matched after trim + lowercase.
 * @type {string[]}
 */
const EXCEPTION_EMAILS = [];

/**
 * Notification recipients. Empty per "No Notifications" assumption.
 * @type {string[]}
 */
const NOTIFICATION_RECIPIENTS = [];

// =============================================================================
// 10. Trigger schedule
// =============================================================================

/**
 * Hour (in SCRIPT_TIMEZONE) the daily trigger fires. Recommended 02:00.
 * @type {number}
 */
const TRIGGER_HOUR = 2;

/**
 * Minutes past TRIGGER_HOUR.
 * @type {number}
 */
const TRIGGER_MINUTE = 0;

// =============================================================================
// 11. Supervisor sheet (dynamic exception allowlist source)
// =============================================================================

/**
 * Sheet listing program supervisors. Source for the dynamic exception allowlist
 * merged with EXCEPTION_EMAILS at the start of every run.
 * @type {string}
 */
const SUPERVISOR_SHEET_NAME = 'Supervisor';

/**
 * Header text used to locate the email column in the Supervisor sheet.
 * If absent, readSupervisorEmails() returns [] (safety net, not a hard dependency).
 * @type {string}
 */
const SUPERVISOR_EMAIL_HEADER = 'EMAIL';
