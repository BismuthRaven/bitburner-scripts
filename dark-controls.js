import { getConfiguration, formatRam, formatDuration } from 'helpers.js'
import { guiPanel, guiKit, useGuiStore, h } from 'Tasks/gui-core.js'
import { DG_PORT, DG_OWNER_FILE, DG_HELPERS, DG_NOTES_FILE } from 'Tasks/dark-controls-common.js'
import { DAEMON } from 'darknet/darknet-paths.js'
import { routeCommand } from 'darknet/darknet-route.js'

/**
 * Darknet monitor: every darknet host we know of in one alphabetical list, refreshed every second. Hosts that go offline
 * or vanish keep their row (struck through, last known values) so the list doesn't jump around; a Change column flags
 * hosts that are new, came back, migrated or went away.
 * Clicking a host or action runs it through Tasks/dark-controls-goto.js with Netscript calls (no terminal typing); the target
 * is looked up live at click time: connect (singularity.connect along the route), ls, backdoor, solve contracts, open caches,
 * read clue files / literature. Click a password to copy it.
 * Low-RAM: the panel only uses ns.run + 0 GB calls; Tasks/dark-controls-scan.js gathers the data.
 */
const argsSchema = [
    ['state-file', '/data/darknet-state.json'], // where darknet-coordinator.js saves passwords and neighbour reports
    ['hide-offline', false], // initial state of the "hide offline" checkbox
];

export function autocomplete(data, _) {
    data.flags(argsSchema);
    return [];
}

