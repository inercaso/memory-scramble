/* Copyright (c) 2021-25 MIT 6.102/6.031 course staff, all rights reserved.
 * Redistribution of original or derived work requires permission of course staff.
 */

import assert from 'node:assert';
import fs from 'node:fs';

/** Represents the state of a single card on the board. */
interface CardState {
    value: string;           // card's display string; non-empty, no whitespace
    faceUp: boolean;         // true if visible to all players
    controller: string | null; // playerId controlling this card, or null
}

/** Represents a player's current game state. */
interface PlayerState {
    firstCard: { row: number; col: number } | null;
    secondCard: { row: number; col: number } | null;
    previousCards: Array<{ row: number; col: number }>;
    previousMatched: boolean;
}

/** Deferred promise pattern for async waiting. */
interface Deferred<T> {
    promise: Promise<T>;
    resolve: (value: T) => void;
    reject: (reason: Error) => void;
}

/** @returns a new Deferred with an unresolved promise */
function createDeferred<T>(): Deferred<T> {
    const { promise, resolve, reject } = Promise.withResolvers<T>();
    return { promise, resolve, reject };
}

/**
 * A mutable, concurrency-safe game board for Memory Scramble.
 * 
 * Players can flip cards concurrently. When a player flips a card controlled
 * by another player, they wait (without busy-waiting) until it becomes available.
 */
export class Board {

    private readonly rows: number;
    private readonly columns: number;
    private readonly cards: Array<Array<CardState | null>>;
    private readonly playerStates: Map<string, PlayerState>;
    private readonly cardWaiters: Map<string, Array<Deferred<void>>>;
    private readonly changeWatchers: Array<Deferred<void>>;

    // Abstraction Function:
    //   AF(rows, columns, cards, playerStates, cardWaiters, changeWatchers) =
    //     a Memory Scramble board with dimensions rows × columns where:
    //     - cards[r][c] is the card at position (r, c), or null if removed
    //     - playerStates tracks each player's current and previous cards
    //     - cardWaiters holds promises for players waiting to control cards
    //     - changeWatchers holds promises for players watching for changes
    //
    // Rep Invariant:
    //   - rows > 0 && columns > 0
    //   - cards.length === rows && cards[i].length === columns for all i
    //   - if card.controller !== null, then card.faceUp === true
    //   - if player.secondCard !== null, then player.firstCard !== null
    //
    // Safety from Rep Exposure:
    //   - all fields are private and readonly
    //   - no public method returns references to mutable internal objects
    //   - look() and toString() return new strings

    /**
     * @param rows number of rows, requires rows > 0
     * @param columns number of columns, requires columns > 0
     * @param cardValues card values in row-major order, requires length === rows * columns
     */
    private constructor(rows: number, columns: number, cardValues: Array<string>) {
        this.rows = rows;
        this.columns = columns;
        this.cards = [];
        this.playerStates = new Map();
        this.cardWaiters = new Map();
        this.changeWatchers = [];

        let index = 0;
        for (let r = 0; r < rows; r++) {
            const row: Array<CardState | null> = [];
            for (let c = 0; c < columns; c++) {
                row.push({
                    value: cardValues[index] ?? '',
                    faceUp: false,
                    controller: null
                });
                index++;
            }
            this.cards.push(row);
        }

        this.checkRep();
    }

    /** Asserts the rep invariant. */
    private checkRep(): void {
        assert(this.rows > 0, 'rows must be positive');
        assert(this.columns > 0, 'columns must be positive');
        assert(this.cards.length === this.rows, 'cards array length must match rows');
        
        for (let r = 0; r < this.rows; r++) {
            assert(this.cards[r]?.length === this.columns, `row ${r} length must match columns`);
            for (let c = 0; c < this.columns; c++) {
                const card = this.cards[r]?.[c];
                if (card !== null && card !== undefined && card.controller !== null) {
                    assert(card.faceUp, `controlled card at (${r},${c}) must be face up`);
                }
            }
        }

        for (const [playerId, state] of this.playerStates) {
            if (state.secondCard !== null) {
                assert(state.firstCard !== null, `player ${playerId} has second card but no first card`);
            }
        }
    }

    /** @returns number of rows (always > 0) */
    public getRows(): number {
        return this.rows;
    }

    /** @returns number of columns (always > 0) */
    public getColumns(): number {
        return this.columns;
    }

    /** @returns the PlayerState for playerId, creating one if needed */
    private getPlayerState(playerId: string): PlayerState {
        let state = this.playerStates.get(playerId);
        if (!state) {
            state = {
                firstCard: null,
                secondCard: null,
                previousCards: [],
                previousMatched: false
            };
            this.playerStates.set(playerId, state);
        }
        return state;
    }

    /** @returns unique string key for board position (row, col) */
    private posKey(row: number, col: number): string {
        return `${row},${col}`;
    }

    /** Resolves all pending watch() promises and clears the watchers list. */
    private notifyChangeWatchers(): void {
        const watchers = [...this.changeWatchers];
        this.changeWatchers.length = 0;
        for (const watcher of watchers) {
            watcher.resolve();
        }
    }

