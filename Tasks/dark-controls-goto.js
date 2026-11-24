import { guiHelper } from 'Tasks/gui-core.js'
import { connectAlong, installBackdoorHere, connectHome } from 'helpers-gui.js'
import { liveRoute } from 'darknet/darknet-route.js'
import { CACHE_WORKER } from 'darknet/darknet-paths.js'

const CONTRACTOR = "Tasks/contractor.js";
const READ_LIMIT = 400;

/** One-shot, run when a dark-controls.js action is clicked. Uses Netscript only (no terminal typing); the target is
 * looked up live because darknet links change all the time.
 * args: [stateFile, target, action, file] - action: connect (move the player's current server there, like the terminal's
 * connect), ls, backdoor, contract (solve the coding contracts there), cache (open `file`), read (show `file`).
 * @param {NS} ns */
export async function main(ns) {
    await guiHelper(ns, "Go to host", async ([stateFile, target, action = "connect", file = ""]) => {
        const need = () => {
            if (!ns.serverExists(target)) throw new Error(`${target} doesn't exist (or has vanished)`);
            if (!ns.dnet.getServerDetails(target).isOnline) throw new Error(`${target} is offline right now`);
        };
        const route = () => {
            const { route, problem } = liveRoute(ns, target, stateFile);
            if (!route) throw new Error(problem);
            return route;
        };
        const hopAlong = async hops => {
            const broken = await connectAlong(ns, hops);
            if (broken !== -1) throw new Error(`the route broke at ${hops[broken]}`);
        };

        if (action === "connect") {
            await hopAlong(route());
            return `Connected to ${target}`;
        }
        if (action === "backdoor") {
            await hopAlong(route());
            try { await installBackdoorHere(ns); }
            finally { await connectHome(ns).catch(() => { }); }
            return `Backdoor installed on ${target}`;
        }
        need();
        if (action === "ls") return `${target}: ${ns.ls(target).join(", ") || "no files"}`;
        if (action === "contract") {
            if (!ns.run(CONTRACTOR, 1, target)) throw new Error(`couldn't start ${CONTRACTOR} (not enough free RAM on home?)`);
            return `Solving the coding contracts on ${target} (${CONTRACTOR})`;
        }
        if (action === "cache") {
            await ns.scp(CACHE_WORKER, target, "home");
            if (!ns.exec(CACHE_WORKER, target, 1, file)) throw new Error(`couldn't start ${CACHE_WORKER} on ${target} (RAM or no session?)`);
            return `Opening ${file} on ${target}; its crawler reports the reward`;
        }
        if (action === "read") {
            if (!ns.scp(file, "home", target)) throw new Error(`couldn't copy ${file} from ${target}`);
            if (file.endsWith(".lit")) return `Copied ${file} to home (scripts can't read .lit text; open it in the Terminal with: cat ${file})`;
            const text = ns.read(file).replace(/\s+/g, " ").trim();
            return `${file}: ${text.length > READ_LIMIT ? text.slice(0, READ_LIMIT) + "..." : text}`;
        }
        throw new Error(`unknown action ${action}`);
    });
}
