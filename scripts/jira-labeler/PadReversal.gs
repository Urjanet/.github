/**
 * PAD_REVERSAL is only a reversal when all of the following are true:
 * 1. The issue already has a PAD label:
 *    MissingChargeDetected, STATEMENTS_IN_PRODUCTION, Charge_Extracted_Twice,
 *    OB_Missing, or Transition.
 * 2. A comment shows PAD was already initiated.
 * 3. The issue was assigned to a developer while in an under-dev status
 *    AFTER that PAD comment.
 *
 * The reverse order is a fresh ticket: it was assigned in under-dev first and
 * PAD was initiated later. Missing PAD comments or missing PAD labels also
 * mean PAD_REVERSAL must not be added.
 *
 * This file is loaded as a sibling script in the Apps Script project.
 * Function declarations are global there. Node tests evaluate this file in a vm.
 */

var PAD_REVERSAL_LABEL = 'PAD_REVERSAL';

var PAD_RELATED_LABELS = [
  'MissingChargeDetected',
  'STATEMENTS_IN_PRODUCTION',
  'Charge_Extracted_Twice',
  'OB_Missing',
  'Transition'
];

/**
 * @param {Object} activity labels, created, currentStatus, currentAssignee, comments, changelog
 * @return {{isReversal: boolean, reason: string, padCommentTime: ?number, underDevAssignmentTime: ?number}}
 */
function evaluatePadReversal(activity) {
  var labels = activity && activity.labels ? activity.labels : [];
  var padCommentTime = padReversalEarliestCommentTime(activity && activity.comments ? activity.comments : []);
  var underDevAssignmentTime = padReversalEarliestUnderDevAssignment(activity || {});

  if (!padReversalHasRelatedLabel(labels)) {
    return padReversalDecision(false, 'missing-pad-label', padCommentTime, underDevAssignmentTime);
  }
  if (padCommentTime == null) {
    return padReversalDecision(false, 'missing-pad-comment', padCommentTime, underDevAssignmentTime);
  }
  if (underDevAssignmentTime == null) {
    return padReversalDecision(false, 'missing-under-dev-assignment', padCommentTime, underDevAssignmentTime);
  }
  if (padCommentTime < underDevAssignmentTime) {
    return padReversalDecision(true, 'pad-before-under-dev-assignment', padCommentTime, underDevAssignmentTime);
  }
  return padReversalDecision(false, 'under-dev-assignment-before-pad', padCommentTime, underDevAssignmentTime);
}

/**
 * Turn a PAD reversal decision into the label add/remove set for one issue.
 * A confirmed non-reversal removes an existing PAD_REVERSAL label.
 * An unverified check (checked false) does not remove a label already on the issue.
 */
function resolvePadReversalUpdate(issue, decision, filterMapping) {
  if (decision && decision.isReversal) {
    return {
      labelsToAdd: (issue.labelsToAdd || []).slice(),
      labelSources: issue.labelSources || {},
      labelsToRemove: [],
      skip: false
    };
  }

  var stripped = labelsAfterRejectingPadReversal(issue, filterMapping);
  var labelsToRemove = [];
  if (decision && decision.checked) {
    var current = issue.fields && issue.fields.labels ? issue.fields.labels : [];
    if (current.indexOf(PAD_REVERSAL_LABEL) !== -1) {
      labelsToRemove.push(PAD_REVERSAL_LABEL);
    }
  }

  return {
    labelsToAdd: stripped.labelsToAdd,
    labelSources: stripped.labelSources,
    labelsToRemove: labelsToRemove,
    skip: stripped.labelsToAdd.length === 0 && labelsToRemove.length === 0
  };
}

/**
 * Drop labels that came only from filters flagged padReversalCheck.
 * Labels also contributed by another filter stay, with those other sources kept.
 */
function labelsAfterRejectingPadReversal(issue, filterMapping) {
  var gated = {};
  var sourceFilters = issue && issue.sourceFilters ? issue.sourceFilters : [];
  sourceFilters.forEach(function(filterId) {
    if (filterMapping[filterId] && filterMapping[filterId].padReversalCheck) {
      gated[filterId] = true;
    }
  });

  var labelsToAdd = [];
  var labelSources = {};
  var requested = issue && issue.labelsToAdd ? issue.labelsToAdd : [];
  requested.forEach(function(label) {
    var sources = issue.labelSources && issue.labelSources[label] ? issue.labelSources[label] : [];
    var remaining = sources.filter(function(filterId) {
      return !gated[filterId];
    });
    if (remaining.length > 0) {
      labelsToAdd.push(label);
      labelSources[label] = remaining;
    }
  });

  return {
    labelsToAdd: labelsToAdd,
    labelSources: labelSources,
    skip: labelsToAdd.length === 0
  };
}

