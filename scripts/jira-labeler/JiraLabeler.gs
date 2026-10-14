/**
 * Add labels and comments to Jira issues from multiple filters.
 * PAD_REVERSAL (filter 69584) is applied only when PadReversal.gs confirms
 * the ticket is a real reversal. Load PadReversal.gs in the same Apps Script project.
 *
 * Credentials live in Script Properties, not in source:
 * JIRA_EMAIL, JIRA_API_TOKEN, and optional JIRA_BASE_URL.
 */

var FILTER_LABEL_MAPPING = {
  '37779': {
    labels: ['AFTER_CUTOFF', 'Auto-Tag'],
    addComment: false
  },
  '40696': {
    labels: ['AFTER_CUTOFF', 'Auto-Tag'],
    addComment: false
  },
  '40798': {
    labels: ['AFTER_CUTOFF', 'Auto-Tag'],
    addComment: false
  },
  '42613': {
    labels: ['REVERSAL', 'Auto-Tag'],
    addComment: false
  },
  '42958': {
    labels: ['REVERSAL-FIX', 'Auto-Tag'],
    addComment: false
  },
  '44744': {
    labels: ['RevisedDueRequested-DC/Dep', 'Auto-Tag'],
    addComment: true,
    commentText: 'Dependent ticket / DC has be closed, please updated the revised due date as per the SLA.'
  },
  '69544': {
    labels: ['TRANSITIONED-DEV', 'Auto-Tag'],
    addComment: false
  },
  '69545': {
    labels: ['RESOLVED-TRANSITIONED-DEV', 'Auto-Tag'],
    addComment: false
  },
  '69583': {
    labels: ['AFTER_CUTOFF_WITH_REVISED_DUE', 'Auto-Tag'],
    addComment: false
  },
  '69584': {
    labels: ['PAD_REVERSAL', 'Auto-Tag'],
    addComment: false,
    padReversalCheck: true
  }
};

