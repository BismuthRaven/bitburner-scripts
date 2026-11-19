import { guiHelper } from 'Tasks/gui-core.js'

/** One-shot: open all ports we have programs for and nuke each host in args.
 * @param {NS} ns */
export async function main(ns) {
    await guiHelper(ns, "Root", hosts => {
        const has = file => ns.fileExists(file, "home");
        return hosts.map(String).map(host => {
            if (has("BruteSSH.exe")) ns.brutessh(host);
            if (has("FTPCrack.exe")) ns.ftpcrack(host);
            if (has("relaySMTP.exe")) ns.relaysmtp(host);
            if (has("HTTPWorm.exe")) ns.httpworm(host);
            if (has("SQLInject.exe")) ns.sqlinject(host);
            try { ns.nuke(host); } catch { }
            return ns.hasRootAccess(host) ? `rooted ${host}` : `FAILED ${host}`;
        }).join(", ");
    });
}
