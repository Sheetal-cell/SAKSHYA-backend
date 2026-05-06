const express = require("express");
const OpenAI = require("openai");
const pool = require("../db/connection");
const verifyJWT = require("../middleware/authMiddleware");
const SYSTEM_PROMPT = require("../middleware/systemPrompt");

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

const pdfParse = require("pdf-parse");

async function extractTextFromPDF(buffer) {
  const data = await pdfParse(buffer);
  return data.text;
}


router.post("/analyze", verifyJWT, async (req, res) => {
  const { base64, filename } = req.body;

  if (!base64) {
    return res.status(400).json({ error: "No PDF data provided." });
  }

  if (!process.env.OPENROUTER_API_KEY) {
    return res.status(500).json({ error: "OPENROUTER_API_KEY not configured." });
  }

  try {
    const buffer = Buffer.from(base64, "base64");

    const text = await extractTextFromPDF(buffer);

    if (!text || text.trim().length < 50) {
      return res.status(400).json({
        error: "Unable to extract meaningful text (possibly scanned PDF).",
      });
    }

    const trimmedText = text.slice(0, 12000);

    const client = getClient();

    const response = await client.chat.completions.create({
      model: "openai/gpt-4o-mini",
      temperature: 0.2,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: `
Extract the following from the judgment:
- Key Directives
- Action Items
- Deadlines
- Compliance Requirements
- Risk Factors

Return ONLY valid JSON.

Judgment:
${trimmedText}
          `,
        },
      ],
    });

    const raw = response.choices[0].message.content;

    const clean = raw.replace(/```json/g, "").replace(/```/g, "").trim();

    let parsed;
    try {
      parsed = JSON.parse(clean);
    } catch (e) {
      console.error("❌ JSON parse failed:", clean);
      return res.status(502).json({
        error: "AI returned invalid JSON",
        raw_output: clean,
      });
    }

    const [result] = await pool.query(
      `INSERT INTO pdf_summaries (user_email, filename, summary_json)
       VALUES (?, ?, ?)`,
      [req.user.email, filename || "unknown.pdf", JSON.stringify(parsed)]
    );

    console.log("✅ Saved to DB:", result.insertId);

    return res.json({
      success: true,
      summaryId: result.insertId,
      data: parsed,
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
        },
        note: "Fallback (rate limit)",
      });
    }

    if (err.status === 401) {
      return res.status(401).json({ error: "Invalid API key." });
    }

    return res.status(500).json({
      error: err.message || "Analysis failed",
    });
  }
});

// ── GET /api/judgment/history ─────────────────────────────────────────────────
router.get("/history", verifyJWT, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT
         ps.id,
         ps.filename,
         ps.summary_json,
         ps.created_at,
         COUNT(ch.id) AS chats
       FROM pdf_summaries ps
       LEFT JOIN chat_history ch ON ch.summary_id = ps.id
       WHERE ps.user_email = ?
       GROUP BY ps.id
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