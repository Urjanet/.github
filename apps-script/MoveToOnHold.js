/**
 * Load the open ops_dev_extraction tickets for the inactive customer aliases
 * onto the Tickets sheet, then move only the rows whose column J is InActive
 * to On Hold.
 *
 * Columns written on Tickets:
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
 * Column L is the inactive customer alias list. This script does not clear it.
 *
 * Paste this into the existing Apps Script project as a new script file.
 * Do not add a manifest. Auth is Script Property Jira_API_TOKEN_SK.
 * Run logOnHoldTransitionId to see the On Hold transition id on FS-187174.
 *
 * Add these lines to the existing onOpen menu, or run installOnHoldMenu once:
 *   .addItem('Fetch inactive tickets and move to On Hold', 'fetchJiraDataAndMoveToOnHold')
 *   .addItem('Move InActive tickets to On Hold', 'moveLoadedTicketsToOnHold')
 */
var ON_HOLD_SHEET = "Tickets";
var ON_HOLD_JIRA_DOMAIN = "arcadiapower.atlassian.net";
var ON_HOLD_JIRA_EMAIL = "sowmiya.kirubakaran@arcadia.com";
var ON_HOLD_PAGE_SIZE = 100;
var ON_HOLD_MAX_PAGES = 500;
var ON_HOLD_STATUS = "On Hold";
var ON_HOLD_INACTIVE = "InActive";
var ON_HOLD_SAMPLE_KEY = "FS-187174";
var ON_HOLD_BATCH_SIZE = 10;
var ON_HOLD_COLUMN_COUNT = 10;

var ON_HOLD_HEADERS = [
  "Key",
  "Summary",
  "Catalyst (migrated)",
  "Status",
  "Assignee",
  "Search Template",
  "Reporter",
  "Created",
  "Customer Alias",
  "Active Status"
];

var ON_HOLD_CUSTOMER_ALIASES = [
  "7-Eleven, Inc",
  "Albertson's Companies, Inc.",
  "BillPay Conjoined Credentials",
  "Canadian Pacific Railway Limited",
  "Chipotle Mexican Grill, Inc.",
  "Costco Wholesale Corporation",
  "CVS Health Corporation",
  "Darden Restaurants, Inc.",
  "Extra Space Storage Inc.",
  "Paylease / Zego",
  "Public Storage",
  "Simon Property Group, Inc.",
  "Starbucks Corporation",
  "State of Texas",
  "Tesla Motors, Inc.",
  "The Cheesecake Factory Incorporated",
  "The Home Depot Inc",
  "Verizon",
  "Webster Bank",
  "Westfield, LLC"
];

function installOnHoldMenu() {
  var ss = SpreadsheetApp.getActive();
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === "onOpenOnHoldMenu") ScriptApp.deleteTrigger(trigger);
  });
  ScriptApp.newTrigger("onOpenOnHoldMenu").forSpreadsheet(ss).onOpen().create();
  onOpenOnHoldMenu();
  onHoldAlert_("On Hold", "The On Hold menu is installed. It appears when this spreadsheet opens.");
}

function onOpenOnHoldMenu() {
  SpreadsheetApp.getUi()
    .createMenu("On Hold")
    .addItem("Fetch inactive tickets and move to On Hold", "fetchJiraDataAndMoveToOnHold")
    .addItem("Move InActive tickets to On Hold", "moveLoadedTicketsToOnHold")
    .addSeparator()
    .addItem("Show On Hold transition id for FS-187174", "logOnHoldTransitionId")
    .addToUi();
}

