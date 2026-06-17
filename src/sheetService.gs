/**
 * @fileoverview Reader for the Timeline sheet. Sole owner of read access
 * to the production internship workbook.
 *
 * Translates raw rows into typed InternRecord objects, applies the validation
 * spec from docs/DataDictionary.md §4, and computes each record's eligibility.
 *
 * Does NOT perform Drive operations or write back to the spreadsheet.
 *
 * Public API:
 *   - readInternRecords()      -> wrapper { source, records, summary }
 *   - getEligibleCandidates()  -> InternRecord[] (ELIGIBLE only)
 *   - readSupervisorEmails()   -> string[]
 */

// =============================================================================
// Public API
// =============================================================================

/**
 * Reads every non-blank data row and returns a typed, validated wrapper.
 *
 * Single batched `getValues()` read (NFR-P3). Per-record validation failures
 * are captured in each record's `validation` block — they do NOT abort the read.
 * Unrecoverable errors (workbook missing, sheet missing, required header missing)
 * throw for the caller (main.gs) to handle at FR-08 Layer 2.
 *
 * @returns {Object} Wrapper with `source`, `records`, and `summary` fields.
 * @throws {Error} If the workbook cannot be opened, the sheet is missing,
 *                 or a required column header is absent.
 */
function readInternRecords() {
  const sheet = _openSourceSheet_();
  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();

  // Source metadata captured even for empty sheets (distinguish "no data").
  const sourceMeta = {
    spreadsheetId: SPREADSHEET_ID,
    sheetName: SOURCE_SHEET_NAME,
    snapshotAt: new Date().toISOString(),
    rowCount: 0
  };

  if (lastRow < 2 || lastCol < 1) {
    return { source: sourceMeta, records: [], summary: _summarize_([]) };
  }

  const values = sheet.getRange(1, 1, lastRow, lastCol).getValues();
  const headers = values[0];
  const colIdx = _buildColumnIndex_(headers);

  const records = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    if (_isBlankRow_(row)) continue; // §4.9: silently skip all-blank rows
    records.push(_mapRowToRecord_(row, colIdx, i + 1));
  }

  sourceMeta.rowCount = records.length;
  return {
    source: sourceMeta,
    records: records,
    summary: _summarize_(records)
  };
}

/**
 * Reads the source sheet and returns only ELIGIBLE records.
 * Note: calls readInternRecords() internally — callers needing both should
 * call it once and filter locally to avoid a second read.
 * @returns {Object[]} InternRecord objects with `validation.eligibility === 'ELIGIBLE'`.
 */
function getEligibleCandidates() {
  const wrapper = readInternRecords();
  return wrapper.records.filter(function (r) {
    return r.validation.eligibility === ELIGIBILITY.ELIGIBLE;
  });
}

/**
 * Reads the EMAIL column of the Supervisor sheet for the dynamic exception
 * allowlist. Never throws — supervisors are a safety net, not a hard dependency:
 *   - Returns [] if the workbook/sheet/EMAIL header is missing or empty.
 *   - Silently skips blank cells and regex failures.
 *   - Deduplicates (case-insensitive after canonicalisation).
 * @returns {string[]} Canonicalised (trim + lowercase) emails.
 */
function readSupervisorEmails() {
  let ss;
  try {
    ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  } catch (e) {
    return [];
  }
  const sheet = ss.getSheetByName(SUPERVISOR_SHEET_NAME);
  if (sheet === null) return [];

  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  if (lastRow < 2 || lastCol < 1) return [];

  const values = sheet.getRange(1, 1, lastRow, lastCol).getValues();
  const headers = values[0];
  const emailIdx = _findHeaderIndex_(headers, SUPERVISOR_EMAIL_HEADER);
  if (emailIdx < 0) return [];

  const seen = {};
  const out = [];
  for (let i = 1; i < values.length; i++) {
    const v = values[i][emailIdx];
    if (_isBlankValue_(v)) continue;
    const cleaned = String(v).trim().toLowerCase();
    if (!EMAIL_REGEX.test(cleaned)) continue;
    if (seen[cleaned]) continue;
    seen[cleaned] = true;
    out.push(cleaned);
  }
  return out;
}

