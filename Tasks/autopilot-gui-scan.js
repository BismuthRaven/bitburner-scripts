import { guiHelper } from 'Tasks/gui-core.js'
import { CONTROL_FILE, AUTOPILOT_STATUS_FILE, DAEMON_STATUS_FILE } from 'helpers-gui.js'
import { CG_MODULES, CG_ORCHESTRATORS, CG_WORKERS } from 'Tasks/autopilot-gui-common.js'

const parse = text => { try { return text ? JSON.parse(text) : null; } catch { return null; } };

/** One-shot: control switches, autopilot/daemon status snapshots and which module scripts / workers run where.
 * @param {NS} ns */
export async function main(ns) {
    await guiHelper(ns, "Control scan", () => {
        const watched = new Set([...CG_ORCHESTRATORS, ...CG_MODULES.flatMap(m => m.scripts ?? [])]);
        const workerKind = Object.fromEntries(Object.entries(CG_WORKERS).flatMap(([kind, files]) => files.map(f => [f, kind])));
        const procs = [], workers = { hack: { procs: 0, threads: 0 }, share: { procs: 0, threads: 0 } };
        const seen = new Set(["home"]), queue = ["home"];
        while (queue.length) {
            const host = queue.shift();
            for (const p of ns.ps(host)) {
                const file = p.filename.replace(/^\//, "");
                if (watched.has(file)) procs.push({ pid: p.pid, host, file, args: p.args.map(String) });
                else if (workerKind[file]) { workers[workerKind[file]].procs++; workers[workerKind[file]].threads += p.threads; }
            }
            for (const next of ns.scan(host)) if (!seen.has(next)) { seen.add(next); queue.push(next); }
        }
        const self = ns.getScriptRam(ns.getScriptName(), "home");
        return {
            key: "ctl", data: {
                money: ns.getServerMoneyAvailable("home"),
                reserve: Number(ns.read("MachineState/CashReserve.txt") || 0),
                disabled: parse(ns.read(CONTROL_FILE))?.disabled ?? [],
                ap: parse(ns.read(AUTOPILOT_STATUS_FILE)),
                d: parse(ns.read(DAEMON_STATUS_FILE)),
                procs, workers,
                homeFree: ns.getServerMaxRam("home") - ns.getServerUsedRam("home") + self,
                ramOf: Object.fromEntries(CG_ORCHESTRATORS.map(f => [f, ns.getScriptRam(f, "home")])),
            }
        };
    });
}
