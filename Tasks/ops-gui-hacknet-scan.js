import { guiHelper } from 'Tasks/gui-core.js'

/** One-shot: hacknet node stats and the cost of a new node.
 * @param {NS} ns */
export async function main(ns) {
    await guiHelper(ns, "Hacknet scan", () => {
        const count = ns.hacknet.numNodes();
        const nodes = [];
        for (let i = 0; i < count; i++) nodes.push(ns.hacknet.getNodeStats(i));
        return {
            key: "hacknet", data: {
                nodes,
                maxNodes: Number.isFinite(ns.hacknet.maxNumNodes()) ? ns.hacknet.maxNumNodes() : null, // null = unlimited (Infinity doesn't survive JSON)
                nodeCost: ns.hacknet.getPurchaseNodeCost(),
                money: ns.getServerMoneyAvailable("home"),
            }
        };
    });
}
