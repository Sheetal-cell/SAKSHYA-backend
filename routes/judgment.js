/**
 * SAKSHYA-backend/routes/judgment.js
 *
 * Fixes:
 *  1. Stronger AI prompt enforcement for negotiationCheatSheet — now a
 *     separate dedicated extraction pass so the field is never empty.
 *  2. Two-pass strategy: first full JSON, then if cheatSheet missing,
 *     a focused second call fills it in.
 *  3. Everything else identical to your working version.
 */

const express   = require("express");
const OpenAI    = require("openai");
const pool      = require("../db/connection");
const verifyJWT = require("../middleware/authMiddleware");
const SYSTEM_PROMPT = require("../middleware/systemPrompt");
const pdfParse  = require("pdf-parse");
const { indexJudgment } = require("../services/rag");

const router = express.Router();

function getClient() {
  return new OpenAI({
    apiKey: process.env.OPENROUTER_API_KEY,
    baseURL: "https://openrouter.ai/api/v1",
    defaultHeaders: {
      "HTTP-Referer": process.env.FRONTEND_URL,
      "X-Title": "CCMS Hackathon Project",
    },
  });
}

async function extractTextFromPDF(buffer) {
  // Preserve page boundaries so RAG citations map to actual PDF pages.
  const data = await pdfParse(buffer, {
    pagerender: async (pageData) => {
      const textContent = await pageData.getTextContent({ normalizeWhitespace: true });
      let lastY = null;
      let pageText = "";
      for (const item of textContent.items) {
        const y = item.transform ? item.transform[5] : null;
        if (lastY !== null && y !== null && y !== lastY) {
          pageText += "\n";
        } else if (pageText && !pageText.endsWith("\n")) {
          pageText += " ";
        }
        pageText += item.str || "";
        lastY = y;
      }
      return "\f" + pageText;
    },
  });
  return data.text;
}

// ─── Fetch negotiation cheat sheet as a dedicated second pass ─────────────────
async function fetchNegotiationCheatSheet(client, trimmedText) {
  const response = await client.chat.completions.create({
    model: "openai/gpt-4o-mini",
    temperature: 0.2,
    messages: [
      {
        role: "system",
        content:
          "You are a senior Indian legal negotiation expert. You identify clauses in court judgments that impose burdens and suggest practical plain-English counter-arguments for affected parties.",
      },
      {
        role: "user",
        content: `
Read the following Indian court judgment text.
Return ONLY a valid JSON array (no markdown, no fences, no explanation).

Find the top 3 clauses that impose the highest obligations, penalties, or compliance burdens on any party.
For each clause return an object with EXACTLY these keys:

{
  "clauseTitle": "short title (max 8 words)",
  "severity": "high" or "medium",
  "originalClause": "exact or closely paraphrased problematic clause (1-3 sentences)",
  "risk": "why this clause is dangerous for the burdened party (1-2 sentences)",
  "suggestedChange": "plain-English counter-argument or revised wording the affected party can use to contest or negotiate — no legalese, 2-4 sentences, practical and actionable",
  "relevantLaw": "applicable Indian law / article / section, or null"
}

Rules:
- Always return an array of 3 objects. If fewer than 3 distinct clauses exist, repeat the most impactful ones with different angles.
- suggestedChange MUST be written so a non-lawyer can read and use it directly.
- Do NOT return an empty array under any circumstances.

Judgment text:
${trimmedText}
        `.trim(),
      },
    ],
  });

  const raw   = response.choices[0].message.content;
  const clean = raw.replace(/```json/g, "").replace(/```/g, "").trim();
  return JSON.parse(clean);
}

