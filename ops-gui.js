import { formatMoney, formatRam, formatNumberShort } from 'helpers.js'
import { guiPanel, guiKit, useGuiStore, h } from 'Tasks/gui-core.js'
import { OG_PORT, OG_OWNER_FILE, OG_HELPERS, OG_PROGRAMS, OG_TOR_COST, OG_SCRIPTS, OG_HACKNET_MAX } from 'Tasks/ops-gui-common.js'

const TABS = ["Servers", "Hacknet", "Files", "Programs", "Scripts"];
const tabOf = store => store.tab ?? TABS[0];

/** Clickable operations panel (no automation): purchased servers, hacknet, files/contracts, darkweb programs and
 * launching the repo's other scripts. Low-RAM (2.6 GB): all work is done by one-shot Tasks/ops-gui-*.js helpers.
 * Only the active tab's data is refreshed.
 * @param {NS} ns */
export async function main(ns) {
    const on = (...tabs) => store => tabs.includes(tabOf(store));
    await guiPanel(ns, {
        port: OG_PORT, ownerFile: OG_OWNER_FILE, title: "Operations", width: 1000, height: 650, component: OpsGui,
        refreshers: [
            { key: "cloud", script: OG_HELPERS.cloudInfo, every: 3000, when: on("Servers") },
            { key: "hacknet", script: OG_HELPERS.hacknetInfo, every: 3000, when: on("Hacknet") },
            { key: "hacknetCosts", script: OG_HELPERS.hacknetCosts, every: 3000, when: on("Hacknet") },
            { key: "files", script: OG_HELPERS.filesInfo, every: 5000, when: on("Files", "Programs") },
            { key: "scripts", script: OG_HELPERS.scriptsInfo, every: 3000, when: on("Scripts") },
        ],
    });
}

function OpsGui({ store }) {
    useGuiStore(store);
    const k = guiKit(store);
    const { t, Btn } = k;
    const tab = tabOf(store);
    const setTab = name => { store.tab = name; store.refreshNow(); store.publish(); };
    const money = [store.data.cloud, store.data.hacknet, store.data.files].map(d => d?.money).find(m => m !== undefined);

    const tabs = h("div", { style: { padding: "4px 6px", display: "flex", gap: 4, alignItems: "center" } },
        ...TABS.map(name => Btn({ label: name, highlight: name === tab, onClick: () => setTab(name) })),
        h("span", { style: { marginLeft: 12, color: t.secondary } }, money !== undefined ? `Money ${formatMoney(money)}` : "", ...k.Busy()));
    const body = { Servers: ServersTab, Hacknet: HacknetTab, Files: FilesTab, Programs: ProgramsTab, Scripts: ScriptsTab }[tab];
    return h("div", { style: { fontFamily: "monospace", fontSize: 12, color: t.primary } },
        tabs, k.Log(), h(body, { store, k }));
}

