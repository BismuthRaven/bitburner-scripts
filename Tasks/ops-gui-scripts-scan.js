import { guiHelper } from 'Tasks/gui-core.js'
import { OG_SCRIPTS } from 'Tasks/ops-gui-common.js'

/** One-shot: RAM cost and running instances (on home) of the scripts listed in the Scripts tab.
 * @param {NS} ns */
export async function main(ns) {
    await guiHelper(ns, "Scripts scan", () => {
        const procs = ns.ps("home");
        const homeFree = ns.getServerMaxRam("home") - ns.getServerUsedRam("home") + ns.getScriptRam(ns.getScriptName(), "home");
        return {
            key: "scripts", data: {
                homeFree,
                scripts: OG_SCRIPTS.map(([file]) => ({
                    file,
                    exists: ns.fileExists(file, "home"),
                    ram: ns.getScriptRam(file, "home"),
                    running: procs.filter(p => p.filename === file).map(p => ({ pid: p.pid, args: p.args })),
                })),
            }
        };
    });
}
