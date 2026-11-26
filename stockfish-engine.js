import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import readline from "node:readline";

const require = createRequire(import.meta.url);
const stockfishPackage = require("stockfish");

const enginePath = stockfishPackage.findEngine("lite-single");

if (!enginePath) {
    throw new Error("Could not locate the Stockfish Lite engine.");
}

class StockfishEngine {
    constructor() {
        this.process = spawn(process.execPath, [enginePath], {
            stdio: ["pipe", "pipe", "inherit"]
        });

        this.queue = Promise.resolve();
        this.active = null;

        this.ready = new Promise((resolve, reject) => {
            this.resolveReady = resolve;
            this.rejectReady = reject;
        });

        const reader = readline.createInterface({
            input: this.process.stdout
        });

        reader.on("line", line => this.handleLine(line));

        this.process.on("error", error => {
            this.rejectReady(error);

            if (this.active) {
                this.active.reject(error);
                this.active = null;
            }
        });

        this.process.on("exit", code => {
            const error = new Error(
                `Stockfish exited with code ${code}.`
            );

            if (this.active) {
                this.active.reject(error);
                this.active = null;
            }

            this.rejectReady(error);
        });

        this.process.stdin.on("error", error => {
            if (this.active) {
                this.active.reject(error);
                this.active = null;
            }
        });

        // Start the Stockfish UCI initialization handshake.
this.send("uci");
    }

    send(command) {
        if (!this.process.stdin.destroyed) {
            this.process.stdin.write(command + "\n");
        }
    }

    handleLine(line) {
        if (line === "uciok") {
            this.send("setoption name Hash value 64");
            this.send("setoption name MultiPV value 3");
            this.send("isready");
            return;
        }

        if (line === "readyok") {
            this.resolveReady();
            return;
        }

        if (!this.active) return;

        if (line.startsWith("info ")) {
            this.readAnalysis(line);
            return;
        }

        if (line.startsWith("bestmove ")) {
            const active = this.active;
            this.active = null;

            clearTimeout(active.stopTimer);
            clearTimeout(active.killTimer);

            const candidates = [...active.candidates.values()]
                .sort((a, b) => a.rank - b.rank);

            const sideToMove = active.fen.split(/\s+/)[1];

            const bestScore = candidates[0]?.score || null;

            let evaluationWhite = null;

            if (bestScore) {
                evaluationWhite = {
                    type: bestScore.type,
                    value: sideToMove === "w"
                        ? bestScore.value
                        : -bestScore.value
                };
            }

            active.resolve({
                depth: active.maxDepth,
                sideToMove,
                bestMove: line.split(/\s+/)[1],
                evaluationWhite,
                candidates
            });
        }
    }

    readAnalysis(line) {
        const depth = Number(
            line.match(/\bdepth (\d+)/)?.[1] || 0
        );

        const rank = Number(
            line.match(/\bmultipv (\d+)/)?.[1] || 1
        );

        const scoreMatch = line.match(
            /\bscore (cp|mate) (-?\d+)/
        );

        const pvMatch = line.match(/\bpv (.+)$/);

        if (!scoreMatch || !pvMatch) return;

        const score = {
            type: scoreMatch[1],
            value: Number(scoreMatch[2])
        };

        const existing = this.active.candidates.get(rank);

        if (existing && existing.depth > depth) return;

        this.active.maxDepth = Math.max(
            this.active.maxDepth,
            depth
        );

        this.active.candidates.set(rank, {
            rank,
            depth,
            score,
            principalVariation: pvMatch[1].trim().split(/\s+/)
        });
    }

    analyse(fen, depth = 14) {
        const task = this.queue.then(async () => {
            await this.ready;

            return new Promise((resolve, reject) => {
                const active = {
                    fen,
                    resolve,
                    reject,
                    candidates: new Map(),
                    maxDepth: 0,
                    stopTimer: null,
                    killTimer: null
                };

                this.active = active;

                this.send(`position fen ${fen}`);
                this.send(`go depth ${depth}`);

                // Stop a search that takes unusually long.
                active.stopTimer = setTimeout(() => {
                    if (this.active !== active) return;

                    this.send("stop");

                    active.killTimer = setTimeout(() => {
                        if (this.active !== active) return;

                        this.active = null;

                        reject(new Error(
                            "Stockfish analysis timed out."
                        ));

                        this.process.kill();
                    }, 5000);

                }, 30000);
            });
        });

        // Keep the queue usable after a failed request.
        this.queue = task.catch(() => {});

        return task;
    }

    close() {
        this.send("quit");
    }
}

const stockfish = new StockfishEngine();

export default stockfish;