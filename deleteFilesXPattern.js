/** @param {NS} ns  usage: run rmdot.js [dir] [--dry] */
export async function main(ns) {
  const dry = ns.args.includes("--dry");
  const dir = (ns.args.find(a => a !== "--dry") ?? "").replace(/^\/+|\/+$/g, "");
  const prefix = dir ? dir + "/" : "";
  for (const f of ns.ls(ns.getHostname())) {
    const p = f.replace(/^\/+/, "");
    if (!p.startsWith(prefix)) continue;
    // any path segment below the starting dir that begins with "."
    if (!p.slice(prefix.length).split("/").some(s => s.startsWith("."))) continue;
    ns.tprint(`${dry ? "would delete" : "deleting"}: ${f}`);
    if (!dry) ns.rm(f);
  }
}