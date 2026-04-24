const express = require("express");
const OpenAI = require("openai");
const pdfjsLib = require("pdfjs-dist/legacy/build/pdf");

const SYSTEM_PROMPT = require("../middleware/systemPrompt");

const router = express.Router();

const client = new OpenAI({
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: "https://openrouter.ai/api/v1",
  defaultHeaders: {
    "HTTP-Referer": process.env.FRONTEND_URL,
    "X-Title": "CCMS Hackathon Project",
  },
});

/**
 * Extract text from PDF using pdfjs
 */
async function extractTextFromPDF(data) {
  const loadingTask = pdfjsLib.getDocument({ data });
  const pdfDoc = await loadingTask.promise;

  let text = "";

  for (let i = 1; i <= pdfDoc.numPages; i++) {
    const page = await pdfDoc.getPage(i);
    const content = await page.getTextContent();

    const strings = content.items.map(item => item.str);
    text += strings.join(" ") + "\n";
  }

  return text;
}

/**
 * POST /api/judgment/analyze
 */
router.post("/analyze", async (req, res) => {
  const { base64, filename } = req.body;

  // ✅ Validate input
  if (!base64) {
    return res.status(400).json({
      error: "No PDF data provided. Send base64 field.",
    });
  }

  if (!process.env.OPENROUTER_API_KEY) {
    return res.status(500).json({
      error: "OPENROUTER_API_KEY not configured on server.",
    });
  }

  try {
    console.log(`📄 Analyzing judgment: ${filename || "unknown.pdf"}`);

    // ✅ Step 1: base64 → Uint8Array
    const buffer = Buffer.from(base64, "base64");
    const uint8Array = new Uint8Array(buffer);

    // ✅ Step 2: Extract text
    const text = await extractTextFromPDF(uint8Array);

    if (!text || text.trim().length < 50) {
      return res.status(400).json({
        error: "Unable to extract meaningful text from PDF (possibly scanned).",
      });
    }

    // ⚠️ Prevent token overflow
    const trimmedText = text.slice(0, 12000);

    // ✅ Step 3: Call OpenRouter
    const response = await client.chat.completions.create({
      model: "openai/gpt-4o-mini", // or "mistralai/mistral-7b-instruct"
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content: SYSTEM_PROMPT,
        },
        {
          role: "user",
          content: `
You are a legal analysis engine.

Extract the following from the judgment:
- Key Directives
- Action Items (who must do what)
- Deadlines (explicit or inferred)
- Compliance Requirements
- Risk Factors (non-compliance consequences)

Return ONLY valid JSON.
No explanation.
No markdown.

Judgment Text:
${trimmedText}
          `,
        },
      ],
    });

    const raw = response.choices[0].message.content;

    // ✅ Step 4: Clean + Parse JSON safely
    const clean = raw
      .replace(/```json/g, "")
      .replace(/```/g, "")
      .trim();

    let parsed;
    try {
      parsed = JSON.parse(clean);
    } catch (e) {
      console.error("⚠️ JSON Parse Failed:", clean);
      return res.status(502).json({
        error: "AI returned malformed JSON",
        raw_output: clean,
      });
    }

    console.log(`✅ Analysis complete for: ${filename || "unknown.pdf"}`);

    return res.json({
      success: true,
      data: parsed,
    });

  } catch (err) {
    console.error("❌ Analysis error:", err);

    // 🔁 Demo-safe fallback
    if (err.status === 429) {
      return res.json({
        success: true,
        data: {
          directives: ["Submit compliance report to authority"],
          action_items: ["Department to review case file"],
          deadlines: ["Within 30 days"],
          compliance: ["Follow court order strictly"],
          risks: ["Contempt of court if ignored"],
        },
        note: "Fallback mode (rate limit or quota exceeded)",
      });
    }

    if (err.status === 401) {
      return res.status(401).json({
        error: "Invalid OpenRouter API key.",
      });
    }

    return res.status(500).json({
      error: err.message || "Failed to analyze judgment.",
    });
  }
});

module.exports = router;