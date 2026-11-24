import { getConfiguration } from './helpers.js'
import { runTerminalCommand } from './helpers-gui.js'
import { liveRoute, routeCommand, STATE_FILE } from './darknet/darknet-route.js'

/**
 * Connects the terminal to a darknet server by a route looked up live (links change all the time, so routes aren't
 * cached). Usage: ex-dark-connect <host> [command to run there...]   e.g.  ex-dark-connect alpha   |   ex-dark-connect alpha backdoor
 * --test only prints the route (a quick routing check), without touching the terminal.
 */
const argsSchema = [
    ['test', false], // only print the route, don't connect
    ['state-file', STATE_FILE], // where darknet-coordinator.js saves the neighbour reports
];

export function autocomplete(data, _) {
    data.flags(argsSchema);
    return [];
}

/** @param {NS} ns */
export async function main(ns) {
    const options = getConfiguration(ns, argsSchema);
    if (!options) return; // invalid args or config file; getConfiguration has already explained why
    const [target, ...rest] = options._.map(String);
    if (!target) return ns.tprint(`Usage: run ${ns.getScriptName()} <darknet host> [command to run there] [--test]`);
    if (ns.getHostname() !== "home") return ns.tprint(`ERROR: run this from home (it probes home's neighbours).`);
    let found;
    try {
        found = liveRoute(ns, target, options['state-file']);
    } catch (err) {
        return ns.tprint(`ERROR: route lookup failed (is DarkscapeNavigator.exe owned?): ${err?.message ?? err}`);
    }
    const { route, problem, jumps } = found;
    if (!route) return ns.tprint(`WARNING: ${problem}.`);
    const path = ["home", ...route].map((n, i) => i > 0 && jumps.includes(n) ? `⇒ ${n}` : i > 0 ? `> ${n}` : n).join(" ");
    const summary = `${target}: ${route.length} hop(s): ${path}${jumps.length ? "   (⇒ = direct jump to a backdoored / stasis-linked server)" : ""}`;
    if (options.test) return ns.tprint(summary);
    const command = routeCommand(route, rest.join(" "));
    try {
        await runTerminalCommand(ns, command);
    } catch (err) {
        ns.tprint(`${summary}\nWARNING: couldn't type into the terminal (${err?.message ?? err}). Run it yourself:\n${command}`);
    }
}
