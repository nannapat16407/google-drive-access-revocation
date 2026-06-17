/**
 * @fileoverview Structured execution logging for audit.
 *
 * Persists one log row per intern processed plus a single run-summary row per
 * invocation. Uses an in-memory buffer flushed once at end to minimise Sheets
 * API quota usage (NFR-R3).
 *
 * Intern rows and RUN_SUMMARY rows share one schema (LOG_COLUMNS); the
 * `rowType` column discriminates them. This keeps the append path a single
 * batched `setValues()` call regardless of row mix.
 *
 * Public API:
 *   - startRun(opts?)              -> RunContext
 *   - recordInternResult(entry)    -> void
 *   - endRun(summary)              -> { runId, endedAt, durationMs }
 *   - flush()                      -> number of rows written
 *
 * Sequencing:
 *   - startRun must precede recordInternResult / endRun (else throws).
 *   - flush is independent of run state and safe to call multiple times.
 *   - Module state does NOT persist across Apps Script invocations.
 */

// =============================================================================
// Tunable constants (module-local)
// =============================================================================

/**
 * Timestamp format written to the log sheet. ISO-8601 in SCRIPT_TIMEZONE.
 * @type {string}
 */
const LOG_TIMESTAMP_FORMAT = "yyyy-MM-dd'T'HH:mm:ssXXX";

/**
 * Log sheet schema. Order here = column order in the sheet.
 *
 * Schema evolution rules:
 *   - New columns MUST be appended at the end (never insert mid-sheet).
 *   - Existing headers MUST NOT be reworded (operators filter by them).
 *   - Pre-existing sheets keep their original headers; only fresh sheets
 *     get the current schema written to row 1.
 *
 * @type {Array<{field: string, header: string}>}
 */
const LOG_COLUMNS = [
  // Shared by both row types — always populated.
  { field: 'rowType',             header: 'ROW TYPE' },
  { field: 'runId',               header: 'RUN ID' },
  { field: 'timestamp',           header: 'TIMESTAMP' },
  { field: 'triggerSource',       header: 'TRIGGER SOURCE' },
  { field: 'dryRun',              header: 'DRY RUN' },

  // Intern-specific. Blank on RUN_SUMMARY rows.
  { field: 'fullName',            header: 'FULL NAME' },
  { field: 'rowNumber',           header: 'ROW NUMBER' },
  { field: 'internEmail',         header: 'INTERN EMAIL' },
  { field: 'folderId',            header: 'FOLDER ID' },
  { field: 'action',              header: 'ACTION' },
  { field: 'outcome',             header: 'OUTCOME' },
  { field: 'message',             header: 'MESSAGE' },

  // Run-summary-specific. Blank on INTERN rows.
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
 * Discriminator values for the ROW TYPE column.
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
 * @type {?Object}
 */
let _currentRun = null;

/**
 * Rows queued for write. flush() materialises each into a column-width array.
 * @type {Object[]}
 */
let _buffer = [];

// =============================================================================
// Public API
// =============================================================================

/**
 * Begins a new run. Allocates a run ID, records started-at, resets the buffer.
 * Throws if a run is already active.
 *
 * @param {{triggerSource: ?string, dryRun: ?boolean}=} opts
 * @returns {{runId: string, startedAt: string, triggerSource: string, dryRun: boolean}}
 *     Snapshot of the run context. Treat as read-only.
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
 * Buffers one INTERN row for a single intern's outcome. Persisted on next flush().
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
 *     `action` is a driveService outcome code or 'DRIVE_API_ERROR'.
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
 * Finalises the run: computes ended-at + duration, pushes a RUN_SUMMARY row,
 * clears the active-run pointer. Does NOT flush (caller decides when).
 *
 * @param {{
 *   totalCandidates: number,
 *   revoked: number,
 *   alreadyRevoked: number,
 *   skipped: number,
 *   failed: number
 * }} summary
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
 * Writes all buffered rows in a single batched `setValues()` call (NFR-R3).
 * Creates the log sheet with canonical headers if missing. Clears the buffer
 * on success. Safe to call multiple times; no-op when buffer is empty.
 * Buffer is preserved if the Sheets API call fails.
 *
 * @returns {number} Rows written. 0 if the buffer was empty.
 * @throws {Error} If the workbook cannot be opened.
 */
function flush() {
  if (_buffer.length === 0) return 0;
  const sheet = _ensureLogSheet_();

  // Materialise partial rows into a full rectangular matrix (blanks -> '').
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
 * Opens the log sheet, creating it with canonical headers if missing.
 *
 * Headers are written only when the sheet is first created. Schema additions
 * are NOT retroactively applied to existing sheets — operators must rename
 * the old sheet (so a fresh one is created) or add the column manually.
 * (Silently rewriting headers on an audit sheet is a footgun.)
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
    // Best-effort visual formatting. Cosmetic failures swallowed.
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
 * Formats a Date as ISO-8601 in SCRIPT_TIMEZONE.
 * @param {Date} date
 * @returns {string}
 * @private
 */
function _formatTimestamp_(date) {
  return Utilities.formatDate(date, SCRIPT_TIMEZONE, LOG_TIMESTAMP_FORMAT);
}

/**
 * Generates a sortable, unique run ID like "R-20260616T023000-a1b2".
 * Random suffix disambiguates runs starting in the same second.
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
 * Coerces a value to a non-negative integer. Returns 0 for missing/invalid input.
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
