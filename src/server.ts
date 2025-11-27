/* Copyright (c) 2021-25 MIT 6.102/6.031 course staff, all rights reserved.
 * Redistribution of original or derived work requires permission of course staff.
 */

import assert from 'node:assert';
import process from 'node:process';
import { Server } from 'node:http';
import express, { Application } from 'express';
import { StatusCodes }  from 'http-status-codes';
import { Board } from './board.js';
import { look, flip, map, watch } from './commands.js';

/**
 * Start a game server using the given arguments.
 * 
 * PS4 instructions: you are advised *not* to modify this file.
 *
 * Command-line usage:
 *     npm start PORT FILENAME
 * where:
 * 
 *   - PORT is an integer that specifies the server's listening port number,
 *     0 specifies that a random unused port will be automatically chosen.
 *   - FILENAME is the path to a valid board file, which will be loaded as
 *     the starting game board.
 * 
 * For example, to start a web server on a randomly-chosen port using the
 * board in `boards/hearts.txt`:
 *     npm start 0 boards/hearts.txt
 * 
 * @throws Error if an error occurs parsing a file or starting a server
 */
async function main(): Promise<void> {
    const [portString, filename] 
        = process.argv.slice(2); // skip the first two arguments 
                                 // (argv[0] is node executable file, argv[1] is this script)
    if (portString === undefined) { throw new Error('missing PORT'); }
    const port = parseInt(portString);
    if (isNaN(port) || port < 0) { throw new Error('invalid PORT'); }
    if (filename === undefined) { throw new Error('missing FILENAME'); }
    
    const board = await Board.parseFromFile(filename);
    const server = new WebServer(board, port);
    await server.start();
}


/**
 * HTTP web game server.
 */
class WebServer {

    private readonly app: Application;
    private server: Server|undefined;

    /**
     * Make a new web game server using board that listens for connections on port.
     * 
     * @param board shared game board
     * @param requestedPort server port number
     */
    public constructor(
        private readonly board: Board, 
        private readonly requestedPort: number
    ) {
        this.app = express();
        this.app.use((request, response, next) => {
            // allow requests from web pages hosted anywhere
            response.set('Access-Control-Allow-Origin', '*');
            next();
        });

        /*
         * GET /look/<playerId>
         * playerId must be a nonempty string of alphanumeric or underscore characters
         * 
         * Response is the board state from playerId's perspective, as described in the ps4 handout.
         */
        this.app.get('/look/:playerId', async(request, response) => {
            const { playerId } = request.params;
            assert(playerId);

            const boardState = await look(this.board, playerId);
            response
            .status(StatusCodes.OK) // 200
            .type('text')
            .send(boardState);
        });

        /*
         * GET /flip/<playerId>/<row>,<column>
         * playerId must be a nonempty string of alphanumeric or underscore characters;
         * row and column must be integers, 0 <= row,column < height,width of board (respectively)
         * 
         * Response is the state of the board after the flip from the perspective of playerID,
         * as described in the ps4 handout.
         */
        this.app.get('/flip/:playerId/:location', async(request, response) => {
            const { playerId, location } = request.params;
            assert(playerId);
            assert(location);

            const [ row, column ] = location.split(',').map( s => parseInt(s) );
            assert(row !== undefined && !isNaN(row));
            assert(column !== undefined && !isNaN(column));

            try {
                const boardState = await flip(this.board, playerId, row, column);
                response
                .status(StatusCodes.OK) // 200
                .type('text')
                .send(boardState);
            } catch (err) {
                response
                .status(StatusCodes.CONFLICT) // 409
                .type('text')
                .send(`cannot flip this card: ${err}`);
            }
        });

        /*
         * GET /replace/<playerId>/<oldcard>/<newcard>
         * playerId must be a nonempty string of alphanumeric or underscore characters;
         * oldcard and newcard must be nonempty strings.
         * 
         * Replaces all occurrences of oldcard with newcard (as card labels) on the board.
         * 
         * Response is the state of the board after the replacement from the the perspective of playerID,
         * as described in the ps4 handout.
         */
        this.app.get('/replace/:playerId/:fromCard/:toCard', async(request, response) => {
            const { playerId, fromCard, toCard } = request.params;
            assert(playerId);
            assert(fromCard);
            assert(toCard);

            const boardState = await map(this.board, playerId, async (card: string) => card === fromCard ? toCard : card);
            response
            .status(StatusCodes.OK) // 200
            .type('text')
            .send(boardState);
        });

        /*
         * GET /watch/<playerId>
         * playerId must be a nonempty string of alphanumeric or underscore characters
         * 
         * Waits until the next time the board changes (defined as any cards turning face up or face down, 
         * being removed from the board, or changing from one string to a different string).
         * 
         * Response is the new state of the board from the perspective of playerID,
         * as described in the ps4 handout.
         */
        this.app.get('/watch/:playerId', async(request, response) => {
            const { playerId } = request.params;
            assert(playerId);

            const boardState = await watch(this.board, playerId);
            response
            .status(StatusCodes.OK) // 200
            .type('text')
            .send(boardState);
        });

        /*
         * GET /
         *
         * Response is the game UI as an HTML page.
         */
        this.app.use(express.static('public/'));
    }

    /**
     * Start this server.
     * 
     * @returns (a promise that) resolves when the server is listening
     */
    public start(): Promise<void> {
        const { promise, resolve } = Promise.withResolvers<void>();
        this.server = this.app.listen(this.requestedPort);
        this.server.on('listening', () => {
            console.log(`server now listening at http://localhost:${this.port}`);
            resolve();
        });
        return promise;
    }

    /**
     * @returns the actual port that server is listening at. (May be different
     *          than the requestedPort used in the constructor, since if
     *          requestedPort = 0 then an arbitrary available port is chosen.)
     *          Requires that start() has already been called and completed.
     */
    public get port(): number {
        const address = this.server?.address() ?? 'not connected';
        if (typeof(address) === 'string') {
            throw new Error('server is not listening at a port');
        }
        return address.port;
    }

    /**
     * Stop this server. Once stopped, this server cannot be restarted.
     */
     public stop(): void {
        this.server?.close();
        console.log('server stopped');
    }
}

await main();
