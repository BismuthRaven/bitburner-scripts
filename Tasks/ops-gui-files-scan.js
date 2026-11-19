import { guiHelper } from 'Tasks/gui-core.js'
import { OG_PROGRAMS, OG_HELPERS } from 'Tasks/ops-gui-common.js'

const REMOTE_EXTS = [".lit", ".txt", ".msg", ".cct"];
const HOME_EXTS = [".lit", ".msg"];

/** One-shot: files on other servers (lore, text, messages, contracts), readable files on home, owned programs.
 * @param {NS} ns */
export async function main(ns) {
    await guiHelper(ns, "Files scan", () => {
        const seen = new Set(["home"]);
        const parent = new Map();
        const queue = ["home"];
        while (queue.length) { const at = queue.shift(); for (const next of ns.scan(at)) if (!seen.has(next)) { seen.add(next); parent.set(next, at); queue.push(next); } }
        const routeTo = host => { const hops = []; for (let at = host; at !== "home"; at = parent.get(at)) hops.unshift(at); return hops; };
        const homeFiles = new Set(ns.ls("home"));
        const remote = [];
        for (const host of seen) if (host !== "home")
            for (const file of ns.ls(host))
                if (REMOTE_EXTS.some(ext => file.endsWith(ext))) remote.push({ host, file, onHome: homeFiles.has(file), route: routeTo(host) });
        const remoteTxt = new Set(remote.filter(r => r.file.endsWith(".txt")).map(r => r.file));
        const solver = "Tasks/contractor.js.solver.js";
        return {
            key: "files", data: {
                remote,
                home: [...homeFiles].filter(f => HOME_EXTS.some(ext => f.endsWith(ext)) || remoteTxt.has(f)).sort(),
                programs: Object.fromEntries(OG_PROGRAMS.map(([file]) => [file, ns.fileExists(file, "home")])),
                tor: seen.has("darkweb"),
                hackLevel: ns.getHackingLevel(),
                money: ns.getServerMoneyAvailable("home"),
                ramOf: Object.fromEntries([...Object.values(OG_HELPERS), "Tasks/contractor.js", solver].map(f => [f, ns.getScriptRam(f, "home")])),
            }
        };
    });
}
