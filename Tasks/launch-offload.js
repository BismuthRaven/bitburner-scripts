import { scanAllServers } from 'helpers.js'

/** Offload a script onto a rooted non-home server with enough free RAM, falling back to home.
 * Copies the script and helpers.js if needed. Usage: run /Tasks/launch-offload.js <script> [args...]
 * Prints JSON `{ host, pid }` to /Temp/launch-offload.txt.
 * @param {NS} ns */
export async function main(ns) {
    const [script, ...args] = ns.args;
    if (!script) return;
    const cost = ns.getScriptRam(script, 'home');
    const candidates = scanAllServers(ns)
        .filter(h => h !== 'home' && !h.startsWith('hacknet-') && ns.hasRootAccess(h))
        .map(h => ({ host: h, free: ns.getServerMaxRam(h) - ns.getServerUsedRam(h) }))
        .filter(c => c.free >= cost)
        .sort((a, b) => b.free - a.free);

    let host = 'home';
    if (candidates.length > 0) {
        host = candidates[0].host;
        const deps = [script, 'helpers.js'].filter(f => ns.fileExists(f, 'home') && !ns.fileExists(f, host));
        if (deps.length > 0) await ns.scp(deps, host, 'home');
    }
    const pid = ns.exec(script, host, { threads: 1, temporary: false }, ...args);
    ns.write('/Temp/launch-offload.txt', JSON.stringify({ host, pid }), 'w');
}
