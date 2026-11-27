/**
 * Fast, zero-RAM-cost IPvGO board engine and tactical MCTS player.
 * Pure JS (no ns.* calls) so Bitburner charges 0 GB RAM for importing it.
 *
 * Board representation:
 *  - Input from ns.go.getBoardState() is string[] of length N, where board[x][y] is
 *    'X' (Black/us), 'O' (White/opponent), '.' (empty), '#' (dead/offline node).
 *  - Internally we use a flat Int8Array of length N*N indexed by p = x * N + y:
 *    0 = empty (.), 1 = Black (X), 2 = White (O), 3 = Dead (#).
 *  - Incremental chain tracking with circular linked lists + pseudo-liberty moments
 *    (pseudoLibs, libSum, libSqSum) gives O(1) legality, O(1) capture, and O(1) exact atari.
 */

export const EMPTY = 0;
export const BLACK = 1;
export const WHITE = 2;
export const DEAD = 3;

const CHAR_TO_CELL = { '.': EMPTY, 'X': BLACK, 'O': WHITE, '#': DEAD };
const CELL_TO_CHAR = ['.', 'X', 'O', '#'];

// Precomputed neighbor tables per board size
const neighborCache = new Map();
const diagCache = new Map();
const nbr8Cache = new Map();

function getNeighborTables(size) {
    let nbr = neighborCache.get(size);
    if (nbr) return { nbr, diag: diagCache.get(size), nbr8: nbr8Cache.get(size) };
    const n2 = size * size;
    nbr = new Array(n2);
    const diag = new Array(n2);
    // 8-neighbors in fixed order: NW, N, NE, W, E, SW, S, SE (-1 if off-board)
    const nbr8 = new Int16Array(n2 * 8);
    const dxs8 = [-1, 0, 1, -1, 1, -1, 0, 1];
    const dys8 = [-1, -1, -1, 0, 0, 1, 1, 1];
    for (let x = 0; x < size; x++) {
        for (let y = 0; y < size; y++) {
            const p = x * size + y;
            const ns = [];
            if (x > 0) ns.push((x - 1) * size + y);
            if (x + 1 < size) ns.push((x + 1) * size + y);
            if (y > 0) ns.push(x * size + (y - 1));
            if (y + 1 < size) ns.push(x * size + (y + 1));
            nbr[p] = Int16Array.from(ns);

            const ds = [];
            if (x > 0 && y > 0) ds.push((x - 1) * size + (y - 1));
            if (x + 1 < size && y > 0) ds.push((x + 1) * size + (y - 1));
            if (x > 0 && y + 1 < size) ds.push((x - 1) * size + (y + 1));
            if (x + 1 < size && y + 1 < size) ds.push((x + 1) * size + (y + 1));
            diag[p] = Int16Array.from(ds);

            const base8 = p * 8;
            for (let k = 0; k < 8; k++) {
                const nx = x + dxs8[k];
                const ny = y + dys8[k];
                nbr8[base8 + k] = (nx >= 0 && nx < size && ny >= 0 && ny < size) ? (nx * size + ny) : -1;
            }
        }
    }
    neighborCache.set(size, nbr);
    diagCache.set(size, diag);
    nbr8Cache.set(size, nbr8);
    return { nbr, diag, nbr8 };
}

// ---------------------------------------------------------------------------
// Precomputed MoGo-style 3x3 pattern table (65536 entries, 2 bits per neighbor)
// Bit encoding per neighbor relative to player-to-move:
//   0 = EMPTY (.), 1 = SELF (X), 2 = OPP (O), 3 = WALL/DEAD (# or off-board)
// Order of 8 neighbors: 0=NW, 1=N, 2=NE, 3=W, 4=E, 5=SW, 6=S, 7=SE
// ---------------------------------------------------------------------------
let PATTERN_TABLE = null;

function buildPatternTable() {
    const table = new Uint8Array(65536);
    // Pattern spec strings: 8 chars (NW,N,NE,W,E,SW,S,SE)
    // Legend: '.'=0, 'X'=1, 'O'=2, 'W'=3, 'x'=0|1, 'o'=0|2, 'e'=1|2, 'b'=1|3, 'w'=2|3, '?'=any
    const charMask = {
        '.': 0b0001,
        'X': 0b0010,
        'O': 0b0100,
        'W': 0b1000,
        'x': 0b0011,
        'o': 0b0101,
        'e': 0b0110,
        'b': 0b1010,
        'w': 0b1100,
        '?': 0b1111,
    };

    const specs = [
        // Hane (classic MoGo patterns)
        { p: 'XO....??', pri: 10 },
        { p: 'XO?...?.', pri: 9 },
        { p: 'XOX...??', pri: 11 },
        { p: 'XO.O..??', pri: 10 },
        // Cut / crosscut / wedge / connect
        { p: 'XO?O????', pri: 11 },
        { p: '?X?OO???', pri: 12 }, // wedge/split between two enemy stones
        { p: '?O?XX???', pri: 11 }, // connect two friendly stones against cut
        { p: 'OX?X.?..', pri: 9 },  // diagonal connect / tiger's mouth
        { p: 'X.?O.X?.', pri: 8 },  // bamboo / net shape
        // Edge / dead-node (#) patterns (top row W W W)
        { p: 'WWWXO???', pri: 11 },
        { p: 'WWW?X?O?', pri: 10 },
        { p: 'WWWX.O??', pri: 9 },
        { p: 'WWW?O?X?', pri: 10 },
        { p: 'WWWO.?X?', pri: 9 },
        // Corner / dead-node nook defense & attack
        { p: 'WW?WX?O?', pri: 10 },
        { p: 'WW?WO?X?', pri: 10 },
    ];

    const rot90 = (s) => s[5] + s[3] + s[0] + s[6] + s[1] + s[7] + s[4] + s[2];
    const flipH = (s) => s[2] + s[1] + s[0] + s[4] + s[3] + s[7] + s[6] + s[5];

    const compiled = [];
    for (const { p, pri } of specs) {
        const seen = new Set();
        let cur = p;
        for (let r = 0; r < 4; r++) {
            seen.add(cur);
            seen.add(flipH(cur));
            cur = rot90(cur);
        }
        for (const variant of seen) {
            const masks = new Uint8Array(8);
            for (let i = 0; i < 8; i++) masks[i] = charMask[variant[i]];
            compiled.push({ masks, pri });
        }
    }

    for (let key = 0; key < 65536; key++) {
        const c0 = 1 << (key & 3);
        const c1 = 1 << ((key >> 2) & 3);
        const c2 = 1 << ((key >> 4) & 3);
        const c3 = 1 << ((key >> 6) & 3);
        const c4 = 1 << ((key >> 8) & 3);
        const c5 = 1 << ((key >> 10) & 3);
        const c6 = 1 << ((key >> 12) & 3);
        const c7 = 1 << ((key >> 14) & 3);
        let best = 0;
        for (let i = 0; i < compiled.length; i++) {
            const m = compiled[i].masks;
            if ((m[0] & c0) && (m[1] & c1) && (m[2] & c2) && (m[3] & c3) &&
                (m[4] & c4) && (m[5] & c5) && (m[6] & c6) && (m[7] & c7)) {
                if (compiled[i].pri > best) best = compiled[i].pri;
            }
        }
        table[key] = best;
    }
    return table;
}

function getPatternTable() {
    if (!PATTERN_TABLE) PATTERN_TABLE = buildPatternTable();
    return PATTERN_TABLE;
}

// Map (cell, myColor) -> 2-bit pattern code: 0=EMPTY, 1=SELF, 2=OPP, 3=WALL/DEAD
const REL_BLACK = new Uint8Array([0, 1, 2, 3]);
const REL_WHITE = new Uint8Array([0, 2, 1, 3]);

