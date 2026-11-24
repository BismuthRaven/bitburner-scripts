/**
 * Fast, zero-RAM-cost IPvGO board engine and tactical MCTS player.
 * Pure JS (no ns.* calls) so Bitburner charges 0 GB RAM for importing it.
 *
 * Board representation:
 *  - Input from ns.go.getBoardState() is string[] of length N, where board[x][y] is
 *    'X' (Black/us), 'O' (White/opponent), '.' (empty), '#' (dead/offline node).
 *  - Internally we use a flat Int8Array of length N*N indexed by p = x * N + y:
 *    0 = empty (.), 1 = Black (X), 2 = White (O), 3 = Dead (#).
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

function getNeighborTables(size) {
    let nbr = neighborCache.get(size);
    if (nbr) return { nbr, diag: diagCache.get(size) };
    const n2 = size * size;
    nbr = new Array(n2);
    const diag = new Array(n2);
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
        }
    }
    neighborCache.set(size, nbr);
    diagCache.set(size, diag);
    return { nbr, diag };
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
 * Lightweight Go board state supporting fast copy, play, liberty/chain queries, and Chinese/IPvGO scoring.
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
        const { nbr, diag } = getNeighborTables(size);
        this.nbr = nbr;
        this.diag = diag;
        // Reusable scratch buffers for flood-fill (avoid per-call allocations in rollouts)
        this._mark = new Int32Array(this.n2);
        this._markId = 0;
        this._stack = new Int16Array(this.n2);
        this._group = new Int16Array(this.n2);
    }

    copyFrom(other) {
        this.cells.set(other.cells);
        this.koPoint = other.koPoint;
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
        return new GoBoard(
            this.size,
            this.cells,
            this.koPoint,
            withHistory && this.historyHashes ? new Set(this.historyHashes) : null
        );
    }

    /**
     * Returns { count, libs, lastLib } for the chain at start (stone of color).
     * Uses internal scratch buffers; do not nest calls.
     */
    _inspectChain(start) {
        const color = this.cells[start];
        const cells = this.cells;
        const nbr = this.nbr;
        const mark = this._mark;
        const stack = this._stack;
        const group = this._group;

        this._markId += 2;
        if (this._markId > 0x70000000) {
            mark.fill(0);
            this._markId = 2;
        }
        const stoneMark = this._markId;
        const libMark = this._markId + 1;

        let sp = 0;
        let gp = 0;
        let libs = 0;
        let lastLib = -1;

        stack[sp++] = start;
        mark[start] = stoneMark;

        while (sp > 0) {
            const p = stack[--sp];
            group[gp++] = p;
            const ns = nbr[p];
            for (let i = 0; i < ns.length; i++) {
                const np = ns[i];
                const nc = cells[np];
                if (nc === EMPTY) {
                    if (mark[np] !== libMark) {
                        mark[np] = libMark;
                        libs++;
                        lastLib = np;
                    }
                } else if (nc === color && mark[np] !== stoneMark) {
                    mark[np] = stoneMark;
                    stack[sp++] = np;
                }
            }
        }
        return { count: gp, libs, lastLib };
    }

    /** Fast check: does placing `color` at `p` succeed? Does not mutate board if illegal.
     *  If `checkSuperko` is true and historyHashes is set, also enforces positional superko.
     */
    isLegal(p, color, checkSuperko = false) {
        if (p < 0 || p >= this.n2 || this.cells[p] !== EMPTY || p === this.koPoint) return false;
        const opp = 3 - color;
        const cells = this.cells;
        const ns = this.nbr[p];

        // Quick accept: if any adjacent point is empty, it's never suicide (still check superko if needed)
        let hasEmpty = false;
        for (let i = 0; i < ns.length; i++) {
            if (cells[ns[i]] === EMPTY) { hasEmpty = true; break; }
        }
        if (hasEmpty && !checkSuperko) return true;

        // Tentatively place stone
        cells[p] = color;
        let captures = false;
        const capturedStones = checkSuperko ? [] : null;

        for (let i = 0; i < ns.length; i++) {
            const np = ns[i];
            if (cells[np] === opp) {
                const info = this._inspectChain(np);
                if (info.libs === 0) {
                    captures = true;
                    if (!checkSuperko) break;
                    for (let j = 0; j < info.count; j++) {
                        const cp = this._group[j];
                        cells[cp] = EMPTY;
                        capturedStones.push(cp);
                    }
                }
            }
        }

        let legal = hasEmpty || captures;
        if (!legal) {
            const selfInfo = this._inspectChain(p);
            legal = selfInfo.libs > 0;
        }

        if (legal && checkSuperko && this.historyHashes) {
            const h = hashCells(cells, this.size);
            if (this.historyHashes.has(h)) legal = false;
        }

        // Undo tentative placement
        if (capturedStones) {
            for (let i = 0; i < capturedStones.length; i++) cells[capturedStones[i]] = opp;
        }
        cells[p] = EMPTY;
        return legal;
    }

    /**
     * Play `color` at `p`. Returns number of captured stones (>= 0) if legal, or -1 if illegal.
     * Updates koPoint (simple ko) and optionally historyHashes.
     */
    play(p, color, checkSuperko = false) {
        if (p < 0 || p >= this.n2 || this.cells[p] !== EMPTY || p === this.koPoint) return -1;
        const opp = 3 - color;
        const cells = this.cells;
        const ns = this.nbr[p];

        cells[p] = color;
        let captured = 0;
        let singleCapPoint = -1;
        const capturedStones = checkSuperko ? [] : null;

        for (let i = 0; i < ns.length; i++) {
            const np = ns[i];
            if (cells[np] === opp) {
                const info = this._inspectChain(np);
                if (info.libs === 0) {
                    const cnt = info.count;
                    captured += cnt;
                    if (cnt === 1) singleCapPoint = np;
                    for (let j = 0; j < cnt; j++) {
                        const cp = this._group[j];
                        cells[cp] = EMPTY;
                        if (capturedStones) capturedStones.push(cp);
                    }
                }
            }
        }

        const selfInfo = this._inspectChain(p);
        if (selfInfo.libs === 0) {
            // Suicide - undo
            if (capturedStones) {
                for (let i = 0; i < capturedStones.length; i++) cells[capturedStones[i]] = opp;
            }
            cells[p] = EMPTY;
            return -1;
        }

        if (checkSuperko && this.historyHashes) {
            const h = hashCells(cells, this.size);
            if (this.historyHashes.has(h)) {
                for (let i = 0; i < capturedStones.length; i++) cells[capturedStones[i]] = opp;
                cells[p] = EMPTY;
                return -1;
            }
            this.historyHashes.add(h);
        }

        // Simple ko: captured exactly 1 stone, and our placed stone is alone with 1 liberty (that captured point)
        if (captured === 1 && selfInfo.count === 1 && selfInfo.libs === 1) {
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
 * Fast tactical move scorer used for:
 *  1) MCTS prior biasing & candidate pruning
 *  2) Heavy playouts (tactical rollout policy: save atari, capture, local 3x3 response, avoid self-atari)
 */
