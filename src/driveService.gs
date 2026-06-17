/**
 * @fileoverview Wrapper around DriveApp for revoking per-intern access to
 * assigned folders. Sole owner of all Drive permission mutations.
 *
 * Confirmed assumptions governing this implementation:
 *   - Permission type : Direct Share (the intern was added by email).
 *   - Folder scope    : Main folder only (no recursive subfolder walk).
 *   - The script owner has at least Editor / Manager permission on every
 *     intern folder, so it can enumerate and remove permissions.
 *
 * Public API (per docs/SystemDesign.md §2.3):
 *   - revokeAccess(folderUrlOrId, internEmail, opts?)  -> RevocationResult
 *   - listPermissions(folderUrlOrId)                   -> PermissionInfo[]
 *   - isExceptionUser(email)                           -> boolean
 *
 * Outcome codes returned in RevocationResult.action are the controlled
 * vocabulary defined in docs/DataDictionary.md §4.7:
 *
 *   REVOKED                     Permission was found and removed.
 *   ALREADY_REVOKED             No permission found; treated as success.
 *   ALREADY_REVOKED_PROVISIONED Same as above but `trackingStatus` was
 *                               'Access Shared' — flagged at WARN because
 *                               a permission was expected to exist.
 *   SKIPPED_EXCEPTION_USER      Email is on EXCEPTION_EMAILS; no action.
 *   DRIVE_API_ERROR             Drive call failed after bounded retries.
 *   FOLDER_NOT_ACCESSIBLE       Folder does not exist or the running user
 *                               cannot read its permissions.
 *   DRY_RUN                     DRY_RUN is on (or overridden); no Drive
 *                               mutation performed.
 *
 * OAuth scope required: https://www.googleapis.com/auth/drive
 * (declared in appsscript.json at project-link time).
 *
 * Limitations:
 *   - Uses DriveApp rather than the Drive Advanced Service. DriveApp
 *     covers editors, viewers, and commenters (via getViewers() /
 *     removeViewer()), which is sufficient for Direct Share. If future
 *     requirements need raw permission IDs or wildcard shares, switch
 *     to Drive.Permissions.list / Drive.Permissions.remove.
 *   - Does not walk subfolders (per Folder Scope assumption).
 *   - Does not handle Google Group membership (per Direct Share
 *     assumption; see docs/OpenQuestions.md Q-08).
 */

// =============================================================================
// Tunable constants (module-local)
// =============================================================================

/**
 * Maximum number of retries on transient Drive errors (HTTP 429 / 5xx,
 * timeouts). Total attempts = DRIVE_MAX_RETRIES + 1.
 *
 * Sourced from NFR-R2 (bounded back-off) and tuned to stay within the
 * Apps Script 6-minute execution budget even on a 100-candidate run.
 * @type {number}
 */
const DRIVE_MAX_RETRIES = 3;

/**
 * Base delay in milliseconds for the first retry. Subsequent retries
 * double the delay: 500ms, 1000ms, 2000ms.
 *
 * Total worst-case wait per failing call ≈ 3.5s, well within quotas.
 * @type {number}
 */
const DRIVE_RETRY_BASE_MS = 500;

/**
 * Minimum length for a folder ID accepted by _resolveFolderId_ when the
 * input is not a URL. Drive IDs in practice are 25–45 chars of
 * [A-Za-z0-9_-]; we use a conservative lower bound to reject obvious
 * garbage without over-constraining.
 * @type {number}
 */
const DRIVE_FOLDER_ID_MIN_LENGTH = 8;

/**
 * Runtime exception list that supplements the static EXCEPTION_EMAILS
 * array in config.gs. Populated by main.gs at the start of every run
 * via setExceptionEmails(), typically with supervisor emails read from
 * the Supervisor sheet.
 *
 * Stays empty until setExceptionEmails() is first called, so the
 * module's default behaviour is identical to the pre-setter version.
 *
 * Apps Script module state does not persist across invocations, so
 * this resets to `[]` on every trigger fire — main.gs repopulates it
 * each run.
 * @type {string[]}
 */
let _dynamicExceptionEmails = [];

