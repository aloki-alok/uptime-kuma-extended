# Customizations

This is a build of [Uptime Kuma](https://github.com/louislam/uptime-kuma) with a
few additions on top of [PR #5916](https://github.com/louislam/uptime-kuma/pull/5916)
(configurable heartbeat-bar range). Everything here is generic and configured
entirely through environment variables and input files — no secrets or
deployment details are committed.

## 1. Configurable heartbeat-bar range (from PR #5916)

`status_page.heartbeat_bar_days` column (0 = auto, range 0–365), set per status
page in the editor. Longer ranges are time-bucketed into ~100 bars.

## 2. Slack `/incident` endpoint

`server/routers/slack-router.js` (registered in `server/server.js`).

- **Route:** `POST /api/slack/incident`
- **Auth:** Slack request signature — HMAC-SHA256 over the raw body using your
  Slack app's signing secret. Requests older than 5 minutes are rejected
  (replay protection). The code holds no secret; security rests entirely on the
  signing secret you configure. An optional team-ID allowlist adds defence in depth.
- **Behaviour:** reuses Uptime Kuma's own incident logic — creates and pins an
  incident on the target status page.
- **Command grammar** (the text after `/incident`):
  - `/incident <title> | <details…> | eta <eta> | <style>`
  - styles: `info`, `warning`, `danger` (default), `primary`, `light`, `dark`
  - `--page <slug>` targets a non-default status page
  - `/incident resolve` (also `clear` / `done` / `ok` / `up`) unpins and
    deactivates active incidents on the page
- **Configuration (environment variables):**
  | Variable | Required | Default | Purpose |
  |---|---|---|---|
  | `SLACK_SIGNING_SECRET` | yes | — | Slack app signing secret; if unset, the endpoint rejects everything |
  | `SLACK_INCIDENT_STATUS_PAGE_SLUG` | no | `all` | Default status page slug to post to |
  | `SLACK_ALLOWED_TEAM_ID` | no | — | Comma-separated Slack team IDs allowed to post |

### Slack app setup

1. Create a Slack app → **Slash Commands** → new command `/incident`,
   Request URL = `https://<your-status-host>/api/slack/incident`.
2. Copy the app's **Signing Secret** into the `SLACK_SIGNING_SECRET` env var.
3. (Optional) set `SLACK_ALLOWED_TEAM_ID` to your workspace's team ID.

## 3. Bulk-add monitors

`extra/bulk-add-monitors.js` reads a JSON file and creates HTTP monitors,
attaching them to a status-page group. Idempotent on monitor name. See
`extra/services.example.json` for the format.

Run it as a one-off, with the main container stopped, then restart to begin
monitoring:

```
docker stop <container>
docker run --rm -v <data-volume>:/app/data -v ./services.json:/services.json \
  <image> node extra/bulk-add-monitors.js --file=/services.json
docker start <container>
```

## Notes

- These additions depend on Uptime Kuma's internal DB models, not a stable
  public API. Re-check them when merging upstream changes.
- Keep the Slack signing secret out of the repo (env var only). Rotate it if
  it is ever exposed.
