/**
 * Same opening as fetchJiraDataFromB27Query: read the JQL in
 * KTLO_Daily_Data!B27, load those Jira issues onto Overall-Analysis, then
 * transition each issue to On Hold.
 *
 * Paste this into the existing Apps Script project as a new script file
 * (the editor saves it as .gs). Do not add a manifest. Function names here
 * do not overlap the KTLO distribution script.
 *
 * Auth is the same Script Property: Jira_API_TOKEN_SK.
 * The On Hold transition id is read from each issue, because that id depends
 * on the workflow and the current status. Run logOnHoldTransitionId to print
 * the id available on FS-187174.
 *
 * Add these lines to the existing onOpen menu, or run installOnHoldMenu once:
 *   .addItem('Fetch B27 tickets and move to On Hold', 'fetchJiraDataAndMoveToOnHold')
 *   .addItem('Move loaded tickets to On Hold', 'moveLoadedTicketsToOnHold')
 */
var ON_HOLD_SHEET_KTLO = "KTLO_Daily_Data";
var ON_HOLD_SHEET_ANALYSIS = "Overall-Analysis";
var ON_HOLD_JIRA_DOMAIN = "arcadiapower.atlassian.net";
var ON_HOLD_JIRA_EMAIL = "sowmiya.kirubakaran@arcadia.com";
var ON_HOLD_PAGE_SIZE = 100;
var ON_HOLD_MAX_PAGES = 500;
var ON_HOLD_STATUS = "On Hold";
var ON_HOLD_SAMPLE_KEY = "FS-187174";
var ON_HOLD_BATCH_SIZE = 10;

var ON_HOLD_FIELDS = [
  "key", "reporter", "status", "created", "duedate",
  "customfield_11168", "customfield_15610", "customfield_11271", "customfield_11183",
  "customfield_11772", "customfield_11178", "customfield_11171", "assignee",
  "customfield_12282", "customfield_12284", "labels",
  "customfield_19783", "customfield_19818", "customfield_19782", "customfield_19817"
];

function installOnHoldMenu() {
  var ss = SpreadsheetApp.getActive();
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === "onOpenOnHoldMenu") ScriptApp.deleteTrigger(trigger);
  });
  ScriptApp.newTrigger("onOpenOnHoldMenu").forSpreadsheet(ss).onOpen().create();
  onOpenOnHoldMenu();
  onHoldAlert_("KTLO On Hold", "The KTLO On Hold menu is installed. It appears when this spreadsheet opens.");
}

function onOpenOnHoldMenu() {
  SpreadsheetApp.getUi()
    .createMenu("KTLO On Hold")
    .addItem("Fetch B27 tickets and move to On Hold", "fetchJiraDataAndMoveToOnHold")
    .addItem("Move loaded tickets to On Hold", "moveLoadedTicketsToOnHold")
    .addSeparator()
    .addItem("Show On Hold transition id for FS-187174", "logOnHoldTransitionId")
    .addToUi();
}

/**
 * Fetch the B27 JQL, replace Overall-Analysis rows the same way as
 * fetchJiraDataFromB27Query, then transition those issues to On Hold.
 */