function patternKeyAt(cells, nbr8, p, color) {
    const rel = color === BLACK ? REL_BLACK : REL_WHITE;
    const base = p * 8;
    let key = 0;
    for (let k = 0; k < 8; k++) {
        const np = nbr8[base + k];
        const code = np < 0 ? 3 : rel[cells[np]];
        key |= code << (k * 2);
    }
    return key;
}

// Fast deterministic Zobrist table (two 32-bit ints per cell/color) for superko hashing
const zobristCache = new Map();
function getZobrist(size) {
    let z = zobristCache.get(size);
    if (z) return z;
    const n2 = size * size;
    const hi = new Uint32Array(n2 * 4);
    const lo = new Uint32Array(n2 * 4);
    let s = (0x9e3779b9 ^ (size * 2654435761)) >>> 0;
    const next = () => {
        s ^= s << 13;
        s ^= s >>> 17;
        s ^= s << 5;
        return s >>> 0;
    };
    for (let i = 0; i < n2 * 4; i++) {
        hi[i] = next();
        lo[i] = next();
    }
    z = { hi, lo };
    zobristCache.set(size, z);
    return z;
}

export function hashCells(cells, size) {
    const { hi, lo } = getZobrist(size);
    let h1 = 0, h2 = 0;
    for (let p = 0; p < cells.length; p++) {
        const c = cells[p];
        if (c === BLACK || c === WHITE) {
            const idx = (p << 2) | c;
            h1 ^= hi[idx];
            h2 ^= lo[idx];
        }
    }
    return (h1 >>> 0) * 4294967296 + (h2 >>> 0);
}

export function boardStringsToCells(boardStrings) {
    const size = boardStrings.length;
    const cells = new Int8Array(size * size);
    for (let x = 0; x < size; x++) {
        const col = boardStrings[x];
        const base = x * size;
        for (let y = 0; y < size; y++) {
            cells[base + y] = CHAR_TO_CELL[col[y]] ?? DEAD;
        }
    }
    return { cells, size };
}

export function cellsToBoardStrings(cells, size) {
    const out = new Array(size);
    for (let x = 0; x < size; x++) {
        let s = '';
        const base = x * size;
        for (let y = 0; y < size; y++) s += CELL_TO_CHAR[cells[base + y]];
        out[x] = s;
    }
    return out;
}

/**
 * Lightweight Go board state with incremental chain tracking (circular linked lists +
 * pseudo-liberty moments) for O(1) atari detection, capture, legality, and fast copy.
 */
export class GoBoard {
    /**
     * @param {number} size
     * @param {Int8Array} [cells]
     * @param {number} [koPoint]
     * @param {Set<number>|null} [historyHashes]
     */
    constructor(size, cells = null, koPoint = -1, historyHashes = null) {
        this.size = size;
        this.n2 = size * size;
        this.cells = cells ? new Int8Array(cells) : new Int8Array(this.n2);
        this.koPoint = koPoint;
        this.historyHashes = historyHashes;
        const { nbr, diag, nbr8 } = getNeighborTables(size);
        this.nbr = nbr;
        this.diag = diag;
        this.nbr8 = nbr8;

        // Incremental chain structures (indexed by root stone index in 0..n2-1):
        // - chainRoot[p]: root of chain containing stone p (-1 if not stone)
        // - chainNext[p]: next stone in circular linked list of chain
        // - chainSize[root]: number of stones in chain
        // - pseudoLibs[root]: sum of adjacent empty points across stones (with multiplicity)
        // - libSum[root]: sum of (libIndex + 1) across pseudo-liberties
        // - libSqSum[root]: sum of (libIndex + 1)^2 across pseudo-liberties
        //   Exact atari test: pseudoLibs * libSqSum === libSum * libSum  <=>  all pseudo-libs are the same single point!
        this.chainRoot = new Int16Array(this.n2);
        this.chainNext = new Int16Array(this.n2);
        this.chainSize = new Int16Array(this.n2);
        this.pseudoLibs = new Int16Array(this.n2);
        this.libSum = new Int32Array(this.n2);
        this.libSqSum = new Int32Array(this.n2);
        this.chainRoot.fill(-1);

        // Reusable scratch buffers for flood-fill (used by analyze/score/exact 2-lib queries)
        this._mark = new Int32Array(this.n2);
        this._markId = 0;
        this._stack = new Int16Array(this.n2);
        this._group = new Int16Array(this.n2);
        this._seenRoots = new Int16Array(4);

        if (cells) this._rebuildChains();
    }

    _rebuildChains() {
        const n2 = this.n2;
        const cells = this.cells;
        const nbr = this.nbr;
        const root = this.chainRoot;
        const next = this.chainNext;
        const cSize = this.chainSize;
        const pLibs = this.pseudoLibs;
        const lSum = this.libSum;
        const lSq = this.libSqSum;
        const stack = this._stack;

        root.fill(-1);
        for (let p = 0; p < n2; p++) {
            const c = cells[p];
            if ((c !== BLACK && c !== WHITE) || root[p] !== -1) continue;
            let sp = 0;
            stack[sp++] = p;
            root[p] = p;
            let prev = p;
            let count = 0;
            let pl = 0, ls = 0, lq = 0;

            while (sp > 0) {
                const cur = stack[--sp];
                count++;
                if (cur !== p) {
                    next[prev] = cur;
                    prev = cur;
                }
                const ns = nbr[cur];
                for (let i = 0; i < ns.length; i++) {
                    const np = ns[i];
                    const nc = cells[np];
                    if (nc === EMPTY) {
                        const v = np + 1;
                        pl++;
                        ls += v;
                        lq += v * v;
                    } else if (nc === c && root[np] === -1) {
                        root[np] = p;
                        stack[sp++] = np;
                    }
                }
            }
            next[prev] = p;
            cSize[p] = count;
            pLibs[p] = pl;
            lSum[p] = ls;
            lSq[p] = lq;
        }
    }

    copyFrom(other) {
        this.cells.set(other.cells);
        this.koPoint = other.koPoint;
        this.chainRoot.set(other.chainRoot);
        this.chainNext.set(other.chainNext);
        this.chainSize.set(other.chainSize);
        this.pseudoLibs.set(other.pseudoLibs);
        this.libSum.set(other.libSum);
        this.libSqSum.set(other.libSqSum);
    }

    static fromStrings(boardStrings, moveHistory = null) {
        const { cells, size } = boardStringsToCells(boardStrings);
        let historyHashes = null;
        if (moveHistory && moveHistory.length > 0) {
            historyHashes = new Set();
            for (const prev of moveHistory) {
                const { cells: pc } = boardStringsToCells(prev);
                historyHashes.add(hashCells(pc, size));
            }
            historyHashes.add(hashCells(cells, size));
        }
        return new GoBoard(size, cells, -1, historyHashes);
    }

    clone(withHistory = false) {
        const b = new GoBoard(
            this.size,
            null,
            this.koPoint,
            withHistory && this.historyHashes ? new Set(this.historyHashes) : null
        );
        b.copyFrom(this);
        return b;
    }

    /** O(1) exact check: does chain with root `r` have exactly 1 distinct liberty? */
    isChainInAtari(r) {
        const pl = this.pseudoLibs[r];
        if (pl <= 0) return false;
        const ls = this.libSum[r];
        return pl * this.libSqSum[r] === ls * ls;
    }

    /** O(1) exact single liberty point for a chain known to be in atari. */
    getAtariPoint(r) {
        return (this.libSum[r] / this.pseudoLibs[r]) - 1;
    }

