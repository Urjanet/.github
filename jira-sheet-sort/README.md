# Sort Jira rows by formula columns

`SORT(JIRA(B30), ...)` can only sort columns that `JIRA()` returns. AK, AM, and AO are sheet formulas, so `sorted-report.formula` calculates them inside the same array as the tickets and then sorts by all three, descending (AK, then AM, then AO).

## Setup

1. Add a tab named `Jira Sorted` (or change `Sheet1!$B$30` and `REPORT_SHEET` to match your names).
2. Paste `sorted-report.formula` into `Jira Sorted!A1`.
3. Replace `AK_EXPR`, `AM_EXPR`, `AO_EXPR` with array versions of your current row formulas (below).
4. Stop reading the old AK/AM/AO columns; the sorted tab is the report.

## Converting a row formula

Each expression must return one value per ticket. Read Jira columns with `INDEX(body,,n)`, where `n` is the column's position in the `JIRA()` output (A = 1), and wrap the row logic in `MAP`:

| Old row formula | Replace with |
| --- | --- |
| `=E32*G32` | `MAP(INDEX(body,,5), INDEX(body,,7), LAMBDA(e, g, e*g))` |
| `=IF(E32="",,TODAY()-E32)` | `MAP(INDEX(body,,5), LAMBDA(e, IF(e="",, TODAY()-e)))` |
| `=VLOOKUP(D32, Teams!A:B, 2, FALSE)` | `MAP(INDEX(body,,4), LAMBDA(d, IFNA(VLOOKUP(d, Teams!A:B, 2, FALSE))))` |

If AM or AO uses AK, refer to `ak` directly, e.g. `MAP(ak, INDEX(body,,6), LAMBDA(k, f, k+f))`.

If `JIRA()` in your setup does not return a header row, set `header` to `{"...your labels..."}` and `body` to `raw`.

## Daily refresh

The formula recalculates when the file opens or `B30` changes. For a fresh pull every morning without opening the file:

1. Extensions > Apps Script, paste `refreshJiraReport.gs`.
2. Run `installDailyTrigger` once and approve access. It schedules `refreshJiraReport` daily around `REFRESH_HOUR` (spreadsheet time zone).

`refreshJiraReport` clears and rewrites the formula in `Jira Sorted!A1`, which forces `JIRA()` to run again instead of returning a cached result.
