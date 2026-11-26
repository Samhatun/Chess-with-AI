import express from "express";
import dotenv from "dotenv";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import stockfish from "./stockfish-engine.js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// ==========================================
// LOCAL OLLAMA CONFIGURATION
// ==========================================

const OLLAMA_URL = (
    process.env.OLLAMA_URL || "http://127.0.0.1:11434"
).replace(/\/+$/, "");

const MODEL = process.env.OLLAMA_MODEL || "qwen3:1.7b";
const AI_TIMEOUT = Number(process.env.OLLAMA_TIMEOUT_MS) || 12000;
const CHAT_TIMEOUT = Number(process.env.OLLAMA_CHAT_TIMEOUT_MS) || 25000;

// ==========================================
// SECURITY
// ==========================================

app.use(
    helmet({
        contentSecurityPolicy: {
            directives: {
                ...helmet.contentSecurityPolicy.getDefaultDirectives(),
                "script-src": ["'self'", "'unsafe-inline'"]
            }
        }
    })
);

app.use(express.json({ limit: "10kb" }));
app.use(express.static("public"));

// ==========================================
// RATE LIMITING
// ==========================================

const aiLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 15,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: {
        error: "Too many commentary requests. Please wait a moment."
    }
});

const chatLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 20,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: {
        error: "You're sending messages too quickly. Please wait a moment."
    }
});

// ==========================================
// SAFE STRING EXTRACTION
// ==========================================

function safeString(value, maxLength = 100) {
    return typeof value === "string"
        ? value.trim().slice(0, maxLength)
        : "";
}

// ==========================================
// FEN VALIDATION
// ==========================================

function isValidFen(fen) {
    if (typeof fen !== "string" || fen.length > 100) {
        return false;
    }

    const parts = fen.trim().split(/\s+/);

    if (parts.length !== 6) return false;

    const [board, turn, castling, ep, halfmove, fullmove] = parts;

    if (!/^[wb]$/.test(turn)) return false;

    if (!/^(?:-|K?Q?k?q?)$/.test(castling)) return false;

    if (!/^(?:-|[a-h][36])$/.test(ep)) return false;

    if (!/^\d+$/.test(halfmove)) return false;

    if (!/^[1-9]\d*$/.test(fullmove)) return false;

    const ranks = board.split("/");

    if (ranks.length !== 8) return false;

    for (const rank of ranks) {
        let squares = 0;

        for (const character of rank) {
            if (/^[1-8]$/.test(character)) {
                squares += Number(character);
            } else if (/^[prnbqkPRNBQK]$/.test(character)) {
                squares++;
            } else {
                return false;
            }
        }

        if (squares !== 8) return false;
    }

    return true;
}

// ==========================================
// PREPARE CHESS POSITION
// ==========================================

function preparePosition(position) {
    return {
        fen: safeString(position.fen, 100),

        movingPiece: safeString(position.movingPiece, 20),
        movingColor: safeString(position.movingColor, 20),

        from: safeString(position.from, 5),
        to: safeString(position.to, 5),

        capturedPiece: safeString(position.capturedPiece, 20),
        capturedColor: safeString(position.capturedColor, 20),

        isCapture: position.isCapture === true,
        isEnPassant: position.isEnPassant === true,

        isCastle: ["K", "Q"].includes(position.isCastle)
            ? position.isCastle
            : null,

        promotion: safeString(position.promotion, 20),

        sideToMove: safeString(position.sideToMove, 20),

        isCheck: position.isCheck === true,
        isCheckmate: position.isCheckmate === true,

        gameStatus: safeString(position.gameStatus, 30),

        recentMoves: Array.isArray(position.recentMoves)
            ? position.recentMoves
                .slice(-12)
                .map(move => safeString(move, 20))
            : []
    };
}

// ==========================================
// FALLBACK COMMENTARY
// ==========================================