function scoreCandidateMove(board, p, color, lastMove, controlledGrid = null) {
    const cells = board.cells;
    if (cells[p] !== EMPTY) return -1e9;
    const opp = 3 - color;
    const ns = board.nbr[p];
    const ds = board.diag[p];
    const size = board.size;

    // Never fill own true eye
    if (board.isTrueEye(p, color)) return -1000;

    // Already completely owned empty territory (no enemy stones nearby)? Low priority unless tactical
    let score = 0;
    const x = (p / size) | 0;
    const y = p % size;

    let adjEmpty = 0;
    let adjFriend = 0;
    let adjOpp = 0;
    let adjDead = 0;
    let captures = 0;
    let savesAtari = 0;
    let putsInAtari = 0;
    let friendlyLibsAfter = 0;
    let connectsTwoFriendChains = 0;
    let firstFriendChainRoot = -1;

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
            const info = board._inspectChain(np);
            if (info.libs === 1) {
                captures += info.count;
            } else if (info.libs === 2) {
                putsInAtari += info.count;
            }
        } else if (nc === color) {
            adjFriend++;
            const info = board._inspectChain(np);
            if (info.libs === 1) {
                savesAtari += info.count;
            } else if (info.libs === 2) {
                score += 6 + Math.min(info.count, 6);
            }
            friendlyLibsAfter += info.libs - 1;
            const root = board._group[0];
            if (firstFriendChainRoot === -1) firstFriendChainRoot = root;
            else if (root !== firstFriendChainRoot) connectsTwoFriendChains++;
        }
    }

    // Immediate captures are huge
    if (captures > 0) score += 40 + captures * 18;

    // Saving our own stones in atari - only if it actually escapes (has >= 2 liberties after, or captures)
    if (savesAtari > 0) {
        if (friendlyLibsAfter >= 2 || captures > 0) {
            score += 32 + savesAtari * 14;
        } else {
            // Throwing good stones after bad (self-atari into 1 liberty)
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

    // Diagonal contact (hane / tiger's mouth / cutting / bamboo joint)
    let diagFriend = 0, diagOpp = 0;
    for (let i = 0; i < ds.length; i++) {
        const dc = cells[ds[i]];
        if (dc === color) diagFriend++;
        else if (dc === opp) diagOpp++;
    }
    if (adjOpp > 0 && diagFriend > 0) score += 7; // hane / cut
    if (adjFriend > 0 && diagOpp > 0) score += 5; // extend / counter-cut
    if (adjFriend === 0 && adjOpp === 0 && diagFriend > 0 && diagOpp > 0) score += 4;

    // Local response to opponent's last move (tenuki penalty / local urgency)
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

    // Avoid playing inside clearly owned territory (controlledGrid[x][y] === 'X')
    if (controlledGrid) {
        const ch = controlledGrid[x][y];
        if ((color === BLACK && ch === 'X') || (color === WHITE && ch === 'O')) {
            if (captures === 0 && savesAtari === 0) score -= 45;
        }
    }

    // Slight bonus for open space around empty moves
    score += adjEmpty * 1.2 - adjDead * 1.5;

    return score;
}

/**
 * Fast heavy playout from `board` with `toPlay` next, returning Black's outcome in [0, 1]
 * and populating `amafB`/`amafW` bitmaps for RAVE (AMAF) credit assignment.
 */
function runPlayout(board, toPlay, komi, lastMove, maxPlies, rng, amafB, amafW, playoutId) {
    const n2 = board.n2;
    const size = board.size;
    const cells = board.cells;
    const nbr = board.nbr;
    let color = toPlay;
    let passes = 0;
    let prevMove = lastMove;

    for (let ply = 0; ply < maxPlies && passes < 2; ply++) {
        let chosen = -1;

        // 1. Tactical check around opponent's last move (atari capture / save / local fight)
        if (prevMove >= 0) {
            const ns = nbr[prevMove];
            const opp = 3 - color;
            let bestTact = -1;
            let bestPri = 0;

            for (let i = 0; i < ns.length; i++) {
                const np = ns[i];
                const nc = cells[np];
                if (nc === color) {
                    const info = board._inspectChain(np);
                    if (info.libs === 1 && info.lastLib >= 0 && info.lastLib !== board.koPoint) {
                        const pri = 20 + info.count;
                        if (pri > bestPri && !board.isTrueEye(info.lastLib, color)) {
                            bestPri = pri;
                            bestTact = info.lastLib;
                        }
                    }
                } else if (nc === opp) {
                    const info = board._inspectChain(np);
                    if (info.libs === 1 && info.lastLib >= 0 && info.lastLib !== board.koPoint) {
                        const pri = 30 + info.count;
                        if (pri > bestPri) {
                            bestPri = pri;
                            bestTact = info.lastLib;
                        }
                    }
                }
            }
            if (cells[prevMove] === opp) {
                const info = board._inspectChain(prevMove);
                if (info.libs === 1 && info.lastLib >= 0 && info.lastLib !== board.koPoint) {
                    const pri = 35 + info.count;
                    if (pri > bestPri) {
                        bestPri = pri;
                        bestTact = info.lastLib;
                    }
                }
            }

            if (bestTact >= 0 && board.play(bestTact, color, false) >= 0) {
                chosen = bestTact;
            }
        }

        // 2. Local 3x3 response with 60% probability if no urgent atari
        if (chosen < 0 && prevMove >= 0 && rng() < 0.6) {
            const lx = (prevMove / size) | 0;
            const ly = prevMove % size;
            const startDir = (rng() * 8) | 0;
            const dxs = [-1, 0, 1, -1, 1, -1, 0, 1];
            const dys = [-1, -1, -1, 0, 0, 1, 1, 1];
            for (let k = 0; k < 8; k++) {
                const idx = (startDir + k) & 7;
                const nx = lx + dxs[idx];
                const ny = ly + dys[idx];
                if (nx >= 0 && nx < size && ny >= 0 && ny < size) {
                    const np = nx * size + ny;
                    if (cells[np] === EMPTY && !board.isTrueEye(np, color)) {
                        if (board.play(np, color, false) >= 0) {
                            chosen = np;
                            break;
                        }
                    }
                }
            }
        }

        // 3. Random legal non-eye move (avoiding obvious self-atari when possible)
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
            // Record first-play AMAF owner for RAVE
            if (amafB[chosen] !== playoutId && amafW[chosen] !== playoutId) {
                if (color === BLACK) amafB[chosen] = playoutId;
                else amafW[chosen] = playoutId;
            }
            passes = 0;
            prevMove = chosen;
        } else {
            board.pass();
            passes++;
            prevMove = -1;
        }
        color = 3 - color;
    }

    const sc = board.score(komi);
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
 * Generates ordered candidate moves for a tree node (top-K by tactical heuristic + pass if endgame).
 */
function generateCandidates(board, color, lastMove, controlledGrid, maxCandidates, checkSuperko) {
    const n2 = board.n2;
    const scored = [];
    for (let p = 0; p < n2; p++) {
        if (board.cells[p] !== EMPTY || p === board.koPoint) continue;
        if (board.isTrueEye(p, color)) continue;
        if (!board.isLegal(p, color, checkSuperko)) continue;
        const s = scoreCandidateMove(board, p, color, lastMove, controlledGrid);
        // Skip clearly dead moves inside our own territory unless nothing else exists
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
        // Prior in [0.15, 0.95]
        const prior = 0.15 + 0.8 * ((scored[i].s - minS) / span);
        out[i] = { move: scored[i].p, prior, rawScore: scored[i].s };
    }
    return out;
}

/**
 * Main AI move selector: Tactical MCTS+RAVE with progressive widening, tactical shortcuts, and smart passing.
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
 * @returns {{ type: 'move' | 'pass', x?: number, y?: number, winRate: number, iterations: number, msg: string }}
 */
export function selectBestMove(boardStrings, options = {}) {
    const {
        moveHistory = null,
        komi = 5.5,
        previousMove = null,
        opponentPassed = false,
        timeBudgetMs = 120,
        maxIterations = 2000,
        color = BLACK,
        analysis = null,
    } = options;

    const rootBoard = GoBoard.fromStrings(boardStrings, moveHistory);
    const size = rootBoard.size;
    const n2 = rootBoard.n2;
    const lastMove = previousMove ? previousMove[0] * size + previousMove[1] : -1;
    const info = analysis ?? rootBoard.analyze(color);

    // Count empty cells to gauge game phase
    let emptyCount = 0;
    for (let p = 0; p < n2; p++) if (rootBoard.cells[p] === EMPTY) emptyCount++;

    // Smart pass: if opponent just passed and we are already winning on the board, pass to win immediately!
    const currentScore = rootBoard.score(komi);
    const myLead = color === BLACK ? currentScore.diff : -currentScore.diff;
    if (opponentPassed && myLead > 0) {
        return {
            type: 'pass',
            winRate: 1.0,
            iterations: 0,
            msg: `Smart Pass (opponent passed, leading by ${myLead.toFixed(1)})`
        };
    }

    // Generate root candidates (narrower on 13x13 so each move gets enough MCTS+RAVE visits)
    const maxRootCandidates = size <= 7 ? 20 : size <= 9 ? 22 : 24;
    const candidates = generateCandidates(rootBoard, color, lastMove, info.controlled, maxRootCandidates, true);

    if (candidates.length === 0) {
        return {
            type: 'pass',
            winRate: myLead > 0 ? 1 : 0,
            iterations: 0,
            msg: 'Pass (no useful moves)'
        };
    }

    // Fast opening book for completely empty / very early corners to save time & play strong shape
    let stoneCount = 0;
    for (let p = 0; p < n2; p++) if (rootBoard.cells[p] === BLACK || rootBoard.cells[p] === WHITE) stoneCount++;
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
                    return { type: 'move', x: sx, y: sy, winRate: 0.55, iterations: 0, msg: `Opening Star (${sx},${sy})` };
                }
            }
        }
    }

    if (candidates.length === 1) {
        const p = candidates[0].move;
        return {
            type: 'move',
            x: (p / size) | 0,
            y: p % size,
            winRate: 0.5,
            iterations: 0,
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

    // Fast xorshift32 PRNG for playouts
    let seed = ((Date.now() ^ (stoneCount * 2654435761)) >>> 0) || 123456789;
    const rng = () => {
        seed ^= seed << 13;
        seed ^= seed >>> 17;
        seed ^= seed << 5;
        return (seed >>> 0) / 4294967296;
    };

    const root = new MCTSNode(-2, 3 - color, null, 1.0);
    root.untriedMoves = candidates;
    root.children = [];

    // Reusable simulation board & AMAF buffers (zero GC pressure per iteration)
    const sim = rootBoard.clone(false);
    const amafB = new Int32Array(n2);
    const amafW = new Int32Array(n2);

    const startTime = performance.now();
    const deadline = startTime + timeBudgetMs;
    const maxPlies = Math.min(emptyCount + 24, size * size + 16);
    const exploreC = 0.55;
    const raveK = size <= 9 ? 150 : 300; // RAVE equivalence parameter (controls AMAF vs UCT blend)
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
            const cands = generateCandidates(sim, simColor, simLastMove, null, 12, false);
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

        // 3. Rollout (heavy tactical playout)
        const blackScore = runPlayout(sim, simColor, komi, simLastMove, maxPlies, rng, amafB, amafW, iterations);

        // 4. Backpropagation + RAVE updates
        let cur = node;
        while (cur !== null) {
            cur.visits++;
            cur.wins += blackScore;
            if (cur.children !== null && cur.children.length > 0) {
                // Children of `cur` are moves played by `3 - cur.playerJustMoved`
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

    if (!best || best.node.move < 0) {
        return {
            type: 'pass',
            winRate: best ? best.wr : 0.5,
            iterations,
            msg: `MCTS Pass (${iterations} sims, wr=${((best?.wr ?? 0.5) * 100).toFixed(1)}%)`
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
        msg: `MCTS (${mx},${my}) [${iterations} sims, v=${best.visits}, wr=${(best.wr * 100).toFixed(1)}%]`
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
