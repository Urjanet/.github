#!/usr/bin/env python3
"""Write one day's Olympus EOD into The Olympus workbook.

Two sections on a tab named for the report date, for example Nov 04:
Member contribution, then Member Contribution in Tickets.
Jira and Google credentials are the same files the SKILL EOD upload uses.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

import olympus_report

JIRA_BASE = "https://arcadiapower.atlassian.net"
SPREADSHEET_ID = "1dPNzBUKZF4Xp-QPpY5ZMkRN_-a_6NPj4BAAMWfMRcLE"
PROTECTED_GID = 377349833
SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets"
IST = timezone(timedelta(hours=5, minutes=30))
SKILL_ROOT = Path(__file__).resolve().parent.parent
CREDENTIALS = SKILL_ROOT / "credentials"
SIBLING_CREDENTIALS = SKILL_ROOT.parent / "skill-eod-sheet" / "credentials"
FIELDS = ",".join(
    [
        "key",
        "summary",
        "status",
        "assignee",
        "project",
        "customfield_11239",
        "customfield_11184",
        "customfield_15845",
        "customfield_11185",
        "customfield_11186",
        "customfield_11187",
        "customfield_11171",
        "customfield_12282",
        "worklog",
    ]
)

BLUE = {"red": 0.15686275, "green": 0.31764707, "blue": 0.49803922}
LIGHT = {"red": 0.92941177, "green": 0.95686275, "blue": 0.9764706}
CREAM = {"red": 1, "green": 0.9490196, "blue": 0.81960785}
WHITE = {"red": 1, "green": 1, "blue": 1}
GREEN = {"red": 0.7764706, "green": 0.9372549, "blue": 0.80784315}
AMBER = {"red": 1, "green": 0.9490196, "blue": 0.8}
GREY = {"red": 0.93, "green": 0.93, "blue": 0.93}


def die(message: str, code: int = 1) -> None:
    print(message, file=sys.stderr)
    raise SystemExit(code)


def is_placeholder(value: str | None) -> bool:
    text = (value or "").strip()
    if not text:
        return True
    upper = text.upper()
    return "REPLACE_WITH" in upper or "REPLACE_ME" in upper or upper.startswith("PASTE_")


def read_env_file(path: Path) -> dict[str, str]:
    if not path.is_file():
        return {}
    values: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
            value = value[1:-1]
        values[key.strip()] = value
    return values


def credential_dirs() -> list[Path]:
    return [CREDENTIALS, SIBLING_CREDENTIALS]


def jira_settings() -> dict[str, str]:
    settings: dict[str, str] = {}
    for folder in credential_dirs():
        for name in ("jira.env.example", "jira.env"):
            settings.update(read_env_file(folder / name))
    return settings


def jira_email() -> str:
    email = os.environ.get("JIRA_EMAIL", "").strip()
    if is_placeholder(email):
        email = jira_settings().get("JIRA_EMAIL", "").strip()
    if is_placeholder(email):
        email = "sowmiya.kirubakaran@arcadia.com"
    return email


def jira_token() -> str:
    path = os.environ.get("JIRA_API_TOKEN_FILE", "").strip()
    if path:
        token = Path(path).read_text(encoding="utf-8").strip()
        if not is_placeholder(token):
            return token
    token = os.environ.get("JIRA_API_TOKEN", "").strip()
    if not is_placeholder(token):
        return token
    file_token = jira_settings().get("JIRA_API_TOKEN", "")
    if not is_placeholder(file_token):
        return file_token
    die(
        "Jira token is still a placeholder. Put the same Atlassian API token "
        f"used by SKILL EOD in {CREDENTIALS / 'jira.env'}. The token is not printed."
    )


def request_json(url: str, headers: dict, method: str = "GET", body: dict | None = None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=90) as response:
            raw = response.read().decode()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:300]
        die(f"HTTP {exc.code} for {urllib.parse.urlparse(url).path}: {detail}")


def basic_auth(email: str, token: str) -> str:
    return base64.b64encode(f"{email}:{token}".encode()).decode()


def fetch_issues(jql: str, email: str, token: str) -> list[dict]:
    headers = {
        "Authorization": f"Basic {basic_auth(email, token)}",
        "Accept": "application/json",
        "Content-Type": "application/json",
    }
    field_list = [item for item in FIELDS.split(",") if item]
    issues: list[dict] = []
    page = None
    while True:
        body: dict = {"jql": jql, "maxResults": 100, "fields": field_list, "expand": "changelog"}
        if page:
            body["nextPageToken"] = page
        data = request_json(f"{JIRA_BASE}/rest/api/3/search/jql", headers, method="POST", body=body)
        batch = data.get("issues") or []
        issues.extend(batch)
        page = data.get("nextPageToken")
        if data.get("isLast") or not page or not batch:
            break
    return issues


def enrich_issue(issue: dict, email: str, token: str) -> None:
    headers = {"Authorization": f"Basic {basic_auth(email, token)}", "Accept": "application/json"}
    changelog = issue.get("changelog") or {}
    histories = list(changelog.get("histories") or [])
    total = changelog.get("total", len(histories))
    start = len(histories)
    while start < total:
        data = request_json(
            f"{JIRA_BASE}/rest/api/3/issue/{issue['key']}/changelog?maxResults=100&startAt={start}",
            headers,
        )
        page = data.get("values") or []
        histories.extend(page)
        if not page:
            break
        start += len(page)
        total = data.get("total", total)
    issue["_histories"] = histories
    worklog = (issue.get("fields") or {}).get("worklog") or {}
    entries = list(worklog.get("worklogs") or [])
    total_entries = worklog.get("total", len(entries))
    start = len(entries)
    while start < total_entries:
        data = request_json(
            f"{JIRA_BASE}/rest/api/3/issue/{issue['key']}/worklog?maxResults=100&startAt={start}",
            headers,
        )
        page = data.get("worklogs") or []
        entries.extend(page)
        if not page:
            break
        start += len(page)
        total_entries = data.get("total", total_entries)
    issue["_worklogs"] = entries


def load_day(day: datetime, email: str, token: str) -> tuple[list[dict], list[str]]:
    found: dict[str, dict] = {}
    queries = []
    for person in olympus_report.ROSTER:
        for jql in (
            olympus_report.status_jql(day, person["jira_name"]),
            olympus_report.worklog_jql(day, person["jira_name"]),
        ):
            queries.append(jql)
            for issue in fetch_issues(jql, email, token):
                found.setdefault(issue["key"], issue)
    for issue in found.values():
        enrich_issue(issue, email, token)
    return list(found.values()), queries


def parse_date(text: str | None) -> datetime:
    if not text:
        now = datetime.now(IST)
        return datetime(now.year, now.month, now.day)
    text = text.strip()
    for fmt in ("%Y-%m-%d", "%d-%b-%Y", "%d-%b", "%b %d", "%d %b", "%b %d %Y"):
        try:
            parsed = datetime.strptime(text, fmt)
        except ValueError:
            continue
        if parsed.year == 1900:
            parsed = parsed.replace(year=datetime.now(IST).year)
        return parsed
    die(f"Could not read a date from {text!r}. Use 2026-11-04 or Nov 04.")


def access_token_from_files() -> str:
    override = os.environ.get("GOOGLE_ACCESS_TOKEN_FILE", "").strip()
    paths = [Path(override)] if override else []
    for folder in credential_dirs():
        paths.extend([folder / "google-access-token.txt", folder / "google-access-token.txt.example"])
    for path in paths:
        if not path.is_file():
            continue
        token = path.read_text(encoding="utf-8").strip()
        if not is_placeholder(token):
            return token
    return ""


def service_account_path() -> Path | None:
    override = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS", "").strip()
    paths = [Path(override)] if override else []
    for folder in credential_dirs():
        paths.extend(
            [folder / "google-service-account.json", folder / "google-service-account.json.example"]
        )
    for path in paths:
        if not path.is_file():
            continue
        with open(path, encoding="utf-8") as handle:
            service_account = json.load(handle)
        if is_placeholder(str(service_account.get("private_key", ""))) or is_placeholder(
            str(service_account.get("client_email", ""))
        ):
            continue
        return path
    return None


def google_token() -> str:
    access = os.environ.get("GOOGLE_ACCESS_TOKEN", "").strip()
    if is_placeholder(access):
        access = access_token_from_files()
    if access:
        return access
    path = service_account_path()
    if path is None:
        die(
            "Sheet was not updated. Put the same Google service-account JSON used by "
            f"SKILL EOD in {CREDENTIALS / 'google-service-account.json'} "
            f"or {SIBLING_CREDENTIALS / 'google-service-account.json'}. "
            "The identity needs edit access on The Olympus spreadsheet.",
            code=2,
        )
    with open(path, encoding="utf-8") as handle:
        service_account = json.load(handle)
    now = int(time.time())
    header = base64.urlsafe_b64encode(json.dumps({"alg": "RS256", "typ": "JWT"}).encode()).rstrip(b"=").decode()
    claim = base64.urlsafe_b64encode(
        json.dumps(
            {
                "iss": service_account["client_email"],
                "scope": SHEETS_SCOPE,
                "aud": "https://oauth2.googleapis.com/token",
                "iat": now,
                "exp": now + 3600,
            }
        ).encode()
    ).rstrip(b"=").decode()
    signing_input = f"{header}.{claim}".encode()
    with tempfile.NamedTemporaryFile("w", delete=False) as key_file:
        os.chmod(key_file.name, 0o600)
        key_file.write(service_account["private_key"])
        key_path = key_file.name
    try:
        signed = subprocess.run(
            ["openssl", "dgst", "-sha256", "-sign", key_path],
            input=signing_input,
            capture_output=True,
            check=False,
        )
    finally:
        os.unlink(key_path)
    if signed.returncode != 0:
        die("Could not sign the Google service-account request. The sheet was not updated.", code=2)
    signature = base64.urlsafe_b64encode(signed.stdout).rstrip(b"=").decode()
    form = urllib.parse.urlencode(
        {"grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer", "assertion": f"{header}.{claim}.{signature}"}
    ).encode()
    req = urllib.request.Request(
        "https://oauth2.googleapis.com/token",
        data=form,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            payload = json.loads(response.read().decode())
    except urllib.error.HTTPError:
        die("Google rejected the service account. The sheet was not updated.", code=2)
    token = payload.get("access_token")
    if not token:
        die("Google did not return an access token. The sheet was not updated.", code=2)
    return token


def sheet_properties(token: str) -> list[dict]:
    data = request_json(
        f"https://sheets.googleapis.com/v4/spreadsheets/{SPREADSHEET_ID}?fields=sheets.properties",
        {"Authorization": f"Bearer {token}"},
    )
    return [(sheet.get("properties") or {}) for sheet in data.get("sheets") or []]


def ensure_date_tab(token: str, title: str) -> int:
    for props in sheet_properties(token):
        if props.get("title") != title:
            continue
        if props.get("sheetId") == PROTECTED_GID:
            die(
                f"Refusing to replace tab {title!r} because it is gid {PROTECTED_GID}. "
                "That is the tab the workbook link opened. Create a different date tab.",
                code=2,
            )
        return props["sheetId"]
    created = request_json(
        f"https://sheets.googleapis.com/v4/spreadsheets/{SPREADSHEET_ID}:batchUpdate",
        {"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        method="POST",
        body={"requests": [{"addSheet": {"properties": {"title": title}}}]},
    )
    replies = created.get("replies") or []
    props = ((replies[0].get("addSheet") or {}).get("properties") if replies else {}) or {}
    sheet_id = props.get("sheetId")
    if sheet_id is None:
        die(f"Could not create tab {title!r}. The workbook was not changed.", code=2)
    return sheet_id


def write_grid(token: str, title: str, rows: list[list]) -> None:
    clear_range = urllib.parse.quote(f"'{title}'!A1:ZZ")
    request_json(
        f"https://sheets.googleapis.com/v4/spreadsheets/{SPREADSHEET_ID}/values/{clear_range}:clear",
        {"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        method="POST",
        body={},
    )
    target = urllib.parse.quote(f"'{title}'!A1")
    request_json(
        f"https://sheets.googleapis.com/v4/spreadsheets/{SPREADSHEET_ID}/values/{target}?valueInputOption=USER_ENTERED",
        {"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        method="PUT",
        body={"range": f"'{title}'!A1", "majorDimension": "ROWS", "values": rows},
    )


def repeat_format(sheet_id: int, start: int, end: int, columns: int, cell: dict, fields: str) -> dict:
    return {
        "repeatCell": {
            "range": {
                "sheetId": sheet_id,
                "startRowIndex": start,
                "endRowIndex": end,
                "startColumnIndex": 0,
                "endColumnIndex": columns,
            },
            "cell": {"userEnteredFormat": cell},
            "fields": fields,
        }
    }


def paint_report(token: str, sheet_id: int, rows: list[list]) -> None:
    width = max((len(row) for row in rows), default=1)
    requests = [
        repeat_format(
            sheet_id,
            0,
            max(len(rows) + 5, 40),
            max(width, 21),
            {
                "backgroundColor": WHITE,
                "textFormat": {"bold": False, "fontSize": 10, "foregroundColor": {"red": 0, "green": 0, "blue": 0}},
                "wrapStrategy": "OVERFLOW_CELL",
                "verticalAlignment": "BOTTOM",
            },
            "userEnteredFormat.backgroundColor,userEnteredFormat.textFormat,userEnteredFormat.wrapStrategy,userEnteredFormat.verticalAlignment",
        ),
        repeat_format(
            sheet_id,
            0,
            1,
            6,
            {"textFormat": {"bold": True, "fontSize": 16, "foregroundColor": BLUE}},
            "userEnteredFormat.textFormat",
        ),
        {
            "updateSheetProperties": {
                "properties": {"sheetId": sheet_id, "gridProperties": {"frozenRowCount": 1}},
                "fields": "gridProperties.frozenRowCount",
            }
        },
    ]
    widths = [210, 160, 280] + [130] * 18
    for index, pixel in enumerate(widths):
        requests.append(
            {
                "updateDimensionProperties": {
                    "range": {
                        "sheetId": sheet_id,
                        "dimension": "COLUMNS",
                        "startIndex": index,
                        "endIndex": index + 1,
                    },
                    "properties": {"pixelSize": pixel},
                    "fields": "pixelSize",
                }
            }
        )
    for index, row in enumerate(rows):
        text = str(row[0]).strip() if row else ""
        if text in {"Member contribution", "Catalyst planned hours", "Member Contribution in Tickets"}:
            requests.append(
                repeat_format(
                    sheet_id,
                    index,
                    index + 1,
                    width,
                    {"textFormat": {"bold": True, "fontSize": 13, "foregroundColor": BLUE}},
                    "userEnteredFormat.textFormat",
                )
            )
            continue
        if text == "Team member":
            requests.append(
                repeat_format(
                    sheet_id,
                    index,
                    index + 1,
                    len(row),
                    {
                        "backgroundColor": BLUE,
                        "wrapStrategy": "WRAP",
                        "verticalAlignment": "MIDDLE",
                        "textFormat": {"bold": True, "fontSize": 10, "foregroundColor": WHITE},
                    },
                    "userEnteredFormat.backgroundColor,userEnteredFormat.wrapStrategy,userEnteredFormat.verticalAlignment,userEnteredFormat.textFormat",
                )
            )
            continue
        if text == "Total":
            requests.append(
                repeat_format(
                    sheet_id,
                    index,
                    index + 1,
                    len(row),
                    {"backgroundColor": CREAM, "textFormat": {"bold": True}},
                    "userEnteredFormat.backgroundColor,userEnteredFormat.textFormat",
                )
            )
            continue
        if index == 2:
            requests.append(
                repeat_format(
                    sheet_id,
                    index,
                    index + 1,
                    1,
                    {"wrapStrategy": "WRAP", "verticalAlignment": "TOP"},
                    "userEnteredFormat.wrapStrategy,userEnteredFormat.verticalAlignment",
                )
            )
            requests.append(
                {
                    "updateDimensionProperties": {
                        "range": {"sheetId": sheet_id, "dimension": "ROWS", "startIndex": index, "endIndex": index + 1},
                        "properties": {"pixelSize": 88},
                        "fields": "pixelSize",
                    }
                }
            )
        if len(row) > 8 and row[8] in {"Skill", "Non Skill", "Other"}:
            color = {"Skill": GREEN, "Non Skill": AMBER, "Other": GREY}[row[8]]
            requests.append(
                {
                    "repeatCell": {
                        "range": {
                            "sheetId": sheet_id,
                            "startRowIndex": index,
                            "endRowIndex": index + 1,
                            "startColumnIndex": 8,
                            "endColumnIndex": 9,
                        },
                        "cell": {"userEnteredFormat": {"backgroundColor": color}},
                        "fields": "userEnteredFormat.backgroundColor",
                    }
                }
            )
    request_json(
        f"https://sheets.googleapis.com/v4/spreadsheets/{SPREADSHEET_ID}:batchUpdate",
        {"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        method="POST",
        body={"requests": requests},
    )


def print_table(rows: list[list]) -> None:
    printing = False
    for row in rows:
        text = str(row[0]).strip() if row else ""
        if text == "Member contribution":
            printing = True
            print(text)
            continue
        if text == "Member Contribution in Tickets":
            break
        if printing and row:
            print("\t".join(str(cell) for cell in row))


def main() -> None:
    parser = argparse.ArgumentParser(description="Upload the Olympus EOD report to Google Sheets.")
    parser.add_argument("--date", help="Report date. Defaults to today in Asia/Kolkata. Example: 2026-11-04.")
    parser.add_argument("--dry-run", action="store_true", help="Fetch Jira and print the table. Do not write the sheet.")
    parser.add_argument("--self-test", action="store_true", help="Run the calculation checks and exit.")
    args = parser.parse_args()
    if args.self_test:
        olympus_report.self_test()
        return
    day = parse_date(args.date)
    email = jira_email()
    token = jira_token()
    issues, queries = load_day(day, email, token)
    generated = datetime.now(IST)
    grid = olympus_report.build_sheet(day, issues, generated)
    print(f"Date: {day.strftime('%Y-%m-%d')} Asia/Kolkata")
    print(f"Tab: {olympus_report.tab_name(day)}")
    print(f"Tickets fetched: {len(issues)}")
    print(f"Queries: {len(queries)}")
    print_table(grid)
    sys.stdout.flush()
    if args.dry_run:
        print("Dry run. The sheet was not updated.")
        return
    access = google_token()
    title = olympus_report.tab_name(day)
    sheet_id = ensure_date_tab(access, title)
    write_grid(access, title, grid)
    paint_report(access, sheet_id, grid)
    print(f"Wrote tab {title!r} (gid {sheet_id}).")
    print(f"https://docs.google.com/spreadsheets/d/{SPREADSHEET_ID}/edit#gid={sheet_id}")


if __name__ == "__main__":
    main()
