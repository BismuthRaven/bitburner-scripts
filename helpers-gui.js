// GUI-only helpers. Not shipped with the shared repo. The control-file pieces below duplicate helpers.js on purpose,
// so helpers.js stays untouched.

import { getNsDataThroughFile } from './helpers.js'

// Live on/off switches for autopilot/daemon sub-modules, edited by autopilot-gui.js. Kept outside /Temp so cleanup.js and resets keep it.
export const CONTROL_FILE = "ex-autopilot-gui-state.txt";
export const AUTOPILOT_STATUS_FILE = "/Temp/autopilot-status.txt";
export const DAEMON_STATUS_FILE = "/Temp/daemon-status.txt";

/** True unless the module id is listed as disabled in CONTROL_FILE (missing/corrupt file = everything enabled). 0 GB.
 * @param {NS} ns @param {string} id */
export function isModuleEnabled(ns, id) {
    try { return !(JSON.parse(ns.read(CONTROL_FILE) || "{}").disabled ?? []).includes(id); }
    catch { return true; }
}

const TERMINAL_NAV_XPATH = "//div[(@role = 'button') and (contains(., 'Terminal'))]"; // sidebar entry (as in casino.js)

/** True while the player may be typing: the terminal input has focus or holds text. 0 GB (DOM via globalThis). */
export function isTerminalInUse() {
    const doc = globalThis["document"];
    const input = doc?.getElementById("terminal-input");
    return !!input && (input.value !== "" || doc.activeElement === input);
}

/** Types a command into the game's terminal and presses Enter, switching to the Terminal page first if another page is
 * shown. Chains like "home;connect a;connect b" work. 0 GB: `document` is reached via globalThis (the bare identifier
 * costs 25 GB). Throws if the terminal can't be reached.
 * @param {NS} ns @param {string} command */
export async function runTerminalCommand(ns, command) {
    const doc = globalThis["document"];
    let input = doc.getElementById("terminal-input");
    if (!input) {
        const nav = doc.evaluate(TERMINAL_NAV_XPATH, doc, null, 9 /* FIRST_ORDERED_NODE_TYPE */, null).singleNodeValue;
        if (!nav) throw new Error("couldn't find the Terminal entry in the sidebar");
        await nav[Object.keys(nav)[1]].onClick({ isTrusted: true });
        for (let i = 0; i < 40 && !input; i++) {
            await ns.sleep(50);
            input = doc.getElementById("terminal-input");
        }
        if (!input) throw new Error("the terminal did not open");
    }
    const handlers = input[Object.keys(input)[1]]; // React props of the game's input element
    input.value = command;
    handlers.onChange({ target: input });
    input.focus();
    await handlers.onKeyDown({ key: "Enter", preventDefault: () => 0 });
}

// Singularity "terminal" moves. Without SF4.3 each call costs 32 GB and the player's location persists between scripts,
// so every step runs in its own temp script (peak RAM = one call).

/** Moves the player's current server along `route` (hostnames after home) with singularity.connect, starting from home.
 * Returns the index of the first hop that couldn't be connected, or -1 when the whole route worked.
 * @param {NS} ns @param {string[]} route */
export async function connectAlong(ns, route) {
    return await getNsDataThroughFile(ns, '(ns.singularity.connect("home"), ns.args.findIndex((hop) => !ns.singularity.connect(hop)))',
        "/Temp/connect-along.txt", route);
}

/** Installs a backdoor on the player's current server (move there with connectAlong first). @param {NS} ns */
export async function installBackdoorHere(ns) {
    await getNsDataThroughFile(ns, "(await ns.singularity.installBackdoor(), true)", "/Temp/install-backdoor-here.txt");
}

/** Moves the player's current server back home. @param {NS} ns */
export async function connectHome(ns) {
    await getNsDataThroughFile(ns, 'ns.singularity.connect("home")', "/Temp/connect-home.txt");
}

