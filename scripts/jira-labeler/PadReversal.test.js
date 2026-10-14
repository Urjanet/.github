const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadPadReversal() {
  const context = {};
  vm.createContext(context);
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, 'PadReversal.gs'), 'utf8'),
    context
  );
  return context;
}

const pad = loadPadReversal();
const { evaluatePadReversal, labelsAfterRejectingPadReversal, resolvePadReversalUpdate } = pad;

const PAD_LABELS = [
  'MissingChargeDetected',
  'STATEMENTS_IN_PRODUCTION',
  'Charge_Extracted_Twice',
  'OB_Missing',
  'Transition'
];

function activity(overrides) {
  return Object.assign({
    labels: ['MissingChargeDetected'],
    created: '2024-05-01T08:00:00.000Z',
    currentStatus: 'Open',
    currentAssignee: null,
    comments: [],
    changelog: []
  }, overrides);
}

function test(name, fn) {
  try {
    fn();
    console.log('ok - ' + name);
  } catch (error) {
    console.error('not ok - ' + name);
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
  }
}

test('EXT-2029692 shape: assigned in under-dev before PAD is not a reversal', () => {
  const decision = evaluatePadReversal(activity({
    currentStatus: 'Under Dev',
    currentAssignee: 'Dev User',
    comments: [
      { body: 'PAD initiated for this charge', created: '2024-05-02T09:00:00.000+0000' }
    ],
    changelog: [
      {
        created: '2024-05-01T08:05:00.000+0000',
        items: [
          { field: 'status', fromString: 'Open', toString: 'Under Dev' },
          { field: 'assignee', fromString: null, toString: 'Dev User' }
        ]
      }
    ]
  }));
  assert.strictEqual(decision.isReversal, false);
  assert.strictEqual(decision.reason, 'under-dev-assignment-before-pad');
});

test('PAD comment before under-dev assignment is a reversal', () => {
  const decision = evaluatePadReversal(activity({
    labels: ['STATEMENTS_IN_PRODUCTION'],
    currentStatus: 'Under Dev',
    currentAssignee: 'Dev User',
    comments: [
      { body: 'PAD initiated', created: '2024-05-01T10:00:00.000Z' }
    ],
    changelog: [
      {
        created: '2024-05-01T12:00:00.000Z',
        items: [
          { field: 'status', fromString: 'Open', toString: 'Under-Dev' },
          { field: 'assignee', fromString: null, toString: 'Dev User' }
        ]
      }
    ]
  }));
  assert.strictEqual(decision.isReversal, true);
  assert.strictEqual(decision.reason, 'pad-before-under-dev-assignment');
});

test('assignee set while already under dev, after PAD, is a reversal', () => {
  const decision = evaluatePadReversal(activity({
    labels: ['Charge_Extracted_Twice'],
    currentStatus: 'UNDER_DEV',
    currentAssignee: 'Dev User',
    comments: [
      { body: 'please start PAD today', created: '2024-05-02T09:00:00.000Z' }
    ],
    changelog: [
      {
        created: '2024-05-03T12:00:00.000Z',
        items: [{ field: 'assignee', fromString: null, toString: 'Dev User' }]
      }
    ]
  }));
  assert.strictEqual(decision.isReversal, true);
});

test('created already assigned in under dev, with a later PAD comment, is not a reversal', () => {
  const decision = evaluatePadReversal(activity({
    currentStatus: 'Under Development',
    currentAssignee: 'Dev User',
    comments: [
      { body: 'PAD started', created: '2024-05-02T09:00:00.000Z' }
    ],
    changelog: []
  }));
  assert.strictEqual(decision.isReversal, false);
  assert.strictEqual(decision.reason, 'under-dev-assignment-before-pad');
});

