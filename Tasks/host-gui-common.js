// Shared constants for host-gui.js and its one-shot helpers (Tasks/host-gui-*.js).
export const HG_PORT = 7171;
export const HG_OWNER_FILE = "/Temp/ex-host-gui-owner.txt";
export const HG_TAG = "host-gui"; // Passed as the "description" arg so our Remote/*-target.js workers are recognisable
export const HG_HELPERS = {
    scanner: "Tasks/host-gui-scan.js",
        rooter: "Tasks/host-gui-root.js",
        copier: "Tasks/host-gui-copy.js",
        launcher: "Tasks/host-gui-exec.js",
        killer: "Tasks/gui-kill.js",
};
export const HG_WORKERS = {
    weaken: "Remote/weak-target.js",
    grow: "Remote/grow-target.js",
    hack: "Remote/hack-target.js",
    auto: "Tasks/hgw-loop.js",
};
export const HG_COPY_FILES = Object.values(HG_WORKERS);

/** Worker args for each mode. Remote/*-target.js: [target, start_time, duration, description, (stock), silentMisfires, loop] */
export function hgWorkerArgs(mode, target) {
    if (mode === "weaken") return [target, 0, 0, HG_TAG, true, false];
    if (mode === "auto") return [target, "auto", 0];
    return [target, 0, 0, HG_TAG, false, true, false];
}
