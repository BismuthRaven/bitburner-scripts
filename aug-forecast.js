// Pure math behind autopilot's "when is it worth installing augmentations" forecast. No Bitburner API is used
// here, so it can be exercised offline with `node .tools/aug-forecast-test.mjs`.
// See .vault/aug-install-forecast.md for the design.

/** Money source categories that represent income. Deliberately excludes *_expenses, servers, hospitalization and augmentations:
 * spending on servers/augs must not look like negative income. */
export const EARNING_CATEGORIES = ['hacking', 'hacknet', 'gang', 'crime', 'work', 'stock', 'sleeves', 'bladeburner',
    'codingcontract', 'infiltration', 'corporation', 'class', 'casino', 'darknet', 'other'];
/** How hard sample noise counts against the trend's confidence (noise equal to the typical step => quality 0) */
const NOISE_PENALTY = 2;

/** @typedef {{ name: string, faction: string|null, price: number, donation_cost: number, money_needed: number,
 *             rep_needed: number, rep_have: number, donations_unlocked: boolean, money_gap: number, rep_gap: number }} ForecastAug */

/** Total money earned since install across EARNING_CATEGORIES. `stock` is lumpy (only realised on sale), so
 * short-window rate measurements leave it out.
 * @param {MoneySources} moneySources
 * @param {boolean} includeStock
 * @returns {number} */
export function grossEarnings(moneySources, includeStock = false) {
    const sources = moneySources?.sinceInstall ?? {};
    return EARNING_CATEGORIES.reduce((total, cat) => total + (cat == 'stock' && !includeStock ? 0 : (sources[cat] || 0)), 0);
}