function addLabelsFromMultipleFilters() {
  const auth = getJiraAuthConfig();
  const JIRA_BASE_URLTest = auth.baseUrl;
  const JIRA_EMAIL = auth.email;
  const JIRA_API_TOKEN = auth.apiToken;
  const MAX_RETRIES = 3;

  try {
    Logger.log('Starting label update process for ' + Object.keys(FILTER_LABEL_MAPPING).length + ' filters');

    const allIssues = new Map();
    const processedFilters = [];
    const failedFilters = [];
    const filterStats = {};

    Object.entries(FILTER_LABEL_MAPPING).forEach(([filterId, config], index) => {
      Logger.log(
        'Processing filter ' + (index + 1) + '/' + Object.keys(FILTER_LABEL_MAPPING).length +
        ': ' + filterId + ' with labels: ' + config.labels.join(', ') +
        (config.addComment ? ' and comment' : '') +
        (config.padReversalCheck ? ' (PAD reversal check)' : '')
      );

      try {
        const filterJson = getJiraFilterWithRetry(JIRA_BASE_URLTest, JIRA_EMAIL, JIRA_API_TOKEN, filterId, MAX_RETRIES);
        if (!filterJson) {
          Logger.log('Failed to fetch filter ' + filterId + ' after ' + MAX_RETRIES + ' retries, skipping...');
          failedFilters.push(filterId);
          return;
        }

        const filterData = JSON.parse(filterJson);
        const jql = filterData.jql;
        Logger.log('Filter ' + filterId + ' JQL: ' + jql);

        const issues = collectJiraIssuesFromJqlWithRetry(JIRA_BASE_URLTest, JIRA_EMAIL, JIRA_API_TOKEN, jql, MAX_RETRIES);
        Logger.log('Filter ' + filterId + ' found ' + issues.length + ' issues');

        issues.forEach(issue => {
          if (allIssues.has(issue.key)) {
            const existingIssue = allIssues.get(issue.key);
            mergeFilterLabels(existingIssue, config.labels, filterId);
            existingIssue.sourceFilters.push(filterId);
            if (config.addComment) {
              existingIssue.addComment = true;
              existingIssue.commentText = config.commentText;
            }
          } else {
            allIssues.set(issue.key, Object.assign({}, issue, {
              labelsToAdd: config.labels.slice(),
              labelSources: labelSourcesFor(config.labels, filterId),
              sourceFilters: [filterId],
              addComment: config.addComment || false,
              commentText: config.commentText || null
            }));
          }
        });

        processedFilters.push(filterId);
        filterStats[filterId] = {
          issuesFound: issues.length,
          labelsToAdd: config.labels,
          addComment: config.addComment
        };
      } catch (error) {
        Logger.log('Error processing filter ' + filterId + ': ' + error.toString());
        failedFilters.push(filterId);
      }
    });

    const uniqueIssues = Array.from(allIssues.values());
    Logger.log('Total unique issues found across all filters: ' + uniqueIssues.length);
    Logger.log('Successfully processed filters: ' + processedFilters.join(', '));
    if (failedFilters.length > 0) {
      Logger.log('Failed filters: ' + failedFilters.join(', '));
    }

    Object.entries(filterStats).forEach(([filterId, stats]) => {
      Logger.log(
        'Filter ' + filterId + ': ' + stats.issuesFound + ' issues, labels: ' +
        stats.labelsToAdd.join(', ') + (stats.addComment ? ', with comment' : '')
      );
    });

    if (uniqueIssues.length === 0) {
      Logger.log('No issues found to update');
      return;
    }

    let successCount = 0;
    let failureCount = 0;
    let commentSuccessCount = 0;
    let commentFailureCount = 0;
    let padReversalApplied = 0;
    let padReversalRejected = 0;

    uniqueIssues.forEach((issue, index) => {
      Logger.log(
        'Updating issue ' + (index + 1) + '/' + uniqueIssues.length + ': ' + issue.key +
        ' (from filters: ' + issue.sourceFilters.join(', ') + ') with labels: ' + issue.labelsToAdd.join(', ')
      );

      try {
        let labelsToRemove = [];

        if (issueHasGatedPadReversal(issue)) {
          const decision = decidePadReversal(JIRA_BASE_URLTest, JIRA_EMAIL, JIRA_API_TOKEN, issue, MAX_RETRIES);
          Logger.log(
            'PAD reversal check for ' + issue.key + ': ' + decision.reason +
            ' (pad ' + formatPadTime(decision.padCommentTime) +
            ', under-dev assignment ' + formatPadTime(decision.underDevAssignmentTime) + ')'
          );

          const resolved = resolvePadReversalUpdate(issue, decision, FILTER_LABEL_MAPPING);
          issue.labelsToAdd = resolved.labelsToAdd;
          issue.labelSources = resolved.labelSources;
          labelsToRemove = resolved.labelsToRemove;

          if (decision.isReversal) {
            padReversalApplied++;
          } else {
            padReversalRejected++;
            if (labelsToRemove.length > 0) {
              Logger.log('Removing incorrect ' + PAD_REVERSAL_LABEL + ' from ' + issue.key);
            }
            if (resolved.skip) {
              Logger.log('No label changes for ' + issue.key + ' after PAD reversal check (' + decision.reason + ')');
              return;
            }
          }
        }

        const labelSuccess = updateIssueLabelsWithRetry(
          JIRA_BASE_URLTest,
          JIRA_EMAIL,
          JIRA_API_TOKEN,
          issue.key,
          issue.fields.labels,
          issue.labelsToAdd,
          MAX_RETRIES,
          labelsToRemove
        );

        if (labelSuccess) {
          successCount++;
          if (issue.addComment && issue.commentText) {
            Logger.log('Adding comment to ' + issue.key + ': ' + issue.commentText);
            const commentSuccess = addJiraCommentRobust(
              JIRA_BASE_URLTest,
              JIRA_EMAIL,
              JIRA_API_TOKEN,
              issue.key,
              issue.commentText,
              MAX_RETRIES
            );
            Logger.log('Comment for ' + issue.key + ' success? ' + commentSuccess);
            if (commentSuccess) {
              commentSuccessCount++;
            } else {
              commentFailureCount++;
            }
          }
        } else {
          failureCount++;
        }
      } catch (error) {
        Logger.log('Error updating ' + issue.key + ': ' + error.toString());
        failureCount++;
      }
    });

    Logger.log('Completed processing ' + uniqueIssues.length + ' unique issues from ' + Object.keys(FILTER_LABEL_MAPPING).length + ' filters');
    Logger.log('Labels - Successfully updated: ' + successCount + ', Failed: ' + failureCount);
    Logger.log('Comments - Successfully added: ' + commentSuccessCount + ', Failed: ' + commentFailureCount);
    Logger.log('PAD reversal - Applied: ' + padReversalApplied + ', Rejected: ' + padReversalRejected);
  } catch (error) {
    Logger.log('Error in addLabelsFromMultipleFilters: ' + error.toString());
    throw error;
  }
}

