import { guiHelper } from 'Tasks/gui-core.js'

/** One-shot: upgrade a cloud server's RAM. args: [host, ram]
 * @param {NS} ns */
export async function main(ns) {
    await guiHelper(ns, "Upgrade server", ([host, ram]) =>
        ns.cloud.upgradeServer(String(host), Number(ram)) ? `Upgraded ${host} to ${ram} GB` : `Could not upgrade ${host} to ${ram} GB - not enough money?`);
}