// =============================================================================
// Internal: sheet access
// =============================================================================

/**
 * Opens the production spreadsheet and returns the source sheet.
 * @returns {GoogleAppsScript.Spreadsheet.Sheet} The source sheet.
 * @throws {Error} If the workbook or sheet is missing/inaccessible.
 * @private
 */
function _openSourceSheet_() {
  let ss;
  try {
    ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  } catch (e) {
    throw new Error(
      'Could not open spreadsheet "' + SPREADSHEET_ID + '": ' + e.message
    );
  }
  const sheet = ss.getSheetByName(SOURCE_SHEET_NAME);
  if (sheet === null) {
    throw new Error(
      'Source sheet "' + SOURCE_SHEET_NAME +
      '" not found in spreadsheet "' + SPREADSHEET_ID + '".'
    );
  }
  return sheet;
}

/**
 * Builds a map from internal field name to 0-based column index by matching
 * COLUMN_MAPPING headers against the sheet's header row.
 *
 * Throws if any REQUIRED header is missing, listing all missing required
 * headers in one error. Optional missing headers simply don't appear in the map.
 *
 * @param {Object[]} headers - Header row from `getValues()[0]`.
 * @returns {Object<string, number>} Map of internal field name → column index.
 * @throws {Error} If any REQUIRED column's header cannot be located.
 * @private
 */
function _buildColumnIndex_(headers) {
  const trimmedHeaders = headers.map(function (h) {
    return h === null || h === undefined ? '' : String(h).trim();
  });

  const colIdx = {};
  const missingRequired = [];

  Object.keys(COLUMN_MAPPING).forEach(function (field) {
    const expectedHeader = COLUMN_MAPPING[field].header;
    const idx = trimmedHeaders.indexOf(expectedHeader);
    if (idx >= 0) {
      colIdx[field] = idx;
    } else if (COLUMN_MAPPING[field].required) {
      missingRequired.push(
        expectedHeader + ' (expected column ' + COLUMN_MAPPING[field].column +
        ', for internal field "' + field + '")'
      );
    }
  });

  if (missingRequired.length > 0) {
    throw new Error(
      'Source sheet is missing required column headers: ' +
      missingRequired.join('; ') + '. Please restore the headers or ' +
      'update COLUMN_MAPPING in config.gs.'
    );
  }
  return colIdx;
}

/**
 * Finds the 0-based column index of a header by exact trimmed text.
 * Returns -1 when absent (callers fail soft).
 * @param {Object[]} headers - Header row.
 * @param {string} header - Exact (case-sensitive) header text.
 * @returns {number} Column index, or -1.
 * @private
 */
function _findHeaderIndex_(headers, header) {
  if (!headers || headers.length === 0) return -1;
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i];
    if (h === null || h === undefined) continue;
    if (String(h).trim() === header) return i;
  }
  return -1;
}

// =============================================================================
// Internal: row -> record mapping
// =============================================================================

/**
 * Converts a raw sheet row into a typed InternRecord, running every §4 rule.
 * Always returns a record (valid or invalid) — caller filters by eligibility.
 *
 * Errors/warnings from typed readers are collected in `buf` and flushed into
 * `validation.errors` / `validation.warnings` with dedup by (code, field).
 *
 * @param {Object[]} row - A single row from `getValues()`.
 * @param {Object<string, number>} colIdx - Field-to-column-index map.
 * @param {number} rowNumber - 1-based sheet row number (for write-back).
 * @returns {Object} An InternRecord with the full validation block.
 * @private
 */
