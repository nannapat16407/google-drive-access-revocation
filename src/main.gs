/**
 * @fileoverview Main controller. Orchestrates a single revocation run.
 *
 * Responsibility:
 *   - Compose the services (sheetService -> driveService -> logService) into
 *     a coherent pipeline:
 *         1. Load the dynamic exception allowlist (supervisor emails
 *            from the Supervisor sheet, merged with the static
 *            EXCEPTION_EMAILS list from config.gs).
 *         2. Publish the allowlist to driveService so revokeAccess can
 *            enforce it (NFR-S2).
 *         3. Start a log run.
 *         4. Read intern records from the source sheet.
 *         5. Filter to the ELIGIBLE candidate set.
 *         6. For each candidate (per-item try/catch), call
 *            revokeAccess and record the result.
 *         7. End the log run with aggregated counts.
 *         8. Flush the log buffer to the log sheet.
 *   - Centralise error handling so a failure on one intern does not
 *     abort the run (FR-08 Layer 1). Source-sheet failures abort
 *     cleanly with an abort-level summary row (FR-08 Layer 2).
 *   - Honour the DRY_RUN flag from config.gs, with an override hook
 *     used by runRevocationPipelineDry().
 *
 * Public functions:
 *   - runRevocationPipeline(triggerSource?, opts?)  -> RunSummary
 *   - runRevocationPipelineDry()                    -> RunSummary
 *
 * Dependencies: config.gs, sheetService.gs, driveService.gs, logService.gs
 *
 * Apps Script scope note: every `.gs` file in this project shares a
 * single global scope, so functions defined in other modules are
 * called here by their bare name (e.g. `revokeAccess(...)`, not
 * `driveService.revokeAccess(...)`). The `module.function` notation
 * in docs/SystemDesign.md is illustrative only.
 */

// =============================================================================
// Tunable constants (module-local)
// =============================================================================

/**
 * Trigger-source labels recorded against each run. Kept here (not in
 * config.gs) because they are an internal implementation detail of
 * the pipeline, not an operator-tunable value.
 *
 * `DRY_RUN_MANUAL` is a distinct label so dry-run rows can be
 * filtered out of routine operator reviews.
 * @enum {string}
 */
const TRIGGER_SOURCE = {
  SCHEDULED:    'SCHEDULED',
  MANUAL:       'MANUAL',
  DRY_RUN:      'DRY_RUN_MANUAL',
  TEST:         'TEST'
};

// =============================================================================
// Public API
// =============================================================================

/**
 * Runs the full revocation pipeline using the current DRY_RUN flag in
 * config.gs (unless overridden via opts.dryRunOverride).
 *
 * Flow:
 *   1. Load + merge the exception allowlist (static + supervisor).
 *   2. Publish the merged list to driveService.
 *   3. Start a log run.
 *   4. Read candidates from the source sheet (throws on failure).
 *   5. For each candidate: try { revokeAccess + record result }.
 *   6. End + flush the log run.
 *
 * Per-intern failures NEVER abort the run (FR-08 Layer 1). A
 * source-sheet failure (workbook unopenable, schema missing) aborts
 * after writing an abort-level summary row (FR-08 Layer 2).
 *
 * @param {string=} triggerSource
 *     One of TRIGGER_SOURCE. Defaults to MANUAL.
 * @param {{dryRunOverride: ?boolean}=} opts
 *     When present, overrides the global DRY_RUN flag for this run
 *     only. Used by runRevocationPipelineDry().
 * @returns {Object} RunSummary. The same shape is returned for
 *     successful runs and for aborts; aborts additionally carry
 *     `aborted: true`, `abortReason`, and `abortError`.
 */
