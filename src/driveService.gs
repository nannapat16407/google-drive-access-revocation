/**
 * @fileoverview DriveApp wrapper for revoking per-intern folder access.
 * Sole owner of all Drive permission mutations.
 *
 * Assumptions:
 *   - Permission type : Direct Share (intern added by email).
 *   - Folder scope    : Main folder only (no recursive subfolder walk).
 *   - Script owner has Editor/Manager permission on every intern folder.
 *
 * Public API:
 *   - revokeAccess(folderUrlOrId, internEmail, opts?)  -> RevocationResult
 *   - listPermissions(folderUrlOrId)                   -> PermissionInfo[]
 *   - isExceptionUser(email)                           -> boolean
 *
 * RevocationResult.action codes (controlled vocabulary):
 *   REVOKED                     Permission found and removed.
 *   ALREADY_REVOKED             No permission found; treated as success.
 *   ALREADY_REVOKED_PROVISIONED Same, but `trackingStatus` was 'Access Shared' (WARN).
 *   SKIPPED_EXCEPTION_USER      Email is on EXCEPTION_EMAILS; no action.
 *   DRIVE_API_ERROR             Drive call failed after bounded retries.
 *   FOLDER_NOT_ACCESSIBLE       Folder missing or unreadable by running user.
 *   DRY_RUN                     DRY_RUN is on; no mutation performed.
 *
 * OAuth scope: https://www.googleapis.com/auth/drive
 */

// =============================================================================
// Tunable constants (module-local)
// =============================================================================

/**
 * Max retries on transient Drive errors (429 / 5xx, timeouts).
 * Total attempts = DRIVE_MAX_RETRIES + 1.
 * @type {number}
 */
const DRIVE_MAX_RETRIES = 3;

/**
 * Base backoff for first retry. Doubles each retry: 500ms, 1000ms, 2000ms.
 * @type {number}
 */
const DRIVE_RETRY_BASE_MS = 500;

/**
 * Min length for a raw folder ID input. Drive IDs are typically 25–45 chars.
 * @type {number}
 */
const DRIVE_FOLDER_ID_MIN_LENGTH = 8;

/**
 * Runtime exception list supplementing EXCEPTION_EMAILS. Populated each run
 * by main.gs via setExceptionEmails() (typically supervisor emails).
 * Resets to `[]` on every trigger fire (Apps Script module state is per-invocation).
 * @type {string[]}
 */
let _dynamicExceptionEmails = [];

// =============================================================================
// Public API
// =============================================================================

/**
 * Revokes an intern's access to their assigned Drive folder. Idempotent (NFR-S5).
 *
 * Check order:
 *   1. Validate inputs           -> DRIVE_API_ERROR on bad folder/email.
 *   2. Exception allowlist       -> SKIPPED_EXCEPTION_USER.
 *   3. Dry-run                   -> DRY_RUN.
 *   4. Open folder               -> FOLDER_NOT_ACCESSIBLE on failure.
 *   5. List editors + viewers    -> DRIVE_API_ERROR on failure.
 *   6. Match + remove            -> REVOKED or DRIVE_API_ERROR.
 *   7. No match                  -> ALREADY_REVOKED (or _PROVISIONED).
 *
 * @param {string} folderUrlOrId - Folder URL or raw folder ID.
 * @param {string} internEmail - Intern's email (canonicalised before matching).
 * @param {{trackingStatus: ?string, dryRunOverride: ?boolean}=} opts
 *     `trackingStatus` escalates ALREADY_REVOKED to ALREADY_REVOKED_PROVISIONED
 *     when 'Access Shared'. `dryRunOverride` forces dry-run on/off.
 * @returns {RevocationResult}
 */
