/**
 * @fileoverview Reader for the Timeline sheet. Sole owner of read access
 * to the production internship workbook.
 *
 * Responsibility:
 *   - Open the source sheet using SPREADSHEET_ID / SOURCE_SHEET_NAME.
 *   - Translate raw rows into typed InternRecord objects (per
 *     docs/DataDictionary.md), normalising formatting inconsistencies
 *     (mixed text/datetime cells, mixed string/numeric phone fields,
 *     multilingual name content, optional fields that may be blank).
 *   - Apply the full validation specification from
 *     docs/DataDictionary.md §4, populating each record's `validation`
 *     block with a controlled-vocabulary error code when a required
 *     field is missing or malformed.
 *   - Compute each record's eligibility outcome (ELIGIBLE,
 *     INELIGIBLE_NOT_ENDED, INELIGIBLE_ACTIVE, INELIGIBLE_EXCEPTION,
 *     INELIGIBLE_INVALID).
 *   - Return a wrapper object containing source metadata, the records
 *     array, and a run-level summary.
 *
 * This file does NOT perform Drive operations and does NOT write back
 * to the spreadsheet. The write-back entry points
 * (writeRevocationStatus, appendLogEntries) declared in
 * docs/SystemDesign.md §2.2 are deferred to a later phase.
 *
 * Public API:
 *   - readInternRecords()      -> wrapper object (see sample below)
 *   - getEligibleCandidates()  -> InternRecord[] (subset of the above)
 *
 * ---------------------------------------------------------------------------
 * SAMPLE OUTPUT (abridged — see docs/DataDictionary.md §3 for full schema):
 *
 *   {
 *     "source": {
 *       "spreadsheetId": "1AOjCbe…rsmAkU",
 *       "sheetName": "Timeline",
 *       "snapshotAt": "2026-06-16T19:30:00.000Z",
 *       "rowCount": 1
 *     },
 *     "records": [
 *       {
 *         "rowNumber": 2,
 *         "position": "Programmer Trainee",
 *         "fullName": "Anantachai Khankang",
 *         "nickname": "Po",
 *         "internEmail": "antcpozxc@gmail.com",
 *         "internshipStartDate": "2025-08-01",
 *         "internshipEndDate": "2025-11-30",
 *         "internshipStatus": "Completed",
 *         "folderLink": "https://drive.google.com/drive/folders/1k7YCLeriyu-fEJhz3cQHL-oSidvGmFgx",
 *         "folderId": "1k7YCLeriyu-fEJhz3cQHL-oSidvGmFgx",
 *         "phone": "062-318-9418",
 *         "lineId": null,
 *         "university": "Kasetsart University",
 *         "workMode": "Hybrid",
 *         "firstDayWorkMode": "WFH",
 *         "trackingStatus": "Access Shared",
 *         "emailStatus": null,
 *         "validation": {
 *           "isValid": true,
 *           "eligibility": "ELIGIBLE",
 *           "errors": [],
 *           "warnings": []
 *         }
 *       }
 *     ],
 *     "summary": {
 *       "total": 1,
 *       "valid": 1,
 *       "invalid": 0,
 *       "skippedReasons": {}
 *     }
 *   }
 *
 * ---------------------------------------------------------------------------
 */

// =============================================================================
// Public API
// =============================================================================

/**
 * Reads every non-blank data row from the source sheet and returns a
 * typed, validated wrapper object.
 *
 * The function performs a single batched `getValues()` read
 * (NFR-P3 in docs/Requirement.md) and never touches Drive.
 *
 * Per-record validation failures are captured in each record's
 * `validation` block — they do NOT abort the read. Unrecoverable
 * errors (workbook not found, sheet missing, required header missing)
 * throw a descriptive Error for the caller (main.gs) to handle at
 * FR-08 Layer 2.
 *
 * @returns {Object} Wrapper with `source`, `records`, and `summary`
 *                   fields, as documented in docs/DataDictionary.md §3.
 * @throws {Error} If the workbook cannot be opened, the sheet is
 *                 missing, or a required column header is absent.
 */
