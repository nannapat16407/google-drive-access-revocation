/**
 * @fileoverview Manual-test entry points for the Apps Script IDE.
 *
 * Each function is a small, side-effecting test designed to be run from the
 * editor's "Select function" dropdown. Not called by the pipeline.
 *
 * Suggested order for a fresh deployment:
 *   1. testLogCreation()    — verify log sheet auto-create + row write/flush.
 *   2. testTriggerInstall() — verify trigger install is idempotent.
 *   3. runSampleDryRun()    — exercise the full pipeline in dry-run mode.
 */

// =============================================================================
// Public API
// =============================================================================

/**
 * Runs the full pipeline in dry-run against the current Timeline snapshot.
 * Produces complete logs but performs NO Drive mutations.
 *
 * After running, verify in the log sheet:
 *   - One INTERN row per ELIGIBLE candidate.
 *   - ACTION column reads 'DRY_RUN' for every intern row.
 *   - MESSAGE distinguishes "would have removed" from "no permission found".
 *   - RUN_SUMMARY row counts match the INTERN rows.
 *
 * @returns {Object} The summary from runRevocationPipelineDry().
 */
function runSampleDryRun() {
  Logger.log('runSampleDryRun: starting dry-run pipeline...');
  const summary = runRevocationPipelineDry();
  Logger.log('runSampleDryRun: complete. Summary:');
  Logger.log(JSON.stringify(summary, null, 2));
  return summary;
}

/**
 * Verifies logService can create/open the log sheet and write one
 * INTERN + RUN_SUMMARY row pair. Does NOT touch driveService or sheetService reads.
 * Safe to run repeatedly (appends two rows each time).
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
 * Verifies the trigger installs idempotently and lists current project triggers.
 * Does NOT uninstall — call uninstallTrigger() separately to remove.
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