function revokeAccess(folderUrlOrId, internEmail, opts) {
  opts = opts || {};
  const trackingStatus = opts.trackingStatus || null;
  const dryRun = (opts.dryRunOverride === null || opts.dryRunOverride === undefined)
    ? DRY_RUN
    : Boolean(opts.dryRunOverride);

  // 1. Validate inputs.
  const folderId = _resolveFolderId_(folderUrlOrId);
  const email = _canonicalEmail_(internEmail);
  if (folderId === null) {
    return _result_(null, internEmail, 'DRIVE_API_ERROR', 'failure',
      'Could not resolve a valid folder ID from input: "' + folderUrlOrId + '".', 0);
  }
  if (email === null) {
    return _result_(folderId, internEmail, 'DRIVE_API_ERROR', 'failure',
      'Could not resolve a valid email from input: "' + internEmail + '".', 0);
  }

  // 2. Exception allowlist — never revoke.
  if (isExceptionUser(email)) {
    return _result_(folderId, email, 'SKIPPED_EXCEPTION_USER', 'success', null, 0);
  }

  // 3-5. Open folder + enumerate permissions (with retry). Under dry-run we
  //    still look up so the log can report what WOULD have happened.
  const opened = _openFolderWithRetry_(folderId);
  if (!opened.ok) {
    return _result_(folderId, email, opened.code, 'failure', opened.message, opened.attempts);
  }
  const folder = opened.folder;

  const editors = _listWithRetry_(function () { return folder.getEditors(); }, 'getEditors');
  if (!editors.ok) {
    return _result_(folderId, email, editors.code, 'failure', editors.message, editors.attempts);
  }
  const viewers = _listWithRetry_(function () { return folder.getViewers(); }, 'getViewers');
  if (!viewers.ok) {
    return _result_(folderId, email, viewers.code, 'failure', viewers.message, viewers.attempts);
  }

  // 6. Match by email. Commenters appear in getViewers() (DriveApp flattens).
  const totalAttempts = editors.attempts + viewers.attempts;
  const isEditor = _findUserByEmail_(editors.value, email) !== null;
  const isViewer = _findUserByEmail_(viewers.value, email) !== null;

  if (dryRun) {
    if (isEditor || isViewer) {
      const role = isEditor ? 'editor' : 'viewer';
      return _result_(folderId, email, 'DRY_RUN', 'success',
        'Dry-run: would have removed ' + role + ' permission.', totalAttempts);
    }
    return _result_(folderId, email, 'DRY_RUN', 'success',
      'Dry-run: no permission found; nothing to remove.', totalAttempts);
  }

  if (!isEditor && !isViewer) {
    // 7. Idempotent path: nothing to remove.
    return _alreadyRevokedResult_(folderId, email, trackingStatus, totalAttempts);
  }

  // 6 (cont). Remove with bounded retry.
  const removalOutcome = isEditor
    ? _removeWithRetry_(function () { folder.removeEditor(email); }, 'removeEditor')
    : _removeWithRetry_(function () { folder.removeViewer(email); }, 'removeViewer');

  if (!removalOutcome.ok) {
    return _result_(folderId, email, removalOutcome.code, 'failure',
      removalOutcome.message, totalAttempts + removalOutcome.attempts);
  }

  return _result_(folderId, email, 'REVOKED', 'success', null,
    totalAttempts + removalOutcome.attempts);
}

/**
 * Lists every account with direct access to a folder (audit / debugging).
 * Commenters appear as `role: 'viewer'` (DriveApp does not distinguish).
 *
 * @param {string} folderUrlOrId
 * @returns {Array<{emailAddress: string, role: string, source: string}>}
 *     Empty array if the folder cannot be opened.
 */
function listPermissions(folderUrlOrId) {
  const folderId = _resolveFolderId_(folderUrlOrId);
  if (folderId === null) return [];

  let folder;
  try {
    folder = DriveApp.getFolderById(folderId);
  } catch (e) {
    return [];
  }

  const out = [];
  try {
    const editors = folder.getEditors();
    for (let i = 0; i < editors.length; i++) {
      const e = editors[i].getEmail();
      if (e) out.push({ emailAddress: e.toLowerCase(), role: 'editor', source: 'getEditors' });
    }
  } catch (e) {
    // Swallow — listPermissions is best-effort.
  }
  try {
    const viewers = folder.getViewers();
    for (let i = 0; i < viewers.length; i++) {
      const e = viewers[i].getEmail();
      if (e) out.push({ emailAddress: e.toLowerCase(), role: 'viewer', source: 'getViewers' });
    }
  } catch (e) {
    // Swallow.
  }
  return out;
}

/**
 * True if email is on the exception allowlist (static EXCEPTION_EMAILS
 * or runtime _dynamicExceptionEmails). Both sides canonicalised before compare.
 * @param {string} email
 * @returns {boolean}
 */
function isExceptionUser(email) {
  if (!email) return false;
  const e = String(email).trim().toLowerCase();
  if (!e) return false;

  for (let i = 0; i < EXCEPTION_EMAILS.length; i++) {
    if (String(EXCEPTION_EMAILS[i]).trim().toLowerCase() === e) return true;
  }
  for (let i = 0; i < _dynamicExceptionEmails.length; i++) {
    if (_dynamicExceptionEmails[i] === e) return true;
  }
  return false;
}

/**
 * Replaces the runtime exception list. main.gs calls this once per run.
 * Emails canonicalised on input; malformed entries silently dropped.
 * @param {string[]} emails
 */
function setExceptionEmails(emails) {
  if (!Array.isArray(emails)) {
    _dynamicExceptionEmails = [];
    return;
  }
  _dynamicExceptionEmails = emails
    .map(function (e) { return String(e == null ? '' : e).trim().toLowerCase(); })
    .filter(function (e) { return e.length > 0; });
}

