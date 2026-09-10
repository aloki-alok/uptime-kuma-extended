/* eslint-disable jsdoc/require-jsdoc */
const crypto = require("node:crypto");
const { R } = require("redbean-node");
const { DOWN, MAINTENANCE, PENDING, UP } = require("../src/util");

const DAY_MS = 24 * 60 * 60 * 1000;
const HISTORY_DAYS = 90;
const MINUTE_MS = 60 * 1000;
const SUSTAINED_DOWN_SECONDS = 600;
const COMPONENT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

function isoTime(value) {
    const text = String(value).trim();
    const normalized = text.includes("T") ? text : `${text.replace(" ", "T")}Z`;
    const parsed = new Date(normalized);
    if (!Number.isFinite(parsed.getTime())) {
        throw new TypeError("Status export contains an invalid heartbeat time");
    }
    return parsed.toISOString();
}

function sqlTime(value) {
    return value.toISOString().slice(0, 19).replace("T", " ");
}

function round(value, precision) {
    const factor = 10 ** precision;
    return Math.round(value * factor) / factor;
}

function parseComponentMap(slug, serialized = process.env.STATUS_EXPORT_COMPONENTS) {
    if (typeof serialized !== "string" || serialized.length === 0 || serialized.length > 8192) {
        throw new TypeError("Status export component mapping is not configured");
    }

    let mappings;
    try {
        mappings = JSON.parse(serialized);
    } catch {
        throw new TypeError("Status export component mapping is invalid");
    }

    const mapping = Object.prototype.hasOwnProperty.call(mappings, slug) ? mappings[slug] : null;
    if (!mapping || Array.isArray(mapping) || typeof mapping !== "object") {
        throw new TypeError("Status export component mapping is missing");
    }

    const entries = Object.entries(mapping);
    const componentIds = new Set(entries.map(([, componentId]) => componentId));
    if (
        entries.length === 0 ||
        componentIds.size !== entries.length ||
        entries.some(
            ([monitorRef, componentId]) =>
                !/^[1-9][0-9]*$/.test(monitorRef) ||
                typeof componentId !== "string" ||
                !COMPONENT_ID_PATTERN.test(componentId)
        )
    ) {
        throw new TypeError("Status export component mapping is invalid");
    }

    return new Map(entries);
}

function currentState(latestConfirmed) {
    if (!latestConfirmed) {
        return "unknown";
    }
    if (Number(latestConfirmed.status) === UP) {
        return "operational";
    }
    if (Number(latestConfirmed.status) === DOWN) {
        return "major_outage";
    }
    if (Number(latestConfirmed.status) === MAINTENANCE) {
        return "maintenance";
    }
    return "unknown";
}

function responseTime(latestConfirmed) {
    const ping = Number(latestConfirmed?.ping);
    if (Number(latestConfirmed?.status) !== UP || !Number.isFinite(ping) || ping < 0) {
        return null;
    }
    return round(ping, 2);
}

function maintenanceCount(extras) {
    if (!extras) {
        return 0;
    }
    try {
        const parsed = JSON.parse(extras);
        return Number.isFinite(parsed?.maintenance) && parsed.maintenance > 0 ? parsed.maintenance : 0;
    } catch {
        throw new TypeError("Status export contains invalid daily statistics");
    }
}

function confirmedDownIntervals(transitions, windowStart, observedUntil) {
    const intervals = [];
    let downSince = null;

    for (const transition of transitions) {
        const observedAt = Date.parse(isoTime(transition.time));
        if (observedAt > observedUntil) {
            break;
        }
        if (observedAt < windowStart) {
            downSince = Number(transition.status) === DOWN ? windowStart : null;
            continue;
        }
        if (Number(transition.status) === DOWN && downSince === null) {
            downSince = observedAt;
        }
        if (Number(transition.status) !== DOWN && downSince !== null) {
            intervals.push({ start: downSince, end: observedAt });
            downSince = null;
        }
    }
    if (downSince !== null && downSince < observedUntil) {
        intervals.push({ start: downSince, end: observedUntil });
    }
    return intervals;
}

function overlapSeconds(intervals, start, end) {
    return intervals.reduce((total, interval) => {
        const overlap = Math.min(interval.end, end) - Math.max(interval.start, start);
        return total + Math.max(0, overlap / 1000);
    }, 0);
}

function longestOverlapSeconds(intervals, start, end) {
    return intervals.reduce((longest, interval) => {
        const overlap = Math.min(interval.end, end) - Math.max(interval.start, start);
        return Math.max(longest, Math.max(0, overlap / 1000));
    }, 0);
}

