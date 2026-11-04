/**
 * SKILL EOD daily report. Paste this file into the spreadsheet:
 * Extensions → Apps Script. Set the project timezone to Asia/Kolkata.
 *
 * Script properties:
 *   JIRA_API_TOKEN   Atlassian API token. Required.
 *   JIRA_EMAIL       Defaults to sowmiya.kirubakaran@arcadia.com.
 *   REPORT_DATE      Optional yyyy-MM-dd. Empty means today in Asia/Kolkata.
 *
 * Run installDailyTrigger once. It calls runSkillEod every day at 20:30.
 * The Nov 03 tab (gid 1231097422) is never replaced.
 */

var JIRA_BASE = 'https://arcadiapower.atlassian.net';
var SPREADSHEET_ID = '1w3uc-rSxWuHBmGjh6IRpjBt1kWhDiQG3QLXalDvKtno';
var PROTECTED_GID = 1231097422;
var TIMEZONE = 'Asia/Kolkata';
var AVAILABLE_HOURS = 7;
var RESOLVED_STATUS = 'Resolved';
var TRANSITION_STATUSES = { 'Pending Audits': true, 'Under Reporter': true, 'Under OCR': true };
var FEASIBLE = 'CA-Feasible';
var OPS_TEAM = 'ops_Dev_extraction';
var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

var ROSTER = [
  ['Nexus', 'Tharun Vijayakumar'],
  ['Nebula', 'Venkat Ganesh R'],
  ['Neon', 'Chandana C Savalgimath'],
  ['Nexus', 'Esvar K N'],
  ['Nexus', 'Janani Nataraj Kumar'],
  ['Nexus', 'K Pavankumar'],
  ['Nova', 'Raghuram selvaraj'],
  ['Nova', 'Pooja Sri Balakrishnan'],
  ['Neon', 'Nitish Kumar Jangam'],
  ['Nova', 'Sartaj R'],
  ['Olympus', 'Karthik C'],
  ['Olympus', 'Saipriyadarsini Balaji'],
  ['Olympus', 'Chandru K S'],
  ['Olympus', 'Stanley Deivanayagam'],
  ['Orin', 'Anusha M'],
  ['Orin', 'Dinesh Ramasamy'],
  ['Orin', 'Smitha R Gulalakai'],
  ['Orin', 'Yogesh Thambidurai']
];

var ALIASES = {
  'esvar kn': 'Esvar K N',
  'esvar k n': 'Esvar K N',
  'pavankumar k': 'K Pavankumar',
  'k pavankumar': 'K Pavankumar',
  'janani n': 'Janani Nataraj Kumar',
  'janani nataraj kumar': 'Janani Nataraj Kumar',
  'pooja sri b': 'Pooja Sri Balakrishnan',
  'pooja sri balakrishnan': 'Pooja Sri Balakrishnan',
  'b saipriyadarsini saipriyadarsini': 'Saipriyadarsini Balaji',
  'saipriyadarsini balaji': 'Saipriyadarsini Balaji',
  'smitha r g': 'Smitha R Gulalakai',
  'smitha r gulalakai': 'Smitha R Gulalakai',
  'yogesh t': 'Yogesh Thambidurai',
  'yogesh thambidurai': 'Yogesh Thambidurai'
};

var BLUE = '#286b7f';
var BROWN = '#8c510c';
var LIGHT = '#edf4f9';
var CREAM = '#fff2d1';
var WHITE = '#ffffff';
var SECTION_PREFIXES = [
  'Skillable EOD',
  'labels IN',
  'Skill resolved and',
  'Member contribution',
  'CA-Feasible tickets',
  'Tickets resolved',
  'Skill member effort',
  'Total hours =',
  'Resolver moved'
];

var FIELDS = [
  'summary',
  'status',
  'customfield_11239',
  'customfield_12282',
  'customfield_11184',
  'customfield_15845',
  'customfield_11185',
  'customfield_11187',
  'worklog'
].join(',');

