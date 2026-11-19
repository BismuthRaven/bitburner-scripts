/** @param {NS} ns */
export async function main(ns) {
  // Stop all other running scripts on home first
  ns.killall("home", true);

  const excludedExtensions = [".exe"];
  const myName = ns.getScriptName();
  const files = ns.ls("home");

  for (const file of files) {
    const excluded = excludedExtensions.some((ext) => file.endsWith(ext));
    if (file !== myName && !excluded) {
      ns.rm(file, "home");
      ns.tprint(`Deleted: ${file}`);
    }
  }

  ns.tprint("Cleanup complete. Run 'rm clean.js' to remove this script.");
}