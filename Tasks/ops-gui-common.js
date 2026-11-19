// Shared constants for ops-gui.js and its one-shot helpers (Tasks/ops-gui-*.js).
export const OG_PORT = 7172;
export const OG_OWNER_FILE = "/Temp/ex-ops-gui-owner.txt";
export const OG_HELPERS = {
    cloudInfo: "Tasks/ops-gui-cloud-scan.js",
        cloudBuy: "Tasks/ops-gui-cloud-buy.js",
        cloudUpgrade: "Tasks/ops-gui-cloud-upgrade.js",
        cloudDelete: "Tasks/ops-gui-cloud-delete.js",
        hacknetInfo: "Tasks/ops-gui-hacknet-scan.js",
        hacknetCosts: "Tasks/ops-gui-hacknet-costs.js",
        hacknetAct: "Tasks/ops-gui-hacknet-act.js",
        filesInfo: "Tasks/ops-gui-files-scan.js",
        filesCollect: "Tasks/ops-gui-files-collect.js",
        scriptsInfo: "Tasks/ops-gui-scripts-scan.js",
        killer: "Tasks/gui-kill.js",
        goConnect: "Tasks/gui-connect.js",
        buyProgram: "Tasks/ops-gui-buy-program.js",
};

/** Darkweb programs: [file, price, hacking level needed to create it yourself (Create Program), description] */
export const OG_PROGRAMS = [
    ["BruteSSH.exe", 500e3, 50, "Opens SSH ports (port opener 1)"],
    ["FTPCrack.exe", 1.5e6, 100, "Opens FTP ports (port opener 2)"],
    ["relaySMTP.exe", 5e6, 250, "Opens SMTP ports (port opener 3)"],
    ["HTTPWorm.exe", 30e6, 500, "Opens HTTP ports (port opener 4)"],
    ["SQLInject.exe", 250e6, 750, "Opens SQL ports (port opener 5)"],
    ["AutoLink.exe", 1e6, 25, "Click hostnames in scan-analyze to connect"],
    ["DeepscanV1.exe", 500e3, 75, "scan-analyze depth 5"],
    ["DeepscanV2.exe", 25e6, 400, "scan-analyze depth 10"],
    ["ServerProfiler.exe", 500e3, 75, "Detailed server info"],
    ["Formulas.exe", 5e9, 1000, "Unlocks the formulas API"],
];
export const OG_TOR_COST = 200e3;

/** Repo scripts offered in the Scripts tab: [file, args, description]. You decide when to start/stop them. */
export const OG_SCRIPTS = [
    ["stats.js", [], "Extra stats in the HUD (income, karma, ...)"],
    ["Tasks/contractor.js", [], "Solve all coding contracts once (solver needs ~12+ GB briefly)"],
    ["hacknet-upgrade-manager.js", ["--max-payoff-time", "1h"], "One-shot: buy hacknet upgrades that pay off within 1h"],
    ["host-manager.js", [], "One-shot: buy/upgrade the best purchased server you can afford"],
    ["stockmaster.js", [], "Stock trader (needs WSE account + TIX API)"],
    ["casino.js", [], "Blackjack bot to win $10b (travel to Aevum first, needs $200k)"],
    ["go.js", [], "Plays IPvGO for bonuses"],
    ["spend-hacknet-hashes.js", [], "Spend hacknet hashes (BN9 / SF9)"],
    ["sleeve.js", [], "Sleeve manager (SF10)"],
    ["gangs.js", [], "Gang manager (SF2)"],
    ["bladeburner.js", [], "Bladeburner manager (SF7)"],
    ["work-for-factions.js", [], "Faction/company work (Singularity, SF4)"],
    ["faction-manager.js", [], "Buy augmentations (Singularity, SF4)"],
    ["daemon.js", [], "FULL hacking automation (takes over the network)"],
];

/** Hacknet node upgrade limits (game constants for hacknet nodes, not servers) */
export const OG_HACKNET_MAX = { level: 200, ram: 64, cores: 16 };
