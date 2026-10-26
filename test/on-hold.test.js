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
  assert.match(onHold.onHoldDescribeTransitions_(payload)[1], /id=41/);
});

test('tickets already On Hold are recognized and keys are parsed from links', () => {
  assert.equal(onHold.onHoldIsTargetStatus_('On Hold'), true);
  assert.equal(onHold.onHoldIsTargetStatus_(' on hold '), true);
  assert.equal(onHold.onHoldIsTargetStatus_('Open'), false);
  assert.equal(onHold.onHoldIssueStatus_({ fields: { status: { name: 'In Progress' } } }), 'In Progress');
  assert.equal(
    onHold.onHoldIssueKey_('=HYPERLINK("https://arcadiapower.atlassian.net/browse/FS-187174", "FS-187174")'),
    'FS-187174'
  );
});

test('sheet rows keep the B27 column order and put status in column C', () => {
  const row = onHold.onHoldIssueToRow_({
    key: 'FS-187174',
    fields: {
      reporter: { displayName: 'Ada Lovelace' },
      status: { name: 'Open' },
      created: '2024-05-01T08:30:00.000+0000',
      assignee: { displayName: 'Grace Hopper' }
    }
  });
  assert.equal(row.length, 20);
  assert.match(row[0], /FS-187174/);
  assert.equal(row[1], 'Ada Lovelace');
  assert.equal(row[2], 'Open');
  assert.equal(row[3], '2024-05-01');
  assert.equal(row[12], 'Grace Hopper');
});
