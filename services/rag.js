const OpenAI = require("openai");
const { randomUUID } = require("crypto");
const pool = require("../db/connection");

const COLLECTION = process.env.QDRANT_COLLECTION || "sakshya_judgments";

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

function getQdrantConfig() {
  if (!process.env.QDRANT_URL || !process.env.QDRANT_API_KEY) return null;
  return {
    baseUrl: process.env.QDRANT_URL.replace(/\/$/, ""),
    apiKey: process.env.QDRANT_API_KEY,
  };
}

// Use Qdrant's REST API so no additional runtime dependency is required.
async function qdrantRequest(path, { method = "GET", body } = {}) {
  const config = getQdrantConfig();
  if (!config) throw new Error("QDRANT_URL or QDRANT_API_KEY is not configured.");

  const response = await fetch(`${config.baseUrl}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "api-key": config.apiKey,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.status === "error") {
    throw new Error(result.status?.error || result.result?.status || `Qdrant request failed (${response.status}).`);
  }
  return result;
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
        chunks.push({ pageNumber: pages.length > 1 ? pageIndex : 1, content });
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
  return response.data.sort((a, b) => a.index - b.index).map(item => item.embedding);
}

async function ensureCollection(vectorSize) {
  const collections = await qdrantRequest("/collections");
  const exists = collections.result?.collections?.some(item => item.name === COLLECTION);
  if (exists) return;

  try {
    await qdrantRequest(`/collections/${encodeURIComponent(COLLECTION)}`, {
      method: "PUT",
      body: { vectors: { size: vectorSize, distance: "Cosine" } },
    });
  } catch (error) {
    // A concurrent upload may create the collection between list and create.
    const refreshed = await qdrantRequest("/collections");
    if (!refreshed.result?.collections?.some(item => item.name === COLLECTION)) throw error;
  }
}

async function indexJudgment({ summaryId, userEmail, fullText, isGuest = false }) {
  const embeddingClient = getEmbeddingClient();
  if (!embeddingClient) return { indexed: false, reason: "Embedding API key is not configured." };
  if (!getQdrantConfig()) return { indexed: false, reason: "QDRANT_URL or QDRANT_API_KEY is not configured." };

  const chunks = splitJudgmentIntoChunks(fullText);
  if (!chunks.length) return { indexed: false, reason: "No readable judgment passages were extracted." };

  // Guest documents receive an unguessable ID and never require a MySQL row.
  const documentId = isGuest ? randomUUID() : String(summaryId);
  const ownerKey = isGuest ? `guest:${documentId}` : `user:${String(userEmail).toLowerCase()}`;
  const points = [];

  for (let i = 0; i < chunks.length; i += 32) {
    const batch = chunks.slice(i, i + 32);
    const vectors = await createEmbeddings(embeddingClient, batch.map(item => item.content));
    batch.forEach((chunk, index) => {
      points.push({
        id: randomUUID(),
        vector: vectors[index],
        payload: {
          documentId,
          ownerKey,
          pageNumber: chunk.pageNumber,
          chunkIndex: chunk.chunkIndex,
          content: chunk.content,
        },
      });
    });
  }

  await ensureCollection(points[0].vector.length);

  // Replace previous vectors if an authenticated judgment is re-indexed.
  if (!isGuest) {
    await qdrantRequest(`/collections/${encodeURIComponent(COLLECTION)}/points/delete?wait=true`, {
      method: "POST",
      body: {
        filter: {
          must: [
            { key: "documentId", match: { value: documentId } },
            { key: "ownerKey", match: { value: ownerKey } },
          ],
        },
      },
    });
  }

  for (let i = 0; i < points.length; i += 100) {
    await qdrantRequest(`/collections/${encodeURIComponent(COLLECTION)}/points?wait=true`, {
      method: "PUT",
      body: { points: points.slice(i, i + 100) },
    });
  }

  return { indexed: true, chunkCount: points.length, documentId };
}

async function retrieveRelevantChunks({
  summaryId,
  documentId,
  userEmail,
  question,
  limit = 5,
  isGuest = false,
}) {
  const embeddingClient = getEmbeddingClient();
  if (!embeddingClient || !getQdrantConfig()) return [];

  let targetDocumentId;
  let ownerKey;

  if (isGuest) {
    targetDocumentId = String(documentId || summaryId || "");
    if (!targetDocumentId) return [];
    ownerKey = `guest:${targetDocumentId}`;
  } else {
    if (!summaryId || !userEmail) return [];
    const [ownedSummary] = await pool.query(
      "SELECT id FROM pdf_summaries WHERE id = ? AND user_email = ? LIMIT 1",
      [summaryId, userEmail]
    );
    if (!ownedSummary.length) {
      const error = new Error("Judgment not found for this account.");
      error.status = 404;
      throw error;
    }
    targetDocumentId = String(summaryId);
    ownerKey = `user:${String(userEmail).toLowerCase()}`;
  }

  const [queryVector] = await createEmbeddings(embeddingClient, [question]);
  const result = await qdrantRequest(`/collections/${encodeURIComponent(COLLECTION)}/points/search`, {
    method: "POST",
    body: {
      vector: queryVector,
      limit,
      with_payload: true,
      filter: {
        must: [
          { key: "documentId", match: { value: targetDocumentId } },
          { key: "ownerKey", match: { value: ownerKey } },
        ],
      },
    },
  });

  return (result.result || []).map(point => ({
    pageNumber: point.payload.pageNumber,
    chunkIndex: point.payload.chunkIndex,
    content: point.payload.content,
    score: point.score,
  }));
}

module.exports = { indexJudgment, retrieveRelevantChunks, splitJudgmentIntoChunks };
