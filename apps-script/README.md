# Ticket sync and On Hold transition

Google Apps Script that pulls issues from a Jira-style REST API into a Google Sheet, calculates whether each customer alias is inactive, and transitions those tickets to **On Hold**.

The script is container-friendly: bind it to the spreadsheet with **Extensions > Apps Script**. `TicketLogic.js` holds the mapping, formula, and request logic. `Code.gs` talks to Sheets and `UrlFetchApp`.

## Sheet

| Column | Header | Written by |
| --- | --- | --- |
| A | Key | Sync |
| B | Summary | Sync |
| C | Catalyst (migrated) | Sync |
| D | Status | Sync, then updated after a successful transition |
| E | Assignee | Sync |
| F | Search Template | Sync |
| G | Reporter | Sync |
| H | Created | Sync (ISO timestamps become real dates) |
| I | Customer Alias | Sync |
| J | Active Status | Formula, one per populated row |
| L | Inactive aliases | You. The script never clears this column |

Column J for row 2:

```text
=IF(I2 = "", "", IF(ISNUMBER(MATCH(I2, L:L, 0)), "InActive", "Active"))
```

The same formula is filled down for every ticket row on each sync. `MATCH` searches all of column L, so a header in L1 must not be a real customer alias.

`main()` writes the rows, calls `SpreadsheetApp.flush()` so column J calculates, then reads columns A, D, and J in one batch. A row is transitioned when Active Status is `InActive` (any capitalization) and Status is not already `On Hold`.

## Install

1. Open the spreadsheet. Choose **Extensions > Apps Script**.
2. Add a script file named `Code` and paste `Code.gs`.
3. Add a script file named `TicketLogic` and paste `TicketLogic.js`.
4. Replace `appsscript.json` with the manifest in this folder (Project Settings > check **Show "appsscript.json" manifest file**). The manifest timezone is `Asia/Calcutta`.
5. Edit `CONFIG` in `Code.gs`:
   - `API_BASE_URL`
   - `SEARCH.PARAMS.jql` (Jira Cloud rejects unbounded JQL; keep a project restriction)
   - `FIELDS` custom field ids (`customfield_10050`, not the `customfield_CATALYST` placeholder)
   - `SHEET_NAME` if the tab is not `Tickets`
6. Save the API credential as a Script Property (**Project Settings > Script Properties**), not in the file:

   | Property | Used when |
   | --- | --- |
   | `API_EMAIL` | `AUTH.TYPE` is `basic` |
   | `API_TOKEN` | `AUTH.TYPE` is `basic` |
   | `BEARER_TOKEN` | `AUTH.TYPE` is `bearer` |
   | `ON_HOLD_TRANSITION_ID` | `TRANSITION.MODE` is `id` |

   A Script Property overrides the matching `CONFIG` placeholder. Values that still start with `YOUR_` are rejected before any request.

7. Run `logTransitionsForIssue` from the editor with a real key, for example `logTransitionsForIssue('PROJ-123')`. Copy the id whose destination is `On Hold`.
8. Run `main` once and accept the spreadsheet, external URL, and trigger permissions.
9. Reload the spreadsheet. The **Ticket Sync** menu appears.

`clasp` can push this folder. Both `.gs` and `.js` files upload into the same Apps Script project.

## Jira Cloud defaults

Search is `GET /rest/api/3/search/jql` with `nextPageToken`. The first request omits that parameter. Pages stop when `isLast` is true or `nextPageToken` is absent. The legacy `/rest/api/3/search` endpoint has been removed on Jira Cloud. For Data Center, set:

```javascript
PATH: '/rest/api/2/search',
PAGINATION: 'startAt',
```

`SEARCH.PARAMS.fields` defaults to `["*navigable"]` so the search works before custom field ids are filled in. The enhanced search otherwise returns only issue ids. After `CONFIG.FIELDS` uses real ids, set `fields` to `null` to request just those ids. Switch `METHOD` to `POST` when the JQL is too long for a query string.

Transitions are `POST /rest/api/3/issue/{key}/transitions` with `{"transition":{"id":"..."}}`. Success is any HTTP 2xx (Jira uses 204). Set `TRANSITION.MODE` to `name` when the On Hold transition id is different from each source status. Name mode loads the available transitions and posts the id whose destination status is `On Hold`.

The API user needs permission to browse the issues and to execute the transition. A workflow screen that requires extra fields can be supplied with `TRANSITION.EXTRA_BODY`.

## Menu and trigger

**Ticket Sync**

- Sync and transition inactive → `main`
- Sync tickets only → `syncTicketsToSheet`
- Transition inactive to On Hold → `transitionInactiveTicketsToOnHold`
- Install hourly trigger → time-driven trigger on `main`
- Remove hourly trigger

To install the trigger without the menu: Apps Script **Triggers** (alarm clock) > **Add Trigger** > function `main` > **Time-driven** > **Hour timer**. The schedule uses the script timezone, `Asia/Calcutta`.

Each entry point takes a script lock. A second run that starts while one is active logs `Skipped` and exits. Set `CONFIG.DRY_RUN` to `true` to log the keys that would move without calling the transition API or changing column D. The sync still writes the sheet.

## What a run changes

1. Fetch every search page. A failed search throws and leaves the sheet alone.
2. Write columns A-I from row 2 in chunks, then column J formulas.
3. Clear only the leftover A-J cells below the new block. Column L stays.
4. Flush so column J calculates.
5. Read A-J once. Skip blank keys, unsafe keys, blank Active Status, and statuses already in `On Hold`.
6. Post transitions in batches of `TRANSITION.BATCH_SIZE`. HTTP 429 and 5xx are retried once. Other failures are logged with the key and response snippet, and column D is left as it was.
7. Write column D in one `setValues` for the successful keys only (unchanged cells in that column are written back with their current values).

`Logger.log` records every transitioned key and every failed call. Executions show those lines. The manifest also sends uncaught exceptions to Cloud Logging.

## Local checks

From the repository root:

```bash
node --check apps-script/Code.gs
node --check apps-script/TicketLogic.js
node --test test/ticket-logic.test.js
```

The node tests cover mapping, the column J formula, candidate selection, pagination, and request building. They do not call Google or Jira.