function getJiraAuthConfig() {
  const props = PropertiesService.getScriptProperties();
  const baseUrl = props.getProperty('JIRA_BASE_URL') || 'https://arcadiapower.atlassian.net';
  const email = props.getProperty('JIRA_EMAIL');
  const apiToken = props.getProperty('JIRA_API_TOKEN');
  if (!email || !apiToken) {
    throw new Error('Set JIRA_EMAIL and JIRA_API_TOKEN in Script Properties');
  }
  return {
    baseUrl: baseUrl,
    email: email,
    apiToken: apiToken
  };
}

function labelSourcesFor(labels, filterId) {
  const sources = {};
  labels.forEach(label => {
    sources[label] = [filterId];
  });
  return sources;
}

function mergeFilterLabels(existingIssue, labels, filterId) {
  labels.forEach(label => {
    if (existingIssue.labelsToAdd.indexOf(label) === -1) {
      existingIssue.labelsToAdd.push(label);
    }
    if (!existingIssue.labelSources[label]) {
      existingIssue.labelSources[label] = [];
    }
    if (existingIssue.labelSources[label].indexOf(filterId) === -1) {
      existingIssue.labelSources[label].push(filterId);
    }
  });
}

function issueHasGatedPadReversal(issue) {
  const sources = issue.labelSources && issue.labelSources[PAD_REVERSAL_LABEL]
    ? issue.labelSources[PAD_REVERSAL_LABEL]
    : [];
  return sources.some(filterId => FILTER_LABEL_MAPPING[filterId] && FILTER_LABEL_MAPPING[filterId].padReversalCheck);
}

/**
 * Fetch comments and changelog, then decide. checked is false when the
 * history could not be read completely, so an existing label is left alone.
 */
function decidePadReversal(baseUrl, email, apiToken, issue, maxRetries) {
  try {
    const activity = getJiraIssueActivityWithRetry(baseUrl, email, apiToken, issue.key, maxRetries);
    if (!activity) {
      return { isReversal: false, checked: false, reason: 'activity-unavailable', padCommentTime: null, underDevAssignmentTime: null };
    }
    issue.fields = issue.fields || {};
    issue.fields.labels = activity.labels || [];
    if (!activity.historyComplete || !activity.commentsComplete) {
      return { isReversal: false, checked: false, reason: 'incomplete-issue-history', padCommentTime: null, underDevAssignmentTime: null };
    }
    return Object.assign({ checked: true }, evaluatePadReversal(activity));
  } catch (error) {
    return {
      isReversal: false,
      checked: false,
      reason: 'activity-check-failed',
      padCommentTime: null,
      underDevAssignmentTime: null
    };
  }
}

function formatPadTime(ms) {
  if (ms == null) return 'n/a';
  return new Date(ms).toISOString();
}

function addJiraCommentRobust(baseUrl, email, apiToken, issueKey, commentText, maxRetries) {
  let attempt = 0;

  while (attempt < maxRetries) {
    attempt++;
    try {
      Logger.log('Attempt ' + attempt + '/' + maxRetries + ' to add comment to ' + issueKey);
      const success = addJiraComment(baseUrl, email, apiToken, issueKey, commentText);
      if (success) {
        return true;
      }
      if (attempt < maxRetries) {
        Logger.log('Waiting before retry for comment on ' + issueKey + '...');
        Utilities.sleep(1000 * attempt);
      }
    } catch (error) {
      Logger.log('Attempt ' + attempt + ' failed for comment on ' + issueKey + ': ' + error.toString());
      if (attempt < maxRetries) {
        Logger.log('Waiting before retry for comment on ' + issueKey + '...');
        Utilities.sleep(1000 * attempt);
      }
    }
  }

  Logger.log('All ' + maxRetries + ' attempts failed for comment on ' + issueKey);
  return false;
}

