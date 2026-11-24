import { guiHelper } from 'Tasks/gui-core.js'
import { OG_HELPERS } from 'Tasks/ops-gui-common.js'

/** One-shot: purchased (cloud) servers, buy costs per RAM size and upgrade costs per server.
 * @param {NS} ns */
export async function main(ns) {
    await guiHelper(ns, "Servers scan", () => {
        const ramLimit = ns.cloud.getRamLimit();
        const sizes = [];
        for (let ram = 2; ram <= ramLimit; ram *= 2) sizes.push(ram);
        const finite = pairs => Object.fromEntries(pairs.filter(([, c]) => Number.isFinite(c))); // Infinity would become null in JSON
        const servers = ns.cloud.getServerNames().map(host => {
            const maxRam = ns.getServerMaxRam(host);
            return {
                host, maxRam,
                usedRam: ns.getServerUsedRam(host),
                procs: ns.ps(host).length,
                upgrades: finite(sizes.filter(r => r > maxRam).map(r => [r, ns.cloud.getServerUpgradeCost(host, r)])),
            };
        });
        return {
            key: "cloud", data: {
                servers, ramLimit,
                limit: ns.cloud.getServerLimit(),
                money: ns.getServerMoneyAvailable("home"),
                buyCosts: finite(sizes.map(r => [r, ns.cloud.getServerCost(r)])),
                ramOf: Object.fromEntries(Object.values(OG_HELPERS).map(f => [f, ns.getScriptRam(f, "home")])),
            }
        };
    });
}