function unknownDay(start) {
    return {
        date: new Date(start).toISOString().slice(0, 10),
        state: "unknown",
        severity: "unknown",
        uptime: null,
        downMinutes: 0,
        avgMs: null,
    };
}

function dailyHistory(rows, transitions, generatedAt, latestCheckAt) {
    const todayStart = Date.UTC(generatedAt.getUTCFullYear(), generatedAt.getUTCMonth(), generatedAt.getUTCDate());
    const windowStart = todayStart - (HISTORY_DAYS - 1) * DAY_MS;
    const observedUntil = Date.parse(latestCheckAt);
    const byTimestamp = new Map(rows.map((row) => [Number(row.timestamp), row]));
    const intervals = confirmedDownIntervals(transitions, windowStart, observedUntil);

    return Array.from({ length: HISTORY_DAYS }, (_, index) => {
        const start = windowStart + index * DAY_MS;
        const end = Math.min(start + DAY_MS, observedUntil);
        const row = byTimestamp.get(Math.floor(start / 1000));
        const maintenance = maintenanceCount(row?.extras ?? null);
        const observed = row && (Number(row.up) > 0 || Number(row.down) > 0 || maintenance > 0);
        if (!observed || end <= start) {
            return unknownDay(start);
        }

        const downSeconds = overlapSeconds(intervals, start, end);
        const longestDown = longestOverlapSeconds(intervals, start, end);
        const severity = downSeconds === 0 ? "none" : longestDown >= SUSTAINED_DOWN_SECONDS ? "major" : "minor";
        const state =
            severity === "major"
                ? "major_outage"
                : severity === "minor"
                  ? "degraded"
                  : maintenance > 0
                    ? "maintenance"
                    : "operational";
        const ping = Number(row.ping);
        const isCompleteDay = observedUntil >= start + DAY_MS;

        return {
            date: new Date(start).toISOString().slice(0, 10),
            state,
            severity,
            uptime: isCompleteDay ? round(Math.max(0, 100 - (downSeconds / 86400) * 100), 3) : null,
            downMinutes: Math.min(1440, Math.round(downSeconds / 60)),
            avgMs: Number(row.up) > 0 && Number.isFinite(ping) && ping >= 0 ? round(ping, 2) : null,
        };
    });
}

function latencyHistory(rows, latestCheckAt) {
    const endBucket = Math.floor(Date.parse(latestCheckAt) / MINUTE_MS) * MINUTE_MS;
    const windowStart = endBucket - 59 * MINUTE_MS;
    const points = [];
    const timestamps = new Set();

    for (const row of rows) {
        const observedAt = Number(row.timestamp) * 1000;
        const ping = Number(row.ping);
        const sampleCount = Number(row.up);
        if (
            observedAt < windowStart ||
            observedAt > endBucket ||
            observedAt % MINUTE_MS !== 0 ||
            !Number.isInteger(sampleCount) ||
            sampleCount <= 0 ||
            !Number.isFinite(ping) ||
            ping < 0
        ) {
            continue;
        }
        if (timestamps.has(observedAt)) {
            throw new TypeError("Status export contains duplicate minute statistics");
        }
        timestamps.add(observedAt);
        points.push({
            observedAt: new Date(observedAt).toISOString(),
            avgMs: round(ping, 2),
            sampleCount,
        });
    }

    return points.sort((first, second) => first.observedAt.localeCompare(second.observedAt));
}

async function repositoryForStatusPage(slug) {
    const statusPage = await R.findOne("status_page", " slug = ? AND published = 1 ", [slug]);
    if (!statusPage) {
        return null;
    }
    const monitorRefs = await R.getCol(
        `SELECT monitor_group.monitor_id FROM monitor_group, \`group\`
         WHERE monitor_group.group_id = \`group\`.id
         AND public = 1 AND \`group\`.status_page_id = ?
         ORDER BY \`group\`.weight, monitor_group.weight`,
        [statusPage.id]
    );
    return {
        monitorRefs: monitorRefs.map(String),
        latestAttempt: (monitorRef) =>
            R.getRow("SELECT status, time, ping FROM heartbeat WHERE monitor_id = ? ORDER BY time DESC LIMIT 1", [
                monitorRef,
            ]),
        latestConfirmed: (monitorRef) =>
            R.getRow(
                "SELECT status, time, ping FROM heartbeat WHERE monitor_id = ? AND status != ? ORDER BY time DESC LIMIT 1",
                [monitorRef, PENDING]
            ),
        minuteStats: (monitorRef, cutoff) =>
            R.getAll(
                "SELECT timestamp, ping, up FROM stat_minutely WHERE monitor_id = ? AND timestamp >= ? ORDER BY timestamp ASC LIMIT 60",
                [monitorRef, cutoff]
            ),
        daily: (monitorRef, cutoff) =>
            R.getAll(
                "SELECT timestamp, ping, up, down, extras FROM stat_daily WHERE monitor_id = ? AND timestamp >= ? ORDER BY timestamp ASC",
                [monitorRef, cutoff]
            ),
        transitions: async (monitorRef, cutoff) => {
            const before = await R.getRow(
                "SELECT status, time FROM heartbeat WHERE monitor_id = ? AND important = 1 AND time < ? ORDER BY time DESC LIMIT 1",
                [monitorRef, cutoff]
            );
            const current = await R.getAll(
                "SELECT status, time FROM heartbeat WHERE monitor_id = ? AND important = 1 AND time >= ? ORDER BY time ASC",
                [monitorRef, cutoff]
            );
            return before ? [before, ...current] : current;
        },
    };
}

