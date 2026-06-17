/**
 * @fileoverview Structured execution logging for audit and troubleshooting.
 *
 * Responsibility:
 *   - Persist one log row per intern processed, capturing: run ID,
 *     timestamp, intern identifier (name + sheet row), email, folder ID,
 *     action code, outcome, and any error message.
 *   - Persist a single run-summary row per invocation, capturing run
 *     metadata (started-at, ended-at, duration, trigger source, dry-run
 *     flag) and aggregated counts (total candidates, revoked, already
 *     revoked, skipped, failed).
 *   - Provide a thin in-memory buffer so that a single invocation
 *     flushes once at the end, minimising Sheets API quota usage
 *     (NFR-R3 in docs/Requirement.md).
 *
 * Single-sheet, two-row-type design:
 *   Intern rows and run-summary rows share one schema (LOG_COLUMNS).
 *   For an INTERN row, the summary-specific columns are written as
 *   blanks; for a RUN_SUMMARY row, the intern-specific columns are
 *   written as blanks. This keeps the append path a single batched
 *   `setValues()` call regardless of row mix.
 *
 * Public API:
 *   - startRun(opts?)              -> RunContext
 *   - recordInternResult(entry)    -> void
 *   - endRun(summary)              -> { runId, endedAt, durationMs }
 *   - flush()                      -> number of rows written
 *
 * Dependencies: config.gs (SPREADSHEET_ID, LOG_SHEET_NAME,
 *               SCRIPT_TIMEZONE, DRY_RUN).
 *
 * Idempotency / sequencing:
 *   - startRun must be called before recordInternResult or endRun.
 *     Calling them out of order throws — defensive against silent
 *     data loss.
 *   - flush is independent of run state. It writes whatever is in
 *     the buffer. Safe to call multiple times.
 *   - Module state does NOT persist across Apps Script invocations,
 *     so _currentRun and _buffer start empty on every trigger fire.
 */

// =============================================================================
// Tunable constants (module-local)
// =============================================================================

/**
 * Format string used for timestamps written to the log sheet.
 * Produces ISO-8601 in SCRIPT_TIMEZONE, e.g. "2026-06-16T14:30:00+07:00".
 * @type {string}
 */
const LOG_TIMESTAMP_FORMAT = "yyyy-MM-dd'T'HH:mm:ssXXX";

/**
 * Defines the log sheet schema. Each entry produces one column. The
 * order here is the column order in the sheet.
 *
 * Schema evolution rules:
 *   - New columns MUST be appended at the end. Never insert in the
 *     middle — historical rows would silently shift under the new
 *     headers.
 *   - Existing headers MUST NOT be reworded. Operators filter by them.
 *   - When adding a column, existing rows (written before the column
 *     existed) will simply have a blank cell in the new column. The
 *     header is rewritten only when the sheet is created from scratch;
 *     pre-existing sheets keep their original headers.
 *
 * The shared-schema design means intern rows write blanks into the
 * summary-specific fields, and summary rows write blanks into the
 * intern-specific fields. The `rowType` column is the discriminator.
 *
 * @type {Array<{field: string, header: string}>}
 */
const LOG_COLUMNS = [
  // Columns shared by both row types — always populated.
  { field: 'rowType',             header: 'ROW TYPE' },
  { field: 'runId',               header: 'RUN ID' },
  { field: 'timestamp',           header: 'TIMESTAMP' },
  { field: 'triggerSource',       header: 'TRIGGER SOURCE' },
  { field: 'dryRun',              header: 'DRY RUN' },

  // Intern-specific columns. Blank on RUN_SUMMARY rows.
  { field: 'fullName',            header: 'FULL NAME' },
  { field: 'rowNumber',           header: 'ROW NUMBER' },
  { field: 'internEmail',         header: 'INTERN EMAIL' },
  { field: 'folderId',            header: 'FOLDER ID' },
  { field: 'action',              header: 'ACTION' },
  { field: 'outcome',             header: 'OUTCOME' },
  { field: 'message',             header: 'MESSAGE' },

  // Run-summary-specific columns. Blank on INTERN rows.
  { field: 'startedAt',           header: 'STARTED AT' },
  { field: 'endedAt',             header: 'ENDED AT' },
  { field: 'durationMs',          header: 'DURATION (MS)' },
  { field: 'totalCandidates',     header: 'TOTAL CANDIDATES' },
  { field: 'revokedCount',        header: 'REVOKED' },
  { field: 'alreadyRevokedCount', header: 'ALREADY REVOKED' },
  { field: 'skippedCount',        header: 'SKIPPED' },
  { field: 'failedCount',         header: 'FAILED' }
];