function generateFallback(position, isGameStart = false) {
    if (isGameStart) {
        return "The pieces are assembled, and the battlefield awaits. Let the contest of strategy and precision begin!";
    }

    const color = position.movingColor || "The player";
    const piece = position.movingPiece || "piece";
    const from = position.from;
    const to = position.to;

    let commentary = `${color} moves the ${piece}`;

    if (from && to) {
        commentary += ` from ${from} to ${to}`;
    }

    commentary += ".";

    if (position.isCheckmate) {
        return `${commentary} Checkmate! The king has fallen, and the battle is decided.`;
    }

    if (position.isCheck) {
        return `${commentary} Check! The opposing king is under direct attack.`;
    }

    if (position.isCastle) {
        return `${commentary} Castling secures the king and brings a rook into action.`;
    }

    if (position.isCapture) {
        const captured = position.capturedPiece || "an opposing piece";
        return `${commentary} The move captures ${captured}, changing the material balance.`;
    }

    if (position.promotion) {
        return `${commentary} The pawn promotes to a ${position.promotion}, gaining a powerful new force.`;
    }

    return `${commentary} The position changes, and both sides must reassess their plans.`;
}

// ==========================================
// GENERATE COMMENTARY USING QWEN3
// ==========================================

async function generateCommentary(prompt, position, engineAnalysis, isGameStart = false) {

    const systemInstructions = `
You are BATTLE HERALD, a dramatic but accurate chess commentator.

Your job is to explain the latest chess move using the supplied
position information and Stockfish analysis.

ACCURACY RULES:
- The FEN is the position AFTER the latest move.
- The move information describes the move that JUST happened.
- Stockfish bestMove is the next recommended move, NOT the latest move.
- evaluationWhite is from White's perspective.
- Positive evaluations favor White; negative evaluations favor Black.
- Never invent captures, pieces, coordinates, threats, or variations.
- Use only tactical claims supported by the supplied position or engine analysis.
- If engine analysis is missing, avoid claiming a specific engine advantage.
- Do not exaggerate a small evaluation advantage.
- Do not confuse the moving side with the side whose turn it is.

COMMENTARY STYLE:
- Write 2 short, natural sentences.
- Aim for approximately 25-45 words.
- Explain one specific positional or tactical consequence.
- Be educational, confident, and occasionally theatrical.
- Avoid repetitive dramatic expressions.
- Return commentary only. No headings, lists, or analysis notes.
- Write in English only. Never use Chinese or any other language.
`;

    const userMessage = `
LATEST MOVE REQUEST:
${prompt}

CHESS POSITION AFTER THE LATEST MOVE:
${JSON.stringify(position)}

VERIFIED STOCKFISH ANALYSIS:
${JSON.stringify(engineAnalysis)}

Explain the move that just happened.
Do not describe Stockfish's bestMove as the move that just happened.
`;

    // Game start: no move has been played yet, so use a dedicated prompt.
    let finalSystem = systemInstructions;
    let finalUser = userMessage;

    if (isGameStart) {
        finalSystem = `
You are BATTLE HERALD, a bombastic medieval battlefield herald announcing a chess match.
The game has NOT started yet. NO move has been played.
Write exactly ONE short, vivid line (maximum 18 words) proclaiming that the battle is about to begin.
Do NOT mention any move, capture, attack, check, or piece action.
Write in English only. Never use Chinese or any other language.
Return only the line, with no quotation marks or explanation.
`;
        finalUser = "Announce that the two armies are assembled and the battle is about to begin.";
    }

    const controller = new AbortController();

    const timeout = setTimeout(() => {
        controller.abort();
    }, AI_TIMEOUT);

    try {
        const response = await fetch(`${OLLAMA_URL}/api/chat`, {
            method: "POST",

            headers: {
                "Content-Type": "application/json"
            },

            signal: controller.signal,

            body: JSON.stringify({
                model: MODEL,

                messages: [
                    {
                        role: "system",
                        content: finalSystem
                    },
                    {
                        role: "user",
                        content: finalUser
                    }
                ],

                stream: false,

                // Disable Qwen3 extended thinking.
                think: false,

                // Keep model loaded between moves.
                keep_alive: "30m",

                options: {
                    temperature: 0.3,
                    top_p: 0.85,
                    num_predict: 85,
                    num_ctx: 2048
                }
            })
        });

        if (!response.ok) {
            const errorText = await response.text();

            throw new Error(
                `Ollama returned ${response.status}: ${errorText}`
            );
        }

        const data = await response.json();

        // Only use actual answer, never thinking field.
        const commentary = data.message?.content?.trim();

        if (!commentary) {
            throw new Error("Ollama returned empty commentary.");
        }

        // The small model sometimes slips into Chinese; use the fallback instead.
        if (/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(commentary)) {
            throw new Error("Commentary contained non-English text.");
        }

        return commentary;

    } finally {
        clearTimeout(timeout);
    }
}

// ==========================================
// BATTLE HERALD COMMENTARY ENDPOINT
// ==========================================