function runRevocationPipeline(triggerSource, opts) {
  opts = opts || {};
  const dryRun = (opts.dryRunOverride === undefined || opts.dryRunOverride === null)
    ? DRY_RUN
    : Boolean(opts.dryRunOverride);
  const source = triggerSource || TRIGGER_SOURCE.MANUAL;

  // 1. Load the dynamic exception allowlist (supervisor emails from
  //    the Supervisor sheet, merged with the static EXCEPTION_EMAILS).
  const exceptionEmails = _loadExceptionEmails_();

  // 2. Publish to driveService so revokeAccess enforces the list.
  setExceptionEmails(exceptionEmails);

  // 3. Start log run.
  const ctx = startRun({ triggerSource: source, dryRun: dryRun });

  // 4-5. Read + filter. Source-sheet failures abort cleanly here.
  let candidates;
  try {
    candidates = getEligibleCandidates();
  } catch (e) {
    return _abortRun_(ctx, 'READ_FAILED', e);
  }

  // 6. Per-candidate processing.
  const counters = {
    totalCandidates: candidates.length,
    revoked:         0,
    alreadyRevoked:  0,
    skipped:         0,
    failed:          0
  };

  for (let i = 0; i < candidates.length; i++) {
    const rec = candidates[i];
    try {
      const result = revokeAccess(rec.folderId, rec.internEmail, {
        trackingStatus: rec.trackingStatus,
        dryRunOverride: dryRun
      });
      _recordResult_(rec, result);
      _bumpCounters_(counters, result);
    } catch (e) {
      // revokeAccess is designed to never throw (it returns
      // DRIVE_API_ERROR / FOLDER_NOT_ACCESSIBLE on failure). If it
      // does throw, we log and continue so one bad row cannot abort
      // the rest of the run.
      _recordFailure_(rec, e);
      counters.failed++;
    }
  }

  // 7-8. End + flush.
  const endedCtx = endRun({
    totalCandidates: counters.totalCandidates,
    revoked:         counters.revoked,
    alreadyRevoked:  counters.alreadyRevoked,
    skipped:         counters.skipped,
    failed:          counters.failed
  });
  flush();

  return {
    runId:           ctx.runId,
    triggerSource:   source,
    dryRun:          dryRun,
    startedAt:       ctx.startedAt,
    endedAt:         endedCtx.endedAt,
    durationMs:      endedCtx.durationMs,
    totalCandidates: counters.totalCandidates,
    revoked:         counters.revoked,
    alreadyRevoked:  counters.alreadyRevoked,
    skipped:         counters.skipped,
    failed:          counters.failed,
    aborted:         false
  };
}

/**
 * Convenience wrapper that forces dry-run mode regardless of DRY_RUN
 * in config.gs. Use from the Apps Script IDE or from integration
 * helpers to preview the candidate set without mutating any Drive
 * permission.
 *
 * @returns {Object} See runRevocationPipeline.
 */
function runRevocationPipelineDry() {
  return runRevocationPipeline(TRIGGER_SOURCE.DRY_RUN, { dryRunOverride: true });
}

// =============================================================================
// Internal: exception allowlist loading
// =============================================================================

/**
 * Loads the dynamic exception allowlist. Combines:
 *   - The static EXCEPTION_EMAILS list from config.gs.
 *   - The supervisor emails read from the Supervisor sheet.
 *
 * Supervisor loading is best-effort: if readSupervisorEmails() throws
 * or returns nothing, the static list alone is used. The pipeline
 * never aborts solely because the Supervisor sheet was unreachable.
 *
 * @returns {string[]} Canonicalised (trim + lowercase), deduplicated.
 * @private
 */
function _loadExceptionEmails_() {
  let supervisors = [];
  try {
    supervisors = readSupervisorEmails();
  } catch (e) {
    // readSupervisorEmails already swallows everything, but
    // belt-and-braces: an exception here must never block the run.
    supervisors = [];
  }

  const seen = {};
  const out = [];
  const merge = function (arr) {
    if (!Array.isArray(arr)) return;
    for (let i = 0; i < arr.length; i++) {
      const c = String(arr[i] == null ? '' : arr[i]).trim().toLowerCase();
      if (c && !seen[c]) {
        seen[c] = true;
        out.push(c);
      }
    }
  };
  merge(EXCEPTION_EMAILS);
  merge(supervisors);
  return out;
}

// =============================================================================
// Internal: per-intern recording
// =============================================================================

/**
 * Records a successful driveService result on the intern's log row.
 *
 * @param {Object} rec - The InternRecord (from getEligibleCandidates).
 * @param {Object} result - The RevocationResult returned by revokeAccess.
 * @private
 */
function _recordResult_(rec, result) {
  recordInternResult({
    fullName:    rec.fullName,
    rowNumber:   rec.rowNumber,
    internEmail: rec.internEmail,
    folderId:    result.folderId,
    action:      result.action,
    outcome:     result.outcome,
    message:     result.errorMessage
  });
}