const loading = (k, what) => k.Note(k.alive ? `Loading ${what}...` : "PANEL STOPPED - run ops-gui.js again", k.alive ? k.t.secondary : k.t.error);
const bar = (...children) => h("div", { style: { padding: "4px 6px", display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" } }, ...children);
const td = (style, ...children) => h("td", { style }, ...children);

// ---------- Servers (ns.cloud) ----------

function ServersTab({ store, k }) {
    const d = store.data.cloud;
    const [name, setName] = React.useState("");
    const [buyRam, setBuyRam] = React.useState(0);
    const [renaming, setRenaming] = React.useState(null); // [host, newName]
    const [confirmDelete, setConfirmDelete] = React.useState(null);
    if (!d) return loading(k, "servers");
    const { t, Btn } = k;
    const sizes = Object.keys(d.buyCosts).map(Number);
    if (!sizes.length) return k.Note("Purchased servers are not available in this BitNode.");
    const affordable = sizes.filter(r => d.buyCosts[r] <= d.money);
    const ram = buyRam || affordable.at(-1) || sizes[0];
    const atLimit = d.servers.length >= d.limit;
    const defaultName = `pserv-${d.servers.length}`;

    const buy = bar(
        `Servers ${d.servers.length}/${d.limit}, max ${formatRam(d.ramLimit)} each.  Buy: `,
        h("input", { placeholder: defaultName, value: name, onChange: e => setName(e.target.value), ...k.stopKeys, style: { ...k.input, width: 100 } }),
        h("select", { value: ram, onChange: e => setBuyRam(Number(e.target.value)), style: k.input },
            ...sizes.map(r => h("option", { key: r, value: r, style: { color: d.buyCosts[r] <= d.money ? t.primary : t.secondary } },
                `${formatRam(r)} - ${formatMoney(d.buyCosts[r], 3, 1)}`))),
        Btn({ label: `Buy ${formatRam(ram)} for ${formatMoney(d.buyCosts[ram], 3, 1)}`, highlight: d.buyCosts[ram] <= d.money && !atLimit,
            disabled: atLimit || d.buyCosts[ram] > d.money, title: atLimit ? "At the server limit" : undefined,
            onClick: () => { store.enqueue(`Buy ${name || defaultName}`, OG_HELPERS.cloudBuy, [name || defaultName, ram]); setName(""); } }),
        Btn({ label: "Biggest affordable", disabled: !affordable.length, onClick: () => setBuyRam(affordable.at(-1)) }));

    const rows = d.servers.map(s => {
        const ups = Object.entries(s.upgrades).map(([r, c]) => [Number(r), c]);
        const double = ups.find(([r]) => r === s.maxRam * 2);
        const best = ups.filter(([, c]) => c <= d.money).at(-1);
        const isRenaming = renaming?.[0] === s.host;
        const submitRename = () => {
            const [from, to] = renaming;
            setRenaming(null);
            if (to && to !== from) store.enqueueLocal(`Rename ${from}`, ns => {
                store.refreshNow();
                return ns.cloud.renameServer(from, to) ? `Renamed ${from} to ${to}` : `Could not rename ${from} to ${to}`;
            });
        };
        return h("tr", { key: s.host },
            td(k.cell, isRenaming
                ? h("input", { autoFocus: true, value: renaming[1], onChange: e => setRenaming([s.host, e.target.value]), style: { ...k.input, width: 110 },
                    onKeyDown: e => { e.stopPropagation(); if (e.key === "Enter") submitRename(); if (e.key === "Escape") setRenaming(null); } })
                : s.host),
            td(k.num, formatRam(s.maxRam)),
            td(k.num, `${formatRam(s.usedRam)} (${s.procs} scripts)`),
            td(k.cell,
                Btn({ label: double ? `x2 → ${formatRam(double[0])} ${formatMoney(double[1], 3, 1)}` : "x2 (max)", disabled: !double || double[1] > d.money,
                    onClick: () => store.enqueue(`Upgrade ${s.host}`, OG_HELPERS.cloudUpgrade, [s.host, double[0]]) }),
                Btn({ label: best ? `Best → ${formatRam(best[0])} ${formatMoney(best[1], 3, 1)}` : "Best (can't afford)", disabled: !best, highlight: !!best,
                    title: "Largest upgrade you can afford right now", onClick: () => store.enqueue(`Upgrade ${s.host}`, OG_HELPERS.cloudUpgrade, [s.host, best[0]]) })),
            td(k.cell,
                isRenaming ? Btn({ label: "OK", onClick: submitRename }) : Btn({ label: "Rename", onClick: () => setRenaming([s.host, s.host]) }),
                confirmDelete === s.host
                    ? [Btn({ key: "y", label: `Really delete${s.procs ? ` + kill ${s.procs}` : ""}?`, danger: true,
                        onClick: () => { setConfirmDelete(null); store.enqueue(`Delete ${s.host}`, OG_HELPERS.cloudDelete, [s.host]); } }),
                    Btn({ key: "n", label: "Cancel", onClick: () => setConfirmDelete(null) })]
                    : Btn({ label: "Delete", danger: true, onClick: () => setConfirmDelete(s.host) })));
    });
    return h("div", null, buy,
        d.servers.length ? k.Table(["Server", "RAM", "Used", "Upgrade", ""], rows) : k.Note("No purchased servers yet."),
        k.Note(`Helper RAM: buy ${store.ramOf[OG_HELPERS.cloudBuy] ?? "?"} GB, delete ${store.ramOf[OG_HELPERS.cloudDelete] ?? "?"} GB (must fit on home).`));
}

// ---------- Hacknet ----------

function HacknetTab({ store, k }) {
    const d = store.data.hacknet;
    if (!d) return loading(k, "hacknet");
    const { t, Btn } = k;
    const costs = store.data.hacknetCosts ?? [];
    const isServer = d.nodes.some(n => "hashCapacity" in n); // Hacknet servers (BN9) produce hashes; string check avoids a phantom RAM charge
    const unit = isServer ? "hashes" : "$";
    const total = d.nodes.reduce((s, n) => s + n.production, 0);
    const act = (label, action, index, count) => store.enqueue(label, OG_HELPERS.hacknetAct, [action, index, count]);
    // Costs arrive via JSON, where Infinity (= already maxed) becomes null
    const upBtn = (i, action, count, cost, maxed, label) => Btn({
        label: maxed || cost === null ? `${label} (max)` : `${label} ${cost === undefined ? "…" : formatMoney(cost, 3, 1)}`,
        disabled: maxed || cost == null || cost > d.money,
        onClick: () => act(`hacknet-node-${i} ${action}`, action, i, count),
    });
    const rows = d.nodes.map((n, i) => {
        const c = costs[i] ?? {};
        return h("tr", { key: i },
            td(k.cell, n.name),
            td(k.num, n.level), td(k.num, formatRam(n.ram)), td(k.num, n.cores),
            td(k.num, `${formatNumberShort(n.production, 3, 2)} ${unit}/s`),
            td(k.num, isServer ? formatNumberShort(n.totalProduction ?? 0) : formatMoney(n.totalProduction ?? 0, 3, 1)),
            td(k.cell,
                upBtn(i, "level", 1, c.level1, n.level >= OG_HACKNET_MAX.level, "+1 lvl"),
                upBtn(i, "level", 10, c.level10, n.level + 10 > OG_HACKNET_MAX.level, "+10 lvl"),
                upBtn(i, "ram", 1, c.ram, !isServer && n.ram >= OG_HACKNET_MAX.ram, "+RAM"),
                upBtn(i, "cores", 1, c.cores, !isServer && n.cores >= OG_HACKNET_MAX.cores, "+core")));
    });
    return h("div", null,
        bar(`Nodes ${d.nodes.length}/${d.maxNodes ?? "∞"} | production ${formatNumberShort(total, 3, 2)} ${unit}/s`,
            Btn({ label: `Buy node ${formatMoney(d.nodeCost, 3, 1)}`, disabled: d.nodeCost > d.money || (d.maxNodes !== null && d.nodes.length >= d.maxNodes),
                highlight: d.nodeCost <= d.money, onClick: () => act("Buy hacknet node", "buy") })),
        d.nodes.length ? k.Table(["Node", "Lvl", "RAM", "Cores", "Prod", "Total", "Upgrades"], rows) : k.Note("No hacknet nodes yet."),
        k.Note("Hacknet usually pays back slower than hacking early on - buy nodes/levels whose cost you'd earn back soon.", t.secondary));
}

// ---------- Files & contracts ----------

const stripHtml = html => String(html).replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n\n").replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

function FilesTab({ store, k }) {
    const d = store.data.files;
    const [viewer, setViewer] = React.useState(null);
    if (!d) return loading(k, "files");
    const { t, Btn } = k;
    const collectable = d.remote.filter(r => (r.file.endsWith(".lit") || r.file.endsWith(".txt")) && !r.onHome);
    const contracts = d.remote.filter(r => r.file.endsWith(".cct"));
    const others = d.remote.filter(r => !r.file.endsWith(".cct"));
    const solverRam = store.ramOf["Tasks/contractor.js.solver.js"];
    const view = file => store.enqueueLocal(`View ${file}`, ns => { setViewer({ file, text: ns.read(file) }); });

    const fileRows = others.map(r => h("tr", { key: r.host + r.file },
        td(k.cell, r.host), td(k.cell, r.file),
        td({ ...k.cell, color: r.onHome ? t.success : t.secondary }, r.onHome ? "on home" : r.file.endsWith(".msg") ? "read it on the server" : "not collected"),
        td(k.cell, r.onHome ? Btn({ label: "View", onClick: () => view(r.file) })
            : Btn({ label: "Connect", title: "Move your current server there (singularity.connect); then run cat in the Terminal - scripts can't read this file type",
                onClick: () => store.enqueue(`Connect ${r.host}`, OG_HELPERS.goConnect, r.route) }))));
    const contractRows = contracts.map(r => h("tr", { key: r.host + r.file },
        td(k.cell, r.host), td(k.cell, r.file),
        td(k.cell, Btn({ label: "Connect", title: "Solve it by hand: move your current server there (singularity.connect), then run it in the Terminal",
            onClick: () => store.enqueue(`Connect ${r.host}`, OG_HELPERS.goConnect, r.route) }))));
    const homeFiles = d.home.map(f => Btn({ key: f, label: f, onClick: () => view(f) }));

    return h("div", null,
        bar(Btn({ label: `Collect ${collectable.length} file(s) to home`, disabled: !collectable.length, highlight: collectable.length > 0,
            title: "Copies .lit and .txt files from all servers to home (.msg/.cct can't be copied)",
            onClick: () => store.enqueue("Collect files", OG_HELPERS.filesCollect) }),
            Btn({ label: `Solve ${contracts.length} contract(s)`, disabled: !contracts.length,
                title: `Runs Tasks/contractor.js (its solver briefly needs ${solverRam ?? "~12"} GB free on home)`,
                onClick: () => store.enqueue("Solve contracts", "Tasks/contractor.js", [], true) })),
        viewer ? h("div", { style: { margin: 6, padding: 6, border: `1px solid ${t.primary}`, maxHeight: 220, overflowY: "auto", whiteSpace: "pre-wrap" } },
            h("div", { style: { color: t.info, marginBottom: 4 } }, viewer.file, " ", Btn({ label: "Close", onClick: () => setViewer(null) })),
            viewer.text ? stripHtml(viewer.text)
                : h("span", { style: { color: t.warning } }, `Scripts can't read this file type; open it in the Terminal with: cat ${viewer.file}`)) : null,
        homeFiles.length ? h("div", { style: { padding: "2px 6px" } }, "On home: ", ...homeFiles) : null,
        contracts.length ? k.Table(["Server", "Contract", ""], contractRows) : null,
        others.length ? k.Table(["Server", "File", "Status", ""], fileRows) : k.Note("No lore/text/message files found on other servers."));
}

// ---------- Programs ----------

function ProgramsTab({ store, k }) {
    const d = store.data.files;
    if (!d) return loading(k, "programs");
    const { t, Btn } = k;
    const rows = OG_PROGRAMS.map(([file, price, createLvl, desc]) => {
        const owned = d.programs[file];
        const canBuy = d.tor && !owned && price <= d.money;
        return h("tr", { key: file },
            td({ ...k.cell, color: owned ? t.success : t.primary }, file),
            td({ ...k.cell, color: owned ? t.success : t.secondary }, owned ? "owned" : "-"),
            td({ ...k.num, color: price <= d.money ? t.primary : t.secondary }, formatMoney(price, 3, 1)),
            td({ ...k.num, color: d.hackLevel >= createLvl ? t.primary : t.secondary }, createLvl),
            td(k.cell, desc),
            td(k.cell, Btn({ label: "Buy", disabled: owned || !d.tor, highlight: canBuy,
                title: d.tor ? `Buys ${file} with singularity.purchaseProgram` : "Buy the TOR router first", onClick: () => store.enqueue(`Buy ${file}`, OG_HELPERS.buyProgram, [file]) })));
    });
    return h("div", null,
        bar(d.tor ? h("span", { style: { color: t.success } }, "TOR router owned")
            : h("span", { style: { color: t.warning } }, `No TOR router: buy it for ${formatMoney(OG_TOR_COST)} at a tech store (e.g. Alpha Enterprises, Sector-12)`)),
        k.Table(["Program", "Owned", "Price", "Create lvl", "What it does", ""], rows),
        k.Note(`Create lvl = hacking level needed to write it yourself (Create Program tab) for free. Your level: ${d.hackLevel}.`));
}

// ---------- Scripts ----------

function ScriptsTab({ store, k }) {
    const d = store.data.scripts;
    const [argsOf, setArgsOf] = React.useState({});
    if (!d) return loading(k, "scripts");
    const { t, Btn } = k;
    const rows = OG_SCRIPTS.map(([file, defaultArgs, desc]) => {
        const s = d.scripts.find(x => x.file === file) ?? {};
        const argText = argsOf[file] ?? defaultArgs.join(" ");
        const args = argText.trim() ? argText.trim().split(/\s+/) : [];
        const fits = s.ram <= d.homeFree;
        const running = s.running ?? [];
        return h("tr", { key: file },
            td({ ...k.cell, color: !s.exists ? t.secondary : running.length ? t.success : t.primary }, file),
            td({ ...k.num, color: fits ? t.primary : t.error }, s.exists ? formatRam(s.ram) : "missing"),
            td(k.cell, h("input", { value: argText, onChange: e => setArgsOf({ ...argsOf, [file]: e.target.value }), ...k.stopKeys, style: { ...k.input, width: 130 } })),
            td(k.cell,
                Btn({ label: "Start", disabled: !s.exists || !fits, title: !s.exists ? "Not on home" : fits ? `run ${file} ${argText}` : `Needs ${formatRam(s.ram)}, ${formatRam(d.homeFree)} free on home`,
                    onClick: () => store.enqueue(`Start ${file}`, file, args, true) }),
                Btn({ label: "Log", disabled: !running.length, title: "Open the tail window", onClick: () => running.forEach(p => store.enqueueLocal(`Tail ${file}`, ns => { ns.ui.openTail(p.pid); })) }),
                Btn({ label: running.length > 1 ? `Kill ${running.length}` : "Kill", disabled: !running.length, danger: true,
                    onClick: () => store.enqueue(`Kill ${file}`, OG_HELPERS.killer, running.map(p => p.pid)) })),
            td({ ...k.cell, color: t.secondary, whiteSpace: "normal" }, desc));
    });
    return h("div", null,
        bar(`Free RAM on home: ${formatRam(d.homeFree)}. Nothing here runs unless you click Start.`),
        k.Table(["Script", "RAM", "Args", "", "What it does"], rows),
        k.Note("RAM shown is the static cost; scripts that spawn helpers (contractor, daemon, ...) briefly need more."));
}
