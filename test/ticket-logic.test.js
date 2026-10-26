'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const TicketLogic = require('../apps-script/Code.js');

const FIELD_PATHS = {
  key: 'key',
  summary: 'fields.summary',
  catalyst: 'fields.customfield_CATALYST',
  status: 'fields.status.name',
  assignee: 'fields.assignee.displayName',
  searchTemplate: 'fields.customfield_SEARCH_TEMPLATE',
  reporter: 'fields.reporter.displayName',
  created: 'fields.created',
  customerAlias: 'fields.customfield_CUSTOMER_ALIAS'
};

function searchConfig(overrides) {
  return {
    API_BASE_URL: 'https://your-domain.atlassian.net',
    FIELDS: FIELD_PATHS,
    SEARCH: Object.assign({
      PATH: '/rest/api/3/search/jql',
      METHOD: 'GET',
      PARAMS: {
        jql: 'project = YOURPROJECT ORDER BY updated DESC',
        maxResults: 100,
        fields: null
      },
      PAGINATION: 'nextPageToken',
      ISSUES_PATH: 'issues'
    }, overrides || {})
  };
}

function transitionConfig() {
  return {
    API_BASE_URL: 'https://your-domain.atlassian.net/',
    TRANSITION: {
      PATH_TEMPLATE: '/rest/api/3/issue/{key}/transitions',
      LIST_PATH_TEMPLATE: '/rest/api/3/issue/{key}/transitions',
      BODY_TEMPLATE: '{"transition":{"id":"{transitionId}"}}'
    }
  };
}

test('column J formula matches the sheet formula and follows the row', () => {
  assert.equal(
    TicketLogic.buildActiveStatusFormula(2),
    '=IF(I2 = "", "", IF(ISNUMBER(MATCH(I2, L:L, 0)), "InActive", "Active"))'
  );
  const formulas = TicketLogic.buildActiveStatusFormulas(2, 3);
  assert.deepEqual(formulas, [
    ['=IF(I2 = "", "", IF(ISNUMBER(MATCH(I2, L:L, 0)), "InActive", "Active"))'],
    ['=IF(I3 = "", "", IF(ISNUMBER(MATCH(I3, L:L, 0)), "InActive", "Active"))'],
    ['=IF(I4 = "", "", IF(ISNUMBER(MATCH(I4, L:L, 0)), "InActive", "Active"))']
  ]);
  assert.throws(() => TicketLogic.buildActiveStatusFormula(1), /integer >= 2/);
  assert.throws(() => TicketLogic.buildActiveStatusFormula('2'), /integer >= 2/);
});

test('mapIssueToRow fills columns A through I and coerces the created date', () => {
  const row = TicketLogic.mapIssueToRow({
    key: 'PROJ-10',
    fields: {
      summary: 'Meter offline',
      customfield_CATALYST: 'Yes',
      status: { name: 'Open' },
      assignee: { displayName: 'Ada Lovelace' },
      customfield_SEARCH_TEMPLATE: 'Default',
      reporter: null,
      created: '2024-05-01T08:30:00.000+0000',
      customfield_CUSTOMER_ALIAS: { value: 'acme' }
    }
  }, FIELD_PATHS);

  assert.equal(row.length, 9);
  assert.equal(row[0], 'PROJ-10');
  assert.equal(row[1], 'Meter offline');
  assert.equal(row[2], 'Yes');
  assert.equal(row[3], 'Open');
  assert.equal(row[4], 'Ada Lovelace');
  assert.equal(row[5], 'Default');
  assert.equal(row[6], '');
  assert.equal(row[7].toISOString(), '2024-05-01T08:30:00.000Z');
  assert.equal(row[8], 'acme');
});

test('sheet text that would execute as a formula is stored as a text formula', () => {
  assert.equal(TicketLogic.sanitizeSheetText('=1+1'), '="=1+1"');
  assert.equal(TicketLogic.sanitizeSheetText('say "hi"'), 'say "hi"');
  assert.equal(TicketLogic.sanitizeSheetText('+cmd\nnext'), '="+cmd"&CHAR(10)&"next"');
  const row = TicketLogic.mapIssueToRow({
    key: 'PROJ-1',
    fields: { summary: '=IMPORTRANGE("x","A1")' }
  }, FIELD_PATHS);
  assert.equal(row[1], '="=IMPORTRANGE(""x"",""A1"")"');
});

test('object and array tracker fields collapse to text', () => {
  assert.equal(TicketLogic.normalizeCellValue({ displayName: 'Grace Hopper' }), 'Grace Hopper');
  assert.equal(TicketLogic.normalizeCellValue({ name: 'Open' }), 'Open');
  assert.equal(TicketLogic.normalizeCellValue([{ value: 'east' }, { value: 'west' }]), 'east, west');
  assert.equal(TicketLogic.normalizeCellValue(null), '');
});

