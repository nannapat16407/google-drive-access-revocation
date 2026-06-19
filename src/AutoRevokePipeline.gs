// =============================================================================
// GLOBAL ENTRY POINTS (ฟังก์ชันหลักสำหรับให้ปุ่ม Run ของ Apps Script มองเห็น)
// =============================================================================
function installRevokeTrigger() { _RevokePipeline.installTrigger(); }
function uninstallRevokeTrigger() { _RevokePipeline.uninstallTrigger(); }
function runAutoRevoke() { _RevokePipeline.onScheduledRun(); }
function testRevokeDryRun() { _RevokePipeline.runSampleDryRun(); }

// =============================================================================
// PIPELINE CORE (ห่อหุ้มโค้ดไว้ด้านใน เพื่อป้องกันตัวแปรตีกับไฟล์อื่นๆ ของคุณ)
// =============================================================================
const _RevokePipeline = (function() {

  // --- 1. CONFIGURATION ---
  const SPREADSHEET_ID = '1r5haDHnFAXnISghauSrJcxQh6c2lE0AjyPu8ImpoTQE';
  const SOURCE_SHEET_NAME = 'Timeline';
  const LOG_SHEET_NAME = 'AccessRevocationLog';
  const SUPERVISOR_SHEET_NAME = 'Supervisor';
  const SUPERVISOR_EMAIL_HEADER = 'EMAIL';

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

  const STATUS_OFFBOARDED = ['Completed', 'Withdraw'];
  const STATUS_ACTIVE = ['Interning', 'Pending'];
  const ALLOWED_INTERNSHIP_STATUSES = STATUS_OFFBOARDED.concat(STATUS_ACTIVE);
  const ALLOWED_WORKMODES = ['Hybrid', 'WFO', 'WFH'];
  const ALLOWED_TRACKING_STATUSES = ['Access Shared'];
  const ALLOWED_EMAIL_STATUSES = ['Success'];
  
  const TRACKING_STATUS_ACCESS_REVOKED = 'Access Revoked';
  const TRACKING_STATUS_REVOCATION_FAILED = 'Revocation Failed';

  const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const FOLDER_URL_REGEX = /^https:\/\/drive\.google\.com\/drive\/folders\/([\w\-]+)/;

  const SCRIPT_TIMEZONE = 'Asia/Bangkok';
  const DATE_FORMAT_ISO = 'yyyy-MM-dd';
  const TEXT_DATE_FORMATS = ['MMM d, yyyy', 'MMMM d, yyyy'];

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

  const ELIGIBILITY = {
    ELIGIBLE:      'ELIGIBLE',
    NOT_ENDED:     'INELIGIBLE_NOT_ENDED',
    ACTIVE:        'INELIGIBLE_ACTIVE',
    ALREADY:       'INELIGIBLE_ALREADY',
    EXCEPTION:     'INELIGIBLE_EXCEPTION',
    INVALID:       'INELIGIBLE_INVALID'
  };

  const GRACE_PERIOD_DAYS = 0;
  const DRY_RUN = false;
  const ENABLE_LOGGING = false;
  const EXCEPTION_EMAILS = [];
  
  const TRIGGER_HOUR = 18;
  const TRIGGER_MINUTE = 0;
  const TRIGGER_HANDLER_FUNCTION = 'runAutoRevoke';

  // --- 2. DRIVE SERVICE ---
  const DRIVE_MAX_RETRIES = 3;
  const DRIVE_RETRY_BASE_MS = 500;
  const DRIVE_FOLDER_ID_MIN_LENGTH = 8;
  let _dynamicExceptionEmails = [];

  function revokeAccess(folderUrlOrId, internEmail, opts) {
    opts = opts || {};
    const trackingStatus = opts.trackingStatus || null;
    const dryRun = (opts.dryRunOverride === null || opts.dryRunOverride === undefined) ? DRY_RUN : Boolean(opts.dryRunOverride);

    const folderId = _resolveFolderId_(folderUrlOrId);
    const email = _canonicalEmail_(internEmail);
    if (folderId === null) return _result_(null, internEmail, 'DRIVE_API_ERROR', 'failure', 'Invalid folder ID.', 0);
    if (email === null) return _result_(folderId, internEmail, 'DRIVE_API_ERROR', 'failure', 'Invalid email.', 0);
    if (isExceptionUser(email)) return _result_(folderId, email, 'SKIPPED_EXCEPTION_USER', 'success', null, 0);

    const opened = _openFolderWithRetry_(folderId);
    if (!opened.ok) return _result_(folderId, email, opened.code, 'failure', opened.message, opened.attempts);
    
    const folder = opened.folder;
    const editors = _listWithRetry_(function () { return folder.getEditors(); }, 'getEditors');
    if (!editors.ok) return _result_(folderId, email, editors.code, 'failure', editors.message, editors.attempts);
    
    const viewers = _listWithRetry_(function () { return folder.getViewers(); }, 'getViewers');
    if (!viewers.ok) return _result_(folderId, email, viewers.code, 'failure', viewers.message, viewers.attempts);

    const totalAttempts = editors.attempts + viewers.attempts;
    const isEditor = _findUserByEmail_(editors.value, email) !== null;
    const isViewer = _findUserByEmail_(viewers.value, email) !== null;

    if (dryRun) {
      if (isEditor || isViewer) return _result_(folderId, email, 'DRY_RUN', 'success', 'Dry-run: would remove permission.', totalAttempts);
      return _result_(folderId, email, 'DRY_RUN', 'success', 'Dry-run: no permission found.', totalAttempts);
    }

    if (!isEditor && !isViewer) return _alreadyRevokedResult_(folderId, email, trackingStatus, totalAttempts);

    const removalOutcome = isEditor 
      ? _removeWithRetry_(function () { folder.removeEditor(email); }, 'removeEditor') 
      : _removeWithRetry_(function () { folder.removeViewer(email); }, 'removeViewer');

    if (!removalOutcome.ok) return _result_(folderId, email, removalOutcome.code, 'failure', removalOutcome.message, totalAttempts + removalOutcome.attempts);
    return _result_(folderId, email, 'REVOKED', 'success', null, totalAttempts + removalOutcome.attempts);
  }

  function isExceptionUser(email) {
    if (!email) return false;
    const e = String(email).trim().toLowerCase();
    for (let i = 0; i < EXCEPTION_EMAILS.length; i++) {
      if (String(EXCEPTION_EMAILS[i]).trim().toLowerCase() === e) return true;
    }
    for (let i = 0; i < _dynamicExceptionEmails.length; i++) {
      if (_dynamicExceptionEmails[i] === e) return true;
    }
    return false;
  }

  function setExceptionEmails(emails) {
    if (!Array.isArray(emails)) { _dynamicExceptionEmails = []; return; }
    _dynamicExceptionEmails = emails.map(function(e) { return String(e == null ? '' : e).trim().toLowerCase(); }).filter(function(e) { return e.length > 0; });
  }

  function _resolveFolderId_(input) {
    if (input === null || input === undefined) return null;
    const s = String(input).trim();
    const match = FOLDER_URL_REGEX.exec(s);
    if (match && match[1]) return match[1];
    if (/^[\w\-]+$/.test(s) && s.length >= DRIVE_FOLDER_ID_MIN_LENGTH) return s;
    return null;
  }

  function _canonicalEmail_(input) {
    if (input === null || input === undefined) return null;
    const s = String(input).trim().toLowerCase();
    return EMAIL_REGEX.test(s) ? s : null;
  }

  function _openFolderWithRetry_(folderId) {
    const r = _withRetry_(function () { return DriveApp.getFolderById(folderId); }, 'getFolderById');
    if (r.ok) return { ok: true, folder: r.value, code: '', message: null, attempts: r.attempts };
    return { ok: false, folder: null, code: _isAccessError_(r.error) ? 'FOLDER_NOT_ACCESSIBLE' : 'DRIVE_API_ERROR', message: r.message, attempts: r.attempts };
  }

  function _listWithRetry_(fn, label) {
    const r = _withRetry_(fn, label);
    if (r.ok) return { ok: true, value: r.value, code: '', message: null, attempts: r.attempts };
    return { ok: false, value: null, code: _isAccessError_(r.error) ? 'FOLDER_NOT_ACCESSIBLE' : 'DRIVE_API_ERROR', message: r.message, attempts: r.attempts };
  }

  function _removeWithRetry_(fn, label) {
    const r = _withRetry_(fn, label);
    if (r.ok) return { ok: true, code: '', message: null, attempts: r.attempts };
    return { ok: false, code: 'DRIVE_API_ERROR', message: r.message, attempts: r.attempts };
  }

  function _withRetry_(fn, label) {
    let lastError = null;
    for (let attempt = 1; attempt <= DRIVE_MAX_RETRIES + 1; attempt++) {
      try {
        return { ok: true, value: fn(), error: null, message: null, attempts: attempt };
      } catch (e) {
        lastError = e;
        if (!_isTransientError_(e)) break;
        if (attempt <= DRIVE_MAX_RETRIES) Utilities.sleep(DRIVE_RETRY_BASE_MS * Math.pow(2, attempt - 1));
      }
    }
    return { ok: false, value: null, error: lastError, message: label + ' failed', attempts: DRIVE_MAX_RETRIES + 1 };
  }

  function _findUserByEmail_(users, email) {
    if (!users || users.length === 0) return null;
    for (let i = 0; i < users.length; i++) {
      try {
        if (String(users[i].getEmail() || '').trim().toLowerCase() === email) return users[i];
      } catch (e) {}
    }
    return null;
  }

  function _result_(folderId, internEmail, action, outcome, errorMessage, attempts) {
    return { folderId, internEmail, action, outcome, errorMessage, attempts };
  }

  function _alreadyRevokedResult_(folderId, email, trackingStatus, attempts) {
    const isProv = String(trackingStatus || '').trim().toLowerCase() === 'access shared';
    return _result_(folderId, email, isProv ? 'ALREADY_REVOKED_PROVISIONED' : 'ALREADY_REVOKED', 'success', isProv ? 'No permission found, but was Access Shared.' : null, attempts);
  }

  function _isAccessError_(e) {
    const msg = _errorMessage_(e).toLowerCase();
    return msg.indexOf('not found') >= 0 || msg.indexOf('permission') >= 0 || msg.indexOf('403') >= 0 || msg.indexOf('404') >= 0;
  }

  function _isTransientError_(e) {
    const msg = _errorMessage_(e).toLowerCase();
    return msg.indexOf('rate limit') >= 0 || msg.indexOf('500') >= 0 || msg.indexOf('timeout') >= 0;
  }

  function _errorMessage_(e) {
    if (e === null || e === undefined) return '';
    if (typeof e === 'string') return e;
    return (typeof e.message === 'string') ? e.message : String(e);
  }

  // --- 3. LOG SERVICE ---
  const LOG_TIMESTAMP_FORMAT = "yyyy-MM-dd'T'HH:mm:ssXXX";
  const LOG_COLUMNS = [
    { field: 'rowType',             header: 'ROW TYPE' },
    { field: 'runId',               header: 'RUN ID' },
    { field: 'timestamp',           header: 'TIMESTAMP' },
    { field: 'triggerSource',       header: 'TRIGGER SOURCE' },
    { field: 'dryRun',              header: 'DRY RUN' },
    { field: 'fullName',            header: 'FULL NAME' },
    { field: 'rowNumber',           header: 'ROW NUMBER' },
    { field: 'internEmail',         header: 'INTERN EMAIL' },
    { field: 'folderId',            header: 'FOLDER ID' },
    { field: 'action',              header: 'ACTION' },
    { field: 'outcome',             header: 'OUTCOME' },
    { field: 'message',             header: 'MESSAGE' },
    { field: 'startedAt',           header: 'STARTED AT' },
    { field: 'endedAt',             header: 'ENDED AT' },
    { field: 'durationMs',          header: 'DURATION (MS)' },
    { field: 'totalCandidates',     header: 'TOTAL CANDIDATES' },
    { field: 'revokedCount',        header: 'REVOKED' },
    { field: 'alreadyRevokedCount', header: 'ALREADY REVOKED' },
    { field: 'skippedCount',        header: 'SKIPPED' },
    { field: 'failedCount',         header: 'FAILED' }
  ];
  let _currentRun = null;
  let _buffer = [];

  function startRun(opts) {
    opts = opts || {};
    const now = new Date();
    _currentRun = {
      runId: 'R-' + Utilities.formatDate(now, SCRIPT_TIMEZONE, "yyyyMMdd'T'HHmmss") + '-' + Math.random().toString(36).slice(2, 6),
      startedAt: Utilities.formatDate(now, SCRIPT_TIMEZONE, LOG_TIMESTAMP_FORMAT),
      startedAtMs: now.getTime(),
      triggerSource: opts.triggerSource || 'MANUAL',
      dryRun: (opts.dryRun === undefined || opts.dryRun === null) ? DRY_RUN : Boolean(opts.dryRun)
    };
    _buffer = [];
    return _currentRun;
  }

  function recordInternResult(entry) {
    if (!_currentRun) return;
    _buffer.push({
      rowType: 'INTERN', runId: _currentRun.runId, timestamp: Utilities.formatDate(new Date(), SCRIPT_TIMEZONE, LOG_TIMESTAMP_FORMAT),
      triggerSource: _currentRun.triggerSource, dryRun: _currentRun.dryRun,
      fullName: entry.fullName || '', rowNumber: entry.rowNumber || '', internEmail: entry.internEmail || '',
      folderId: entry.folderId || '', action: entry.action || '', outcome: entry.outcome || '', message: entry.message || ''
    });
  }

  function endRun(summary) {
    if (!_currentRun) return;
    const now = new Date();
    const endedAt = Utilities.formatDate(now, SCRIPT_TIMEZONE, LOG_TIMESTAMP_FORMAT);
    const durationMs = now.getTime() - _currentRun.startedAtMs;
    _buffer.push({
      rowType: 'RUN_SUMMARY', runId: _currentRun.runId, timestamp: endedAt,
      triggerSource: _currentRun.triggerSource, dryRun: _currentRun.dryRun,
      startedAt: _currentRun.startedAt, endedAt: endedAt, durationMs: durationMs,
      totalCandidates: summary.totalCandidates || 0, revokedCount: summary.revoked || 0,
      alreadyRevokedCount: summary.alreadyRevoked || 0, skippedCount: summary.skipped || 0, failedCount: summary.failed || 0
    });
    const out = { runId: _currentRun.runId, endedAt: endedAt, durationMs: durationMs };
    _currentRun = null;
    return out;
  }

  function flush() {
    if (!ENABLE_LOGGING || _buffer.length === 0) { _buffer = []; return 0; }
    let sheet;
    try {
      let ss = SpreadsheetApp.openById(SPREADSHEET_ID);
      sheet = ss.getSheetByName(LOG_SHEET_NAME);
      if (!sheet) {
        sheet = ss.insertSheet(LOG_SHEET_NAME);
        sheet.getRange(1, 1, 1, LOG_COLUMNS.length).setValues([LOG_COLUMNS.map(c => c.header)]);
        sheet.getRange(1, 1, 1, LOG_COLUMNS.length).setFontWeight('bold');
        sheet.setFrozenRows(1);
      }
    } catch(e) { return 0; }

    const rows = _buffer.map(row => LOG_COLUMNS.map(col => row[col.field] || ''));
    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, LOG_COLUMNS.length).setValues(rows);
    const written = rows.length;
    _buffer = [];
    return written;
  }

  // --- 4. SHEET SERVICE ---
  function getEligibleCandidates() {
    const sheet = _openSourceSheet_();
    const lastRow = sheet.getLastRow();
    const lastCol = sheet.getLastColumn();
    if (lastRow < 2 || lastCol < 1) return [];

    const values = sheet.getRange(1, 1, lastRow, lastCol).getValues();
    const headers = values[0];
    const colIdx = _buildColumnIndex_(headers);
    const records = [];

    for (let i = 1; i < values.length; i++) {
      if (_isBlankRow_(values[i])) continue;
      const rec = _mapRowToRecord_(values[i], colIdx, i + 1);
      if (rec.validation.eligibility === ELIGIBILITY.ELIGIBLE) records.push(rec);
    }
    return records;
  }

  function readSupervisorEmails() {
    try {
      const sheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(SUPERVISOR_SHEET_NAME);
      if (!sheet || sheet.getLastRow() < 2) return [];
      const values = sheet.getDataRange().getValues();
      const emailIdx = values[0].map(h => String(h).trim()).indexOf(SUPERVISOR_EMAIL_HEADER);
      if (emailIdx < 0) return [];
      
      const out = [];
      for (let i = 1; i < values.length; i++) {
        const email = String(values[i][emailIdx] || '').trim().toLowerCase();
        if (EMAIL_REGEX.test(email) && out.indexOf(email) === -1) out.push(email);
      }
      return out;
    } catch(e) { return []; }
  }

  function updateTrackingStatus(rowNumber, status) {
    const sheet = _openSourceSheet_();
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    const colIdx = headers.map(h => String(h).trim()).indexOf(COLUMN_MAPPING.trackingStatus.header);
    if (colIdx >= 0) sheet.getRange(rowNumber, colIdx + 1).setValue(status);
    else sheet.getRange(COLUMN_MAPPING.trackingStatus.column + rowNumber).setValue(status);
  }

  function _openSourceSheet_() {
    return SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(SOURCE_SHEET_NAME);
  }

  function _buildColumnIndex_(headers) {
    const trimmed = headers.map(h => String(h || '').trim());
    const colIdx = {};
    Object.keys(COLUMN_MAPPING).forEach(field => {
      const idx = trimmed.indexOf(COLUMN_MAPPING[field].header);
      if (idx >= 0) colIdx[field] = idx;
    });
    return colIdx;
  }

  function _mapRowToRecord_(row, colIdx, rowNumber) {
    const record = {
      rowNumber: rowNumber,
      fullName: String(row[colIdx.fullName] || '').trim(),
      internshipEndDate: _readDate_(row[colIdx.internshipEndDate]),
      internEmail: String(row[colIdx.internEmail] || '').trim().toLowerCase(),
      internshipStatus: String(row[colIdx.internshipStatus] || '').trim(),
      trackingStatus: String(row[colIdx.trackingStatus] || '').trim(),
      validation: { isValid: true, eligibility: ELIGIBILITY.ELIGIBLE, errors: [] }
    };
    
    const folderData = _readFolderLink_(row[colIdx.folderLink]);
    record.folderLink = folderData.url;
    record.folderId = folderData.id;

    if (!record.fullName || !EMAIL_REGEX.test(record.internEmail) || !record.internshipEndDate || !record.folderId || ALLOWED_INTERNSHIP_STATUSES.indexOf(record.internshipStatus) < 0) {
      record.validation.isValid = false;
      record.validation.eligibility = ELIGIBILITY.INVALID;
      return record;
    }

    if (isExceptionUser(record.internEmail)) record.validation.eligibility = ELIGIBILITY.EXCEPTION;
    else if (STATUS_ACTIVE.indexOf(record.internshipStatus) >= 0) record.validation.eligibility = ELIGIBILITY.ACTIVE;
    else if (!_hasEndDatePassed_(record.internshipEndDate)) record.validation.eligibility = ELIGIBILITY.NOT_ENDED;
    
    return record;
  }

  function _readDate_(v) {
    if (!v) return null;
    if (Object.prototype.toString.call(v) === '[object Date]') return Utilities.formatDate(v, SCRIPT_TIMEZONE, DATE_FORMAT_ISO);
    return _parseIsoDate_(String(v).trim()) || null;
  }

  function _parseIsoDate_(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m) return null;
    return Utilities.formatDate(new Date(+m[1], +m[2] - 1, +m[3]), SCRIPT_TIMEZONE, DATE_FORMAT_ISO);
  }

  function _readFolderLink_(v) {
    const url = String(v || '').trim();
    const match = FOLDER_URL_REGEX.exec(url);
    return match ? { url: url, id: match[1] } : { url: url, id: null };
  }

  function _isBlankRow_(row) {
    return row.every(cell => cell === null || cell === undefined || String(cell).trim() === '');
  }

  // *แก้ไข* เช็กวันที่ END แบบตรงๆ ไม่บวกวัน
  function _hasEndDatePassed_(isoEndDate) {
    if (!isoEndDate) return false;
    const parts = isoEndDate.split('-');
    const endDate = new Date(parts[0], parts[1] - 1, parts[2]);
    endDate.setDate(endDate.getDate() + GRACE_PERIOD_DAYS);
    const targetDateIso = Utilities.formatDate(endDate, SCRIPT_TIMEZONE, DATE_FORMAT_ISO);
    const todayIso = Utilities.formatDate(new Date(), SCRIPT_TIMEZONE, DATE_FORMAT_ISO);
    return todayIso >= targetDateIso; // ถ้าวันนี้ >= วันที่ END ถือว่าผ่าน
  }

  // --- 5. MAIN ORCHESTRATION ---
  function runRevocationPipeline(triggerSource, dryRunOverride) {
    const dryRun = dryRunOverride !== undefined ? dryRunOverride : DRY_RUN;
    setExceptionEmails(readSupervisorEmails());
    startRun({ triggerSource: triggerSource || 'MANUAL', dryRun: dryRun });

    let candidates = [];
    try { candidates = getEligibleCandidates(); } catch (e) { return endRun({}), flush(), false; }

    const counters = { totalCandidates: candidates.length, revoked: 0, alreadyRevoked: 0, skipped: 0, failed: 0 };
    candidates.forEach(rec => {
      try {
        const result = revokeAccess(rec.folderId, rec.internEmail, { trackingStatus: rec.trackingStatus, dryRunOverride: dryRun });
        recordInternResult({ fullName: rec.fullName, rowNumber: rec.rowNumber, internEmail: rec.internEmail, folderId: result.folderId, action: result.action, outcome: result.outcome, message: result.errorMessage });
        
        if (result.outcome === 'failure') counters.failed++;
        else if (result.action === 'REVOKED') counters.revoked++;
        else if (result.action === 'ALREADY_REVOKED' || result.action === 'ALREADY_REVOKED_PROVISIONED') counters.alreadyRevoked++;
        else counters.skipped++;

        if (!dryRun && result.action !== 'SKIPPED_EXCEPTION_USER') {
          const newStatus = result.outcome === 'failure' ? TRACKING_STATUS_REVOCATION_FAILED : TRACKING_STATUS_ACCESS_REVOKED;
          updateTrackingStatus(rec.rowNumber, newStatus);
        }
      } catch (e) { counters.failed++; }
    });
    
    endRun(counters);
    flush();
  }

  // --- 6. TRIGGER MANAGEMENT & EXPORTS ---
  return {
    installTrigger: function() {
      const triggers = ScriptApp.getProjectTriggers();
      for (let i = 0; i < triggers.length; i++) {
        if (triggers[i].getHandlerFunction() === TRIGGER_HANDLER_FUNCTION) return Logger.log('Trigger already exists.');
      }
      ScriptApp.newTrigger(TRIGGER_HANDLER_FUNCTION).timeBased().everyDays(1).atHour(TRIGGER_HOUR).nearMinute(TRIGGER_MINUTE).create();
      Logger.log('Installed trigger at ' + TRIGGER_HOUR + ':00');
    },
    uninstallTrigger: function() {
      ScriptApp.getProjectTriggers().forEach(t => {
        if (t.getHandlerFunction() === TRIGGER_HANDLER_FUNCTION) ScriptApp.deleteTrigger(t);
      });
      Logger.log('Trigger uninstalled.');
    },
    onScheduledRun: function() { runRevocationPipeline('SCHEDULED'); },
    runSampleDryRun: function() { runRevocationPipeline('DRY_RUN_MANUAL', true); }
  };

})();