app.post("/api/commentary", aiLimiter, async (req, res) => {

    const requestStartedAt = Date.now();

    try {
        const { prompt, position } = req.body;

        // Validate prompt.
        if (
            typeof prompt !== "string" ||
            prompt.trim().length === 0 ||
            prompt.length > 2000
        ) {
            return res.status(400).json({
                error: "Invalid commentary prompt."
            });
        }

        // Validate position object.
        if (
            position === null ||
            typeof position !== "object" ||
            Array.isArray(position)
        ) {
            return res.status(400).json({
                error: "Invalid chess position."
            });
        }

        const isGameStart = Object.keys(position).length === 0;

        const chessPosition = preparePosition(position);

        let engineAnalysis = null;

        // ======================================
        // STOCKFISH ANALYSIS
        // ======================================

        if (!isGameStart) {

            if (!isValidFen(chessPosition.fen)) {
                return res.status(400).json({
                    error: "Missing or invalid chess position FEN."
                });
            }

            console.log("\n===== STOCKFISH ANALYSIS =====");
            console.log("FEN:", chessPosition.fen);

            const stockfishStartedAt = Date.now();

            try {
                engineAnalysis = await stockfish.analyse(
                    chessPosition.fen,
                    14
                );

                console.log(
                    "Stockfish Time:",
                    Date.now() - stockfishStartedAt,
                    "ms"
                );

                console.log("Best response:", engineAnalysis.bestMove);
                console.log("Evaluation:", engineAnalysis.evaluationWhite);
                console.log("Candidates:", engineAnalysis.candidates);

            } catch (engineError) {
                console.error("Stockfish analysis failed:", engineError);
                console.log("Continuing without engine analysis.");

            } finally {
                console.log(
                    "Stockfish Total Time:",
                    Date.now() - stockfishStartedAt,
                    "ms"
                );
            }

            console.log("==============================\n");
        }

        // ======================================
        // QWEN COMMENTARY
        // ======================================

        console.log("\n===== BATTLE HERALD =====");
        console.log("Local AI:", MODEL);

        let commentary;

        const qwenStartedAt = Date.now();

        try {
            commentary = await generateCommentary(
                prompt,
                chessPosition,
                engineAnalysis,
                isGameStart
            );

            console.log("Qwen commentary:", commentary);

        } catch (aiError) {
            console.error("Ollama commentary failed:", aiError);

            commentary = generateFallback(
                chessPosition,
                isGameStart
            );

            console.log("Using fallback commentary:", commentary);

        } finally {
            console.log(
                "Qwen Total Time:",
                Date.now() - qwenStartedAt,
                "ms"
            );
        }

        // ======================================
        // SEND RESPONSE TO WEBSITE
        // ======================================

        console.log(
            "Complete Request Time:",
            Date.now() - requestStartedAt,
            "ms"
        );

        return res.json({
            commentary,
            analysis: engineAnalysis
        });

    } catch (error) {
        console.error("Commentary request failed:", error);

        return res.status(500).json({
            error: "Could not process commentary request."
        });
    }
});

// ==========================================
// MOVE RECOMMENDATION
// ==========================================

const PIECE_NAMES = {
    p: "pawn", n: "knight", b: "bishop",
    r: "rook", q: "queen", k: "king"
};

// Look up which piece sits on a square (e.g. "g1") in a FEN string.
function pieceAtSquare(fen, square) {
    const ranks = fen.split(/\s+/)[0].split("/");
    const file = square.charCodeAt(0) - 97;
    const rankIndex = 8 - Number(square[1]);

    if (file < 0 || file > 7 || rankIndex < 0 || rankIndex > 7) return null;

    let col = 0;

    for (const ch of ranks[rankIndex]) {
        if (/[1-8]/.test(ch)) {
            col += Number(ch);
        } else {
            if (col === file) {
                return {
                    piece: PIECE_NAMES[ch.toLowerCase()],
                    color: ch === ch.toUpperCase() ? "White" : "Black"
                };
            }
            col++;
        }
    }

    return null;
}