test('each PAD label qualifies when the order is a reversal', () => {
  PAD_LABELS.forEach(label => {
    const decision = evaluatePadReversal(activity({
      labels: [label],
      currentStatus: 'Under Dev',
      currentAssignee: 'Dev User',
      comments: [{ body: 'PAD', created: '2024-05-01T09:00:00.000Z' }],
      changelog: [
        {
          created: '2024-05-01T11:00:00.000Z',
          items: [
            { field: 'Status', fromString: 'Open', toString: 'Under Dev' },
            { field: 'Assignee', fromString: null, toString: 'Dev User' }
          ]
        }
      ]
    }));
    assert.strictEqual(decision.isReversal, true, label);
  });
});

test('no PAD comment rejects the label', () => {
  const decision = evaluatePadReversal(activity({
    comments: [{ body: 'assigned to dev in under dev', created: '2024-05-01T09:00:00.000Z' }],
    changelog: [
      {
        created: '2024-05-01T12:00:00.000Z',
        items: [
          { field: 'status', fromString: 'Open', toString: 'Under Dev' },
          { field: 'assignee', fromString: null, toString: 'Dev User' }
        ]
      }
    ]
  }));
  assert.strictEqual(decision.isReversal, false);
  assert.strictEqual(decision.reason, 'missing-pad-comment');
});

test('no PAD label rejects the label even when comments and assignment order match', () => {
  const decision = evaluatePadReversal(activity({
    labels: ['Auto-Tag', 'PAD_REVERSAL', 'AFTER_CUTOFF'],
    comments: [{ body: 'PAD initiated', created: '2024-05-01T09:00:00.000Z' }],
    currentStatus: 'Under Dev',
    currentAssignee: 'Dev User',
    changelog: [
      {
        created: '2024-05-01T12:00:00.000Z',
        items: [{ field: 'status', fromString: 'Open', toString: 'Under Dev' }]
      }
    ]
  }));
  assert.strictEqual(decision.isReversal, false);
  assert.strictEqual(decision.reason, 'missing-pad-label');
});

test('PAD with no under-dev assignment is not a reversal', () => {
  const decision = evaluatePadReversal(activity({
    labels: ['OB_Missing'],
    comments: [{ body: 'PAD initiated', created: '2024-05-01T09:00:00.000Z' }],
    currentStatus: 'Open',
    currentAssignee: 'Someone',
    changelog: []
  }));
  assert.strictEqual(decision.isReversal, false);
  assert.strictEqual(decision.reason, 'missing-under-dev-assignment');
});

test('word padding is not a PAD comment', () => {
  const decision = evaluatePadReversal(activity({
    comments: [{ body: 'padding the timeline', created: '2024-05-01T09:00:00.000Z' }],
    currentStatus: 'Under Dev',
    currentAssignee: 'Dev User',
    changelog: [
      {
        created: '2024-05-01T12:00:00.000Z',
        items: [
          { field: 'status', fromString: 'Open', toString: 'Under Dev' },
          { field: 'assignee', fromString: null, toString: 'Dev User' }
        ]
      }
    ]
  }));
  assert.strictEqual(decision.isReversal, false);
  assert.strictEqual(decision.reason, 'missing-pad-comment');
});

test('PAD_REVERSAL inside a comment is not itself a PAD initiation comment', () => {
  const decision = evaluatePadReversal(activity({
    comments: [{ body: 'see the PAD_REVERSAL label', created: '2024-05-01T09:00:00.000Z' }]
  }));
  assert.strictEqual(decision.reason, 'missing-pad-comment');
});

test('ADF comment text counts as a PAD comment', () => {
  const decision = evaluatePadReversal(activity({
    labels: ['Transition'],
    currentStatus: 'Under Dev',
    currentAssignee: 'Dev User',
    comments: [{
      created: '2024-05-01T09:00:00.000Z',
      body: {
        type: 'doc',
        content: [{
          type: 'paragraph',
          content: [{ type: 'text', text: 'PAD already available' }]
        }]
      }
    }],
    changelog: [
      {
        created: '2024-05-01T12:00:00.000Z',
        items: [
          { field: 'status', fromString: 'Open', toString: 'Under Dev' },
          { field: 'assignee', fromString: null, toString: 'Dev User' }
        ]
      }
    ]
  }));
  assert.strictEqual(decision.isReversal, true);
});

