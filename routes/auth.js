const express = require("express");
const { OAuth2Client } = require("google-auth-library");
const jwt = require("jsonwebtoken");
const pool = require("../db/connection");

const router = express.Router();
const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);


// ── Google Auth ──
router.post("/google", async (req, res) => {
  try {
    const { token } = req.body;

    const ticket = await client.verifyIdToken({
      idToken: token,
      audience: process.env.GOOGLE_CLIENT_ID,
    });

    const payload = ticket.getPayload();
    const user = {
      name: payload.name,
      email: payload.email,
      picture: payload.picture,
      googleId: payload.sub,
    };

    // Check if user already exists
    const [existing] = await pool.query(
      "SELECT id FROM users WHERE google_id = ?",
      [user.googleId]
    );

    if (existing.length === 0) {
      // New user — insert only
      await pool.query(
        `INSERT INTO users (google_id, name, email, picture)
         VALUES (?, ?, ?, ?)`,
        [user.googleId, user.name, user.email, user.picture]
      );
      console.log("✅ New user saved:", user.email);
    } else {
      // Returning user — just update last_login
      await pool.query(
        "UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE google_id = ?",
        [user.googleId]
      );
      console.log("👋 Returning user:", user.email);
    }

    const appToken = jwt.sign(
      { email: user.email, googleId: user.googleId },
      process.env.JWT_SECRET,
      { expiresIn: "1d" }
    );

    res.json({ user, token: appToken });
  } catch (err) {
    console.error("Auth error:", {
      message: err.message,
      code: err.code,
      sql: err.sql,
    });
    res.status(401).json({ error: err.message });
  }
});

// GET /auth/profile — fetch user profile + their PDF history
router.get("/profile", require("../middleware/authMiddleware"), async (req, res) => {
  try {
    const [users] = await pool.query(
      "SELECT name, email, picture, created_at, last_login FROM users WHERE email = ?",
      [req.user.email]
    );
    const [summaries] = await pool.query(
      "SELECT id, filename, created_at FROM pdf_summaries WHERE user_email = ? ORDER BY created_at DESC LIMIT 20",
      [req.user.email]
    );
    res.json({ user: users[0], summaries });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;