// =============================================================================
// Public API
// =============================================================================

/**
 * Revokes an intern's access to their assigned Drive folder.
 *
 * The function is idempotent (NFR-S5): calling it on an intern who has
 * already been revoked returns ALREADY_REVOKED with `outcome: 'success'`,
 * never an error.
 *
 * Order of checks (priority encoded by control flow):
 *   1. Validate inputs           -> DRIVE_API_ERROR on bad folder/email.
 *   2. Exception allowlist       -> SKIPPED_EXCEPTION_USER.
 *   3. Dry-run                   -> DRY_RUN.
 *   4. Open folder               -> FOLDER_NOT_ACCESSIBLE on failure.
 *   5. List editors + viewers    -> DRIVE_API_ERROR on failure.
 *   6. Match + remove            -> REVOKED or DRIVE_API_ERROR.
 *   7. No match                  -> ALREADY_REVOKED (or _PROVISIONED).
 *
 * @param {string} folderUrlOrId - Either a Drive folder URL
 *     (`https://drive.google.com/drive/folders/{id}`) or a raw folder ID.
 * @param {string} internEmail - The intern's email. Canonicalised to
 *     trimmed lowercase before matching.
 * @param {{trackingStatus: ?string, dryRunOverride: ?boolean}=} opts
 *     Optional. `trackingStatus` (typically the value from the
 *     TRACKING STATUS column) escalates ALREADY_REVOKED to
 *     ALREADY_REVOKED_PROVISIONED when set to 'Access Shared'.
 *     `dryRunOverride` forces dry-run on/off regardless of the global
 *     DRY_RUN flag; useful for ad-hoc previews.
 * @returns {RevocationResult} See typedef below.
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

  // 2. Exception allowlist — never revoke, even in dry-run mode.
  if (isExceptionUser(email)) {
    return _result_(folderId, email, 'SKIPPED_EXCEPTION_USER', 'success', null, 0);
  }

  // 3. Dry-run short-circuit. We DO look up the folder and permission
  //    set under dry-run so the log can report what WOULD have happened,
  //    but we never call removeEditor / removeViewer.
  // 4 + 5. Open folder and enumerate permissions (with retry).
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

  // 6. Match by email. Commenter access is reported by DriveApp as a
  //    viewer, so checking getViewers() covers both viewer and commenter
  //    roles.
  const totalAttempts = editors.attempts + viewers.attempts;
  const isEditor = _findUserByEmail_(editors.value, email) !== null;
  const isViewer = _findUserByEmail_(viewers.value, email) !== null;

  if (dryRun) {
    // Report the action that WOULD have been taken.
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

  // 6 (cont.). Remove with bounded retry. removeEditor/removeViewer are
  //    idempotent at the Drive level — calling them when the user is
  //    not in the list is a no-op — but we only call after a positive
  //    match above, so the call count is meaningful.
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
 * Lists every account that currently has direct access to a folder, for
 * audit / debugging purposes.
 *
 * Returns a flat array combining editors, viewers, and commenters.
 * Commenters appear with `role: 'viewer'` because DriveApp does not
 * distinguish the two.
 *
 * @param {string} folderUrlOrId - Folder URL or raw ID.
 * @returns {Array<{emailAddress: string, role: string, source: string}>}
 *     role is 'editor' or 'viewer'; source is 'getEditors' or
 *     'getViewers'. Returns an empty array if the folder cannot be
 *     opened (callers should consult revokeAccess for diagnostics).
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
 * Determines whether an email is on the exception allowlist. The
 * allowlist has two sources, both checked here:
 *
 *   1. EXCEPTION_EMAILS (config.gs)  — the static, hard-coded list.
 *   2. _dynamicExceptionEmails      — populated at runtime by
 *      setExceptionEmails(), typically with supervisor emails read
 *      from the Supervisor sheet by main.gs.
 *
 * Both sides are canonicalised (trim + lowercase) before comparison.
 *
 * Implemented locally in driveService rather than imported from
 * sheetService to keep service boundaries clean: driveService is the
 * sole enforcer of the allowlist at permission-mutation time
 * (NFR-S2), and depending on sheetService for the check would create
 * an unwanted cross-service coupling.
 *
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
 * Replaces the runtime exception list. main.gs calls this once per
 * run with the supervisor emails read from the Supervisor sheet.
 * Pass an empty array to reset.
 *
 * Emails are canonicalised (trim + lowercase) on input so the
 * comparison in isExceptionUser stays cheap and case-insensitive.
 * Malformed entries are silently dropped (they would never match a
 * valid intern email anyway).
 *
 * This setter is additive: it does not modify EXCEPTION_EMAILS, and
 * the module's default behaviour (with no setter call) is unchanged.
 *
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
 * Accepts either a Drive folder URL or a raw folder ID and returns the
 * ID. Returns null when the input cannot be resolved.
 *
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

  // Raw ID form: allow letters, digits, underscores, hyphens.
  if (/^[\w\-]+$/.test(s) && s.length >= DRIVE_FOLDER_ID_MIN_LENGTH) {
    return s;
  }
  return null;
}

/**
 * Canonicalises an email (trim + lowercase) and validates the format.
 * Returns null when the input is not a usable email.
 *
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
 * Opens a folder by ID with bounded retry on transient errors.
 *
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
  // Folder-level failures are usually 404 / 403 — surface as
  // FOLDER_NOT_ACCESSIBLE rather than DRIVE_API_ERROR.
  const code = _isAccessError_(r.error)
    ? 'FOLDER_NOT_ACCESSIBLE'
    : 'DRIVE_API_ERROR';
  return { ok: false, folder: null, code: code, message: r.message, attempts: r.attempts };
}

/**
 * Runs a Drive list operation with bounded retry.
 *
 * @param {function(): Object[]} fn - The list operation to run.
 * @param {string} label - Human-readable name for diagnostics.
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
 * Runs a Drive removal operation (removeEditor / removeViewer) with
 * bounded retry.
 *
 * @param {function(): void} fn - The removal operation.
 * @param {string} label - Human-readable name for diagnostics.
 * @returns {{ok: boolean, code: string, message: ?string, attempts: number}}
 * @private
 */
