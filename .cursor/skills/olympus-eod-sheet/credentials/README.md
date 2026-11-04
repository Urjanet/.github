# Credentials

Use the same Jira token and Google service-account JSON as the SKILL EOD skill.

The uploader reads this folder and `.cursor/skills/skill-eod-sheet/credentials/`. A filled-in file wins over the `.example` file. Environment variables win over both.

| File | What to put in it |
| --- | --- |
| `jira.env` | `JIRA_EMAIL` and `JIRA_API_TOKEN` |
| `google-service-account.json` | The service-account JSON key |
| `google-access-token.txt` | One access token, only if you are not using a service account |

Share The Olympus spreadsheet with the service-account email as an Editor.

These filled-in names are gitignored:

- `jira.env`
- `google-service-account.json`
- `google-access-token.txt`

`REPLACE_WITH_` and `REPLACE_ME` count as empty. The uploader does not write the sheet until Google credentials are real, and it does not print them.