/**
 * Records an unexpected exception (not a normal RevocationResult) on
 * the intern's log row.
 *
 * Action code is 'DRIVE_API_ERROR' because that is the closest match
 * in the controlled vocabulary (docs/DataDictionary.md §4.7) and the
 * exception happened inside the per-intern Drive cycle. The message
 * carries the raw exception text so an operator can diagnose.
 *
 * @param {Object} rec
 * @param {*} error
 * @private
 */
function _recordFailure_(rec, error) {
  const msg = (error && typeof error === 'object' && error.message)
    ? error.message
    : String(error);
  recordInternResult({
    fullName:    rec.fullName,
    rowNumber:   rec.rowNumber,
    internEmail: rec.internEmail,
    folderId:    rec.folderId,
    action:      'DRIVE_API_ERROR',
    outcome:     'failure',
    message:     'Unhandled exception in pipeline: ' + msg
  });
}

// =============================================================================
// Internal: summary aggregation
// =============================================================================

/**
 * Increments the appropriate counter based on a RevocationResult.
 *
 * Bucketing rules:
 *   - outcome === 'failure'                  -> failed (always wins)
 *   - action === 'REVOKED'                   -> revoked
 *   - action in {ALREADY_REVOKED,
 *                ALREADY_REVOKED_PROVISIONED}-> alreadyRevoked
 *   - action === 'SKIPPED_EXCEPTION_USER'    -> skipped
 *   - action === 'DRY_RUN'                   -> skipped
 *        (Per-intern log rows carry the distinguishing message;
 *         the summary does not subdivide dry-run outcomes.)
 *   - any other action                       -> skipped (defensive)
 *
 * @param {Object} counters - Mutated in place.
 * @param {Object} result
 * @private
 */
function _bumpCounters_(counters, result) {
  if (result.outcome === 'failure') {
    counters.failed++;
    return;
  }
  switch (result.action) {
    case 'REVOKED':
      counters.revoked++;
      return;
    case 'ALREADY_REVOKED':
    case 'ALREADY_REVOKED_PROVISIONED':
      counters.alreadyRevoked++;
      return;
    case 'SKIPPED_EXCEPTION_USER':
    case 'DRY_RUN':
      counters.skipped++;
      return;
    default:
      // Unknown action — defensive. The per-intern log row still
      // carries the raw action text for diagnosis.
      counters.skipped++;
  }
}

/**
 * Ends the run with a failure summary. Used when the source sheet
 * cannot be read and the pipeline cannot proceed.
 *
 * Always emits a RUN_SUMMARY row and flushes it, so even an abort
 * leaves an auditable trace. The flush itself is wrapped in a
 * try/catch: if the workbook is so badly unreachable that the log
 * sheet cannot be written either, we still return the abort summary
 * (with `flushError` set) rather than throwing — the caller already
 * has an error to deal with.
 *
 * @param {Object} ctx - The run context returned by startRun.
 * @param {string} reason - Short reason code (e.g. 'READ_FAILED').
 * @param {*} error - The exception that caused the abort.
 * @returns {Object} RunSummary with `aborted: true`.
 * @private
 */
function _abortRun_(ctx, reason, error) {
  const msg = (error && typeof error === 'object' && error.message)
    ? error.message
    : String(error);

  let flushError = null;
  try {
    endRun({
      totalCandidates: 0,
      revoked:         0,
      alreadyRevoked:  0,
      skipped:         0,
      failed:          0
    });
    flush();
  } catch (e) {
    // The workbook is likely unreachable (same workbook as the
    // source sheet that just failed). Surface the secondary error
    // on the returned summary; do not throw.
    flushError = (e && typeof e === 'object' && e.message)
      ? e.message
      : String(e);
  }

  return {
    runId:           ctx.runId,
    triggerSource:   ctx.triggerSource,
    dryRun:          ctx.dryRun,
    startedAt:       ctx.startedAt,
    endedAt:         null,
    durationMs:      null,
    totalCandidates: 0,
    revoked:         0,
    alreadyRevoked:  0,
    skipped:         0,
    failed:          0,
    aborted:         true,
    abortReason:     reason,
    abortError:      msg,
    flushError:      flushError
  };
}