function _removeWithRetry_(fn, label) {
  const r = _withRetry_(fn, label);
  if (r.ok) {
    return { ok: true, code: '', message: null, attempts: r.attempts };
  }
  // Removal can fail for access reasons (rare — we just listed the
  // editors successfully) or for transient reasons. Treat access
  // failures as DRIVE_API_ERROR here, since FOLDER_NOT_ACCESSIBLE
  // is reserved for "we couldn't even see the folder".
  return { ok: false, code: 'DRIVE_API_ERROR', message: r.message, attempts: r.attempts };
}

/**
 * Core retry wrapper. Runs `fn` up to DRIVE_MAX_RETRIES + 1 times,
 * retrying only on transient errors (rate limits, 5xx, timeouts).
 * Non-transient errors break the loop immediately.
 *
 * @param {function(): *} fn
 * @param {string} label - Used only to build a useful error message.
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
      // A user without a resolvable email is skipped silently.
    }
  }
  return null;
}

// =============================================================================
// Internal: result construction
// =============================================================================

/**
 * Builds a RevocationResult.
 *
 * @param {?string} folderId
 * @param {string} internEmail
 * @param {string} action - Outcome code (DataDictionary §4.7).
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
 * ALREADY_REVOKED_PROVISIONED when `trackingStatus` is 'Access Shared',
 * indicating the system expected a permission to exist but none was
 * found — a state worth flagging at WARN for follow-up.
 *
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
 * True when an error indicates the running user cannot see the folder
 * or the folder does not exist (HTTP 403 / 404 equivalents).
 *
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
 * True when an error is likely transient and worth retrying:
 * rate-limit (429), server errors (5xx), timeouts.
 *
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
 * @property {string} action          Outcome code; one of the values listed in the
 *                                    file-level docstring (DataDictionary §4.7).
 * @property {'success'|'failure'} outcome Whether the action completed without error.
 * @property {?string} errorMessage   Human-readable detail; null on clean success.
 * @property {number} attempts        Total Drive API calls made (for quota diagnostics).
 */
