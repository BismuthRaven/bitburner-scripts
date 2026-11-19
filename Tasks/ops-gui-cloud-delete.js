import { guiHelper } from 'Tasks/gui-core.js'

/** One-shot: kill everything on a cloud server and delete it. args: [host]
 * @param {NS} ns */
export async function main(ns) {
    await guiHelper(ns, "Delete server", ([host]) => {
        ns.killall(String(host));
        return ns.cloud.deleteServer(String(host)) ? `Deleted ${host}` : `Could not delete ${host}`;
    });
}