test('inactive tickets transition only when they are not already On Hold', () => {
  const options = {
    inactiveValue: 'InActive',
    alreadyTargetStatuses: ['On Hold']
  };
  assert.equal(TicketLogic.shouldTransition('InActive', 'Open', options), true);
  assert.equal(TicketLogic.shouldTransition(' inactive ', 'Waiting', options), true);
  assert.equal(TicketLogic.shouldTransition('INACTIVE', ' on hold ', options), false);
  assert.equal(TicketLogic.shouldTransition('Active', 'Open', options), false);
  assert.equal(TicketLogic.shouldTransition('', 'Open', options), false);
  assert.equal(TicketLogic.shouldTransition('InActive', '', options), true);
});

test('candidate selection uses columns A, D, and J and skips unsafe keys', () => {
  const values = [
    ['PROJ-1', '', '', 'Open', '', '', '', '', 'acme', 'InActive'],
    ['PROJ-2', '', '', 'On Hold', '', '', '', '', 'old', 'inactive'],
    ['', '', '', 'Open', '', '', '', '', '', 'InActive'],
    ['../etc', '', '', 'Open', '', '', '', '', 'acme', 'InActive'],
    [10001, '', '', 'Open', '', '', '', '', 'acme', ''],
    ['PROJ-3', '', '', 'Waiting', '', '', '', '', 'acme', 'Active']
  ];
  const result = TicketLogic.collectTransitionCandidates(values, {
    dataStartRow: 2,
    inactiveValue: 'InActive',
    alreadyTargetStatuses: ['On Hold']
  });

  assert.deepEqual(result.candidates.map((item) => item.key), ['PROJ-1']);
  assert.equal(result.candidates[0].sheetRow, 2);
  assert.equal(result.candidates[0].valueIndex, 0);
  assert.deepEqual(result.skippedKeys, ['../etc']);
  assert.equal(result.inactiveAlreadyOnHold, 1);
  assert.equal(result.blankActive, 1);
});

test('successful transitions update only those status cells', () => {
  const values = [
    ['PROJ-1', '', '', 'Open', '', '', '', '', '', 'InActive'],
    ['PROJ-2', '', '', 'Waiting', '', '', '', '', '', 'Active']
  ];
  const original = values[0][3];
  const column = TicketLogic.applySuccessfulStatuses(values, [
    { valueIndex: 0, key: 'PROJ-1' }
  ], 'On Hold');
  assert.deepEqual(column, [['On Hold'], ['Waiting']]);
  assert.equal(values[0][3], original);
  assert.throws(() => TicketLogic.applySuccessfulStatuses(values, [{ valueIndex: 9 }], 'On Hold'), /outside/);
});

test('search pagination follows nextPageToken and does not repeat a token', () => {
  assert.deepEqual(
    TicketLogic.getNextPage({ issues: [{}], nextPageToken: 'page-2', isLast: false }, 'nextPageToken', {}),
    { pageToken: 'page-2', startAt: 0 }
  );
  assert.equal(
    TicketLogic.getNextPage({ nextPageToken: 'page-2', isLast: true }, 'nextPageToken', {}),
    null
  );
  assert.equal(
    TicketLogic.getNextPage({ nextPageToken: 'page-2' }, 'nextPageToken', { pageToken: 'page-2' }),
    null
  );
  assert.equal(TicketLogic.getNextPage({ nextPageToken: null, isLast: false }, 'nextPageToken', {}), null);
  assert.equal(TicketLogic.getNextPage({ issues: [] }, 'none', {}), null);
});

test('legacy startAt pagination stops on the last page', () => {
  assert.deepEqual(
    TicketLogic.getNextPage({ total: 120 }, 'startAt', { startAt: 0, pageSize: 50, maxResults: 50 }),
    { pageToken: null, startAt: 50 }
  );
  assert.equal(
    TicketLogic.getNextPage({ total: 100 }, 'startAt', { startAt: 50, pageSize: 50, maxResults: 50 }),
    null
  );
  assert.equal(
    TicketLogic.getNextPage({}, 'startAt', { startAt: 0, pageSize: 20, maxResults: 50 }),
    null
  );
  assert.throws(() => TicketLogic.getNextPage({}, 'offset', {}), /Unknown pagination/);
});

test('duplicate issue keys collapse to the first copy', () => {
  const issues = TicketLogic.dedupeIssues([
    { key: 'PROJ-1', fields: { summary: 'first' } },
    { key: 'PROJ-1', fields: { summary: 'second' } },
    { id: '99' },
    { id: '99' },
    { fields: { summary: 'no key' } },
    { fields: { summary: 'also no key' } }
  ]);
  assert.equal(issues.length, 4);
  assert.equal(issues[0].fields.summary, 'first');
});

