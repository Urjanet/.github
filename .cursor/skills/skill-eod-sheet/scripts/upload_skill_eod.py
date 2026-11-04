#!/usr/bin/env python3
"""Upload one day's SKILL EOD ticket list into the Google Sheet.

Same shape as the PMU MTD upload: one Jira query, one row per ticket,
header preserved, body replaced. Secrets stay in the environment.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict
from datetime import datetime
from pathlib import Path

JIRA_BASE = "https://arcadiapower.atlassian.net"
SPREADSHEET_ID = "1w3uc-rSxWuHBmGjh6IRpjBt1kWhDiQG3QLXalDvKtno"
SHEET_GID = 1231097422
SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets"
SKILL_ROOT = Path(__file__).resolve().parent.parent
CREDENTIALS = SKILL_ROOT / "credentials"

MONTHS = {
    1: "Jan",
    2: "Feb",
    3: "Mar",
    4: "Apr",
    5: "May",
    6: "Jun",
    7: "Jul",
    8: "Aug",
    9: "Sep",
    10: "Oct",
    11: "Nov",
    12: "Dec",
}

DEFAULT_HEADERS = [
    "Ticket",
    "Summary",
    "Status",
    "Assignee",
    "Resolver",
    "Labels",
    "Skill",
    "CA Agent",
    "CA Engineer",
    "ET Agent",
    "ET Engineer",
    "Template PRs",
    "Template added by",
    "Audits",
    "Audit added by",
    "Update type",
    "Dev min",
    "Analysis min",
    "UT min",
    "Hours",
]

SKILL = {
    "tharun vijayakumar",
    "venkat ganesh r",
    "chandana c savalgimath",
    "esvar k n",
    "janani nataraj kumar",
    "k pavankumar",
    "raghuram selvaraj",
    "pooja sri balakrishnan",
    "nitish kumar jangam",
    "sartaj r",
    "karthik c",
    "saipriyadarsini balaji",
    "chandru k s",
    "stanley deivanayagam",
    "anusha m",
    "dinesh ramasamy",
    "smitha r gulalakai",
    "yogesh thambidurai",
    "deepika kumari",
    "subramanya siva",
}
ALIAS = {
    "esvar kn": "esvar k n",
    "pavankumar k": "k pavankumar",
    "b saipriyadarsini saipriyadarsini": "saipriyadarsini balaji",
    "smitha r g": "smitha r gulalakai",
    "yogesh t": "yogesh thambidurai",
}
OTHER = {
    "svc ticketvalidator jira user",
    "svc automon jira user",
    "automation for jira",
    "meruthika k",
    "vaishali vaduganathan",
    "monisha s",
    "velayutham k",
    "mukes kanna s",
    "logeshkumar m",
    "dhana sheelaa",
    "shankar ganesh k",
    "shafna azmi mujibudeen",
    "vijaykumar chauhan",
    "muthu prabha shankar",
    "neela kudupudi",
    "suba shri b",
    "vineeth ebinezar",
}

FIELDS = ",".join(
    [
        "key",
        "summary",
        "status",
        "labels",
        "assignee",
        "customfield_11178",
        "customfield_19782",
        "customfield_19817",
        "customfield_19783",
        "customfield_19818",
        "customfield_11187",
        "customfield_11184",
        "customfield_15845",
        "customfield_11185",
    ]
)

TPL_RE = re.compile(
    r"(templates3|40448635-14a2-444c-b2de-eb65df1e7043)/pull-requests/(\d+)",
    re.I,
)
AUDIT_RE = re.compile(r"auditoverrides5/commits/([0-9a-fA-F]{7,40})")


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


def credential_file(*names: str) -> Path | None:
    for name in names:
        path = CREDENTIALS / name
        if path.is_file():
            return path
    return None


def jira_settings() -> dict[str, str]:
    settings: dict[str, str] = {}
    for name in ("jira.env.example", "jira.env"):
        settings.update(read_env_file(CREDENTIALS / name))
    return settings


def jira_token() -> str:
    path = os.environ.get("JIRA_API_TOKEN_FILE")
    if path:
        with open(path, encoding="utf-8") as handle:
            token = handle.read().strip()
            if not is_placeholder(token):
                return token
    token = os.environ.get("JIRA_API_TOKEN", "").strip()
    if not is_placeholder(token):
        return token
    file_token = jira_settings().get("JIRA_API_TOKEN", "")
    if not is_placeholder(file_token):
        return file_token
    die(
        "Jira token is still a placeholder. Put the Atlassian API token in "
        f"{CREDENTIALS / 'jira.env'} or {CREDENTIALS / 'jira.env.example'}. "
        "The token is not printed."
    )


def jira_email() -> str:
    email = os.environ.get("JIRA_EMAIL", "").strip()
    if is_placeholder(email):
        email = jira_settings().get("JIRA_EMAIL", "").strip()
    if is_placeholder(email):
        email = "sowmiya.kirubakaran@arcadia.com"
    return email


def request_json(
    url: str,
    headers: dict,
    method: str = "GET",
    body: dict | None = None,
    ok_errors: tuple[int, ...] = (),
):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as response:
            raw = response.read().decode()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as exc:
        if exc.code in ok_errors:
            return {}
        detail = exc.read().decode("utf-8", errors="replace")[:300]
        die(f"HTTP {exc.code} for {urllib.parse.urlparse(url).path}: {detail}")


def label_for(day: datetime) -> str:
    return f"CASkillable-{day.day:02d}-{MONTHS[day.month]}"


def parse_date(text: str) -> datetime:
    text = text.strip()
    for fmt in ("%Y-%m-%d", "%d-%b-%Y", "%d-%b", "%b %d", "%d %b", "%b %d %Y"):
        try:
            parsed = datetime.strptime(text, fmt)
            if parsed.year == 1900:
                parsed = parsed.replace(year=datetime.now().year)
            return parsed
        except ValueError:
            continue
    die(f"Could not read a date from {text!r}. Use 2026-11-04 or 04-Nov.")


def skill_group(name: str | None) -> str:
    if not name:
        return ""
    low = " ".join(name.strip().split()).lower()
    low = ALIAS.get(low, low)
    if low in SKILL:
        return "Skill"
    if low in OTHER:
        return "Other Team"
    return "Non Skill"


def display(value) -> str:
    if value is None:
        return ""
    if isinstance(value, dict):
        return str(value.get("displayName") or value.get("value") or value.get("name") or "")
    if isinstance(value, list):
        return ", ".join(display(item) for item in value if display(item))
    text = str(value).strip()
    return "" if text in ("-", "—", "–") else text


def minutes(value) -> str:
    if value is None or value == "":
        return ""
    try:
        return str(int(float(value))) if float(value) == int(float(value)) else str(value)
    except (TypeError, ValueError):
        return str(value)


def hours_of(fields: dict) -> str:
    dev = float(fields.get("customfield_11187") or 0)
    analysis = fields.get("customfield_11184")
    if analysis is None:
        analysis = fields.get("customfield_15845") or 0
    ut = float(fields.get("customfield_11185") or 0)
    total = (dev + float(analysis or 0) + ut) / 60
    if total == 0:
        return ""
    return f"{total:.2f}".rstrip("0").rstrip(".")


def basic_auth(email: str, token: str) -> str:
    return base64.b64encode(f"{email}:{token}".encode()).decode()


def fetch_issues(jql: str, email: str, token: str, fields: str = FIELDS) -> list[dict]:
    headers = {
        "Authorization": f"Basic {basic_auth(email, token)}",
        "Accept": "application/json",
    }
    issues: list[dict] = []
    page = None
    while True:
        query = {"jql": jql, "maxResults": "100", "fields": fields}
        if page:
            query["nextPageToken"] = page
        url = f"{JIRA_BASE}/rest/api/3/search/jql?{urllib.parse.urlencode(query)}"
        data = request_json(url, headers)
        batch = data.get("issues") or []
        issues.extend(batch)
        if data.get("isLast") or not data.get("nextPageToken") or not batch:
            break
        page = data["nextPageToken"]
    return issues


def walk_urls(node, found: list[str]) -> None:
    if isinstance(node, dict):
        if node.get("type") == "text":
            text = node.get("text") or ""
            if "bitbucket.org" in text:
                found.append(text)
            for mark in node.get("marks") or []:
                href = (mark.get("attrs") or {}).get("href") or ""
                if "bitbucket.org" in href:
                    found.append(href)
        href = (node.get("attrs") or {}).get("href") or ""
        if "bitbucket.org" in str(href):
            found.append(href)
        for child in node.values():
            walk_urls(child, found)
    elif isinstance(node, list):
        for child in node:
            walk_urls(child, found)


def artifacts_for(issue: dict, email: str, token: str) -> dict:
    headers = {
        "Authorization": f"Basic {basic_auth(email, token)}",
        "Accept": "application/json",
    }
    pr_author: dict[str, str] = {}
    detail = request_json(
        f"{JIRA_BASE}/rest/dev-status/1.0/issue/detail?"
        + urllib.parse.urlencode(
            {"issueId": issue["id"], "applicationType": "bitbucket", "dataType": "pullrequest"}
        ),
        headers,
        ok_errors=(404,),
    )
    for block in detail.get("detail") or []:
        for pr in block.get("pullRequests") or []:
            if pr.get("id"):
                pr_author[str(pr["id"])] = (pr.get("author") or {}).get("name") or ""
    comment_authors: dict[str, list[str]] = defaultdict(list)
    audit_authors: dict[str, list[str]] = defaultdict(list)
    start = 0
    while True:
        data = request_json(
            f"{JIRA_BASE}/rest/api/3/issue/{issue['key']}/comment?maxResults=100&startAt={start}",
            headers,
        )
        for comment in data.get("comments") or []:
            found: list[str] = []
            walk_urls(comment.get("body"), found)
            who = (comment.get("author") or {}).get("displayName") or ""
            for url in found:
                for match in TPL_RE.finditer(url):
                    comment_authors[match.group(2)].append(who)
                for match in AUDIT_RE.finditer(url):
                    audit_authors[match.group(1).lower()].append(who)
        if start + data.get("maxResults", 100) >= data.get("total", 0):
            break
        start += data.get("maxResults", 100)
    ids = set(pr_author) | set(comment_authors)
    templates = []
    authors = []
    for pr_id in sorted(ids, key=lambda item: int(item)):
        who = pr_author.get(pr_id) or (comment_authors[pr_id][0] if comment_authors[pr_id] else "")
        templates.append(pr_id)
        if who:
            authors.append(who)
    audits = []
    audit_by = []
    for sha in sorted(audit_authors):
        audits.append(sha[:7])
        if audit_authors[sha]:
            audit_by.append(audit_authors[sha][0])
    if templates and audits:
        update = "Connector Upgrade+Override"
    elif templates:
        update = "Connector Upgrade"
    elif audits:
        update = "Override"
    else:
        update = "Non-resolved"
    return {
        "templates": ", ".join(templates),
        "template_by": ", ".join(dict.fromkeys(authors)),
        "audits": ", ".join(audits),
        "audit_by": ", ".join(dict.fromkeys(audit_by)),
        "update": update,
        "audit_shas": list(audit_authors),
    }


def closer_name(issue: dict, email: str, token: str) -> str:
    headers = {
        "Authorization": f"Basic {basic_auth(email, token)}",
        "Accept": "application/json",
    }
    start = 0
    last = ""
    while True:
        data = request_json(
            f"{JIRA_BASE}/rest/api/3/issue/{issue['key']}/changelog?maxResults=100&startAt={start}",
            headers,
        )
        for history in data.get("values") or []:
            who = (history.get("author") or {}).get("displayName") or ""
            for item in history.get("items") or []:
                if item.get("field") == "status" and item.get("toString") in ("Closed", "Resolved"):
                    last = who
        if data.get("isLast", True) or start + data.get("maxResults", 100) >= data.get("total", 0):
            break
        start += data.get("maxResults", 100)
    return last


def row_values(issue: dict, artifacts: dict | None, resolver: str) -> dict[str, str]:
    fields = issue["fields"]
    status = (fields.get("status") or {}).get("name") or ""
    who = display(fields.get("customfield_11178")) or resolver
    artifacts = artifacts or {
        "templates": "",
        "template_by": "",
        "audits": "",
        "audit_by": "",
        "update": "",
    }
    analysis = fields.get("customfield_11184")
    if analysis is None:
        analysis = fields.get("customfield_15845")
    return {
        "ticket": issue["key"],
        "summary": display(fields.get("summary")),
        "status": status,
        "assignee": display(fields.get("assignee")),
        "resolver": who,
        "labels": ", ".join(fields.get("labels") or []),
        "skill": skill_group(who) if who else "",
        "ca agent": display(fields.get("customfield_19782")),
        "ca engineer": display(fields.get("customfield_19817")),
        "et agent": display(fields.get("customfield_19783")),
        "et engineer": display(fields.get("customfield_19818")),
        "template prs": artifacts["templates"],
        "template added by": artifacts["template_by"],
        "audits": artifacts["audits"],
        "audit added by": artifacts["audit_by"],
        "update type": artifacts["update"],
        "dev min": minutes(fields.get("customfield_11187")),
        "analysis min": minutes(analysis),
        "ut min": minutes(fields.get("customfield_11185")),
        "hours": hours_of(fields),
    }


HEADER_KEYS = [
    (("ticket", "key", "issue", "issue key"), "ticket"),
    (("summary",), "summary"),
    (("status",), "status"),
    (("assignee",), "assignee"),
    (("resolver", "who closed"), "resolver"),
    (("labels", "label"), "labels"),
    (("skill", "skill member", "group"), "skill"),
    (("ca agent", "code adapt agent", "ai codeadapt agent result"), "ca agent"),
    (("ca engineer", "code adapt engineer", "ai codeadapt engineer result"), "ca engineer"),
    (("et agent", "error type agent", "ai errortype agent result"), "et agent"),
    (("et engineer", "error type engineer", "ai errortype engineer result"), "et engineer"),
    (("template prs", "template pr", "templates", "template"), "template prs"),
    (("template added by", "template pr added by"), "template added by"),
    (("audits", "audit"), "audits"),
    (("audit added by", "audit pr added by"), "audit added by"),
    (("update type", "update"), "update type"),
    (("dev min", "development min"), "dev min"),
    (("analysis min",), "analysis min"),
    (("ut min", "unit testing min"), "ut min"),
    (("hours",), "hours"),
]


def header_key(header: str) -> str | None:
    cleaned = re.sub(r"[^a-z0-9]+", " ", header.lower()).strip()
    for aliases, key in HEADER_KEYS:
        if cleaned in aliases:
            return key
    return None


def needs_artifacts(headers: list[str]) -> bool:
    keys = {header_key(header) for header in headers}
    return bool(keys & {"template prs", "template added by", "audits", "audit added by", "update type"})


def access_token_from_files() -> str:
    names = []
    override = os.environ.get("GOOGLE_ACCESS_TOKEN_FILE", "").strip()
    if override:
        names.append(override)
    for path in [Path(name) for name in names] + [
        CREDENTIALS / "google-access-token.txt",
        CREDENTIALS / "google-access-token.txt.example",
    ]:
        if not path.is_file():
            continue
        token = path.read_text(encoding="utf-8").strip()
        if not is_placeholder(token):
            return token
    return ""


def service_account_path() -> Path | None:
    override = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS", "").strip()
    candidates = [Path(override)] if override else []
    candidates.extend(
        [
            CREDENTIALS / "google-service-account.json",
            CREDENTIALS / "google-service-account.json.example",
        ]
    )
    for path in candidates:
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
            "Sheet was not updated. Fill in "
            f"{CREDENTIALS / 'google-service-account.json'} "
            f"or {CREDENTIALS / 'google-access-token.txt'}. "
            "The example files next to them can be edited instead. "
            "The identity needs edit access on the SKILL EOD spreadsheet.",
            code=2,
        )
    with open(path, encoding="utf-8") as handle:
        service_account = json.load(handle)
    now = int(time.time())
    header = base64.urlsafe_b64encode(
        json.dumps({"alg": "RS256", "typ": "JWT"}).encode()
    ).rstrip(b"=").decode()
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
        die("Could not sign the Google service-account request.")
    signature = base64.urlsafe_b64encode(signed.stdout).rstrip(b"=").decode()
    form = urllib.parse.urlencode(
        {
            "grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
            "assertion": f"{header}.{claim}.{signature}",
        }
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


def sheet_title(token: str) -> str:
    data = request_json(
        f"https://sheets.googleapis.com/v4/spreadsheets/{SPREADSHEET_ID}?fields=sheets.properties",
        {"Authorization": f"Bearer {token}"},
    )
    for sheet in data.get("sheets") or []:
        props = sheet.get("properties") or {}
        if props.get("sheetId") == SHEET_GID:
            return props["title"]
    die(f"Tab gid {SHEET_GID} was not found. The sheet was not updated.", code=2)


def read_headers(token: str, title: str) -> list[str]:
    quoted = urllib.parse.quote(f"'{title}'!1:1")
    data = request_json(
        f"https://sheets.googleapis.com/v4/spreadsheets/{SPREADSHEET_ID}/values/{quoted}",
        {"Authorization": f"Bearer {token}"},
    )
    values = data.get("values") or []
    if not values or not any(cell.strip() for cell in values[0] if isinstance(cell, str)):
        return []
    return [str(cell) for cell in values[0]]


def write_body(token: str, title: str, headers: list[str], rows: list[list[str]]) -> None:
    clear_range = urllib.parse.quote(f"'{title}'!A2:ZZ")
    request_json(
        f"https://sheets.googleapis.com/v4/spreadsheets/{SPREADSHEET_ID}/values/{clear_range}:clear",
        {"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        method="POST",
        body={},
    )
    values = [headers, *rows]
    target = urllib.parse.quote(f"'{title}'!A1")
    url = (
        f"https://sheets.googleapis.com/v4/spreadsheets/{SPREADSHEET_ID}/values/{target}"
        "?valueInputOption=USER_ENTERED"
    )
    request_json(
        url,
        {"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        method="PUT",
        body={"range": f"'{title}'!A1", "majorDimension": "ROWS", "values": values},
    )


def build_rows(issues: list[dict], headers: list[str], email: str, token: str) -> tuple[list[list[str]], list[str]]:
    want_artifacts = needs_artifacts(headers)
    shared: dict[str, list[str]] = defaultdict(list)
    table = []
    for issue in issues:
        fields = issue["fields"]
        status = (fields.get("status") or {}).get("name") or ""
        resolver = ""
        if not display(fields.get("customfield_11178")) and status in ("Closed", "Resolved"):
            resolver = closer_name(issue, email, token)
        artifacts = artifacts_for(issue, email, token) if want_artifacts else None
        if artifacts:
            for sha in artifacts["audit_shas"]:
                shared[sha].append(issue["key"])
        values = row_values(issue, artifacts, resolver)
        table.append([values.get(header_key(header) or "", "") for header in headers])
    shared_notes = [
        f"{sha[:7]} on {', '.join(keys)}"
        for sha, keys in shared.items()
        if len(set(keys)) > 1
    ]
    return table, shared_notes


def main() -> None:
    parser = argparse.ArgumentParser(description="Upload SKILL EOD tickets to the Google Sheet.")
    parser.add_argument("--date", required=True, help="Date, such as 2026-11-04 or 04-Nov.")
    parser.add_argument("--dry-run", action="store_true", help="Fetch Jira only. Do not write the sheet.")
    args = parser.parse_args()
    day = parse_date(args.date)
    label = label_for(day)
    jql = f'labels IN ({label}) AND status != "On Hold (migrated)"'
    email = jira_email()
    token = jira_token()
    issues = fetch_issues(jql, email, token)
    held = fetch_issues(
        f'labels IN ({label}) AND status = "On Hold (migrated)"',
        email,
        token,
        fields="key",
    )
    print(f"JQL: {jql}")
    print(f"Tickets: {len(issues)}")
    print(f"On Hold (migrated) excluded: {len(held)}")
    if args.dry_run:
        print("Dry run. The sheet was not updated.")
        return
    access = google_token()
    title = sheet_title(access)
    headers = read_headers(access, title) or list(DEFAULT_HEADERS)
    rows, shared = build_rows(issues, headers, email, token)
    write_body(access, title, headers, rows)
    print(f"Wrote {len(rows)} rows to tab {title!r} (gid {SHEET_GID}).")
    if shared:
        print("Shared audit commits: " + "; ".join(shared))


if __name__ == "__main__":
    main()