test('newest-first changelog still uses the earliest under-dev assignment', () => {
  const decision = evaluatePadReversal(activity({
    comments: [{ body: 'PAD initiated', created: '2024-05-01T10:00:00.000Z' }],
    currentStatus: 'Open',
    currentAssignee: null,
    changelog: [
      {
        created: '2024-05-04T12:00:00.000Z',
        items: [
          { field: 'status', fromString: 'Under Dev', toString: 'Open' },
          { field: 'assignee', fromString: 'Dev User', toString: null }
        ]
      },
      {
        created: '2024-05-01T08:00:00.000Z',
        items: [
          { field: 'status', fromString: 'Open', toString: 'Under Dev' },
          { field: 'assignee', fromString: null, toString: 'Dev User' }
        ]
      }
    ]
  }));
  assert.strictEqual(decision.isReversal, false);
  assert.strictEqual(decision.reason, 'under-dev-assignment-before-pad');
});

test('equal PAD and assignment timestamps are not a reversal', () => {
  const decision = evaluatePadReversal(activity({
    comments: [{ body: 'PAD initiated', created: '2024-05-01T12:00:00.000Z' }],
    currentStatus: 'Under Dev',
    currentAssignee: 'Dev User',
    changelog: [
      {
        created: '2024-05-01T12:00:00.000Z',
        items: [
          { field: 'status', fromString: 'Open', toString: 'Under Dev' },
          { field: 'assignee', fromString: null, toString: 'Dev User' }
        ]
      }
    ]
  }));
  assert.strictEqual(decision.isReversal, false);
  assert.strictEqual(decision.reason, 'under-dev-assignment-before-pad');
});

test('earliest PAD comment is compared, not a later one', () => {
  const decision = evaluatePadReversal(activity({
    comments: [
      { body: 'follow up', created: '2024-05-01T08:30:00.000Z' },
      { body: 'PAD initiated', created: '2024-05-01T09:00:00.000Z' },
      { body: 'PAD still open', created: '2024-05-01T13:00:00.000Z' }
    ],
    currentStatus: 'Under Dev',
    currentAssignee: 'Dev User',
    changelog: [
      {
        created: '2024-05-01T12:00:00.000Z',
        items: [
          { field: 'status', fromString: 'Open', toString: 'Under Dev' },
          { field: 'assignee', fromString: null, toString: 'Dev User' }
        ]
      }
    ]
  }));
  assert.strictEqual(decision.isReversal, true);
});

test('unassigned value does not count as an assignee', () => {
  const decision = evaluatePadReversal(activity({
    currentStatus: 'Under Dev',
    currentAssignee: 'Unassigned',
    comments: [{ body: 'PAD initiated', created: '2024-05-01T09:00:00.000Z' }],
    changelog: []
  }));
  assert.strictEqual(decision.reason, 'missing-under-dev-assignment');
});

test('UnderDev status counts as under-dev', () => {
  const decision = evaluatePadReversal(activity({
    currentStatus: 'UnderDev',
    currentAssignee: null,
    comments: [{ body: 'PAD initiated', created: '2024-05-01T09:00:00.000Z' }],
    changelog: [
      {
        created: '2024-05-01T12:00:00.000Z',
        items: [{ field: 'assignee', fromString: null, toString: 'Dev User' }]
      }
    ]
  }));
  assert.strictEqual(decision.isReversal, true);
});

test('In Development is not under-dev', () => {
  const decision = evaluatePadReversal(activity({
    currentStatus: 'In Development',
    currentAssignee: 'Dev User',
    comments: [{ body: 'PAD initiated', created: '2024-05-01T09:00:00.000Z' }],
    changelog: []
  }));
  assert.strictEqual(decision.reason, 'missing-under-dev-assignment');
});

