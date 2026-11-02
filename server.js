require("dotenv").config();
const express = require("express");
const cors = require("cors");
const pool = require("./db/connection");

const authRoutes     = require("./routes/auth");
const judgmentRoutes = require("./routes/judgment");
const chatRoutes     = require("./routes/chat");
const voiceRoutes    = require("./routes/voice");          // ← NEW
const verifyJWT      = require("./middleware/authMiddleware");

const app  = express();
const PORT = process.env.PORT || 5000;

app.use(cors({
  origin: [
    "http://localhost:5173",
    "https://sakshya7.vercel.app",
    "https://sakshya-frontend.vercel.app",
  ],
  methods: ["GET", "POST"],
  credentials: true,
}));
app.use(express.json({ limit: "20mb" }));

pool.query("SELECT 1")
  .then(() => console.log("✅ MySQL DB connected"))
  .catch(console.error);

app.get("/test-db", async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT 1 + 1 AS result");
    res.json({ db: "connected", result: rows[0].result });
  } catch (err) {
    res.json({ db: "failed", error: err.message, code: err.code });
  }
});

app.get("/",           (req, res) => res.send("CCMS Backend is LIVE 🚀"));
app.get("/api/health", (req, res) => res.json({ status: "ok", service: "CCMS Judgment Intelligence API" }));
app.get("/protected",  verifyJWT, (req, res) => res.json({ message: "You are authenticated", user: req.user }));

app.use("/auth",         authRoutes);
app.use("/api/judgment", judgmentRoutes);
app.use("/api/chat",     chatRoutes);
app.use("/api/voice",    voiceRoutes);                     // ← NEW

app.use((req, res) => res.status(404).json({ error: "Route not found" }));
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: err.message || "Internal server error" });
});

app.listen(PORT, () => {
  console.log(`✅ CCMS Backend running on http://localhost:${PORT}`);
});
