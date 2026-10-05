const REPORT_SHEET = 'Jira Sorted';
const REPORT_CELL = 'A1';
const REFRESH_HOUR = 7;

function refreshJiraReport() {
  const sheet = SpreadsheetApp.getActive().getSheetByName(REPORT_SHEET);
  if (!sheet) throw new Error(`Sheet "${REPORT_SHEET}" not found`);
  const range = sheet.getRange(REPORT_CELL);
  const formula = range.getFormula();
  if (!formula) throw new Error(`No formula in ${REPORT_SHEET}!${REPORT_CELL}`);

  // Re-setting an identical formula can be served from the custom-function cache; clearing first forces JIRA() to run again.
  range.clearContent();
  SpreadsheetApp.flush();
  range.setFormula(formula);
}

function installDailyTrigger() {
  ScriptApp.getProjectTriggers()
    .filter((t) => t.getHandlerFunction() === 'refreshJiraReport')
    .forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('refreshJiraReport').timeBased().everyDays(1).atHour(REFRESH_HOUR).create();
}