function fetchJiraDataAndMoveToOnHold() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var ktloSheet = ss.getSheetByName(ON_HOLD_SHEET_KTLO);
  var targetSheet = ss.getSheetByName(ON_HOLD_SHEET_ANALYSIS);
  if (!ktloSheet) { onHoldAlert_("Missing sheet", "Sheet '" + ON_HOLD_SHEET_KTLO + "' was not found."); return; }
  if (!targetSheet) { onHoldAlert_("Missing sheet", "Sheet '" + ON_HOLD_SHEET_ANALYSIS + "' was not found."); return; }

  var jqlCell = ktloSheet.getRange("B27");
  var jqlQuery = jqlCell.getDisplayValue().toString().trim();
  if (!jqlQuery) jqlQuery = jqlCell.getValue().toString().trim();
  if (!jqlQuery) { onHoldAlert_("Empty JQL", "Cell B27 of '" + ON_HOLD_SHEET_KTLO + "' is empty."); return; }

  var headers = onHoldAuthHeaders_();
  if (!headers) { onHoldAlert_("Missing token", "'Jira_API_TOKEN_SK' was not found in Script Properties."); return; }

  if (!onHoldConfirm_("This clears " + ON_HOLD_SHEET_ANALYSIS + " rows 2:1000, reloads the B27 JQL, and transitions those issues to " + ON_HOLD_STATUS + ". Continue?")) return;

  var searchResult;
  try { searchResult = onHoldFetchIssues_(jqlQuery, ON_HOLD_FIELDS, headers); }
  catch (err) { onHoldAlert_("Jira search failed", err.message); return; }

  var issues = searchResult.issues;
  var clearRows = Math.max(999, issues.length);
  targetSheet.getRange(2, 1, clearRows, targetSheet.getMaxColumns()).clearContent();
  if (!issues.length) {
    onHoldAlert_("No issues", "B27 JQL returned no issues. Rows 2:1000 were cleared.\n\n" + jqlQuery.substring(0, 500));
    return;
  }

  targetSheet.getRange(2, 1, issues.length, 20).setValues(issues.map(onHoldIssueToRow_));
  SpreadsheetApp.flush();
  var result = onHoldMoveIssues_(issues, headers);
  onHoldWriteStatusColumn_(targetSheet, issues, result.transitioned);
  SpreadsheetApp.flush();
  onHoldReport_(ss, searchResult.truncated, issues.length, result);
}

/** Transition issues already listed in Overall-Analysis column A. Does not clear the sheet. */
function moveLoadedTicketsToOnHold() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(ON_HOLD_SHEET_ANALYSIS);
  if (!sheet) { onHoldAlert_("Missing sheet", "Sheet '" + ON_HOLD_SHEET_ANALYSIS + "' was not found."); return; }
  var headers = onHoldAuthHeaders_();
  if (!headers) { onHoldAlert_("Missing token", "'Jira_API_TOKEN_SK' was not found in Script Properties."); return; }

  var loaded = onHoldReadLoadedTickets_(sheet);
  if (!loaded.keys.length) { onHoldAlert_("No tickets", "No Jira keys were found in column A."); return; }
  if (!onHoldConfirm_("Transition " + loaded.keys.length + " loaded tickets that are not already " + ON_HOLD_STATUS + "? Column C is updated after each success.")) return;

  var issues = [];
  try {
    for (var i = 0; i < loaded.keys.length; i += 50) {
      var batch = loaded.keys.slice(i, i + 50);
      onHoldFetchIssues_("key in (" + batch.join(",") + ")", ["key", "status"], headers).issues.forEach(function (issue) {
        issues.push(issue);
      });
    }
  } catch (err) { onHoldAlert_("Jira search failed", err.message); return; }

  var result = onHoldMoveIssues_(issues, headers);
  onHoldWriteLoadedStatus_(sheet, loaded.rowByKey, result.transitioned);
  SpreadsheetApp.flush();
  onHoldReport_(ss, false, issues.length, result);
}

/** Log every transition on FS-187174 and highlight the On Hold id. */
function logOnHoldTransitionId() {
  var headers = onHoldAuthHeaders_();
  if (!headers) { onHoldAlert_("Missing token", "'Jira_API_TOKEN_SK' was not found in Script Properties."); return; }
  var response;
  try {
    response = UrlFetchApp.fetch(onHoldTransitionUrl_(ON_HOLD_SAMPLE_KEY), {
      method: "get",
      headers: headers,
      muteHttpExceptions: true
    });
  } catch (err) { onHoldAlert_("Transition lookup failed", String(err)); return; }
  var code = response.getResponseCode();
  var text = response.getContentText() || "";
  if (code < 200 || code >= 300) {
    onHoldAlert_("Transition lookup failed", ON_HOLD_SAMPLE_KEY + " HTTP " + code + " " + text.substring(0, 500));
    return;
  }
  var payload;
  try { payload = JSON.parse(text); }
  catch (err) { onHoldAlert_("Transition lookup failed", "Invalid JSON: " + text.substring(0, 300)); return; }
  var lines = onHoldDescribeTransitions_(payload);
  var onHoldId = onHoldFindTransitionId_(payload);
  lines.forEach(function (line) { Logger.log(line); });
  var summary = lines.join("\n");
  if (onHoldId) summary = "ON_HOLD_TRANSITION_ID for " + ON_HOLD_SAMPLE_KEY + " from its current status: " + onHoldId + "\n\n" + summary;
  else summary = "No " + ON_HOLD_STATUS + " transition is available from the current status of " + ON_HOLD_SAMPLE_KEY + ".\n\n" + summary;
  onHoldAlert_(ON_HOLD_SAMPLE_KEY, summary);
}