    /**
     * Exact distinct liberty count & up to 2 liberty points for chain with root `r`.
     * Walks only the chain's circular linked list (fast, no full flood-fill).
     */
    getChainLiberties(r) {
        const cells = this.cells;
        const nbr = this.nbr;
        const next = this.chainNext;
        const mark = this._mark;
        this._markId += 1;
        if (this._markId > 0x70000000) { mark.fill(0); this._markId = 1; }
        const libMark = this._markId;

        let libs = 0;
        let lib1 = -1;
        let lib2 = -1;
        let cur = r;
        do {
            const ns = nbr[cur];
            for (let i = 0; i < ns.length; i++) {
                const np = ns[i];
                if (cells[np] === EMPTY && mark[np] !== libMark) {
                    mark[np] = libMark;
                    libs++;
                    if (lib1 < 0) lib1 = np;
                    else if (lib2 < 0) lib2 = np;
                }
            }
            cur = next[cur];
        } while (cur !== r);
        return { count: this.chainSize[r], libs, lib1, lib2 };
    }

    /** Merge chain `rb` into chain `ra` (both roots). */
    _mergeChains(ra, rb) {
        if (ra === rb) return ra;
        // Merge smaller into larger to minimize root relabeling
        if (this.chainSize[ra] < this.chainSize[rb]) {
            const tmp = ra; ra = rb; rb = tmp;
        }
        const root = this.chainRoot;
        const next = this.chainNext;
        let cur = rb;
        do {
            root[cur] = ra;
            cur = next[cur];
        } while (cur !== rb);
        // Splice circular linked lists
        const tmpNext = next[ra];
        next[ra] = next[rb];
        next[rb] = tmpNext;

        this.chainSize[ra] += this.chainSize[rb];
        this.pseudoLibs[ra] += this.pseudoLibs[rb];
        this.libSum[ra] += this.libSum[rb];
        this.libSqSum[ra] += this.libSqSum[rb];
        return ra;
    }

    /** Remove all stones in chain `r`, restoring liberties to adjacent chains. */
    _removeChain(r, capturedOut = null) {
        const cells = this.cells;
        const nbr = this.nbr;
        const root = this.chainRoot;
        const next = this.chainNext;
        const pLibs = this.pseudoLibs;
        const lSum = this.libSum;
        const lSq = this.libSqSum;

        let count = 0;
        let cur = r;
        do {
            const nxt = next[cur];
            cells[cur] = EMPTY;
            root[cur] = -1;
            if (capturedOut) capturedOut.push(cur);
            const v = cur + 1;
            const v2 = v * v;
            const ns = nbr[cur];
            for (let i = 0; i < ns.length; i++) {
                const nr = root[ns[i]];
                if (nr >= 0) {
                    pLibs[nr]++;
                    lSum[nr] += v;
                    lSq[nr] += v2;
                }
            }
            count++;
            cur = nxt;
        } while (cur !== r);
        return count;
    }

    /**
     * O(1) legality check (when checkSuperko=false): does placing `color` at `p` succeed?
     * Does not mutate board.
     */
    isLegal(p, color, checkSuperko = false) {
        if (p < 0 || p >= this.n2 || this.cells[p] !== EMPTY || p === this.koPoint) return false;
        const opp = 3 - color;
        const cells = this.cells;
        const root = this.chainRoot;
        const ns = this.nbr[p];

        let hasEmpty = false;
        let hasFriendNonAtari = false;
        let captures = false;
        for (let i = 0; i < ns.length; i++) {
            const np = ns[i];
            const nc = cells[np];
            if (nc === EMPTY) {
                hasEmpty = true;
            } else if (nc === color) {
                if (!this.isChainInAtari(root[np])) hasFriendNonAtari = true;
            } else if (nc === opp) {
                if (this.isChainInAtari(root[np])) captures = true;
            }
        }

        if (!hasEmpty && !hasFriendNonAtari && !captures) return false;
        if (!checkSuperko || !this.historyHashes) return true;

        // Superko check via fast scratch clone (only called at root/analyze, never in playouts)
        const tmp = this.clone(false);
        if (tmp.play(p, color, false) < 0) return false;
        const h = hashCells(tmp.cells, this.size);
        return !this.historyHashes.has(h);
    }

    /**
     * Play `color` at `p` in O(1) amortized time using incremental chains.
     * Returns number of captured stones (>= 0) if legal, or -1 if illegal.
     */
    play(p, color, checkSuperko = false) {
        if (p < 0 || p >= this.n2 || this.cells[p] !== EMPTY || p === this.koPoint) return -1;
        const opp = 3 - color;
        const cells = this.cells;
        const root = this.chainRoot;
        const next = this.chainNext;
        const pLibs = this.pseudoLibs;
        const lSum = this.libSum;
        const lSq = this.libSqSum;
        const ns = this.nbr[p];

        // Quick O(1) suicide check before mutating
        let hasEmpty = false;
        let hasFriendSafe = false;
        let canCapture = false;
        for (let i = 0; i < ns.length; i++) {
            const np = ns[i];
            const nc = cells[np];
            if (nc === EMPTY) hasEmpty = true;
            else if (nc === color) { if (!this.isChainInAtari(root[np])) hasFriendSafe = true; }
            else if (nc === opp) { if (this.isChainInAtari(root[np])) canCapture = true; }
        }
        if (!hasEmpty && !hasFriendSafe && !canCapture) return -1;

        // For superko-checked root moves, verify on a clone first so illegal superko never mutates
        if (checkSuperko && this.historyHashes) {
            const tmp = this.clone(false);
            const cap = tmp.play(p, color, false);
            if (cap < 0) return -1;
            const h = hashCells(tmp.cells, this.size);
            if (this.historyHashes.has(h)) return -1;
            this.copyFrom(tmp);
            this.historyHashes.add(h);
            return cap;
        }

        // Place stone as its own singleton chain
        const pv = p + 1;
        const pv2 = pv * pv;
        cells[p] = color;
        root[p] = p;
        next[p] = p;
        this.chainSize[p] = 1;

        let selfPl = 0, selfLs = 0, selfLq = 0;
        for (let i = 0; i < ns.length; i++) {
            const np = ns[i];
            const nc = cells[np];
            if (nc === EMPTY) {
                const v = np + 1;
                selfPl++;
                selfLs += v;
                selfLq += v * v;
            } else if (nc === BLACK || nc === WHITE) {
                // Neighbor chain loses one pseudo-liberty at p
                const nr = root[np];
                pLibs[nr]--;
                lSum[nr] -= pv;
                lSq[nr] -= pv2;
            }
        }
        pLibs[p] = selfPl;
        lSum[p] = selfLs;
        lSq[p] = selfLq;

        // Capture any adjacent opponent chains that now have 0 pseudo-liberties
        let captured = 0;
        let singleCapPoint = -1;
        for (let i = 0; i < ns.length; i++) {
            const np = ns[i];
            if (cells[np] === opp) {
                const nr = root[np];
                if (pLibs[nr] === 0) {
                    const cnt = this._removeChain(nr);
                    captured += cnt;
                    if (cnt === 1) singleCapPoint = np;
                }
            }
        }

        // Merge with adjacent friendly chains
        let myRoot = p;
        for (let i = 0; i < ns.length; i++) {
            const np = ns[i];
            if (cells[np] === color) {
                myRoot = this._mergeChains(myRoot, root[np]);
            }
        }

        // Simple ko: captured 1 stone, our stone is alone and in atari at the captured point
        if (captured === 1 && this.chainSize[myRoot] === 1 && this.isChainInAtari(myRoot)) {
            this.koPoint = singleCapPoint;
        } else {
            this.koPoint = -1;
        }
        return captured;
    }

    pass() {
        this.koPoint = -1;
    }

    /**
     * Checks if point `p` is a true eye for `color` (avoid filling own eyes in rollouts / endgame).
     */
    isTrueEye(p, color) {
        if (this.cells[p] !== EMPTY) return false;
        const cells = this.cells;
        const ns = this.nbr[p];
        for (let i = 0; i < ns.length; i++) {
            const nc = cells[ns[i]];
            if (nc !== color && nc !== DEAD) return false;
        }
        const ds = this.diag[p];
        const opp = 3 - color;
        let oppDiag = 0;
        let deadOrEdge = 4 - ds.length;
        for (let i = 0; i < ds.length; i++) {
            const dc = cells[ds[i]];
            if (dc === opp) oppDiag++;
            else if (dc === DEAD) deadOrEdge++;
        }
        // On edge/corner (or next to dead nodes), 0 enemy diagonals allowed; in center, at most 1
        return deadOrEdge > 0 ? oppDiag === 0 : oppDiag <= 1;
    }

