const express = require("express");
const OpenAI  = require("openai");
const pool    = require("../db/connection");
const verifyJWT = require("../middleware/authMiddleware");

const router = express.Router();

// ─── OpenRouter client ────────────────────────────────────────────────────────
function getClient() {
  return new OpenAI({
    apiKey: process.env.OPENROUTER_API_KEY,
    baseURL: "https://openrouter.ai/api/v1",
    defaultHeaders: {
      "HTTP-Referer": process.env.FRONTEND_URL,
      "X-Title": "CCMS Hackathon Project",
    },
    maxRetries: 3,
    timeout: 30000,
  });
}

// ─── System prompt ────────────────────────────────────────────────────────────
function buildSystemPrompt(context) {
  const safeContext = JSON.stringify(context).slice(0, 6000);
  return `You are SAKSHYA Assistant — an expert legal AI built for the Court Case Monitoring System (CCMS) of the Centre for e-Governance, India.

You have been given the full structured analysis of a court judgment. Answer all follow-up questions using ONLY this data. Be concise, factual and professional. Format lists with bullet points where helpful.

=== JUDGMENT ANALYSIS ===
${safeContext}
========================

Rules:
- Never invent facts not present in the analysis above.
- If the user asks something outside the document, say "This information is not available in the analyzed judgment."
- When referencing deadlines or compliance items, always emphasise urgency if applicable.
- Keep answers short (3–6 sentences max) unless a detailed breakdown is explicitly asked.
- Do NOT use **markdown bold** in your responses. Use plain text only.`;
}

// ─── Retry wrapper ────────────────────────────────────────────────────────────
async function callWithRetry(fn, retries = 3, delayMs = 1000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const isNetworkError =
        err.code === "ECONNRESET" ||
        err.message?.includes("terminated") ||
        err.message?.includes("ECONNRESET") ||
        err.cause?.code === "ECONNRESET";

      if (isNetworkError && attempt < retries) {
        console.log(`⚠️ Network error on attempt ${attempt}, retrying in ${delayMs}ms...`);
        await new Promise(r => setTimeout(r, delayMs * attempt));
        continue;
      }
      throw err;
    }
  }
}

// ─── POST /api/chat ───────────────────────────────────────────────────────────
router.post("/", verifyJWT, async (req, res) => {
  const { context, history = [], message, summaryId } = req.body;

  if (!message || typeof message !== "string") {
    return res.status(400).json({ error: "message field is required." });
  }
  if (!context || typeof context !== "object") {
    return res.status(400).json({ error: "context (judgment data) is required." });
  }
  if (!process.env.OPENROUTER_API_KEY) {
    return res.status(500).json({ error: "OPENROUTER_API_KEY not configured on server." });
  }

  // ── AI call ─────────────────────────────────────────────────────────────────
  let reply;
  try {
    const client = getClient();

    const messages = [
      { role: "system", content: buildSystemPrompt(context) },
      ...history.slice(-10).map(({ role, content }) => ({ role, content })),
      { role: "user", content: message },
    ];

    reply = await callWithRetry(async () => {
      const response = await client.chat.completions.create({
        model: "openai/gpt-4o-mini",
        temperature: 0.3,
        max_tokens: 500,
        messages,
      });
      return response.choices[0].message.content;
    });

  } catch (err) {
    console.error("❌ Chat error:", err);

    const isNetworkError =
      err.code === "ECONNRESET" ||
      err.message?.includes("terminated") ||
      err.cause?.code === "ECONNRESET";

    if (isNetworkError) {
      return res.status(503).json({ error: "Connection to AI service was interrupted. Please try again." });
    }
    if (err.status === 429) {
      return res.json({ success: true, reply: "I'm temporarily unavailable due to rate limits. Please try again in a moment." });
    }
    if (err.status === 401) {
      return res.status(401).json({ error: "Invalid OpenRouter API key." });
    }

    return res.status(500).json({ error: err.message || "Failed to process chat message." });
  }

  // ── Persist to DB (non-fatal) ────────────────────────────────────────────────
  if (summaryId) {
    try {
      await pool.query(
        `INSERT INTO chat_history (user_email, summary_id, role, content) VALUES
         (?, ?, 'user', ?), (?, ?, 'assistant', ?)`,
        [req.user.email, summaryId, message,
         req.user.email, summaryId, reply]
      );
    } catch (dbErr) {
      console.error("[chat] DB persist failed (non-fatal):", dbErr);
    }
  }

  return res.json({ success: true, reply });
});

// ─── GET /api/chat/history/:summaryId ────────────────────────────────────────
router.get("/history/:summaryId", verifyJWT, async (req, res) => {
  const { summaryId } = req.params;

  if (!summaryId) {
    return res.status(400).json({ success: false, error: "summaryId is required." });
  }

  try {
    const [rows] = await pool.query(
      `SELECT role, content, created_at
       FROM   chat_history
       WHERE  user_email = ? AND summary_id = ?
       ORDER  BY created_at ASC`,
      [req.user.email, summaryId]
    );
    return res.json({ success: true, history: rows });
  } catch (err) {
    console.error("[chat] history fetch failed:", err);
    return res.status(500).json({ success: false, error: "Could not load history." });
  }
});

module.exports = router;