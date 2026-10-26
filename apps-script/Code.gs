/**
 * Sync issue-tracker tickets into this spreadsheet, then move inactive
 * customers' tickets to On Hold.
 *
 * Sheet layout (row 1 is the header and is never overwritten once present):
 *   A Key
 *   B Summary
 *   C Catalyst (migrated)
 *   D Status
 *   E Assignee
 *   F Search Template
 *   G Reporter
 *   H Created
 *   I Customer Alias
 *   J Active Status
 *       =IF(I2 = "", "", IF(ISNUMBER(MATCH(I2, L:L, 0)), "InActive", "Active"))
 *   K unused
 *   L reference list of inactive customer aliases (never cleared by this script)
 *
 * SETUP
 * 1. Create the spreadsheet and a tab named in CONFIG.SHEET_NAME (default
 *    "Tickets"). Put inactive customer aliases in column L. A header in L1 is
 *    included by the formula's L:L lookup, so that header must not equal a
 *    real alias.
 * 2. Extensions > Apps Script. Create two script files and paste in Code.gs
 *    and TicketLogic.js. If you use clasp, push this folder as-is.
 * 3. Replace the CONFIG placeholders (base URL, JQL, field ids, sheet name).
 *    Store the credential in Script Properties instead of the source file:
 *      Project Settings > Script Properties
 *        API_TOKEN               Jira API token (or the password for basic auth)
 *        API_EMAIL               account email used with basic auth
 *        BEARER_TOKEN            used only when AUTH.TYPE is "bearer"
 *        ON_HOLD_TRANSITION_ID   used when TRANSITION.MODE is "id"
 *    A Script Property overrides the matching CONFIG value.
 * 4. Discover the On Hold transition id. Select logTransitionsForIssue in the
 *    editor, pass a key that is not already On Hold, and run it. Copy the id
 *    whose destination is "On Hold" into ON_HOLD_TRANSITION_ID. Transition ids
 *    depend on the workflow and the current status. If one id does not work
 *    from every status, set TRANSITION.MODE to "name".
 * 5. Run main once from the editor and approve the spreadsheet, external
 *    request, and trigger scopes.
 * 6. Reload the spreadsheet. Use the Ticket Sync menu, or install the trigger.
 *
 * TIME-DRIVEN TRIGGER
 * Menu: Ticket Sync > Install hourly trigger.
 * Or UI: left sidebar Triggers (alarm clock) > Add Trigger >
 *   function main, event source Time-driven, hour timer.
 * The script timezone is Asia/Calcutta (see appsscript.json). Remove the
 * trigger from the same menu or from the Triggers page. Overlapping runs are
 * skipped with a script lock.
 *
 * CUSTOM MENU
 * onOpen adds Ticket Sync when this project is bound to the spreadsheet
 * (Extensions > Apps Script from that sheet). Reload the sheet after saving.
 *
 * Jira Cloud notes
 * - Search uses GET /rest/api/3/search/jql and nextPageToken. The removed
 *   /rest/api/3/search endpoint is not the default. Data Center can switch
 *   SEARCH.PATH to /rest/api/2/search and SEARCH.PAGINATION to "startAt".
 * - The enhanced search returns only issue ids unless `fields` is set. Leave
 *   SEARCH.PARAMS.fields null to request every field referenced by CONFIG.FIELDS.
 * - Jira Cloud rejects unbounded JQL. Keep a project (or other) restriction.
 * - POST /rest/api/3/issue/{key}/transitions with {"transition":{"id":"..."}}
 *   returns 204 on success. The API token needs a user who can browse and
 *   transition the issues.
 * - Do not commit a real token. Placeholders that start with YOUR_ are rejected.
 */
'use strict';