    /**
     * Computes full board analysis matching Bitburner's ns.go.analysis.* APIs at 0 GB RAM:
     *  - chains: (number | null)[][]
     *  - liberties: number[][] (-1 for empty/dead)
     *  - controlled: string[] ('X', 'O', '?', '.', '#')
     *  - validMoves: boolean[][] (for Black by default, with superko if historyHashes present)
     */
    analyze(color = BLACK) {
        const size = this.size;
        const cells = this.cells;
        const nbr = this.nbr;
        const visited = new Uint8Array(this.n2);
        const chains = Array.from({ length: size }, () => new Array(size).fill(null));
        const liberties = Array.from({ length: size }, () => new Array(size).fill(-1));
        const controlledArr = Array.from({ length: size }, () => new Array(size).fill('.'));
        const stack = this._stack;
        const group = this._group;
        let chainId = 0;

        for (let p = 0; p < this.n2; p++) {
            if (visited[p]) continue;
            const c = cells[p];
            if (c === DEAD) {
                visited[p] = 1;
                controlledArr[(p / size) | 0][p % size] = '#';
                continue;
            }
            const id = chainId++;
            let sp = 0, gp = 0;
            stack[sp++] = p;
            visited[p] = 1;

            if (c === EMPTY) {
                let touchesBlack = false;
                let touchesWhite = false;
                while (sp > 0) {
                    const cur = stack[--sp];
                    group[gp++] = cur;
                    const ns = nbr[cur];
                    for (let i = 0; i < ns.length; i++) {
                        const np = ns[i];
                        const nc = cells[np];
                        if (nc === EMPTY && !visited[np]) {
                            visited[np] = 1;
                            stack[sp++] = np;
                        } else if (nc === BLACK) touchesBlack = true;
                        else if (nc === WHITE) touchesWhite = true;
                    }
                }
                const ctrl = (touchesBlack && !touchesWhite) ? 'X'
                    : (touchesWhite && !touchesBlack) ? 'O' : '?';
                for (let i = 0; i < gp; i++) {
                    const gpIdx = group[i];
                    const gx = (gpIdx / size) | 0;
                    const gy = gpIdx % size;
                    chains[gx][gy] = id;
                    controlledArr[gx][gy] = ctrl;
                }
            } else {
                // Stone chain: count distinct empty neighbors
                this._markId += 1;
                if (this._markId > 0x70000000) { this._mark.fill(0); this._markId = 1; }
                const libMark = this._markId;
                let libs = 0;
                while (sp > 0) {
                    const cur = stack[--sp];
                    group[gp++] = cur;
                    const ns = nbr[cur];
                    for (let i = 0; i < ns.length; i++) {
                        const np = ns[i];
                        const nc = cells[np];
                        if (nc === c && !visited[np]) {
                            visited[np] = 1;
                            stack[sp++] = np;
                        } else if (nc === EMPTY && this._mark[np] !== libMark) {
                            this._mark[np] = libMark;
                            libs++;
                        }
                    }
                }
                for (let i = 0; i < gp; i++) {
                    const gpIdx = group[i];
                    const gx = (gpIdx / size) | 0;
                    const gy = gpIdx % size;
                    chains[gx][gy] = id;
                    liberties[gx][gy] = libs;
                }
            }
        }

        const controlled = controlledArr.map(col => col.join(''));
        const validMoves = Array.from({ length: size }, (_, x) => {
            const col = new Array(size);
            const base = x * size;
            for (let y = 0; y < size; y++) {
                col[y] = this.isLegal(base + y, color, true);
            }
            return col;
        });

        return { chains, liberties, controlled, validMoves };
    }

    /**
     * Exact Chinese/IPvGO area score: stones + encircled empty territory (+ komi for White).
     * Returns { black, white, diff } where diff = black - white.
     */
    score(komi = 5.5) {
        const cells = this.cells;
        const nbr = this.nbr;
        const n2 = this.n2;
        const mark = this._mark;
        const stack = this._stack;

        this._markId += 1;
        if (this._markId > 0x70000000) { mark.fill(0); this._markId = 1; }
        const seen = this._markId;

        let black = 0;
        let white = komi;

        for (let p = 0; p < n2; p++) {
            const c = cells[p];
            if (c === BLACK) black++;
            else if (c === WHITE) white++;
            else if (c === EMPTY && mark[p] !== seen) {
                let sp = 0;
                let regionSize = 0;
                let touchesB = false;
                let touchesW = false;
                stack[sp++] = p;
                mark[p] = seen;
                while (sp > 0) {
                    const cur = stack[--sp];
                    regionSize++;
                    const ns = nbr[cur];
                    for (let i = 0; i < ns.length; i++) {
                        const np = ns[i];
                        const nc = cells[np];
                        if (nc === EMPTY) {
                            if (mark[np] !== seen) {
                                mark[np] = seen;
                                stack[sp++] = np;
                            }
                        } else if (nc === BLACK) touchesB = true;
                        else if (nc === WHITE) touchesW = true;
                    }
                }
                if (touchesB && !touchesW) black += regionSize;
                else if (touchesW && !touchesB) white += regionSize;
            }
        }
        return { black, white, diff: black - white };
    }
}

/**
 * Bounded 1v1 ladder reader: checks if `chainRoot` (owned by `defenderColor`, currently in atari)
 * can escape if defender plays its sole liberty first.
 * Returns true if the chain is caught in a working ladder (dies), false if it escapes.
 * Uses a fast scratch board copy; only called at root candidate scoring & key tactics.
 */
function isLadderDead(board, chainRoot, defenderColor, maxDepth = 18) {
    const attackerColor = 3 - defenderColor;
    const sim = board.clone(false);
    let targetRoot = chainRoot;

    for (let d = 0; d < maxDepth; d++) {
        // Defender must be in atari and tries to extend at its single liberty
        if (!sim.isChainInAtari(targetRoot)) return false;
        const esc = sim.getAtariPoint(targetRoot);
        if (esc < 0 || sim.play(esc, defenderColor, false) < 0) return true;

        targetRoot = sim.chainRoot[esc];
        const info = sim.getChainLiberties(targetRoot);
        if (info.libs <= 1) return true;  // Still in atari after extending -> dead
        if (info.libs >= 3) return false; // Escaped with 3+ liberties

        // Attacker chooses one of the 2 remaining liberties to put defender back in atari
        // Check if either liberty is adjacent to an attacker chain in atari (counter-atari breaks ladder)
        const ns = sim.nbr[info.lib1];
        for (let i = 0; i < ns.length; i++) {
            const np = ns[i];
            if (sim.cells[np] === attackerColor && sim.isChainInAtari(sim.chainRoot[np])) {
                // Defender could counter-capture if attacker doesn't fix
                break;
            }
        }

        // Try both attacker atari moves (branch only if 2nd is needed)
        const candA = info.lib1;
        const candB = info.lib2;
        // Prefer the atari that leaves defender with fewer empty neighbors on the OTHER liberty (drives toward edge)
        let emptyA = 0, emptyB = 0;
        const nsA = sim.nbr[candA], nsB = sim.nbr[candB];
        for (let i = 0; i < nsA.length; i++) if (sim.cells[nsA[i]] === EMPTY) emptyA++;
        for (let i = 0; i < nsB.length; i++) if (sim.cells[nsB[i]] === EMPTY) emptyB++;
        const first = emptyA >= emptyB ? candA : candB;
        const second = first === candA ? candB : candA;

        // Try first attacker move; if it fails to kill, try second via recursive branch
        if (sim.isLegal(first, attackerColor, false)) {
            const branch = (d < 4 && sim.isLegal(second, attackerColor, false)) ? sim.clone(false) : null;
            if (sim.play(first, attackerColor, false) >= 0) {
                const newRoot = sim.chainRoot[esc];
                if (newRoot < 0 || sim.cells[esc] !== defenderColor) return true;
                if (sim.isChainInAtari(newRoot)) {
                    targetRoot = newRoot;
                    continue;
                }
            }
            if (branch && branch.play(second, attackerColor, false) >= 0) {
                const bRoot = branch.chainRoot[esc];
                if (bRoot < 0 || branch.cells[esc] !== defenderColor) return true;
                if (branch.isChainInAtari(bRoot)) {
                    return isLadderDead(branch, bRoot, defenderColor, maxDepth - d - 1);
                }
            }
            return false;
        } else if (sim.play(second, attackerColor, false) >= 0) {
            const newRoot = sim.chainRoot[esc];
            if (newRoot < 0 || sim.cells[esc] !== defenderColor) return true;
            if (!sim.isChainInAtari(newRoot)) return false;
            targetRoot = newRoot;
        } else {
            return false;
        }
    }
    return false;
}

