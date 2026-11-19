import { guiHelper } from 'Tasks/gui-core.js'
import { HG_HELPERS, HG_WORKERS, HG_TAG } from 'Tasks/host-gui-common.js'

const PORT_OPENER_FILES = ["BruteSSH.exe", "FTPCrack.exe", "relaySMTP.exe", "HTTPWorm.exe", "SQLInject.exe"];

/** One-shot: snapshot every host for host-gui.js.
 * @param {NS} ns */
export async function main(ns) {
    await guiHelper(ns, "Scan", () => {
        const paths = { home: [] };
        const queue = ["home"];
        while (queue.length) {
            const from = queue.shift();
            for (const next of ns.scan(from))
                if (!(next in paths)) { paths[next] = [...paths[from], next]; queue.push(next); }
        }
        const modeByFile = Object.fromEntries(Object.entries(HG_WORKERS).map(([mode, file]) => [file, mode]));
        const self = ns.getHostname();
        const ownRam = ns.getScriptRam(ns.getScriptName(), self); // Don't count this short-lived helper as used RAM
        const hosts = Object.keys(paths).map(host => {
            const maxMoney = ns.getServerMaxMoney(host);
            return {
                host, maxMoney, path: paths[host],
                rooted: ns.hasRootAccess(host),
                reqPorts: ns.getServerNumPortsRequired(host),
                reqLevel: ns.getServerRequiredHackingLevel(host),
                maxRam: ns.getServerMaxRam(host),
                usedRam: ns.getServerUsedRam(host) - (host === self ? ownRam : 0),
                money: ns.getServerMoneyAvailable(host),
                sec: ns.getServerSecurityLevel(host),
                minSec: ns.getServerMinSecurityLevel(host),
                weakenTime: maxMoney ? ns.getWeakenTime(host) : 0,
                workers: ns.ps(host)
                    .filter(p => modeByFile[p.filename] && (p.filename === HG_WORKERS.auto || p.args[3] === HG_TAG))
                    .map(p => ({ pid: p.pid, mode: modeByFile[p.filename], target: p.args[0], threads: p.threads })),
            };
        });
        const ramOf = Object.fromEntries([...Object.values(HG_HELPERS), ...Object.values(HG_WORKERS)].map(f => [f, ns.getScriptRam(f, "home")]));
        return {
            key: "hosts", data: {
                hosts, ramOf,
                hackLevel: ns.getHackingLevel(),
                openers: PORT_OPENER_FILES.filter(f => ns.fileExists(f, "home")).length,
            }
        };
    });
}
