import { log, getConfiguration, instanceCount, getNsDataThroughFile, formatMoney, formatRam, formatDuration } from './helpers.js'

// The purpose of the host manager is to buy the best servers it can
// until it thinks RAM is underutilized enough that you don't need to anymore.

const purchasedServerName = "daemon"; // The name to give all purchased servers. Also used to determine which servers were purchased
let maxPurchasableServerRamExponent; // The max server ram you can buy as an exponent (power of 2). Typically 1 petabyte (2^20), but less in some BNs
let maxPurchasedServers; // The max number of servers you can have in your farm. Typically 25, but can be less in some BNs
let costByRamExponent = {}; // A dictionary of how much each server size costs, prepped in advance.

// The following globals are set via command line arguments specified below, along with their defaults
let keepRunning = false;
let minRamExponent;
let absReservedMoney;
let pctReservedMoney;
let budget;

let options;
const argsSchema = [
    ['c', false], // Set to true to run continuously
    ['run-continuously', false], // Long-form alias for above flag
    ['interval', 10000], // Update interval (in milliseconds) when running continuously
    ['min-ram-exponent', 5], // the minimum amount of ram to purchase
    ['utilization-trigger', 0.80], // the percentage utilization that will trigger an attempted purchase
    ['absolute-reserve', null], // Set to reserve a fixed amount of money. Defaults to the contents of MachineState/CashReserve.txt on home
    ['reserve-percent', 0.9], // Set to reserve a percentage of home money
    ['reserve-by-time', false], // Experimental exponential decay by time in the run. Starts willing to spend lots of money, falls off over time.
    ['reserve-by-time-decay-factor', 0.2], // Controls how quickly our % reserve increases from --reserve-percent to 100% over time. For example, if --reserve-percent is set to 0.05 (allow spending 95% of money), time to reduce spending to ~25% of money is ~6hrs at 0.2, ~4hrs at 0.3, ~2hrs at 0.5
    ['budget', Number.POSITIVE_INFINITY], // Yet another way to control spending, this budget will not be exceeded, regardless of player owned money. Reserves are still respected.
    ['allow-worse-purchases', false], // Set to true to allow purchase of servers worse than our current best purchased server
    ['compare-to-home-threshold', 0.05], // Do not bother buying servers unless they are at least this big compared to current home RAM
    ['compare-to-network-ram-threshold', 0.01], // Do not bother buying servers unless they are at least this big compared to total network RAM
];

export function autocomplete(data, _) {
    data.flags(argsSchema);
    return [];
}

/** Note: In addition to this script's RAM footprint (2.7 GB last this was updated)
 *        This script requires 3.85 GB of DYNAMIC RAM (2.25 GB (for cloud.purchaseServer) + 1.6 GB Base Cost) used by getNsDataThroughFile)
 * @param {NS} ns **/