/** Reload the customer-alias query onto Tickets, then transition column J = InActive. */
function fetchJiraDataAndMoveToOnHold() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(ON_HOLD_SHEET);
  if (!sheet) { onHoldAlert_("Missing sheet", "Sheet '" + ON_HOLD_SHEET + "' was not found."); return; }
  var headers = onHoldAuthHeaders_();
  if (!headers) { onHoldAlert_("Missing token", "'Jira_API_TOKEN_SK' was not found in Script Properties."); return; }
  if (!onHoldConfirm_("This rewrites columns A-J on '" + ON_HOLD_SHEET + "' from the customer-alias query, then moves rows whose column J is InActive to On Hold. Column K is filled only on the rows that move. Column L is not changed. Continue?")) return;

  var fieldIds;
  var searchResult;
  try {
    fieldIds = onHoldResolveFields_(headers);
    searchResult = onHoldFetchIssues_(onHoldJql_(), onHoldSearchFields_(fieldIds), headers);
  } catch (err) { onHoldAlert_("Jira search failed", err.message); return; }

  var issues = searchResult.issues;
  var clearRows = Math.max(999, issues.length);
  sheet.getRange(1, 1, 1, ON_HOLD_COLUMN_COUNT).setValues([ON_HOLD_HEADERS]);
  sheet.getRange(1, 11).setValue("Status Change");
  sheet.getRange(2, 1, clearRows, ON_HOLD_COLUMN_COUNT).clearContent();
  sheet.getRange(2, 11, clearRows, 1).clearContent();
  if (!issues.length) {
    onHoldAlert_("No issues", "The customer-alias query returned no open issues.");
    return;
  }

  sheet.getRange(2, 1, issues.length, 9).setValues(issues.map(function (issue) {
    return onHoldIssueToRow_(issue, fieldIds);
  }));
  onHoldWriteActiveStatusFormulas_(sheet, issues.length);
  SpreadsheetApp.flush();
  onHoldWaitForActiveStatus_(sheet, issues.length);

  var activeValues = sheet.getRange(2, 10, issues.length, 1).getDisplayValues();
  var inactiveIssues = [];
  issues.forEach(function (issue, index) {
    if (onHoldIsInactive_(activeValues[index][0])) inactiveIssues.push(issue);
  });
  if (!inactiveIssues.length) {
    onHoldAlert_("On Hold", "Loaded " + issues.length + " issues. Column J has no InActive rows, so nothing was moved. Put the inactive customer aliases in column L.");
    return;
  }

  var result = onHoldMoveIssues_(inactiveIssues, headers);
  result.skippedActive = issues.length - inactiveIssues.length;
  onHoldMarkTransitioned_(sheet, onHoldRowByKey_(issues), result.transitioned);
  SpreadsheetApp.flush();
  onHoldReport_(ss, searchResult.truncated, issues.length, result);
}

/** Move Tickets rows whose column J is InActive and whose column D is not already On Hold. */
function moveLoadedTicketsToOnHold() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(ON_HOLD_SHEET);
  if (!sheet) { onHoldAlert_("Missing sheet", "Sheet '" + ON_HOLD_SHEET + "' was not found."); return; }
  var headers = onHoldAuthHeaders_();
  if (!headers) { onHoldAlert_("Missing token", "'Jira_API_TOKEN_SK' was not found in Script Properties."); return; }

  SpreadsheetApp.flush();
  var loaded = onHoldReadLoadedTickets_(sheet);
  if (!loaded.keys.length) {
    onHoldAlert_("No InActive tickets", "Column J has no InActive rows to move. Active rows stay as they are. Column L is the inactive customer alias list.");
    return;
  }
  if (!onHoldConfirm_("Move " + loaded.keys.length + " InActive tickets to On Hold? Active rows are left unchanged.")) return;

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
  onHoldMarkTransitioned_(sheet, loaded.rowByKey, result.transitioned);
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