function readInternRecords() {
  const sheet = _openSourceSheet_();
  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();

  // Source metadata is captured even for empty sheets so the caller
  // can distinguish "no data" from "could not read".
  const sourceMeta = {
    spreadsheetId: SPREADSHEET_ID,
    sheetName: SOURCE_SHEET_NAME,
    snapshotAt: new Date().toISOString(),
    rowCount: 0
  };

  if (lastRow < 2 || lastCol < 1) {
    // Header-only or completely empty sheet.
    return { source: sourceMeta, records: [], summary: _summarize_([]) };
  }

  // Single batched read of the used range.
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
 * Convenience wrapper that reads the source sheet and returns only the
 * records whose eligibility is `ELIGIBLE`. Useful for the main
 * controller's candidate-list step.
 *
 * Note: this calls readInternRecords() internally; callers that need
 * both the full wrapper and the filtered list should call
 * readInternRecords() once and filter the result themselves to avoid
 * a second sheet read.
 *
 * @returns {Object[]} Array of InternRecord objects with
 *                     `validation.eligibility === 'ELIGIBLE'`.
 */
function getEligibleCandidates() {
  const wrapper = readInternRecords();
  return wrapper.records.filter(function (r) {
    return r.validation.eligibility === ELIGIBILITY.ELIGIBLE;
  });
}

/**
 * Reads the EMAIL column of the Supervisor sheet and returns the list
 * of canonicalised supervisor emails. Used by main.gs to populate the
 * dynamic exception allowlist that supplements EXCEPTION_EMAILS in
 * config.gs (per confirmed assumption #8: "Read supervisor emails from
 * the Supervisor sheet; never revoke supervisor accounts").
 *
 * Defensive behaviour — supervisors are a safety net, not a hard
 * dependency, so this function NEVER throws:
 *
 *   - Returns `[]` if the workbook cannot be opened.
 *   - Returns `[]` if the Supervisor sheet is missing or empty.
 *   - Returns `[]` if the EMAIL header is absent.
 *   - Silently skips blank cells and cells that fail EMAIL_REGEX.
 *   - Deduplicates (case-insensitive after canonicalisation).
 *
 * @returns {string[]} Array of canonicalised (trim + lowercase) emails.
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

  // Single batched read of the used range.
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
 *
 * Defensive on every failure mode that would otherwise crash the
 * pipeline mid-run:
 *   - Spreadsheet ID is wrong or the running user lacks access.
 *   - Source sheet has been renamed or deleted.
 *
 * @returns {GoogleAppsScript.Spreadsheet.Sheet} The source sheet.
 * @throws {Error} With a descriptive message naming the missing
 *                 resource, for the caller to surface via FR-08.
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
 * Builds a map from internal field name to 0-based column index, by
 * matching each entry in COLUMN_MAPPING against the sheet's header row.
 *
 * Matching is by exact header text. If a known required header is
 * absent, the function throws with a descriptive message listing every
 * missing required header — operators get one clear error instead of a
 * cascade. Optional headers that are absent simply do not appear in
 * the returned map (the typed readers return null for them).
 *
 * @param {Object[]} headers - The header row from `getValues()[0]`.
 * @returns {Object<string, number>} Map of internal field name → 0-based
 *                                   column index.
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
 * Used by readSupervisorEmails() to locate the EMAIL column on the
 * Supervisor sheet without hard-coding the column letter.
 *
 * Returns -1 when the header is absent so callers can fail soft
 * (rather than throw) — appropriate for a safety-net lookup where
 * missing data should degrade gracefully.
 *
 * @param {Object[]} headers - The header row from `getValues()[0]`.
 * @param {string} header - Exact (case-sensitive) header text to find.
 * @returns {number} 0-based column index, or -1 when not found.
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
 * Converts a single raw sheet row into a typed InternRecord object,
 * running every validation rule from docs/DataDictionary.md §4.
 *
 * Always returns a record object (valid or invalid). The caller
 * decides whether to filter based on `validation.eligibility`.
 *
 * Validation entries produced by the typed readers are collected into
 * a fresh per-record buffer (`buf`) and flushed into the record's
 * `validation.errors` / `validation.warnings` arrays at the end, with
 * simple deduplication by (code, field) so a single problem is not
 * reported twice (e.g. a malformed date being both parsed-as-null by
 * the reader and flagged-as-missing by the required-field check).
 *
 * @param {Object[]} row - A single row from `getValues()`.
 * @param {Object<string, number>} colIdx - Field-to-column-index map.
 * @param {number} rowNumber - 1-based sheet row number (for write-back).
 * @returns {Object} An InternRecord with the full validation block.
 * @private
 */
function _mapRowToRecord_(row, colIdx, rowNumber) {
  // Per-record buffer for errors/warnings emitted by typed readers.
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

  // Folder link is special-cased because it produces two fields
  // (URL + extracted ID) and has its own validation rules.
  const folderResult = _readFolderLink_(row, colIdx.folderLink);
  record.folderLink = folderResult.url;
  record.folderId = folderResult.id;
  if (folderResult.error) {
    buf.errors.push(folderResult.error);
  }

  // Required-field checks cover the "missing entirely" case (as
  // opposed to "present but malformed", which the readers already
  // caught). Same code is used in both cases; dedup below handles it.
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

  // Flush buffer into the validation block, deduplicating by (code, field).
  buf.errors.forEach(function (err) {
    const exists = record.validation.errors.some(function (e) {
      return e.code === err.code && e.field === err.field;
    });
    if (!exists) record.validation.errors.push(err);
  });
  buf.warnings.forEach(function (w) {
    record.validation.warnings.push(w);
  });

  // Derive final state from the error list.
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
 * Reads a free-text cell. Returns trimmed string or null when blank.
 * Coerces numbers to string (the phone / LINE columns store both forms).
 *
 * @param {Object[]} row - Sheet row.
 * @param {number|undefined} idx - Column index, or undefined if the
 *        header was absent (optional column).
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
 * Reads and validates the EMAIL column. Returns the canonical email
 * (trim + lowercase) or null when blank. When the cell is non-empty
 * but fails the regex, the original cleaned value is returned AND a
 * EMAIL_FORMAT entry is pushed onto `buf.errors`.
 *
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
 * Reads a date cell. Accepts native Date objects and the text formats
 * documented in docs/DataDictionary.md §4.5. Ambiguous DD/MM forms
 * are rejected (never silently swapped).
 *
 * On parse failure, returns null AND pushes the appropriate error code.
 *
 * @param {Object[]} row - Sheet row.
 * @param {number|undefined} idx - Column index.
 * @param {string} errorCodeSuffix - Either 'START_DATE' or 'END_DATE';
 *        used to look up the right ERROR_CODES key.
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
    // Native datetime from Sheets. Retain calendar date only.
    if (isNaN(v.getTime())) {
      buf.errors.push(_err_(code, header));
      return null;
    }
    return _isoDate_(v);
  }

  if (typeof v === 'number') {
    // A numeric value in a date column is not one of the accepted
    // forms in docs/DataDictionary.md §4.5 (native Date, ISO string,
    // or "MMM d, yyyy" string). Sheets serials and epoch-ms guesses
    // are intentionally NOT supported — reject rather than risk a
    // silent day/month/year misinterpretation (Risk R-03).
    buf.errors.push(_err_(code, header));
    return null;
  }

  // Text cell — try ISO first, then the documented text formats.
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
 * Reads an enum cell. Returns the canonical value if it matches the
 * allowed set (case-insensitively). Unknown values are passed through
 * unchanged with a WARN entry — non-blocking for optional columns.
 *
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
 * Reads the INTERNSHIP STATUS column with strict enum enforcement.
 * Unlike other enum columns, an unknown value here IS a hard error
 * (it gates eligibility): an UNKNOWN status value pushes
 * STATUS_VALUE into `buf.errors`, marking the record INVALID.
 *
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
 * Reads the FOLDER LINK cell, validates its URL form, and extracts
 * the folder ID.
 *
 * @param {Object[]} row - Sheet row.
 * @param {number|undefined} idx - Column index.
 * @returns {{url: ?string, id: ?string, error: ?Object}}
 *   - `url`   : the trimmed URL string (always returned when present,
 *                even if malformed, for audit visibility).
 *   - `id`    : the extracted folder ID, or null.
 *   - `error` : a validation entry to be merged into the record's
 *                errors, or null when the URL is valid.
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
 * Computes the eligibility outcome for a record that has already passed
 * validation (no errors). The order of checks encodes priority:
 *
 *   1. EXCEPTION user  — never revoked, even if otherwise eligible.
 *   2. ACTIVE status   — overrides any date check.
 *   3. NOT_ENDED       — end date still within grace window.
 *   4. Otherwise       — ELIGIBLE.
 *
 * INELIGIBLE_ALREADY is documented but not yet produced: it requires a
 * per-intern status write-back column, which depends on
 * docs/OpenQuestions.md Q-04.
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
  // Defensive: status should already be in OFFBOARDED if validation
  // passed, but check explicitly in case the allowed set grows later.
  if (STATUS_OFFBOARDED.indexOf(record.internshipStatus) < 0) {
    return ELIGIBILITY.INVALID;
  }
  if (!_hasEndDatePassed_(record.internshipEndDate)) {
    return ELIGIBILITY.NOT_ENDED;
  }
  return ELIGIBILITY.ELIGIBLE;
}