function runSkillEod() {
  var override = PropertiesService.getScriptProperties().getProperty('REPORT_DATE');
  var parts = (override || '').split('-');
  if (parts.length === 3 && parts[0].length === 4) {
    runForDay(Number(parts[0]), Number(parts[1]), Number(parts[2]));
    return;
  }
  var now = new Date();
  runForDay(
    Number(Utilities.formatDate(now, TIMEZONE, 'yyyy')),
    Number(Utilities.formatDate(now, TIMEZONE, 'MM')),
    Number(Utilities.formatDate(now, TIMEZONE, 'dd'))
  );
}

function installDailyTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === 'runSkillEod') ScriptApp.deleteTrigger(trigger);
  });
  ScriptApp.newTrigger('runSkillEod')
    .timeBased()
    .everyDays(1)
    .atHour(20)
    .nearMinute(30)
    .create();
}

function runForDay(year, month, day) {
  var label = 'CASkillable-' + pad(day) + '-' + MONTHS[month - 1];
  var jql = 'labels IN (' + label + ') AND status != "On Hold (migrated)"';
  var issues = fetchIssues(jql);
  issues.forEach(enrichIssue);
  var rows = buildSheet(year, month, day, issues, jql);
  writeReport(tabName(month, day), rows);
}

function tabName(month, day) {
  return MONTHS[month - 1] + ' ' + pad(day);
}

function pad(value) {
  return value < 10 ? '0' + value : String(value);
}

function jiraFetch(path) {
  var props = PropertiesService.getScriptProperties();
  var email = props.getProperty('JIRA_EMAIL') || 'sowmiya.kirubakaran@arcadia.com';
  var token = props.getProperty('JIRA_API_TOKEN');
  if (!token || token.indexOf('REPLACE') !== -1) {
    throw new Error('Set script property JIRA_API_TOKEN. The token is not written to the sheet.');
  }
  var response = UrlFetchApp.fetch(JIRA_BASE + path, {
    headers: {
      Authorization: 'Basic ' + Utilities.base64Encode(email + ':' + token),
      Accept: 'application/json'
    },
    muteHttpExceptions: true
  });
  var code = response.getResponseCode();
  if (code >= 300) throw new Error('Jira HTTP ' + code + ' for ' + path.split('?')[0]);
  return JSON.parse(response.getContentText() || '{}');
}

function fetchIssues(jql) {
  var issues = [];
  var page = '';
  while (true) {
    var path = '/rest/api/3/search/jql?jql=' + encodeURIComponent(jql) +
      '&maxResults=100&fields=' + encodeURIComponent(FIELDS) + '&expand=changelog';
    if (page) path += '&nextPageToken=' + encodeURIComponent(page);
    var data = jiraFetch(path);
    var batch = data.issues || [];
    issues = issues.concat(batch);
    if (data.isLast || !data.nextPageToken || !batch.length) break;
    page = data.nextPageToken;
  }
  return issues;
}

function enrichIssue(issue) {
  var changelog = issue.changelog || {};
  var histories = (changelog.histories || []).slice();
  var total = changelog.total || histories.length;
  var start = histories.length;
  while (start < total) {
    var data = jiraFetch('/rest/api/3/issue/' + issue.key + '/changelog?maxResults=100&startAt=' + start);
    var page = data.values || [];
    if (!page.length) break;
    histories = histories.concat(page);
    start += page.length;
    total = data.total || total;
  }
  issue._histories = histories;
  var worklog = (issue.fields || {}).worklog || {};
  var entries = (worklog.worklogs || []).slice();
  var entryTotal = worklog.total || entries.length;
  start = entries.length;
  while (start < entryTotal) {
    var more = jiraFetch('/rest/api/3/issue/' + issue.key + '/worklog?maxResults=100&startAt=' + start);
    var logs = more.worklogs || [];
    if (!logs.length) break;
    entries = entries.concat(logs);
    start += logs.length;
    entryTotal = more.total || entryTotal;
  }
  issue._worklogs = entries;
}