// =============================================================================
// Internal: input resolution
// =============================================================================

/**
 * Resolves a folder URL or raw ID to the folder ID. Null if unresolvable.
 * @param {*} input
 * @returns {?string}
 * @private
 */
function _resolveFolderId_(input) {
  if (input === null || input === undefined) return null;
  const s = String(input).trim();
  if (!s) return null;

  // URL form.
  const match = FOLDER_URL_REGEX.exec(s);
  if (match && match[1]) return match[1];

  // Raw ID form.
  if (/^[\w\-]+$/.test(s) && s.length >= DRIVE_FOLDER_ID_MIN_LENGTH) {
    return s;
  }
  return null;
}

/**
 * Canonicalises an email and validates the format. Null if invalid.
 * @param {*} input
 * @returns {?string}
 * @private
 */
function _canonicalEmail_(input) {
  if (input === null || input === undefined) return null;
  const s = String(input).trim().toLowerCase();
  if (!s) return null;
  return EMAIL_REGEX.test(s) ? s : null;
}

// =============================================================================
// Internal: Drive calls with retry
// =============================================================================

/**
 * Opens a folder by ID with bounded retry.
 * @param {string} folderId
 * @returns {{ok: boolean, folder: ?GoogleAppsScript.Drive.Folder,
 *            code: string, message: ?string, attempts: number}}
 * @private
 */
function _openFolderWithRetry_(folderId) {
  const r = _withRetry_(function () {
    return DriveApp.getFolderById(folderId);
  }, 'getFolderById');
  if (r.ok) {
    return { ok: true, folder: r.value, code: '', message: null, attempts: r.attempts };
  }
  // Folder-level failures are usually 404/403 — surface as FOLDER_NOT_ACCESSIBLE.
  const code = _isAccessError_(r.error)
    ? 'FOLDER_NOT_ACCESSIBLE'
    : 'DRIVE_API_ERROR';
  return { ok: false, folder: null, code: code, message: r.message, attempts: r.attempts };
}

/**
 * Runs a Drive list operation with bounded retry.
 * @param {function(): Object[]} fn
 * @param {string} label
 * @returns {{ok: boolean, value: ?Object[], code: string, message: ?string, attempts: number}}
 * @private
 */
function _listWithRetry_(fn, label) {
  const r = _withRetry_(fn, label);
  if (r.ok) {
    return { ok: true, value: r.value, code: '', message: null, attempts: r.attempts };
  }
  const code = _isAccessError_(r.error) ? 'FOLDER_NOT_ACCESSIBLE' : 'DRIVE_API_ERROR';
  return { ok: false, value: null, code: code, message: r.message, attempts: r.attempts };
}

/**
 * Runs a Drive removal operation (removeEditor/removeViewer) with bounded retry.
 * @param {function(): void} fn
 * @param {string} label
 * @returns {{ok: boolean, code: string, message: ?string, attempts: number}}
 * @private
 */
function _removeWithRetry_(fn, label) {
  const r = _withRetry_(fn, label);
  if (r.ok) {
    return { ok: true, code: '', message: null, attempts: r.attempts };
  }
  return { ok: false, code: 'DRIVE_API_ERROR', message: r.message, attempts: r.attempts };
}

/**
 * Core retry wrapper. Runs `fn` up to DRIVE_MAX_RETRIES + 1 times, retrying
 * only on transient errors. Non-transient errors break immediately.
 * @param {function(): *} fn
 * @param {string} label - For error message only.
 * @returns {{ok: boolean, value: ?, error: ?Object, message: ?string, attempts: number}}
 * @private
 */
function _withRetry_(fn, label) {
  let lastError = null;
  for (let attempt = 1; attempt <= DRIVE_MAX_RETRIES + 1; attempt++) {
    try {
      const value = fn();
      return { ok: true, value: value, error: null, message: null, attempts: attempt };
    } catch (e) {
      lastError = e;
      if (!_isTransientError_(e)) break;
      if (attempt <= DRIVE_MAX_RETRIES) {
        const backoff = DRIVE_RETRY_BASE_MS * Math.pow(2, attempt - 1);
        Utilities.sleep(backoff);
      }
    }
  }
  const msg = label + ' failed after ' + (DRIVE_MAX_RETRIES + 1) +
    ' attempts: ' + _errorMessage_(lastError);
  return { ok: false, value: null, error: lastError, message: msg, attempts: DRIVE_MAX_RETRIES + 1 };
}

// =============================================================================
// Internal: user matching
// =============================================================================