// Turn a UCI move ("g1f3") into verified facts using the FEN BEFORE the move.
function describeUciMove(fen, uci) {
    if (typeof uci !== "string" || uci.length < 4) return null;

    const from = uci.slice(0, 2);
    const to = uci.slice(2, 4);
    const mover = pieceAtSquare(fen, from);
    const target = pieceAtSquare(fen, to);
    const epSquare = fen.split(/\s+/)[3];

    if (!mover) return null;

    const fileShift = to.charCodeAt(0) - from.charCodeAt(0);

    const isCastle =
        mover.piece === "king" && Math.abs(fileShift) === 2
            ? (fileShift > 0 ? "K" : "Q")
            : null;

    const isEnPassant =
        mover.piece === "pawn" && from[0] !== to[0] && !target && to === epSquare;

    return {
        uci,
        piece: mover.piece,
        color: mover.color,
        from,
        to,
        capturedPiece: isEnPassant ? "pawn" : (target ? target.piece : null),
        isCastle,
        isEnPassant,
        promotion: uci[4] ? PIECE_NAMES[uci[4]] : null
    };
}

function moveToText(m) {
    if (!m) return "an unknown move";

    if (m.isCastle) {
        return `${m.color} castles ${m.isCastle === "K" ? "kingside" : "queenside"}`;
    }

    let text = `${m.color} ${m.piece} from ${m.from} to ${m.to}`;

    if (m.isEnPassant) text += ", capturing a pawn en passant";
    else if (m.capturedPiece) text += `, capturing a ${m.capturedPiece}`;

    if (m.promotion) text += `, promoting to a ${m.promotion}`;

    return text;
}

// Score from the point of view of the side to move.
function formatScore(score) {
    if (!score) return null;

    if (score.type === "mate") {
        return score.value > 0
            ? `forced mate in ${score.value}`
            : `being mated in ${-score.value}`;
    }

    const pawns = score.value / 100;
    return `${pawns >= 0 ? "+" : ""}${pawns.toFixed(2)}`;
}

function buildRecommendationFacts(fen, analysis) {
    const sideToMove = fen.split(/\s+/)[1] === "w" ? "White" : "Black";
    const best = describeUciMove(fen, analysis.bestMove);

    // Candidate scores are already from the side-to-move's perspective.
    const [first, second, third] = analysis.candidates;

    const alternatives = [second, third]
        .filter(Boolean)
        .map(c => {
            const uci = c.principalVariation?.[0];
            return {
                uci,
                text: moveToText(describeUciMove(fen, uci)),
                eval: formatScore(c.score)
            };
        })
        .filter(a => a.uci);

    let gapCentipawns = null;

    if (first?.score?.type === "cp" && second?.score?.type === "cp") {
        gapCentipawns = first.score.value - second.score.value;
    }

    return {
        sideToMove,
        best,
        bestText: moveToText(best),
        evalForMover: formatScore(first?.score),
        gapCentipawns,
        alternatives
    };
}

function fallbackRecommendation(facts) {
    let text = `Stockfish recommends this move: ${facts.bestText}.`;

    if (facts.evalForMover) {
        text += ` The engine rates the position at ${facts.evalForMover} for you after best play.`;
    }

    if (facts.gapCentipawns !== null && facts.gapCentipawns >= 50) {
        text += " The alternatives are noticeably weaker.";
    }

    return text;
}

async function generateRecommendation(facts, recentMoves) {
    const systemInstructions = `
You are the STRATEGIC ADVISOR in a chess app. A strong chess engine has
already chosen the best move. Your job is only to explain it to the player.

RULES:
- Address the player as "you".
- The recommended move and all facts below are verified. Do not change them.
- Never invent captures, threats, checks, or variations that are not listed.
- You may mention general principles (development, center control, king safety,
  piece activity) only when they plausibly fit the described move.
- If the gap to the second-best move is large, say the alternatives are clearly weaker.
  If it is small, say several moves are close.
- Write 2 to 3 sentences, about 40-65 words. Plain text only.
- Write in English only.
`;

    const userMessage = `
SIDE TO MOVE (the player): ${facts.sideToMove}
RECOMMENDED MOVE: ${facts.bestText}
ENGINE EVALUATION FOR THE PLAYER AFTER BEST PLAY: ${facts.evalForMover ?? "unknown"}
LEAD OVER SECOND-BEST MOVE (centipawns): ${facts.gapCentipawns ?? "unknown"}
OTHER STRONG OPTIONS: ${
        facts.alternatives.length
            ? facts.alternatives.map(a => `${a.text} (${a.eval})`).join("; ")
            : "none supplied"
    }
RECENT MOVES: ${recentMoves.length ? recentMoves.join(" ") : "none"}

Explain why the recommended move is good.
`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), AI_TIMEOUT);

    try {
        const response = await fetch(`${OLLAMA_URL}/api/chat`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: controller.signal,
            body: JSON.stringify({
                model: MODEL,
                messages: [
                    { role: "system", content: systemInstructions },
                    { role: "user", content: userMessage }
                ],
                stream: false,
                think: false,
                keep_alive: "30m",
                options: {
                    temperature: 0.3,
                    top_p: 0.85,
                    num_predict: 140,
                    num_ctx: 2048
                }
            })
        });

        if (!response.ok) {
            throw new Error(`Ollama returned ${response.status}: ${await response.text()}`);
        }

        const data = await response.json();

        // Defensively strip any leaked <think> blocks.
        const text = (data.message?.content || "")
            .replace(/<think>[\s\S]*?<\/think>/g, "")
            .trim();

        if (!text) throw new Error("Ollama returned empty recommendation.");

        return text;

    } finally {
        clearTimeout(timeout);
    }
}

