import { guiHelper } from 'Tasks/gui-core.js'
import { connectAlong } from 'helpers-gui.js'

/** One-shot (shared by the GUI panels): move the player's current server (what the terminal shows) to the end of the route
 * with singularity.connect. args: hostnames after home, in order.
 * @param {NS} ns */
export async function main(ns) {
    await guiHelper(ns, "Connect", async route => {
        const broken = await connectAlong(ns, route);
        if (broken !== -1) throw new Error(`the route broke at ${route[broken]}`);
        return `Connected to ${route.at(-1) ?? "home"}`;
    });
}
