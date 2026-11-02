const OpenAI = require("openai");
const { QdrantClient } = require("@qdrant/js-client-rest");
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

function getQdrantClient() {
  if (!process.env.QDRANT_URL || !process.env.QDRANT_API_KEY) return null;
  return new QdrantClient({
    url: process.env.QDRANT_URL,
    apiKey: process.env.QDRANT_API_KEY,
    timeout: 60000,
  });
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
  return response.data
    .sort((a, b) => a.index - b.index)
    .map(item => item.embedding);
}

async function ensureCollection(qdrant, vectorSize) {
  const collections = await qdrant.getCollections();
  const exists = collections.collections.some(item => item.name === COLLECTION);

  if (!exists) {
    try {
      await qdrant.createCollection(COLLECTION, {
        vectors: { size: vectorSize, distance: "Cosine" },
      });
    } catch (error) {
      // Another simultaneous upload may have created the collection first.
      const refreshed = await qdrant.getCollections();
      if (!refreshed.collections.some(item => item.name === COLLECTION)) throw error;
    }
  }
}

async function indexJudgment({ summaryId, userEmail, fullText, isGuest = false }) {
  const embeddingClient = getEmbeddingClient();
  const qdrant = getQdrantClient();

  if (!embeddingClient) {
    return { indexed: false, reason: "Embedding API key is not configured." };
  }
  if (!qdrant) {
    return { indexed: false, reason: "QDRANT_URL or QDRANT_API_KEY is not configured." };
  }

  const chunks = splitJudgmentIntoChunks(fullText);
  if (!chunks.length) {
    return { indexed: false, reason: "No readable judgment passages were extracted." };
  }

  // Guest documents receive an unguessable ID and never require a MySQL row.
  const documentId = isGuest ? randomUUID() : String(summaryId);
  const ownerKey = isGuest ? `guest:${documentId}` : `user:${String(userEmail).toLowerCase()}`;

  // Generate vectors in small batches to avoid oversized provider requests.
  const batchSize = 32;
  const points = [];
  for (let i = 0; i < chunks.length; i += batchSize) {
    const batch = chunks.slice(i, i + batchSize);
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

  await ensureCollection(qdrant, points[0].vector.length);

  // Re-indexing an authenticated summary replaces its previous vectors.
  if (!isGuest) {
    await qdrant.delete(COLLECTION, {
      wait: true,
      filter: { must: [
        { key: "documentId", match: { value: documentId } },
        { key: "ownerKey", match: { value: ownerKey } },
      ] },
    });
  }

  for (let i = 0; i < points.length; i += 100) {
    await qdrant.upsert(COLLECTION, {
      wait: true,
      points: points.slice(i, i + 100),
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
  const qdrant = getQdrantClient();
  if (!embeddingClient || !qdrant) return [];

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
  const result = await qdrant.search(COLLECTION, {
    vector: queryVector,
    limit,
    with_payload: true,
    filter: {
      must: [
        { key: "documentId", match: { value: targetDocumentId } },
        { key: "ownerKey", match: { value: ownerKey } },
      ],
    },
  });

  return result.map(point => ({
    pageNumber: point.payload.pageNumber,
    chunkIndex: point.payload.chunkIndex,
    content: point.payload.content,
    score: point.score,
  }));
}

module.exports = {
  indexJudgment,
  retrieveRelevantChunks,
  splitJudgmentIntoChunks,
};