function buildSheet(year, month, day, issues, jql) {
  var bounds = dayBounds(year, month, day);
  var teams = {};
  ROSTER.forEach(function (pair) { teams[pair[1]] = pair[0]; });
  var actions = [];
  issues.forEach(function (issue) {
    var fields = issue.fields || {};
    var latest = {};
    (issue._histories || []).forEach(function (history) {
      var when = parseJiraTime(history.created);
      if (when === null || when < bounds.start || when >= bounds.end) return;
      var author = canonicalName((history.author || {}).displayName);
      if (!author) return;
      (history.items || []).forEach(function (item) {
        if (item.field !== 'status') return;
        var target = item.toString || '';
        if (target !== RESOLVED_STATUS && !TRANSITION_STATUSES[target]) return;
        if (!latest[author] || when >= latest[author].when) latest[author] = { when: when, target: target };
      });
    });
    Object.keys(latest).forEach(function (author) {
      var target = latest[author].target;
      var kind = target === RESOLVED_STATUS ? 'Resolved' : 'Transitioned';
      var minutes = effortMinutes(fields);
      actions.push({
        key: issue.key,
        summary: fields.summary || '',
        status: (fields.status || {}).name || '',
        template: templateName(fields),
        whiteboard: whiteboardOf(fields) || 'empty',
        skill: isSkill(fields),
        member: author,
        team: teams[author] || OPS_TEAM,
        kind: kind,
        handoff: kind === 'Transitioned' ? target : 'Resolved',
        minutes: minutes,
        manualSeconds: manualSeconds(issue, author, bounds)
      });
    });
  });

  var byMember = {};
  actions.forEach(function (action) {
    if (!byMember[action.member]) byMember[action.member] = [];
    byMember[action.member].push(action);
  });
  var members = ROSTER.map(function (pair) { return [pair[0], pair[1]]; });
  Object.keys(byMember).filter(function (name) { return !teams[name]; }).sort().forEach(function (name) {
    members.push([OPS_TEAM, name]);
  });
  var memberRows = members.map(function (pair) {
    return memberRecord(pair[0], pair[1], byMember[pair[1]] || []);
  });
  var enabled = memberRows.filter(function (row) { return row.team !== OPS_TEAM; });
  var others = memberRows.filter(function (row) { return row.team === OPS_TEAM; });

  var workedKeys = {};
  var skillResolvedKeys = {};
  var addressedKeys = {};
  actions.forEach(function (action) {
    workedKeys[action.key] = true;
    if (action.skill) addressedKeys[action.key] = true;
    if (action.skill && action.kind === 'Resolved') skillResolvedKeys[action.key] = true;
  });
  var feasible = issues.filter(function (issue) { return isSkill(issue.fields || {}); });
  var statusCounts = {};
  issues.forEach(function (issue) {
    var name = ((issue.fields || {}).status || {}).name || '';
    statusCounts[name] = (statusCounts[name] || 0) + 1;
  });
  var skillResolved = sum(memberRows, 'skillResolved');
  var skillAddressed = sum(memberRows, 'skillAddressed');
  var workedCount = Object.keys(workedKeys).length;
  var resolvedCount = Object.keys(skillResolvedKeys).length;
  var stamp = Utilities.formatDate(new Date(), TIMEZONE, "yyyy-MM-dd'T'HH:mm:ss") + '+05:30';
  var rows = [
    ['Skillable EOD — ' + day + ' ' + MONTHS[month - 1] + ' ' + year],
    [TIMEZONE, labelFrom(jql), 'Generated ' + stamp],
    [jql],
    ['Skill resolved', skillResolved, 'Skill addressed', skillAddressed, 'CA-Feasible not resolved', (feasible.length - resolvedCount) + ' of ' + feasible.length],
    [
      'Tickets in label: ' + issues.length,
      'Worked: ' + workedCount,
      'No resolve or handoff: ' + (issues.length - workedCount),
      'Pending Audits: ' + (statusCounts['Pending Audits'] || 0),
      'Under Reporter: ' + (statusCounts['Under Reporter'] || 0)
    ],
    [],
    ['Skill resolved and skill addressed'],
    cohortHeader(),
    cohortRow('Skill enabled', enabled),
    cohortRow('Not skill enabled', others),
    [],
    ['Member contribution'],
    memberHeader()
  ];
  memberRows.forEach(function (row) { rows.push(memberLine(row)); });
  rows.push([]);

  var resolved = actions.filter(function (action) { return action.kind === 'Resolved'; });
  resolved.sort(function (a, b) { return compareActions(a, b); });
  rows.push(['Resolver tickets and templates (' + resolved.length + ')']);
  rows.push(['Resolver moved the ticket to Resolved on the report day. Template is the Search Template on the ticket.']);
  rows.push(['Ticket', 'Template', 'Resolver', 'Team', 'Cohort', 'Status', 'ITD Whiteboard', 'Class', 'Summary']);
  resolved.forEach(function (action) {
    rows.push([
      action.key, action.template, action.member, action.team,
      teams[action.member] ? 'Skill enabled' : 'Not skill enabled',
      action.status, action.whiteboard, action.skill ? 'Skill' : 'Non-skill', action.summary
    ]);
  });
  rows.push([]);

  var notResolved = feasible.filter(function (issue) { return !skillResolvedKeys[issue.key]; });
  notResolved.sort(function (a, b) { return a.key < b.key ? -1 : a.key > b.key ? 1 : 0; });
  rows.push(['CA-Feasible tickets not resolved (' + notResolved.length + ')']);
  rows.push(['Ticket', 'Status', 'ITD Whiteboard', 'Skill resolved', 'Skill addressed', 'Summary']);
  notResolved.forEach(function (issue) {
    var fields = issue.fields || {};
    rows.push([
      issue.key,
      (fields.status || {}).name || '',
      whiteboardOf(fields) || 'empty',
      'No',
      addressedKeys[issue.key] ? 'Yes' : 'No',
      fields.summary || ''
    ]);
  });
  rows.push([]);

  var ordered = actions.slice().sort(function (a, b) { return compareActions(a, b); });
  rows.push(['Tickets resolved or transitioned (' + ordered.length + ')']);
  rows.push(['Ticket', 'Member', 'Team', 'Action', 'Handoff', 'Status', 'ITD Whiteboard', 'Class', 'Summary']);
  ordered.forEach(function (action) {
    rows.push([
      action.key, action.member, action.team, action.kind, action.handoff,
      action.status, action.whiteboard, action.skill ? 'Skill' : 'Non-skill', action.summary
    ]);
  });
  rows.push([]);
  rows.push(['Skill member effort calculation']);
  rows.push(['Total hours = Manual hours + Skill hours + Non-skill hours. Skill hours = (Analysis minutes + Unit testing minutes + Development minutes) / 60 on CA-Feasible tickets. Non-skill hours use the same effort fields on every other ticket. Manual hours are the Jira worklogs that member logged on the report day.']);
  rows.push(['Team', 'Member', 'Ticket', 'ITD Whiteboard', 'Class', 'Action', 'Analysis minutes', 'Unit testing minutes', 'Development minutes']);
  members.forEach(function (pair) {
    var owned = (byMember[pair[1]] || []).slice().sort(function (a, b) {
      return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    });
    if (!owned.length) rows.push([pair[0], pair[1], '', '', '', '', 0, 0, 0]);
    owned.forEach(function (action) {
      rows.push([
        pair[0], pair[1], action.key, action.whiteboard,
        action.skill ? 'Skill' : 'Non-skill', action.kind,
        plainNumber(action.minutes[0]), plainNumber(action.minutes[1]), plainNumber(action.minutes[2])
      ]);
    });
    rows.push([pair[0], pair[1], 'Total']);
  });
  return rows;
}

