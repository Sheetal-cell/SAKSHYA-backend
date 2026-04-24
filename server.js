require("dotenv").config();
const express = require("express");
const cors = require("cors");
const judgmentRoutes = require("./routes/judgment");

const app = express();
const PORT = process.env.PORT || 5000;

app.get("/", (req, res) => {
  res.send("CCMS Backend is LIVE 🚀");
});

app.use(cors({
  origin: process.env.FRONTEND_URL || "http://localhost:5173",
  methods: ["GET", "POST"],
}));
app.use(express.json({ limit: "20mb" }));

app.use("/api/judgment", judgmentRoutes);

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