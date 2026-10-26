/**
 * Sync issue-tracker tickets into this spreadsheet, then move inactive
 * customers' tickets to On Hold.
 *
 * Paste this whole file into the Apps Script editor (Extensions > Apps Script).
 * Replace the default Code.gs contents. Do not add a separate manifest or a
 * second file. Save the project, then run main.
 *
 * Sheet layout (row 1 is the header and is left in place once it has values):
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
 *   L reference list of inactive customer aliases (this script does not clear it)
 *
 * SETUP
 * 1. Put inactive customer aliases in column L. The formula searches all of
 *    column L, so a header in L1 must not equal a real alias.
 * 2. Extensions > Apps Script. Select all of Code.gs and paste this file.
 *    Save. The editor names the file Code.gs; that is fine.
 * 3. Edit CONFIG below: API_BASE_URL, JQL, sheet name, and the real custom
 *    field ids. Put the credential in Project Settings > Script Properties
 *    (these override CONFIG):
 *        API_TOKEN               Jira API token, or the basic-auth password
 *        API_EMAIL               account email used with basic auth
 *        BEARER_TOKEN            used only when AUTH.TYPE is "bearer"
 *        ON_HOLD_TRANSITION_ID   used when TRANSITION.MODE is "id"
 * 4. Run logTransitionsForIssue from the editor with a key that is not already
 *    On Hold, for example logTransitionsForIssue("PROJ-123"). Copy the id whose
 *    destination is "On Hold". If one id does not work from every status, set
 *    TRANSITION.MODE to "name".
 * 5. Run main once and approve the spreadsheet, external request, and trigger
 *    permissions. Apps Script asks for those on first run. No manifest file
 *    is required.
 * 6. Reload the spreadsheet. Use the Ticket Sync menu.
 *
 * TIME-DRIVEN TRIGGER
 * Menu: Ticket Sync > Install hourly trigger.
 * Or: Triggers (alarm clock) > Add Trigger > function main > Time-driven >
 * Hour timer. The trigger uses the spreadsheet timezone (File > Settings).
 * Overlapping runs are skipped with a script lock.
 *
 * Jira Cloud
 * Search is GET /rest/api/3/search/jql with nextPageToken. Keep a project
 * restriction in the JQL. Data Center can set SEARCH.PATH to
 * /rest/api/2/search and SEARCH.PAGINATION to "startAt".
 * Transitions are POST /rest/api/3/issue/{key}/transitions.
 * Placeholders that start with YOUR_ are rejected. Do not paste a real token
 * into this file if the project is shared.
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
    throw new Error('Missing ' + label + '. Set the Script Property or replace the CONFIG placeholder. See the setup notes at the top of this file.');
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

var TicketLogic = (function () {
  var COLUMNS = {
    KEY: 0,
    SUMMARY: 1,
    CATALYST: 2,
    STATUS: 3,
    ASSIGNEE: 4,
    SEARCH_TEMPLATE: 5,
    REPORTER: 6,
    CREATED: 7,
    CUSTOMER_ALIAS: 8,
    ACTIVE_STATUS: 9
  };

  var FIELD_ORDER = [
    'key',
    'summary',
    'catalyst',
    'status',
    'assignee',
    'searchTemplate',
    'reporter',
    'created',
    'customerAlias'
  ];

  function getByPath(obj, path) {
    if (path == null || path === '') return undefined;
    var current = obj;
    var parts = String(path).split('.');
    for (var i = 0; i < parts.length; i++) {
      if (current == null || typeof current !== 'object') return undefined;
      current = current[parts[i]];
    }
    return current;
  }

  function normalizeCellValue(value) {
    if (value == null) return '';
    if (Object.prototype.toString.call(value) === '[object Date]') {
      return isNaN(value.getTime()) ? '' : value;
    }
    var kind = typeof value;
    if (kind === 'string' || kind === 'number' || kind === 'boolean') return value;
    if (Array.isArray(value)) {
      return value.map(function (item) {
        return String(normalizeCellValue(item));
      }).filter(function (item) {
        return item !== '';
      }).join(', ');
    }
    if (kind === 'object') {
      if (typeof value.displayName === 'string' && value.displayName !== '') return value.displayName;
      if (typeof value.name === 'string' && value.name !== '') return value.name;
      if (typeof value.value === 'string' || typeof value.value === 'number' || typeof value.value === 'boolean') {
        return value.value;
      }
      if (value.value != null && typeof value.value === 'object') return normalizeCellValue(value.value);
      try {
        return JSON.stringify(value);
      } catch (err) {
        return '';
      }
    }
    return String(value);
  }

  /**
   * Sheets treats a string that starts with =, +, -, or @ as a formula when it
   * is written with setValues. Store those strings as a formula that evaluates
   * back to the original text.
   */
  function sanitizeSheetText(value) {
    if (typeof value !== 'string') return value;
    if (value === '') return '';
    if (!/^[=+\-@]/.test(value)) return value;
    var lines = value.split(/\r\n|\n|\r/);
    var quoted = lines.map(function (line) {
      return '"' + line.replace(/"/g, '""') + '"';
    });
    return '=' + quoted.join('&CHAR(10)&');
  }

  function coerceIsoDate(value) {
    if (typeof value !== 'string') return value;
    var match = value.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?)(Z|[+-]\d{2}:?\d{2})$/);
    if (!match) return value;
    var zone = match[2];
    if (/^[+-]\d{4}$/.test(zone)) zone = zone.slice(0, 3) + ':' + zone.slice(3);
    var parsed = new Date(match[1] + zone);
    if (isNaN(parsed.getTime())) return value;
    return parsed;
  }

  function mapIssueToRow(issue, fieldPaths) {
    var paths = fieldPaths || {};
    var row = FIELD_ORDER.map(function (name) {
      return sanitizeSheetText(normalizeCellValue(getByPath(issue, paths[name])));
    });
    row[COLUMNS.CREATED] = coerceIsoDate(row[COLUMNS.CREATED]);
    if (row.length !== 9) throw new Error('Ticket rows must contain columns A through I.');
    return row;
  }

  function buildActiveStatusFormula(rowNumber) {
    if (typeof rowNumber !== 'number' || !isFinite(rowNumber) || Math.floor(rowNumber) !== rowNumber || rowNumber < 2) {
      throw new Error('Active Status formula row must be an integer >= 2. Got: ' + rowNumber);
    }
    return '=IF(I' + rowNumber + ' = "", "", IF(ISNUMBER(MATCH(I' + rowNumber + ', L:L, 0)), "InActive", "Active"))';
  }

  function buildActiveStatusFormulas(startRow, rowCount) {
    var start = Number(startRow);
    var count = Number(rowCount);
    if (!isFinite(count) || count < 0 || Math.floor(count) !== count) {
      throw new Error('Formula row count must be a non-negative integer.');
    }
    var formulas = [];
    for (var i = 0; i < count; i++) formulas.push([buildActiveStatusFormula(start + i)]);
    return formulas;
  }

  function normalizeStatusToken(value) {
    return String(value == null ? '' : value).trim().toLowerCase();
  }

  function shouldTransition(activeStatus, currentStatus, options) {
    var settings = options || {};
    var inactive = normalizeStatusToken(settings.inactiveValue || 'InActive');
    if (normalizeStatusToken(activeStatus) !== inactive) return false;
    var targets = settings.alreadyTargetStatuses || [];
    var status = normalizeStatusToken(currentStatus);
    for (var i = 0; i < targets.length; i++) {
      if (status === normalizeStatusToken(targets[i]) && status !== '') return false;
    }
    return true;
  }

  function isSafeIssueKey(key) {
    return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(String(key == null ? '' : key).trim());
  }

  function collectTransitionCandidates(values, options) {
    var settings = options || {};
    var startRow = settings.dataStartRow || 2;
    var candidates = [];
    var skippedKeys = [];
    var inactiveAlreadyOnHold = 0;
    var blankActive = 0;
    var rows = values || [];

    for (var i = 0; i < rows.length; i++) {
      var row = rows[i] || [];
      var rawKey = row[COLUMNS.KEY];
      if (rawKey == null || String(rawKey).trim() === '') continue;
      var key = String(rawKey).trim();
      if (!isSafeIssueKey(key)) {
        skippedKeys.push(key);
        continue;
      }
      var active = row[COLUMNS.ACTIVE_STATUS];
      var status = row[COLUMNS.STATUS];
      if (active == null || String(active).trim() === '') blankActive++;
      if (shouldTransition(active, status, settings)) {
        candidates.push({
          sheetRow: startRow + i,
          valueIndex: i,
          key: key,
          status: status == null ? '' : String(status)
        });
      } else if (normalizeStatusToken(active) === normalizeStatusToken(settings.inactiveValue || 'InActive')) {
        inactiveAlreadyOnHold++;
      }
    }

    return {
      candidates: candidates,
      skippedKeys: skippedKeys,
      inactiveAlreadyOnHold: inactiveAlreadyOnHold,
      blankActive: blankActive
    };
  }

  function applySuccessfulStatuses(values, succeeded, targetStatus) {
    var next = (values || []).map(function (row) { return row.slice(); });
    (succeeded || []).forEach(function (item) {
      if (!item || item.valueIndex == null) return;
      if (item.valueIndex < 0 || item.valueIndex >= next.length) {
        throw new Error('Status update row is outside the sheet read: ' + item.valueIndex);
      }
      next[item.valueIndex][COLUMNS.STATUS] = targetStatus;
    });
    return next.map(function (row) { return [row[COLUMNS.STATUS]]; });
  }

  function dedupeIssues(issues) {
    var seen = {};
    var out = [];
    (issues || []).forEach(function (issue) {
      var raw = issue && (issue.key != null ? issue.key : issue.id);
      var token = raw == null ? '' : String(raw);
      if (token !== '') {
        if (seen[token]) return;
        seen[token] = true;
      }
      out.push(issue);
    });
    return out;
  }

  function extractIssues(payload, issuesPath) {
    if (payload == null) return [];
    if (issuesPath == null || issuesPath === '') {
      if (Array.isArray(payload)) return payload;
      throw new Error('Search response is not an array. Set SEARCH.ISSUES_PATH.');
    }
    var value = getByPath(payload, issuesPath);
    if (value == null) return [];
    if (!Array.isArray(value)) {
      throw new Error('SEARCH.ISSUES_PATH did not resolve to an array: ' + issuesPath);
    }
    return value;
  }

  function getNextPage(payload, pagination, state) {
    var mode = pagination || 'none';
    var current = state || {};
    if (mode === 'none') return null;
    if (mode === 'nextPageToken') {
      if (!payload || payload.isLast === true) return null;
      var token = payload.nextPageToken;
      if (token == null || String(token).trim() === '') return null;
      if (token === current.pageToken) return null;
      return { pageToken: token, startAt: current.startAt || 0 };
    }
    if (mode === 'startAt') {
      var pageSize = current.pageSize || 0;
      if (pageSize <= 0) return null;
      var startAt = current.startAt || 0;
      var nextStart = startAt + pageSize;
      if (payload && typeof payload.total === 'number') {
        return nextStart < payload.total ? { pageToken: null, startAt: nextStart } : null;
      }
      var maxResults = current.maxResults || pageSize;
      if (pageSize < maxResults) return null;
      return { pageToken: null, startAt: nextStart };
    }
    throw new Error('Unknown pagination mode: ' + mode);
  }

  function fieldsFromMapping(fieldPaths) {
    var fields = [];
    var paths = fieldPaths || {};
    Object.keys(paths).forEach(function (name) {
      var path = paths[name];
      if (!path || path === 'key' || path === 'id') return;
      if (String(path).indexOf('fields.') !== 0) return;
      var fieldName = String(path).slice('fields.'.length).split('.')[0];
      if (fieldName && fields.indexOf(fieldName) === -1) fields.push(fieldName);
    });
    return fields;
  }

  function copyParams(params) {
    var copy = {};
    Object.keys(params || {}).forEach(function (key) {
      var value = params[key];
      copy[key] = Array.isArray(value) ? value.slice() : value;
    });
    return copy;
  }

  function assertApiBaseUrl(url) {
    var text = String(url || '').trim().replace(/\/+$/, '');
    var match = text.match(/^https:\/\/([^/?#]+)$/i) || text.match(/^https:\/\/([^/?#]+)(\/.*)?$/i);
    if (!match) throw new Error('API_BASE_URL must be an https URL.');
    if (match[1].indexOf('@') !== -1) throw new Error('API_BASE_URL must not contain credentials.');
    return text;
  }

  function assertApiPath(path, label) {
    var text = String(path || '');
    // Curly braces are allowed so transition templates can contain {key}.
    if (!/^\/[A-Za-z0-9._~:/?#\[\]@!$&'()*+,;={}-]*$/.test(text) || text.indexOf('//') === 0) {
      throw new Error(label + ' must be a path starting with /, not a full URL.');
    }
    return text;
  }

  function serializeQuery(params) {
    var parts = [];
    Object.keys(params || {}).forEach(function (key) {
      var value = params[key];
      if (value == null) return;
      var encodedKey = encodeURIComponent(key);
      if (Array.isArray(value)) {
        parts.push(encodedKey + '=' + encodeURIComponent(value.map(function (item) {
          return String(item);
        }).join(',')));
      } else {
        parts.push(encodedKey + '=' + encodeURIComponent(String(value)));
      }
    });
    return parts.join('&');
  }

  function buildSearchRequest(config, page) {
    var search = (config && config.SEARCH) || {};
    var base = assertApiBaseUrl(config && config.API_BASE_URL);
    var path = assertApiPath(search.PATH, 'SEARCH.PATH');
    var params = copyParams(search.PARAMS);
    if (params.fields == null || params.fields === '' || params.fields === 'auto') {
      params.fields = fieldsFromMapping(config.FIELDS);
    }
    var pageState = page || {};
    var pagination = search.PAGINATION || 'none';
    delete params.nextPageToken;
    if (pagination === 'nextPageToken') {
      if (pageState.pageToken) params.nextPageToken = pageState.pageToken;
    } else if (pagination === 'startAt') {
      params.startAt = pageState.startAt || 0;
    } else if (pagination !== 'none') {
      throw new Error('Unknown pagination mode: ' + pagination);
    }

    var method = String(search.METHOD || 'GET').toUpperCase();
    var pageSize = Number(params.maxResults) || null;
    if (method === 'POST' && typeof params.fields === 'string') params.fields = [params.fields];
    if (method === 'GET') {
      var query = serializeQuery(params);
      return {
        url: base + path + (query ? '?' + query : ''),
        method: 'get',
        payload: null,
        contentType: null,
        pageSize: pageSize
      };
    }
    if (method === 'POST') {
      return {
        url: base + path,
        method: 'post',
        payload: JSON.stringify(params),
        contentType: 'application/json',
        pageSize: pageSize
      };
    }
    throw new Error('SEARCH.METHOD must be GET or POST.');
  }

  function fillTemplate(template, values, encoder) {
    var body = String(template);
    Object.keys(values || {}).forEach(function (key) {
      if (values[key] == null) return;
      body = body.split('{' + key + '}').join(encoder(String(values[key])));
    });
    return body;
  }

  function jsonEscape(value) {
    return JSON.stringify(value).slice(1, -1);
  }

  function buildTransitionUrl(config, issueKey) {
    if (!isSafeIssueKey(issueKey)) throw new Error('Refusing to call the transition API for key: ' + issueKey);
    var transition = (config && config.TRANSITION) || {};
    var template = String(transition.PATH_TEMPLATE || '');
    if (template.indexOf('{key}') === -1) throw new Error('TRANSITION.PATH_TEMPLATE must contain {key}.');
    var base = assertApiBaseUrl(config && config.API_BASE_URL);
    var path = fillTemplate(assertApiPath(template, 'TRANSITION.PATH_TEMPLATE'), {
      key: String(issueKey).trim()
    }, encodeURIComponent);
    return base + path;
  }

  function buildTransitionListUrl(config, issueKey) {
    var transition = (config && config.TRANSITION) || {};
    var listConfig = {
      API_BASE_URL: config && config.API_BASE_URL,
      TRANSITION: {
        PATH_TEMPLATE: transition.LIST_PATH_TEMPLATE || transition.PATH_TEMPLATE
      }
    };
    return buildTransitionUrl(listConfig, issueKey);
  }

  function buildTransitionPayload(template, values, extraBody) {
    var body = fillTemplate(template, values, jsonEscape);
    var parsed;
    try {
      parsed = JSON.parse(body);
    } catch (err) {
      throw new Error('TRANSITION.BODY_TEMPLATE is not valid JSON after substitution.');
    }
    if (extraBody && typeof extraBody === 'object') {
      Object.keys(extraBody).forEach(function (key) {
        parsed[key] = extraBody[key];
      });
    }
    return JSON.stringify(parsed);
  }

  function transitionChoices(payload) {
    var list = Array.isArray(payload) ? payload : (payload && payload.transitions);
    if (!Array.isArray(list)) return [];
    return list.map(function (item) {
      return {
        id: item && item.id != null ? String(item.id) : '',
        name: item && item.name ? String(item.name) : '',
        to: item && item.to && item.to.name ? String(item.to.name) : ''
      };
    });
  }

  function findTransitionId(payload, targetName) {
    var target = normalizeStatusToken(targetName);
    if (!target) return null;
    var choices = transitionChoices(payload);
    var byName = null;
    for (var i = 0; i < choices.length; i++) {
      var choice = choices[i];
      if (!choice.id) continue;
      if (normalizeStatusToken(choice.to) === target) return choice.id;
      if (byName == null && normalizeStatusToken(choice.name) === target) byName = choice.id;
    }
    return byName;
  }

  function chunk(items, size) {
    var n = Number(size);
    if (!isFinite(n) || n < 1 || Math.floor(n) !== n) {
      throw new Error('Chunk size must be a positive integer.');
    }
    var out = [];
    var source = items || [];
    for (var i = 0; i < source.length; i += n) out.push(source.slice(i, i + n));
    return out;
  }

  function isSuccessStatus(code) {
    return code >= 200 && code < 300;
  }

  function isRetryableStatus(code) {
    return code === 429 || code >= 500;
  }

  function tailClearStart(dataStartRow, writtenCount) {
    return Number(dataStartRow) + Number(writtenCount);
  }

  return {
    COLUMNS: COLUMNS,
    FIELD_ORDER: FIELD_ORDER,
    getByPath: getByPath,
    normalizeCellValue: normalizeCellValue,
    sanitizeSheetText: sanitizeSheetText,
    coerceIsoDate: coerceIsoDate,
    mapIssueToRow: mapIssueToRow,
    buildActiveStatusFormula: buildActiveStatusFormula,
    buildActiveStatusFormulas: buildActiveStatusFormulas,
    shouldTransition: shouldTransition,
    isSafeIssueKey: isSafeIssueKey,
    collectTransitionCandidates: collectTransitionCandidates,
    applySuccessfulStatuses: applySuccessfulStatuses,
    dedupeIssues: dedupeIssues,
    extractIssues: extractIssues,
    getNextPage: getNextPage,
    fieldsFromMapping: fieldsFromMapping,
    buildSearchRequest: buildSearchRequest,
    buildTransitionUrl: buildTransitionUrl,
    buildTransitionListUrl: buildTransitionListUrl,
    buildTransitionPayload: buildTransitionPayload,
    transitionChoices: transitionChoices,
    findTransitionId: findTransitionId,
    chunk: chunk,
    isSuccessStatus: isSuccessStatus,
    isRetryableStatus: isRetryableStatus,
    tailClearStart: tailClearStart
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = TicketLogic;
}
