import { formatMoney, formatRam, formatDuration } from 'helpers.js'
import { guiPanel, guiKit, useGuiStore, sortRows, h } from 'Tasks/gui-core.js'
import { HG_PORT, HG_OWNER_FILE, HG_HELPERS, HG_WORKERS, HG_COPY_FILES, hgWorkerArgs } from 'Tasks/host-gui-common.js'

const HOME_EXTRA_RESERVE_GB = 0; // Extra RAM to keep free on home on top of what the panel's helpers need
const THREAD_OPTIONS = [["Max", 1], ["75%", 0.75], ["50%", 0.5], ["25%", 0.25], ["1 thread", 0]];

/** Manual host control panel: click to root, copy scripts and run weaken / grow / hack per host.
 * Low-RAM (2.6 GB): all work is done by one-shot Tasks/host-gui-*.js helpers (see Tasks/gui-core.js).
 * @param {NS} ns */
export async function main(ns) {
    await guiPanel(ns, {
        port: HG_PORT, ownerFile: HG_OWNER_FILE, title: "Hosts", width: 1150, height: 700, component: HostGui,
        refreshers: [{ key: "hosts", script: HG_HELPERS.scanner, every: 2000 }],
    });
}

/** Same rule as hgw-loop's auto mode, used to highlight the suggested next step. */
function suggestedOp(t) {
    if (!t || !t.maxMoney) return null;
    if (t.sec > t.minSec + 1) return "weaken";
    if (t.money < t.maxMoney * 0.9) return "grow";
    return "hack";
}

const SORTS = {
    Host: r => r.host, Lvl: r => r.reqLevel, RAM: r => r.maxRam, Money: r => r.maxMoney,
    Sec: r => r.sec - r.minSec, Time: r => r.weakenTime,
};