/**
 * Fast tactical move scorer used for MCTS prior biasing & candidate ordering.
 * Uses O(1) incremental chain stats + 3x3 pattern table + optional ladder check at root.
 */
function scoreCandidateMove(board, p, color, lastMove, controlledGrid = null, checkLadders = false) {
    const cells = board.cells;
    if (cells[p] !== EMPTY) return -1e9;
    const opp = 3 - color;
    const ns = board.nbr[p];
    const ds = board.diag[p];
    const size = board.size;
    const root = board.chainRoot;
    const cSize = board.chainSize;
    const pLibs = board.pseudoLibs;

    // Never fill own true eye
    if (board.isTrueEye(p, color)) return -1000;

    let score = 0;
    const x = (p / size) | 0;
    const y = p % size;

    let adjEmpty = 0;
    let adjFriend = 0;
    let adjOpp = 0;
    let adjDead = 0;
    let captures = 0;
    let savesAtari = 0;
    let savesAtariRoot = -1;
    let putsInAtari = 0;
    let friendlyLibsAfter = 0;
    let connectsTwoFriendChains = 0;
    let firstFriendChainRoot = -1;

    // Deduplicate adjacent chain roots (at most 4 orthogonal neighbors)
    const seen = board._seenRoots;
    let seenCount = 0;

    for (let i = 0; i < ns.length; i++) {
        const np = ns[i];
        const nc = cells[np];
        if (nc === EMPTY) {
            adjEmpty++;
            friendlyLibsAfter++;
        } else if (nc === DEAD) {
            adjDead++;
        } else if (nc === opp) {
            adjOpp++;
            const r = root[np];
            let dup = false;
            for (let s = 0; s < seenCount; s++) if (seen[s] === r) { dup = true; break; }
            if (dup) continue;
            seen[seenCount++] = r;

            if (board.isChainInAtari(r)) {
                captures += cSize[r];
            } else if (pLibs[r] <= 4) {
                const info = board.getChainLiberties(r);
                if (info.libs === 2) putsInAtari += cSize[r];
            }
        } else if (nc === color) {
            adjFriend++;
            const r = root[np];
            let dup = false;
            for (let s = 0; s < seenCount; s++) if (seen[s] === r) { dup = true; break; }
            if (dup) continue;
            seen[seenCount++] = r;

            if (board.isChainInAtari(r)) {
                savesAtari += cSize[r];
                savesAtariRoot = r;
            } else if (pLibs[r] <= 4) {
                const info = board.getChainLiberties(r);
                if (info.libs === 2) score += 6 + Math.min(cSize[r], 6);
                friendlyLibsAfter += info.libs - 1;
            } else {
                friendlyLibsAfter += Math.max(2, (pLibs[r] >> 1));
            }
            if (firstFriendChainRoot === -1) firstFriendChainRoot = r;
            else if (r !== firstFriendChainRoot) connectsTwoFriendChains++;
        }
    }

    // Immediate captures are huge
    if (captures > 0) score += 40 + captures * 18;

    // Saving our own stones in atari - check ladder at root so we don't chase a dead ladder
    if (savesAtari > 0) {
        if (friendlyLibsAfter >= 2 || captures > 0) {
            if (checkLadders && captures === 0 && friendlyLibsAfter === 2 && savesAtariRoot >= 0 &&
                isLadderDead(board, savesAtariRoot, color, 16)) {
                score -= 28; // Dead ladder: don't throw stones into it
            } else {
                score += 32 + savesAtari * 14;
            }
        } else {
            score -= 20;
        }
    }

    // Putting opponent chains into atari
    if (putsInAtari > 0 && (friendlyLibsAfter >= 2 || captures > 0)) {
        score += 14 + Math.min(putsInAtari, 8) * 4;
    }

    // Penalize self-atari (moving into 1 liberty without capturing)
    if (captures === 0 && friendlyLibsAfter <= 1) {
        score -= 30;
    }

    // Connecting separate friendly groups
    if (connectsTwoFriendChains > 0 && friendlyLibsAfter >= 2) {
        score += 10 * connectsTwoFriendChains;
    }

    // 3x3 MoGo tactical pattern bonus
    const patPri = getPatternTable()[patternKeyAt(cells, board.nbr8, p, color)];
    if (patPri > 0) score += patPri;

    // Diagonal contact (hane / tiger's mouth / cutting / bamboo joint)
    let diagFriend = 0, diagOpp = 0;
    for (let i = 0; i < ds.length; i++) {
        const dc = cells[ds[i]];
        if (dc === color) diagFriend++;
        else if (dc === opp) diagOpp++;
    }
    if (adjOpp > 0 && diagFriend > 0) score += 6;
    if (adjFriend > 0 && diagOpp > 0) score += 4;
    if (adjFriend === 0 && adjOpp === 0 && diagFriend > 0 && diagOpp > 0) score += 3;

    // Local response to opponent's last move
    if (lastMove >= 0) {
        const lx = (lastMove / size) | 0;
        const ly = lastMove % size;
        const dx = Math.abs(x - lx);
        const dy = Math.abs(y - ly);
        if (dx <= 1 && dy <= 1) score += 12;
        else if (dx <= 2 && dy <= 2) score += 5;
    }

    // Positional preference: 3rd/4th line early/midgame, avoid 1st line unless tactical
    const edgeDist = Math.min(x, size - 1 - x, y, size - 1 - y);
    if (edgeDist === 0) {
        if (adjOpp === 0 && captures === 0 && savesAtari === 0) score -= 8;
    } else if (edgeDist === 1) {
        score += (size <= 7 ? 3 : 1);
    } else if (edgeDist === 2 || edgeDist === 3) {
        score += 4;
    } else {
        score += 2;
    }

    // Avoid playing inside clearly owned territory
    if (controlledGrid) {
        const ch = controlledGrid[x][y];
        if ((color === BLACK && ch === 'X') || (color === WHITE && ch === 'O')) {
            if (captures === 0 && savesAtari === 0) score -= 45;
        }
    }

    score += adjEmpty * 1.2 - adjDead * 1.5;
    return score;
}

/**
 * Fast heavy playout using:
 *  1) O(1) incremental atari save/capture around prevMove
 *  2) Precomputed 3x3 MoGo pattern responses around prevMove
 *  3) LGRF-1 (Last-Good-Reply with Forgetting)
 *  4) Random legal non-eye move avoiding self-atari
 * Populates AMAF bitmaps for RAVE and records playout moves for LGRF update.
 */
