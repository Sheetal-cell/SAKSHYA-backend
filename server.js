require("dotenv").config();
const express = require("express");
const cors = require("cors");
const judgmentRoutes = require("./routes/judgment");
const chatRoutes = require("./routes/chat"); // ← NEW

const app = express();
const PORT = process.env.PORT || 5000;
const authRoutes = require("./routes/auth");
const verifyJWT = require("./middleware/authMiddleware");
app.get("/protected", verifyJWT, (req, res) => {
  res.json({
    message: "You are authenticated",
    user: req.user,
  });
});
app.get("/", (req, res) => {
  res.send("CCMS Backend is LIVE 🚀");
});

app.use(cors({
  origin: [
    "http://localhost:5173",
    "https://sakshya7.vercel.app"
  ],
  methods: ["GET", "POST"],
  credentials: true
}));
app.use(express.json({ limit: "20mb" }));
app.use("/auth", authRoutes);
app.use("/api/judgment", judgmentRoutes);
app.use("/api/chat", chatRoutes); // ← NEW

app.get("/api/health", (req, res) => {
  res.json({ status: "ok", service: "CCMS Judgment Intelligence API" });
});

app.use((req, res) => {
  res.status(404).json({ error: "Route not found" });
});

app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: err.message || "Internal server error" });
});

app.listen(PORT, () => {
  console.log(`✅ CCMS Backend running on http://localhost:${PORT}`);
});