/**
 * Finds the first User in `users` whose email matches `email`.
 * @param {Object[]} users - Result of getEditors() / getViewers().
 * @param {string} email - Canonical (lowercase) email.
 * @returns {?Object} The matching User, or null.
 * @private
 */
function _findUserByEmail_(users, email) {
  if (!users || users.length === 0) return null;
  for (let i = 0; i < users.length; i++) {
    try {
      const candidate = String(users[i].getEmail() || '').trim().toLowerCase();
      if (candidate === email) return users[i];
    } catch (e) {
      // Skip users without a resolvable email.
    }
  }
  return null;
}

// =============================================================================
// Internal: result construction
// =============================================================================

/**
 * Builds a RevocationResult.
 * @param {?string} folderId
 * @param {string} internEmail
 * @param {string} action - Outcome code.
 * @param {'success'|'failure'} outcome
 * @param {?string} errorMessage
 * @param {number} attempts - Drive API calls made.
 * @returns {RevocationResult}
 * @private
 */
function _result_(folderId, internEmail, action, outcome, errorMessage, attempts) {
  return {
    folderId: folderId,
    internEmail: internEmail,
    action: action,
    outcome: outcome,
    errorMessage: errorMessage,
    attempts: attempts
  };
}

/**
 * Builds the idempotent "no permission found" result. Escalates to
 * ALREADY_REVOKED_PROVISIONED when `trackingStatus` is 'Access Shared'.
 * @param {string} folderId
 * @param {string} email
 * @param {?string} trackingStatus
 * @param {number} attempts
 * @returns {RevocationResult}
 * @private
 */
function _alreadyRevokedResult_(folderId, email, trackingStatus, attempts) {
  const isProvisioned = String(trackingStatus || '').trim().toLowerCase() === 'access shared';
  const action = isProvisioned ? 'ALREADY_REVOKED_PROVISIONED' : 'ALREADY_REVOKED';
  const message = isProvisioned
    ? 'No permission found, but TRACKING STATUS was "Access Shared" — expected a permission to exist.'
    : null;
  return _result_(folderId, email, action, 'success', message, attempts);
}

// =============================================================================
// Internal: error classification
// =============================================================================

/**
 * True when an error indicates the folder is missing or unreadable (403/404).
 * @param {*} e
 * @returns {boolean}
 * @private
 */
function _isAccessError_(e) {
  const msg = _errorMessage_(e).toLowerCase();
  return msg.indexOf('not found') >= 0 ||
         msg.indexOf('not exist') >= 0 ||
         msg.indexOf('does not have') >= 0 ||
         msg.indexOf('insufficient') >= 0 ||
         msg.indexOf('permission') >= 0 ||
         msg.indexOf('forbidden') >= 0 ||
         msg.indexOf('403') >= 0 ||
         msg.indexOf('404') >= 0;
}

/**
 * True when an error is likely transient: rate-limit (429), 5xx, timeouts.
 * @param {*} e
 * @returns {boolean}
 * @private
 */
function _isTransientError_(e) {
  const msg = _errorMessage_(e).toLowerCase();
  return msg.indexOf('rate limit') >= 0 ||
         msg.indexOf('rate limit exceeded') >= 0 ||
         msg.indexOf('quota') >= 0 ||
         msg.indexOf('429') >= 0 ||
         msg.indexOf('500') >= 0 ||
         msg.indexOf('502') >= 0 ||
         msg.indexOf('503') >= 0 ||
         msg.indexOf('504') >= 0 ||
         msg.indexOf('timeout') >= 0 ||
         msg.indexOf('timed out') >= 0 ||
         msg.indexOf('temporarily') >= 0 ||
         msg.indexOf('unavailable') >= 0 ||
         msg.indexOf('try again') >= 0 ||
         msg.indexOf('internal error') >= 0;
}

/**
 * Safely extracts a string message from any error shape.
 * @param {*} e
 * @returns {string}
 * @private
 */
function _errorMessage_(e) {
  if (e === null || e === undefined) return '';
  if (typeof e === 'string') return e;
  if (typeof e === 'object') {
    if (typeof e.message === 'string') return e.message;
    if (typeof e.toString === 'function') {
      try { return String(e.toString()); } catch (_) { /* ignore */ }
    }
  }
  return String(e);
}

/**
 * @typedef {Object} RevocationResult
 * @property {?string} folderId       Resolved folder ID; null on resolution failure.
 * @property {string} internEmail     Email processed (canonical form when resolvable).
 * @property {string} action          Outcome code (see file-level docstring).
 * @property {'success'|'failure'} outcome Whether the action completed without error.
 * @property {?string} errorMessage   Human-readable detail; null on clean success.
 * @property {number} attempts        Total Drive API calls made (quota diagnostics).
 */