var CONFIG = {
  // Blank uses the spreadsheet this script is bound to. Set an id only for a
  // standalone script (the spreadsheets scope above already allows openById).
  SPREADSHEET_ID: '',

  SHEET_NAME: 'Tickets',

  API_BASE_URL: 'https://your-domain.atlassian.net',

  AUTH: {
    // "basic" is Jira Cloud email + API token. "bearer" sends Bearer <token>.
    TYPE: 'basic',
    EMAIL: 'you@example.com',
    API_TOKEN: 'YOUR_API_TOKEN',
    BEARER_TOKEN: 'YOUR_BEARER_TOKEN'
  },

  SEARCH: {
    PATH: '/rest/api/3/search/jql',
    METHOD: 'GET',
    // GET query parameters, or the JSON body when METHOD is POST.
    // Use POST when the JQL is too long for a URL.
    PARAMS: {
      jql: 'project = YOURPROJECT AND statusCategory != Done ORDER BY updated DESC',
      maxResults: 100,
      // *navigable covers summary, status, assignee, reporter, and created
      // before the real custom field ids are known. Set fields to null after
      // FIELDS uses real ids (customfield_10050) to request only those fields.
      // Jira rejects a fields list that names an unknown id.
      fields: ['*navigable']
    },
    // "nextPageToken" (Jira Cloud search/jql), "startAt" (legacy / Data Center), or "none".
    PAGINATION: 'nextPageToken',
    // Dot-path of the issue array. Use "" when the response body is a raw array.
    ISSUES_PATH: 'issues',
    MAX_PAGES: 50
  },

  // Dot-paths into each issue. Point catalyst, search template, and customer
  // alias at the real custom field ids (customfield_10050, and so on).
  FIELDS: {
    key: 'key',
    summary: 'fields.summary',
    catalyst: 'fields.customfield_CATALYST',
    status: 'fields.status.name',
    assignee: 'fields.assignee.displayName',
    searchTemplate: 'fields.customfield_SEARCH_TEMPLATE',
    reporter: 'fields.reporter.displayName',
    created: 'fields.created',
    customerAlias: 'fields.customfield_CUSTOMER_ALIAS'
  },

  TRANSITION: {
    PATH_TEMPLATE: '/rest/api/3/issue/{key}/transitions',
    LIST_PATH_TEMPLATE: '/rest/api/3/issue/{key}/transitions',
    // "id" posts ON_HOLD_TRANSITION_ID. "name" looks up a transition whose
    // destination status (or transition name) matches TARGET_STATUS_NAME.
    MODE: 'id',
    ON_HOLD_TRANSITION_ID: 'YOUR_ON_HOLD_TRANSITION_ID',
    TARGET_STATUS_NAME: 'On Hold',
    // Additional current statuses that already count as done for this job.
    ALREADY_TARGET_STATUSES: ['On Hold'],
    // {transitionId} is substituted. Placeholders must sit inside JSON strings.
    BODY_TEMPLATE: '{"transition":{"id":"{transitionId}"}}',
    // Merged into the body when a workflow requires extra fields. Null is typical.
    EXTRA_BODY: null,
    // UrlFetchApp.fetchAll chunk size. Lower it if the tracker returns 429.
    BATCH_SIZE: 10
  },

  // Compared case-insensitively with column J. The formula writes "InActive".
  INACTIVE_VALUE: 'InActive',

  // Log the keys that would move and skip the transition API plus column D.
  DRY_RUN: false,

  HEADER_ROW: 1,
  DATA_START_ROW: 2
};

var HEADERS = [
  'Key',
  'Summary',
  'Catalyst (migrated)',
  'Status',
  'Assignee',
  'Search Template',
  'Reporter',
  'Created',
  'Customer Alias',
  'Active Status'
];

var LOCK_WAIT_MS = 30000;
var WRITE_CHUNK_ROWS = 2000;
// Columns A-J. Column L (index 12) is the inactive-alias list and is never cleared.
var CLEAR_COLUMN_COUNT = 10;

/**
 * Sync tickets, wait for the Active Status formulas, then transition them.
 */
function main() {
  withLock_(function () {
    syncTicketsToSheet_();
    SpreadsheetApp.flush();
    transitionInactiveTicketsToOnHold_();
  });
}

