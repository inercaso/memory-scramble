# Laboratory Work #3 - Memory Scramble Game

**Course:** Network Programming  
**Based on:** MIT 6.102 Software Construction  
**Student:** Daniela Cebotari  
**Group:** FAF-231  
**University:** Technical University of Moldova  

---

## Table of Contents

1. [Introduction](#1-introduction)
   - 1.1 [Game Board Specification](#11-game-board-specification)
   - 1.2 [Board File Format](#12-board-file-format)
   - 1.3 [Board State Response Format](#13-board-state-response-format)
2. [Objectives](#2-objectives)
3. [Theoretical Background](#3-theoretical-background)
   - 3.1 [Abstract Data Types](#31-abstract-data-types)
   - 3.2 [Rep Invariants and Abstraction Functions](#32-rep-invariants-and-abstraction-functions)
   - 3.3 [Concurrency with Promises](#33-concurrency-with-promises)
4. [System Architecture](#4-system-architecture)
   - 4.1 [Module Structure](#41-module-structure)
   - 4.2 [Data Flow](#42-data-flow)
5. [Implementation Details](#5-implementation-details)
   - 5.1 [Board ADT Design](#51-board-adt-design)
   - 5.2 [Card State Management](#52-card-state-management)
   - 5.3 [Player State Tracking](#53-player-state-tracking)
   - 5.4 [Gameplay Rules Implementation](#54-gameplay-rules-implementation)
   - 5.5 [Asynchronous Waiting Mechanism](#55-asynchronous-waiting-mechanism)
   - 5.6 [Map Operation with Pairwise Consistency](#56-map-operation-with-pairwise-consistency)
   - 5.7 [Watch Mechanism for Change Notifications](#57-watch-mechanism-for-change-notifications)
   - 5.8 [Commands Module (Glue Code)](#58-commands-module-glue-code)
6. [Testing Strategy](#6-testing-strategy)
   - 6.0 [Test Framework](#60-test-framework)
   - 6.1 [Test Partitioning](#61-test-partitioning)
   - 6.2 [Concurrency Tests](#62-concurrency-tests)
7. [Simulation Script](#7-simulation-script)
8. [Running the Application](#8-running-the-application)
9. [Requirements Checklist](#9-requirements-checklist)
10. [Conclusion](#10-conclusion)

---

## 1. Introduction

Memory Scramble is a multiplayer networked implementation of the classic Memory (Concentration) card game. Unlike traditional turn-based Memory games, Memory Scramble allows multiple players to flip cards simultaneously, creating a dynamic and competitive gameplay experience.

The game is built using TypeScript and follows the principles of safe, easy-to-understand, and ready-for-change software construction. Players connect via HTTP and interact with a shared game board, trying to find matching pairs of cards before their opponents.

Key features include:
- **Concurrent gameplay** - Multiple players can play simultaneously without taking turns
- **Asynchronous waiting** - Players wait (without busy-waiting) when trying to flip cards controlled by others
- **Real-time updates** - Watch mechanism allows clients to receive instant notifications of board changes
- **Card transformation** - Map operation allows replacing cards while maintaining game consistency

### 1.1 Game Board Specification

The Memory Scramble game board consists of a grid of spaces. Each space starts with a card. As cards are matched and removed, spaces become empty.

**Cards:** A card is a non-empty string of non-whitespace, non-newline characters. This allows text-based cards like `Hello` or emoji-based cards like `🌈`. Two cards match if they have the same string of characters.

**Card States:** All cards start face down. Players turn them face up, and cards will either turn face down again (if non-matching) or be removed from the board (if matching).

**Coordinate System:** Coordinates are specified as `(row, column)`, starting at `(0, 0)` in the top-left corner, increasing vertically downwards and horizontally to the right.

### 1.2 Board File Format

Game boards are loaded from files using the following grammar:

```
BOARD_FILE ::= ROW "x" COLUMN NEWLINE (CARD NEWLINE)+

CARD    ::= [^\s\n\r]+
ROW     ::= INT
COLUMN  ::= INT
INT     ::= [0-9]+
NEWLINE ::= "\r"? "\n"
```

- `ROW` is the number of rows
- `COLUMN` is the number of columns  
- Cards are listed reading across each row, starting with the top row
- A valid board file must have exactly `ROW × COLUMN` newline-terminated card lines

**Example:** A 3×3 board of rainbows and unicorns:

```
3x3
🦄
🦄
🌈
🌈
🌈
🦄
🌈
🦄
🌈
```

### 1.3 Board State Response Format

The server responds with a board state showing the current state from the player's perspective:

```
BOARD_STATE ::= ROW "x" COLUMN NEWLINE (SPOT NEWLINE)+

SPOT    ::= "none" | "down" | "up " CARD | "my " CARD
CARD    ::= [^\s\n\r]+
ROW     ::= INT
COLUMN  ::= INT
INT     ::= [0-9]+
NEWLINE ::= "\r"? "\n"
```

| State | Meaning |
|-------|---------|
| `none` | No card at this location (removed) |
| `down` | Face-down card |
| `up <card>` | Face-up card controlled by another player or no one |
| `my <card>` | Face-up card controlled by the requesting player |

**Example Response:**

```
3x3
up A
down
down
none
my B
none
down
down
up C
```

This indicates: cards at `(0,0)`, `(1,1)`, and `(2,2)` are face up; the player controls the `B` card at `(1,1)`; positions `(1,0)` and `(1,2)` have no cards.

---

## 2. Objectives

The primary objectives of this laboratory work are:

1. **Design and implement a mutable Board ADT** with proper representation invariants, abstraction functions, and safety from representation exposure
2. **Implement all gameplay rules** (1-A through 3-B) for the Memory Scramble game
3. **Connect the Board ADT to an HTTP web server** using a commands module with minimal glue code
4. **Handle concurrent players** using asynchronous methods and Promises without busy-waiting
5. **Implement card transformation (map)** with pairwise consistency guarantees
6. **Implement board watching** for real-time change notifications
7. **Create comprehensive unit tests** covering all game rules and edge cases
8. **Develop a simulation script** to verify the game handles concurrent players correctly

---

## 3. Theoretical Background

### 3.1 Abstract Data Types

An Abstract Data Type (ADT) is a type defined by its operations rather than its representation. The Board ADT in this implementation encapsulates the game state and provides operations for players to interact with the board without exposing internal implementation details.

The Board ADT operations include:
- **Creators:** `parseFromFile()` - creates a new board from a file
- **Observers:** `look()`, `getRows()`, `getColumns()`, `toString()`
- **Mutators:** `flip()`, `map()`
- **Mixed:** `watch()` - observes and waits for mutations

### 3.2 Rep Invariants and Abstraction Functions

**Rep Invariant (RI):** A predicate over the representation that must always be true. It defines which states of the representation are valid.

**Abstraction Function (AF):** A mapping from valid representation values to the abstract values they represent.

For the Board ADT:

```typescript
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
```

### 3.3 Concurrency with Promises

JavaScript/TypeScript uses an event-driven, single-threaded model with asynchronous operations. Promises represent values that may be available in the future, allowing non-blocking operations.

The implementation uses the **Deferred pattern** for managing promises that need to be resolved externally:

```typescript
interface Deferred<T> {
    promise: Promise<T>;
    resolve: (value: T) => void;
    reject: (reason: Error) => void;
}

function createDeferred<T>(): Deferred<T> {
    const { promise, resolve, reject } = Promise.withResolvers<T>();
    return { promise, resolve, reject };
}
```

This pattern enables:
- Players to wait for cards without busy-waiting
- The board to notify waiting players when cards become available
- Watch operations to wait for and receive change notifications

---

## 4. System Architecture

### 4.1 Module Structure

The application follows a layered architecture with clear separation of concerns:

```
┌─────────────────────────────────────────────────────────┐
│                    HTTP Server                          │
│                   (server.ts)                           │
├─────────────────────────────────────────────────────────┤
│                  Commands Module                        │
│                  (commands.ts)                          │
│         look() | flip() | map() | watch()               │
├─────────────────────────────────────────────────────────┤
│                    Board ADT                            │
│                   (board.ts)                            │
│   parseFromFile() | look() | flip() | map() | watch()   │
└─────────────────────────────────────────────────────────┘
```

**Key Design Decisions:**
- The HTTP server only calls functions from the commands module (never Board methods directly)
- Commands module functions are pure glue code (at most 3 lines each)
- All game logic and state management is encapsulated in the Board ADT

### 4.2 Data Flow

```
Client Request → HTTP Server → Commands Module → Board ADT
                                                    ↓
Client Response ← HTTP Server ← Commands Module ← Board State
```

---

## 5. Implementation Details

### 5.1 Board ADT Design

The Board class encapsulates all game state and logic:

```typescript
export class Board {
    private readonly rows: number;
    private readonly columns: number;
    private readonly cards: Array<Array<CardState | null>>;
    private readonly playerStates: Map<string, PlayerState>;
    private readonly cardWaiters: Map<string, Array<Deferred<void>>>;
    private readonly changeWatchers: Array<Deferred<void>>;
    
    // ... methods
}
```

The constructor is private, enforcing that boards can only be created through the `parseFromFile()` factory method:

```typescript
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
    // ... validation and card parsing
    
    return new Board(rows, columns, cardValues);
}
```

**Safety from Rep Exposure:**
- All fields are `private` and `readonly`
- The `look()` method returns a new string, not internal state
- CardState objects are never exposed to clients
- Player states are accessed through controlled methods

### 5.2 Card State Management

Each card on the board is represented by a `CardState` interface:

```typescript
interface CardState {
    value: string;      // the card's display value (e.g., "🦄", "A")
    faceUp: boolean;    // true if card is face up, false if face down
    controller: string | null;  // playerId of controlling player, or null
}
```

The board state is returned in a specific format:

```typescript
public look(playerId: string): string {
    let result = `${this.rows}x${this.columns}\n`;

    for (let r = 0; r < this.rows; r++) {
        for (let c = 0; c < this.columns; c++) {
            const card = this.cards[r]?.[c];
            if (card === null || card === undefined) {
                result += 'none\n';      // card removed
            } else if (!card.faceUp) {
                result += 'down\n';       // face down
            } else if (card.controller === playerId) {
                result += `my ${card.value}\n`;   // controlled by this player
            } else {
                result += `up ${card.value}\n`;   // face up, controlled by other/none
            }
        }
    }
    return result;
}
```

Example output:
```
3x3
up A
down
my B
none
down
up C
down
down
down
```

### 5.3 Player State Tracking

Each player's game state is tracked using the `PlayerState` interface:

```typescript
interface PlayerState {
    firstCard: { row: number; col: number } | null;   // position of first flipped card
    secondCard: { row: number; col: number } | null;  // position of second flipped card
    previousCards: Array<{ row: number; col: number }>; // cards from previous turn
    previousMatched: boolean;  // whether previous pair matched
}
```

Player states are lazily initialized when a player first interacts with the board:

```typescript
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
```

### 5.4 Gameplay Rules Implementation

The game implements a comprehensive set of rules divided into three phases:

#### First Card Rules (1-A through 1-D)

```typescript
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
```

| Rule | Description | Implementation |
|------|-------------|----------------|
| 1-A | Empty space fails | Check for null/undefined card |
| 1-B | Face down turns up, player controls | Set faceUp=true, controller=playerId |
| 1-C | Face up uncontrolled becomes controlled | Set controller=playerId |
| 1-D | Face up controlled by other waits | Await on deferred promise |

#### Second Card Rules (2-A through 2-E)

```typescript
private flipSecondCard(playerId: string, row: number, column: number): void {
    const card = this.cards[row]?.[column];
    const state = this.getPlayerState(playerId);
    const firstPos = state.firstCard;
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
```

| Rule | Description | Implementation |
|------|-------------|----------------|
| 2-A | Empty space fails, relinquish first | Throw error, release first card |
| 2-B | Controlled card fails, relinquish first | Throw error, release first card |
| 2-C | Face down turns up | Set faceUp=true |
| 2-D | Match keeps control of both | Set second card controller |
| 2-E | No match relinquishes both | Clear first card controller, notify waiters |

#### Next Move Rules (3-A and 3-B)

```typescript
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
```

| Rule | Description | Implementation |
|------|-------------|----------------|
| 3-A | Matched pair removed on next move | Set cards to null, notify waiters |
| 3-B | Non-matched turn down if uncontrolled | Set faceUp=false if controller is null |

### 5.5 Asynchronous Waiting Mechanism

When a player tries to flip a card controlled by another player, they must wait. The implementation uses a queue of Deferred promises per card position:

```typescript
private readonly cardWaiters: Map<string, Array<Deferred<void>>>;

private notifyCardWaiters(row: number, col: number): void {
    const key = this.posKey(row, col);
    const waiters = this.cardWaiters.get(key);
    if (waiters && waiters.length > 0) {
        const first = waiters.shift();  // FIFO queue
        first?.resolve();
    }
}
```

**Key Properties:**
- **No busy-waiting:** Players await on promises, not spin loops
- **FIFO ordering:** First waiter gets the card first
- **Graceful failure:** Waiters are notified when cards are removed, allowing them to fail appropriately

### 5.6 Map Operation with Pairwise Consistency

The `map()` operation transforms all cards on the board while maintaining pairwise consistency - if two cards match at the start, they must still match during and after the transformation:

```typescript
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
```

**Algorithm:**
1. Group all cards by their current value
2. For each unique value, call the transformation function once
3. Apply the result to all cards in that group atomically
4. Notify watchers of changes

This ensures that matching cards are always transformed together, maintaining pairwise consistency.

### 5.7 Watch Mechanism for Change Notifications

The watch mechanism allows clients to wait for board changes without polling:

```typescript
private readonly changeWatchers: Array<Deferred<void>>;

private notifyChangeWatchers(): void {
    const watchers = [...this.changeWatchers];
    this.changeWatchers.length = 0;
    for (const watcher of watchers) {
        watcher.resolve();
    }
}

public async watch(playerId: string): Promise<string> {
    const deferred = createDeferred<void>();
    this.changeWatchers.push(deferred);
    await deferred.promise;
    return this.look(playerId);
}
```

**Change events that trigger notifications:**
- Card flipped face up
- Card flipped face down
- Card removed from board
- Card value changed (via map)

### 5.8 Commands Module (Glue Code)

The commands module provides the interface between the HTTP server and the Board ADT. Each function is implemented as minimal glue code (1 line each):

```typescript
export async function look(board: Board, playerId: string): Promise<string> {
    return board.look(playerId);
}

export async function flip(board: Board, playerId: string, row: number, column: number): Promise<string> {
    return board.flip(playerId, row, column);
}

export async function map(board: Board, playerId: string, f: (card: string) => Promise<string>): Promise<string> {
    return board.map(playerId, f);
}

export async function watch(board: Board, playerId: string): Promise<string> {
    return board.watch(playerId);
}
```

This design ensures:
- Clear separation of concerns
- Easy testing (Board tests are sufficient)
- Simple maintenance and debugging

---

## 6. Testing Strategy

### 6.0 Test Framework

The project uses **Vitest** as its test framework. Vitest is a modern, fast testing framework that natively supports TypeScript without requiring a separate compilation step. Tests are written in TypeScript and executed directly from the `test/` directory.

**Key benefits of Vitest:**
- **Native TypeScript support** - No need to compile tests before running
- **Fast execution** - Optimized for speed with parallel test execution
- **Familiar API** - Uses the same `describe`, `it`, `expect` syntax as Jest/Mocha
- **Verbose output** - Shows each test case with pass/fail status

**Running Tests:**

```bash
# Run all tests with verbose output
npm test

# Run tests in watch mode (re-runs on file changes)
npx vitest

# Run tests with code coverage
npm run coverage
```

**Example Output:**

```
 ✓ test/board.test.ts (28 tests)
   ✓ Board (28 tests)
     ✓ parseFromFile (3 tests)
       ✓ parses a valid 3x3 board file
       ✓ parses a valid 5x5 board file
       ✓ throws on non-existent file
     ✓ look (3 tests)
       ✓ shows all cards face down initially
       ✓ shows my card for controlled cards
       ✓ shows up for cards controlled by others
     ✓ flip first card (4 tests)
       ✓ rule 1-A: empty space fails
       ✓ rule 1-B: face down card turns up and player controls
       ✓ rule 1-C: face up uncontrolled card becomes controlled
       ✓ rule 1-D: waits for controlled card then takes control
     ✓ flip second card (5 tests)
       ✓ rule 2-A: empty space fails and relinquishes first
       ✓ rule 2-B: controlled card fails and relinquishes first
       ✓ rule 2-C: face down card turns face up
       ✓ rule 2-D: matching cards keeps control of both
       ✓ rule 2-E: non-matching cards relinquishes both
     ...

 Test Files  1 passed (1)
      Tests  28 passed (28)
   Duration  1.19s
```

### 6.1 Test Partitioning

The test suite is organized by functionality with clear partitions:

```typescript
describe('Board', function() {
    
    describe('parseFromFile', function() {
        // - valid file with small board (3x3)
        // - valid file with larger board (5x5)
        // - invalid file: wrong format, missing cards
    });

    describe('look', function() {
        // - all cards face down
        // - some cards face up (controlled by player, by other, uncontrolled)
        // - some cards removed (none)
    });

    describe('flip first card', function() {
        // - rule 1-A: empty space
        // - rule 1-B: face down
        // - rule 1-C: face up, not controlled
        // - rule 1-D: face up, controlled by other
    });

    describe('flip second card', function() {
        // - rule 2-A: empty space
        // - rule 2-B: controlled by self or other
        // - rule 2-C: face down
        // - rule 2-D: match
        // - rule 2-E: no match
    });

    describe('next move rules', function() {
        // - rule 3-A: matched pair removed
        // - rule 3-B: non-matched cards turn down
    });

    describe('concurrent players', function() {
        // - multiple players waiting
        // - card removed while waiting
    });

    describe('map', function() {
        // - transform all cards
        // - pairwise consistency
    });

    describe('watch', function() {
        // - notified on flip
        // - notified on removal
        // - notified on map
    });
});
```

### 6.2 Concurrency Tests

Testing concurrent operations requires careful coordination:

```typescript
it('two players waiting for same card, both eventually get it', async function() {
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
    assert(bobLines[1]?.startsWith('my '));
    
    // ... charlie gets it next
});
```

---

## 7. Simulation Script

The simulation script validates that the game handles concurrent players correctly:

```typescript
async function simulationMain(): Promise<void> {
    const filename = 'boards/ab.txt';
    const board: Board = await Board.parseFromFile(filename);
    const size = 5;
    const players = 4;
    const tries = 100;
    const minDelayMs = 0.1;
    const maxDelayMs = 2;

    // start up players as concurrent asynchronous function calls
    const playerPromises: Array<Promise<void>> = [];
    for (let ii = 0; ii < players; ++ii) {
        const playerId = `player${ii}`;
        playerPromises.push(player(playerId));
    }

    // wait for all players to finish
    await Promise.all(playerPromises);
}
```

**Requirements met:**
- 4 players running concurrently
- 100 moves per player
- Random timeouts between 0.1ms and 2ms
- No shuffling (random card selection only)
- Game never crashes

Example output:
```
starting simulation with 4 players, 100 moves each
board: boards/ab.txt (5x5)
delays: 0.1ms - 2ms

simulation complete
player0: 28 moves, 2 matches
player1: 20 moves, 1 matches
player2: 30 moves, 6 matches
player3: 35 moves, 2 matches
```

---

## 8. Running the Application

### Prerequisites
- Node.js v22.12.x or later
- npm

### Installation
```bash
npm install
```

### Running Tests
```bash
npm test
```

### Running the Simulation
```bash
npm run simulation
```

### Starting the Web Server
```bash
npm start 8080 boards/perfect.txt
```

Then open http://localhost:8080 in your web browser to play the game.

### Available Board Files
- `boards/perfect.txt` - 3x3 board with unicorns and rainbows
- `boards/ab.txt` - 5x5 board with A and B cards
- `boards/zoom.txt` - 5x5 board with vehicle emojis

---

## 9. Requirements Checklist

| Requirement | Points | Status | Notes |
|-------------|--------|--------|-------|
| Game works correctly according to all rules | 10 | ✅ Met | All gameplay rules (1-A through 3-B) implemented and tested |
| Unit tests for Board ADT covering all rules | 10 | ✅ Met | 28 passing tests with comprehensive coverage |
| Simulation script (4 players, 100 moves, 0.1-2ms timeouts) | 4 | ✅ Met | Runs without crashes |
| Module structure (commands as glue code) | 6 | ✅ Met | Each command function is 1 line |
| Rep invariants, AF, SRE documentation | 6 | ✅ Met | Documented in Board class |
| Specifications for every method | 8 | ✅ Met | TypeDoc comments on all public methods |
| **Total** | **44** | **✅ All Met** | |

### Additional Requirements Met

| Requirement | Status | Notes |
|-------------|--------|-------|
| `checkRep()` implemented | ✅ | Called after all mutating operations |
| `toString()` implemented | ✅ | Returns debug representation |
| No busy-waiting | ✅ | Uses Promise-based waiting |
| Pairwise consistency for map() | ✅ | Cards grouped by value before transformation |
| Watch mechanism | ✅ | Notifies on all board changes |
| Private constructor with factory method | ✅ | `parseFromFile()` is the only way to create boards |

---

## 10. Conclusion

This laboratory work successfully implemented a multiplayer Memory Scramble game demonstrating key software engineering principles:

### Key Achievements

1. **Safe from Bugs:** The implementation uses TypeScript's type system, private fields, and rep invariants (checked with `checkRep()`) to prevent bugs. Comprehensive tests verify all gameplay rules.

2. **Easy to Understand:** Clear separation between the Board ADT and commands module, with well-documented abstraction functions and rep invariants. The code follows consistent naming conventions and includes explanatory comments where needed.

3. **Ready for Change:** The modular architecture allows changing the Board implementation without affecting the HTTP server. The commands module serves as a stable interface, and the use of interfaces (CardState, PlayerState, Deferred) enables easy modification.

### Technical Highlights

- **Concurrency without locks:** JavaScript's event loop and Promises enable safe concurrent access without traditional synchronization primitives
- **Deferred pattern:** Elegant solution for externally-resolved promises, enabling the waiting mechanism
- **Pairwise consistency:** The map operation maintains game invariants even during asynchronous transformations
- **Comprehensive testing:** 28 tests covering normal operation, error cases, and concurrent scenarios

### Lessons Learned

1. **Design before implementation:** The rep invariant and abstraction function guided the implementation and prevented bugs
2. **Test concurrent code carefully:** Race conditions can be subtle; careful test design is essential
3. **Keep modules focused:** The single-line command functions demonstrate the power of well-designed ADT operations

The Memory Scramble game is now ready for multiplayer gameplay, with a robust implementation that handles concurrent players, card transformations, and real-time updates correctly.
