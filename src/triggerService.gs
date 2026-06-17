/**
 * @fileoverview Manages the time-driven trigger that runs the revocation
 * pipeline automatically.
 *
 * Responsibility:
 *   - Install / uninstall the daily time-driven trigger that calls
 *     onScheduledRun() at TRIGGER_HOUR:TRIGGER_MINUTE.
 *   - Guard against duplicate installations.
 *   - Expose onScheduledRun() — the function bound to the trigger —
 *     which delegates to main.runRevocationPipeline('SCHEDULED').
 *
 * Public functions:
 *   - installTrigger()    -> { installed: boolean, existingTriggerId: ?string }
 *   - uninstallTrigger()  -> { removed: number }
 *   - onScheduledRun()    -> void   (bound to the trigger)
 *
 * Dependencies: config.gs (TRIGGER_HOUR, TRIGGER_MINUTE),
 *               main.gs   (runRevocationPipeline).
 *
 * Timezone note: Apps Script time-driven triggers fire in the script
 * project's timezone, which is set at the project level (in the
 * Apps Script IDE or in appsscript.json). TRIGGER_HOUR and
 * TRIGGER_MINUTE are interpreted in that timezone. SCRIPT_TIMEZONE
 * (config.gs) is the value the project timezone SHOULD match —
 * verify this when the project is linked via clasp.
 */

// =============================================================================
// Tunable constants (module-local)
// =============================================================================

/**
 * The function name that the trigger should call. Must match a
 * top-level function defined in this Apps Script project (it is the
 * onScheduledRun function below).
 * @type {string}
 */
const TRIGGER_HANDLER_FUNCTION = 'onScheduledRun';

// =============================================================================
// Public API
// =============================================================================

/**
 * Installs a daily time-driven trigger that fires near
 * TRIGGER_HOUR:TRIGGER_MINUTE (in the script project's timezone).
 *
 * Idempotent: if a CLOCK trigger pointing at onScheduledRun already
 * exists, this function is a no-op. The existing trigger is left
 * untouched. Call uninstallTrigger() first to force a reinstall.
 *
 * Call this from the Apps Script IDE once per deployment. Do NOT
 * call it from onScheduledRun itself — that would create a feedback
 * loop.
 *
 * @returns {{installed: boolean, existingTriggerId: ?string}}
 */
function installTrigger() {
  const existing = _findScheduledTrigger_();
  if (existing !== null) {
    Logger.log(
      'installTrigger: trigger already exists (id=' + existing.getUniqueId() +
      '). No action taken.'
    );
    return { installed: false, existingTriggerId: existing.getUniqueId() };
  }

  const trigger = ScriptApp.newTrigger(TRIGGER_HANDLER_FUNCTION)
    .timeBased()
    .everyDays(1)
    .atHour(TRIGGER_HOUR)
    .nearMinute(TRIGGER_MINUTE)
    .create();

  Logger.log(
    'installTrigger: created daily trigger (id=' + trigger.getUniqueId() +
    ') firing near ' + TRIGGER_HOUR + ':' + _pad2_(TRIGGER_MINUTE) +
    ' in the script timezone.'
  );
  return { installed: true, existingTriggerId: null };
}

/**
 * Removes every time-driven trigger owned by this script that points
 * at onScheduledRun. Other triggers (if any) are left untouched.
 *
 * Safe to call when no trigger exists — returns { removed: 0 }.
 *
 * @returns {{removed: number}}
 */
function uninstallTrigger() {
  const triggers = ScriptApp.getProjectTriggers();
  let removed = 0;
  for (let i = 0; i < triggers.length; i++) {
    const t = triggers[i];
    if (t.getHandlerFunction() === TRIGGER_HANDLER_FUNCTION) {
      ScriptApp.deleteTrigger(t);
      removed++;
    }
  }
  Logger.log('uninstallTrigger: removed ' + removed + ' trigger(s).');
  return { removed: removed };
}

/**
 * The entry point that the time-driven trigger calls. Delegates to
 * runRevocationPipeline with triggerSource = SCHEDULED.
 *
 * Wrapped in its own try/catch so that an uncaught error in the
 * pipeline surfaces in the Apps Script execution log AND in the
 * runtime's failure-notification email to the script owner (FR-08
 * Layer 3), rather than failing silently.
 *
 * The caught error is re-thrown after logging so the Apps Script
 * runtime records the execution as a failure.
 */
function onScheduledRun() {
  let summary;
  try {
    summary = runRevocationPipeline(TRIGGER_SOURCE.SCHEDULED);
  } catch (e) {
    const msg = (e && e.message) ? e.message : String(e);
    Logger.log('onScheduledRun FAILED: ' + msg);
    throw e; // Re-throw so the runtime records the failure.
  }
  Logger.log('onScheduledRun completed: ' + JSON.stringify(summary));
}

// =============================================================================
// Internal
// =============================================================================

/**
 * Returns the active scheduled trigger if one exists, else null.
 *
 * "Scheduled" means: a CLOCK-trigger whose handler function is
 * onScheduledRun. Other CLOCK triggers (if any exist) are ignored.
 *
 * @returns {?GoogleAppsScript.Script.Trigger}
 * @private
 */
function _findScheduledTrigger_() {
  const triggers = ScriptApp.getProjectTriggers();
  for (let i = 0; i < triggers.length; i++) {
    const t = triggers[i];
    if (t.getHandlerFunction() === TRIGGER_HANDLER_FUNCTION &&
        t.getEventType() === ScriptApp.EventType.CLOCK) {
      return t;
    }
  }
  return null;
}

/**
 * Pads a number to two digits with a leading zero. Used only to
 * format a clean log message in installTrigger().
 * @param {number} n
 * @returns {string}
 * @private
 */
function _pad2_(n) {
  return n < 10 ? '0' + n : String(n);
}