function onHoldMoveIssues_(issues, headers) {
  var pending = [];
  var already = 0;
  (issues || []).forEach(function (issue) {
    var key = onHoldIssueKey_(issue && issue.key);
    if (!key) return;
    var status = onHoldIssueStatus_(issue);
    if (onHoldIsTargetStatus_(status)) { already++; return; }
    pending.push({ key: key, status: status });
  });

  var ready = [];
  var failures = [];
  onHoldChunk_(pending, ON_HOLD_BATCH_SIZE).forEach(function (batch) {
    var requests = batch.map(function (item) {
      return { url: onHoldTransitionUrl_(item.key), method: "get", headers: headers, muteHttpExceptions: true };
    });
    onHoldFetchAll_(requests).forEach(function (response, index) {
      var item = batch[index];
      var parsed = onHoldReadTransitionList_(item, response);
      if (!parsed.ok) { failures.push(parsed.error); return; }
      if (!parsed.id) {
        var missing = item.key + ": no \"" + ON_HOLD_STATUS + "\" transition from status \"" + item.status + "\".";
        Logger.log("Failed transition for " + missing);
        failures.push(missing);
        return;
      }
      ready.push({ key: item.key, transitionId: parsed.id });
    });
  });

  var transitioned = [];
  onHoldChunk_(ready, ON_HOLD_BATCH_SIZE).forEach(function (batch) {
    var requests = batch.map(function (item) {
      return {
        url: onHoldTransitionUrl_(item.key),
        method: "post",
        headers: headers,
        contentType: "application/json",
        payload: JSON.stringify({ transition: { id: item.transitionId } }),
        muteHttpExceptions: true
      };
    });
    onHoldFetchAll_(requests).forEach(function (response, index) {
      onHoldRecordTransition_(batch[index], response, false, headers, transitioned, failures);
    });
  });
  return { transitioned: transitioned, already: already, failures: failures, pending: pending.length };
}

function onHoldReadTransitionList_(item, response) {
  var code = onHoldResponseCode_(response);
  if (!code) {
    var transport = item.key + ": " + (response && response.error ? response.error : "no response");
    Logger.log("Failed to list transitions for " + transport);
    return { ok: false, error: transport };
  }
  var text = response.getContentText() || "";
  if (code < 200 || code >= 300) {
    var httpError = item.key + " (HTTP " + code + "): " + text.substring(0, 180);
    Logger.log("Failed to list transitions for " + httpError);
    return { ok: false, error: httpError };
  }
  try { return { ok: true, id: onHoldFindTransitionId_(JSON.parse(text)) }; }
  catch (err) {
    var parseError = item.key + ": invalid transition JSON";
    Logger.log("Failed to parse transitions for " + item.key + ": " + err);
    return { ok: false, error: parseError };
  }
}

function onHoldRecordTransition_(item, response, isRetry, headers, transitioned, failures) {
  var code = onHoldResponseCode_(response);
  if (!code) {
    if (!isRetry) return onHoldRetryTransition_(item, headers, transitioned, failures);
    var transport = item.key + ": " + (response && response.error ? response.error : "no response");
    Logger.log("Failed transition for " + transport);
    failures.push(transport);
    return false;
  }
  if (code >= 200 && code < 300) {
    Logger.log("Transitioned " + item.key + " to \"" + ON_HOLD_STATUS + "\" with transition id " + item.transitionId + " (HTTP " + code + (isRetry ? ", retry" : "") + ").");
    transitioned.push(item.key);
    return true;
  }
  if (!isRetry && (code === 429 || code >= 500)) return onHoldRetryTransition_(item, headers, transitioned, failures);
  var message = item.key + " (HTTP " + code + "): " + (response.getContentText() || "").substring(0, 180);
  Logger.log("Failed transition for " + message);
  failures.push(message);
  return false;
}

