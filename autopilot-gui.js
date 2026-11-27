import { formatMoney, formatRam, formatDuration } from 'helpers.js'
import { CONTROL_FILE } from 'helpers-gui.js'
import { guiPanel, guiKit, useGuiStore, h } from 'Tasks/gui-core.js'
import { CG_PORT, CG_OWNER_FILE, CG_HELPERS, CG_MODULES, CG_PRESETS } from 'Tasks/autopilot-gui-common.js'

const TABS = ["Modules", "Queue & activity"];
const tabOf = store => store.tab ?? TABS[0];
const STALE_MS = 15000;

/** Control panel + monitor for autopilot.js / daemon.js: switch individual sub-modules on/off live (they read
 * ex-autopilot-gui-state.txt before acting), see what each orchestrator is doing, what is queued and what it launched.
 * Low-RAM: the panel only uses ns.run + 0 GB calls; Tasks/autopilot-gui-scan.js gathers the data.
 * @param {NS} ns */
export async function main(ns) {
    await guiPanel(ns, {
        port: CG_PORT, ownerFile: CG_OWNER_FILE, title: "Autopilot / daemon control", width: 1100, height: 700, component: CtlGui,
        refreshers: [{ key: "ctl", script: CG_HELPERS.info, every: 2000 }],
    });
}

/** Queue a 0 GB read-modify-write of the control file (switch modules on/off). */
function setModules(store, ids, off, label) {
    store.enqueueLocal(label, ns => {
        let cfg;
        try { cfg = JSON.parse(ns.read(CONTROL_FILE) || "{}"); } catch { cfg = {}; }
        const disabled = new Set(cfg.disabled ?? []);
        ids.forEach(id => off ? disabled.add(id) : disabled.delete(id));
        cfg.disabled = [...disabled];
        ns.write(CONTROL_FILE, JSON.stringify(cfg), "w");
        if (store.data.ctl) store.data.ctl.disabled = cfg.disabled; // Instant feedback before the next scan
        return label;
    });
}