/**
 * Discriminator values written to the first column (`ROW TYPE`).
 * @enum {string}
 */
const LOG_ROW_TYPE = {
  INTERN:      'INTERN',
  RUN_SUMMARY: 'RUN_SUMMARY'
};

// =============================================================================
// Module-local state (per-invocation only; never persists)
// =============================================================================

/**
 * Active run context, or null when no run is in progress.
 *
 * Set by startRun, cleared by endRun. recordInternResult and endRun
 * consult this; flush does not.
 * @type {?Object}
 */
let _currentRun = null;

/**
 * Rows queued for write. Each entry is a partial object keyed by the
 * `field` names in LOG_COLUMNS. flush() materialises each row into a
 * full column-width array, defaulting blanks to ''.
 * @type {Object[]}
 */
let _buffer = [];

// =============================================================================
// Public API
// =============================================================================

/**
 * Begins a new run. Allocates a unique run ID, records the started-at
 * timestamp, and resets the in-memory buffer.
 *
 * Must be called once per run, before recordInternResult / endRun.
 * Calling startRun while another run is active throws — defensive
 * against accidentally interleaved runs.
 *
 * @param {{triggerSource: ?string, dryRun: ?boolean}=} opts
 *     `triggerSource` is a short label identifying how the run was
 *     invoked (e.g. 'SCHEDULED', 'MANUAL', 'TEST'). Defaults to
 *     'MANUAL'. `dryRun` is the run-level dry-run flag; defaults to
 *     the global DRY_RUN from config.gs.
 * @returns {{runId: string, startedAt: string, triggerSource: string, dryRun: boolean}}
 *     A snapshot of the run context. The internal _currentRun also
 *     holds a millisecond timestamp used to compute duration in
 *     endRun; callers should treat the returned object as read-only.
 * @throws {Error} If a run is already active.
 */
function startRun(opts) {
  if (_currentRun !== null) {
    throw new Error(
      'logService.startRun called while a run is already active (runId=' +
      _currentRun.runId + '). Call endRun() (and flush()) first.'
    );
  }
  opts = opts || {};
  const now = new Date();
  const ctx = {
    runId:         _newRunId_(now),
    startedAt:     _formatTimestamp_(now),
    startedAtMs:   now.getTime(),
    triggerSource: opts.triggerSource || 'MANUAL',
    dryRun:        (opts.dryRun === undefined || opts.dryRun === null)
                     ? DRY_RUN
                     : Boolean(opts.dryRun)
  };
  _currentRun = ctx;
  _buffer = [];
  return {
    runId:         ctx.runId,
    startedAt:     ctx.startedAt,
    triggerSource: ctx.triggerSource,
    dryRun:        ctx.dryRun
  };
}