function revisionFor(latestCheckAt, components) {
    const content = {
        latestCheckAt,
        components: [...components].sort((left, right) => left.componentId.localeCompare(right.componentId)),
    };
    return crypto.createHash("sha256").update(JSON.stringify(content)).digest("hex");
}

async function buildStatusExport(slug, options = {}) {
    const generatedAt = options.now ? options.now() : new Date();
    if (!(generatedAt instanceof Date) || !Number.isFinite(generatedAt.getTime())) {
        throw new TypeError("Status export clock is invalid");
    }

    const componentMap = options.componentMap ?? parseComponentMap(slug);
    const repository = options.repository ?? (await repositoryForStatusPage(slug));
    if (!repository) {
        return null;
    }
    if (
        repository.monitorRefs.length !== componentMap.size ||
        repository.monitorRefs.some((monitorRef) => !componentMap.has(String(monitorRef)))
    ) {
        throw new TypeError("Status export topology does not match its component mapping");
    }

    const todayStart = Date.UTC(generatedAt.getUTCFullYear(), generatedAt.getUTCMonth(), generatedAt.getUTCDate());
    const dailyCutoff = Math.floor((todayStart - (HISTORY_DAYS - 1) * DAY_MS) / 1000);
    const transitionCutoff = new Date(todayStart - HISTORY_DAYS * DAY_MS);
    const components = [];

    for (const monitorRef of repository.monitorRefs) {
        const latestAttempt = await repository.latestAttempt(monitorRef);
        if (!latestAttempt) {
            throw new TypeError("Status export component has no heartbeat");
        }
        const latestCheckAt = isoTime(latestAttempt.time);
        const minuteCutoff = Math.floor(
            (Math.floor(Date.parse(latestCheckAt) / MINUTE_MS) * MINUTE_MS - 59 * MINUTE_MS) / 1000
        );
        const [latestConfirmed, minuteStats, daily, transitions] = await Promise.all([
            repository.latestConfirmed(monitorRef),
            repository.minuteStats(monitorRef, minuteCutoff),
            repository.daily(monitorRef, dailyCutoff),
            repository.transitions(monitorRef, sqlTime(transitionCutoff)),
        ]);
        if (Date.parse(latestCheckAt) > generatedAt.getTime()) {
            throw new TypeError("Status export component heartbeat is in the future");
        }
        if (latestConfirmed && Date.parse(isoTime(latestConfirmed.time)) > Date.parse(latestCheckAt)) {
            throw new TypeError("Status export confirmed heartbeat is newer than its latest check");
        }

        components.push({
            componentId: componentMap.get(String(monitorRef)),
            state: currentState(latestConfirmed),
            latestCheckAt,
            responseTimeMs: responseTime(latestConfirmed),
            latency: latencyHistory(minuteStats, latestCheckAt),
            history: dailyHistory(daily, transitions, generatedAt, latestCheckAt),
        });
    }

    const latestCheckAt = components
        .map((component) => component.latestCheckAt)
        .sort()
        .at(0);
    return {
        schemaVersion: "1.0.0",
        generatedAt: generatedAt.toISOString(),
        latestCheckAt,
        sourceRevision: revisionFor(latestCheckAt, components),
        components,
    };
}

function hasValidBearerToken(authorization, secret = process.env.STATUS_EXPORT_TOKEN) {
    if (
        typeof secret !== "string" ||
        secret.length < 32 ||
        typeof authorization !== "string" ||
        !authorization.startsWith("Bearer ")
    ) {
        return false;
    }
    const supplied = Buffer.from(authorization.slice(7));
    const expected = Buffer.from(secret);
    return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

module.exports = { buildStatusExport, hasValidBearerToken, parseComponentMap };