/** Fetch tickets and rewrite columns A-J from row 2 down. Column L is kept. */
function syncTicketsToSheet() {
  withLock_(syncTicketsToSheet_);
}

/** Move InActive tickets that are not already On Hold, then update column D. */
function transitionInactiveTicketsToOnHold() {
  withLock_(transitionInactiveTicketsToOnHold_);
}

/** Bound-script menu. Reload the spreadsheet after editing the script. */
function onOpen() {
  try {
    SpreadsheetApp.getUi()
      .createMenu('Ticket Sync')
      .addItem('Sync and transition inactive', 'main')
      .addSeparator()
      .addItem('Sync tickets only', 'syncTicketsToSheet')
      .addItem('Transition inactive to On Hold', 'transitionInactiveTicketsToOnHold')
      .addSeparator()
      .addItem('Install hourly trigger', 'installHourlyTrigger')
      .addItem('Remove hourly trigger', 'removeHourlyTrigger')
      .addToUi();
  } catch (err) {
    Logger.log('Ticket Sync menu was not added. Open the script from the spreadsheet (Extensions > Apps Script). ' + err);
  }
}

/** Replace any existing main() time trigger with an hourly one. */
function installHourlyTrigger() {
  removeHourlyTrigger();
  ScriptApp.newTrigger('main').timeBased().everyHours(1).create();
  Logger.log('Installed an hourly time-driven trigger for main().');
}

/** Remove time-driven triggers that call main(). */
function removeHourlyTrigger() {
  var removed = 0;
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === 'main') {
      ScriptApp.deleteTrigger(trigger);
      removed++;
    }
  });
  Logger.log('Removed ' + removed + ' trigger(s) for main().');
}

/**
 * Log the transition id, name, and destination for one issue.
 * Run from the editor as logTransitionsForIssue('PROJ-123').
 * @param {string} issueKey
 */
function logTransitionsForIssue(issueKey) {
  if (!TicketLogic.isSafeIssueKey(issueKey)) {
    throw new Error('Pass an issue key, for example logTransitionsForIssue("PROJ-123").');
  }
  var response = fetchResponse_({
    url: TicketLogic.buildTransitionListUrl(CONFIG, issueKey),
    method: 'get'
  });
  var code = response.getResponseCode();
  var text = response.getContentText() || '';
  if (!TicketLogic.isSuccessStatus(code)) {
    Logger.log('Failed to list transitions for ' + issueKey + ': HTTP ' + code + ' ' + truncate_(text, 500));
    return;
  }
  var choices = TicketLogic.transitionChoices(parseJson_(text, 'transition list for ' + issueKey));
  if (choices.length === 0) {
    Logger.log('No transitions are available for ' + issueKey + ' from its current status.');
    return;
  }
  Logger.log('Available transitions for ' + issueKey + ':');
  choices.forEach(function (choice) {
    Logger.log('- id=' + choice.id + ' name="' + choice.name + '" to="' + choice.to + '"');
  });
}

function syncTicketsToSheet_() {
  var issues = fetchAllIssues_();
  var rows = issues.map(function (issue) {
    return TicketLogic.mapIssueToRow(issue, CONFIG.FIELDS);
  });
  var sheet = getSheet_();
  ensureHeaders_(sheet);
  ensureRowCapacity_(sheet, CONFIG.DATA_START_ROW + Math.max(rows.length, 1) - 1);
  writeTicketRows_(sheet, rows);
  writeActiveStatusFormulas_(sheet, rows.length);
  clearTail_(sheet, TicketLogic.tailClearStart(CONFIG.DATA_START_ROW, rows.length));
  SpreadsheetApp.flush();
  Logger.log('Synced ' + rows.length + ' ticket(s) to "' + CONFIG.SHEET_NAME + '". Column L was not modified.');
}