/**
 * Determines whether an email is on the EXCEPTION_EMAILS allowlist.
 * Both sides are canonicalised (trim + lowercase) before comparison.
 *
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
 * Compares the intern's end date (yyyy-MM-dd string) against today minus
 * the configured grace period. Returns true only when the end date is
 * strictly before the cutoff — i.e. access should be revoked.
 *
 * Using `<` (not `<=`) is intentional: an intern whose end date is
 * today still has access for the rest of today. Revocation happens
 * from tomorrow onward (or after the grace window).
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
 * Builds the run-level summary block. Counts valid / invalid records
 * and aggregates skip reasons into a stable map keyed by error code
 * (for invalid records) or eligibility value (for valid-but-ineligible).
 *
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
 * Maps an ERROR_CODES suffix (START_DATE / END_DATE) to its source
 * header name, used when building validation messages.
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
 * Formats a Date to a yyyy-MM-dd string in SCRIPT_TIMEZONE. Discards
 * any time-of-day component.
 * @param {Date} date
 * @returns {string}
 * @private
 */
function _isoDate_(date) {
  return Utilities.formatDate(date, SCRIPT_TIMEZONE, DATE_FORMAT_ISO);
}

/**
 * Parses a yyyy-MM-dd string and returns the same canonical form.
 * Returns null if the string is not a valid ISO date (e.g. rejects
 * 2026-13-40 by reconstructing the Date and checking the fields round-trip).
 *
 * Ambiguous DD/MM/YYYY forms are simply not matched by the regex.
 *
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
 * Parses a text date like "Jan 5, 2026" using a manual month lookup
 * so the result does not depend on the runtime's locale.
 *
 * @param {string} s
 * @param {string} _format - Format pattern (currently ignored; both
 *        short and long month names are accepted via the same parser).
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
 * True when an entire row has no non-blank cells. Per §4.9 these rows
 * are silently skipped (not counted, not logged).
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