const parseMoney = text => {
    const m = String(text).trim().toLowerCase().match(/^([\d.]+(?:e\d+)?)\s*([kmbtq]?)$/);
    return m ? Number(m[1]) * { "": 1, k: 1e3, m: 1e6, b: 1e9, t: 1e12, q: 1e15 }[m[2]] : NaN;
};
const ago = t => t ? `${formatDuration(Math.max(0, Date.now() - t))} ago` : "never";
const bar = (...children) => h("div", { style: { padding: "3px 6px", display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" } }, ...children);
const td = (style, ...children) => h("td", { style }, ...children);

/** Running state of an orchestrator, with a freshness check of its status snapshot. */
function orchestrator(d, file, status) {
    const running = d.procs.filter(p => p.file === file);
    const fresh = status && running.some(p => p.pid === status.pid) && Date.now() - status.time < STALE_MS;
    return { running, status: fresh ? status : null };
}

function CtlGui({ store }) {
    useGuiStore(store);
    const k = guiKit(store);
    const { t, Btn } = k;
    const d = store.data.ctl;
    if (!d) return h("div", { style: { fontFamily: "monospace", fontSize: 12, color: t.primary } }, k.Log(),
        k.Note(k.alive ? "Loading..." : "PANEL STOPPED - run autopilot-gui.js again", k.alive ? t.secondary : t.error));
    const ap = orchestrator(d, "autopilot.js", d.ap);
    const dm = orchestrator(d, "daemon.js", d.d);
    const tab = tabOf(store);
    const setTab = name => { store.tab = name; store.publish(); };
    const tabs = h("div", { style: { padding: "4px 6px", display: "flex", gap: 4, alignItems: "center" } },
        ...TABS.map(name => Btn({ label: name, highlight: name === tab, onClick: () => setTab(name) })),
        h("span", { style: { marginLeft: 12, color: t.secondary } }, `Money ${formatMoney(d.money)}`, ...k.Busy()));
    const body = tab === TABS[0] ? ModulesTab : ActivityTab;
    return h("div", { style: { fontFamily: "monospace", fontSize: 12, color: t.primary } },
        h(Header, { store, k, d, ap, dm }), tabs, k.Log(), h(body, { store, k, d, ap, dm }));
}

// ---------- Header: orchestrators, reserve, presets ----------

function Header({ store, k, d, ap, dm }) {
    const { t, Btn } = k;
    const [reserveText, setReserveText] = React.useState("");
    const orch = (name, file, o) => {
        const ram = d.ramOf[file];
        const state = o.running.length ? (o.status ? `running (pid ${o.running[0].pid})` : `running (pid ${o.running[0].pid}, no status yet)`) : "stopped";
        return h("span", { key: file, style: { marginRight: 14 } },
            h("b", null, `${name}: `),
            h("span", { style: { color: o.running.length ? t.success : t.secondary } }, state, " "),
            o.running.length
                ? [Btn({ key: "s", label: "Stop", danger: true, title: "Kill it (its helpers keep running)", onClick: () => store.enqueue(`Stop ${file}`, CG_HELPERS.killer, o.running.map(p => p.pid)) }),
                    Btn({ key: "l", label: "Log", onClick: () => store.enqueueLocal(`Tail ${file}`, ns => { ns.ui.openTail(o.running[0].pid); }) })]
                : Btn({ label: `Start (${formatRam(ram ?? 0)})`, disabled: !ram || ram > d.homeFree, highlight: true,
                    title: ram > d.homeFree ? `Needs ${formatRam(ram)}, ${formatRam(d.homeFree)} free on home` : `run ${file}`,
                    onClick: () => store.enqueue(`Start ${file}`, file, [], true) }));
    };
    const setReserve = value => store.enqueueLocal(`Set reserve`, ns => { ns.write("MachineState/CashReserve.txt", String(value), "w"); store.refreshNow(); return `MachineState/CashReserve.txt = ${formatMoney(value)}`; });
    const typed = parseMoney(reserveText);
    const disabled = new Set(d.disabled);
    const preset = CG_PRESETS.find(([, ids]) => ids.length === disabled.size && ids.every(id => disabled.has(id)));
    return h("div", { style: { borderBottom: `1px solid ${t.well}` } },
        bar(orch("Autopilot", "autopilot.js", ap), orch("Daemon", "daemon.js", dm)),
        bar(`Reserved money (MachineState/CashReserve.txt): ${formatMoney(d.reserve)}`,
            h("input", { placeholder: "e.g. 500m, 2b", value: reserveText, onChange: e => setReserveText(e.target.value), ...k.stopKeys, style: { ...k.input, width: 90 } }),
            Btn({ label: "Set", disabled: !Number.isFinite(typed), onClick: () => { setReserve(typed); setReserveText(""); } }),
            Btn({ label: "Clear", disabled: !d.reserve, onClick: () => setReserve(0) }),
            h("span", { style: { color: t.secondary } }, disabled.has("ap-reserve") ? "(autopilot leaves it alone)" : "(autopilot rewrites it unless 'Stock cash reserve' is off)")),
        bar("Presets:", ...CG_PRESETS.map(([label, ids, title]) => Btn({
            key: label, label, title, highlight: preset?.[0] === label,
            onClick: () => store.enqueueLocal(`Preset ${label}`, ns => {
                ns.write(CONTROL_FILE, JSON.stringify({ disabled: ids }), "w");
                store.data.ctl.disabled = ids;
                return `Preset "${label}": ${CG_MODULES.length - ids.length}/${CG_MODULES.length} modules on`;
            }),
        })), h("span", { style: { color: t.secondary } }, `${CG_MODULES.length - disabled.size}/${CG_MODULES.length} on`)));
}

// ---------- Modules ----------

function ModulesTab({ store, k, d, ap, dm }) {
    const { t, Btn } = k;
    const disabled = new Set(d.disabled);
    const alive = { AP: ap.running.length > 0, D: dm.running.length > 0 };
    const periodic = d.d?.periodic ?? [];
    let group = null;
    const rows = [];
    for (const m of CG_MODULES) {
        if (m.group !== group) {
            group = m.group;
            rows.push(h("tr", { key: `g-${group}` }, h("th", { colSpan: 7, style: { ...k.cell, color: t.info, paddingTop: 6 } }, group)));
        }
        const on = !disabled.has(m.id);
        const procs = d.procs.filter(p => m.scripts?.includes(p.file));
        const workers = m.workers ? d.workers[m.workers] : null;
        const busy = procs.length > 0 || workers?.procs > 0;
        const nexts = periodic.filter(p => p.module === m.id).map(p => p.nextRun);
        const next = nexts.length && dm.status ? Math.min(...nexts) - Date.now() : null;
        const stop = () => {
            if (on) setModules(store, [m.id], true, `${m.label}: off`);
            if (procs.length) store.enqueue(`Stop ${m.label}`, CG_HELPERS.killer, procs.map(p => p.pid));
            if (workers?.procs) store.enqueue(`Stop ${m.label} workers`, CG_HELPERS.stopWorkers, [m.workers]);
        };
        rows.push(h("tr", { key: m.id },
            td(k.cell, Btn({ label: on ? "ON" : "OFF", highlight: on, title: on ? "Click to switch off (stops future launches/actions)" : "Click to switch on",
                onClick: () => setModules(store, [m.id], on, `${m.label}: ${on ? "off" : "on"}`) })),
            td({ ...k.cell, color: on ? t.primary : t.secondary }, m.label),
            td(k.cell, ...m.by.map(by => h("span", { key: by, title: alive[by] ? "running" : "not running - this part is inert",
                style: { marginRight: 4, color: alive[by] ? t.primary : t.secondary, textDecoration: alive[by] ? "none" : "line-through" } }, by))),
            td({ ...k.cell, color: busy ? t.success : t.secondary }, workers
                ? (workers.procs ? `${workers.threads.toLocaleString()} thr` : "-")
                : procs.length ? procs.map(p => `${p.pid}${p.host !== "home" ? "@" + p.host : ""}`).join(" ") : "-"),
            td({ ...k.num, color: on ? t.primary : t.secondary }, next === null ? "" : on ? (next > 0 ? `${Math.ceil(next / 1000)}s` : "due") : "skip"),
            td(k.cell,
                Btn({ label: "Stop", danger: true, disabled: !busy, title: "Switch off AND kill what's running (otherwise it would be relaunched)", onClick: stop }),
                Btn({ label: "Log", disabled: !procs.length, onClick: () => store.enqueueLocal(`Tail ${m.label}`, ns => { ns.ui.openTail(procs[0].pid); }) })),
            td({ ...k.cell, color: t.secondary, whiteSpace: "normal", minWidth: 300 }, m.desc)));
    }
    return h("div", null,
        k.Table(["Switch", "Module", "By", "Running", "Next", "Actions", "What it does"], rows),
        k.Note("Switches apply live: autopilot.js and daemon.js check them before each action. OFF stops future launches only - use Stop to also kill what runs. " +
            "AP = autopilot.js, D = daemon.js (struck through = not running). Daemon also honours its --disable-script arg."));
}

// ---------- Queue & activity ----------

function ActivityTab({ store, k, d, ap, dm }) {
    const { t, Btn } = k;
    const disabled = new Set(d.disabled);
    const moduleOf = id => CG_MODULES.find(m => m.id === id);
    const pre = (text, color = t.primary) => h("div", { style: { padding: "2px 6px 2px 16px", whiteSpace: "pre-wrap", color } }, text);
    const head = text => h("div", { style: { padding: "6px 6px 2px", color: t.info } }, text);

    // Autopilot
    const a = ap.status;
    const flags = a ? Object.entries(a.flags).filter(([, v]) => v).map(([f]) => f) : [];
    const f = a?.forecast;
    const eta = ms => ms == null ? "unknown" : formatDuration(ms);
    const conf = pct => `${(100 * (pct ?? 0)).toFixed(0)}%`;
    const forecastLine = !f ? null
        : f.reason === "beyond-horizon" ? pre(`Installing now: next aug ETA ${eta(f.etaNextAug)} (confidence ${conf(f.confidence)}) - beyond the horizon`, t.success)
        : f.reason === "no-more-augs" ? pre(`Installing now: nothing more is coming (confidence ${conf(f.confidence)})`, t.success)
        : pre(`Next aug: ${f.nextAug ? `"${f.nextAug}"` : "-"} ETA ${eta(f.etaNextAug)} (confidence ${conf(f.confidence)}) - ` +
            (f.action === "wait" ? "waiting" : f.reason.replace(/-/g, " ")), f.reason === "low-confidence" || f.reason === "unknown" ? t.secondary : t.primary);
    const apPart = a ? [
        pre(a.status || "(no status yet)"),
        a.installAt ? pre(`Install (reset) in ${formatDuration(Math.max(0, a.installAt - Date.now()))} - reserving ${formatMoney(a.reservedPurchase)}`, t.warning) : null,
        forecastLine,
        pre(`Next BN: ${a.nextBn} | wants daemon args: ${a.wantedDaemonArgs.length ? a.wantedDaemonArgs.join(" ") : "(none)"}` +
            (disabled.has("ap-daemon") ? " (not applied: 'Manage daemon' is off)" : ""), t.secondary),
        flags.length ? pre(`Flags: ${flags.join(", ")}`, t.secondary) : null,
    ] : [pre(ap.running.length ? "Running, waiting for its first status snapshot..." : "Not running.", t.secondary)];

    // Daemon
    const s = dm.status;
    const w = d.workers;
    const daemonPart = s ? [
        pre(`RAM ${formatRam(s.usedRam)} / ${formatRam(s.maxRam)} (${(s.utilization * 100).toFixed(1)}%) | max targets ${s.maxTargets}` +
            ` | modes: ${Object.entries(s.modes).filter(([, v]) => v).map(([m]) => m).join(", ") || "normal"}` +
            (s.hackingOn ? "" : " | HACKING SWITCHED OFF") + (s.studying ? " | studying" : ""), s.hackingOn ? t.primary : t.warning),
        pre(`Targeting: ${s.targeting.join(", ") || "-"}\nPrepping: ${s.prepping.join(", ") || "-"}`),
        s.summary ? pre(s.summary, t.secondary) : null,
    ] : [pre(dm.running.length ? "Running, waiting for its first status snapshot..." : "Not running.", t.secondary)];
    const workerBar = bar(`Workers: H/G/W ${w["hack"].threads.toLocaleString()} threads (${w["hack"].procs} scripts), share ${w["share"].threads.toLocaleString()} threads`,
        Btn({ label: "Kill H/G/W workers", danger: true, disabled: !w["hack"].procs, title: "Kills running hack/grow/weaken jobs everywhere (daemon re-schedules them while 'Hack / grow / weaken' is ON)",
            onClick: () => store.enqueue("Kill H/G/W workers", CG_HELPERS.stopWorkers, ["hack"]) }),
        Btn({ label: "Kill share workers", danger: true, disabled: !w["share"].procs, onClick: () => store.enqueue("Kill share workers", CG_HELPERS.stopWorkers, ["share"]) }));

    // Daemon queue: periodic scripts by next run, then helpers it has not launched yet
    const now = Date.now();
    const state = id => {
        const off = id && disabled.has(id);
        return td({ ...k.cell, color: off ? t.error : t.success }, off ? "OFF" : "on");
    };
    const shortArgs = args => args.map(x => typeof x === "number" && !Number.isInteger(x) ? formatMoney(x) : String(x)).join(" ");
    const queueRows = s ? [
        ...[...s.periodic].sort((x, y) => x.nextRun - y.nextRun).map((p, i) => h("tr", { key: `p${i}` },
            td(k.cell, p.name.replace(/^\//, "")), td(k.cell, moduleOf(p.module)?.label ?? p.module ?? "-"), state(p.module),
            td(k.num, p.nextRun - now > 0 ? formatDuration(p.nextRun - now) : "due"), td(k.num, `every ${Math.round(p.interval / 1000)}s`),
            td({ ...k.cell, color: t.secondary }, shortArgs(p.args)))),
        ...s.helpers.filter(x => !x.launched).map((x, i) => h("tr", { key: `h${i}` },
            td(k.cell, x.name), td(k.cell, moduleOf(x.module)?.label ?? x.module ?? "-"), state(x.module),
            td(k.num, "waiting"), td(k.num, "once"), td({ ...k.cell, color: t.secondary }, "conditions not met yet (RAM, SF, money...)"))),
    ] : [];

    const launches = [...(a?.recentLaunches ?? []).map(l => ({ ...l, by: "AP" })), ...(s?.recentLaunches ?? []).map(l => ({ ...l, by: "D" }))]
        .sort((x, y) => y.time - x.time).slice(0, 15);
    const launchRows = launches.map((l, i) => h("tr", { key: i },
        td(k.cell, new Date(l.time).toLocaleTimeString()), td(k.cell, l.by), td(k.cell, String(l.script).replace(/^\//, "")),
        td({ ...k.num, color: l.pid ? t.primary : t.error }, l.pid || "failed"), td({ ...k.cell, color: t.secondary }, shortArgs(l.args ?? []))));

    return h("div", null,
        head(`Autopilot${a ? ` (updated ${ago(a.time)})` : ""}`), ...apPart,
        head(`Daemon${s ? ` (updated ${ago(s.time)})` : ""}`), ...daemonPart, workerBar,
        head("Daemon queue"), queueRows.length ? k.Table(["Script", "Module", "Switch", "Next run", "Interval", "Args"], queueRows) : pre("-", t.secondary),
        head("Recent launches"), launchRows.length ? k.Table(["Time", "By", "Script", "PID", "Args"], launchRows) : pre("-", t.secondary));
}
