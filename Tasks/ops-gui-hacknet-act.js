import { guiHelper } from 'Tasks/gui-core.js'

/** One-shot: buy a hacknet node or upgrade one. args: [action ("buy"|"level"|"ram"|"cores"), index, count]
 * @param {NS} ns */
export async function main(ns) {
    await guiHelper(ns, "Hacknet", ([action, index = 0, count = 1]) => {
        const hn = ns.hacknet;
        if (action === "buy") {
            const id = hn.purchaseNode();
            return id >= 0 ? `Bought hacknet-node-${id}` : "Could not buy a hacknet node - not enough money?";
        }
        const ok = action === "level" ? hn.upgradeLevel(index, count)
            : action === "ram" ? hn.upgradeRam(index, count)
                : action === "cores" ? hn.upgradeCore(index, count) : false;
        return ok ? `hacknet-node-${index}: +${count} ${action}` : `hacknet-node-${index}: could not upgrade ${action} (money or max reached)`;
    });
}
