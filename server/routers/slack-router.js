let express = require("express");
const crypto = require("crypto");
const querystring = require("querystring");
const dayjs = require("dayjs");
const { R } = require("redbean-node");
const apicache = require("../modules/apicache");
const StatusPage = require("../model/status_page");
const { log } = require("../../src/util");

let router = express.Router();

// Config (set as container env vars)
const SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET || "";
const DEFAULT_SLUG = process.env.SLACK_INCIDENT_STATUS_PAGE_SLUG || "all";
// Optional allowlist: comma-separated Slack team IDs. Empty = allow any team that passes signature.
const ALLOWED_TEAM_IDS = (process.env.SLACK_ALLOWED_TEAM_ID || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const VALID_STYLES = [ "info", "warning", "danger", "primary", "light", "dark" ];
const RESOLVE_WORDS = [ "resolve", "resolved", "clear", "cleared", "done", "ok", "up" ];

/**
 * Verify a Slack request signature over the raw request body.
 * @param {Buffer} rawBody Raw request body buffer
 * @param {object} headers Request headers
 * @returns {boolean} True if the signature is valid and fresh
 */
function verifySlackSignature(rawBody, headers) {
    if (!SIGNING_SECRET) {
        log.error("slack", "SLACK_SIGNING_SECRET is not set; rejecting request");
        return false;
    }
    const timestamp = headers["x-slack-request-timestamp"];
    const signature = headers["x-slack-signature"];
    if (!timestamp || !signature) {
        return false;
    }
    // Reject requests older than 5 minutes (replay protection)
    if (Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp)) > 60 * 5) {
        return false;
    }
    const base = `v0:${timestamp}:${rawBody.toString("utf8")}`;
    const expected = "v0=" + crypto.createHmac("sha256", SIGNING_SECRET).update(base).digest("hex");
    const a = Buffer.from(expected);
    const b = Buffer.from(String(signature));
    if (a.length !== b.length) {
        return false;
    }
    return crypto.timingSafeEqual(a, b);
}

/**
 * Parse the Slack slash-command text into an incident.
 * Format (all parts after the first are optional):
 *   <title> | <details...> | eta <eta> | <style>
 * A leading "resolve" (or clear/done/ok/up) resolves active incidents instead.
 * @param {string} text Raw slash-command text
 * @returns {object} Parsed command: { resolve } or { title, content, style }
 */
function parseIncidentText(text) {
    const trimmed = (text || "").trim();
    if (!trimmed || RESOLVE_WORDS.includes(trimmed.toLowerCase())) {
        return { resolve: true };
    }

    const parts = trimmed.split("|").map((p) => p.trim()).filter((p) => p.length > 0);
    let title = parts.shift() || "Incident";
    let style = "danger";
    let eta = null;
    const contentParts = [];

    for (const part of parts) {
        const etaMatch = part.match(/^eta[:\s]+(.+)$/i);
        if (etaMatch) {
            eta = etaMatch[1].trim();
        } else if (VALID_STYLES.includes(part.toLowerCase())) {
            style = part.toLowerCase();
        } else {
            contentParts.push(part);
        }
    }

    let content = contentParts.join("\n\n");
    if (eta) {
        content += (content ? "\n\n" : "") + `**ETA:** ${eta}`;
    }
    if (!content) {
        content = title;
    }
    return { resolve: false, title, content, style };
}

/**
 * POST /api/slack/incident
 * Slack slash command endpoint. Posts (or resolves) a pinned incident on the
 * configured status page. Auth is the Slack request signature.
 */
router.post(
    "/api/slack/incident",
    express.raw({ type: () => true, limit: "64kb" }),
    async (request, response) => {
        try {
            const rawBody = Buffer.isBuffer(request.body) ? request.body : Buffer.from("");

            if (!verifySlackSignature(rawBody, request.headers)) {
                log.warn("slack", "Rejected /incident: invalid signature");
                return response.status(401).json({
                    response_type: "ephemeral",
                    text: "Unauthorized: invalid Slack signature.",
                });
            }

            const params = querystring.parse(rawBody.toString("utf8"));

            if (ALLOWED_TEAM_IDS.length > 0 && !ALLOWED_TEAM_IDS.includes(params.team_id)) {
                log.warn("slack", `Rejected /incident: team ${params.team_id} not allowed`);
                return response.status(403).json({
                    response_type: "ephemeral",
                    text: "This Slack workspace is not allowed to post incidents.",
                });
            }

            const slug = (params.text || "").match(/--page[:\s]+(\S+)/i)?.[1] || DEFAULT_SLUG;
            const text = (params.text || "").replace(/--page[:\s]+\S+/i, "").trim();
            const statusPageID = await StatusPage.slugToID(slug);
            if (!statusPageID) {
                return response.status(200).json({
                    response_type: "ephemeral",
                    text: `Status page "${slug}" not found.`,
                });
            }

            const parsed = parseIncidentText(text);
            const userName = params.user_name || "someone";

            if (parsed.resolve) {
                await R.exec(
                    "UPDATE incident SET pin = 0, active = 0, last_updated_date = ? WHERE active = 1 AND status_page_id = ?",
                    [ R.isoDateTime(dayjs.utc()), statusPageID ]
                );
                apicache.clear();
                log.info("slack", `Incident(s) resolved on "${slug}" by ${userName}`);
                return response.status(200).json({
                    response_type: "in_channel",
                    text: `:white_check_mark: Active incidents on *${slug}* marked resolved by ${userName}.`,
                });
            }

            const incidentBean = R.dispense("incident");
            incidentBean.title = parsed.title;
            incidentBean.content = parsed.content;
            incidentBean.style = parsed.style;
            incidentBean.pin = true;
            incidentBean.active = true;
            incidentBean.status_page_id = statusPageID;
            incidentBean.created_date = R.isoDateTime(dayjs.utc());
            await R.store(incidentBean);
            apicache.clear();

            log.info("slack", `Incident posted on "${slug}" by ${userName}: ${parsed.title}`);
            return response.status(200).json({
                response_type: "in_channel",
                text: `:rotating_light: Incident posted to *${slug}* by ${userName}:\n*${parsed.title}*\n${parsed.content}`,
            });
        } catch (error) {
            log.error("slack", "Failed to handle /incident: " + error.message);
            return response.status(200).json({
                response_type: "ephemeral",
                text: "Failed to post incident: " + error.message,
            });
        }
    }
);

module.exports = router;