test('GET search omits a null nextPageToken and requests mapped fields', () => {
  const config = searchConfig();
  const first = TicketLogic.buildSearchRequest(config, { pageToken: null, startAt: 0 });
  assert.equal(config.SEARCH.PARAMS.fields, null);
  assert.equal(config.SEARCH.PARAMS.nextPageToken, undefined);
  assert.equal(first.method, 'get');
  assert.equal(first.payload, null);
  assert.equal(
    first.url,
    'https://your-domain.atlassian.net/rest/api/3/search/jql?jql=project%20%3D%20YOURPROJECT%20ORDER%20BY%20updated%20DESC&maxResults=100&fields=summary%2Ccustomfield_CATALYST%2Cstatus%2Cassignee%2Ccustomfield_SEARCH_TEMPLATE%2Creporter%2Ccreated%2Ccustomfield_CUSTOMER_ALIAS'
  );

  const second = TicketLogic.buildSearchRequest(searchConfig(), { pageToken: 'abc' });
  assert.match(second.url, /nextPageToken=abc/);

  const params = searchConfig().SEARCH.PARAMS;
  assert.equal(params.nextPageToken, undefined);
  assert.equal(params.fields, null);
});

test('POST search sends JSON and does not mutate config', () => {
  const config = searchConfig({
    METHOD: 'POST',
    PARAMS: {
      jql: 'project = YOURPROJECT',
      maxResults: 50,
      fields: ['summary', 'status'],
      nextPageToken: null
    }
  });
  const request = TicketLogic.buildSearchRequest(config, { pageToken: 'token-2' });
  assert.equal(request.method, 'post');
  assert.deepEqual(JSON.parse(request.payload), {
    jql: 'project = YOURPROJECT',
    maxResults: 50,
    fields: ['summary', 'status'],
    nextPageToken: 'token-2'
  });
  assert.equal(config.SEARCH.PARAMS.nextPageToken, null);
});

test('issue extraction accepts a path or a raw array', () => {
  assert.deepEqual(TicketLogic.extractIssues({ issues: [{ key: 'A-1' }] }, 'issues'), [{ key: 'A-1' }]);
  assert.deepEqual(TicketLogic.extractIssues([{ key: 'A-1' }], ''), [{ key: 'A-1' }]);
  assert.deepEqual(TicketLogic.extractIssues({}, 'issues'), []);
  assert.throws(() => TicketLogic.extractIssues({ issues: {} }, 'issues'), /not resolve to an array/);
});

test('transition URL and body keep keys inside the path and JSON strings', () => {
  const config = transitionConfig();
  assert.equal(
    TicketLogic.buildTransitionUrl(config, 'PROJ-15'),
    'https://your-domain.atlassian.net/rest/api/3/issue/PROJ-15/transitions'
  );
  assert.equal(
    TicketLogic.buildTransitionListUrl(config, 'PROJ-15'),
    'https://your-domain.atlassian.net/rest/api/3/issue/PROJ-15/transitions'
  );
  assert.equal(
    TicketLogic.buildTransitionPayload(config.TRANSITION.BODY_TEMPLATE, { transitionId: '31"x' }, null),
    '{"transition":{"id":"31\\"x"}}'
  );
  assert.equal(
    TicketLogic.buildTransitionPayload(config.TRANSITION.BODY_TEMPLATE, { transitionId: '31' }, { fields: { resolution: { name: 'Done' } } }),
    '{"transition":{"id":"31"},"fields":{"resolution":{"name":"Done"}}}'
  );
  assert.throws(() => TicketLogic.buildTransitionUrl(config, '../PROJ-1'), /Refusing/);
  assert.throws(() => TicketLogic.buildSearchRequest({ API_BASE_URL: 'http://example.com', SEARCH: { PATH: '/x', PARAMS: {} } }, {}), /https/);
});

test('transition lookup prefers the destination status over the action name', () => {
  const payload = {
    transitions: [
      { id: 11, name: 'On Hold', to: { name: 'Waiting' } },
      { id: 31, name: 'Hold issue', to: { name: 'On Hold' } }
    ]
  };
  assert.equal(TicketLogic.findTransitionId(payload, 'on hold'), '31');
  assert.equal(TicketLogic.findTransitionId({ transitions: [{ id: 11, name: 'On Hold' }] }, 'On Hold'), '11');
  assert.equal(TicketLogic.findTransitionId({ transitions: [] }, 'On Hold'), null);
  assert.deepEqual(TicketLogic.transitionChoices(payload)[1], {
    id: '31',
    name: 'Hold issue',
    to: 'On Hold'
  });
});

test('batches and the tail clear start stay aligned with the written block', () => {
  assert.deepEqual(TicketLogic.chunk(['a', 'b', 'c', 'd', 'e'], 2), [['a', 'b'], ['c', 'd'], ['e']]);
  assert.equal(TicketLogic.tailClearStart(2, 0), 2);
  assert.equal(TicketLogic.tailClearStart(2, 40), 42);
  assert.equal(TicketLogic.isSuccessStatus(204), true);
  assert.equal(TicketLogic.isSuccessStatus(400), false);
  assert.equal(TicketLogic.isRetryableStatus(429), true);
  assert.equal(TicketLogic.isRetryableStatus(503), true);
  assert.equal(TicketLogic.isRetryableStatus(400), false);
  assert.equal(TicketLogic.isSafeIssueKey('INC0012345'), true);
  assert.equal(TicketLogic.isSafeIssueKey('PROJ-1?x'), false);
});