function onHoldJql_() {
  var parts = ON_HOLD_CUSTOMER_ALIASES.map(function (alias) {
    return '"Customer Alias[Paragraph]" ~ "' + String(alias).replace(/"/g, '\\"') + '"';
  });
  return "(" + parts.join(" OR ") + ') and assignee IN membersOf("ops_dev_extraction") AND status = open or key = FS-114249';
}

function onHoldSearchFields_(fieldIds) {
  return ["summary", "status", "assignee", "reporter", "created", fieldIds.catalyst, fieldIds.searchTemplate, fieldIds.customerAlias];
}

function onHoldResolveFields_(headers) {
  var response = UrlFetchApp.fetch("https://" + ON_HOLD_JIRA_DOMAIN + "/rest/api/3/field", {
    method: "get",
    headers: headers,
    muteHttpExceptions: true
  });
  var code = response.getResponseCode();
  var body = response.getContentText();
  if (code !== 200) throw new Error("Jira field lookup failed (" + code + "): " + body.substring(0, 300));
  var fields;
  try { fields = JSON.parse(body); }
  catch (err) { throw new Error("Jira field lookup returned invalid JSON: " + body.substring(0, 300)); }
  var ids = {
    catalyst: onHoldMatchField_(fields, ["Catalyst (migrated)"]),
    searchTemplate: onHoldMatchField_(fields, ["Search Template"]),
    customerAlias: onHoldMatchField_(fields, ["Customer Alias"], "textarea")
  };
  var missing = [];
  if (!ids.catalyst) missing.push("Catalyst (migrated)");
  if (!ids.searchTemplate) missing.push("Search Template");
  if (!ids.customerAlias) missing.push("Customer Alias");
  if (missing.length) throw new Error("Could not find Jira fields: " + missing.join(", ") + ".");
  return ids;
}

function onHoldMatchField_(fields, names, customHint) {
  var wanted = {};
  names.forEach(function (name) { wanted[String(name).trim().toLowerCase()] = true; });
  var matches = (fields || []).filter(function (field) {
    return field && wanted[String(field.name || "").trim().toLowerCase()];
  });
  if (customHint) {
    var hinted = matches.filter(function (field) {
      var custom = field.schema && field.schema.custom ? String(field.schema.custom) : "";
      return custom.toLowerCase().indexOf(String(customHint).toLowerCase()) !== -1;
    });
    if (hinted.length) matches = hinted;
  }
  return matches.length ? matches[0].id : "";
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
        var missing = item.key + ': no "' + ON_HOLD_STATUS + '" transition from status "' + item.status + '".';
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
    Logger.log("Failed to parse transitions for " + item.key + ": " + err);
    return { ok: false, error: item.key + ": invalid transition JSON" };
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
    Logger.log('Transitioned ' + item.key + ' to "' + ON_HOLD_STATUS + '" with transition id ' + item.transitionId + " (HTTP " + code + (isRetry ? ", retry" : "") + ").");
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

function onHoldIssueToRow_(issue, fieldIds) {
  var ids = fieldIds || {};
  var key = issue.key;
  var fields = issue.fields || {};
  return [
    '=HYPERLINK("https://' + ON_HOLD_JIRA_DOMAIN + '/browse/' + key + '", "' + key + '")',
    onHoldSheetText_(fields.summary),
    onHoldSheetText_(fields[ids.catalyst]),
    onHoldSheetText_(fields.status),
    onHoldSheetText_(fields.assignee),
    onHoldSheetText_(fields[ids.searchTemplate]),
    onHoldSheetText_(fields.reporter),
    fields.created ? String(fields.created).substring(0, 10) : "",
    onHoldSheetText_(fields[ids.customerAlias])
  ];
}

function onHoldActiveStatusFormula_(rowNumber) {
  return '=IF(I' + rowNumber + ' = "", "", IF(ISNUMBER(MATCH(I' + rowNumber + ', L:L, 0)), "InActive", "Active"))';
}

function onHoldWriteActiveStatusFormulas_(sheet, rowCount) {
  var formulas = [];
  for (var i = 0; i < rowCount; i++) formulas.push([onHoldActiveStatusFormula_(i + 2)]);
  if (formulas.length) sheet.getRange(2, 10, formulas.length, 1).setFormulas(formulas);
}

function onHoldWaitForActiveStatus_(sheet, rowCount) {
  var deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    SpreadsheetApp.flush();
    var values = sheet.getRange(2, 9, rowCount, 2).getDisplayValues();
    var waiting = false;
    for (var i = 0; i < values.length; i++) {
      if (String(values[i][0]).trim() && !String(values[i][1]).trim()) waiting = true;
    }
    if (!waiting) return;
    Utilities.sleep(1000);
  }
  Logger.log("Timed out waiting for column J formulas to calculate.");
}

function onHoldRowByKey_(issues) {
  var rowByKey = {};
  (issues || []).forEach(function (issue, index) {
    var key = onHoldIssueKey_(issue && issue.key);
    if (key) rowByKey[key] = index + 2;
  });
  return rowByKey;
}

function onHoldChangeNote_() {
  return "status changed to - " + ON_HOLD_STATUS;
}

function onHoldMarkTransitioned_(sheet, rowByKey, transitioned) {
  var rows = [];
  (transitioned || []).forEach(function (key) {
    if (rowByKey && rowByKey[key]) rows.push(rowByKey[key]);
  });
  rows.sort(function (a, b) { return a - b; });
  var note = onHoldChangeNote_();
  var start = null;
  var count = 0;
  function writeGroup() {
    if (start === null) return;
    var notes = [];
    var statuses = [];
    for (var i = 0; i < count; i++) {
      statuses.push([ON_HOLD_STATUS]);
      notes.push([note]);
    }
    sheet.getRange(start, 4, count, 1).setValues(statuses);
    sheet.getRange(start, 11, count, 1).setValues(notes);
  }
  rows.forEach(function (row) {
    if (start === null) { start = row; count = 1; return; }
    if (row === start + count) { count++; return; }
    writeGroup();
    start = row;
    count = 1;
  });
  writeGroup();
}

function onHoldReadLoadedTickets_(sheet) {
  var lastRow = Math.max(sheet.getLastRow(), 2);
  var height = lastRow - 1;
  var range = sheet.getRange(2, 1, height, 1);
  var displays = range.getDisplayValues();
  var formulas = range.getFormulas();
  var statuses = sheet.getRange(2, 4, height, 1).getDisplayValues();
  var active = sheet.getRange(2, 10, height, 1).getDisplayValues();
  var keys = [];
  var rowByKey = {};
  var seen = {};
  for (var i = 0; i < height; i++) {
    var key = onHoldIssueKey_(displays[i][0]) || onHoldIssueKey_(formulas[i][0]);
    if (!key || seen[key]) continue;
    if (!onHoldIsInactive_(active[i][0])) continue;
    if (onHoldIsTargetStatus_(statuses[i][0])) continue;
    seen[key] = true;
    keys.push(key);
    rowByKey[key] = i + 2;
  }
  return { keys: keys, rowByKey: rowByKey };
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
  if (typeof val === "string" && val.trim().indexOf('{"type":"doc"') === 0) {
    try { return onHoldExtractFieldValue_(JSON.parse(val)); } catch (err) { return val; }
  }
  return val;
}

function onHoldSheetText_(value) {
  var text = onHoldExtractFieldValue_(value);
  if (typeof text !== "string") return text;
  if (/^[=+\-@]/.test(text)) return "'" + text;
  return text;
}

function onHoldIssueStatus_(issue) {
  var fields = issue && issue.fields;
  return String(onHoldExtractFieldValue_(fields && fields.status) || "").trim();
}

function onHoldIsTargetStatus_(status) {
  return String(status || "").trim().toLowerCase() === ON_HOLD_STATUS.toLowerCase();
}

function onHoldIsInactive_(status) {
  return String(status || "").trim().toLowerCase() === ON_HOLD_INACTIVE.toLowerCase();
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
    return "id=" + (item && item.id !== undefined ? item.id : "") + ' name="' + (item && item.name ? item.name : "") + '" to="' + toName + '"';
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
  var message = "Moved " + moved + " InActive issues to " + ON_HOLD_STATUS + ".";
  if (result.skippedActive) message += " " + result.skippedActive + " Active issues were left unchanged.";
  if (result.already) message += " " + result.already + " were already " + ON_HOLD_STATUS + ".";
  if (result.failures.length) message += " " + result.failures.length + " failed.\n\n" + result.failures.slice(0, 5).join("\n");
  if (truncated) message += "\n\nLoaded the first " + loadedCount + " issues. The query has more pages than this run keeps.";
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
    onHoldIsInactive_: onHoldIsInactive_,
    onHoldIssueStatus_: onHoldIssueStatus_,
    onHoldIssueKey_: onHoldIssueKey_,
    onHoldDescribeTransitions_: onHoldDescribeTransitions_,
    onHoldIssueToRow_: onHoldIssueToRow_,
    onHoldJql_: onHoldJql_,
    onHoldChangeNote_: onHoldChangeNote_,
    onHoldActiveStatusFormula_: onHoldActiveStatusFormula_,
    onHoldMatchField_: onHoldMatchField_,
    ON_HOLD_STATUS: ON_HOLD_STATUS,
    ON_HOLD_HEADERS: ON_HOLD_HEADERS
  };
}