function runPlayout(board, toPlay, komi, lastMove, maxPlies, rng, amafB, amafW, playoutId,
    lgrB, lgrW, playoutMoves, playoutColors) {
    const n2 = board.n2;
    const size = board.size;
    const cells = board.cells;
    const nbr = board.nbr;
    const nbr8 = board.nbr8;
    const root = board.chainRoot;
    const cSize = board.chainSize;
    const patTable = getPatternTable();

    let color = toPlay;
    let passes = 0;
    let prevMove = lastMove;
    let recorded = 0;

    for (let ply = 0; ply < maxPlies && passes < 2; ply++) {
        let chosen = -1;
        const opp = 3 - color;

        // 1. O(1) tactical atari check around opponent's last move
        if (prevMove >= 0) {
            const ns = nbr[prevMove];
            let bestTact = -1;
            let bestPri = 0;

            for (let i = 0; i < ns.length; i++) {
                const np = ns[i];
                const nc = cells[np];
                if (nc === color) {
                    const r = root[np];
                    if (board.isChainInAtari(r)) {
                        const lib = board.getAtariPoint(r);
                        if (lib !== board.koPoint && !board.isTrueEye(lib, color)) {
                            const pri = 20 + cSize[r];
                            if (pri > bestPri) { bestPri = pri; bestTact = lib; }
                        }
                    }
                } else if (nc === opp) {
                    const r = root[np];
                    if (board.isChainInAtari(r)) {
                        const lib = board.getAtariPoint(r);
                        if (lib !== board.koPoint) {
                            const pri = 30 + cSize[r];
                            if (pri > bestPri) { bestPri = pri; bestTact = lib; }
                        }
                    }
                }
            }
            if (cells[prevMove] === opp) {
                const r = root[prevMove];
                if (board.isChainInAtari(r)) {
                    const lib = board.getAtariPoint(r);
                    if (lib !== board.koPoint) {
                        const pri = 35 + cSize[r];
                        if (pri > bestPri) { bestPri = pri; bestTact = lib; }
                    }
                }
            }

            if (bestTact >= 0 && board.play(bestTact, color, false) >= 0) {
                chosen = bestTact;
            }
        }

        // 2. 3x3 MoGo pattern match in the 8-neighborhood of prevMove
        if (chosen < 0 && prevMove >= 0) {
            const base8 = prevMove * 8;
            let bestPatMove = -1;
            let bestPatPri = 0;
            const startDir = (rng() * 8) | 0;
            for (let k = 0; k < 8; k++) {
                const np = nbr8[base8 + ((startDir + k) & 7)];
                if (np < 0 || cells[np] !== EMPTY || np === board.koPoint) continue;
                if (board.isTrueEye(np, color)) continue;
                const pri = patTable[patternKeyAt(cells, nbr8, np, color)];
                if (pri > bestPatPri) {
                    bestPatPri = pri;
                    bestPatMove = np;
                }
            }
            if (bestPatMove >= 0 && board.play(bestPatMove, color, false) >= 0) {
                chosen = bestPatMove;
            }
        }

        // 3. LGRF-1: try the last winning reply to prevMove (with 70% probability)
        if (chosen < 0 && prevMove >= 0 && rng() < 0.7) {
            const reply = color === BLACK ? lgrB[prevMove] : lgrW[prevMove];
            if (reply >= 0 && cells[reply] === EMPTY && reply !== board.koPoint && !board.isTrueEye(reply, color)) {
                if (board.play(reply, color, false) >= 0) {
                    chosen = reply;
                }
            }
        }

        // 4. Random legal non-eye move (preferring moves with >= 1 empty neighbor to avoid self-atari)
        if (chosen < 0) {
            const start = (rng() * n2) | 0;
            let fallback = -1;
            for (let k = 0; k < n2; k++) {
                const p = (start + k) % n2;
                if (cells[p] !== EMPTY || p === board.koPoint) continue;
                if (board.isTrueEye(p, color)) continue;
                if (board.isLegal(p, color, false)) {
                    const pns = nbr[p];
                    let hasAir = false;
                    for (let i = 0; i < pns.length; i++) {
                        if (cells[pns[i]] === EMPTY) { hasAir = true; break; }
                    }
                    if (hasAir) {
                        board.play(p, color, false);
                        chosen = p;
                        break;
                    } else if (fallback < 0) {
                        fallback = p;
                    }
                }
            }
            if (chosen < 0 && fallback >= 0) {
                if (board.play(fallback, color, false) >= 0) chosen = fallback;
            }
        }

        if (chosen >= 0) {
            if (amafB[chosen] !== playoutId && amafW[chosen] !== playoutId) {
                if (color === BLACK) amafB[chosen] = playoutId;
                else amafW[chosen] = playoutId;
            }
            if (recorded < playoutMoves.length) {
                playoutMoves[recorded] = chosen;
                playoutColors[recorded] = color;
                recorded++;
            }
            passes = 0;
            prevMove = chosen;
        } else {
            board.pass();
            passes++;
            prevMove = -1;
        }
        color = opp;
    }

    const sc = board.score(komi);
    const blackWon = sc.diff > 0;

    // LGRF-1 update: winners' replies are remembered; losers' replies are forgotten
    const winColor = blackWon ? BLACK : WHITE;
    const winTable = blackWon ? lgrB : lgrW;
    const loseTable = blackWon ? lgrW : lgrB;
    for (let i = 1; i < recorded; i++) {
        const prev = playoutMoves[i - 1];
        const cur = playoutMoves[i];
        if (playoutColors[i] === winColor) {
            winTable[prev] = cur;
        } else if (loseTable[prev] === cur) {
            loseTable[prev] = -1;
        }
    }

    if (sc.diff > 0) return 0.85 + 0.15 * Math.tanh(sc.diff / (size * 1.5));
    if (sc.diff < 0) return 0.15 * (1 + Math.tanh(sc.diff / (size * 1.5)));
    return 0.5;
}

class MCTSNode {
    constructor(move, playerJustMoved, parent, prior = 0.5) {
        this.move = move; // -1 for pass, -2 for root
        this.playerJustMoved = playerJustMoved;
        this.parent = parent;
        this.prior = prior;
        this.visits = 0;
        this.wins = 0; // From Black's perspective
        this.raveVisits = 0;
        this.raveWins = 0; // From Black's perspective
        this.children = null;
        this.untriedMoves = null;
    }
}

/**
 * Generates ordered candidate moves for a tree node (top-K by tactical heuristic).
 */
function generateCandidates(board, color, lastMove, controlledGrid, maxCandidates, checkSuperko, checkLadders = false) {
    const n2 = board.n2;
    const scored = [];
    for (let p = 0; p < n2; p++) {
        if (board.cells[p] !== EMPTY || p === board.koPoint) continue;
        if (board.isTrueEye(p, color)) continue;
        if (!board.isLegal(p, color, checkSuperko)) continue;
        const s = scoreCandidateMove(board, p, color, lastMove, controlledGrid, checkLadders);
        if (s <= -40) continue;
        scored.push({ p, s });
    }
    scored.sort((a, b) => b.s - a.s);
    const limit = Math.min(scored.length, maxCandidates);
    const out = new Array(limit);
    const topS = limit > 0 ? scored[0].s : 0;
    const minS = limit > 0 ? scored[limit - 1].s : 0;
    const span = Math.max(1, topS - minS);
    for (let i = 0; i < limit; i++) {
        const prior = 0.15 + 0.8 * ((scored[i].s - minS) / span);
        out[i] = { move: scored[i].p, prior, rawScore: scored[i].s };
    }
    return out;
}

/**
 * Persistent MCTS session state for tree reuse + LGRF persistence across turns in a game.
 * Pass the same `MCTSSession` instance into `selectBestMove(..., { session })` each turn;
 * call `session.reset()` when a new game starts.
 */
export class MCTSSession {
    constructor() {
        this.reset();
    }

