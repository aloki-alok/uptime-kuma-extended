/* eslint-disable jsdoc/require-jsdoc */
const crypto = require("node:crypto");
const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const { buildStatusExport, hasValidBearerToken, parseComponentMap } = require("../../../server/status-export");

function repository() {
    return {
        monitorRefs: ["11"],
        latestAttempt: async () => ({ status: 1, time: "2026-09-11 00:59:30", ping: 47.4 }),
        latestConfirmed: async () => ({ status: 1, time: "2026-09-11 00:59:30", ping: 47.4 }),
        minuteStats: async () => [
            { timestamp: 1789088280, ping: 51.2, up: 1 },
            { timestamp: 1789088340, ping: 47.4, up: 1 },
        ],
        daily: async () => [
            { timestamp: 1788998400, ping: 50.25, up: 100, down: 1, extras: null },
            { timestamp: 1789084800, ping: 47.4, up: 1, down: 0, extras: null },
        ],
        transitions: async () => [
            { status: 1, time: "2026-09-09 23:00:00" },
            { status: 0, time: "2026-09-10 00:10:00" },
            { status: 1, time: "2026-09-10 00:11:00" },
        ],
    };
}

describe("status export", () => {
    test("requires a configured constant-time bearer token", () => {
        const secret = "a-secure-status-export-token-value";
        assert.equal(hasValidBearerToken(`Bearer ${secret}`, secret), true);
        assert.equal(hasValidBearerToken("Bearer wrong", secret), false);
        assert.equal(hasValidBearerToken(`Bearer ${secret}`, "short"), false);
        assert.equal(hasValidBearerToken(undefined, secret), false);
    });

    test("accepts only explicit monitor to component mappings", () => {
        const mappings = JSON.stringify({ all: { 11: "api", 12: "web" } });
        assert.deepEqual(
            [...parseComponentMap("all", mappings)],
            [
                ["11", "api"],
                ["12", "web"],
            ]
        );
        assert.throws(() => parseComponentMap("missing", mappings));
        assert.throws(() => parseComponentMap("all", JSON.stringify({ all: { 11: "API" } })));
    });

    test("exports bounded monitoring data without private monitor identifiers", async () => {
        const result = await buildStatusExport("all", {
            now: () => new Date("2026-09-11T01:00:00Z"),
            componentMap: new Map([["11", "api"]]),
            repository: repository(),
        });

        assert.equal(result.schemaVersion, "1.0.0");
        assert.equal(result.latestCheckAt, "2026-09-11T00:59:30.000Z");
        assert.equal(result.components.length, 1);
        assert.equal(result.components[0].componentId, "api");
        assert.equal(result.components[0].history.length, 90);
        assert.equal(result.components[0].history.at(-2).state, "degraded");
        assert.equal(result.components[0].history.at(-2).downMinutes, 1);
        assert.equal(result.components[0].history.at(-1).uptime, null);
        assert.deepEqual(result.components[0].latency, [
            { observedAt: "2026-09-11T00:58:00.000Z", avgMs: 51.2, sampleCount: 1 },
            { observedAt: "2026-09-11T00:59:00.000Z", avgMs: 47.4, sampleCount: 1 },
        ]);
        assert.equal(
            result.sourceRevision,
            crypto
                .createHash("sha256")
                .update(
                    JSON.stringify({
                        latestCheckAt: result.latestCheckAt,
                        components: result.components,
                    })
                )
                .digest("hex")
        );
        assert.equal(JSON.stringify(result).includes("monitorRef"), false);
        assert.equal(JSON.stringify(result).includes("https://"), false);
        assert.equal(JSON.stringify(result).includes("msg"), false);
    });

    test("retains the prior confirmed state while a check is pending", async () => {
        const source = repository();
        source.latestAttempt = async () => ({ status: 2, time: "2026-09-11 00:59:50", ping: null });

        const result = await buildStatusExport("all", {
            now: () => new Date("2026-09-11T01:00:00Z"),
            componentMap: new Map([["11", "api"]]),
            repository: source,
        });

        assert.equal(result.components[0].state, "operational");
        assert.equal(result.components[0].latestCheckAt, "2026-09-11T00:59:50.000Z");
        assert.equal(result.components[0].responseTimeMs, 47.4);
    });

    test("rejects a status page whose public topology differs from its mapping", async () => {
        await assert.rejects(
            buildStatusExport("all", {
                now: () => new Date("2026-09-11T01:00:00Z"),
                componentMap: new Map([["12", "web"]]),
                repository: repository(),
            }),
            /topology/
        );
    });

    test("uses the oldest component check as the page freshness time", async () => {
        const first = repository();
        first.monitorRefs = ["11", "12"];
        first.latestAttempt = async (monitorRef) => ({
            status: 1,
            time: monitorRef === "11" ? "2026-09-11 00:59:30" : "2026-09-11 00:58:30",
            ping: 47.4,
        });
        first.latestConfirmed = first.latestAttempt;

        const result = await buildStatusExport("all", {
            now: () => new Date("2026-09-11T01:00:00Z"),
            componentMap: new Map([
                ["11", "api"],
                ["12", "web"],
            ]),
            repository: first,
        });

        assert.equal(result.latestCheckAt, "2026-09-11T00:58:30.000Z");
    });

    test("rejects future heartbeats and duplicate minute buckets", async () => {
        const future = repository();
        future.latestAttempt = async () => ({ status: 1, time: "2026-09-11 01:00:01", ping: 47.4 });
        await assert.rejects(
            buildStatusExport("all", {
                now: () => new Date("2026-09-11T01:00:00Z"),
                componentMap: new Map([["11", "api"]]),
                repository: future,
            }),
            /future/
        );

        const duplicate = repository();
        duplicate.minuteStats = async () => [
            { timestamp: 1789088340, ping: 47.4, up: 1 },
            { timestamp: 1789088340, ping: 48.1, up: 1 },
        ];
        await assert.rejects(
            buildStatusExport("all", {
                now: () => new Date("2026-09-11T01:00:00Z"),
                componentMap: new Map([["11", "api"]]),
                repository: duplicate,
            }),
            /duplicate/
        );
    });
});
