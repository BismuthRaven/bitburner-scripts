// Shared engine for the clickable low-RAM panels (host-gui.js, ops-gui.js, autopilot-gui.js, dark-controls.js).
// - Panels only use ns.run (1 GB) plus 0 GB calls. Real work happens in one-shot helper scripts, run one at a time.
// - Helpers get the panel's reply port as args[0] and answer through guiHelper(), which posts {pid, kind, ...} JSON.
// - Only the panel's main loop touches ns: React handlers just enqueue jobs (ns calls from handlers while main is
//   in ns.sleep throw "concurrent calls" errors).
// RAM gotcha: the game's static analyzer charges any identifier matching an ns API name (e.g. `scan`, `connect`,
// `kill`), even on unrelated objects. Verify with: node .tools/ram-check.mjs <script>
const NO_DATA = "NULL PORT DATA";
const TICK_MS = 100;
const HELPER_TIMEOUT_MS = 20000;
const MAX_MESSAGES = 8;

/** Helper side: run work(args) and report its result to the panel. Return a string (message) or {key, data}. */
export async function guiHelper(ns, label, work) {
    const [replyPort, ...args] = ns.args;
    const post = payload => ns.writePort(Number(replyPort), JSON.stringify({ pid: ns.pid, ...payload }));
    try {
        const result = await work(args);
        if (result && typeof result === "object" && "key" in result) post({ kind: "data", key: result.key, data: result.data });
        else post({ kind: "action", text: result ?? `${label} done` });
    } catch (err) {
        post({ kind: "action", text: `${label} failed: ${err?.message ?? err}` });
    }
}

/** Panel side: open a tail window rendering `component` and run the job loop until killed or replaced.
 * @param {NS} ns
 * @param {{port: number, ownerFile: string, title?: string, width: number, height: number, component: Function,
 *   refreshers: {key: string, script: string, args?: (store) => any[], every: number, when?: (store) => boolean}[]}} cfg */
export async function guiPanel(ns, cfg) {
    ns.disableLog("ALL");
    ns.write(cfg.ownerFile, String(ns.pid), "w"); // A newer instance overwrites this and the old one exits
    ns.clearPort(cfg.port);
    const store = {
        alive: true, data: {}, ramOf: {}, theme: ns.ui.getTheme(), messages: [], queue: [], busy: null, tab: null,
        listeners: new Set(), nextRefresh: {},
        /** Queue a helper script run. noReply = a normal script (no reply port arg, no answer expected). */
        enqueue(label, script, args = [], noReply = false) {
            if (this.busy === label || this.queue.some(j => j.label === label)) return;
            this.queue.push({ label, script, args, noReply });
            this.publish();
        },
        /** Queue a 0 GB ns operation executed inside the main loop, e.g. ns => ns.read(file). Return a message or nothing. */
        enqueueLocal(label, fn) { this.queue.push({ label, fn }); this.publish(); },
        refreshNow() { this.nextRefresh = {}; },
        note(text) { this.messages = [`${new Date().toLocaleTimeString()} ${text}`, ...this.messages].slice(0, MAX_MESSAGES); },
        publish() { this.listeners.forEach(l => l({})); },
    };
    ns.atExit(() => { store.alive = false; store.publish(); });
    ns.ui.openTail();
    ns.ui.resizeTail(cfg.width, cfg.height);
    if (cfg.title) ns.ui.setTailTitle(cfg.title);
    ns.printRaw(React.createElement(cfg.component, { store }));

    let pending = null;
    while (true) {
        if (ns.read(cfg.ownerFile) !== String(ns.pid)) return store.note("Replaced by a newer instance");
        let changed = false;
        for (let raw = ns.readPort(cfg.port); raw !== NO_DATA; raw = ns.readPort(cfg.port)) {
            let msg;
            try { msg = JSON.parse(raw); } catch { continue; }
            if (msg.kind === "data") {
                store.data[msg.key] = msg.data;
                Object.assign(store.ramOf, msg.data?.ramOf ?? {});
            } else {
                if (msg.text) store.note(msg.text);
                store.refreshNow();
            }
            if (pending?.pid === msg.pid) pending = null;
            changed = true;
        }
        if (pending && Date.now() - pending.started > HELPER_TIMEOUT_MS) {
            store.note(`${pending.label}: helper gave no response (check its log)`);
            pending = null;
        }
        while (!pending) {
            const due = cfg.refreshers.find(r => (r.when?.(store) ?? true) && Date.now() >= (store.nextRefresh[r.key] ?? 0));
            const job = store.queue.shift() ?? (due ? { label: `refresh ${due.key}`, script: due.script, args: due.args?.(store) ?? [], refresher: due } : null);
            if (!job) break;
            changed = true;
            if (job.refresher) store.nextRefresh[job.refresher.key] = Date.now() + job.refresher.every;
            if (job.fn) {
                try { const msg = job.fn(ns); if (msg) store.note(msg); }
                catch (err) { store.note(`${job.label} failed: ${err?.message ?? err}`); }
                continue;
            }
            // External scripts (noReply) get their own args only; helpers get the reply port first
            const pid = job.noReply ? ns.run(job.script, 1, ...job.args) : ns.run(job.script, 1, cfg.port, ...job.args);
            if (!pid) {
                const ram = store.ramOf[job.script];
                store.note(`${job.label}: could not start ${job.script}` + (ram ? ` - needs ${ram} GB free on home` : " - missing file or not enough RAM on home"));
                break;
            }
            if (job.noReply) { store.note(`Started ${job.script}${job.args.length ? " " + job.args.join(" ") : ""} (pid ${pid})`); store.refreshNow(); }
            else pending = { pid, label: job.label, started: Date.now(), refresh: !!job.refresher };
        }
        const busy = pending && !pending.refresh ? pending.label : null;
        if (busy !== store.busy) { store.busy = busy; changed = true; }
        if (changed) store.publish();
        await ns.sleep(TICK_MS);
    }
}

