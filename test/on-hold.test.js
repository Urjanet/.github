'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const onHold = require('../apps-script/MoveToOnHold.js');

test('On Hold transition id prefers the destination status', () => {
  const payload = {
    transitions: [
      { id: 11, name: 'On Hold', to: { name: 'Waiting' } },
      { id: 41, name: 'Hold issue', to: { name: 'On Hold' } }
    ]
  };
  assert.equal(onHold.onHoldFindTransitionId_(payload), '41');
  assert.equal(onHold.onHoldFindTransitionId_({ transitions: [{ id: 11, name: 'On Hold' }] }), '11');
  assert.equal(onHold.onHoldFindTransitionId_({ transitions: [] }), '');
});

test('only column J InActive rows are eligible, and keys parse from links', () => {
  assert.equal(onHold.onHoldIsInactive_('InActive'), true);
  assert.equal(onHold.onHoldIsInactive_(' inactive '), true);
  assert.equal(onHold.onHoldIsInactive_('Active'), false);
  assert.equal(onHold.onHoldIsTargetStatus_('On Hold'), true);
  assert.equal(onHold.onHoldIsTargetStatus_('Open'), false);
  assert.equal(
    onHold.onHoldIssueKey_('=HYPERLINK("https://arcadiapower.atlassian.net/browse/FS-187174", "FS-187174")'),
    'FS-187174'
  );
});

test('the customer alias query is the one sent to Jira', () => {
  const jql = onHold.onHoldJql_();
  assert.match(jql, /"Customer Alias\[Paragraph\]" ~ "7-Eleven, Inc"/);
  assert.match(jql, /"Customer Alias\[Paragraph\]" ~ "Albertson's Companies, Inc\."/);
  assert.match(jql, /"Customer Alias\[Paragraph\]" ~ "Westfield, LLC"/);
  assert.match(jql, /assignee IN membersOf\("ops_dev_extraction"\)/);
  assert.match(jql, /status = open or key = FS-114249$/);
  assert.equal((jql.match(/"Customer Alias\[Paragraph\]"/g) || []).length, 20);
});

test('column L aliases become batched Jira queries', () => {
  const values = [' Verizon ', 'verizon', '', 'Quoted "Name"'];
  for (let i = 0; i < 20; i++) values.push('Customer ' + i);
  const aliases = onHold.onHoldNormalizeAliases_(values);
  assert.deepEqual(aliases.slice(0, 2), ['Verizon', 'Quoted "Name"']);
  assert.equal(aliases.length, 22);

  const queries = onHold.onHoldQueriesForAliases_(aliases);
  assert.equal(queries.length, 2);
  assert.equal((queries[0].match(/"Customer Alias\[Paragraph\]"/g) || []).length, 20);
  assert.match(queries[0], /status = open or key = FS-114249$/);
  assert.match(queries[0], /~ "Verizon"/);
  assert.match(queries[0], /~ "Quoted \\"Name\\""/);
  assert.equal((queries[1].match(/"Customer Alias\[Paragraph\]"/g) || []).length, 2);
  assert.doesNotMatch(queries[1], /FS-114249/);
  assert.match(queries[1], /assignee IN membersOf\("ops_dev_extraction"\) AND status = open$/);
});

test('sheet rows are the ten requested columns and status is column D', () => {
  const row = onHold.onHoldIssueToRow_({
    key: 'FS-187174',
    fields: {
      summary: 'Meter offline',
      customfield_1: 'Yes',
      status: { name: 'Open' },
      assignee: { displayName: 'Grace Hopper' },
      customfield_2: 'Default',
      reporter: { displayName: 'Ada Lovelace' },
      created: '2024-05-01T08:30:00.000+0000',
      customfield_3: 'Verizon'
    }
  }, {
    catalyst: 'customfield_1',
    searchTemplate: 'customfield_2',
    customerAlias: 'customfield_3'
  });
  assert.equal(row.length, 9);
  assert.match(row[0], /FS-187174/);
  assert.equal(row[1], 'Meter offline');
  assert.equal(row[2], 'Yes');
  assert.equal(row[3], 'Open');
  assert.equal(row[4], 'Grace Hopper');
  assert.equal(row[5], 'Default');
  assert.equal(row[6], 'Ada Lovelace');
  assert.equal(row[7], '2024-05-01');
  assert.equal(row[8], 'Verizon');
  assert.deepEqual(onHold.ON_HOLD_HEADERS, [
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
  ]);
});

test('a moved ticket records the new status in the change note', () => {
  assert.equal(onHold.onHoldChangeNote_(), 'status changed to - On Hold');
});

test('column J formula marks aliases that appear in column L as InActive', () => {
  assert.equal(
    onHold.onHoldActiveStatusFormula_(2),
    '=IF(I2 = "", "", IF(ISNUMBER(MATCH(I2, L:L, 0)), "InActive", "Active"))'
  );
  assert.match(onHold.onHoldActiveStatusFormula_(15), /MATCH\(I15, L:L, 0\)/);
});

test('Customer Alias prefers the paragraph field when the name is shared', () => {
  const fields = [
    { id: 'customfield_1', name: 'Customer Alias', schema: { custom: 'com.atlassian.jira.plugin.system.customfieldtypes:textfield' } },
    { id: 'customfield_2', name: 'Customer Alias', schema: { custom: 'com.atlassian.jira.plugin.system.customfieldtypes:textarea' } },
    { id: 'customfield_3', name: 'Catalyst (migrated)', schema: { custom: 'com.atlassian.jira.plugin.system.customfieldtypes:textfield' } }
  ];
  assert.equal(onHold.onHoldMatchField_(fields, ['Customer Alias'], 'textarea'), 'customfield_2');
  assert.equal(onHold.onHoldMatchField_(fields, ['Catalyst (migrated)']), 'customfield_3');
});