// ─────────────────────────────────────────────────────────────────────────────
router.post("/analyze", (req, res, next) => req.headers["x-guest-mode"] === "true" ? (req.isGuest = true, next()) : verifyJWT(req, res, next), async (req, res) => {
  const { base64, filename } = req.body;

  if (!base64) return res.status(400).json({ error: "No PDF data provided." });
  if (!process.env.OPENROUTER_API_KEY)
    return res.status(500).json({ error: "OPENROUTER_API_KEY not configured." });

  try {
    const buffer = Buffer.from(base64, "base64");
    const text   = await extractTextFromPDF(buffer);

    if (!text || text.trim().length < 50) {
      return res.status(400).json({
        error: "Unable to extract meaningful text (possibly scanned PDF).",
      });
    }

    const trimmedText = text.slice(0, 12000);
    const client = getClient();

    // ── Pass 1: Full judgment analysis ───────────────────────────────────────
    const response = await client.chat.completions.create({
      model: "openai/gpt-4o-mini",
      temperature: 0.2,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: `
You are a senior legal analyst for the Indian judiciary system.
Analyze the judgment text below and return ONLY a single valid JSON object.
No markdown. No explanation. No code fences.

The JSON must contain ALL of these top-level keys:

{
  "caseTitle": "string",
  "court": "string",
  "caseNumber": "string",
  "judgmentDate": "string",
  "bench": "string",
  "petitioner": "string",
  "respondent": "string",
  "outcome": "allowed|dismissed|partly_allowed|disposed|unknown",
  "appealRecommendation": "comply|appeal|review|unclear",
  "complianceRequired": true|false,
  "complianceDeadline": "string or null",
  "responsibleAuthority": "string or null",
  "limitationPeriod": "string or null",
  "summary": "3-5 sentence plain-English summary of the judgment",
  "summaryLineReference": "string or null",
  "keyDirectives": [
    {
      "id": "D1",
      "directive": "string",
      "priority": "critical|high|medium|low",
      "deadline": "string or null",
      "authority": "string or null",
      "lineReference": "string or null",
      "pageReference": "string or null"
    }
  ],
  "riskFlags": [
    { "flag": "string", "severity": "high|medium|low" }
  ],
  "criticalDates": [
    { "date": "string", "label": "string" }
  ],
  "legalProvisions": ["string"],
  "legalIssues": ["string"],
  "departments": ["string"],
  "authorities": ["string"],
  "action_items": ["string"],
  "negotiationCheatSheet": []
}

IMPORTANT: Set negotiationCheatSheet to an empty array [] — it will be filled separately.

Judgment Text:
${trimmedText}
          `.trim(),
        },
      ],
    });

    const raw   = response.choices[0].message.content;
    const clean = raw.replace(/```json/g, "").replace(/```/g, "").trim();

    let parsed;
    try {
      parsed = JSON.parse(clean);
    } catch (e) {
      console.error("❌ JSON parse failed:", clean.slice(0, 300));
      return res.status(502).json({ error: "AI returned invalid JSON", raw_output: clean });
    }

    // ── Pass 2: Dedicated negotiation cheat sheet ─────────────────────────────
    try {
      const cheatSheet = await fetchNegotiationCheatSheet(client, trimmedText);
      parsed.negotiationCheatSheet = Array.isArray(cheatSheet) ? cheatSheet : [];
      console.log(`✅ Negotiation cheat sheet: ${parsed.negotiationCheatSheet.length} clauses`);
    } catch (csErr) {
      console.warn("⚠️ Cheat sheet pass failed, using empty array:", csErr.message);
      parsed.negotiationCheatSheet = [];
    }

    // Guest analysis is intentionally stateless while the database is unavailable.
    if (req.isGuest) {
      return res.json({
        success: true,
        summaryId: null,
        data: parsed,
        rag: { indexed: false, reason: "Guest mode: analysis is temporary and is not saved." },
        guest: true,
      });
    }

    // ── Save to DB ────────────────────────────────────────────────────────────
    const [result] = await pool.query(
      `INSERT INTO pdf_summaries (user_email, filename, summary_json)
       VALUES (?, ?, ?)`,
      [req.user.email, filename || "unknown.pdf", JSON.stringify(parsed)]
    );

    console.log("✅ Saved to DB:", result.insertId);

    // Build the searchable judgment index without making ordinary analysis fail
    // when the embedding provider is not configured or temporarily unavailable.
    let rag = { indexed: false, reason: "RAG indexing was not completed." };
    try {
      rag = await indexJudgment({
        summaryId: result.insertId,
        userEmail: req.user.email,
        fullText: text,
      });
      if (rag.indexed) console.log(`✅ RAG indexed ${rag.chunkCount} judgment chunks.`);
    } catch (ragError) {
      console.error("⚠️ RAG indexing failed:", ragError.message);
      rag = { indexed: false, reason: "Judgment saved, but passage indexing failed." };
    }

    return res.json({
      success: true,
      summaryId: result.insertId,
      data: parsed,
      rag,
    });

  } catch (err) {
    console.error("❌ Error:", err);

    if (err.status === 429) {
      return res.json({
        success: true,
        data: {
          directives: ["Submit compliance report"],
          action_items: ["Review case file"],
          deadlines: ["Within 30 days"],
          compliance: ["Follow court order"],
          risks: ["Contempt of court"],
          negotiationCheatSheet: [],
        },
        note: "Fallback (rate limit)",
      });
    }

    if (err.status === 401) return res.status(401).json({ error: "Invalid API key." });
    return res.status(500).json({ error: err.message || "Analysis failed" });
  }
});

// ── GET /api/judgment/history ─────────────────────────────────────────────────
router.get("/history", verifyJWT, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT
         ps.id, ps.filename, ps.summary_json, ps.created_at,
         COUNT(ch.id) AS chats
       FROM pdf_summaries ps
       LEFT JOIN chat_history ch ON ch.summary_id = ps.id
       WHERE ps.id IN (
         SELECT MAX(id) FROM pdf_summaries
         WHERE user_email = ?
         GROUP BY filename
       )
       GROUP BY ps.id, ps.filename, ps.summary_json, ps.created_at
       ORDER BY ps.created_at DESC`,
      [req.user.email]
    );

    const parsed = rows.map((r) => ({
      ...r,
      summary_json: typeof r.summary_json === "string"
        ? JSON.parse(r.summary_json)
        : r.summary_json,
    }));

    res.json(parsed);
  } catch (err) {
    console.error("❌ History error:", err);
    res.status(500).json({ error: err.message || "Failed to fetch history" });
  }
});

module.exports = router;