function writeReport(name, rows) {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  ss.getSheets().forEach(function (sheet) {
    if (sheet.getSheetId() === PROTECTED_GID && sheet.getName() === name) {
      throw new Error('Refusing to replace the existing ' + name + ' tab.');
    }
  });
  var sheet = ss.getSheetByName(name) || ss.insertSheet(name);
  sheet.clear();
  if (!rows.length) return;
  var width = rows.reduce(function (max, row) { return Math.max(max, row.length); }, 1);
  var values = rows.map(function (row) {
    var copy = row.slice();
    while (copy.length < width) copy.push('');
    return copy;
  });
  sheet.getRange(1, 1, values.length, width).setValues(values);
  paint(sheet, rows, width);
}

function paint(sheet, rows, width) {
  var cream = false;
  var bodyStart = null;
  var bodyWidth = width;
  var bodyColor = LIGHT;
  function flush(end) {
    if (bodyStart !== null && end > bodyStart) {
      sheet.getRange(bodyStart + 1, 1, end - bodyStart, bodyWidth).setBackground(bodyColor);
    }
    bodyStart = null;
  }
  rows.forEach(function (row, index) {
    var text = row.length ? String(row[0]).trim() : '';
    var blank = !row.length || !row.some(function (cell) { return String(cell).trim(); });
    var header = (text === 'Cohort' || text === 'Team' || text === 'Ticket') &&
      row.length > 1 && (row[1] === 'People' || row[1] === 'Member' || row[1] === 'Template' || row[1] === 'Status');
    if (blank) {
      flush(index);
      cream = false;
      return;
    }
    if (header) {
      flush(index);
      var color = cream ? BROWN : BLUE;
      sheet.getRange(index + 1, 1, 1, row.length)
        .setBackground(color)
        .setFontColor(WHITE)
        .setFontWeight('bold')
        .setFontSize(10);
      bodyStart = index + 1;
      bodyWidth = row.length;
      bodyColor = cream ? CREAM : LIGHT;
      return;
    }
    if (text.indexOf('Resolver tickets') === 0) {
      flush(index);
      cream = true;
      sheet.getRange(index + 1, 1, 1, width).setBackground(WHITE).setFontColor(BROWN).setFontWeight('bold').setFontSize(12);
      return;
    }
    if (SECTION_PREFIXES.some(function (prefix) { return text.indexOf(prefix) === 0; })) {
      flush(index);
      sheet.getRange(index + 1, 1, 1, width).setBackground(WHITE).setFontColor(BLUE).setFontWeight('bold').setFontSize(12);
    }
  });
  flush(rows.length);
}

