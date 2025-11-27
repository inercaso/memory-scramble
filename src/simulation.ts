/* Copyright (c) 2021-25 MIT 6.102/6.031 course staff, all rights reserved.
 * Redistribution of original or derived work requires permission of course staff.
 */

import assert from 'node:assert';
import { Board } from './board.js';
import { flip, look } from './commands.js';

/**
 * simulates multiple players making random moves on a memory scramble board.
 * requirements: 4 players, timeouts between 0.1ms and 2ms, no shuffling, 100 moves each.
 * 
 * @throws Error if an error occurs reading or parsing the board
 */
async function simulationMain(): Promise<void> {
    const filename = 'boards/ab.txt';
    const board: Board = await Board.parseFromFile(filename);
    const size = 5;
    const players = 4;
    const tries = 100;
    const minDelayMs = 0.1;
    const maxDelayMs = 2;

    console.log(`starting simulation with ${players} players, ${tries} moves each`);
    console.log(`board: ${filename} (${size}x${size})`);
    console.log(`delays: ${minDelayMs}ms - ${maxDelayMs}ms`);

    const moveCount = new Map<string, number>();
    const matchCount = new Map<string, number>();

    // start up players as concurrent asynchronous function calls
    const playerPromises: Array<Promise<void>> = [];
    for (let ii = 0; ii < players; ++ii) {
        const playerId = `player${ii}`;
        moveCount.set(playerId, 0);
        matchCount.set(playerId, 0);
        playerPromises.push(player(playerId));
    }

    // wait for all players to finish
    await Promise.all(playerPromises);

    console.log('\nsimulation complete');
    for (let ii = 0; ii < players; ++ii) {
        const playerId = `player${ii}`;
        console.log(`${playerId}: ${moveCount.get(playerId)} moves, ${matchCount.get(playerId)} matches`);
    }

    /**
     * simulates a single player making random moves
     * @param playerId the player's id
     */
    async function player(playerId: string): Promise<void> {
        for (let jj = 0; jj < tries; ++jj) {
            try {
                await timeout(randomDelay(minDelayMs, maxDelayMs));
                
                const row1 = randomInt(size);
                const col1 = randomInt(size);
                
                // try to flip first card
                const state1 = await flip(board, playerId, row1, col1);
                moveCount.set(playerId, (moveCount.get(playerId) ?? 0) + 1);

                await timeout(randomDelay(minDelayMs, maxDelayMs));
                
                const row2 = randomInt(size);
                const col2 = randomInt(size);
                
                // try to flip second card
                const state2 = await flip(board, playerId, row2, col2);
                
                // check if we made a match
                const lines = state2.trim().split('\n');
                let myCards = 0;
                for (const line of lines) {
                    if (line.startsWith('my ')) {
                        myCards++;
                    }
                }
                if (myCards === 2) {
                    matchCount.set(playerId, (matchCount.get(playerId) ?? 0) + 1);
                }

            } catch (err) {
                // flip failures are normal, continue playing
            }
        }
    }
}

/**
 * @param max a positive integer upper bound
 * @returns random integer >= 0 and < max
 */
function randomInt(max: number): number {
    return Math.floor(Math.random() * max);
}

/**
 * @param min minimum delay in ms
 * @param max maximum delay in ms
 * @returns random delay between min and max
 */
function randomDelay(min: number, max: number): number {
    return min + Math.random() * (max - min);
}

/**
 * @param milliseconds duration to wait
 * @returns promise that fulfills after at least milliseconds
 */
async function timeout(milliseconds: number): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, milliseconds);
    return promise;
}

void simulationMain();
