import { guiHelper } from 'Tasks/gui-core.js'

/** One-shot: upgrade costs (x1 and x10 levels, x1 RAM, x1 core) for every hacknet node. Split from the
 * stats scan to keep each helper small (every hacknet function costs 0.5 GB).
 * @param {NS} ns */
export async function main(ns) {
    await guiHelper(ns, "Hacknet costs", () => {
        const costs = [];
        for (let i = 0; i < ns.hacknet.numNodes(); i++) costs.push({
            level1: ns.hacknet.getLevelUpgradeCost(i, 1),
            level10: ns.hacknet.getLevelUpgradeCost(i, 10),
            ram: ns.hacknet.getRamUpgradeCost(i, 1),
            cores: ns.hacknet.getCoreUpgradeCost(i, 1),
        });
        return { key: "hacknetCosts", data: costs };
    });
}