function dayBounds(year, month, day) {
  var utcMidnight = Date.UTC(year, month - 1, day);
  var start = utcMidnight - 5.5 * 60 * 60 * 1000;
  return { start: start, end: start + 24 * 60 * 60 * 1000 };
}

function parseJiraTime(text) {
  if (!text) return null;
  if (text.charAt(text.length - 1) === 'Z') return new Date(text).getTime();
  var match = String(text).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?([+-])(\d{2})(\d{2})?$/);
  if (!match) {
    var parsed = Date.parse(text);
    return isNaN(parsed) ? null : parsed;
  }
  var utc = Date.UTC(+match[1], +match[2] - 1, +match[3], +match[4], +match[5], +match[6]);
  var sign = match[7] === '-' ? -1 : 1;
  var offset = (Number(match[8]) * 60 + Number(match[9] || 0)) * 60 * 1000;
  return utc - sign * offset;
}

function normName(name) {
  return String(name || '').replace(/\./g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}

function canonicalName(name) {
  var key = normName(name);
  if (ALIASES[key]) return ALIASES[key];
  return String(name || '').replace(/\s+/g, ' ').trim();
}

function templateName(fields) {
  var value = fields.customfield_12282;
  if (value && typeof value === 'object') return value.value || value.name || '';
  return value || '';
}

function whiteboardOf(fields) {
  return String(fields.customfield_11239 || '').trim();
}

function isSkill(fields) {
  return whiteboardOf(fields) === FEASIBLE;
}

function effortMinutes(fields) {
  var analysis = fields.customfield_11184;
  if (analysis === null || analysis === undefined || analysis === '') analysis = fields.customfield_15845 || 0;
  return [Number(analysis || 0), Number(fields.customfield_11185 || 0), Number(fields.customfield_11187 || 0)];
}

function manualSeconds(issue, member, bounds) {
  var total = 0;
  (issue._worklogs || []).forEach(function (entry) {
    if (canonicalName((entry.author || {}).displayName) !== member) return;
    var when = parseJiraTime(entry.started);
    if (when === null || when < bounds.start || when >= bounds.end) return;
    total += Number(entry.timeSpentSeconds || 0);
  });
  return total;
}

function memberRecord(team, name, owned) {
  var skillResolved = count(owned, function (action) { return action.skill && action.kind === 'Resolved'; });
  var skillTransitioned = count(owned, function (action) { return action.skill && action.kind === 'Transitioned'; });
  var otherResolved = count(owned, function (action) { return !action.skill && action.kind === 'Resolved'; });
  var otherTransitioned = count(owned, function (action) { return !action.skill && action.kind === 'Transitioned'; });
  var skillMinutes = 0;
  var otherMinutes = 0;
  var manual = 0;
  owned.forEach(function (action) {
    var minutes = action.minutes[0] + action.minutes[1] + action.minutes[2];
    if (action.skill) skillMinutes += minutes;
    else otherMinutes += minutes;
    manual += action.manualSeconds;
  });
  return {
    team: team,
    name: name,
    worked: owned.length,
    resolved: skillResolved + otherResolved,
    transitioned: skillTransitioned + otherTransitioned,
    skillResolved: skillResolved,
    skillTransitioned: skillTransitioned,
    skillAddressed: skillResolved + skillTransitioned,
    otherResolved: otherResolved,
    otherTransitioned: otherTransitioned,
    totalHours: manual / 3600 + skillMinutes / 60 + otherMinutes / 60,
    manualHours: manual / 3600,
    skillHours: skillMinutes / 60,
    otherHours: otherMinutes / 60
  };
}

function memberHeader() {
  return ['Team', 'Member', 'Available hours', 'Worked', 'Resolved', 'Transitioned', 'Skill resolved', 'Skill transitioned', 'Skill addressed', 'Non-skill resolved', 'Non-skill transitioned', 'Total hours', 'Manual hours', 'Skill hours', 'Non-skill hours', 'Skill leverage', 'Skill performance'];
}

function memberLine(row) {
  return [
    row.team, row.name, AVAILABLE_HOURS, row.worked, row.resolved, row.transitioned,
    row.skillResolved, row.skillTransitioned, row.skillAddressed, row.otherResolved, row.otherTransitioned,
    plainNumber(row.totalHours), plainNumber(row.manualHours), plainNumber(row.skillHours), plainNumber(row.otherHours),
    leverage(row.skillAddressed, row.worked), performance(row.skillHours + row.otherHours)
  ];
}

function cohortHeader() {
  return ['Cohort', 'People', 'Skill resolved', 'Skill addressed', 'Worked', 'Resolved', 'Transitioned', 'Total hours', 'Manual hours', 'Skill hours', 'Non-skill hours', 'Skill leverage', 'Skill performance'];
}

function cohortRow(label, rows) {
  var people = rows.length;
  var skillAddressed = sum(rows, 'skillAddressed');
  var worked = sum(rows, 'worked');
  var skillHours = sum(rows, 'skillHours');
  var otherHours = sum(rows, 'otherHours');
  return [
    label, people, sum(rows, 'skillResolved'), skillAddressed, worked,
    sum(rows, 'resolved'), sum(rows, 'transitioned'),
    plainNumber(sum(rows, 'totalHours')), plainNumber(sum(rows, 'manualHours')),
    plainNumber(skillHours), plainNumber(otherHours),
    leverage(skillAddressed, worked),
    performance(people ? (skillHours + otherHours) / people : 0)
  ];
}

function count(rows, test) {
  return rows.filter(test).length;
}

function sum(rows, key) {
  return rows.reduce(function (total, row) { return total + Number(row[key] || 0); }, 0);
}

function plainNumber(value) {
  var rounded = Math.round((value + 1e-9) * 100) / 100;
  if (rounded === Math.trunc(rounded)) return Math.trunc(rounded);
  return rounded;
}

function performance(hours) {
  return hours.toFixed(2) + 'h / ' + AVAILABLE_HOURS + 'h';
}

function leverage(addressed, worked) {
  if (!worked) return '';
  return plainNumber(addressed / worked);
}

function labelFrom(jql) {
  return jql.split(' AND ')[0].replace('labels IN (', '').replace(')', '');
}

function compareActions(a, b) {
  var left = rosterRank(a.member);
  var right = rosterRank(b.member);
  if (left !== right) return left - right;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

function rosterRank(name) {
  for (var i = 0; i < ROSTER.length; i++) if (ROSTER[i][1] === name) return i;
  return ROSTER.length;
}