const DAEMON_FILE = DAEMON.replace(/^\//, "");
const AIR_GAP_DEPTH = 8; // every 8th darknet row is empty (game constant)
const FRESH_MS = 90000; // matches the coordinator's fresh-ms: older reports may no longer describe the network
const SAFE_BACKDOORS = 2; // more backdoors than this add darknet instability
const RECENT_MS = 60000; // how long new / back / moved hosts stay flagged
const FORMATS = { numeric: 'num', alphabetic: 'alpha', alphanumeric: 'alnum', ASCII: 'ascii', unicode: 'uni' };
const ACCESS = ["ours", "rooted", "known", "locked", "lab", "offline"];
const C = { anchor: "#0ff", bd: "#f6f", inst: "#0f8", lab: "#f9f", cct: "#0ff", cache: "#fc0", clue: "#9cf", lit: "#c9f" };
// Fixed column widths (px) so the table doesn't reflow every refresh
const COLS = [["Host", 170], ["Change", 95], ["Depth", 55], ["Marks", 50], ["Build", 80], ["Hops", 40], ["Diff", 40], ["Cha", 50], ["Model", 130],
["Pw", 60], ["Password", 100], ["RAM", 145], ["Files", 70], ["Links", 160], ["Report", 85], ["Actions", 135]];
const TABLE_WIDTH = COLS.reduce((sum, [, w]) => sum + w, 0);

/** @param {NS} ns */
export async function main(ns) {
    const options = getConfiguration(ns, argsSchema);
    if (!options) return; // invalid args or config file; getConfiguration has already explained why
    const component = ({ store }) => h(DarkScanGui, { store, options });
    await guiPanel(ns, {
        port: DG_PORT, ownerFile: DG_OWNER_FILE, title: "Darknet", width: TABLE_WIDTH + 40, height: 750, component,
        refreshers: [{ key: "dnet", script: DG_HELPERS.info, args: () => [options['state-file']], every: 1000 }],
    });
}

const accessOf = x => !x.online ? "offline" : x.lab ? "lab" : x.instancePid ? "ours" : x.admin ? "rooted" : x.pw !== null ? "known" : "locked";
const accessLabel = a => a === "known" ? "known pw" : a;
const routeCmd = (x, then = "") => x.route ? routeCommand(x.route, then) : null;
const ACTION_TEXT = {
    connect: () => "connect (Netscript)", ls: () => "list its files", backdoor: () => "connect + install a backdoor",
    contract: () => "solve the coding contracts there (Tasks/contractor.js)", cache: file => `open ${file}`, read: file => `read ${file}`,
};
const ago = ms => `${formatDuration(Math.max(0, ms))} ago`;
/** "current" / "old" / "pre-build" for an instance's build compared with home's. */
const buildLabel = (build, homeBuild) => build === homeBuild ? "current" : build ? "old" : "pre-build";

/** Remembers hosts across snapshots: last online record (for struck-through rows) and when each appeared / moved / left. */
function trackChanges(tr, d) {
    if (d.time === tr.time) return;
    const baseline = tr.time === 0; // don't flag everything on the first snapshot
    const present = new Set();
    for (const x of d.hosts) {
        present.add(x.name);
        const s = tr.seen.get(x.name);
        if (!x.online) { if (s && !s.goneAt) s.goneAt = d.time; continue; }
        tr.last.set(x.name, x);
        if (!s) tr.seen.set(x.name, { depth: x.depth, newAt: baseline ? 0 : d.time, backAt: 0, movedAt: 0, from: null, goneAt: 0, build: x.instanceBuild, updatedAt: 0 });
        else {
            if (s.goneAt) Object.assign(s, { goneAt: 0, backAt: d.time });
            if (s.depth !== x.depth) Object.assign(s, { from: s.depth, depth: x.depth, movedAt: d.time });
            if (x.instanceBuild !== null && s.build !== null && x.instanceBuild > s.build) s.updatedAt = d.time;
            if (x.instanceBuild !== null) s.build = x.instanceBuild; // keep the last build seen while the instance restarts
        }
    }
    for (const [name, s] of tr.seen) if (!present.has(name) && !s.goneAt) s.goneAt = d.time;
    tr.time = d.time;
}

function DarkScanGui({ store, options }) {
    useGuiStore(store);
    const k = guiKit(store);
    const { t, Btn } = k;
    const [query, setQuery] = React.useState("");
    const [only, setOnly] = React.useState("");
    const [hideOffline, setHideOffline] = React.useState(!!options['hide-offline']);
    const [notes, setNotes] = React.useState(null);
    const track = React.useRef({ time: 0, seen: new Map(), last: new Map() });
    const root = (...children) => h("div", { style: { fontFamily: "monospace", fontSize: 12, color: t.primary } }, ...children);

    const d = store.data.dnet;
    if (!d) return root(k.Log(), k.Note(k.alive ? "Scanning the darknet..." : "PANEL STOPPED - run dark-controls.js again", k.alive ? t.secondary : t.error));
    if (d.missing) return root(k.Log(), k.Note(`You need ${d.missing} before the darknet can be scanned (buy it via the TOR router).`, t.warning));
    trackChanges(track.current, d);
    const tr = track.current;

    const color = { ours: t.success, rooted: t.primary, known: t.warning, locked: t.error, lab: C.lab, offline: t.secondary };
    // Actions only name the target: Tasks/dark-controls-goto.js looks the route up live when clicked and uses Netscript calls
    const go = (x, action = "connect", file = "") => store.enqueue(`${action} ${file || x.name}`, DG_HELPERS.goto, [options['state-file'], x.name, action, file]);
    const actionTitle = (x, action = "connect", file = "") => `click: ${ACTION_TEXT[action](file)} (target looked up live)\nlast scan's route: ${routeCmd(x) ?? "none"}`;
    const tail = (pid, what) => store.enqueueLocal(`Log ${what}`, ns => { ns.ui.openTail(pid); });
    const span = (text, style = {}, props = {}) => h("span", { style, ...props }, text);
    /** Clickable text running `action` on host x (x = null: plain text) */
    const link = (text, x, action, file, style = {}, title = "") => span(text, { cursor: x ? "pointer" : "default", textDecoration: x ? "underline" : "none", ...style },
        { title: x ? `${title ? title + "\n" : ""}${actionTitle(x, action, file)}` : title, onClick: x && k.alive ? () => go(x, action, file) : undefined });
    const bar = (...children) => h("div", { style: { padding: "3px 6px", display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" } }, ...children);
    const recent = at => at && d.time - at < RECENT_MS;

    // Every host we know of: live ones as reported now, the rest from their last online snapshot (or the bare report)
    const current = new Map(d.hosts.map(x => [x.name, x]));
    const all = [...new Set([...current.keys(), ...tr.last.keys()])].map(name => {
        const cur = current.get(name);
        if (cur?.online) return cur;
        const last = tr.last.get(name);
        return { ...(last ?? cur), online: false, route: null, instancePid: null, procs: [], pw: cur?.pw ?? last?.pw ?? null };
    }).sort((a, b) => a.name.localeCompare(b.name));
    const byName = new Map(all.map(x => [x.name, x]));
    const live = all.filter(x => x.online);
    const backdoorCount = live.filter(x => x.backdoored).length;

    // ---- header ----
    const lab = live.find(x => x.lab);
    const deepest = Math.max(-1, ...live.map(x => x.depth));
    const linkedNames = live.filter(x => x.linked).map(x => x.name);
    const unstable = d.authMult > 1 || d.authTimeout > 0;
    // Update wave: our instances on the build home holds now vs older ones
    const instances = live.filter(x => x.instancePid);
    const upToDate = instances.filter(x => x.instanceBuild === d.build).length;
    const behind = instances.filter(x => x.instanceBuild !== d.build).map(x => `${x.name} (${buildLabel(x.instanceBuild, d.build)})`);
    const buildBar = d.build ? bar(
        span(`Build ${d.build} (${ago(Date.now() - d.build)}):`, { color: t.secondary }, { title: "build of the darknet scripts on home (darknet/darknet-build.txt)" }),
        span(`${upToDate}/${instances.length} instances current`, { color: behind.length ? t.warning : t.success },
            { title: behind.length ? `updating:\n${behind.join("\n")}` : "every instance runs the current scripts" }),
        behind.length ? span(`updating: ${behind.slice(0, 6).join(", ")}${behind.length > 6 ? ` +${behind.length - 6}` : ""}`, { color: t.warning }) : null)
        : bar(span("Build: none yet (re-run darknet-daemon.js on home to stamp one)", { color: t.secondary }));
    const counts = Object.fromEntries(ACCESS.map(a => [a, all.filter(x => accessOf(x) === a).length]));
    const header = h("div", { style: { borderBottom: `1px solid ${t.well}` } },
        bar(h("b", null, `Darknet: ${live.length} live`),
            ...ACCESS.filter(a => counts[a]).map(a => span(`${counts[a]} ${accessLabel(a)}`, { color: color[a] }, { key: a })),
            span(`| deepest d${deepest}`, { color: t.secondary }),
            lab ? link(`lab ${lab.name} d${lab.depth}`, lab, "connect", "", { color: C.lab }, "the labyrinth: its exit leads deeper") : null),
        bar(span(`Stasis ${linkedNames.length}/${d.linkLimit}`, { color: C.anchor }, { title: linkedNames.join("\n") || "none" }),
            span(`Backdoors ${backdoorCount}/${SAFE_BACKDOORS}`, { color: backdoorCount > SAFE_BACKDOORS ? t.error : C.bd },
                { title: live.filter(x => x.backdoored).map(x => x.name).join("\n") || "none" }),
            span(`Auth x${d.authMult.toFixed(2)}, timeouts ${(d.authTimeout * 100).toFixed(0)}%`, { color: unstable ? t.warning : t.secondary },
                { title: "darknet instability (grows with backdoors)" }),
            span(`Charisma ${d.charisma}`, { color: t.secondary }),
            span(`Reports: ${d.reportCount} host(s) in ${d.stateFile}`, { color: d.reportCount ? t.secondary : t.error },
                { title: d.reportCount ? "neighbour reports from our dark-w0rm.js instances" : "no reports: is darknet-daemon.js running?" })),
        buildBar);

    // ---- toolbar ----
    const toolbar = bar(
        h("input", { placeholder: "filter hosts", value: query, onChange: e => setQuery(e.target.value), ...k.stopKeys, style: { ...k.input, width: 110 } }),
        h("select", { value: only, onChange: e => setOnly(e.target.value), style: k.input },
            h("option", { value: "" }, "all hosts"), ...ACCESS.filter(a => a !== "lab" || counts.lab).map(a => h("option", { key: a, value: a }, accessLabel(a)))),
        h("label", null, h("input", { type: "checkbox", checked: hideOffline, onChange: e => setHideOffline(e.target.checked) }), `hide offline (${counts.offline})`),
        Btn({ label: "Refresh", title: "Scan again now", onClick: () => { store.refreshNow(); store.publish(); } }),
        d.daemonPid ? Btn({ label: "Daemon log", onClick: () => tail(d.daemonPid, "darknet-daemon.js") })
            : Btn({ label: "Start daemon", highlight: !d.coordinatorPid, disabled: !store.ramOf[DAEMON_FILE],
                title: `darknet-daemon.js is not running on home (needs ${formatRam(store.ramOf[DAEMON_FILE] ?? 0)})` +
                    (d.coordinatorPid ? ". Normal once autopilot's --hand-off run has exited: the coordinator and worms carry on." : ""),
                onClick: () => store.enqueue("Start darknet-daemon.js", DAEMON_FILE, [], true) }),
        d.coordinatorPid ? Btn({ label: "Coordinator log", onClick: () => tail(d.coordinatorPid, "darknet-coordinator.js") }) : null,
        Btn({ label: notes === null ? "Notes" : "Hide notes", disabled: !d.hasNotes && notes === null, title: `lore and clue notes found so far (${DG_NOTES_FILE})`,
            onClick: () => notes === null ? store.enqueueLocal("Read notes", ns => { setNotes(ns.read(DG_NOTES_FILE)); }) : setNotes(null) }));
    // Fixed height so new messages / busy state don't push the table down
    const status = h("div", { style: { height: "4.8em", overflow: "hidden" } },
        h("div", { style: { padding: "0 6px", height: "1.2em", color: t.info } }, `Updated ${ago(Date.now() - d.time)}`, ...k.Busy()), k.Log());

    // ---- host rows ----
    const procList = x => x.procs.map(p => `${p.file} x${p.threads} (pid ${p.pid})`).join("\n");
    const marks = x => [
        x.linked ? span("∞", { color: C.anchor }, { key: "s", title: "stasis-linked: never moves, restarts or goes offline; reachable from anywhere" }) : null,
        x.backdoored ? span("♦", { color: C.bd }, { key: "b", title: "backdoored: reachable from anywhere (but may restart / go offline at mutations)" }) : null,
        x.instancePid ? span("●", { color: C.inst, cursor: "pointer" }, { key: "i", onClick: () => tail(x.instancePid, x.name),
            title: `click: log of our dark-w0rm.js (pid ${x.instancePid})\n${procList(x)}` })
            : x.procs.length ? span("○", { color: C.inst }, { key: "o", title: procList(x) }) : null,
    ];
    const fileLinks = x => (x.files ?? []).flatMap(file => {
        const kind = file.endsWith(".cct") ? ["@", "cct", "contract", "coding contract"] : file.endsWith(".cache") ? ["$", "cache", "cache", "cache (opening it gives a reward)"]
            : file.endsWith(".data.txt") ? ["?", "clue", "read", "clue file"] : file.endsWith(".lit") ? ["§", "lit", "read", "literature"] : null;
        if (!kind) return [];
        const [symbol, cls, action, what] = kind;
        return [link(symbol, x, action, file, { color: C[cls], marginRight: 4, fontWeight: "bold" }, `${what}: ${file}`)];
    });
    /** Our instance's build: current (matches home), old (will update), pre-build (stopped once when home re-runs). */
    const buildCell = (x, td) => {
        if (!x.online || !x.instancePid) return td({ color: t.secondary }, "-");
        const label = buildLabel(x.instanceBuild, d.build);
        return td({ color: label === "current" ? t.success : t.warning }, span(label, {},
            { title: `instance build ${x.instanceBuild || "none (started before builds existed)"}\nhome build ${d.build || "none"}` }));
    };
    const changeOf = x => {
        const s = tr.seen.get(x.name);
        if (!x.online) return s?.goneAt ? [`gone ${ago(d.time - s.goneAt)}`, t.secondary] : ["offline", t.secondary];
        if (recent(s?.movedAt)) return [`d${s.from}→d${x.depth}`, t.warning, `migrated ${ago(d.time - s.movedAt)}`];
        if (recent(s?.backAt)) return ["back", t.success, `back online ${ago(d.time - s.backAt)}`];
        if (recent(s?.updatedAt)) return ["updated", t.success, `restarted on the new build ${ago(d.time - s.updatedAt)}`];
        if (recent(s?.newAt)) return ["new", t.success, `appeared ${ago(d.time - s.newAt)}`];
        return ["", t.secondary];
    };

    const hostRow = x => {
        const off = !x.online;
        const known = x.depth !== undefined; // offline hosts never seen online have no details
        const base = { ...k.cell, overflow: "hidden", textOverflow: "ellipsis" };
        const struck = off ? { textDecoration: "line-through", color: t.secondary, opacity: 0.6 } : {};
        const td = (style, ...children) => h("td", { style: { ...base, ...style, ...struck } }, ...children);
        const tdNum = (style, ...children) => td({ textAlign: "right", ...style }, ...children);
        const dash = () => td({}, known ? "" : "-");
        const acc = accessOf(x);
        const cmd = routeCmd(x);
        const [change, changeColor, changeTitle] = changeOf(x);
        const nameTitle = [x.name, off ? "offline: last known values" : cmd ? "" : "no route in the last scan (it is looked up again when clicked)",
            x.hint ? `hint: ${x.hint}` : "", x.info ? `data: ${x.info}` : ""].filter(Boolean).join("\n");
        const nearGap = known && (x.depth + 1) % AIR_GAP_DEPTH === 0;
        const free = x.maxRam - x.usedRam - x.blockedRam;
        const canBackdoor = !off && x.name !== "darkweb" && x.admin && !x.backdoored && !x.linked;
        const linkNames = x.links ?? [];
        const age = x.seen === null || x.seen === undefined ? null : d.time - x.seen;
        const pw = x.pw;
        return h("tr", { key: x.name },
            td({ color: color[acc], fontWeight: acc === "ours" || acc === "lab" ? "bold" : "normal" }, link(x.name, off ? null : x, "connect", "", {}, nameTitle)),
            h("td", { style: { ...base, color: changeColor }, title: changeTitle }, change),
            known ? tdNum({ color: nearGap ? t.warning : t.secondary }, span(`d${x.depth}`, {},
                { title: nearGap ? `depth ${x.depth}: the row below (${x.depth + 1}) is an air gap - crossing needs a migration` : `depth ${x.depth}` })) : dash(),
            td({}, ...(off ? [] : marks(x))),
            buildCell(x, td),
            tdNum({ color: cmd ? t.primary : t.secondary }, cmd ? span(x.route.length, {}, { title: `${x.route.length} connect(s) from home` }) : "-"),
            known ? tdNum({ color: t.secondary }, x.difficulty ?? "?") : dash(),
            known ? tdNum({ color: x.cha <= d.charisma ? t.success : t.error }, span(x.cha, {}, { title: `charisma needed to read its logs (heartbleed): ${x.cha}, you have ${d.charisma}` })) : dash(),
            known ? td({ color: t.secondary }, span(x.model, {}, { title: `password model: ${x.model}\nhint: ${x.hint}` })) : dash(),
            known ? td({ color: t.secondary }, span(`${x.pwLength ?? "?"}${FORMATS[x.pwFormat] ?? x.pwFormat}`, {}, { title: `password: ${x.pwLength} characters, ${x.pwFormat}` })) : dash(),
            td({ color: t.warning }, pw === null ? "" : span(pw === "" ? "∅" : pw, { cursor: "pointer", textDecoration: "underline" },
                { title: `password: ${JSON.stringify(pw)}\nclick: copy to clipboard`, onClick: () => k.copyText(pw, `password of ${x.name}`) })),
            known ? tdNum({ color: free > 0 ? t.secondary : t.warning }, span(`${formatRam(x.usedRam)} / ${formatRam(x.maxRam)}${x.blockedRam ? " blk" : ""}${x.stationary ? " fixed" : ""}`, {},
                { title: `${formatRam(x.maxRam - x.usedRam)} free of ${formatRam(x.maxRam)}` + (x.blockedRam ? `, ${formatRam(x.blockedRam)} of it blocked by the owner (darknet-ram.js frees it)` : "") +
                    (x.stationary ? "\nstationary: never migrates" : "") })) : dash(),
            td({}, ...(off ? [] : fileLinks(x))),
            td({ color: t.secondary }, span(linkNames.join(" ") || "-", {},
                { title: linkNames.map(n => n === "home" ? "home" : `${n} (${byName.get(n)?.online ? `d${byName.get(n).depth}` : "offline"})`).join("\n") || "no reported links" })),
            td({ color: age !== null && age > FRESH_MS ? t.warning : t.secondary }, age === null ? "-" : span(ago(age), {},
                { title: `last neighbour report from our instance there${age > FRESH_MS ? " (stale: its links may have changed)" : ""}` })),
            h("td", { style: base },
                Btn({ label: "Connect", disabled: off, title: off ? "offline" : actionTitle(x), onClick: () => go(x) }),
                Btn({ label: "ls", disabled: off, title: off ? "offline" : `list the files on ${x.name}\n${actionTitle(x, "ls")}`, onClick: () => go(x, "ls") }),
                Btn({ label: "BD", disabled: !canBackdoor, danger: backdoorCount >= SAFE_BACKDOORS,
                    title: !canBackdoor ? "needs root; not for offline / darkweb / already backdoored / stasis-linked hosts"
                        : `backdoor ${x.name}\n${backdoorCount} backdoor(s) now; more than ${SAFE_BACKDOORS} adds darknet instability (slower, timing-out authentication) and backdoored servers restart / go offline more often\n${actionTitle(x, "backdoor")}`,
                    onClick: () => go(x, "backdoor") })));
    };

    const q = query.trim().toLowerCase();
    const visible = all.filter(x => (!hideOffline || x.online) && (!q || x.name.toLowerCase().includes(q)) && (!only || accessOf(x) === only));
    const table = h("table", { style: { borderCollapse: "collapse", tableLayout: "fixed", width: TABLE_WIDTH } },
        h("colgroup", null, ...COLS.map(([name, w]) => h("col", { key: name, style: { width: w } }))),
        h("thead", null, h("tr", null, ...COLS.map(([name]) => h("th", { key: name, style: { ...k.cell, color: t.primary } }, name)))),
        h("tbody", null, ...visible.map(hostRow)));

    return root(header, toolbar, status,
        notes !== null ? h("div", { style: { margin: "2px 6px", padding: 4, border: `1px solid ${t.well}`, maxHeight: 200, overflowY: "auto", whiteSpace: "pre-wrap", color: t.secondary } },
            notes || "(empty)") : null,
        visible.length ? table : k.Note(all.length ? "No hosts match the filter." : "No darknet hosts known yet: is darknet-daemon.js running?"),
        k.Note(`Names: ours = our dark-w0rm.js runs there, rooted = admin rights, known pw = password saved, locked = not cracked yet${counts.lab ? ", lab = labyrinth" : ""}, struck through = offline / gone (last known values). ` +
            "Marks: ∞ stasis link, ♦ backdoor, ● our instance (click = log), ○ other scripts. Files: @ contract, $ cache, ? clue, § literature. " +
            "Clicking a host, file or button runs it with Netscript calls (no terminal typing). Hover for details."));
}
