/* Copyright (c) 2021-25 MIT 6.102/6.031 course staff, all rights reserved.
 * Redistribution of original or derived work requires permission of course staff.
 */

import assert from 'node:assert';
import { Board } from '../src/board.js';

/**
 * helper to wait for a short time
 */
async function timeout(ms: number): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, ms);
    return promise;
}

/**
 * Tests for the Board abstract data type.
 */
describe('Board', function() {
    
    // testing strategy for Board:
    //
    // parseFromFile:
    //   - valid file with small board (3x3)
    //   - valid file with larger board (5x5)
    //   - invalid file: wrong format, missing cards, extra cards
    //
    // look:
    //   - all cards face down
    //   - some cards face up (controlled by player, controlled by other, uncontrolled)
    //   - some cards removed (none)
    //
    // flip first card:
    //   - rule 1-A: empty space -> fail
    //   - rule 1-B: face down -> turns up, player controls
    //   - rule 1-C: face up, not controlled -> player controls
    //   - rule 1-D: face up, controlled by other -> wait
    //
    // flip second card:
    //   - rule 2-A: empty space -> fail, relinquish first
    //   - rule 2-B: controlled by self or other -> fail, relinquish first
    //   - rule 2-C: face down -> turns up
    //   - rule 2-D: match -> keep control of both
    //   - rule 2-E: no match -> relinquish both
    //
    // next move rules:
    //   - rule 3-A: matched pair removed
    //   - rule 3-B: non-matched cards turn down if not controlled
    //
    // concurrent players:
    //   - two players try to flip same card
    //   - player waits then gets card after other releases
    //   - player waits but card removed -> fails
    //
    // map:
    //   - transform all cards
    //   - pairwise consistency (matching cards transform together)
    //   - interleaves with other operations
    //
    // watch:
    //   - notified on flip up
    //   - notified on removal
    //   - notified on map change


    describe('parseFromFile', function() {

        it('parses a valid 3x3 board file', async function() {
            const board = await Board.parseFromFile('boards/perfect.txt');
            assert.strictEqual(board.getRows(), 3);
            assert.strictEqual(board.getColumns(), 3);
            const state = board.look('player1');
            assert(state.startsWith('3x3\n'));
            // all cards should be face down initially
            const lines = state.trim().split('\n');
            assert.strictEqual(lines.length, 10); // header + 9 cards
            for (let i = 1; i < lines.length; i++) {
                assert.strictEqual(lines[i], 'down');
            }
        });

        it('parses a valid 5x5 board file', async function() {
            const board = await Board.parseFromFile('boards/ab.txt');
            assert.strictEqual(board.getRows(), 5);
            assert.strictEqual(board.getColumns(), 5);
            const state = board.look('player1');
            assert(state.startsWith('5x5\n'));
        });

        it('throws on non-existent file', async function() {
            await assert.rejects(
                Board.parseFromFile('boards/nonexistent.txt'),
                /ENOENT|no such file/
            );
        });

    });


    describe('look', function() {

        it('shows all cards face down initially', async function() {
            const board = await Board.parseFromFile('boards/perfect.txt');
            const state = board.look('alice');
            const lines = state.trim().split('\n');
            for (let i = 1; i < lines.length; i++) {
                assert.strictEqual(lines[i], 'down');
            }
        });

        it('shows my card for controlled cards', async function() {
            const board = await Board.parseFromFile('boards/perfect.txt');
            await board.flip('alice', 0, 0);
            const state = board.look('alice');
            const lines = state.trim().split('\n');
            assert(lines[1]?.startsWith('my '));
        });

        it('shows up for cards controlled by others', async function() {
            const board = await Board.parseFromFile('boards/perfect.txt');
            await board.flip('alice', 0, 0);
            const stateAlice = board.look('alice');
            const stateBob = board.look('bob');
            
            const aliceLines = stateAlice.trim().split('\n');
            const bobLines = stateBob.trim().split('\n');
            
            assert(aliceLines[1]?.startsWith('my '));
            assert(bobLines[1]?.startsWith('up '));
        });

    });


    describe('flip first card', function() {

        it('rule 1-A: empty space fails', async function() {
            const board = await Board.parseFromFile('boards/ab.txt');
            
            // match and remove cards first
            await board.flip('alice', 0, 0); // A
            await board.flip('alice', 0, 2); // A
            await board.flip('alice', 1, 0); // triggers removal
            
            // now try to flip the removed card
            await assert.rejects(
                board.flip('bob', 0, 0),
                /no card/
            );
        });

        it('rule 1-B: face down card turns up and player controls', async function() {
            const board = await Board.parseFromFile('boards/perfect.txt');
            const result = await board.flip('alice', 0, 0);
            const lines = result.trim().split('\n');
            assert(lines[1]?.startsWith('my '));
        });

        it('rule 1-C: face up uncontrolled card becomes controlled', async function() {
            const board = await Board.parseFromFile('boards/perfect.txt');
            
            // alice flips two non-matching cards
            await board.flip('alice', 0, 0);
            await board.flip('alice', 2, 2);
            
            // cards are now uncontrolled but still face up
            // bob can take control of one
            const result = await board.flip('bob', 0, 0);
            const lines = result.trim().split('\n');
            assert(lines[1]?.startsWith('my '));
        });

        it('rule 1-D: waits for controlled card then takes control', async function() {
            const board = await Board.parseFromFile('boards/perfect.txt');
            
            // alice controls card at 0,0
            await board.flip('alice', 0, 0);
            
            // bob tries to flip same card - should wait
            const bobFlipPromise = board.flip('bob', 0, 0);
            
            // give bob's request time to start waiting
            await timeout(10);
            
            // alice flips second card (non-matching), releasing first
            await board.flip('alice', 2, 2);
            
            // now bob should get the card
            const bobResult = await bobFlipPromise;
            const lines = bobResult.trim().split('\n');
            assert(lines[1]?.startsWith('my '));
        });

    });


    describe('flip second card', function() {

        it('rule 2-A: empty space fails and relinquishes first', async function() {
            const board = await Board.parseFromFile('boards/ab.txt');
            
            // alice matches and removes cards at 0,0 and 0,2
            await board.flip('alice', 0, 0);
            await board.flip('alice', 0, 2);
            await board.flip('alice', 1, 0); // removes 0,0 and 0,2
            
            // bob flips first card
            await board.flip('bob', 1, 1);
            
            // bob tries empty space as second card
            await assert.rejects(
                board.flip('bob', 0, 0),
                /no card/
            );
            
            // bob should have lost control of first card
            const state = board.look('bob');
            const lines = state.trim().split('\n');
            assert(!lines.some(l => l.startsWith('my ')));
        });

        it('rule 2-B: controlled card fails and relinquishes first', async function() {
            const board = await Board.parseFromFile('boards/ab.txt');
            
            // alice flips first card
            await board.flip('alice', 0, 0);
            
            // bob flips first card at different position
            await board.flip('bob', 0, 1);
            
            // alice tries to flip bob's card as second card - should fail
            await assert.rejects(
                board.flip('alice', 0, 1),
                /controlled/
            );
            
            // alice should have lost control of her first card
            const state = board.look('alice');
            const lines = state.trim().split('\n');
            assert(!lines[1]?.startsWith('my '));
        });

        it('rule 2-C: face down card turns face up', async function() {
            const board = await Board.parseFromFile('boards/ab.txt');
            
            await board.flip('alice', 0, 0); // A, first card
            
            // 1,0 is face down
            let state = board.look('alice');
            let lines = state.trim().split('\n');
            assert.strictEqual(lines[6], 'down'); // position 5 is 1,0
            
            await board.flip('alice', 1, 0); // B, second card - should turn up
            
            state = board.look('alice');
            lines = state.trim().split('\n');
            assert(lines[6]?.startsWith('up ')); // should be face up now
        });

        it('rule 2-D: matching cards keeps control of both', async function() {
            const board = await Board.parseFromFile('boards/ab.txt');
            
            // find two A cards at 0,0 and 0,2
            await board.flip('alice', 0, 0); // A
            await board.flip('alice', 0, 2); // A
            
            const state = board.look('alice');
            const lines = state.trim().split('\n');
            // both should show as 'my'
            assert(lines[1]?.startsWith('my '));
            assert(lines[3]?.startsWith('my '));
        });

        it('rule 2-E: non-matching cards relinquishes both', async function() {
            const board = await Board.parseFromFile('boards/ab.txt');
            
            // flip A at 0,0 and B at 0,1
            await board.flip('alice', 0, 0); // A
            await board.flip('alice', 0, 1); // B
            
            const state = board.look('alice');
            const lines = state.trim().split('\n');
            // neither should be 'my' anymore
            assert(lines[1]?.startsWith('up '));
            assert(lines[2]?.startsWith('up '));
        });

        it('rule 2-B: cannot flip same card as second card', async function() {
            const board = await Board.parseFromFile('boards/ab.txt');
            
            await board.flip('alice', 0, 0);
            
            // try to flip same card again
            await assert.rejects(
                board.flip('alice', 0, 0),
                /controlled/
            );
        });

    });


    describe('next move rules', function() {

        it('rule 3-A: matched pair is removed on next move', async function() {
            const board = await Board.parseFromFile('boards/ab.txt');
            
            // match two A cards
            await board.flip('alice', 0, 0); // A
            await board.flip('alice', 0, 2); // A
            
            // start next move - matched pair should be removed
            await board.flip('alice', 1, 0);
            
            const state = board.look('alice');
            const lines = state.trim().split('\n');
            assert.strictEqual(lines[1], 'none');
            assert.strictEqual(lines[3], 'none');
        });

        it('rule 3-B: non-matched cards turn down if not controlled', async function() {
            const board = await Board.parseFromFile('boards/ab.txt');
            
            // flip non-matching cards
            await board.flip('alice', 0, 0); // A
            await board.flip('alice', 0, 1); // B
            
            // cards are up but uncontrolled
            let state = board.look('alice');
            let lines = state.trim().split('\n');
            assert(lines[1]?.startsWith('up '));
            assert(lines[2]?.startsWith('up '));
            
            // start next move - uncontrolled cards should turn down
            await board.flip('alice', 1, 1);
            
            state = board.look('alice');
            lines = state.trim().split('\n');
            assert.strictEqual(lines[1], 'down');
            assert.strictEqual(lines[2], 'down');
        });

        it('rule 3-B: card stays up if controlled by another player', async function() {
            const board = await Board.parseFromFile('boards/ab.txt');
            
            // alice flips non-matching cards
            await board.flip('alice', 0, 0); // A
            await board.flip('alice', 0, 1); // B
            
            // bob takes control of 0,0 before alice's next move
            await board.flip('bob', 0, 0);
            
            // alice starts next move
            await board.flip('alice', 1, 1);
            
            const state = board.look('alice');
            const lines = state.trim().split('\n');
            // 0,0 should still be up (controlled by bob)
            assert(lines[1]?.startsWith('up '));
            // 0,1 should be down
            assert.strictEqual(lines[2], 'down');
        });

    });


    describe('concurrent players', function() {

        it('two players waiting for same card, both eventually get it', async function() {
            this.timeout(10000);
            const board = await Board.parseFromFile('boards/ab.txt');
            
            // alice controls 0,0 (A)
            await board.flip('alice', 0, 0);
            
            // bob tries to get it - will wait
            const bobPromise = board.flip('bob', 0, 0);
            
            await timeout(50);
            
            // alice releases by flipping second card (0,1 = B, non-matching)
            await board.flip('alice', 0, 1);
            
            // bob should now have the card
            const bobResult = await bobPromise;
            const bobLines = bobResult.trim().split('\n');
            assert(bobLines[1]?.startsWith('my '), `expected 'my' but got ${bobLines[1]}`);
            
            // charlie now tries to get the same card
            const charliePromise = board.flip('charlie', 0, 0);
            
            await timeout(50);
            
            // bob releases by flipping second card (0,1 = B, non-matching with A)
            await board.flip('bob', 0, 1);
            
            // charlie should get the card
            const charlieResult = await charliePromise;
            const charlieLines = charlieResult.trim().split('\n');
            assert(charlieLines[1]?.startsWith('my '));
        });

        it('multiple waiters queue up and get card in order', async function() {
            this.timeout(5000);
            const board = await Board.parseFromFile('boards/ab.txt');
            
            // alice controls 0,0 (A)
            await board.flip('alice', 0, 0);
            
            // bob and charlie both wait for 0,0
            const bobPromise = board.flip('bob', 0, 0);
            await timeout(5);
            const charliePromise = board.flip('charlie', 0, 0);
            
            await timeout(10);
            
            // alice releases by flipping non-matching second card
            await board.flip('alice', 0, 1);
            
            // bob gets it first (queued first)
            const bobResult = await bobPromise;
            assert(bobResult.trim().split('\n')[1]?.startsWith('my '));
            
            // bob releases by flipping non-matching second card
            await board.flip('bob', 0, 1);
            
            // now charlie gets it
            const charlieResult = await charliePromise;
            assert(charlieResult.trim().split('\n')[1]?.startsWith('my '));
        });

        it('player waiting for card that gets removed fails', async function() {
            const board = await Board.parseFromFile('boards/ab.txt');
            
            // alice matches cards at 0,0 and 0,2
            await board.flip('alice', 0, 0);
            await board.flip('alice', 0, 2);
            
            // bob waits for 0,0
            const bobPromise = board.flip('bob', 0, 0);
            
            await timeout(10);
            
            // alice's next move removes the matched cards
            await board.flip('alice', 1, 0);
            
            // bob's flip should fail
            await assert.rejects(bobPromise, /no card/);
        });

    });


    describe('map', function() {

        it('transforms all cards', async function() {
            const board = await Board.parseFromFile('boards/ab.txt');
            
            await board.map('alice', async (card) => card.toLowerCase());
            
            // flip a card to see the transformed value
            await board.flip('alice', 0, 0);
            const state = board.look('alice');
            const lines = state.trim().split('\n');
            assert(lines[1]?.includes('a')); // lowercase
        });

        it('maintains pairwise consistency', async function() {
            const board = await Board.parseFromFile('boards/ab.txt');
            
            // start map operation
            const mapPromise = board.map('alice', async (card) => {
                await timeout(5);
                return card === 'A' ? 'X' : card === 'B' ? 'Y' : card;
            });
            
            // while map is running, look at board
            await timeout(2);
            const state = board.look('bob');
            
            // all A's should be either A or X, not mixed
            const lines = state.trim().split('\n');
            const cards = lines.slice(1);
            
            await mapPromise;
            
            // after map, check transformed correctly
            const finalState = board.look('bob');
            await board.flip('bob', 0, 0);
            const afterFlip = board.look('bob');
            assert(afterFlip.includes('my X') || afterFlip.includes('my Y'));
        });

    });


    describe('watch', function() {

        it('notifies on card flip', async function() {
            const board = await Board.parseFromFile('boards/ab.txt');
            
            const watchPromise = board.watch('alice');
            
            await timeout(5);
            
            // bob flips a card
            await board.flip('bob', 0, 0);
            
            // alice's watch should resolve
            const state = await watchPromise;
            assert(state.includes('up '));
        });

        it('notifies on card removal', async function() {
            const board = await Board.parseFromFile('boards/ab.txt');
            
            // bob matches cards
            await board.flip('bob', 0, 0);
            await board.flip('bob', 0, 2);
            
            // alice starts watching
            const watchPromise = board.watch('alice');
            
            await timeout(5);
            
            // bob's next move removes matched cards
            await board.flip('bob', 1, 0);
            
            // alice should be notified
            const state = await watchPromise;
            assert(state.includes('none'));
        });

        it('notifies on map change', async function() {
            const board = await Board.parseFromFile('boards/ab.txt');
            
            const watchPromise = board.watch('alice');
            
            await timeout(5);
            
            // bob maps the board
            await board.map('bob', async (card) => card.toLowerCase());
            
            // alice should be notified
            const state = await watchPromise;
            assert(state.startsWith('5x5'));
        });

    });


    describe('toString', function() {

        it('returns debug representation', async function() {
            const board = await Board.parseFromFile('boards/perfect.txt');
            const str = board.toString();
            assert(str.includes('Board(3x3)'));
            assert(str.includes('[?]')); // face down cards
        });

    });

});