    reset() {
        this.root = null;
        this.size = 0;
        this.color = 0;
        this.lastBoardHash = 0;
        this.lastChosenMove = -2;
        this.lgrB = null;
        this.lgrW = null;
    }

    /**
     * Try to advance the saved tree by 2 plies (our last move -> opponent's reply)
     * and verify the resulting board matches the live board hash (guards against cheats/resets).
     */
    tryReuse(rootBoard, color, oppMove, oppPassed) {
        if (!this.root || this.size !== rootBoard.size || this.color !== color) {
            this.root = null;
            return null;
        }
        // Step 1: advance through our own chosen move
        const myNode = this._findChild(this.root, this.lastChosenMove);
        if (!myNode) { this.root = null; return null; }

        // Step 2: advance through opponent's move (or pass = -1)
        const oppMoveIdx = oppPassed ? -1 : oppMove;
        const nextRoot = this._findChild(myNode, oppMoveIdx);
        if (!nextRoot) { this.root = null; return null; }

        // Detach parent to allow GC of old tree branches
        nextRoot.parent = null;
        nextRoot.move = -2;
        return nextRoot;
    }

    _findChild(node, move) {
        if (!node || !node.children) return null;
        for (let i = 0; i < node.children.length; i++) {
            if (node.children[i].move === move) return node.children[i];
        }
        return null;
    }

    ensureLgr(n2) {
        if (!this.lgrB || this.lgrB.length !== n2) {
            this.lgrB = new Int16Array(n2).fill(-1);
            this.lgrW = new Int16Array(n2).fill(-1);
        }
    }
}

/**
 * Main AI move selector: Incremental-chain Tactical MCTS+RAVE with 3x3 patterns, LGRF,
 * ladder reading, tree reuse, and smart passing.
 *
 * @param {string[]} boardStrings - Current board from ns.go.getBoardState()
 * @param {object} [options]
 * @param {string[][]} [options.moveHistory] - Prior boards for superko enforcement
 * @param {number} [options.komi=5.5]
 * @param {[number, number] | null} [options.previousMove] - Opponent's last move [x, y] or null if pass
 * @param {boolean} [options.opponentPassed=false] - Whether opponent just passed
 * @param {number} [options.timeBudgetMs=120] - Think time per move in ms
 * @param {number} [options.maxIterations=2000] - Cap on MCTS iterations
 * @param {number} [options.color=BLACK] - Player to move (BLACK=1, WHITE=2)
 * @param {object} [options.analysis] - Optional precomputed board.analyze()
 * @param {MCTSSession|null} [options.session] - Optional persistent session for tree reuse & LGRF
 * @returns {{ type: 'move' | 'pass', x?: number, y?: number, winRate: number, iterations: number, reusedVisits: number, msg: string }}
 */