function onHoldRetryTransition_(item, headers, transitioned, failures) {
  Utilities.sleep(1000);
  var response;
  try {
    response = UrlFetchApp.fetch(onHoldTransitionUrl_(item.key), {
      method: "post",
      headers: headers,
      contentType: "application/json",
      payload: JSON.stringify({ transition: { id: item.transitionId } }),
      muteHttpExceptions: true
    });
  } catch (err) { response = { error: err }; }
  return onHoldRecordTransition_(item, response, true, headers, transitioned, failures);
}

function onHoldFetchIssues_(jqlQuery, requestedFields, headers) {
  var searchUrl = "https://" + ON_HOLD_JIRA_DOMAIN + "/rest/api/3/search/jql";
  var issues = [];
  var seenKeys = {};
  var nextPageToken = "";
  for (var page = 0; page < ON_HOLD_MAX_PAGES; page++) {
    var payload = { jql: jqlQuery, maxResults: ON_HOLD_PAGE_SIZE, fields: requestedFields };
    if (nextPageToken) payload.nextPageToken = nextPageToken;
    var response = UrlFetchApp.fetch(searchUrl, {
      method: "post",
      headers: headers,
      contentType: "application/json",
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
    var code = response.getResponseCode();
    var body = response.getContentText();
    if (code !== 200) throw new Error("Jira search failed (" + code + "): " + body.substring(0, 500));
    var data;
    try { data = JSON.parse(body); }
    catch (err) { throw new Error("Jira search returned invalid JSON: " + body.substring(0, 500)); }
    (data.issues || []).forEach(function (issue) {
      var key = issue && issue.key;
      if (!key || seenKeys[key]) return;
      seenKeys[key] = true;
      issues.push(issue);
    });
    if (data.isLast || !data.nextPageToken) return { issues: issues, truncated: false };
    if (data.nextPageToken === nextPageToken) throw new Error("Jira search repeated the same page token. Stopped to avoid a loop.");
    nextPageToken = data.nextPageToken;
  }
  return { issues: issues, truncated: true };
}

function onHoldIssueToRow_(issue) {
  var key = issue.key;
  var fields = issue.fields || {};
  return [
    "=HYPERLINK(\"https://" + ON_HOLD_JIRA_DOMAIN + "/browse/" + key + "\", \"" + key + "\")",
    onHoldExtractFieldValue_(fields.reporter),
    onHoldExtractFieldValue_(fields.status),
    fields.created ? fields.created.substring(0, 10) : "",
    fields.duedate || "",
    onHoldExtractFieldValue_(fields.customfield_11168),
    onHoldExtractFieldValue_(fields.customfield_15610),
    onHoldExtractFieldValue_(fields.customfield_11271),
    onHoldExtractFieldValue_(fields.customfield_11183),
    onHoldExtractFieldValue_(fields.customfield_11772),
    onHoldExtractFieldValue_(fields.customfield_11178),
    onHoldExtractFieldValue_(fields.customfield_11171),
    onHoldExtractFieldValue_(fields.assignee),
    onHoldExtractFieldValue_(fields.customfield_12282),
    onHoldExtractFieldValue_(fields.customfield_12284),
    onHoldExtractFieldValue_(fields.labels),
    onHoldExtractFieldValue_(fields.customfield_19783),
    onHoldExtractFieldValue_(fields.customfield_19818),
    onHoldExtractFieldValue_(fields.customfield_19782),
    onHoldExtractFieldValue_(fields.customfield_19817)
  ];
}

function onHoldWriteStatusColumn_(sheet, issues, transitioned) {
  var moved = {};
  (transitioned || []).forEach(function (key) { moved[key] = true; });
  var column = issues.map(function (issue) {
    var key = onHoldIssueKey_(issue && issue.key);
    return [moved[key] ? ON_HOLD_STATUS : onHoldIssueStatus_(issue)];
  });
  if (column.length) sheet.getRange(2, 3, column.length, 1).setValues(column);
}

function onHoldReadLoadedTickets_(sheet) {
  var lastRow = Math.max(sheet.getLastRow(), 2);
  var height = lastRow - 1;
  var range = sheet.getRange(2, 1, height, 1);
  var displays = range.getDisplayValues();
  var formulas = range.getFormulas();
  var statuses = sheet.getRange(2, 3, height, 1).getDisplayValues();
  var keys = [];
  var rowByKey = {};
  var seen = {};
  for (var i = 0; i < height; i++) {
    var key = onHoldIssueKey_(displays[i][0]) || onHoldIssueKey_(formulas[i][0]);
    if (!key || seen[key]) continue;
    if (onHoldIsTargetStatus_(statuses[i][0])) continue;
    seen[key] = true;
    keys.push(key);
    rowByKey[key] = i + 2;
  }
  return { keys: keys, rowByKey: rowByKey };
}

function onHoldWriteLoadedStatus_(sheet, rowByKey, transitioned) {
  var keys = Object.keys(rowByKey || {});
  if (!keys.length || !(transitioned || []).length) return;
  var moved = {};
  transitioned.forEach(function (key) { moved[key] = true; });
  var minRow = keys.reduce(function (min, key) { return Math.min(min, rowByKey[key]); }, rowByKey[keys[0]]);
  var maxRow = keys.reduce(function (max, key) { return Math.max(max, rowByKey[key]); }, rowByKey[keys[0]]);
  var column = sheet.getRange(minRow, 3, maxRow - minRow + 1, 1).getValues();
  keys.forEach(function (key) {
    if (moved[key]) column[rowByKey[key] - minRow][0] = ON_HOLD_STATUS;
  });
  sheet.getRange(minRow, 3, column.length, 1).setValues(column);
}

function onHoldAuthHeaders_() {
  var apiToken = PropertiesService.getScriptProperties().getProperty("Jira_API_TOKEN_SK");
  if (!apiToken) return null;
  return {
    "Authorization": "Basic " + Utilities.base64Encode(ON_HOLD_JIRA_EMAIL + ":" + apiToken),
    "Accept": "application/json",
    "Content-Type": "application/json"
  };
}

function onHoldTransitionUrl_(issueKey) {
  return "https://" + ON_HOLD_JIRA_DOMAIN + "/rest/api/3/issue/" + encodeURIComponent(issueKey) + "/transitions";
}

function onHoldExtractFieldValue_(val) {
  if (val === undefined || val === null) return "";
  if (Array.isArray(val)) return val.map(onHoldExtractFieldValue_).filter(String).join(", ");
  if (typeof val === "object") {
    if (val.type === "doc" && Array.isArray(val.content)) {
      var textParts = [];
      function walk(node) {
        if (!node) return;
        if (node.type === "text" && node.text) textParts.push(node.text);
        if (Array.isArray(node.content)) node.content.forEach(walk);
      }
      val.content.forEach(walk);
      return textParts.join(" ").trim();
    }
    return val.displayName || val.value || val.name || JSON.stringify(val);
  }
  if (typeof val === "string" && val.trim().indexOf("{\"type\":\"doc\"") === 0) {
    try { return onHoldExtractFieldValue_(JSON.parse(val)); } catch (err) { return val; }
  }
  return val;
}

function onHoldIssueStatus_(issue) {
  var fields = issue && issue.fields;
  return String(onHoldExtractFieldValue_(fields && fields.status) || "").trim();
}

function onHoldIsTargetStatus_(status) {
  return String(status || "").trim().toLowerCase() === ON_HOLD_STATUS.toLowerCase();
}

function onHoldFindTransitionId_(payload) {
  var transitions = payload && payload.transitions;
  if (!Array.isArray(transitions)) return "";
  var target = ON_HOLD_STATUS.toLowerCase();
  var byName = "";
  for (var i = 0; i < transitions.length; i++) {
    var item = transitions[i];
    if (!item || item.id === undefined || item.id === null || item.id === "") continue;
    var toName = item.to && item.to.name ? String(item.to.name).trim().toLowerCase() : "";
    var name = item.name ? String(item.name).trim().toLowerCase() : "";
    if (toName === target) return String(item.id);
    if (!byName && name === target) byName = String(item.id);
  }
  return byName;
}

function onHoldDescribeTransitions_(payload) {
  var transitions = payload && payload.transitions;
  if (!Array.isArray(transitions) || !transitions.length) return ["No transitions are available from the current status."];
  return transitions.map(function (item) {
    var toName = item && item.to && item.to.name ? item.to.name : "";
    return "id=" + (item && item.id !== undefined ? item.id : "") + " name=\"" + (item && item.name ? item.name : "") + "\" to=\"" + toName + "\"";
  });
}

function onHoldIssueKey_(raw) {
  var text = String(raw === undefined || raw === null ? "" : raw).trim().replace(/[\u2010-\u2015\u2212]/g, "-");
  var match = text.match(/[A-Z][A-Z0-9_]+-\d+/i);
  return match ? match[0].toUpperCase() : "";
}

function onHoldChunk_(items, size) {
  var out = [];
  var source = items || [];
  for (var i = 0; i < source.length; i += size) out.push(source.slice(i, i + size));
  return out;
}

function onHoldFetchAll_(requests) {
  try { return UrlFetchApp.fetchAll(requests); }
  catch (err) {
    Logger.log("Batch HTTP request failed (" + err + "). Retrying one by one.");
    return requests.map(function (request) {
      var options = {};
      Object.keys(request).forEach(function (key) { if (key !== "url") options[key] = request[key]; });
      try { return UrlFetchApp.fetch(request.url, options); }
      catch (singleErr) { return { error: singleErr }; }
    });
  }
}

function onHoldResponseCode_(response) {
  return response && typeof response.getResponseCode === "function" ? response.getResponseCode() : 0;
}

function onHoldReport_(ss, truncated, loadedCount, result) {
  var moved = result.transitioned.length;
  var message = "Moved " + moved + " issues to " + ON_HOLD_STATUS + ".";
  if (result.already) message += " " + result.already + " were already " + ON_HOLD_STATUS + ".";
  if (result.failures.length) message += " " + result.failures.length + " failed.\n\n" + result.failures.slice(0, 5).join("\n");
  if (truncated) message += "\n\nLoaded the first " + loadedCount + " issues. The JQL has more pages than this run keeps.";
  result.transitioned.forEach(function (key) { Logger.log("Sheet status set to " + ON_HOLD_STATUS + " for " + key + "."); });
  if (result.failures.length || truncated) onHoldAlert_("On Hold", message);
  else ss.toast(message, "Jira", 8);
}

function onHoldConfirm_(message) {
  try {
    var ui = SpreadsheetApp.getUi();
    return ui.alert("Move to On Hold", message, ui.ButtonSet.YES_NO) === ui.Button.YES;
  } catch (err) {
    Logger.log("No spreadsheet UI. Stopped before changing Jira. " + message);
    return false;
  }
}

function onHoldAlert_(title, message) {
  try {
    var ui = SpreadsheetApp.getUi();
    if (message) ui.alert(title, message, ui.ButtonSet.OK);
    else ui.alert(title);
  } catch (err) { Logger.log(message ? title + "\n\n" + message : title); }
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    onHoldFindTransitionId_: onHoldFindTransitionId_,
    onHoldIsTargetStatus_: onHoldIsTargetStatus_,
    onHoldIssueStatus_: onHoldIssueStatus_,
    onHoldIssueKey_: onHoldIssueKey_,
    onHoldDescribeTransitions_: onHoldDescribeTransitions_,
    onHoldIssueToRow_: onHoldIssueToRow_,
    ON_HOLD_STATUS: ON_HOLD_STATUS
  };
}
