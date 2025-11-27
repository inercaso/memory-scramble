/* Copyright (c) 2021-25 MIT 6.102/6.031 course staff, all rights reserved.
 * Redistribution of original or derived work requires permission of course staff.
 */

import assert from 'node:assert';
import fs from 'node:fs';

/**
 * represents the state of a single card on the board
 */
interface CardState {
    value: string;
    faceUp: boolean;
    controller: string | null;
}

/**
 * represents a player's current game state
 */
interface PlayerState {
    firstCard: { row: number; col: number } | null;
    secondCard: { row: number; col: number } | null;
    previousCards: Array<{ row: number; col: number }>;
    previousMatched: boolean;
}

/**
 * deferred promise pattern for async waiting
 */
interface Deferred<T> {
    promise: Promise<T>;
    resolve: (value: T) => void;
    reject: (reason: Error) => void;
}

/**
 * creates a new deferred promise
 * @returns deferred object with promise, resolve, and reject
 */
function createDeferred<T>(): Deferred<T> {
    const { promise, resolve, reject } = Promise.withResolvers<T>();
    return { promise, resolve, reject };
}

/**
 * a mutable, concurrency-safe game board for memory scramble.
 * 
 * the board consists of a grid of cards that players can flip over
 * to find matching pairs. players take turns flipping cards, and
 * matched pairs are removed from the board.
 */
export class Board {

    private readonly rows: number;
    private readonly columns: number;
    private readonly cards: Array<Array<CardState | null>>;
    private readonly playerStates: Map<string, PlayerState>;
    private readonly cardWaiters: Map<string, Array<Deferred<void>>>;
    private readonly changeWatchers: Array<Deferred<void>>;

    // abstraction function:
    //   AF(rows, columns, cards, playerStates, cardWaiters, changeWatchers) =
    //     a memory scramble board with dimensions rows x columns where:
    //     - cards[r][c] represents the card at position (r, c), or null if removed
    //     - each card has a value, face up/down state, and optional controller
    //     - playerStates tracks each player's current cards and previous move
    //     - cardWaiters holds promises for players waiting to control cards
    //     - changeWatchers holds promises for players watching for changes
    //
    // rep invariant:
    //   - rows > 0 && columns > 0
    //   - cards.length === rows
    //   - cards[i].length === columns for all 0 <= i < rows
    //   - if a card is controlled, it must be face up
    //   - each card is controlled by at most one player
    //   - a player controls at most 2 cards (their first and second card)
    //   - if player has secondCard, they must also have firstCard
    //
    // safety from rep exposure:
    //   - all fields are private and readonly where applicable
    //   - cards array contains mutable CardState objects but these are never exposed
    //   - look() and toString() return new strings, not internal state
    //   - playerStates map is not exposed; operations work on copies

    /**
     * create a new board with the given dimensions and cards.
     * 
     * @param rows number of rows, must be > 0
     * @param columns number of columns, must be > 0
     * @param cardValues array of card values in row-major order, length must be rows * columns
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

    private checkRep(): void {
        assert(this.rows > 0, 'rows must be positive');
        assert(this.columns > 0, 'columns must be positive');
        assert(this.cards.length === this.rows, 'cards array length must match rows');
        
        for (let r = 0; r < this.rows; r++) {
            assert(this.cards[r]?.length === this.columns, `row ${r} length must match columns`);
            for (let c = 0; c < this.columns; c++) {
                const card = this.cards[r]?.[c];
                if (card !== null && card !== undefined) {
                    // if controlled, must be face up
                    if (card.controller !== null) {
                        assert(card.faceUp, `controlled card at (${r},${c}) must be face up`);
                    }
                }
            }
        }

        // check player states
        for (const [playerId, state] of this.playerStates) {
            if (state.secondCard !== null) {
                assert(state.firstCard !== null, `player ${playerId} has second card but no first card`);
            }
        }
    }

    /**
     * get the number of rows on the board.
     * @returns number of rows
     */
    public getRows(): number {
        return this.rows;
    }

    /**
     * get the number of columns on the board.
     * @returns number of columns
     */
    public getColumns(): number {
        return this.columns;
    }

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

    private posKey(row: number, col: number): string {
        return `${row},${col}`;
    }

