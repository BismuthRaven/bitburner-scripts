import { guiHelper } from 'Tasks/gui-core.js'
import { DAEMON, COORDINATOR, WORM, buildOf, readBuild, samePath } from 'darknet/darknet-paths.js'
import { DG_DARKSCAPE, DG_LAB_NAMES, DG_NOTES_FILE } from 'Tasks/dark-controls-common.js'
import { parseState, neighbourGraph, routesFrom } from 'darknet/darknet-route.js'

/** One-shot: live darknet snapshot for dark-controls.js. args: [stateFile]
 * ns.scan can't see darknet hosts and ns.dnet.probe only sees the neighbours of the server it runs on, so adjacency
 * comes from the neighbour reports the darknet crawlers send the coordinator (state file) plus a live probe
 * from home. Every host ever heard of is then checked live.
 * @param {NS} ns */
export async function main(ns) {
    await guiHelper(ns, "Darknet scan", ([stateFile]) => {
        const daemonFile = DAEMON.replace(/^\//, "");
        const ramOf = { [daemonFile]: ns.getScriptRam(daemonFile, "home") };
        if (!ns.fileExists(DG_DARKSCAPE, "home")) return { key: "dnet", data: { time: Date.now(), missing: DG_DARKSCAPE, ramOf } };

        const saved = parseState(ns.read(stateFile));
        const reports = saved.nodes ?? {};
        const passwords = saved.passwords ?? {};
        const linked = ns.dnet.getStasisLinkedServers();
        const edges = neighbourGraph(reports, ns.dnet.probe());

        // Only hosts we have actually come across (no probing of known names such as the labyrinths: spoilers)
        const names = new Set([...edges.keys(), ...Object.keys(reports), ...Object.keys(passwords), ...linked]);
        names.delete("home");
        const hosts = new Map();
        for (const name of names) {
            const exists = ns.serverExists(name);
            const det = exists ? ns.dnet.getServerDetails(name) : { isOnline: false };
            const base = {
                name, online: !!det.isOnline, pw: passwords[name] ?? null, seen: reports[name]?.seen ?? null,
                links: [...(edges.get(name) ?? [])].sort(), linked: linked.includes(name), lab: DG_LAB_NAMES.includes(name),
            };
            if (!det.isOnline) { hosts.set(name, base); continue; }
            const srv = ns.getServer(name);
            const running = ns.ps(name);
            const crawler = running.find(p => samePath(p.filename, WORM));
            const procs = running.map(p => ({ file: p.filename, threads: p.threads, pid: p.pid }));
            hosts.set(name, {
                ...base,
                depth: det.depth ?? -1, difficulty: det.difficulty ?? null, cha: det.requiredCharismaSkill ?? 0,
                model: det.modelId ?? "?", hint: det.passwordHint ?? "", info: det.data ? String(det.data).slice(0, 200) : "",
                pwLength: det.passwordLength ?? null, pwFormat: det.passwordFormat ?? "", blockedRam: det.blockedRam ?? 0,
                stationary: !!det.isStationary, admin: !!srv.hasAdminRights, maxRam: srv.maxRam ?? 0, usedRam: srv.ramUsed ?? 0,
                backdoored: srv.backdoorInstalled === true && !base.linked, // setStasisLink also sets backdoorInstalled
                procs, files: ns.ls(name), instancePid: crawler?.pid ?? null, instanceBuild: crawler ? buildOf(crawler) : null,
            });
        }

        // Cached routes for display only; actions look the route up again when clicked (Tasks/dark-controls-goto.js)
        const anchors = [...hosts.values()].filter(x => x.online && (x.linked || x.backdoored)).map(x => x.name);
        const routes = routesFrom(edges, n => !!hosts.get(n)?.online, anchors);
        for (const x of hosts.values()) x.route = routes.get(x.name) ?? null;

        const homeProcs = ns.ps("home");
        const auth = ns.dnet.getDarknetInstability();
        return {
            key: "dnet", data: {
                time: Date.now(), stateFile, ramOf, build: readBuild(ns),
                charisma: ns.getPlayer().skills.charisma,
                linkLimit: ns.dnet.getStasisLinkLimit(),
                authMult: auth.authenticationDurationMultiplier, authTimeout: auth.authenticationTimeoutChance,
                reportCount: Object.keys(reports).length,
                daemonPid: homeProcs.find(p => samePath(p.filename, DAEMON))?.pid ?? null,
                coordinatorPid: homeProcs.find(p => samePath(p.filename, COORDINATOR))?.pid ?? null,
                hasNotes: ns.fileExists(DG_NOTES_FILE, "home"),
                hosts: [...hosts.values()],
            }
        };
    });
}
