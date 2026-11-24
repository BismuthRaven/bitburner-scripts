import { guiHelper } from 'Tasks/gui-core.js'

/** One-shot: copy .lit and .txt files from every server to home (.msg and .cct files cannot be copied by scripts).
 * @param {NS} ns */
export async function main(ns) {
    await guiHelper(ns, "Collect files", () => {
        const seen = new Set(["home"]);
        const queue = ["home"];
        while (queue.length) for (const next of ns.scan(queue.shift())) if (!seen.has(next)) { seen.add(next); queue.push(next); }
        const have = new Set(ns.ls("home"));
        let copied = 0;
        for (const host of seen) if (host !== "home") {
            const files = ns.ls(host).filter(f => (f.endsWith(".lit") || f.endsWith(".txt")) && !have.has(f));
            if (files.length && ns.scp(files, "home", host)) { copied += files.length; files.forEach(f => have.add(f)); }
        }
        return copied ? `Collected ${copied} file(s) to home` : "No new .lit/.txt files to collect";
    });
}