function addJiraComment(baseUrl, email, apiToken, issueKey, commentText) {
  if (!issueKey) {
    throw new Error('Issue key is required');
  }
  if (!commentText || commentText.trim() === '') {
    Logger.log('No comment text provided for ' + issueKey);
    return true;
  }

  try {
    const url = baseUrl + '/rest/api/2/issue/' + issueKey + '/comment';
    const headers = jiraHeaders(email, apiToken, true);
    const payload = { body: commentText };
    const response = UrlFetchApp.fetch(url, {
      method: 'post',
      headers: headers,
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });

    const responseCode = response.getResponseCode();
    Logger.log('Comment response for ' + issueKey + ': ' + responseCode);
    if (responseCode === 200 || responseCode === 201) {
      return true;
    }
    Logger.log('Failed to add comment to ' + issueKey + ': ' + response.getContentText());
    return false;
  } catch (error) {
    Logger.log('Error adding comment to ' + issueKey + ': ' + error.toString());
    throw error;
  }
}

function getJiraFilterWithRetry(baseUrl, email, apiToken, filterId, maxRetries) {
  let attempt = 0;
  let lastError = null;

  while (attempt < maxRetries) {
    attempt++;
    try {
      Logger.log('Attempt ' + attempt + '/' + maxRetries + ' to fetch filter ' + filterId);
      const result = getJiraFilter(baseUrl, email, apiToken, filterId);
      if (result) {
        return result;
      }
      if (attempt < maxRetries) {
        Logger.log('Waiting before retry for filter ' + filterId + '...');
        Utilities.sleep(1000 * attempt);
      }
    } catch (error) {
      lastError = error;
      Logger.log('Attempt ' + attempt + ' failed for filter ' + filterId + ': ' + error.toString());
      if (attempt < maxRetries) {
        Logger.log('Waiting before retry for filter ' + filterId + '...');
        Utilities.sleep(1000 * attempt);
      }
    }
  }

  Logger.log('All ' + maxRetries + ' attempts failed for filter ' + filterId);
  if (lastError) {
    throw lastError;
  }
  return null;
}

function getJiraFilter(baseUrl, email, apiToken, filterId) {
  if (!filterId) {
    throw new Error('Filter ID is required');
  }

  const url = baseUrl + '/rest/api/2/filter/' + filterId;
  try {
    const response = UrlFetchApp.fetch(url, {
      method: 'get',
      headers: jiraHeaders(email, apiToken, false),
      muteHttpExceptions: true
    });

    if (response.getResponseCode() !== 200) {
      Logger.log('Failed to fetch filter ' + filterId + '. Response code: ' + response.getResponseCode() + ', Content: ' + response.getContentText());
      return null;
    }
    return response.getContentText();
  } catch (error) {
    Logger.log('Error fetching filter ' + filterId + ': ' + error.toString());
    throw error;
  }
}

function collectJiraIssuesFromJqlWithRetry(baseUrl, email, apiToken, jql, maxRetries) {
  let attempt = 0;
  let lastError = null;

  while (attempt < maxRetries) {
    attempt++;
    try {
      Logger.log('Attempt ' + attempt + '/' + maxRetries + ' to search with JQL');
      const result = collectJiraIssuesFromJql(baseUrl, email, apiToken, jql);
      if (result && result.length >= 0) {
        return result;
      }
      if (attempt < maxRetries) {
        Logger.log('Waiting before retry for JQL search...');
        Utilities.sleep(1000 * attempt);
      }
    } catch (error) {
      lastError = error;
      Logger.log('Attempt ' + attempt + ' failed for JQL search: ' + error.toString());
      if (attempt < maxRetries) {
        Logger.log('Waiting before retry for JQL search...');
        Utilities.sleep(1000 * attempt);
      }
    }
  }

  Logger.log('All ' + maxRetries + ' attempts failed for JQL search');
  if (lastError) {
    throw lastError;
  }
  return [];
}