app.post("/api/recommend", aiLimiter, async (req, res) => {
    try {
        const fen = safeString(req.body?.fen, 100);

        if (!isValidFen(fen)) {
            return res.status(400).json({ error: "Missing or invalid chess position FEN." });
        }

        const recentMoves = Array.isArray(req.body?.recentMoves)
            ? req.body.recentMoves.slice(-10).map(m => safeString(m, 20)).filter(Boolean)
            : [];

        let analysis;

        try {
            analysis = await stockfish.analyse(fen, 14);
        } catch (engineError) {
            console.error("Stockfish recommendation failed:", engineError);
            return res.status(503).json({ error: "The chess engine is unavailable right now." });
        }

        if (!analysis.bestMove || analysis.bestMove === "(none)") {
            return res.status(400).json({ error: "There are no legal moves in this position." });
        }

        const facts = buildRecommendationFacts(fen, analysis);

        let explanation;
        let source = "ai";

        try {
            explanation = await generateRecommendation(facts, recentMoves);
        } catch (aiError) {
            console.error("Ollama recommendation failed:", aiError);
            explanation = fallbackRecommendation(facts);
            source = "fallback";
        }

        return res.json({
            bestMove: analysis.bestMove,
            evaluation: analysis.evaluationWhite,   // White's perspective
            alternatives: facts.alternatives,
            explanation,
            source
        });

    } catch (error) {
        console.error("Recommendation request failed:", error);
        return res.status(500).json({ error: "Could not process recommendation request." });
    }
});

// ==========================================
// CHAT WITH AI
// ==========================================

function sanitizeChatHistory(history) {
    if (!Array.isArray(history)) return [];

    return history
        .slice(-8)
        .filter(m => m && (m.role === "user" || m.role === "assistant"))
        .map(m => ({ role: m.role, content: safeString(m.content, 600) }))
        .filter(m => m.content);
}

// Evaluation from White's perspective (positive favors White).
function evalWhiteText(score) {
    if (!score) return "unknown";

    if (score.type === "mate") {
        return score.value > 0
            ? `White has a forced mate in ${score.value}`
            : `Black has a forced mate in ${-score.value}`;
    }

    const pawns = score.value / 100;
    return `${pawns >= 0 ? "+" : ""}${pawns.toFixed(2)} (positive favors White)`;
}