export function selectBestMove(boardStrings, options = {}) {
    const {
        moveHistory = null,
        komi = 5.5,
        previousMove = null,
        opponentPassed = false,
        timeBudgetMs = 250,
        maxIterations = 12000,
        color = BLACK,
        analysis = null,
        session = null,
    } = options;

    const rootBoard = GoBoard.fromStrings(boardStrings, moveHistory);
    const size = rootBoard.size;
    const n2 = rootBoard.n2;
    const lastMove = previousMove ? previousMove[0] * size + previousMove[1] : -1;
    const info = analysis ?? rootBoard.analyze(color);

    let emptyCount = 0;
    let stoneCount = 0;
    for (let p = 0; p < n2; p++) {
        const c = rootBoard.cells[p];
        if (c === EMPTY) emptyCount++;
        else if (c === BLACK || c === WHITE) stoneCount++;
    }

    // Smart pass: if opponent just passed and we are already winning on the board, pass to win immediately!
    const currentScore = rootBoard.score(komi);
    const myLead = color === BLACK ? currentScore.diff : -currentScore.diff;
    if (opponentPassed && myLead > 0) {
        if (session) session.reset();
        return {
            type: 'pass',
            winRate: 1.0,
            iterations: 0,
            reusedVisits: 0,
            msg: `Smart Pass (opponent passed, leading by ${myLead.toFixed(1)})`
        };
    }

    // Fast opening book for completely empty / very early corners
    if (stoneCount < 4) {
        const starPts = size === 13
            ? [[3, 3], [9, 9], [3, 9], [9, 3], [6, 6], [2, 2], [10, 10]]
            : size === 9
                ? [[2, 2], [6, 6], [2, 6], [6, 2], [4, 4]]
                : size === 7
                    ? [[2, 2], [4, 4], [2, 4], [4, 2], [3, 3]]
                    : [[2, 2], [1, 1], [3, 3], [1, 3], [3, 1]];
        for (const [sx, sy] of starPts) {
            const p = sx * size + sy;
            if (rootBoard.cells[p] === EMPTY && rootBoard.isLegal(p, color, true)) {
                const ns = rootBoard.nbr[p];
                let clear = true;
                for (let i = 0; i < ns.length; i++) if (rootBoard.cells[ns[i]] !== EMPTY) { clear = false; break; }
                if (clear) {
                    if (session) session.reset();
                    return { type: 'move', x: sx, y: sy, winRate: 0.55, iterations: 0, reusedVisits: 0, msg: `Opening Star (${sx},${sy})` };
                }
            }
        }
    }

    // Generate root candidates (with ladder check enabled at root)
    const maxRootCandidates = size <= 7 ? 20 : size <= 9 ? 22 : 24;
    const candidates = generateCandidates(rootBoard, color, lastMove, info.controlled, maxRootCandidates, true, true);

    if (candidates.length === 0) {
        if (session) session.reset();
        return {
            type: 'pass',
            winRate: myLead > 0 ? 1 : 0,
            iterations: 0,
            reusedVisits: 0,
            msg: 'Pass (no useful moves)'
        };
    }

    if (candidates.length === 1) {
        const p = candidates[0].move;
        if (session) session.reset();
        return {
            type: 'move',
            x: (p / size) | 0,
            y: p % size,
            winRate: 0.5,
            iterations: 0,
            reusedVisits: 0,
            msg: `Forced Move (${(p / size) | 0},${p % size})`
        };
    }

    // Include pass as a candidate in late game if there are few contested points
    let contestedCount = 0;
    for (let x = 0; x < size; x++) {
        for (let y = 0; y < size; y++) {
            if (info.controlled[x][y] === '?') contestedCount++;
        }
    }
    if (contestedCount <= 4 && myLead > 0) {
        candidates.push({ move: -1, prior: 0.4, rawScore: 0 });
    }

    // Tree reuse: try advancing saved tree by 2 plies and filter out any children now illegal (superko)
    let root = null;
    let reusedVisits = 0;
    if (session) {
        root = session.tryReuse(rootBoard, color, lastMove, opponentPassed);
        if (root) {
            reusedVisits = root.visits;
            // Filter reused children against exact root legality (handles superko) & merge fresh root candidates
            const legalSet = new Set(candidates.map(c => c.move));
            if (root.children) {
                root.children = root.children.filter(ch => ch.move === -1 ? legalSet.has(-1) : rootBoard.isLegal(ch.move, color, true));
            } else {
                root.children = [];
            }
            const existing = new Set(root.children.map(ch => ch.move));
            root.untriedMoves = candidates.filter(c => !existing.has(c.move));
        }
    }
    if (!root) {
        root = new MCTSNode(-2, 3 - color, null, 1.0);
        root.untriedMoves = candidates;
        root.children = [];
    }

    // LGRF-1 tables (persisted in session if provided, otherwise per-move)
    let lgrB, lgrW;
    if (session) {
        session.ensureLgr(n2);
        lgrB = session.lgrB;
        lgrW = session.lgrW;
    } else {
        lgrB = new Int16Array(n2).fill(-1);
        lgrW = new Int16Array(n2).fill(-1);
    }

    // Fast xorshift32 PRNG for playouts
    let seed = ((Date.now() ^ (stoneCount * 2654435761)) >>> 0) || 123456789;
    const rng = () => {
        seed ^= seed << 13;
        seed ^= seed >>> 17;
        seed ^= seed << 5;
        return (seed >>> 0) / 4294967296;
    };

    // Reusable simulation board & scratch buffers (zero GC pressure per iteration)
    const sim = rootBoard.clone(false);
    const amafB = new Int32Array(n2);
    const amafW = new Int32Array(n2);
    const maxPlies = Math.min(emptyCount + 24, size * size + 16);
    const playoutMoves = new Int16Array(maxPlies);
    const playoutColors = new Int8Array(maxPlies);

    const startTime = performance.now();
    const deadline = startTime + timeBudgetMs;
    const exploreC = 0.55;
    const raveK = size <= 9 ? 150 : 300;
    const priorWeight = 6.0;
    let iterations = 0;

    while (iterations < maxIterations) {
        if ((iterations & 15) === 0 && performance.now() >= deadline) break;
        iterations++;

        sim.copyFrom(rootBoard);
        let node = root;
        let simColor = color;
        let simLastMove = lastMove;

        // 1. Selection (UCT + RAVE + tactical prior)
        while (node.untriedMoves !== null && node.untriedMoves.length === 0 && node.children.length > 0) {
            const logN = Math.log(node.visits + 1);
            const isBlackTurn = simColor === BLACK;
            let bestChild = null;
            let bestScore = -1e9;

            for (let i = 0; i < node.children.length; i++) {
                const ch = node.children[i];
                const rawWin = isBlackTurn ? (ch.wins / ch.visits) : (1 - ch.wins / ch.visits);
                let val = rawWin;
                if (ch.raveVisits > 0) {
                    const raveWin = isBlackTurn ? (ch.raveWins / ch.raveVisits) : (1 - ch.raveWins / ch.raveVisits);
                    const beta = ch.raveVisits / (ch.visits + ch.raveVisits + (ch.visits * ch.raveVisits) / raveK);
                    val = (1 - beta) * rawWin + beta * raveWin;
                }
                const priorBonus = (priorWeight * ch.prior) / (ch.visits + 1);
                const ucb = val + exploreC * Math.sqrt(logN / ch.visits) + priorBonus;
                if (ucb > bestScore) {
                    bestScore = ucb;
                    bestChild = ch;
                }
            }
            node = bestChild;
            if (node.move >= 0) {
                sim.play(node.move, simColor, false);
                if (amafB[node.move] !== iterations && amafW[node.move] !== iterations) {
                    if (simColor === BLACK) amafB[node.move] = iterations;
                    else amafW[node.move] = iterations;
                }
                simLastMove = node.move;
            } else {
                sim.pass();
                simLastMove = -1;
            }
            simColor = 3 - simColor;
        }

        // 2. Expansion (progressive: expand only once node has been visited >= 2 times, or at root)
        if (node.untriedMoves === null && (node === root || node.visits >= 2)) {
            const cands = generateCandidates(sim, simColor, simLastMove, null, 12, false, false);
            node.untriedMoves = cands;
            node.children = [];
        }
        if (node.untriedMoves !== null && node.untriedMoves.length > 0) {
            const next = node.untriedMoves.shift();
            if (next.move >= 0) {
                if (sim.play(next.move, simColor, false) >= 0) {
                    if (amafB[next.move] !== iterations && amafW[next.move] !== iterations) {
                        if (simColor === BLACK) amafB[next.move] = iterations;
                        else amafW[next.move] = iterations;
                    }
                    simLastMove = next.move;
                } else {
                    continue;
                }
            } else {
                sim.pass();
                simLastMove = -1;
            }
            const child = new MCTSNode(next.move, simColor, node, next.prior);
            node.children.push(child);
            node = child;
            simColor = 3 - simColor;
        }

        // 3. Rollout (heavy tactical playout with 3x3 patterns + LGRF-1)
        const blackScore = runPlayout(sim, simColor, komi, simLastMove, maxPlies, rng, amafB, amafW, iterations,
            lgrB, lgrW, playoutMoves, playoutColors);

        // 4. Backpropagation + RAVE updates
        let cur = node;
        while (cur !== null) {
            cur.visits++;
            cur.wins += blackScore;
            if (cur.children !== null && cur.children.length > 0) {
                const childColor = 3 - cur.playerJustMoved;
                const amafArr = childColor === BLACK ? amafB : amafW;
                for (let i = 0; i < cur.children.length; i++) {
                    const ch = cur.children[i];
                    if (ch.move >= 0 && amafArr[ch.move] === iterations) {
                        ch.raveVisits++;
                        ch.raveWins += blackScore;
                    }
                }
            }
            cur = cur.parent;
        }
    }

    // Choose child with highest visit count (robust child), tie-breaking by win rate
    let best = null;
    const isBlack = color === BLACK;
    for (let i = 0; i < root.children.length; i++) {
        const ch = root.children[i];
        const chWr = isBlack ? (ch.wins / ch.visits) : (1 - ch.wins / ch.visits);
        if (!best || ch.visits > best.visits || (ch.visits === best.visits && chWr > best.wr)) {
            best = { node: ch, visits: ch.visits, wr: chWr };
        }
    }

    // Save root & chosen move in session for tree reuse on next turn
    if (session) {
        session.root = root;
        session.size = size;
        session.color = color;
        session.lastChosenMove = best ? best.node.move : -1;
    }

    const reuseTag = reusedVisits > 0 ? `+${reusedVisits}r` : '';
    if (!best || best.node.move < 0) {
        return {
            type: 'pass',
            winRate: best ? best.wr : 0.5,
            iterations,
            reusedVisits,
            msg: `MCTS Pass (${iterations}${reuseTag} sims, wr=${((best?.wr ?? 0.5) * 100).toFixed(1)}%)`
        };
    }

    const mx = (best.node.move / size) | 0;
    const my = best.node.move % size;
    return {
        type: 'move',
        x: mx,
        y: my,
        winRate: best.wr,
        iterations,
        reusedVisits,
        msg: `MCTS (${mx},${my}) [${iterations}${reuseTag} sims, v=${best.visits}, wr=${(best.wr * 100).toFixed(1)}%]`
    };
}

/**
 * Finds the best SnakeEyes cheat target: an enemy chain with exactly 2 liberties and >= minKilled stones.
 * Fixed version: scans full board (0..size-1, not 0..size-2) and finds exact 2 distinct liberties cleanly.
 */
export function findSnakeEyesTarget(boardStrings, minKilled = 5) {
    const board = GoBoard.fromStrings(boardStrings);
    const size = board.size;
    const cells = board.cells;
    const nbr = board.nbr;
    const visited = new Uint8Array(board.n2);
    let best = null;
    let bestSize = minKilled - 1;

    for (let p = 0; p < board.n2; p++) {
        if (visited[p] || cells[p] !== WHITE) continue;
        // Flood-fill enemy chain and collect its distinct liberties
        const stack = [p];
        visited[p] = 1;
        let chainSize = 0;
        const libs = new Set();
        while (stack.length > 0) {
            const cur = stack.pop();
            chainSize++;
            const ns = nbr[cur];
            for (let i = 0; i < ns.length; i++) {
                const np = ns[i];
                const nc = cells[np];
                if (nc === WHITE && !visited[np]) {
                    visited[np] = 1;
                    stack.push(np);
                } else if (nc === EMPTY) {
                    libs.add(np);
                }
            }
        }
        if (libs.size === 2 && chainSize > bestSize) {
            const [l1, l2] = [...libs];
            bestSize = chainSize;
            best = {
                x1: (l1 / size) | 0,
                y1: l1 % size,
                x2: (l2 / size) | 0,
                y2: l2 % size,
                killed: chainSize,
            };
        }
    }
    return best;
}