function collectJiraIssuesFromJql(baseUrl, email, apiToken, jql) {
  if (!jql || jql.trim() === '') {
    throw new Error('JQL query is required');
  }

  const issues = [];
  let startAt = 0;
  const maxResults = 100;
  let hasMoreResults = true;
  const escapedJql = jql.trim();

  while (hasMoreResults) {
    try {
      const encodedJql = encodeURIComponent(escapedJql);
      const url = baseUrl + '/rest/api/2/search/jql?jql=' + encodedJql + '&fields=labels&maxResults=' + maxResults + '&startAt=' + startAt;
      const response = UrlFetchApp.fetch(url, {
        method: 'get',
        headers: jiraHeaders(email, apiToken, false),
        muteHttpExceptions: true
      });

      if (response.getResponseCode() !== 200) {
        Logger.log('JIRA API failed. Response code: ' + response.getResponseCode() + ', Content: ' + response.getContentText());
        break;
      }

      const responseText = response.getContentText();
      if (!responseText) {
        Logger.log('Empty response from JIRA API');
        break;
      }

      const jsonObject = JSON.parse(responseText);
      const issuesArray = jsonObject.issues || [];
      issuesArray.forEach(issue => {
        issues.push(issue);
      });

      const total = jsonObject.total || 0;
      const currentCount = startAt + issuesArray.length;
      if (currentCount >= total || issuesArray.length < maxResults) {
        hasMoreResults = false;
      } else {
        startAt += maxResults;
      }
    } catch (error) {
      Logger.log('Error executing JIRA query: ' + error.toString());
      hasMoreResults = false;
    }
  }

  return issues;
}

function updateIssueLabelsWithRetry(baseUrl, email, apiToken, issueKey, currentLabels, labelsToAdd, maxRetries, labelsToRemove) {
  let attempt = 0;

  while (attempt < maxRetries) {
    attempt++;
    try {
      const success = updateIssueLabels(baseUrl, email, apiToken, issueKey, currentLabels, labelsToAdd, labelsToRemove);
      if (success) {
        return true;
      }
      if (attempt < maxRetries) {
        Logger.log('Waiting before retry for ' + issueKey + '...');
        Utilities.sleep(1000 * attempt);
      }
    } catch (error) {
      Logger.log('Attempt ' + attempt + ' failed for ' + issueKey + ': ' + error.toString());
      if (attempt < maxRetries) {
        Logger.log('Waiting before retry for ' + issueKey + '...');
        Utilities.sleep(1000 * attempt);
      }
    }
  }

  Logger.log('All ' + maxRetries + ' attempts failed for ' + issueKey);
  return false;
}

function updateIssueLabels(baseUrl, email, apiToken, issueKey, currentLabels, labelsToAdd, labelsToRemove) {
  if (!issueKey) {
    throw new Error('Issue key is required');
  }

  const additions = labelsToAdd || [];
  const removals = labelsToRemove || [];
  if (additions.length === 0 && removals.length === 0) {
    Logger.log('No labels to add for ' + issueKey);
    return true;
  }

  try {
    const url = baseUrl + '/rest/api/2/issue/' + issueKey;
    const original = currentLabels || [];
    const removalSet = {};
    removals.forEach(label => {
      removalSet[label] = true;
    });
    const kept = original.filter(label => !removalSet[label]);
    const updatedLabels = Array.from(new Set(kept.concat(additions)));

    if (sameLabelSet(original, updatedLabels)) {
      Logger.log('No new labels to add for ' + issueKey);
      return true;
    }

    const payload = {
      fields: {
        labels: updatedLabels
      }
    };
    const response = UrlFetchApp.fetch(url, {
      method: 'put',
      headers: jiraHeaders(email, apiToken, true),
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });

    const responseCode = response.getResponseCode();
    Logger.log('Response for ' + issueKey + ': ' + responseCode);
    if (responseCode === 200 || responseCode === 204) {
      return true;
    }
    Logger.log('Failed to update ' + issueKey + ': ' + response.getContentText());
    return false;
  } catch (error) {
    Logger.log('Error updating ' + issueKey + ': ' + error.toString());
    throw error;
  }
}

