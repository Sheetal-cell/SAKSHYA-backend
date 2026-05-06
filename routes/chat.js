// Add at top:
const express = require("express");
const router = express.Router();
const pool = require("../db/connection");
const verifyJWT = require("../middleware/authMiddleware");

// Update route — add verifyJWT and summaryId support:
router.post("/", verifyJWT, async (req, res) => {
  const { context, history = [], message, summaryId } = req.body;

  // ... (all existing validation + AI call logic stays the same) ...

  // After getting `reply`, persist both turns:
  if (summaryId) {
    await pool.query(
      `INSERT INTO chat_history (user_email, summary_id, role, content) VALUES
       (?, ?, 'user', ?), (?, ?, 'assistant', ?)`,
      [req.user.email, summaryId, message,
       req.user.email, summaryId, reply]
    );
  }

  return res.json({ success: true, reply });
});

// GET /api/chat/history/:summaryId — load chat for a PDF
router.get("/history/:summaryId", verifyJWT, async (req, res) => {
  const [rows] = await pool.query(
    `SELECT role, content, created_at FROM chat_history
     WHERE user_email = ? AND summary_id = ?
     ORDER BY created_at ASC`,
    [req.user.email, req.params.summaryId]
  );
  res.json({ success: true, history: rows });
});

module.exports = router;