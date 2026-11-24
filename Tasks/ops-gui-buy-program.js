import { guiHelper } from 'Tasks/gui-core.js'
import { getNsDataThroughFile } from 'helpers.js'

/** One-shot: buy a darkweb program with singularity.purchaseProgram (needs the TOR router). args: [program file].
 * Runs as a temp script because the call is expensive without SF4.3.
 * @param {NS} ns */
export async function main(ns) {
    await guiHelper(ns, "Buy program", async ([file]) => {
        const bought = await getNsDataThroughFile(ns, "ns.singularity.purchaseProgram(ns.args[0])", "/Temp/gui-buy-program.txt", [file]);
        if (!bought) throw new Error(`couldn't buy ${file} (TOR router, money, or already owned)`);
        return `Bought ${file}`;
    });
}