function padReversalDecision(isReversal, reason, padCommentTime, underDevAssignmentTime) {
  return {
    isReversal: isReversal,
    reason: reason,
    padCommentTime: padCommentTime,
    underDevAssignmentTime: underDevAssignmentTime
  };
}

function padReversalHasRelatedLabel(labels) {
  return labels.some(function(label) {
    return PAD_RELATED_LABELS.indexOf(label) !== -1;
  });
}

function padReversalEarliestCommentTime(comments) {
  var earliest = null;
  comments.forEach(function(comment) {
    if (!comment || !padReversalIsPadComment(comment.body)) {
      return;
    }
    var at = padReversalParseTime(comment.created);
    if (at == null) {
      return;
    }
    if (earliest == null || at < earliest) {
      earliest = at;
    }
  });
  return earliest;
}

/**
 * Earliest moment the issue was in an under-dev status and had an assignee.
 * Issue create time counts when it was created already in that state.
 * Changelog may arrive newest-first; it is sorted before walking.
 */
function padReversalEarliestUnderDevAssignment(activity) {
  var histories = padReversalSortHistories(activity.changelog || []);
  var status = padReversalInitialField(histories, 'status', activity.currentStatus);
  var assignee = padReversalInitialField(histories, 'assignee', activity.currentAssignee);
  var earliest = null;

  if (padReversalIsUnderDevStatus(status) && padReversalHasAssignee(assignee)) {
    earliest = padReversalParseTime(activity.created);
  }

  histories.forEach(function(history) {
    var at = padReversalParseTime(history.created);
    var nextStatus = status;
    var nextAssignee = assignee;
    var changed = false;

    (history.items || []).forEach(function(item) {
      var field = String(item.field || '').toLowerCase();
      if (field === 'status') {
        nextStatus = item.toString;
        changed = true;
      } else if (field === 'assignee') {
        nextAssignee = item.toString;
        changed = true;
      }
    });

    var wasAssignedUnderDev = padReversalIsUnderDevStatus(status) && padReversalHasAssignee(assignee);
    var nowAssignedUnderDev = padReversalIsUnderDevStatus(nextStatus) && padReversalHasAssignee(nextAssignee);
    if (changed && !wasAssignedUnderDev && nowAssignedUnderDev && at != null) {
      if (earliest == null || at < earliest) {
        earliest = at;
      }
    }

    status = nextStatus;
    assignee = nextAssignee;
  });

  return earliest;
}

function padReversalInitialField(histories, fieldName, currentValue) {
  for (var i = 0; i < histories.length; i++) {
    var items = histories[i].items || [];
    for (var j = 0; j < items.length; j++) {
      if (String(items[j].field || '').toLowerCase() === fieldName) {
        return items[j].fromString == null ? null : items[j].fromString;
      }
    }
  }
  return currentValue == null ? null : currentValue;
}

function padReversalSortHistories(histories) {
  return histories.slice().sort(function(a, b) {
    var aTime = padReversalParseTime(a.created);
    var bTime = padReversalParseTime(b.created);
    if (aTime == null && bTime == null) return 0;
    if (aTime == null) return 1;
    if (bTime == null) return -1;
    return aTime - bTime;
  });
}

function padReversalIsUnderDevStatus(status) {
  if (status == null) return false;
  var normalized = String(status).toLowerCase().replace(/[_/-]+/g, ' ').replace(/\s+/g, ' ').trim();
  var squashed = normalized.replace(/ /g, '');
  return normalized.indexOf('under dev') !== -1 || squashed.indexOf('underdev') === 0;
}

function padReversalHasAssignee(value) {
  if (value == null) return false;
  var text = String(value).trim();
  return text !== '' && text.toLowerCase() !== 'unassigned';
}

function padReversalIsPadComment(body) {
  return /\bPAD\b/i.test(padReversalCommentText(body));
}

function padReversalCommentText(body) {
  if (body == null) return '';
  if (typeof body === 'string') return body;
  var parts = [];
  padReversalCollectText(body, parts);
  return parts.join(' ');
}

function padReversalCollectText(node, parts) {
  if (node == null) return;
  if (typeof node === 'string') {
    parts.push(node);
    return;
  }
  if (Object.prototype.toString.call(node) === '[object Array]') {
    node.forEach(function(child) {
      padReversalCollectText(child, parts);
    });
    return;
  }
  if (typeof node === 'object') {
    if (typeof node.text === 'string') {
      parts.push(node.text);
    }
    if (node.content) {
      padReversalCollectText(node.content, parts);
    }
  }
}

function padReversalParseTime(value) {
  if (value == null || value === '') return null;
  var ms = Date.parse(value);
  return isNaN(ms) ? null : ms;
}
