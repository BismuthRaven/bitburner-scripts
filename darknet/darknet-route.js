/**
 * Live darknet routing. Darknet links are ephemeral (servers migrate, restart and go offline), so look a route up right
 * before using it rather than trusting an old one.
 * ns.scan can't see darknet hosts and ns.dnet.probe only sees the neighbours of the server it runs on, so adjacency
 * comes from the neighbour reports the darknet crawlers send the coordinator (state file) plus a fresh probe
 * from home. A route hops between adjacent online servers, or jumps straight to a backdoored / stasis-linked one (the
 * terminal can `connect` to those from anywhere).
 * Used by dark-connect.js. liveRoute must run on home; it costs getServer 2 GB + dnet.probe 0.2 +
 * serverExists 0.1 + dnet.getServerDetails 0.1. The other exports are pure (0 GB).
 */

export const STATE_FILE = "/data/darknet-state.json";

/** Parsed state file ({passwords, nodes}), or {} for missing / corrupt text. */
export const parseState = (text) => {
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
};

/** Neighbour graph (name -> Set) from the reports plus home's live neighbours. Links are two-way, so a host is
 * attached even if only its neighbour reported it. */
export function neighbourGraph(reports, homeNeighbours) {
  const edges = new Map();
  const addEdge = (a, b) => (edges.get(a) ?? edges.set(a, new Set()).get(a)).add(b);
  const link = (a, b) => (addEdge(a, b), addEdge(b, a));
  for (const report of Object.values(reports)) for (const n of report.neighbours ?? []) link(report.host, n);
  for (const n of homeNeighbours) link("home", n);
  return edges;
}

/** Shortest terminal routes from home (name -> hops, home excluded) by BFS over adjacent online hosts plus anchors. */
export function routesFrom(edges, isOnline, anchors) {
  const routes = new Map([["home", []]]);
  for (const queue = ["home"]; queue.length > 0; ) {
    const at = queue.shift();
    for (const next of [...(edges.get(at) ?? []), ...anchors]) {
      if (routes.has(next) || !isOnline(next)) continue;
      routes.set(next, [...routes.get(at), next]);
      queue.push(next);
    }
  }
  return routes;
}

/** The terminal command for a route, e.g. "home;connect a;connect b;backdoor". */
export const routeCommand = (route, then = "") => ["home", ...route.map((n) => `connect ${n}`), ...(then ? [then] : [])].join(";");

/**
 * Looks up the route to `target` from live data. Run on home.
 * @param {NS} ns
 * @returns {{route: string[] | null, problem: string | null, jumps: string[]}} route = hops after home (null if none);
 *   problem = why there is no route; jumps = hops reached by jumping to an anchor rather than from a neighbour.
 */
export function liveRoute(ns, target, stateFile = STATE_FILE) {
  if (target === "home") return { route: [], problem: null, jumps: [] };
  const edges = neighbourGraph(parseState(ns.read(stateFile)).nodes ?? {}, ns.dnet.probe());
  const linked = ns.dnet.getStasisLinkedServers();
  const names = new Set([...edges.keys(), ...linked, target]);
  names.delete("home");
  const online = new Map([...names].map((n) => [n, ns.serverExists(n) && ns.dnet.getServerDetails(n).isOnline === true]));
  if (!ns.serverExists(target)) return { route: null, problem: `${target} doesn't exist (or has vanished)`, jumps: [] };
  if (!online.get(target)) return { route: null, problem: `${target} is offline right now`, jumps: [] };
  // setStasisLink also sets backdoorInstalled, so this covers both kinds of anchor
  const anchors = [...names].filter((n) => online.get(n) && (linked.includes(n) || ns.getServer(n).backdoorInstalled === true));
  const route = routesFrom(edges, (n) => online.get(n) === true, anchors).get(target);
  if (!route) return { route: null, problem: `no route to ${target} right now (no online reported neighbour links to it, and it isn't backdoored)`, jumps: [] };
  const jumps = route.filter((n, i) => !edges.get(i === 0 ? "home" : route[i - 1])?.has(n));
  return { route, problem: null, jumps };
}
