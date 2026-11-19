import { guiHelper } from 'Tasks/gui-core.js'

/** One-shot: copy a worker to a host and start it with a share of the host's free RAM.
 * args (after reply port): [host, threadFraction (0 = 1 thread), reserveGb, script, ...scriptArgs]
 * @param {NS} ns */
export async function main(ns) {
    await guiHelper(ns, "Start worker", ([host, fraction, reserveGb, script, ...scriptArgs]) => {
        if (host !== "home" && !ns.scp(script, host, "home")) return `${host}: could not copy ${script}`;
        const scriptRam = ns.getScriptRam(script, "home");
        if (!scriptRam) return `${script} not found on home`;
        const free = ns.getServerMaxRam(host) - ns.getServerUsedRam(host);
        // On home this helper's RAM frees up when it exits, so it counts toward the reserve but not toward what fits now
        const ownRam = host === "home" ? ns.getScriptRam(ns.getScriptName(), "home") : 0;
        const maxThreads = Math.min(Math.floor((free + ownRam - reserveGb) / scriptRam), Math.floor(free / scriptRam));
        if (maxThreads < 1) return `${host}: not enough free RAM (${Math.max(0, free + ownRam - reserveGb).toFixed(2)} GB usable, need ${scriptRam} GB)`;
        const threads = fraction > 0 ? Math.max(1, Math.floor(maxThreads * fraction)) : 1;
        const pid = ns.exec(script, host, threads, ...scriptArgs);
        return pid ? `${host}: ${scriptArgs[1] === "auto" ? "auto loop" : script.split("/").pop()} -> ${scriptArgs[0]} x${threads}`
            : `${host}: exec failed`;
    });
}