    /** Resolves the first waiter for card at (row, col) in FIFO order. */
    private notifyCardWaiters(row: number, col: number): void {
        const key = this.posKey(row, col);
        const waiters = this.cardWaiters.get(key);
        if (waiters && waiters.length > 0) {
            const first = waiters.shift();
            first?.resolve();
        }
    }

    /**
     * Handles cleanup from player's previous move (rules 3-A, 3-B).
     * @param playerId the player whose previous move to handle
     */
    private handlePreviousMove(playerId: string): void {
        const state = this.getPlayerState(playerId);

        if (state.previousCards.length === 0) {
            return;
        }

        if (state.previousMatched) {
            // rule 3-A: remove matched pair
            for (const pos of state.previousCards) {
                const card = this.cards[pos.row]?.[pos.col];
                if (card) {
                    card.controller = null;
                    const row = this.cards[pos.row];
                    if (row) {
                        row[pos.col] = null;
                    }
                    this.notifyCardWaiters(pos.row, pos.col);
                }
            }
            this.notifyChangeWatchers();
        } else {
            // rule 3-B: turn face down if not controlled by another player
            let changed = false;
            for (const pos of state.previousCards) {
                const card = this.cards[pos.row]?.[pos.col];
                if (card && card.faceUp && card.controller === null) {
                    card.faceUp = false;
                    changed = true;
                }
            }
            if (changed) {
                this.notifyChangeWatchers();
            }
        }

        state.previousCards = [];
        state.previousMatched = false;
    }

    /**
     * Flip a card on the board following gameplay rules 1-A through 2-E.
     * 
     * @param playerId ID of player flipping, requires nonempty alphanumeric/underscore string
     * @param row row of card, requires 0 <= row < rows
     * @param column column of card, requires 0 <= column < columns
     * @returns board state in BOARD_STATE format after the flip
     * @throws Error "no card at this position" if space is empty (rules 1-A, 2-A)
     * @throws Error "card is controlled by a player" if second card is controlled (rule 2-B)
     */
    public async flip(playerId: string, row: number, column: number): Promise<string> {
        const state = this.getPlayerState(playerId);

        if (state.firstCard === null) {
            this.handlePreviousMove(playerId);
            await this.flipFirstCard(playerId, row, column);
        } else if (state.secondCard === null) {
            this.flipSecondCard(playerId, row, column);
        } else {
            this.handlePreviousMove(playerId);
            state.firstCard = null;
            state.secondCard = null;
            await this.flipFirstCard(playerId, row, column);
        }

        this.checkRep();
        return this.look(playerId);
    }

    /**
     * Flip first card (rules 1-A through 1-D).
     * @throws Error if no card at position
     */
    private async flipFirstCard(playerId: string, row: number, column: number): Promise<void> {
        const state = this.getPlayerState(playerId);

        let card = this.cards[row]?.[column];
        if (card === null || card === undefined) {
            throw new Error('no card at this position');
        }

        // rule 1-D: wait if controlled by another player
        while (card.controller !== null && card.controller !== playerId) {
            const key = this.posKey(row, column);
            let waiters = this.cardWaiters.get(key);
            if (!waiters) {
                waiters = [];
                this.cardWaiters.set(key, waiters);
            }
            const deferred = createDeferred<void>();
            waiters.push(deferred);
            await deferred.promise;

            card = this.cards[row]?.[column];
            if (card === null || card === undefined) {
                throw new Error('no card at this position');
            }
        }

        // rules 1-B, 1-C: turn up and control
        if (!card.faceUp) {
            card.faceUp = true;
            this.notifyChangeWatchers();
        }
        card.controller = playerId;
        state.firstCard = { row, col: column };
    }

    /**
     * Flip second card (rules 2-A through 2-E).
     * @throws Error if no card at position or card is controlled
     */
    private flipSecondCard(playerId: string, row: number, column: number): void {
        const card = this.cards[row]?.[column];
        const state = this.getPlayerState(playerId);
        const firstPos = state.firstCard;

        if (!firstPos) {
            throw new Error('no first card');
        }

        const firstCard = this.cards[firstPos.row]?.[firstPos.col];

        // rule 2-A: empty space
        if (card === null || card === undefined) {
            this.relinquishFirstCard(playerId);
            throw new Error('no card at this position');
        }

        // rule 2-B: controlled by any player
        if (card.controller !== null) {
            this.relinquishFirstCard(playerId);
            throw new Error('card is controlled by a player');
        }

        // rule 2-C: turn face up
        if (!card.faceUp) {
            card.faceUp = true;
            this.notifyChangeWatchers();
        }

        state.secondCard = { row, col: column };

        if (firstCard && card.value === firstCard.value) {
            // rule 2-D: match
            card.controller = playerId;
            state.previousCards = [firstPos, { row, col: column }];
            state.previousMatched = true;
        } else {
            // rule 2-E: no match
            if (firstCard) {
                firstCard.controller = null;
                this.notifyCardWaiters(firstPos.row, firstPos.col);
            }
            state.previousCards = [firstPos, { row, col: column }];
            state.previousMatched = false;
        }
    }