async function generateChatReply(message, history, ctx) {
    let positionBlock = "No board position was supplied.";

    if (ctx) {
        positionBlock = `
CURRENT POSITION (verified):
- FEN: ${ctx.fen}
- Side to move: ${ctx.sideToMove}
- The human player is: ${ctx.playerColor}
- Recent moves: ${ctx.recentMoves.length ? ctx.recentMoves.join(" ") : "none yet"}
${ctx.engine ? `- Stockfish evaluation: ${ctx.engine.eval}
- Stockfish's best move for the side to move: ${ctx.engine.best}
- Other strong options: ${ctx.engine.alternatives || "none supplied"}` : "- Engine analysis unavailable."}`;
    }

    const systemInstructions = `
You are the friendly AI chess coach inside a chess app. The player can ask you
anything: chess strategy, tactics, openings, rules, the current game, or general
questions.

RULES:
- Answer the question directly and conversationally, in plain text (no markdown, no lists).
- Keep answers short: usually 2 to 5 sentences, under about 120 words.
- For questions about the current game, use ONLY the verified position info below.
  Never invent pieces, captures, threats, or variations that are not supported by it.
- If you are not sure about something on the board, say so instead of guessing.
- If the player asks for a move suggestion, you may mention Stockfish's best move
  and explain the idea behind it.
- For non-chess questions, answer helpfully and briefly.
- Reply in the same language the player writes in (English by default).
${positionBlock}
`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CHAT_TIMEOUT);

    try {
        const response = await fetch(`${OLLAMA_URL}/api/chat`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: controller.signal,
            body: JSON.stringify({
                model: MODEL,
                messages: [
                    { role: "system", content: systemInstructions },
                    ...history,
                    { role: "user", content: message }
                ],
                stream: false,
                think: false,
                keep_alive: "30m",
                options: {
                    temperature: 0.4,
                    top_p: 0.9,
                    num_predict: 260,
                    num_ctx: 3072
                }
            })
        });

        if (!response.ok) {
            throw new Error(`Ollama returned ${response.status}: ${await response.text()}`);
        }

        const data = await response.json();

        const text = (data.message?.content || "")
            .replace(/<think>[\s\S]*?<\/think>/g, "")
            .trim();

        if (!text) throw new Error("Ollama returned an empty chat reply.");

        return text;

    } finally {
        clearTimeout(timeout);
    }
}

app.post("/api/chat", chatLimiter, async (req, res) => {
    try {
        const message = safeString(req.body?.message, 500);

        if (!message) {
            return res.status(400).json({ error: "Please type a question." });
        }

        const history = sanitizeChatHistory(req.body?.history);
        const playerColor = req.body?.playerColor === "b" ? "Black" : "White";
        const recentMoves = Array.isArray(req.body?.recentMoves)
            ? req.body.recentMoves.slice(-10).map(m => safeString(m, 20)).filter(Boolean)
            : [];

        const fen = safeString(req.body?.fen, 100);
        let ctx = null;

        if (isValidFen(fen)) {
            ctx = {
                fen,
                sideToMove: fen.split(/\s+/)[1] === "w" ? "White" : "Black",
                playerColor,
                recentMoves,
                engine: null
            };

            try {
                const analysis = await stockfish.analyse(fen, 12);

                if (analysis.bestMove && analysis.bestMove !== "(none)") {
                    const facts = buildRecommendationFacts(fen, analysis);

                    ctx.engine = {
                        eval: evalWhiteText(analysis.evaluationWhite),
                        best: facts.bestText,
                        alternatives: facts.alternatives
                            .map(a => `${a.text} (${a.eval})`)
                            .join("; ")
                    };
                }
            } catch (engineError) {
                console.error("Stockfish (chat) failed:", engineError);
            }
        }

        let reply;

        try {
            reply = await generateChatReply(message, history, ctx);
        } catch (aiError) {
            console.error("Ollama chat failed:", aiError);
            return res.status(503).json({
                error: "The AI is not responding right now. Please try again in a moment."
            });
        }

        return res.json({ reply });

    } catch (error) {
        console.error("Chat request failed:", error);
        return res.status(500).json({ error: "Could not process chat request." });
    }
});

// ==========================================
// HEALTH CHECK
// ==========================================

app.get("/api/health", async (req, res) => {

    let ollamaStatus = "unavailable";

    try {
        const response = await fetch(`${OLLAMA_URL}/api/tags`, {
            signal: AbortSignal.timeout(5000)
        });

        ollamaStatus = response.ok ? "connected" : "unavailable";

    } catch {
        ollamaStatus = "unavailable";
    }

    res.json({
        status: "Chess server is running.",
        model: MODEL,
        ollama: ollamaStatus,
        chessEngine: "Stockfish 19 Lite"
    });
});

// ==========================================
// START SERVER
// ==========================================

const server = app.listen(PORT, () => {

    console.log("-----------------------------------");
    console.log("BATTLE HERALD CHESS SERVER");
    console.log(`Server: http://localhost:${PORT}`);
    console.log(`AI Model: ${MODEL} (Ollama)`);
    console.log("Chess Engine: Stockfish 19 Lite");
    console.log("-----------------------------------");

});

// ==========================================
// GRACEFUL SHUTDOWN
// ==========================================

let shuttingDown = false;

function shutdown() {

    if (shuttingDown) return;

    shuttingDown = true;

    console.log("\nShutting down Battle Herald...");

    stockfish.close();

    server.close(() => {
        process.exit(0);
    });

    setTimeout(() => process.exit(1), 5000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);