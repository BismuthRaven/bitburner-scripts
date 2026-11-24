import { guiHelper } from 'Tasks/gui-core.js'
import { HG_COPY_FILES } from 'Tasks/host-gui-common.js'

/** One-shot: copy the ex-host-gui worker scripts to each host in args.
 * @param {NS} ns */
export async function main(ns) {
    await guiHelper(ns, "Copy", args => {
        const hosts = args.map(String);
        const failed = hosts.filter(host => !ns.scp(HG_COPY_FILES, host, "home"));
        return `Copied workers to ${hosts.length - failed.length}/${hosts.length} host(s)` + (failed.length ? ` (failed: ${failed.join(", ")})` : "");
    });
}