function transitionInactiveTicketsToOnHold_() {
  SpreadsheetApp.flush();
  var sheet = getSheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow < CONFIG.DATA_START_ROW) {
    Logger.log('No data rows to evaluate.');
    return;
  }

  var numRows = lastRow - CONFIG.DATA_START_ROW + 1;
  var width = TicketLogic.COLUMNS.ACTIVE_STATUS + 1;
  var values = sheet.getRange(CONFIG.DATA_START_ROW, TicketLogic.COLUMNS.KEY + 1, numRows, width).getValues();
  var result = TicketLogic.collectTransitionCandidates(values, {
    dataStartRow: CONFIG.DATA_START_ROW,
    inactiveValue: CONFIG.INACTIVE_VALUE,
    alreadyTargetStatuses: targetStatusNames_()
  });

  result.skippedKeys.forEach(function (key) {
    Logger.log('Skipped issue key that cannot be placed in a transition URL: ' + key);
  });
  Logger.log(
    'Eligible for "' + CONFIG.TRANSITION.TARGET_STATUS_NAME + '": ' + result.candidates.length +
    '. Inactive but already in a target status: ' + result.inactiveAlreadyOnHold +
    '. Blank Active Status: ' + result.blankActive + '.'
  );
  if (result.blankActive > 0) {
    Logger.log('Rows with a key and a blank Active Status were left unchanged. Confirm column J calculated. Spreadsheet calculation must be automatic.');
  }
  if (result.candidates.length === 0) return;

  if (CONFIG.DRY_RUN) {
    result.candidates.forEach(function (candidate) {
      Logger.log('[DRY_RUN] Would transition ' + candidate.key + ' (row ' + candidate.sheetRow + ').');
    });
    return;
  }

  var prepared = prepareTransitions_(result.candidates);
  var succeeded = postTransitions_(prepared);
  if (succeeded.length === 0) {
    Logger.log('No tickets were transitioned.');
    return;
  }

  var statusColumn = TicketLogic.applySuccessfulStatuses(
    values,
    succeeded,
    CONFIG.TRANSITION.TARGET_STATUS_NAME
  );
  sheet.getRange(CONFIG.DATA_START_ROW, TicketLogic.COLUMNS.STATUS + 1, numRows, 1).setValues(statusColumn);
  SpreadsheetApp.flush();
  Logger.log('Updated column D for ' + succeeded.length + ' ticket(s).');
}

function prepareTransitions_(candidates) {
  var mode = String(CONFIG.TRANSITION.MODE || 'id').toLowerCase();
  if (mode === 'id') {
    var transitionId = resolveConfiguredTransitionId_();
    return candidates.map(function (candidate) {
      return { candidate: candidate, transitionId: transitionId };
    });
  }
  if (mode === 'name') return prepareTransitionsByName_(candidates);
  throw new Error('TRANSITION.MODE must be "id" or "name".');
}

function prepareTransitionsByName_(candidates) {
  var prepared = [];
  TicketLogic.chunk(candidates, batchSize_()).forEach(function (batch) {
    var requests = batch.map(function (candidate) {
      return {
        url: TicketLogic.buildTransitionListUrl(CONFIG, candidate.key),
        method: 'get',
        headers: buildRequestHeaders_(),
        muteHttpExceptions: true
      };
    });
    var responses = fetchAllOrOne_(requests);
    for (var i = 0; i < responses.length; i++) {
      var transitionId = transitionIdFromListResponse_(batch[i].key, responses[i]);
      if (transitionId) prepared.push({ candidate: batch[i], transitionId: transitionId });
    }
  });
  return prepared;
}

