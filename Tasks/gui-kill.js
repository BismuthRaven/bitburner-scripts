import { guiHelper } from 'Tasks/gui-core.js'

/** One-shot (shared by the GUI panels): kill the given pids.
 * @param {NS} ns */
export async function main(ns) {
    await guiHelper(ns, "Stop", pids => {
        const stopped = pids.filter(pid => ns.kill(Number(pid))).length;
        return `Stopped ${stopped}/${pids.length} script(s)`;
    });
}