function _mapRowToRecord_(row, colIdx, rowNumber) {
  const buf = { errors: [], warnings: [] };

  const record = {
    rowNumber: rowNumber,
    position:            _readText_(row, colIdx.position),
    fullName:            _readText_(row, colIdx.fullName),
    nickname:            _readText_(row, colIdx.nickname),
    internshipStartDate: _readDate_(row, colIdx.internshipStartDate, 'START_DATE', buf),
    internshipEndDate:   _readDate_(row, colIdx.internshipEndDate,   'END_DATE',   buf),
    phone:               _readText_(row, colIdx.phone),
    lineId:              _readText_(row, colIdx.lineId),
    internEmail:         _readEmail_(row, colIdx.internEmail, buf),
    university:          _readText_(row, colIdx.university),
    workMode:            _readEnum_(row, colIdx.workMode, ALLOWED_WORKMODES, buf),
    internshipStatus:    _readStatus_(row, colIdx.internshipStatus, buf),
    folderLink:          null,
    folderId:            null,
    firstDayWorkMode:    _readText_(row, colIdx.firstDayWorkMode),
    trackingStatus:      _readEnum_(row, colIdx.trackingStatus, ALLOWED_TRACKING_STATUSES, buf),
    emailStatus:         _readEnum_(row, colIdx.emailStatus, ALLOWED_EMAIL_STATUSES, buf),
    validation: {
      isValid: true,
      eligibility: ELIGIBILITY.ELIGIBLE,
      errors: [],
      warnings: []
    }
  };

  // Folder link produces two fields (URL + ID) and has its own validation.
  const folderResult = _readFolderLink_(row, colIdx.folderLink);
  record.folderLink = folderResult.url;
  record.folderId = folderResult.id;
  if (folderResult.error) {
    buf.errors.push(folderResult.error);
  }

  // Required-field checks cover "missing entirely" (readers caught "malformed").
  if (_isBlankValue_(record.fullName)) {
    buf.errors.push(_err_(ERROR_CODES.MISSING_NAME, 'NAME'));
  }
  if (_isBlankValue_(record.internEmail)) {
    buf.errors.push(_err_(ERROR_CODES.MISSING_EMAIL, 'EMAIL'));
  }
  if (_isBlankValue_(record.internshipEndDate)) {
    buf.errors.push(_err_(ERROR_CODES.END_DATE, 'END'));
  }
  if (_isBlankValue_(record.internshipStatus)) {
    buf.errors.push(_err_(ERROR_CODES.MISSING_STATUS, 'INTERNSHIP STATUS'));
  }
  if (_isBlankValue_(record.folderLink)) {
    buf.errors.push(_err_(ERROR_CODES.MISSING_FOLDER, 'FOLDER LINK'));
  }

  // Flush buffer with dedup by (code, field).
  buf.errors.forEach(function (err) {
    const exists = record.validation.errors.some(function (e) {
      return e.code === err.code && e.field === err.field;
    });
    if (!exists) record.validation.errors.push(err);
  });
  buf.warnings.forEach(function (w) {
    record.validation.warnings.push(w);
  });

  if (record.validation.errors.length > 0) {
    record.validation.isValid = false;
    record.validation.eligibility = ELIGIBILITY.INVALID;
  } else {
    record.validation.eligibility = _computeEligibility_(record);
  }

  return record;
}

// =============================================================================
// Internal: typed cell readers
// =============================================================================

/**
 * Reads a free-text cell. Trimmed string or null. Coerces numbers to string.
 * @param {Object[]} row - Sheet row.
 * @param {number|undefined} idx - Column index, or undefined if header absent.
 * @returns {?string}
 * @private
 */
function _readText_(row, idx) {
  if (idx === undefined || idx === null) return null;
  const v = row[idx];
  if (_isBlankValue_(v)) return null;
  return String(v).trim();
}

/**
 * Reads the EMAIL column. Canonical email or null. Non-empty failures push
 * EMAIL_FORMAT and return the cleaned value.
 * @param {Object[]} row - Sheet row.
 * @param {number|undefined} idx - Column index.
 * @param {{errors: Object[], warnings: Object[]}} buf - Per-record buffer.
 * @returns {?string} Canonical email, or null when blank.
 * @private
 */
