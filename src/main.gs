/**
 * @fileoverview Main controller. Orchestrates a single revocation run.
 *
 * Pipeline:
 *   1. Load + merge exception allowlist (static + supervisor).
 *   2. Publish allowlist to driveService (NFR-S2).
 *   3. Start a log run.
 *   4. Read intern records from the source sheet.
 *   5. Filter to ELIGIBLE candidates.
 *   6. For each candidate, call revokeAccess and record the result.
 *   7. End log run with aggregated counts.
 *   8. Flush the log buffer.
 *
 * Per-intern failures never abort the run (FR-08 Layer 1). Source-sheet
 * failures abort cleanly with an abort-level summary row (FR-08 Layer 2).
 *
 * Public functions:
 *   - runRevocationPipeline(triggerSource?, opts?)  -> RunSummary
 *   - runRevocationPipelineDry()                    -> RunSummary
 */

// =============================================================================
// Tunable constants (module-local)
// =============================================================================

/**
 * Trigger-source labels recorded against each run.
 * `DRY_RUN_MANUAL` is distinct so dry-run rows can be filtered out.
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
 * Runs the full revocation pipeline using DRY_RUN (unless overridden).
 *
 * @param {string=} triggerSource - One of TRIGGER_SOURCE. Defaults to MANUAL.
 * @param {{dryRunOverride: ?boolean}=} opts - Overrides DRY_RUN for this run.
 * @returns {Object} RunSummary. Aborts additionally carry `aborted: true`,
 *     `abortReason`, and `abortError`.
 */
function runRevocationPipeline(triggerSource, opts) {
  opts = opts || {};
  const dryRun = (opts.dryRunOverride === undefined || opts.dryRunOverride === null)
    ? DRY_RUN
    : Boolean(opts.dryRunOverride);
  const source = triggerSource || TRIGGER_SOURCE.MANUAL;

  // 1. Load + merge exception allowlist.
  const exceptionEmails = _loadExceptionEmails_();

  // 2. Publish to driveService.
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
      _maybeWriteTrackingStatus_(rec, result, dryRun);
    } catch (e) {
      // revokeAccess is designed not to throw. If it does, log and continue.
      _recordFailure_(rec, e);
      counters.failed++;
      _maybeWriteTrackingStatus_(rec, { outcome: 'failure' }, dryRun);
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
 * Convenience wrapper forcing dry-run regardless of config.
 * @returns {Object} See runRevocationPipeline.
 */
function runRevocationPipelineDry() {
  return runRevocationPipeline(TRIGGER_SOURCE.DRY_RUN, { dryRunOverride: true });
}

// =============================================================================
// Internal: exception allowlist loading
// =============================================================================

/**
 * Loads the merged exception allowlist (static EXCEPTION_EMAILS + supervisor emails).
 * Supervisor loading is best-effort; never aborts on supervisor failure.
 * @returns {string[]} Canonicalised (trim + lowercase), deduplicated.
 * @private
 */
function _loadExceptionEmails_() {
  let supervisors = [];
  try {
    supervisors = readSupervisorEmails();
  } catch (e) {
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
 * Records an unexpected exception on the intern's log row.
 * Action code is 'DRIVE_API_ERROR' (closest controlled-vocabulary match).
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
 * Bucketing rules:
 *   - outcome === 'failure'                          -> failed
 *   - action === 'REVOKED'                           -> revoked
 *   - action in {ALREADY_REVOKED, ALREADY_REVOKED_PROVISIONED} -> alreadyRevoked
 *   - action in {SKIPPED_EXCEPTION_USER, DRY_RUN}    -> skipped
 *   - any other action                               -> skipped (defensive)
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
      // Unknown action — defensive. Raw action still logged per-intern.
      counters.skipped++;
  }
}

/**
 * Maps a RevocationResult to the TRACKING STATUS value to write back, or null.
 *
 * Decision matrix:
 *   - dry-run OR action === 'DRY_RUN'                -> null
 *   - action === 'SKIPPED_EXCEPTION_USER'            -> null (don't mislabel)
 *   - outcome === 'failure'                          -> 'Revocation Failed'
 *   - action in {REVOKED, ALREADY_REVOKED[_PROVISIONED]} -> 'Access Revoked'
 *   - any other action                               -> null
 *
 * ALREADY_REVOKED[_PROVISIONED] maps to 'Access Revoked' because the desired
 * end-state (no access) has been reached. SKIPPED_EXCEPTION_USER is left
 * unchanged because the allowlist is a safety net, not a state transition.
 *
 * @param {Object} result - The RevocationResult, or `{ outcome: 'failure' }`.
 * @param {boolean} dryRun - The run-level dry-run flag.
 * @returns {?string} TRACKING_STATUS_ACCESS_REVOKED, TRACKING_STATUS_REVOCATION_FAILED, or null.
 * @private
 */
function _computeNewTrackingStatus_(result, dryRun) {
  if (dryRun) return null;
  if (result.action === 'DRY_RUN') return null;
  if (result.action === 'SKIPPED_EXCEPTION_USER') return null;
  if (result.outcome === 'failure') return TRACKING_STATUS_REVOCATION_FAILED;
  switch (result.action) {
    case 'REVOKED':
    case 'ALREADY_REVOKED':
    case 'ALREADY_REVOKED_PROVISIONED':
      return TRACKING_STATUS_ACCESS_REVOKED;
    default:
      return null;
  }
}

/**
 * Writes the new TRACKING STATUS for an intern if warranted.
 * Write-back failure is logged but never aborts the run (audit trail is in the
 * per-intern log row, separate from the Timeline cell).
 *
 * @param {Object} rec - The InternRecord (needs `rowNumber`).
 * @param {Object} result - The RevocationResult or `{ outcome: 'failure' }`.
 * @param {boolean} dryRun - The run-level dry-run flag.
 * @private
 */
function _maybeWriteTrackingStatus_(rec, result, dryRun) {
  const newStatus = _computeNewTrackingStatus_(result, dryRun);
  if (newStatus === null) return;

  try {
    updateTrackingStatus(rec.rowNumber, newStatus);
  } catch (e) {
    // Don't abort the run. The Drive outcome is already logged; operator can
    // reconcile Timeline manually using the log sheet.
    const msg = (e && typeof e === 'object' && e.message) ? e.message : String(e);
    Logger.log(
      'Warning: write-back failed for row ' + rec.rowNumber +
      ' (intended status "' + newStatus + '"): ' + msg
    );
  }
}

/**
 * Ends the run with a failure summary when the source sheet cannot be read.
 *
 * Always emits a RUN_SUMMARY row and flushes it. The flush is wrapped in
 * try/catch: if the log sheet is also unreachable, the abort summary is still
 * returned (with `flushError` set) rather than throwing.
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
    // Workbook likely unreachable. Surface secondary error; do not throw.
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