/**
 * Buffers one INTERN row describing the outcome of processing a
 * single intern. The row is persisted on the next flush().
 *
 * Required sequencing: startRun must have been called and endRun
 * must NOT yet have been called for the current run.
 *
 * @param {{
 *   fullName: ?string,
 *   rowNumber: ?number,
 *   internEmail: ?string,
 *   folderId: ?string,
 *   action: ?string,
 *   outcome: ?string,
 *   message: ?string
 * }} entry
 *     `action` is one of the outcome codes from driveService
 *     (REVOKED, ALREADY_REVOKED, ALREADY_REVOKED_PROVISIONED,
 *     SKIPPED_EXCEPTION_USER, DRIVE_API_ERROR, FOLDER_NOT_ACCESSIBLE,
 *     DRY_RUN) or 'DRIVE_API_ERROR' for unexpected pipeline errors.
 *     `outcome` is 'success' or 'failure'.
 * @throws {Error} If no run is currently active.
 */
function recordInternResult(entry) {
  if (_currentRun === null) {
    throw new Error(
      'logService.recordInternResult called without an active run. ' +
      'Call startRun() first.'
    );
  }
  entry = entry || {};
  _buffer.push({
    rowType:       LOG_ROW_TYPE.INTERN,
    runId:         _currentRun.runId,
    timestamp:     _formatTimestamp_(new Date()),
    triggerSource: _currentRun.triggerSource,
    dryRun:        _currentRun.dryRun,
    fullName:      entry.fullName || '',
    rowNumber:     (entry.rowNumber === undefined || entry.rowNumber === null)
                     ? ''
                     : entry.rowNumber,
    internEmail:   entry.internEmail || '',
    folderId:      entry.folderId || '',
    action:        entry.action || '',
    outcome:       entry.outcome || '',
    message:       entry.message || ''
  });
}

/**
 * Finalises the current run. Computes ended-at and duration, pushes a
 * single RUN_SUMMARY row to the buffer, and clears the active-run
 * pointer.
 *
 * flush() is intentionally NOT called here. Callers decide when to
 * persist (typically immediately after endRun, but tests may inspect
 * the buffer in between).
 *
 * @param {{
 *   totalCandidates: number,
 *   revoked: number,
 *   alreadyRevoked: number,
 *   skipped: number,
 *   failed: number
 * }} summary
 *     Aggregated counts for the run. Missing or non-numeric values
 *     default to 0.
 * @returns {{runId: string, endedAt: string, durationMs: number}}
 * @throws {Error} If no run is currently active.
 */
function endRun(summary) {
  if (_currentRun === null) {
    throw new Error(
      'logService.endRun called without an active run. Call startRun() first.'
    );
  }
  summary = summary || {};
  const now = new Date();
  const endedAt = _formatTimestamp_(now);
  const durationMs = now.getTime() - _currentRun.startedAtMs;

  _buffer.push({
    rowType:             LOG_ROW_TYPE.RUN_SUMMARY,
    runId:               _currentRun.runId,
    timestamp:           endedAt,
    triggerSource:       _currentRun.triggerSource,
    dryRun:              _currentRun.dryRun,
    fullName:            '',
    rowNumber:           '',
    internEmail:         '',
    folderId:            '',
    action:              '',
    outcome:             '',
    message:             '',
    startedAt:           _currentRun.startedAt,
    endedAt:             endedAt,
    durationMs:          durationMs,
    totalCandidates:     _toIntOrZero_(summary.totalCandidates),
    revokedCount:        _toIntOrZero_(summary.revoked),
    alreadyRevokedCount: _toIntOrZero_(summary.alreadyRevoked),
    skippedCount:        _toIntOrZero_(summary.skipped),
    failedCount:         _toIntOrZero_(summary.failed)
  });

  const out = {
    runId:      _currentRun.runId,
    endedAt:    endedAt,
    durationMs: durationMs
  };
  _currentRun = null;
  return out;
}

/**
 * Writes all buffered rows to the log sheet in a single batched
 * `setValues()` call (NFR-R3). Creates the log sheet with the
 * canonical headers if it does not exist. Clears the buffer after a
 * successful write.
 *
 * Safe to call multiple times per invocation. A no-op when the
 * buffer is empty.
 *
 * If the underlying Sheets API call fails, the buffer is preserved
 * so the next flush() retry writes the same data.
 *
 * @returns {number} Number of rows written. 0 if the buffer was empty.
 * @throws {Error} If the workbook cannot be opened (the log sheet
 *                 lives in the same workbook as the source data —
 *                 see docs/SystemDesign.md §1).
 */