function _readEmail_(row, idx, buf) {
  if (idx === undefined || idx === null) return null;
  const v = row[idx];
  if (_isBlankValue_(v)) return null;
  const cleaned = String(v).trim().toLowerCase();
  if (!EMAIL_REGEX.test(cleaned)) {
    buf.errors.push(_err_(ERROR_CODES.EMAIL_FORMAT, 'EMAIL'));
  }
  return cleaned;
}

/**
 * Reads a date cell. Accepts native Date and text formats in TEXT_DATE_FORMATS.
 * Ambiguous DD/MM forms are rejected (never silently swapped).
 * On parse failure, returns null and pushes the appropriate error code.
 *
 * @param {Object[]} row - Sheet row.
 * @param {number|undefined} idx - Column index.
 * @param {string} errorCodeSuffix - 'START_DATE' or 'END_DATE'.
 * @param {{errors: Object[], warnings: Object[]}} buf - Per-record buffer.
 * @returns {?string} ISO date string (yyyy-MM-dd), or null.
 * @private
 */
function _readDate_(row, idx, errorCodeSuffix, buf) {
  const code = ERROR_CODES[errorCodeSuffix];
  const header = _headerForCode_(errorCodeSuffix);
  if (idx === undefined || idx === null) return null;
  const v = row[idx];
  if (_isBlankValue_(v)) return null;

  if (Object.prototype.toString.call(v) === '[object Date]') {
    // Native datetime — retain calendar date only.
    if (isNaN(v.getTime())) {
      buf.errors.push(_err_(code, header));
      return null;
    }
    return _isoDate_(v);
  }

  if (typeof v === 'number') {
    // Numeric dates are NOT supported — reject to avoid silent day/month/year
    // misinterpretation (Risk R-03).
    buf.errors.push(_err_(code, header));
    return null;
  }

  // Text cell — try ISO first, then documented text formats.
  const s = String(v).trim();
  const iso = _parseIsoDate_(s);
  if (iso) return iso;

  for (let i = 0; i < TEXT_DATE_FORMATS.length; i++) {
    const parsed = _parseTextDate_(s, TEXT_DATE_FORMATS[i]);
    if (parsed) return parsed;
  }

  buf.errors.push(_err_(code, header));
  return null;
}

/**
 * Reads an enum cell case-insensitively. Unknown values pass through with WARN.
 * @param {Object[]} row - Sheet row.
 * @param {number|undefined} idx - Column index.
 * @param {string[]} allowed - Allowed enum values.
 * @param {{errors: Object[], warnings: Object[]}} buf - Per-record buffer.
 * @returns {?string}
 * @private
 */
function _readEnum_(row, idx, allowed, buf) {
  if (idx === undefined || idx === null) return null;
  const v = row[idx];
  if (_isBlankValue_(v)) return null;
  const s = String(v).trim();
  if (allowed.indexOf(s) >= 0) return s;
  const lowered = s.toLowerCase();
  for (let i = 0; i < allowed.length; i++) {
    if (allowed[i].toLowerCase() === lowered) return allowed[i];
  }
  buf.warnings.push({
    code: 'UNKNOWN_ENUM_VALUE',
    field: '(enum)',
    message: 'Unknown enum value "' + s + '". Passed through unchanged.'
  });
  return s;
}

/**
 * Reads INTERNSHIP STATUS with strict enum enforcement.
 * Unknown values are a hard error (gates eligibility) → STATUS_VALUE → INVALID.
 * @param {Object[]} row - Sheet row.
 * @param {number|undefined} idx - Column index.
 * @param {{errors: Object[], warnings: Object[]}} buf - Per-record buffer.
 * @returns {?string} Canonical status, or null when blank.
 * @private
 */
function _readStatus_(row, idx, buf) {
  if (idx === undefined || idx === null) return null;
  const v = row[idx];
  if (_isBlankValue_(v)) return null;
  const s = String(v).trim();
  if (ALLOWED_INTERNSHIP_STATUSES.indexOf(s) >= 0) return s;
  buf.errors.push(_err_(ERROR_CODES.STATUS_VALUE, 'INTERNSHIP STATUS'));
  return s;
}

