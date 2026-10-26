/**
 * Pure helpers for the ticket sync. No SpreadsheetApp or UrlFetchApp calls.
 *
 * Apps Script loads every script in the project into one global scope, so this
 * file publishes `TicketLogic`. Node tests load it through module.exports.
 */
'use strict';

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