// ---------- shared UI kit (no ns calls) ----------

export const h = (...args) => React.createElement(...args);

/** Re-render the calling component whenever the store publishes. */
export function useGuiStore(store) {
    const [, force] = React.useState({});
    React.useEffect(() => { store.listeners.add(force); return () => store.listeners.delete(force); }, []);
}

/** Theme-aware building blocks bound to a store. */
export function guiKit(store) {
    const t = store.theme;
    const alive = store.alive;
    const cell = { padding: "1px 6px", whiteSpace: "nowrap", textAlign: "left", borderBottom: `1px solid ${t.well}` };
    const kit = {
        t, alive,
        cell, num: { ...cell, textAlign: "right" },
        input: { background: t.backgroundsecondary, color: t.primary, border: `1px solid ${t.primary}`, fontFamily: "inherit", fontSize: "inherit" },
        stopKeys: { onKeyDown: e => e.stopPropagation() }, // Keep the terminal from stealing keystrokes
        Btn: ({ key, label, onClick, disabled, title, highlight, danger }) => h("button", {
            key, onClick: alive && !disabled ? onClick : undefined, disabled: !alive || disabled, title,
            style: {
                margin: "0 1px", padding: "0 5px", fontFamily: "inherit", fontSize: "inherit",
                background: highlight ? t.primary : t.backgroundsecondary,
                color: highlight ? t.backgroundprimary : danger ? t.error : t.primary,
                border: `1px solid ${danger ? t.error : t.primary}`,
                opacity: !alive || disabled ? 0.3 : 1, cursor: !alive || disabled ? "default" : "pointer",
            }
        }, label),
        Note: (text, color = t.secondary) => h("div", { style: { padding: "1px 6px", color } }, text),
        Log: (lines = 3) => h("div", { style: { padding: "2px 6px", minHeight: "1.2em", color: t.warning } },
            ...store.messages.slice(0, lines).map((m, i) => h("div", { key: i, style: { opacity: i ? 0.6 : 1 } }, m))),
        Busy: () => [
            store.busy ? h("span", { key: "b", style: { color: t.info } }, ` | working: ${store.busy}`) : null,
            store.queue.length ? h("span", { key: "q", style: { color: t.info } }, ` (+${store.queue.length} queued)`) : null,
            alive ? null : h("span", { key: "d", style: { color: t.error } }, " | PANEL STOPPED - run it again")],
        Table: (headers, rows, sort, setSort, sortable = {}) => h("table", { style: { borderCollapse: "collapse" } },
            h("thead", null, h("tr", null, ...headers.map(name => h("th", {
                key: name, style: { ...cell, cursor: sortable[name] ? "pointer" : "default", color: t.primary },
                onClick: sortable[name] ? () => setSort(s => ({ key: name, dir: s.key === name ? -s.dir : 1 })) : undefined,
            }, name + (sort?.key === name ? (sort.dir > 0 ? " ▲" : " ▼") : ""))))),
            h("tbody", null, ...rows)),
        copyText: (text, what) => {
            navigator.clipboard?.writeText(text);
            store.note(`Copied ${what} to clipboard: ${text}`);
            store.publish();
        },
    };
    return kit;
}

/** Sort rows by a key-extractor map + {key, dir} state, ties broken by `tie`. */
export function sortRows(rows, extractors, sort, tie = r => r.host ?? "") {
    const get = extractors[sort.key];
    if (!get) return rows;
    return [...rows].sort((a, b) => {
        const va = get(a), vb = get(b);
        return (va < vb ? -1 : va > vb ? 1 : String(tie(a)).localeCompare(String(tie(b)))) * sort.dir;
    });
}