/**
 * Reads the FOLDER LINK cell, validates URL form, extracts folder ID.
 *
 * @param {Object[]} row - Sheet row.
 * @param {number|undefined} idx - Column index.
 * @returns {{url: ?string, id: ?string, error: ?Object}}
 *   - `url`   : trimmed URL (returned even when malformed, for audit).
 *   - `id`    : extracted folder ID, or null.
 *   - `error` : validation entry to merge, or null.
 * @private
 */
function _readFolderLink_(row, idx) {
  if (idx === undefined || idx === null) {
    return { url: null, id: null, error: null };
  }
  const v = row[idx];
  if (_isBlankValue_(v)) {
    return { url: null, id: null, error: null };
  }
  const url = String(v).trim();
  const match = FOLDER_URL_REGEX.exec(url);
  if (!match) {
    return {
      url: url,
      id: null,
      error: _err_(ERROR_CODES.FOLDER_URL_FORMAT, 'FOLDER LINK')
    };
  }
  const id = match[1];
  if (!id || id.length < 8) {
    return {
      url: url,
      id: null,
      error: _err_(ERROR_CODES.FOLDER_ID, 'FOLDER LINK')
    };
  }
  return { url: url, id: id, error: null };
}

// =============================================================================
// Internal: eligibility computation
// =============================================================================

/**
 * Computes eligibility for a record that passed validation. Check order = priority:
 *   1. EXCEPTION user — never revoked.
 *   2. ACTIVE status  — overrides any date check.
 *   3. NOT_ENDED      — end date still within grace window.
 *   4. Otherwise      — ELIGIBLE.
 *
 * INELIGIBLE_ALREADY is documented but not produced (requires write-back column).
 *
 * @param {Object} record - A valid InternRecord.
 * @returns {string} One of the ELIGIBILITY enum values.
 * @private
 */
function _computeEligibility_(record) {
  if (_isExceptionUser_(record.internEmail)) {
    return ELIGIBILITY.EXCEPTION;
  }
  if (STATUS_ACTIVE.indexOf(record.internshipStatus) >= 0) {
    return ELIGIBILITY.ACTIVE;
  }
  // Defensive: status should be in OFFBOARDED if validation passed.
  if (STATUS_OFFBOARDED.indexOf(record.internshipStatus) < 0) {
    return ELIGIBILITY.INVALID;
  }
  if (!_hasEndDatePassed_(record.internshipEndDate)) {
    return ELIGIBILITY.NOT_ENDED;
  }
  return ELIGIBILITY.ELIGIBLE;
}

/**
 * True if email is on the EXCEPTION_EMAILS allowlist (case-insensitive).
 * @param {?string} email
 * @returns {boolean}
 * @private
 */
function _isExceptionUser_(email) {
  if (!email || EXCEPTION_EMAILS.length === 0) return false;
  const e = email.toLowerCase();
  for (let i = 0; i < EXCEPTION_EMAILS.length; i++) {
    if (String(EXCEPTION_EMAILS[i]).trim().toLowerCase() === e) return true;
  }
  return false;
}

/**
 * True when endDate is strictly before today minus grace period.
 *
 * `<` (not `<=`) is intentional: an intern whose end date is today still
 * has access for the rest of today.
 *
 * @param {?string} isoEndDate - yyyy-MM-dd string, or null.
 * @returns {boolean}
 * @private
 */
function _hasEndDatePassed_(isoEndDate) {
  if (!isoEndDate) return false;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - GRACE_PERIOD_DAYS);
  const cutoffIso = _isoDate_(cutoff);
  // ISO yyyy-MM-dd strings sort lexicographically = chronologically.
  return isoEndDate < cutoffIso;
}

// =============================================================================
// Internal: summary builder
// =============================================================================

/**
 * Builds the run-level summary: counts valid/invalid, aggregates skip reasons
 * keyed by error code (invalid) or eligibility value (ineligible).
 * @param {Object[]} records
 * @returns {Object}
 * @private
 */
