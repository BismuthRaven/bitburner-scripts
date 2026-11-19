/** @param {NS} ns
 * Simple stepwise worker, launched by host-gui.js (runs on the host it was started on).
 * args: [target, mode = 'auto' | 'weaken' | 'grow' | 'hack', once = 0 | 1]
 * 'auto' picks weaken -> grow -> hack from the target's current state. */
export async function main(ns) {
    const [target, mode = "auto", once = 0] = ns.args;
    do {
        const op = mode === "auto" ? nextOp(ns, target) : mode;
        if (op === "weaken") await ns.weaken(target);
        else if (op === "grow") await ns.grow(target);
        else if (op === "hack") await ns.hack(target);
        else return ns.tprint(`hgw-loop: unknown mode '${mode}'`);
    } while (!once);
}

function nextOp(ns, target) {
    if (ns.getServerSecurityLevel(target) > ns.getServerMinSecurityLevel(target) + 1) return "weaken";
    if (ns.getServerMoneyAvailable(target) < ns.getServerMaxMoney(target) * 0.9) return "grow";
    return "hack";
}