function sameLabelSet(left, right) {
  if (left.length !== right.length) return false;
  const seen = {};
  right.forEach(label => {
    seen[label] = true;
  });
  return left.every(label => seen[label]);
}

function getJiraIssueActivityWithRetry(baseUrl, email, apiToken, issueKey, maxRetries) {
  let attempt = 0;
  let lastError = null;

  while (attempt < maxRetries) {
    attempt++;
    try {
      Logger.log('Attempt ' + attempt + '/' + maxRetries + ' to read activity for ' + issueKey);
      return getJiraIssueActivity(baseUrl, email, apiToken, issueKey);
    } catch (error) {
      lastError = error;
      Logger.log('Attempt ' + attempt + ' failed for activity on ' + issueKey + ': ' + error.toString());
      if (attempt < maxRetries) {
        Utilities.sleep(1000 * attempt);
      }
    }
  }

  Logger.log('All ' + maxRetries + ' attempts failed for activity on ' + issueKey);
  if (lastError) {
    throw lastError;
  }
  return null;
}

function getJiraIssueActivity(baseUrl, email, apiToken, issueKey) {
  const issueUrl = baseUrl + '/rest/api/2/issue/' + encodeURIComponent(issueKey) + '?fields=labels,status,assignee,created';
  const issueJson = jiraGetJson(email, apiToken, issueUrl);
  const fields = issueJson.fields || {};
  const commentPage = fetchAllJiraPages(baseUrl, email, apiToken, '/rest/api/2/issue/' + encodeURIComponent(issueKey) + '/comment', 'comments');
  const historyPage = fetchAllJiraPages(baseUrl, email, apiToken, '/rest/api/2/issue/' + encodeURIComponent(issueKey) + '/changelog', 'values');
  const assignee = fields.assignee;

  return {
    labels: fields.labels || [],
    created: fields.created || null,
    currentStatus: fields.status ? fields.status.name : null,
    currentAssignee: assignee ? (assignee.displayName || assignee.name || null) : null,
    comments: commentPage.items.map(comment => ({
      body: comment.body,
      created: comment.created
    })),
    changelog: historyPage.items.map(history => ({
      created: history.created,
      items: (history.items || []).map(item => ({
        field: item.field,
        fromString: item.fromString,
        toString: item.toString
      }))
    })),
    commentsComplete: commentPage.complete,
    historyComplete: historyPage.complete
  };
}

function fetchAllJiraPages(baseUrl, email, apiToken, path, valuesKey) {
  const items = [];
  let startAt = 0;
  const maxResults = 100;
  const maxPages = 50;

  for (let page = 0; page < maxPages; page++) {
    const joiner = path.indexOf('?') >= 0 ? '&' : '?';
    const url = baseUrl + path + joiner + 'startAt=' + startAt + '&maxResults=' + maxResults;
    const json = jiraGetJson(email, apiToken, url);
    const batch = json[valuesKey] || [];
    batch.forEach(item => items.push(item));

    const total = typeof json.total === 'number' ? json.total : null;
    const finished = json.isLast === true ||
      batch.length === 0 ||
      (total != null && startAt + batch.length >= total) ||
      batch.length < maxResults;
    if (finished) {
      return { items: items, complete: true };
    }
    startAt += batch.length;
  }

  return { items: items, complete: false };
}

function jiraGetJson(email, apiToken, url) {
  const response = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: jiraHeaders(email, apiToken, false),
    muteHttpExceptions: true
  });
  const responseCode = response.getResponseCode();
  if (responseCode !== 200) {
    throw new Error('Jira GET failed with ' + responseCode);
  }
  const text = response.getContentText();
  if (!text) {
    throw new Error('Empty response from Jira');
  }
  return JSON.parse(text);
}

function jiraHeaders(email, apiToken, jsonBody) {
  const headers = {
    Authorization: 'Basic ' + Utilities.base64Encode(email + ':' + apiToken),
    Accept: 'application/json'
  };
  if (jsonBody) {
    headers['Content-Type'] = 'application/json';
  }
  return headers;
}