function _summarize_(records) {
  let valid = 0;
  let invalid = 0;
  const skippedReasons = {};

  records.forEach(function (r) {
    if (r.validation.isValid) {
      valid++;
    } else {
      invalid++;
    }
    if (r.validation.eligibility === ELIGIBILITY.ELIGIBLE) return;

    let reason;
    if (r.validation.eligibility === ELIGIBILITY.INVALID && r.validation.errors.length > 0) {
      reason = r.validation.errors[0].code;
    } else {
      reason = r.validation.eligibility;
    }
    skippedReasons[reason] = (skippedReasons[reason] || 0) + 1;
  });

  return {
    total: records.length,
    valid: valid,
    invalid: invalid,
    skippedReasons: skippedReasons
  };
}

// =============================================================================
// Internal: small utilities
// =============================================================================

/**
 * Builds a structured error entry for the validation block.
 * @param {string} code - One of ERROR_CODES.
 * @param {string} field - Spreadsheet header of the offending column.
 * @returns {{code: string, field: string, message: string}}
 * @private
 */
function _err_(code, field) {
  return {
    code: code,
    field: field,
    message: 'Validation failed for column "' + field + '" (code: ' + code + ').'
  };
}

/**
 * Maps an ERROR_CODES suffix (START_DATE / END_DATE) to its source header.
 * @param {string} suffix
 * @returns {string}
 * @private
 */
function _headerForCode_(suffix) {
  if (suffix === 'START_DATE') return 'START';
  if (suffix === 'END_DATE') return 'END';
  return suffix;
}

/**
 * Formats a Date to yyyy-MM-dd in SCRIPT_TIMEZONE (discards time-of-day).
 * @param {Date} date
 * @returns {string}
 * @private
 */
function _isoDate_(date) {
  return Utilities.formatDate(date, SCRIPT_TIMEZONE, DATE_FORMAT_ISO);
}

/**
 * Parses a yyyy-MM-dd string. Returns null if invalid (e.g. rejects 2026-13-40
 * by round-trip field check). Ambiguous DD/MM/YYYY forms are not matched.
 * @param {string} s
 * @returns {?string}
 * @private
 */
function _parseIsoDate_(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const year = +m[1], month = +m[2], day = +m[3];
  const d = new Date(year, month - 1, day);
  if (d.getFullYear() !== year ||
      d.getMonth() !== month - 1 ||
      d.getDate() !== day) {
    return null;
  }
  return _isoDate_(d);
}

/**
 * Parses a text date like "Jan 5, 2026" via manual month lookup (locale-free).
 * @param {string} s
 * @param {string} _format - Format pattern (currently ignored).
 * @returns {?string}
 * @private
 */
function _parseTextDate_(s, _format) {
  const months = {
    jan: 0,  feb: 1,  mar: 2,  apr: 3,  may: 4,  jun: 5,
    jul: 6,  aug: 7,  sep: 8,  oct: 9,  nov: 10, dec: 11,
    january: 0, february: 1, march: 2,     april: 3,    may: 4,       june: 5,
    july: 6,   august: 7,   september: 8, october: 9,  november: 10, december: 11
  };
  const m = /^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/.exec(s);
  if (!m) return null;
  const monthIdx = months[m[1].toLowerCase()];
  if (monthIdx === undefined) return null;
  const day = +m[2], year = +m[3];
  const d = new Date(year, monthIdx, day);
  if (d.getFullYear() !== year ||
      d.getMonth() !== monthIdx ||
      d.getDate() !== day) {
    return null;
  }
  return _isoDate_(d);
}

/**
 * True when a single cell value is effectively blank.
 * @param {*} v
 * @returns {boolean}
 * @private
 */
function _isBlankValue_(v) {
  return v === null || v === undefined ||
         (typeof v === 'string' && v.trim() === '');
}

/**
 * True when an entire row has no non-blank cells (§4.9 — silently skipped).
 * @param {Object[]} row
 * @returns {boolean}
 * @private
 */
function _isBlankRow_(row) {
  for (let i = 0; i < row.length; i++) {
    if (!_isBlankValue_(row[i])) return false;
  }
  return true;
}