function transitionIdFromListResponse_(issueKey, response) {
  if (!response || typeof response.getResponseCode !== 'function') {
    Logger.log('Failed to list transitions for ' + issueKey + ': ' + (response && response.error ? response.error : 'no response'));
    return null;
  }
  var code = response.getResponseCode();
  var text = response.getContentText() || '';
  if (!TicketLogic.isSuccessStatus(code)) {
    Logger.log('Failed to list transitions for ' + issueKey + ': HTTP ' + code + ' ' + truncate_(text, 300));
    return null;
  }
  var transitionId;
  try {
    transitionId = TicketLogic.findTransitionId(parseJson_(text, 'transitions for ' + issueKey), CONFIG.TRANSITION.TARGET_STATUS_NAME);
  } catch (err) {
    Logger.log('Failed to parse transitions for ' + issueKey + ': ' + err);
    return null;
  }
  if (!transitionId) {
    Logger.log('Failed transition for ' + issueKey + ': no "' + CONFIG.TRANSITION.TARGET_STATUS_NAME + '" transition is available from the current status.');
  }
  return transitionId;
}

function postTransitions_(prepared) {
  var succeeded = [];
  TicketLogic.chunk(prepared, batchSize_()).forEach(function (batch) {
    var requests = batch.map(function (item) {
      return {
        url: TicketLogic.buildTransitionUrl(CONFIG, item.candidate.key),
        method: 'post',
        contentType: 'application/json',
        headers: buildRequestHeaders_(),
        payload: TicketLogic.buildTransitionPayload(
          CONFIG.TRANSITION.BODY_TEMPLATE,
          { transitionId: item.transitionId, key: item.candidate.key },
          CONFIG.TRANSITION.EXTRA_BODY
        ),
        muteHttpExceptions: true
      };
    });
    var responses = fetchAllOrOne_(requests);
    for (var i = 0; i < responses.length; i++) {
      if (recordTransitionResponse_(batch[i], responses[i], false)) succeeded.push(batch[i].candidate);
    }
  });
  return succeeded;
}

function recordTransitionResponse_(item, response, isRetry) {
  var key = item.candidate.key;
  var suffix = isRetry ? ', retry' : '';
  if (!response || typeof response.getResponseCode !== 'function') {
    if (!isRetry) return retryTransition_(item);
    Logger.log('Failed transition for ' + key + ': ' + (response && response.error ? response.error : 'no response'));
    return false;
  }
  var code = response.getResponseCode();
  if (TicketLogic.isSuccessStatus(code)) {
    Logger.log('Transitioned ' + key + ' to "' + CONFIG.TRANSITION.TARGET_STATUS_NAME + '" (HTTP ' + code + suffix + ').');
    return true;
  }
  if (!isRetry && TicketLogic.isRetryableStatus(code)) return retryTransition_(item);
  Logger.log('Failed transition for ' + key + ': HTTP ' + code + ' ' + truncate_(response.getContentText(), 300));
  return false;
}

function retryTransition_(item) {
  Utilities.sleep(1000);
  var response;
  try {
    response = UrlFetchApp.fetch(TicketLogic.buildTransitionUrl(CONFIG, item.candidate.key), {
      method: 'post',
      contentType: 'application/json',
      headers: buildRequestHeaders_(),
      payload: TicketLogic.buildTransitionPayload(
        CONFIG.TRANSITION.BODY_TEMPLATE,
        { transitionId: item.transitionId, key: item.candidate.key },
        CONFIG.TRANSITION.EXTRA_BODY
      ),
      muteHttpExceptions: true
    });
  } catch (err) {
    response = { error: err };
  }
  return recordTransitionResponse_(item, response, true);
}

function fetchAllIssues_() {
  var issues = [];
  var page = { pageToken: null, startAt: 0 };
  var maxPages = CONFIG.SEARCH.MAX_PAGES || 50;
  for (var i = 0; i < maxPages; i++) {
    var request = TicketLogic.buildSearchRequest(CONFIG, page);
    var json = fetchJson_(request);
    var batch = TicketLogic.extractIssues(json, CONFIG.SEARCH.ISSUES_PATH);
    for (var j = 0; j < batch.length; j++) issues.push(batch[j]);
    if (batch.length === 0) break;
    var next = TicketLogic.getNextPage(json, CONFIG.SEARCH.PAGINATION, {
      pageToken: page.pageToken,
      startAt: page.startAt || 0,
      pageSize: batch.length,
      maxResults: request.pageSize
    });
    if (!next) break;
    if (i === maxPages - 1) {
      Logger.log('Search stopped at MAX_PAGES=' + maxPages + '. Some tickets were not fetched.');
      break;
    }
    page = next;
  }
  issues = TicketLogic.dedupeIssues(issues);
  Logger.log('Fetched ' + issues.length + ' issue(s) from ' + CONFIG.API_BASE_URL + CONFIG.SEARCH.PATH + '.');
  return issues;
}

