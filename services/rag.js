const OpenAI = require("openai");
const pool = require("../db/connection");

function getEmbeddingClient() {
  const apiKey = process.env.RAG_EMBEDDING_API_KEY || process.env.OPENROUTER_API_KEY;
  if (!apiKey) return null;

  return new OpenAI({
    apiKey,
    baseURL: process.env.RAG_EMBEDDING_BASE_URL || "https://openrouter.ai/api/v1",
    timeout: 60000,
    maxRetries: 2,
  });
}

function getEmbeddingModel() {
  return process.env.RAG_EMBEDDING_MODEL || "openai/text-embedding-3-small";
}

async function ensureRagTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS judgment_chunks (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      summary_id INT NOT NULL,
      user_email VARCHAR(255) NOT NULL,
      page_number INT NOT NULL,
      chunk_index INT NOT NULL,
      content TEXT NOT NULL,
      embedding_json LONGTEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_chunks_owner_summary (user_email, summary_id),
      CONSTRAINT fk_judgment_chunks_summary
        FOREIGN KEY (summary_id) REFERENCES pdf_summaries(id) ON DELETE CASCADE
    )
  `);
}

function splitJudgmentIntoChunks(fullText, chunkSize = 1100, overlap = 180) {
  const pages = String(fullText || "").split("\f");
  const chunks = [];

  pages.forEach((pageText, pageIndex) => {
    const normalized = pageText.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
    if (!normalized) return;

    let start = 0;
    while (start < normalized.length) {
      const end = Math.min(start + chunkSize, normalized.length);
      const content = normalized.slice(start, end).trim();
      if (content.length >= 40) {
        chunks.push({ pageNumber: pageIndex + 1, content });
      }
      if (end >= normalized.length) break;
      start = Math.max(end - overlap, start + 1);
    }
  });

  return chunks.map((chunk, index) => ({ ...chunk, chunkIndex: index }));
}

async function createEmbeddings(client, texts) {
  const response = await client.embeddings.create({
    model: getEmbeddingModel(),
    input: texts,
  });
  return response.data
    .sort((a, b) => a.index - b.index)
    .map(item => item.embedding);
}

async function indexJudgment({ summaryId, userEmail, fullText }) {
  const client = getEmbeddingClient();
  if (!client) {
    return { indexed: false, reason: "Embedding API key is not configured." };
  }

  await ensureRagTable();
  const chunks = splitJudgmentIntoChunks(fullText);
  if (!chunks.length) {
    return { indexed: false, reason: "No readable judgment passages were extracted." };
  }

  // Generate vectors in small batches to avoid oversized provider requests.
  const batchSize = 32;
  const rows = [];
  for (let i = 0; i < chunks.length; i += batchSize) {
    const batch = chunks.slice(i, i + batchSize);
    const vectors = await createEmbeddings(client, batch.map(item => item.content));
    batch.forEach((chunk, index) => {
      rows.push([
        summaryId,
        userEmail,
        chunk.pageNumber,
        chunk.chunkIndex,
        chunk.content,
        JSON.stringify(vectors[index]),
      ]);
    });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(
      "DELETE FROM judgment_chunks WHERE summary_id = ? AND user_email = ?",
      [summaryId, userEmail]
    );
    for (let i = 0; i < rows.length; i += 100) {
      const batch = rows.slice(i, i + 100);
      await conn.query(
        `INSERT INTO judgment_chunks
          (summary_id, user_email, page_number, chunk_index, content, embedding_json)
         VALUES ?`,
        [batch]
      );
    }
    await conn.commit();
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }

  return { indexed: true, chunkCount: rows.length };
}

function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return -1;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (!normA || !normB) return -1;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

async function retrieveRelevantChunks({ summaryId, userEmail, question, limit = 5 }) {
  const client = getEmbeddingClient();
  if (!client) return [];

  await ensureRagTable();
  const [ownedSummary] = await pool.query(
    "SELECT id FROM pdf_summaries WHERE id = ? AND user_email = ? LIMIT 1",
    [summaryId, userEmail]
  );
  if (!ownedSummary.length) {
    const error = new Error("Judgment not found for this account.");
    error.status = 404;
    throw error;
  }

  const [rows] = await pool.query(
    `SELECT page_number, chunk_index, content, embedding_json
     FROM judgment_chunks
     WHERE summary_id = ? AND user_email = ?
     ORDER BY chunk_index ASC`,
    [summaryId, userEmail]
  );
  if (!rows.length) return [];

  const [queryVector] = await createEmbeddings(client, [question]);
  return rows
    .map(row => {
      let vector;
      try { vector = JSON.parse(row.embedding_json); } catch { vector = []; }
      return {
        pageNumber: row.page_number,
        chunkIndex: row.chunk_index,
        content: row.content,
        score: cosineSimilarity(queryVector, vector),
      };
    })
    .filter(item => item.score >= 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

module.exports = {
  ensureRagTable,
  indexJudgment,
  retrieveRelevantChunks,
  splitJudgmentIntoChunks,
};
