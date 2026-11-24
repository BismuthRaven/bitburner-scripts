import { guiHelper } from 'Tasks/gui-core.js'

/** One-shot: buy a cloud server. args: [name, ram]
 * @param {NS} ns */
export async function main(ns) {
    await guiHelper(ns, "Buy server", ([name, ram]) => {
        const host = ns.cloud.purchaseServer(String(name), Number(ram));
        return host ? `Bought ${host} (${ram} GB)` : `Could not buy ${name} (${ram} GB) - not enough money or at the server limit`;
    });
}