function flush() {
  if (_buffer.length === 0) return 0;
  const sheet = _ensureLogSheet_();

  // Materialise each buffered partial row into a full column-width
  // array, defaulting missing fields to '' so setValues receives a
  // strictly rectangular matrix.
  const rows = _buffer.map(function (row) {
    return LOG_COLUMNS.map(function (col) {
      const v = row[col.field];
      return (v === undefined || v === null) ? '' : v;
    });
  });

  const startRow = sheet.getLastRow() + 1;
  sheet
    .getRange(startRow, 1, rows.length, LOG_COLUMNS.length)
    .setValues(rows);

  const written = rows.length;
  _buffer = [];
  return written;
}

// =============================================================================
// Internal: sheet lifecycle
// =============================================================================

/**
 * Opens the log sheet, creating it with the canonical headers if
 * missing.
 *
 * Headers are written exactly once, when the sheet is first created.
 * Subsequent schema additions (appended columns in LOG_COLUMNS) are
 * NOT retroactively applied to existing sheets — operators who want
 * the new column must rename the old sheet (so a fresh one is
 * created) or add the column manually. This is intentional: silently
 * rewriting headers on an audit sheet is a footgun.
 *
 * @returns {GoogleAppsScript.Spreadsheet.Sheet}
 * @throws {Error} If the workbook cannot be opened.
 * @private
 */
function _ensureLogSheet_() {
  let ss;
  try {
    ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  } catch (e) {
    const msg = (e && e.message) ? e.message : String(e);
    throw new Error(
      'Could not open spreadsheet "' + SPREADSHEET_ID + '" for logging: ' + msg
    );
  }
  let sheet = ss.getSheetByName(LOG_SHEET_NAME);
  if (sheet === null) {
    sheet = ss.insertSheet(LOG_SHEET_NAME);
    sheet
      .getRange(1, 1, 1, LOG_COLUMNS.length)
      .setValues([LOG_COLUMNS.map(function (c) { return c.header; })]);
    // Best-effort visual formatting. Failures here are cosmetic and
    // must not abort the run.
    try {
      sheet.getRange(1, 1, 1, LOG_COLUMNS.length).setFontWeight('bold');
      sheet.setFrozenRows(1);
    } catch (e) {
      // Intentionally swallowed.
    }
  }
  return sheet;
}

// =============================================================================
// Internal: timestamps, IDs, small utilities
// =============================================================================

/**
 * Formats a Date as an ISO-8601 string in SCRIPT_TIMEZONE.
 * @param {Date} date
 * @returns {string}
 * @private
 */
function _formatTimestamp_(date) {
  return Utilities.formatDate(date, SCRIPT_TIMEZONE, LOG_TIMESTAMP_FORMAT);
}

/**
 * Generates a sortable, unique run ID like "R-20260616T023000-a1b2".
 *
 * The timestamp component gives sortability and human-readability;
 * the random suffix disambiguates two runs that start within the same
 * second (rare but possible during manual testing).
 * @param {Date} date
 * @returns {string}
 * @private
 */
function _newRunId_(date) {
  const stamp = Utilities.formatDate(
    date, SCRIPT_TIMEZONE, "yyyyMMdd'T'HHmmss"
  );
  const suffix = Math.random().toString(36).slice(2, 6);
  return 'R-' + stamp + '-' + suffix;
}

/**
 * Coerces a value to a non-negative integer. Returns 0 for missing,
 * non-finite, or negative inputs. Used by endRun so a malformed
 * summary object cannot produce negative counts in the log.
 * @param {*} v
 * @returns {number}
 * @private
 */
function _toIntOrZero_(v) {
  if (v === undefined || v === null) return 0;
  const n = Number(v);
  if (!isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}
