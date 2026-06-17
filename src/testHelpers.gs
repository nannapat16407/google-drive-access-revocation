/**
 * @fileoverview Manual-test entry points for use from the Apps Script IDE.
 *
 * Each function in this file is a small, side-effecting test designed to
 * be run interactively from the Apps Script editor's "Select function"
 * dropdown. They are NOT called by the pipeline and are NOT bound to
 * any trigger.
 *
 * Suggested run order for a fresh deployment (per docs/ProjectStatusReport.md
 * §7 "Recommended Next Steps"):
 *
 *   1. testLogCreation()    — verify the log sheet is auto-created with
 *                             the correct headers and that a single
 *                             INTERN + RUN_SUMMARY row pair can be
 *                             written and flushed.
 *   2. testTriggerInstall() — verify the time-driven trigger can be
 *                             installed idempotently and is visible in
 *                             the project trigger list.
 *   3. runSampleDryRun()    — exercise the full pipeline in dry-run
 *                             mode against the live Timeline snapshot.
 *                             No Drive permission is mutated; the log
 *                             sheet should fill with DRY_RUN rows.
 *
 * Public functions:
 *   - runSampleDryRun()
 *   - testLogCreation()
 *   - testTriggerInstall()
 *
 * Dependencies: config.gs (LOG_SHEET_NAME, DRY_RUN), and all service
 *               modules reached transitively through the pipeline.
 */

// =============================================================================
// Public API
// =============================================================================

/**
 * Runs the full revocation pipeline in dry-run mode against the
 * current Timeline snapshot. Produces complete logs in the
 * AccessRevocationLog sheet but performs NO Drive mutations.
 *
 * Use this as the smoke test after any change to sheetService or
 * driveService. After running, open the log sheet and verify:
 *   - One INTERN row per ELIGIBLE candidate.
 *   - The ACTION column reads 'DRY_RUN' for every intern row.
 *   - The MESSAGE column distinguishes "would have removed" from
 *     "no permission found".
 *   - The final RUN_SUMMARY row has counts matching the INTERN rows.
 *
 * @returns {Object} The summary object produced by runRevocationPipelineDry().
 */
function runSampleDryRun() {
  Logger.log('runSampleDryRun: starting dry-run pipeline...');
  const summary = runRevocationPipelineDry();
  Logger.log('runSampleDryRun: complete. Summary:');
  Logger.log(JSON.stringify(summary, null, 2));
  return summary;
}

/**
 * Verifies that logService can create (or open) the log sheet and
 * write a single INTERN + RUN_SUMMARY row pair. Does NOT call
 * driveService or sheetService's read path.
 *
 * Safe to run repeatedly: each invocation appends two rows to the
 * log sheet.
 *
 * @returns {{written: number, runId: string}}
 */
function testLogCreation() {
  Logger.log('testLogCreation: starting...');
  const ctx = startRun({ triggerSource: 'TEST', dryRun: true });
  Logger.log('testLogCreation: runId=' + ctx.runId);

  recordInternResult({
    fullName:    'TEST USER (synthetic)',
    rowNumber:   -1,
    internEmail: 'test@example.com',
    folderId:    'TEST_FOLDER_ID',
    action:      'DRY_RUN',
    outcome:     'success',
    message:     'Synthetic row written by testLogCreation().'
  });

  endRun({
    totalCandidates: 1,
    revoked:         0,
    alreadyRevoked:  0,
    skipped:         0,
    failed:          0
  });

  const written = flush();
  Logger.log(
    'testLogCreation: wrote ' + written + ' row(s) to "' + LOG_SHEET_NAME + '".'
  );
  return { written: written, runId: ctx.runId };
}

/**
 * Verifies that the time-driven trigger can be installed
 * idempotently, then lists every currently-registered project
 * trigger. Does NOT uninstall — call uninstallTrigger() separately
 * to remove.
 *
 * @returns {{
 *   installed: boolean,
 *   existingTriggerId: ?string,
 *   allTriggers: Array<{handler: string, type: string, id: string}>
 * }}
 */
function testTriggerInstall() {
  Logger.log('testTriggerInstall: installing (or confirming) trigger...');
  const result = installTrigger();
  const triggers = ScriptApp.getProjectTriggers().map(function (t) {
    return {
      handler: t.getHandlerFunction(),
      type:    String(t.getEventType()),
      id:      t.getUniqueId()
    };
  });
  Logger.log('testTriggerInstall: result=' + JSON.stringify(result));
  Logger.log('testTriggerInstall: current project triggers:');
  Logger.log(JSON.stringify(triggers, null, 2));
  return {
    installed:         result.installed,
    existingTriggerId: result.existingTriggerId,
    allTriggers:       triggers
  };
}
