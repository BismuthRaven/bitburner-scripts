import { guiHelper } from 'Tasks/gui-core.js'
import { CG_WORKERS } from 'Tasks/autopilot-gui-common.js'

/** One-shot: kill daemon's worker scripts of the given kinds (hack, share) on every server.
 * @param {NS} ns */
export async function main(ns) {
    await guiHelper(ns, "Stop workers", kinds => {
        const files = new Set(kinds.flatMap(k => CG_WORKERS[k] ?? []));
        let stopped = 0;
        const seen = new Set(["home"]), queue = ["home"];
        while (queue.length) {
            const host = queue.shift();
            for (const p of ns.ps(host))
                if (files.has(p.filename.replace(/^\//, "")) && ns.kill(p.pid)) stopped++;
            for (const next of ns.scan(host)) if (!seen.has(next)) { seen.add(next); queue.push(next); }
        }
        return `Stopped ${stopped} ${kinds.join("/")} worker script(s)`;
    });
}