function HostGui({ store }) {
    useGuiStore(store);
    const [target, setTarget] = React.useState(""); // "" = each host targets itself
    const [filter, setFilter] = React.useState("");
    const [rootedOnly, setRootedOnly] = React.useState(false);
    const [hideUseless, setHideUseless] = React.useState(true);
    const [threadPct, setThreadPct] = React.useState(1);
    const [sort, setSort] = React.useState({ key: "Lvl", dir: 1 });
    const k = guiKit(store);
    const { t, Btn } = k;
    const root = (...children) => h("div", { style: { fontFamily: "monospace", fontSize: 12, color: t.primary } }, ...children);

    const data = store.data.hosts;
    if (!data) return root(k.Note(store.alive ? "Scanning network..." : "PANEL STOPPED - run host-gui.js again", store.alive ? t.secondary : t.error), k.Log());

    const { hosts, openers, hackLevel } = data;
    const ramOf = store.ramOf;
    const byHost = Object.fromEntries(hosts.map(r => [r.host, r]));
    const canRoot = r => !r.rooted && hackLevel >= r.reqLevel && openers >= r.reqPorts;
    const homeReserve = Math.max(0, ...Object.values(HG_HELPERS).map(f => ramOf[f] ?? 0)) + HOME_EXTRA_RESERVE_GB;
    const missing = [...Object.values(HG_HELPERS), ...Object.values(HG_WORKERS)].filter(f => !ramOf[f]);
    const startJob = (host, mode, tgt) => store.enqueue(`${host} ${mode}`, HG_HELPERS.launcher,
        [host, threadPct, host === "home" ? homeReserve : 0, HG_WORKERS[mode], ...hgWorkerArgs(mode, tgt)]);

    const q = filter.trim().toLowerCase();
    const visible = sortRows(hosts
        .filter(r => !rootedOnly || r.rooted)
        .filter(r => !hideUseless || r.host === "home" || r.maxRam > 0 || r.maxMoney > 0)
        .filter(r => !q || r.host.toLowerCase().includes(q)), SORTS, sort);
    const targets = hosts.filter(r => r.rooted && r.maxMoney > 0).sort((a, b) => a.reqLevel - b.reqLevel);
    const rootable = hosts.filter(canRoot);
    const copyable = hosts.filter(r => r.rooted && r.host !== "home" && r.maxRam > 0);
    const workerPids = hosts.flatMap(r => r.workers.map(w => w.pid));
    const home = byHost.home;

    const toolbar = h("div", { style: { padding: "4px 6px", display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" } },
        h("span", null, "Target ",
            h("select", { value: target, onChange: e => setTarget(e.target.value), style: k.input },
                h("option", { value: "" }, "(each host itself)"),
                ...targets.map(r => h("option", { key: r.host, value: r.host }, `${r.host} - ${formatMoney(r.maxMoney, 3, 0)} (lvl ${r.reqLevel})`)))),
        h("span", null, "Threads ",
            h("select", { value: threadPct, onChange: e => setThreadPct(Number(e.target.value)), style: k.input },
                ...THREAD_OPTIONS.map(([label, v]) => h("option", { key: label, value: v }, label)))),
        h("input", { placeholder: "filter hosts", value: filter, onChange: e => setFilter(e.target.value), ...k.stopKeys, style: { ...k.input, width: 110 } }),
        h("label", null, h("input", { type: "checkbox", checked: rootedOnly, onChange: e => setRootedOnly(e.target.checked) }), "rooted only"),
        h("label", null, h("input", { type: "checkbox", checked: hideUseless, onChange: e => setHideUseless(e.target.checked) }), "hide 0 RAM/money"),
        Btn({ label: `Root all (${rootable.length})`, disabled: !rootable.length, title: rootable.map(r => r.host).join(", "),
            onClick: () => store.enqueue("Root all", HG_HELPERS.rooter, rootable.map(r => r.host)) }),
        Btn({ label: `Copy to all (${copyable.length})`, disabled: !copyable.length, title: `scp ${HG_COPY_FILES.join(", ")} to every rooted host with RAM`,
            onClick: () => store.enqueue("Copy all", HG_HELPERS.copier, copyable.map(r => r.host)) }),
        Btn({ label: `Stop all (${workerPids.length})`, disabled: !workerPids.length, title: "Kill every worker started from this panel",
            onClick: () => store.enqueue("Stop all", HG_HELPERS.killer, workerPids) }),
    );

    const status = h("div", { style: { padding: "0 6px", color: t.secondary } },
        `Hack lvl ${hackLevel} | port openers ${openers}/5 | ${hosts.filter(r => r.rooted).length}/${hosts.length} rooted`,
        ` | home ${formatRam(home.usedRam)} / ${formatRam(home.maxRam)} used (keeps ${formatRam(homeReserve)} free for helpers)`,
        ...k.Busy(),
        missing.length ? h("span", { style: { color: t.error } }, ` | missing on home: ${missing.join(", ")}`) : null);

    const rows = visible.map(r => {
        const effTarget = target || r.host;
        const tr = byHost[effTarget];
        const targetOk = tr?.rooted && tr.maxMoney > 0;
        const busy = r.workers.length > 0;
        const freeRam = r.maxRam - r.usedRam - (r.host === "home" ? homeReserve : 0);
        const canStart = r.rooted && r.maxRam > 0 && !busy && targetOk;
        const why = !r.rooted ? "Root the host first" : r.maxRam === 0 ? "Host has no RAM"
            : busy ? "Stop the running worker first" : !targetOk ? "Pick a rooted target with money in the Target dropdown" : null;
        const suggest = canStart ? suggestedOp(tr) : null;
        const runBtn = (mode, label) => {
            const workerRam = ramOf[HG_WORKERS[mode]];
            const threads = Math.floor(freeRam / (workerRam || Infinity));
            return Btn({
                label, disabled: !canStart || threads < 1, highlight: mode === suggest && threads >= 1,
                title: why ?? (threads < 1 ? `Not enough free RAM (${formatRam(Math.max(0, freeRam))}, need ${formatRam(workerRam ?? 0)})`
                    : `${mode} ${effTarget} with up to ${threads} threads | sec ${tr.sec.toFixed(1)}/${tr.minSec.toFixed(1)}, money ${formatMoney(tr.money, 3, 1)}/${formatMoney(tr.maxMoney, 3, 1)}`),
                onClick: () => startJob(r.host, mode, effTarget),
            });
        };
        const connectCmd = ["home", ...r.path.map(p => `connect ${p}`)].join("; ");
        const rootTitle = r.rooted ? "Already rooted" : canRoot(r) ? "Open ports and nuke" : `Needs hack lvl ${r.reqLevel} and ${r.reqPorts} port openers`;
        const hostColor = r.host === "home" ? t.info : r.rooted ? t.primary : canRoot(r) ? t.warning : t.secondary;
        const secDelta = r.sec - r.minSec;
        const moneyPct = r.maxMoney ? r.money / r.maxMoney : 0;

        return h("tr", { key: r.host },
            h("td", { style: { ...k.cell, color: hostColor } }, r.host),
            h("td", { style: { ...k.num, color: hackLevel >= r.reqLevel ? t.primary : t.error } }, r.reqLevel),
            h("td", { style: { ...k.num, color: openers >= r.reqPorts ? t.primary : t.error } }, r.reqPorts),
            h("td", { style: k.num }, r.maxRam ? `${formatRam(r.usedRam)} / ${formatRam(r.maxRam)}` : "-"),
            h("td", { style: { ...k.num, color: !r.maxMoney ? t.secondary : moneyPct >= 0.9 ? t.success : t.warning } },
                r.maxMoney ? `${formatMoney(r.money, 3, 1)} / ${formatMoney(r.maxMoney, 3, 1)}` : "-"),
            h("td", { style: { ...k.num, color: !r.maxMoney ? t.secondary : secDelta <= 1 ? t.success : t.warning } },
                r.maxMoney ? `+${secDelta.toFixed(1)}` : "-"),
            h("td", { style: k.num, title: "Weaken time (grow ≈ 0.8x, hack ≈ 0.25x)" }, r.maxMoney ? formatDuration(r.weakenTime) : "-"),
            h("td", { style: { ...k.cell, color: t.info } },
                r.workers.map(w => `${w.mode}${w.mode === "auto" ? "∞" : ""}→${w.target} x${w.threads}`).join(", ")),
            h("td", { style: k.cell },
                Btn({ label: "Root", disabled: !canRoot(r), title: rootTitle, onClick: () => store.enqueue(`Root ${r.host}`, HG_HELPERS.rooter, [r.host]) }),
                Btn({ label: "Copy", disabled: !r.rooted || r.host === "home", title: `scp ${HG_COPY_FILES.join(", ")}`,
                    onClick: () => store.enqueue(`Copy ${r.host}`, HG_HELPERS.copier, [r.host]) }),
                runBtn("weaken", "W"), runBtn("grow", "G"), runBtn("hack", "H"), runBtn("auto", "Auto∞"),
                Btn({ label: "Stop", disabled: !busy, title: "Kill the worker(s) on this host",
                    onClick: () => store.enqueue(`Stop ${r.host}`, HG_HELPERS.killer, r.workers.map(w => w.pid)) }),
                Btn({ label: "Path", disabled: r.host === "home", title: `Copy to clipboard: ${connectCmd}`, onClick: () => k.copyText(connectCmd, `path to ${r.host}`) }),
                Btn({ label: "BD", disabled: !r.rooted || r.host === "home" || hackLevel < r.reqLevel,
                    title: "Copy connect + backdoor command; paste into the terminal",
                    onClick: () => k.copyText(`${connectCmd}; backdoor`, `backdoor command for ${r.host}`) })));
    });

    return root(toolbar, status, k.Log(),
        k.Table(["Host", "Lvl", "Ports", "RAM", "Money", "Sec", "Time", "Running", "Actions"], rows, sort, setSort, SORTS),
        k.Note("W/G/H = one operation (highlighted = suggested next step). Auto∞ = weaken→grow→hack loop. Path/BD copy terminal commands."));
}