    private notifyChangeWatchers(): void {
        const watchers = [...this.changeWatchers];
        this.changeWatchers.length = 0;
        for (const watcher of watchers) {
            watcher.resolve();
        }
    }

    private notifyCardWaiters(row: number, col: number): void {
        const key = this.posKey(row, col);
        const waiters = this.cardWaiters.get(key);
        if (waiters && waiters.length > 0) {
            const first = waiters.shift();
            first?.resolve();
        }
    }

    /**
     * handles the start of a new first-card flip by processing previous move results.
     * implements rules 3-A and 3-B.
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
     * flip a card on the board following the gameplay rules.
     * 
     * @param playerId id of the player flipping
     * @param row row of the card (0-indexed from top)
     * @param column column of the card (0-indexed from left)
     * @returns promise that resolves to the board state after flip
     * @throws error if the flip fails per the rules
     */
    public async flip(playerId: string, row: number, column: number): Promise<string> {
        const state = this.getPlayerState(playerId);

        if (state.firstCard === null) {
            // flipping first card
            this.handlePreviousMove(playerId);
            await this.flipFirstCard(playerId, row, column);
        } else if (state.secondCard === null) {
            // flipping second card
            this.flipSecondCard(playerId, row, column);
        } else {
            // already has two cards, start new turn
            this.handlePreviousMove(playerId);
            state.firstCard = null;
            state.secondCard = null;
            await this.flipFirstCard(playerId, row, column);
        }

        this.checkRep();
        return this.look(playerId);
    }

    private async flipFirstCard(playerId: string, row: number, column: number): Promise<void> {
        const state = this.getPlayerState(playerId);

        // rule 1-A: empty space
        let card = this.cards[row]?.[column];
        if (card === null || card === undefined) {
            throw new Error('no card at this position');
        }

        // rule 1-D: card controlled by another player - wait
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

            // after waiting, re-check card
            card = this.cards[row]?.[column];
            if (card === null || card === undefined) {
                throw new Error('no card at this position');
            }
        }

        // rule 1-B: face down - turn up and control
        // rule 1-C: face up, not controlled - control it
        if (!card.faceUp) {
            card.faceUp = true;
            this.notifyChangeWatchers();
        }
        card.controller = playerId;
        state.firstCard = { row, col: column };
    }

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

        // rule 2-B: controlled by any player (including self)
        if (card.controller !== null) {
            this.relinquishFirstCard(playerId);
            throw new Error('card is controlled by a player');
        }

        // rule 2-C: turn face up if face down
        if (!card.faceUp) {
            card.faceUp = true;
            this.notifyChangeWatchers();
        }

        state.secondCard = { row, col: column };

        // rule 2-D and 2-E: check for match
        if (firstCard && card.value === firstCard.value) {
            // rule 2-D: match - keep control of both
            card.controller = playerId;
            state.previousCards = [firstPos, { row, col: column }];
            state.previousMatched = true;
        } else {
            // rule 2-E: no match - relinquish control of both
            if (firstCard) {
                firstCard.controller = null;
                this.notifyCardWaiters(firstPos.row, firstPos.col);
            }
            state.previousCards = [firstPos, { row, col: column }];
            state.previousMatched = false;
        }
    }

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
     * look at the current state of the board from a player's perspective.
     * 
     * @param playerId id of the player looking
     * @returns board state string in the format specified
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
     * apply a transformation function to all cards on the board.
     * maintains pairwise consistency: matching cards stay matching during the operation.
     * 
     * @param playerId id of the player applying the map
     * @param f async function to transform card values
     * @returns board state after transformation
     */
    public async map(playerId: string, f: (card: string) => Promise<string>): Promise<string> {
        // group cards by value to maintain pairwise consistency
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

        // transform each group atomically
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
     * watch for changes to the board.
     * 
     * @param playerId id of the player watching
     * @returns promise that resolves to board state when a change occurs
     */
    public async watch(playerId: string): Promise<string> {
        const deferred = createDeferred<void>();
        this.changeWatchers.push(deferred);
        await deferred.promise;
        return this.look(playerId);
    }

    /**
     * @returns string representation of the board for debugging
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
