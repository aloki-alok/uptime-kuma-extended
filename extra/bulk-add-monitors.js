/*
 * Bulk-add HTTP monitors to a status page group from a JSON file.
 *
 * Usage (run with the main container STOPPED, as a one-off container):
 *   docker stop <container>
 *   docker run --rm -v <data-volume>:/app/data -v ./services.json:/services.json \
 *     <image> node extra/bulk-add-monitors.js --file=/services.json
 *   docker start <container>
 *
 * services.json format:
 * {
 *   "statusPageSlug": "all",
 *   "groupName": "Services",
 *   "defaults": { "interval": 60, "maxretries": 1, "acceptedStatuscodes": ["200-299"] },
 *   "services": [
 *     { "name": "Example", "url": "https://example.com/health" },
 *     { "name": "Example 2", "url": "https://example.org/health", "interval": 120 }
 *   ]
 * }
 */
const fs = require("fs");
const Database = require("../server/database");
const { R } = require("redbean-node");
const StatusPage = require("../server/model/status_page");
const args = require("args-parser")(process.argv);

const main = async () => {
    const file = args.file || process.argv[2];
    if (!file) {
        throw new Error("Usage: node extra/bulk-add-monitors.js --file=<services.json>");
    }
    const config = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!Array.isArray(config.services) || config.services.length === 0) {
        throw new Error("services.json has no 'services' array");
    }

    console.log("Connecting to the database...");
    Database.initDataDir(args);
    await Database.connect(false, false, true);

    const slug = config.statusPageSlug || "all";
    const statusPageID = await StatusPage.slugToID(slug);
    if (!statusPageID) {
        throw new Error(`Status page "${slug}" not found`);
    }

    const groupName = config.groupName || "Services";
    let group = await R.findOne("group", " name = ? AND status_page_id = ? ", [groupName, statusPageID]);
    if (!group) {
        group = R.dispense("group");
        group.name = groupName;
        group.public = 1;
        group.active = 1;
        group.weight = 1000;
        group.status_page_id = statusPageID;
        await R.store(group);
        console.log(`Created group "${groupName}" (id=${group.id}) on status page "${slug}"`);
    }

    const d = config.defaults || {};
    const interval = (svc) => svc.interval || d.interval || 60;

    let added = 0;
    let linked = 0;
    let skipped = 0;

    for (const svc of config.services) {
        if (!svc.name || !svc.url) {
            console.log("  SKIP (needs name+url):", JSON.stringify(svc));
            skipped++;
            continue;
        }

        let monitor = await R.findOne("monitor", " name = ? ", [svc.name]);
        if (monitor) {
            console.log(`  exists: monitor "${svc.name}" (id=${monitor.id})`);
        } else {
            monitor = R.dispense("monitor");
            monitor.name = svc.name;
            monitor.type = svc.type || d.type || "http";
            monitor.url = svc.url;
            monitor.method = svc.method || d.method || "GET";
            monitor.interval = interval(svc);
            monitor.retry_interval = svc.retryInterval || d.retryInterval || interval(svc);
            monitor.resend_interval =
                svc.resendInterval != null ? svc.resendInterval : d.resendInterval != null ? d.resendInterval : 0;
            monitor.maxretries = svc.maxretries != null ? svc.maxretries : d.maxretries != null ? d.maxretries : 1;
            monitor.upside_down = 0;
            monitor.active = 1;
            monitor.accepted_statuscodes_json = JSON.stringify(
                svc.acceptedStatuscodes || d.acceptedStatuscodes || ["200-299"]
            );
            monitor.weight = 2000;
            monitor.timeout = svc.timeout || d.timeout || Math.round(interval(svc) * 0.8 * 10) / 10;
            await R.store(monitor);
            console.log(`  ADDED monitor "${svc.name}" (id=${monitor.id})`);
            added++;
        }

        // Ensure group membership (idempotent)
        const membership = await R.findOne("monitor_group", " monitor_id = ? AND group_id = ? ", [
            monitor.id,
            group.id,
        ]);
        if (!membership) {
            const mg = R.dispense("monitor_group");
            mg.monitor_id = monitor.id;
            mg.group_id = group.id;
            mg.weight = 1000;
            mg.send_url = svc.sendUrl ? 1 : 0;
            await R.store(mg);
            console.log(`    linked "${svc.name}" -> group "${groupName}"`);
            linked++;
        }
    }

    console.log(`\nDone. Added ${added} monitor(s), linked ${linked}, skipped ${skipped}.`);
    console.log("IMPORTANT: restart the container to begin monitoring -> docker start uptime-kuma");
    await Database.close();
    process.exit(0);
};

main().catch((e) => {
    console.error("ERROR:", e.message);
    process.exit(1);
});