function fetchJson_(request) {
  var response = fetchResponse_(request);
  var code = response.getResponseCode();
  var text = response.getContentText() || '';
  if (!TicketLogic.isSuccessStatus(code)) {
    throw new Error('Search failed HTTP ' + code + ': ' + truncate_(text, 500));
  }
  return parseJson_(text, 'search response');
}

function fetchResponse_(request) {
  var options = {
    method: request.method,
    headers: buildRequestHeaders_(),
    muteHttpExceptions: true
  };
  if (request.payload != null) {
    options.payload = request.payload;
    options.contentType = request.contentType || 'application/json';
  }
  try {
    return UrlFetchApp.fetch(request.url, options);
  } catch (err) {
    throw new Error('Request failed for ' + request.url + ': ' + err);
  }
}

function fetchAllOrOne_(requests) {
  try {
    return UrlFetchApp.fetchAll(requests);
  } catch (err) {
    Logger.log('Batch HTTP request failed (' + err + '). Retrying one by one.');
    return requests.map(function (request) {
      var options = {};
      Object.keys(request).forEach(function (key) {
        if (key !== 'url') options[key] = request[key];
      });
      try {
        return UrlFetchApp.fetch(request.url, options);
      } catch (singleErr) {
        return { error: singleErr };
      }
    });
  }
}

function ensureRowCapacity_(sheet, lastRowNeeded) {
  var maxRows = sheet.getMaxRows();
  if (lastRowNeeded > maxRows) sheet.insertRowsAfter(maxRows, lastRowNeeded - maxRows);
}

function writeTicketRows_(sheet, rows) {
  if (rows.length === 0) return;
  var width = TicketLogic.FIELD_ORDER.length;
  for (var offset = 0; offset < rows.length; offset += WRITE_CHUNK_ROWS) {
    var slice = rows.slice(offset, offset + WRITE_CHUNK_ROWS);
    sheet.getRange(CONFIG.DATA_START_ROW + offset, TicketLogic.COLUMNS.KEY + 1, slice.length, width).setValues(slice);
  }
}

function writeActiveStatusFormulas_(sheet, rowCount) {
  var formulas = TicketLogic.buildActiveStatusFormulas(CONFIG.DATA_START_ROW, rowCount);
  for (var offset = 0; offset < formulas.length; offset += WRITE_CHUNK_ROWS) {
    var slice = formulas.slice(offset, offset + WRITE_CHUNK_ROWS);
    sheet.getRange(CONFIG.DATA_START_ROW + offset, TicketLogic.COLUMNS.ACTIVE_STATUS + 1, slice.length, 1).setFormulas(slice);
  }
}

/**
 * Clear columns A-J below the rows just written. Column L is outside this range.
 * Fetch failures never reach here, so a bad API response does not blank the sheet.
 */
function clearTail_(sheet, firstRowToClear) {
  var lastRow = Math.max(sheet.getLastRow(), firstRowToClear - 1);
  if (lastRow < firstRowToClear) return;
  sheet.getRange(firstRowToClear, 1, lastRow - firstRowToClear + 1, CLEAR_COLUMN_COUNT).clearContent();
}

function ensureHeaders_(sheet) {
  var range = sheet.getRange(CONFIG.HEADER_ROW, 1, 1, HEADERS.length);
  var current = range.getValues()[0];
  var empty = current.every(function (cell) { return String(cell).trim() === ''; });
  if (empty) {
    range.setValues([HEADERS]);
    Logger.log('Wrote header row on "' + sheet.getName() + '".');
    return;
  }
  for (var i = 0; i < HEADERS.length; i++) {
    if (String(current[i]).trim() !== HEADERS[i]) {
      Logger.log('Header mismatch at column ' + (i + 1) + ': expected "' + HEADERS[i] + '", found "' + current[i] + '". Row 1 was left unchanged.');
    }
  }
}

