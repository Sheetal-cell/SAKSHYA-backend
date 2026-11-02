# SAKSHYA-backend

# ⚖️ Sakshya – Backend (CCMS Legal Intelligence System)

## 📌 Overview
The backend powers Sakshya, a Legal AI system for judgment analysis, chat assistance, and case intelligence.

It provides REST APIs and connects to a **MySQL database using mysql2**.

---

## 🚀 Tech Stack
- Node.js
- Express.js
- MySQL2
- dotenv
- CORS
- Axios (optional for AI/API calls)

---

## 📂 Project Structure
backend/
├── config/
│ └── db.js
├── routes/
├── controllers/
├── models/
├── services/
├── server.js
├── app.js
└── .env


---

## 🗄️ Database Setup (MySQL2)

### 1. Install MySQL Server
Make sure MySQL is installed and running locally or on cloud (like AWS / PlanetScale).

---

### 2. Create Database
```sql
CREATE DATABASE sakshya_db;
3. Create Tables (Example)
USE sakshya_db;

CREATE TABLE users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100),
  email VARCHAR(100) UNIQUE,
  password VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE judgments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  title VARCHAR(255),
  content TEXT,
  analysis TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
⚙️ Environment Variables

Create .env file:

PORT=5000

DB_HOST=localhost
DB_USER=root
DB_PASSWORD=your_password
DB_NAME=sakshya_db
DB_PORT=3306
🔌 Database Connection (mysql2)

Example config/db.js:

import mysql from "mysql2";
import dotenv from "dotenv";

dotenv.config();

export const db = mysql.createConnection({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT,
});

db.connect((err) => {
  if (err) {
    console.error("❌ Database connection failed:", err);
  } else {
    console.log("✅ Connected to MySQL Database");
  }
});
🚀 Run Backend
1. Install dependencies
npm install
2. Start server

Development:

npm run dev

Production:

npm start

Server runs at:

http://localhost:5000
📡 API Endpoints
Health Check
GET /api/health
Chat Assistant
POST /api/chat
Judgment Analysis
POST /api/analyze
Users (example)
GET /api/users
POST /api/users
🔐 CORS Configuration
app.use(cors({
  origin: "http://localhost:5173"
}));
✨ Features
Legal chat assistant API
Judgment analysis system
MySQL relational database integration
Modular MVC structure
Scalable backend architecture
🔗 Frontend Integration

Make sure frontend uses:

VITE_API_URL=http://localhost:5000


## Judgment RAG (feature/rag-upgrade)

The RAG upgrade stores page-labelled judgment passages and their embedding vectors in the existing MySQL database. Follow-up chat retrieves the five most relevant passages for the selected judgment and asks the existing chat model to answer with page references.

Configure these optional environment variables on the backend deployment:

- `RAG_EMBEDDING_API_KEY`: API key for an OpenAI-compatible embeddings provider. If omitted, the backend attempts to use `OPENROUTER_API_KEY`.
- `RAG_EMBEDDING_BASE_URL`: embeddings API base URL. Defaults to `https://openrouter.ai/api/v1`.
- `RAG_EMBEDDING_MODEL`: embedding model identifier. Defaults to `openai/text-embedding-3-small`.

The provider must support the OpenAI-compatible `/embeddings` endpoint and the configured model. Verify that the chosen provider/model supports embeddings before enabling this feature. If embeddings are not configured or indexing fails, the existing structured-analysis chat path remains available.

The `judgment_chunks` table is created automatically the first time indexing is attempted. It is scoped by both judgment ID and authenticated user email; deleting a parent judgment cascades to its chunks.