/** @param {number[]} values @returns {number} The median of the finite values (NaN when there are none) */
export function median(values) {
    const sorted = values.filter(v => Number.isFinite(v)).sort((a, b) => a - b);
    if (sorted.length == 0) return NaN;
    const mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Robust slope of a cumulative series: the median of the per-interval slopes. Unlike a least-squares fit (or a
 * Theil-Sen median over all point pairs), a *single* lumpy sample - a stock sale, a big crime payout - only affects
 * the one interval it lands in, so it cannot fake a trend.
 * @param {{t: number, y: number}[]} points
 * @param {number} minDtMs Ignore intervals shorter than this
 * @returns {number} slope in y units per millisecond (NaN when there are no usable intervals) */
export function robustSlope(points, minDtMs = 1000) {
    const slopes = [];
    for (let i = 1; i < points.length; i++) {
        const dt = points[i].t - points[i - 1].t;
        if (dt >= minDtMs) slopes.push((points[i].y - points[i - 1].y) / dt);
    }
    return median(slopes);
}

/** Fit a line to a cumulative series and say how noisy it is relative to its own growth.
 * Noise is measured against the typical per-sample step: a series that jitters by as much as it grows cannot be
 * extrapolated, while a flat series with no jitter is perfectly predictable.
 * @param {{t: number, y: number}[]} points
 * @param {number} minDtMs
 * @returns {{ slopePerMs: number, ratePerSecond: number, relativeNoise: number, quality: number, count: number }} */
export function fitTrend(points, minDtMs = 1000) {
    const count = points.length;
    if (count < 2) return { slopePerMs: 0, ratePerSecond: 0, relativeNoise: Infinity, quality: 0, count };
    const slopePerMs = robustSlope(points, minDtMs);
    if (!Number.isFinite(slopePerMs)) return { slopePerMs: 0, ratePerSecond: 0, relativeNoise: Infinity, quality: 0, count };
    const meanDt = (points[count - 1].t - points[0].t) / (count - 1);
    const step = Math.abs(slopePerMs) * meanDt; // How much the series grows between two samples on average
    const intercept = median(points.map(p => p.y - slopePerMs * p.t));
    const mad = median(points.map(p => Math.abs(p.y - (intercept + slopePerMs * p.t)))); // Median absolute deviation
    const relativeNoise = step > 0 ? mad / step : mad > 0 ? Infinity : 0;
    return {
        slopePerMs, ratePerSecond: slopePerMs * 1000, relativeNoise, count,
        quality: Math.max(0, Math.min(1, 1 - NOISE_PENALTY * relativeNoise)),
    };
}

/** Estimate the income rate ($/s) from a window of cumulative-earnings samples.
 * @param {{t: number, y: number}[]} points
 * @param {{minSamples?: number, minDtMs?: number}} opts
 * @returns {{ ratePerSecond: number, quality: number, relativeNoise: number, count: number }} */
export function estimateIncomeRate(points, { minSamples = 12, minDtMs = 1000 } = {}) {
    const fit = fitTrend(points, minDtMs);
    return { ...fit, ratePerSecond: Math.max(0, fit.ratePerSecond), quality: fit.count >= minSamples ? fit.quality : 0 };
}

/** Time until an augmentation's two gates open (money and reputation).
 * @param {{ moneyNeeded: number, moneyHave: number, moneyPerMs: number, repNeeded: number, repHave: number,
 *           repPerMs: number, donationsUnlocked: boolean }} gates
 * @returns {{ etaMoney: number, etaRep: number, eta: number }} milliseconds, Infinity when the gate cannot open */
export function etaForAug({ moneyNeeded, moneyHave, moneyPerMs, repNeeded, repHave, repPerMs, donationsUnlocked }) {
    const etaMoney = moneyNeeded <= moneyHave ? 0 : moneyPerMs > 0 ? (moneyNeeded - moneyHave) / moneyPerMs : Infinity;
    // When donations are unlocked, reputation is bought with money, so its cost is already part of moneyNeeded
    const etaRep = donationsUnlocked || repHave >= repNeeded ? 0 : repPerMs > 0 ? (repNeeded - repHave) / repPerMs : Infinity;
    return { etaMoney, etaRep, eta: Math.max(etaMoney, etaRep) };
}

/** exp(-eta/tau): income grows superlinearly early in a BN, so a linear extrapolation far out is unreliable. */
export function horizonDecay(etaMs, tauMs) {
    return Number.isFinite(etaMs) ? Math.exp(-Math.max(0, etaMs) / tauMs) : 0;
}

/** ETA for each of the next augmentations faction-manager could not afford, plus the one autopilot decides on.
 * @param {{ nextAugs: ForecastAug[], budget: number, incomeRatePerSecond: number, incomeQuality: number,
 *           repRates: {[faction: string]: number}|null, deficit: number, mature: boolean, tauMs: number }} params
 *   repRates: measured rep/s per faction. A faction missing from the map has an unknown rate (as opposed to a
 *   measured 0), so a rep-gated aug of that faction gets no ETA and the decision falls back to the timer.
 *   deficit: how many more augs are needed to reach the install threshold.
 * @returns {null|{ candidates: any[], etaNextAug: number|null, etaToThreshold: number|null, nextAug: string|null,
 *                  confidence: number, trendConfidence: number }} */
export function forecastAugTiming({ nextAugs, budget, incomeRatePerSecond, incomeQuality, repRates, deficit, mature, tauMs }) {
    if (!nextAugs || nextAugs.length == 0) return null;
    const moneyPerMs = Math.max(0, incomeRatePerSecond) / 1000;
    const candidates = nextAugs.map(aug => {
        const repNeeded = aug.rep_needed || 0, repHave = aug.rep_have || 0;
        const repGated = !aug.donations_unlocked && repHave < repNeeded;
        const repRate = repRates ? repRates[aug.faction] : undefined;
        if (repGated && repRate == null)
            return { ...aug, eta: null }; // No measured rep rate: we cannot tell when the rep gate opens
        const { etaMoney, etaRep, eta } = etaForAug({
            moneyNeeded: aug.money_needed, moneyHave: budget, moneyPerMs,
            repNeeded, repHave, repPerMs: (repGated ? repRate : 0) / 1000, donationsUnlocked: aug.donations_unlocked,
        });
        return { ...aug, etaMoney, etaRep, eta };
    });
    const etas = candidates.map(c => c.eta).filter(e => e !== null);
    const etaNextAug = etas.length ? Math.min(...etas) : null;
    // NeuroFlux levels are not part of the candidate list by design: they are always "next up", so they would
    // always be reachable and the forecast would always say "wait" (autopilot counts them separately).
    // The augs that reach the threshold are the `deficit` soonest ones, so order by ETA (unknown last).
    const byEta = candidates.slice().sort((a, b) => (a.eta ?? Infinity) - (b.eta ?? Infinity));
    const threshold = byEta[deficit - 1] || null;
    const etaToThreshold = threshold ? threshold.eta : null;
    const trendConfidence = Math.max(0, Math.min(1, incomeQuality)) * (mature ? 1 : 0);
    return {
        candidates, etaNextAug, etaToThreshold,
        nextAug: etaNextAug === null ? null : candidates.find(c => c.eta === etaNextAug)?.name ?? null,
        trendConfidence,
        confidence: etaToThreshold === null ? 0 : trendConfidence * horizonDecay(etaToThreshold, tauMs),
    };
}

/** Whether to install now, wait for the forecast ETA (plus padding), or fall back to the plain countdown.
 * The countdown is only the padding for an uncertain forecast, so this is deliberate: whatever the rule, the
 * forecast may only change *when* we install, never *whether* we install.
 * @param {null|{ etaToThreshold: number|null, confidence: number, trendConfidence: number }} forecast
 * @param {{ confidenceThreshold: number, horizonMs: number, paddingMs: number }} opts
 * @returns {{ action: 'install'|'wait'|'timer', reason: string, waitMs: number }} */
export function decideInstallTiming(forecast, { confidenceThreshold, horizonMs, paddingMs }) {
    if (!forecast) return { action: 'timer', reason: 'no-forecast', waitMs: paddingMs };
    if (forecast.etaToThreshold === null) return { action: 'timer', reason: 'unknown', waitMs: paddingMs };
    // The "don't wait" decisions only need the trend to be trustworthy, not the horizon decay (which is what makes
    // far-out predictions untrustworthy in the first place: an ETA of 115 days is a solid reason to stop waiting).
    if (forecast.trendConfidence < confidenceThreshold) return { action: 'timer', reason: 'low-confidence', waitMs: paddingMs };
    if (forecast.etaToThreshold === Infinity) return { action: 'install', reason: 'no-more-augs', waitMs: 0 };
    if (forecast.etaToThreshold > horizonMs) return { action: 'install', reason: 'beyond-horizon', waitMs: 0 };
    if (forecast.confidence < confidenceThreshold) return { action: 'timer', reason: 'low-confidence', waitMs: paddingMs };
    return { action: 'wait', reason: 'waiting', waitMs: forecast.etaToThreshold + paddingMs };
}
