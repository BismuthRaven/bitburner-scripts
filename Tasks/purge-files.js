/**
 * Deletes files from home. The VS Code sync extension never erases on delete - it moves the file to /trashbin/<path>
 * (and only for deletes made through the VS Code UI), so use this to finish the job in-game.
 *   run Tasks/purge-files.js --trashbin               empties /trashbin
 *   run Tasks/purge-files.js darknet.js foo/bar.txt   removes exact files (leading slash optional)
 *   add --dry-run to only list what would be removed
 * @param {NS} ns */
export async function main(ns) {
    const flags = ns.flags([["trashbin", false], ["dry-run", false]]);
    const targets = new Set(flags._.map(f => String(f).replace(/^\//, "")));
    if (flags.trashbin)
        ns.ls("home", "trashbin/").forEach(f => targets.add(f.replace(/^\//, "")));
    if (!targets.size) return ns.tprint("Nothing to do. Pass file names and/or --trashbin (add --dry-run to preview).");

    let removed = 0, failed = 0;
    for (const file of targets) {
        if (!ns.fileExists(file, "home")) { ns.tprint(`Missing: ${file}`); continue; }
        if (flags["dry-run"]) { ns.tprint(`Would remove: ${file}`); continue; }
        if (ns.rm(file, "home")) { removed++; ns.tprint(`Removed: ${file}`); }
        else { failed++; ns.tprint(`ERROR: Failed to remove ${file} (still running?)`); }
    }
    if (!flags["dry-run"]) ns.tprint(`${failed ? "WARNING" : "SUCCESS"}: removed ${removed}, failed ${failed}.`);
}

export function autocomplete(data) {
    data.flags([["trashbin", false], ["dry-run", false]]);
    return [];
}