export async function main(ns) {
    const runOptions = getConfiguration(ns, argsSchema);
    if (!runOptions || await instanceCount(ns) > 1) return; // Prevent multiple instances of this script from being started, even with different args.
    options = runOptions; // We don't set the global "options" until we're sure this is the only running instance
    ns.disableLog('ALL')

    // Get the maximum number of purchased servers in this bitnode
    maxPurchasedServers = await getNsDataThroughFile(ns, 'ns.cloud.getServerLimit()');
    log(ns, `INFO: Max purchasable servers has been detected as ${maxPurchasedServers.toFixed(0)}.`);
    if (maxPurchasedServers == 0)
        return log(ns, `INFO: Shutting down due to host purchasing being disabled in this BN...`);

    // Get the maximum size of purchased servers in this bitnode
    const purchasedServerMaxRam = await getNsDataThroughFile(ns, 'ns.cloud.getRamLimit()');
    maxPurchasableServerRamExponent = Math.log2(purchasedServerMaxRam);
    log(ns, `INFO: Max purchasable RAM has been detected as 2^${maxPurchasableServerRamExponent} (${formatRam(2 ** maxPurchasableServerRamExponent)}).`);

    // Gather one-time info in advance about how much RAM each size of server costs (Up to 2^30 to be future-proof, but we expect everything above 2^20 to be Infinity)
    costByRamExponent = await getNsDataThroughFile(ns, 'Object.fromEntries([...Array(30).keys()].map(i => [i, ns.cloud.getServerCost(2**i)]))', '/Temp/host-costs.txt');

    keepRunning = options.c || options['run-continuously'];
    pctReservedMoney = options['reserve-percent'];
    minRamExponent = options['min-ram-exponent'];
    budget = options['budget'];
    // Log the command line options, for new users who don't know why certain decisions are/aren't being made
    if (minRamExponent > maxPurchasableServerRamExponent) {
        log(ns, `WARN: --min-ram-exponent was set to ${minRamExponent} (${formatRam(2 ** minRamExponent)}), ` +
            `but the maximum server RAM in this BN is ${maxPurchasableServerRamExponent} (${formatRam(2 ** maxPurchasableServerRamExponent)}), ` +
            `so the minimum has been lowered accordingly.`);
        minRamExponent = maxPurchasableServerRamExponent;
    } else
        log(ns, `INFO: --min-ram-exponent is set to ${minRamExponent}: New servers will only be purchased ` +
            `if we can afford 2^${minRamExponent} (${formatRam(2 ** minRamExponent)}) or more in size.`);
    log(ns, `INFO: --compare-to-home-threshold is set to ${options['compare-to-home-threshold'] * 100}%: ` +
        `New servers are deemed "not worthwhile" unless they are at least this big compared to your home server.`);
    log(ns, `INFO: --compare-to-network-ram-threshold is set to ${options['compare-to-network-ram-threshold'] * 100}%: ` +
        `New servers are deemed "not worthwhile" unless they are this big compared to total ram on the entire network.`);
    log(ns, `INFO: --utilization-trigger is set to ${options['utilization-trigger'] * 100}%: ` +
        `New servers will only be purchased when more than this much RAM is in use across the entire network.`);
    if (options['reserve-by-time'])
        log(ns, `INFO: --reserve-by-time is active! This community-contributed option will spend more of your money on servers early on, and less later on.`);
    else
        log(ns, `INFO: --reserve-percent is set to ${pctReservedMoney * 100}%: ` +
            `This means we will spend no more than ${((1 - pctReservedMoney) * 100).toFixed(1)}% of current Money on a new server.`);
    // Start the main loop (or run once)
    if (!keepRunning)
        log(ns, `host-manager will run once. Run with argument "-c" to run continuously.`)
    do {
        absReservedMoney = options['absolute-reserve'] != null ? Number(options['absolute-reserve']) : Number(ns.read("MachineState/CashReserve.txt") || 0);
        // Buy/upgrade as many servers as our current budget & thresholds allow in a single pass
        let boughtCount = 0;
        while (boughtCount < maxPurchasedServers * 2 && await tryToBuyBestServerPossible(ns)) {
            boughtCount++;
            await ns.sleep(20);
        }
        if (keepRunning)
            await ns.sleep(options['interval']);
    } while (keepRunning);
}

// Logging system to only print a log if it is different from the last log printed.
let lastStatus = "";
function setStatus(ns, logMessage) {
    if (logMessage != lastStatus) ns.print(lastStatus = logMessage);
    return false;
}

/** @param {NS} ns
  * Attempts to buy or upgrade a server. Returns true if a purchase/upgrade occurred. **/
