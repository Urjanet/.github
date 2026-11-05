# Credentials you can fill in

The uploader reads these files. Environment variables still win when they are set.

Fill in one of the two Google files. A service-account JSON is the one that keeps working. An access token expires.

| File | What to put in it |
| --- | --- |
| `jira.env.example` | `JIRA_EMAIL` and `JIRA_API_TOKEN` |
| `google-service-account.json.example` | The whole JSON key downloaded from Google Cloud |
| `google-access-token.txt.example` | One `ya29...` access token, only if you are not using a service account |

Share the Google Sheet with the service-account `client_email` as an Editor before the upload.

Gitignored copies, used ahead of the example files:

- `jira.env`
- `google-service-account.json`
- `google-access-token.txt`

Copy the example, drop `.example` from the name, and edit the copy when you do not want the secret in git. Editing the example file in this folder also works. Leave `REPLACE_WITH_` and `REPLACE_ME` in place until the real value is ready. The uploader treats those as empty and does not write the sheet.