function getSheet_() {
  var ss = getSpreadsheet_();
  var sheet = ss.getSheetByName(CONFIG.SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.SHEET_NAME);
    Logger.log('Created sheet "' + CONFIG.SHEET_NAME + '".');
  }
  return sheet;
}

function getSpreadsheet_() {
  if (CONFIG.SPREADSHEET_ID) return SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('No active spreadsheet. Bind this script to a sheet or set CONFIG.SPREADSHEET_ID.');
  return ss;
}

function targetStatusNames_() {
  return [].concat(CONFIG.TRANSITION.TARGET_STATUS_NAME || []).concat(CONFIG.TRANSITION.ALREADY_TARGET_STATUSES || []).filter(function (name) {
    return name != null && String(name).trim() !== '';
  });
}

function batchSize_() {
  var size = Number(CONFIG.TRANSITION.BATCH_SIZE);
  if (!isFinite(size) || size < 1) return 10;
  return Math.floor(size);
}

function buildRequestHeaders_() {
  return {
    Accept: 'application/json',
    Authorization: buildAuthorizationHeader_()
  };
}

function buildAuthorizationHeader_() {
  var auth = CONFIG.AUTH || {};
  var type = String(auth.TYPE || 'basic').toLowerCase();
  if (type === 'bearer') {
    var bearer = readSecret_('BEARER_TOKEN', auth.BEARER_TOKEN);
    assertConfiguredSecret_('BEARER_TOKEN', bearer);
    return 'Bearer ' + bearer;
  }
  if (type === 'basic') {
    var email = readSecret_('API_EMAIL', auth.EMAIL);
    var token = readSecret_('API_TOKEN', auth.API_TOKEN);
    assertConfiguredSecret_('API_EMAIL', email);
    assertConfiguredSecret_('API_TOKEN', token);
    return 'Basic ' + Utilities.base64Encode(email + ':' + token);
  }
  throw new Error('AUTH.TYPE must be "basic" or "bearer".');
}

function resolveConfiguredTransitionId_() {
  var id = readSecret_('ON_HOLD_TRANSITION_ID', CONFIG.TRANSITION.ON_HOLD_TRANSITION_ID);
  assertConfiguredSecret_('ON_HOLD_TRANSITION_ID', id);
  return String(id).trim();
}

function readSecret_(propertyName, fallback) {
  try {
    var stored = PropertiesService.getScriptProperties().getProperty(propertyName);
    if (stored != null && String(stored).trim() !== '') return String(stored).trim();
  } catch (err) {
    Logger.log('Could not read Script Property ' + propertyName + '. Using CONFIG. ' + err);
  }
  return fallback;
}

function assertConfiguredSecret_(label, value) {
  var text = value == null ? '' : String(value).trim();
  if (text === '' || text.indexOf('YOUR_') === 0 || text === 'you@example.com') {
    throw new Error('Missing ' + label + '. Set the Script Property or replace the CONFIG placeholder. See the setup notes at the top of Code.gs.');
  }
}

function parseJson_(text, label) {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error('Could not parse ' + label + ': ' + truncate_(text, 300));
  }
}

function truncate_(text, limit) {
  var clean = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  if (clean.length <= limit) return clean;
  return clean.slice(0, limit) + '...';
}

function formatError_(err) {
  if (!err) return 'Unknown error';
  return err.stack || String(err);
}

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_WAIT_MS)) {
    Logger.log('Skipped: another run holds the script lock.');
    return;
  }
  try {
    fn();
  } catch (err) {
    Logger.log('Run failed: ' + formatError_(err));
    throw err;
  } finally {
    lock.releaseLock();
  }
}