async function tryToBuyBestServerPossible(ns) {
    // Scan the set of all servers on the network that we own (or rooted) to get a sense of current RAM utilization
    let rootedServers = await getNsDataThroughFile(ns, 'scanAllServers(ns).filter(s => ns.hasRootAccess(s))', '/Temp/rooted-servers.txt');
    // Gather the list of all purchased servers.
    let purchasedServers = null;
    try { purchasedServers = await getNsDataThroughFile(ns, 'ns.cloud.getServerNames()', null, null, null, 3, 5, /* silent errors */ true); } catch { /* Ignore */ }
    if (purchasedServers == null) // Early game, if we have insufficient RAM (1.05 GB cloud.getServerNames + 1.6 base cost), we can fall-back to guessing based on their name
        purchasedServers = rootedServers.filter(s => s.startsWith(purchasedServerName));
    // If some of the servers are hacknet servers, and they aren't being used for scripts, ignore the RAM they have available
    // with the assumption that these are reserved for generating hashes
    const likelyHacknet = rootedServers.filter(s => s.startsWith("hacknet-node-") || s.startsWith('hacknet-server-'));
    if (likelyHacknet.length > 0) {
        const totalHacknetUsedRam = likelyHacknet.reduce((t, s) => t + ns.getServerUsedRam(s), 0);
        if (totalHacknetUsedRam == 0) {
            rootedServers = rootedServers.filter(s => !likelyHacknet.includes(s));
            log(ns, `Removing ${likelyHacknet.length} hacknet servers from RAM statistics since they are not being utilized.`)
        } else if (!keepRunning)
            log(ns, `We are currently using ${formatRam(totalHacknetUsedRam)} of hacknet RAM, so including hacknet in our utilization stats.`)
    }

    const totalMaxRam = rootedServers.reduce((t, s) => t + ns.getServerMaxRam(s), 0);
    const totalUsedRam = rootedServers.reduce((t, s) => t + ns.getServerUsedRam(s), 0);
    if (options['utilization-trigger'] > 0) {
        const utilizationRate = totalUsedRam / totalMaxRam;
        setStatus(ns, `Using ${Math.round(totalUsedRam).toLocaleString('en')}/${formatRam(totalMaxRam)} (` +
            `${(utilizationRate * 100).toFixed(1)}%) across ${rootedServers.length} servers ` +
            `(Triggers at ${options['utilization-trigger'] * 100}%, ${purchasedServers.length} bought so far)`);
        // If utilization is below target. We don't need another server.
        if (utilizationRate < options['utilization-trigger'])
            return false;
    }

    // Check for other reasons not to go ahead with the purchase
    let prefix = 'Host-manager wants to buy another server, but ';

    // Determine our budget for spending money on servers
    let cashMoney = await getNsDataThroughFile(ns, `ns.getServerMoneyAvailable(ns.args[0])`, null, ["home"]);
    if (options['reserve-by-time']) { // Option to vary pctReservedMoney by time since augment.
        // Decay factor of 0.2 = Starts willing to spend 95% of our money, backing down to ~75% at 1 hour, ~60% at 2 hours, ~25% at 6 hours, and ~10% at 10 hours.
        // Decay factor of 0.3 = Starts willing to spend 95% of our money, backing down to ~66% at 1 hour, ~45% at 2 hours, ~23% at 4 hours, ~10% at 6 hours
        // Decay factor of 0.5 = Starts willing to spend 95% of our money, then halving every hour (to ~48% at 1 hour, ~24% at 2 hours, ~12% at 3 hours, etc)
        const timeSinceLastAug = Date.now() - (await getNsDataThroughFile(ns, 'ns.getResetInfo()')).lastAugReset;
        const t = timeSinceLastAug / (60 * 60 * 1000); // Time since last aug, in hours.
        const decayFactor = options['reserve-by-time-decay-factor'];
        pctReservedMoney = 1.0 - (1.0 - options['reserve-percent']) * Math.pow(1 - decayFactor, t);
        if (!keepRunning)
            log(ns, `After spending ${formatDuration(timeSinceLastAug)} in this augmentation, reserve % has grown from ` +
                `${(options['reserve-percent'] * 100).toFixed(1)}% to ${(pctReservedMoney * 100).toFixed(1)}%`);
    }

    let spendableMoney = Math.min(budget, cashMoney * (1.0 - pctReservedMoney), cashMoney - absReservedMoney);
    if (spendableMoney <= 0.01) {
        if (!keepRunning) // Show a more detailed log if we aren't running continuously
            return setStatus(ns, `${prefix}all player cash (${formatMoney(cashMoney)}) is currently reserved (budget: ${formatMoney(budget)}, ` +
                `abs reserve: ${formatMoney(absReservedMoney)}, ` +
                `% reserve: ${(pctReservedMoney * 100).toFixed(1)}% (${formatMoney(cashMoney * (1.0 - pctReservedMoney))}))`);
        // Otherwise the "status" log we show should remain relatively consistent so we aren't spamming e.g. changes in player money in --continuous mode
        return setStatus(ns, `${prefix}all player cash is currently reserved (budget: ${formatMoney(budget)}, ` +
            `abs reserve: ${formatMoney(absReservedMoney)}, % reserve: ${(pctReservedMoney * 100).toFixed(1)}%)`);
    }

    // Collect information about previously purchased servers first, so we know upgrade discounts and softcap trade-offs
    const maxPurchasableServerRam = Math.pow(2, maxPurchasableServerRamExponent);
    const ramByServer = Object.fromEntries(purchasedServers.map(server => [server, ns.getServerMaxRam(server)]));
    let [worstServerName, worstServerRam] = purchasedServers.reduce(([minS, minR], s) =>
        ramByServer[s] < minR ? [s, ramByServer[s]] : [minS, minR], [null, maxPurchasableServerRam]);
    let [bestServerName, bestServerRam] = purchasedServers.reduce(([maxS, maxR], s) =>
        ramByServer[s] > maxR ? [s, ramByServer[s]] : [maxS, maxR], [null, 0]);

    const isUpgrade = purchasedServers.length >= maxPurchasedServers;
    if (isUpgrade && worstServerRam >= maxPurchasableServerRam) {
        keepRunning = false;
        return setStatus(ns, `INFO: We are at the max number of servers ${maxPurchasedServers}, ` +
            `and all have the maximum possible RAM (${formatRam(maxPurchasableServerRam)}).`);
    }

    const worstExp = worstServerName != null ? Math.log2(worstServerRam) : 0;
    const baseUpgradeCredit = isUpgrade ? costByRamExponent[worstExp] : 0;
    const minCandidateExp = isUpgrade ? worstExp + 1 : minRamExponent;
    // Detect whether CloudServerSoftcap > 1 (cost more than doubles above 64 GB)
    const hasSoftcap = maxPurchasableServerRamExponent >= 7 && (costByRamExponent[7] / costByRamExponent[6]) > 2.0001;
    const homeRam = ns.getServerMaxRam("home");
    const homeThreshold = options['compare-to-home-threshold'];
    const networkThreshold = options['compare-to-network-ram-threshold'];

    // Determine the highest exponent we could afford at all (accounting for upgrade credit when at server limit)
    let maxAffordableExp = 0;
    for (let e = 1; e <= maxPurchasableServerRamExponent; e++)
        if (costByRamExponent[e] - baseUpgradeCredit <= spendableMoney)
            maxAffordableExp = e;

    if (maxAffordableExp == 0)
        return setStatus(ns, `${prefix}spendableMoney (${formatMoney(spendableMoney)}) is less than the cost ` +
            `of even the cheapest ${isUpgrade ? 'upgrade' : 'server'} (${formatMoney(costByRamExponent[minCandidateExp] - baseUpgradeCredit)} for ${formatRam(2 ** minCandidateExp)})`);
    if (maxAffordableExp < minCandidateExp)
        return setStatus(ns, `${prefix}The highest ram exponent we can afford (2^${maxAffordableExp}) on our budget ` +
            `of ${formatMoney(spendableMoney)} is less than the minimum needed (2^${minCandidateExp} for ${formatMoney(costByRamExponent[minCandidateExp] - baseUpgradeCredit)})`);

    const maxAffordableRam = Math.pow(2, maxAffordableExp);
    if (!isUpgrade && !options['allow-worse-purchases']) {
        if (worstServerName != null && maxAffordableRam < worstServerRam)
            return setStatus(ns, `${prefix}the most RAM we can buy (${formatRam(maxAffordableRam)}) on our budget of ` +
                `${formatMoney(spendableMoney)} is less than our worst purchased server ${worstServerName}'s RAM ${formatRam(worstServerRam)}`);
        if (bestServerName != null && maxAffordableRam < bestServerRam)
            return setStatus(ns, `${prefix}the most RAM we can buy (${formatRam(maxAffordableRam)}) on our budget of ` +
                `${formatMoney(spendableMoney)} is less than our previously purchased server ${bestServerName} RAM ${formatRam(bestServerRam)}`);
    }

    // Choose the best server exponent to purchase/upgrade:
    // - In linear-cost BNs (softcap = 1), larger servers have identical $/GB and less RAM fragmentation, so pick the largest valid tier.
    // - In softcap BNs (softcap > 1), smaller servers give dramatically more GB/$; pick the highest-GB/$ valid tier,
    //   jumping straight to any tier `e` where the entire farm can already afford to reach `2^e` on current spendableMoney.
    const startExp = (!isUpgrade && !options['allow-worse-purchases'] && bestServerRam > 0)
        ? Math.max(minCandidateExp, Math.log2(bestServerRam)) : minCandidateExp;
    let chosenExp = 0;
    let bestEfficiency = 0;
    let bestFarmCanReach = false;
    for (let e = startExp; e <= maxAffordableExp; e++) {
        const ram = Math.pow(2, e);
        const stepCost = costByRamExponent[e] - baseUpgradeCredit;
        const ramGain = isUpgrade ? ram - worstServerRam : ram;
        if (e < maxPurchasableServerRamExponent) {
            if (ram < homeRam * homeThreshold) continue;
            if (ramGain / totalMaxRam < networkThreshold) continue;
        }
        const efficiency = ramGain / stepCost;
        const costToBringFarmToE = (maxPurchasedServers - purchasedServers.length) * costByRamExponent[e] +
            purchasedServers.reduce((sum, s) => sum + (ramByServer[s] < ram ? costByRamExponent[e] - costByRamExponent[Math.log2(ramByServer[s])] : 0), 0);
        const farmCanReachE = hasSoftcap && costToBringFarmToE <= spendableMoney;
        if (chosenExp == 0 ||
            (farmCanReachE && e > chosenExp) ||
            (!bestFarmCanReach && (!hasSoftcap || efficiency > bestEfficiency * 1.0001 || (Math.abs(efficiency - bestEfficiency) <= bestEfficiency * 0.0001 && e > chosenExp)))) {
            chosenExp = e;
            bestEfficiency = efficiency;
            bestFarmCanReach = farmCanReachE;
        }
    }

    if (chosenExp == 0) {
        if (maxAffordableRam < homeRam * homeThreshold)
            return setStatus(ns, `${prefix}the most RAM we can buy (${formatRam(maxAffordableRam)}) on our budget of ${formatMoney(spendableMoney)} ` +
                `is less than --compare-to-home-threshold (${homeThreshold}) x home RAM (${formatRam(homeRam)})`);
        return setStatus(ns, `${prefix}the most RAM we can gain (${formatRam(isUpgrade ? maxAffordableRam - worstServerRam : maxAffordableRam)}) on our budget of ${formatMoney(spendableMoney)} ` +
            `is less than --compare-to-network-ram-threshold (${networkThreshold}) x total network RAM (${formatRam(totalMaxRam)})`);
    }

    const maxRamPossibleToBuy = Math.pow(2, chosenExp);
    const cost = costByRamExponent[chosenExp] - baseUpgradeCredit;
    const purchasedServer = isUpgrade
        ? ((await getNsDataThroughFile(ns, `ns.cloud.upgradeServer(ns.args[0], ns.args[1])`, null, [worstServerName, maxRamPossibleToBuy])) ? worstServerName : "")
        : await getNsDataThroughFile(ns, `ns.cloud.purchaseServer(ns.args[0], ns.args[1])`, null, [purchasedServerName, maxRamPossibleToBuy]);

    if (!purchasedServer)
        return setStatus(ns, `${prefix}Could not ${isUpgrade ? 'upgrade' : 'purchase'} a server with ${formatRam(maxRamPossibleToBuy)} ` +
            `RAM for ${formatMoney(cost)} with a budget of ${formatMoney(spendableMoney)}.`);

    log(ns, `SUCCESS: ${isUpgrade ? 'Upgraded' : 'Purchased'} server ${purchasedServer} with ${formatRam(maxRamPossibleToBuy)} ` +
        `RAM for ${formatMoney(cost)} (budget was ${formatMoney(spendableMoney)})`, true, 'success');
    budget -= cost;
    return true;
}