test('rejecting the PAD filter drops its labels and keeps labels from other filters', () => {
  const mapping = {
    '69584': { padReversalCheck: true },
    '37779': { padReversalCheck: false }
  };
  const result = labelsAfterRejectingPadReversal({
    sourceFilters: ['69584', '37779'],
    labelsToAdd: ['PAD_REVERSAL', 'Auto-Tag', 'AFTER_CUTOFF'],
    labelSources: {
      PAD_REVERSAL: ['69584'],
      'Auto-Tag': ['69584', '37779'],
      AFTER_CUTOFF: ['37779']
    }
  }, mapping);
  assert.deepEqual(result.labelsToAdd, ['Auto-Tag', 'AFTER_CUTOFF']);
  assert.deepEqual(result.labelSources['Auto-Tag'], ['37779']);
  assert.strictEqual(result.skip, false);
});

test('rejecting a PAD-only issue leaves no labels to add', () => {
  const result = labelsAfterRejectingPadReversal({
    sourceFilters: ['69584'],
    labelsToAdd: ['PAD_REVERSAL', 'Auto-Tag'],
    labelSources: {
      PAD_REVERSAL: ['69584'],
      'Auto-Tag': ['69584']
    }
  }, {
    '69584': { padReversalCheck: true }
  });
  assert.deepEqual(result.labelsToAdd, []);
  assert.strictEqual(result.skip, true);
});

test('a confirmed fresh ticket removes an existing PAD_REVERSAL label', () => {
  const resolved = resolvePadReversalUpdate({
    sourceFilters: ['69584'],
    labelsToAdd: ['PAD_REVERSAL', 'Auto-Tag'],
    labelSources: {
      PAD_REVERSAL: ['69584'],
      'Auto-Tag': ['69584']
    },
    fields: { labels: ['PAD_REVERSAL', 'MissingChargeDetected'] }
  }, { isReversal: false, checked: true }, {
    '69584': { padReversalCheck: true }
  });
  assert.deepEqual(resolved.labelsToAdd, []);
  assert.deepEqual(resolved.labelsToRemove, ['PAD_REVERSAL']);
  assert.strictEqual(resolved.skip, false);
});

test('an unverified PAD check does not remove an existing label', () => {
  const resolved = resolvePadReversalUpdate({
    sourceFilters: ['69584'],
    labelsToAdd: ['PAD_REVERSAL', 'Auto-Tag'],
    labelSources: {
      PAD_REVERSAL: ['69584'],
      'Auto-Tag': ['69584']
    },
    fields: { labels: ['PAD_REVERSAL'] }
  }, { isReversal: false, checked: false }, {
    '69584': { padReversalCheck: true }
  });
  assert.deepEqual(resolved.labelsToRemove, []);
  assert.strictEqual(resolved.skip, true);
});

test('a real reversal keeps PAD_REVERSAL and does not remove it', () => {
  const resolved = resolvePadReversalUpdate({
    sourceFilters: ['69584'],
    labelsToAdd: ['PAD_REVERSAL', 'Auto-Tag'],
    labelSources: {
      PAD_REVERSAL: ['69584'],
      'Auto-Tag': ['69584']
    },
    fields: { labels: ['MissingChargeDetected'] }
  }, { isReversal: true, checked: true }, {
    '69584': { padReversalCheck: true }
  });
  assert.deepEqual(resolved.labelsToAdd, ['PAD_REVERSAL', 'Auto-Tag']);
  assert.deepEqual(resolved.labelsToRemove, []);
  assert.strictEqual(resolved.skip, false);
});

test('labeler source does not embed Jira credentials', () => {
  const source = fs.readFileSync(path.join(__dirname, 'JiraLabeler.gs'), 'utf8');
  assert.strictEqual(source.includes('ATATT'), false);
  assert.strictEqual(source.includes('sowmiya.kirubakaran'), false);
  assert.strictEqual(source.includes('JIRA_API_TOKEN = "'), false);
});

if (process.exitCode) {
  process.exit(process.exitCode);
}
