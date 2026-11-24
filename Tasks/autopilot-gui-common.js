// Shared constants for autopilot-gui.js and its one-shot helpers (Tasks/autopilot-gui-*.js).
// Module ids must match the isModuleEnabled(ns, id) checks in autopilot.js / daemon.js.
export const CG_PORT = 7173;
export const CG_OWNER_FILE = "/Temp/ex-autopilot-gui-owner.txt";
export const CG_HELPERS = {
    info: "Tasks/autopilot-gui-scan.js",
    stopWorkers: "Tasks/autopilot-gui-stop-workers.js",
    killer: "Tasks/gui-kill.js",
};
export const CG_ORCHESTRATORS = ["autopilot.js", "daemon.js"];
export const CG_WORKERS = {
    hack: ["Remote/hack-target.js", "Remote/grow-target.js", "Remote/weak-target.js", "Remote/manualhack-target.js"],
    share: ["Remote/share.js"],
};

/** Switchable sub-modules. by: who launches/acts (AP = autopilot.js, D = daemon.js). scripts: what counts as "running".
 * workers: daemon worker kind (CG_WORKERS) instead of scripts. */
export const CG_MODULES = [
    // Autopilot decisions
    { id: "ap-daemon", group: "Autopilot decisions", label: "Manage daemon", by: ["AP"], scripts: ["daemon.js"], desc: "Start daemon.js and relaunch it whenever its wanted mode changes (early / tight / xp-only). Off = you start/stop daemon yourself." },
    { id: "ap-xp-mode", group: "Autopilot decisions", label: "XP-mode switching", by: ["AP"], desc: "Relaunch daemon in --xp-only every 55 min for 5 min for hack XP. Off = only the 'no hack income in this BN' case still uses --xp-only." },
    { id: "ap-buy-augs", group: "Autopilot decisions", label: "Auto-buy augs", by: ["AP"], desc: "Buy affordable augmentations once the batch threshold is met (even if 'Auto-install augs' is off). Off = install only already-purchased augs." },
    { id: "ap-install-augs", group: "Autopilot decisions", label: "Auto-install augs", by: ["AP"], desc: "Reserve money and run ascend.js (soft reset to install augs) once enough augs are ready. Off = buy augs without resetting." },
    { id: "ap-destroy-bn", group: "Autopilot decisions", label: "Auto-destroy BitNode", by: ["AP"], desc: "Destroy w0r1d_d43m0n and jump to the next BN as soon as a win condition is met." },
    { id: "ap-casino", group: "Autopilot decisions", label: "Casino run", by: ["AP"], scripts: ["casino.js"], desc: "Kills daemon + work, travels to Aevum and wins $10b at blackjack (takes over the UI, reloads the game)." },
    { id: "ap-daedalus", group: "Autopilot decisions", label: "Rush Daedalus", by: ["AP"], desc: "Hold $100b cash (liquidating stocks) and favour hack XP to get the Daedalus invite sooner." },
    { id: "ap-reserve", group: "Autopilot decisions", label: "Stock cash reserve", by: ["AP"], desc: "Keep MachineState/CashReserve.txt at up to 80% of cash / $8b so money goes to stocks. Off = MachineState/CashReserve.txt is yours (edit it above)." },
    { id: "stanek", group: "Autopilot decisions", label: "Stanek's Gift", by: ["AP"], scripts: ["stanek.js"], desc: "Accept the gift early (if not penalised) and charge fragments with stanek.js after each reset." },
    // Long-running feature scripts
    { id: "stockmaster", group: "Feature scripts", label: "Stock trading", by: ["AP", "D"], scripts: ["stockmaster.js"], desc: "Buys/sells stocks (stockmaster.js)." },
    { id: "work-for-factions", group: "Feature scripts", label: "Work for factions", by: ["AP", "D"], scripts: ["work-for-factions.js"], desc: "Takes your FOCUS: crime, faction and company work, joins factions (work-for-factions.js, SF4)." },
    { id: "gangs", group: "Feature scripts", label: "Gang", by: ["AP", "D"], scripts: ["gangs.js"], desc: "Recruits, equips and ascends gang members, territory warfare (gangs.js, SF2)." },
    { id: "sleeve", group: "Feature scripts", label: "Sleeves", by: ["AP", "D"], scripts: ["sleeve.js"], desc: "Assigns sleeve tasks and buys their augs (sleeve.js, SF10)." },
    { id: "spend-hashes", group: "Feature scripts", label: "Spend hashes", by: ["AP", "D"], scripts: ["spend-hacknet-hashes.js"], desc: "Spends hacknet hashes; autopilot also boosts the best hack server with them (SF9)." },
    { id: "bladeburner", group: "Feature scripts", label: "Bladeburner", by: ["D"], scripts: ["bladeburner.js"], desc: "Joins and runs Bladeburner actions (bladeburner.js, SF7)." },
    { id: "go", group: "Feature scripts", label: "IPvGO", by: ["D"], scripts: ["go.js"], desc: "Plays IPvGO for the faction bonuses (go.js)." },
    { id: "stats", group: "Feature scripts", label: "HUD stats", by: ["D"], scripts: ["stats.js"], desc: "Extra stats in the overview HUD (stats.js)." },
    { id: "darknet", group: "Feature scripts", label: "Darknet", by: ["AP"], scripts: ["darknet-daemon.js", "darknet/darknet-coordinator.js"], desc: "After the casino decision, with ~9 GB free on home: runs darknet-daemon.js --hand-off (coordinator + worm on darkweb, then it exits; the coordinator and worms carry on). Restarted if they die." },
    // Periodic one-shot purchases / chores
    { id: "tor", group: "Daemon periodic", label: "Buy TOR", by: ["D"], scripts: ["Tasks/tor-manager.js"], desc: "Buys the TOR router (SF4)." },
    { id: "programs", group: "Daemon periodic", label: "Buy programs", by: ["D"], scripts: ["Tasks/program-manager.js"], desc: "Buys port crackers from the darkweb (SF4)." },
    { id: "contracts", group: "Daemon periodic", label: "Solve contracts", by: ["D"], scripts: ["Tasks/contractor.js"], desc: "Finds and solves coding contracts." },
    { id: "hacknet", group: "Daemon periodic", label: "Hacknet upgrades", by: ["D"], scripts: ["hacknet-upgrade-manager.js"], desc: "Buys hacknet nodes/upgrades with a good payoff time." },
    { id: "home-ram", group: "Daemon periodic", label: "Home RAM", by: ["D"], scripts: ["Tasks/ram-manager.js"], desc: "Spends ~50% of spare cash on home RAM upgrades (SF4)." },
    { id: "faction-manager", group: "Daemon periodic", label: "Join factions / aug plan", by: ["D"], scripts: ["faction-manager.js"], desc: "Joins useful factions and works out affordable augs (autopilot's install decision reads this)." },
    { id: "servers", group: "Daemon periodic", label: "Buy servers", by: ["D"], scripts: ["host-manager.js"], desc: "Buys/upgrades purchased servers from a share of hack income." },
    { id: "backdoor", group: "Daemon periodic", label: "Backdoor servers", by: ["D"], scripts: ["Tasks/backdoor-all-servers.js"], desc: "Installs backdoors on every rooted server (SF4)." },
    { id: "sell-hashes", group: "Daemon periodic", label: "Sell hashes for $", by: ["D"], desc: "Sells hashes for money while you have under $10m (SF9)." },
    // Daemon's own work
    { id: "hacking", group: "Daemon core", label: "Hack / grow / weaken", by: ["D"], workers: "hack", desc: "Preps and batch-hacks targets, farms XP with spare RAM. Off = no new jobs (running ones finish)." },
    { id: "share", group: "Daemon core", label: "Share RAM", by: ["D"], workers: "share", desc: "Uses spare RAM for share() to boost faction rep gain." },
    { id: "root", group: "Daemon core", label: "Root servers", by: ["D"], desc: "Cracks and nukes every server as soon as you own enough port openers." },
    { id: "study", group: "Daemon core", label: "Kickstart study", by: ["D"], desc: "After a reset, travels and studies at a university to kickstart hack XP (takes your FOCUS)." },
];

const ALL = CG_MODULES.map(m => m.id);
const keep = ids => ALL.filter(id => !ids.includes(id));
/** [label, disabled ids, title] */
export const CG_PRESETS = [
    ["Everything on", [], "Original autopilot/daemon behaviour"],
    ["No focus / resets", ["work-for-factions", "study", "ap-casino", "ap-install-augs", "ap-destroy-bn"],
        "Automation never takes your focus, never resets or leaves the BN"],
    ["Hacking only", keep(["ap-daemon", "hacking", "share", "root", "tor", "programs", "contracts", "servers", "home-ram", "stats"]),
        "Daemon hacks and maintains its infrastructure; everything else is up to you"],
    ["All off", ALL, "Nothing new is started; orchestrators only monitor"],
];