    /** Relinquish control of player's first card when second flip fails. */
    private relinquishFirstCard(playerId: string): void {
        const state = this.getPlayerState(playerId);
        if (state.firstCard) {
            const card = this.cards[state.firstCard.row]?.[state.firstCard.col];
            if (card) {
                card.controller = null;
                this.notifyCardWaiters(state.firstCard.row, state.firstCard.col);
            }
            state.previousCards = [state.firstCard];
            state.previousMatched = false;
        }
        state.firstCard = null;
        state.secondCard = null;
    }

    /**
     * Look at the current board state from a player's perspective.
     * 
     * @param playerId ID of player looking, requires nonempty alphanumeric/underscore string
     * @returns board state in BOARD_STATE format: "ROWxCOL\n" followed by one line per card
     *          ("none", "down", "up VALUE", or "my VALUE")
     */
    public look(playerId: string): string {
        let result = `${this.rows}x${this.columns}\n`;

        for (let r = 0; r < this.rows; r++) {
            for (let c = 0; c < this.columns; c++) {
                const card = this.cards[r]?.[c];
                if (card === null || card === undefined) {
                    result += 'none\n';
                } else if (!card.faceUp) {
                    result += 'down\n';
                } else if (card.controller === playerId) {
                    result += `my ${card.value}\n`;
                } else {
                    result += `up ${card.value}\n`;
                }
            }
        }

        return result;
    }

    /**
     * Apply a transformation to all cards, maintaining pairwise consistency.
     * 
     * @param playerId ID of player applying map, requires nonempty alphanumeric/underscore string
     * @param f transformation function, requires f is a pure function (same input → same output)
     * @returns board state in BOARD_STATE format after transformation
     */
    public async map(playerId: string, f: (card: string) => Promise<string>): Promise<string> {
        const valueGroups = new Map<string, Array<{ row: number; col: number }>>();

        for (let r = 0; r < this.rows; r++) {
            for (let c = 0; c < this.columns; c++) {
                const card = this.cards[r]?.[c];
                if (card) {
                    let positions = valueGroups.get(card.value);
                    if (!positions) {
                        positions = [];
                        valueGroups.set(card.value, positions);
                    }
                    positions.push({ row: r, col: c });
                }
            }
        }

        for (const [oldValue, positions] of valueGroups) {
            const newValue = await f(oldValue);
            if (newValue !== oldValue) {
                for (const pos of positions) {
                    const card = this.cards[pos.row]?.[pos.col];
                    if (card && card.value === oldValue) {
                        card.value = newValue;
                    }
                }
                this.notifyChangeWatchers();
            }
        }

        this.checkRep();
        return this.look(playerId);
    }

    /**
     * Watch for board changes (card flip, removal, or value change via map).
     * 
     * @param playerId ID of player watching, requires nonempty alphanumeric/underscore string
     * @returns board state in BOARD_STATE format when a change occurs
     */
    public async watch(playerId: string): Promise<string> {
        const deferred = createDeferred<void>();
        this.changeWatchers.push(deferred);
        await deferred.promise;
        return this.look(playerId);
    }

    /**
     * @returns human-readable board representation for debugging:
     *          "[ ]" = removed, "[?]" = face down, "[VALUE]" = face up
     */
    public toString(): string {
        let result = `Board(${this.rows}x${this.columns}):\n`;
        for (let r = 0; r < this.rows; r++) {
            for (let c = 0; c < this.columns; c++) {
                const card = this.cards[r]?.[c];
                if (card === null || card === undefined) {
                    result += '[ ] ';
                } else if (!card.faceUp) {
                    result += '[?] ';
                } else {
                    result += `[${card.value}] `;
                }
            }
            result += '\n';
        }
        return result;
    }

    /**
     * Make a new board by parsing a file.
     * 
     * PS4 instructions: the specification of this method may not be changed.
     * 
     * @param filename path to game board file
     * @returns a new board with the size and cards from the file
     * @throws Error if the file cannot be read or is not a valid game board
     */
    public static async parseFromFile(filename: string): Promise<Board> {
        const content = await fs.promises.readFile(filename, 'utf-8');
        const lines = content.split(/\r?\n/).filter(line => line.length > 0);

        if (lines.length === 0) {
            throw new Error('empty board file');
        }

        const header = lines[0];
        const match = header?.match(/^(\d+)x(\d+)$/);
        if (!match) {
            throw new Error('invalid board header format');
        }

        const rows = parseInt(match[1] ?? '0');
        const columns = parseInt(match[2] ?? '0');

        if (rows <= 0 || columns <= 0) {
            throw new Error('invalid board dimensions');
        }

        const expectedCards = rows * columns;
        const cardLines = lines.slice(1);

        if (cardLines.length !== expectedCards) {
            throw new Error(`expected ${expectedCards} cards but got ${cardLines.length}`);
        }

        const cardValues: Array<string> = [];
        for (const line of cardLines) {
            if (!/^[^\s\n\r]+$/.test(line)) {
                throw new Error(`invalid card format: ${line}`);
            }
            cardValues.push(line);
        }

        return new Board(rows, columns, cardValues);
    }
}
