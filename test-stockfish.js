import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import readline from "node:readline";

const require = createRequire(import.meta.url);
const stockfishPackage = require("stockfish");

// Find the installed Stockfish engine.
const enginePath = stockfishPackage.findEngine("lite-single");

// Start Stockfish as a separate process.
const engine = spawn(process.execPath, [enginePath], {
    stdio: ["pipe", "pipe", "inherit"]
});

// Read Stockfish output one line at a time.
const rl = readline.createInterface({
    input: engine.stdout
});

let searchStarted = false;

const timeout = setTimeout(() => {
    console.error("Stockfish timed out.");
    engine.kill();
    process.exit(1);
}, 30000);

function send(command) {
    engine.stdin.write(command + "\n");
}

rl.on("line", (line) => {
    console.log(line);

    if (line === "uciok") {
        send("isready");
    }

    if (line === "readyok" && !searchStarted) {
        searchStarted = true;

        console.log("\nAnalyzing starting position...\n");

        send("position startpos");
        send("go depth 8");
    }

    if (line.startsWith("bestmove ")) {
        clearTimeout(timeout);

        const bestMove = line.split(/\s+/)[1];

        console.log("\nStockfish test successful!");
        console.log("Best move:", bestMove);

        send("quit");
        engine.kill();
    }
});

engine.on("error", (error) => {
    clearTimeout(timeout);
    console.error("Could not start Stockfish:", error);
});

engine.on("exit", () => {
    clearTimeout(timeout);
});

// Start the UCI handshake.
send("uci");