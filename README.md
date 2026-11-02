# ⚖️ SAKSHYA — Legal Intelligence Backend

SAKSHYA is a legal judgment intelligence system. This repository contains the Node.js/Express REST API responsible for PDF text extraction, AI-powered judgment analysis, legal chat, authentication, MySQL persistence, and retrieval-augmented generation (RAG).

**Frontend repository:** https://github.com/Sheetal-cell/SAKSHYA-frontend

## Architecture

The backend acts as the application and data layer between the React frontend, AI services, Qdrant Cloud, and (for account features) MySQL.

```text
React + Vite Frontend
        |
        | REST / JSON + Base64 PDF
        v
Express API (server.js)
        |
        +-- /auth       -> Google identity verification + JWT/profile
        |
        +-- /api/judgment
        |      +-- PDF Base64 decoding
        |      +-- PDF text extraction (page-aware)
        |      +-- LLM structured analysis
        |      +-- MySQL summary persistence (authenticated users)
        |      +-- RAG chunking + embeddings + indexing
        |
        +-- /api/chat
        |      +-- Request validation
        |      +-- Optional RAG passage retrieval
        |      +-- LLM response generation
        |      +-- Chat-history persistence (authenticated records)
        |
        +-- /api/voice
        |
        v
  OpenRouter API                 Qdrant Cloud
  - Chat completions             - judgment_chunks collection
  - Embeddings (RAG)              - vectors + page-aware payloads

                                  MySQL (authenticated account features)
                                  - users
                                  - pdf_summaries
                                  - chat_history
```

## Technology stack

- Node.js and Express 4
- Qdrant Cloud vector storage through its REST API
- MySQL 8-compatible account/history database access through `mysql2/promise`
- OpenAI JavaScript SDK configured with the OpenRouter-compatible API
- `pdf-parse` for PDF text extraction
- `google-auth-library` for Google ID-token verification
- `jsonwebtoken` for application JWTs
- `cors` and `dotenv` for API configuration

## Project structure

```text
.
├── db/
│   └── connection.js          # MySQL connection pool
├── middleware/
│   ├── authMiddleware.js      # JWT verification
│   └── systemPrompt.js        # Judgment-analysis system instructions
├── routes/
│   ├── auth.js                # Google authentication and profile
│   ├── judgment.js            # PDF analysis and saved judgment history
│   ├── chat.js                # AI chat, RAG retrieval and chat history
│   └── voice.js               # Voice-related API routes
├── services/
│   └── rag.js                 # Chunking, embeddings, indexing and retrieval
├── server.js                 # Express app, CORS and route registration
├── package.json
└── .env                       # Local secrets/configuration (not committed)
```

## Core implementation concepts

### 1. REST API and middleware

`server.js` creates the Express application, enables JSON request parsing and CORS, registers route modules, and exposes health/database checks. The API is split into authentication, judgment, chat, and voice route modules.

### 2. PDF extraction and structured analysis

The judgment endpoint accepts a Base64-encoded PDF. The backend decodes the file and uses `pdf-parse` to extract text. Its custom page renderer preserves form-feed page boundaries so later RAG chunks can retain page numbers.

The extracted text is limited to the first 12,000 characters for the analysis prompt. The backend calls the configured OpenRouter chat model (`openai/gpt-4o-mini`) to produce structured JSON containing case details, outcome, summary, directives, deadlines, risks, legal provisions, action items, and related fields.

A second focused LLM pass generates the negotiation cheat sheet. If that second pass fails, the main analysis can still be returned with an empty cheat-sheet array.

### 3. Authentication and authorization

The Google authentication route verifies a Google ID token using `google-auth-library`. It creates or updates the corresponding MySQL user record and issues an application JWT signed with `JWT_SECRET`. Protected routes use `middleware/authMiddleware.js` to verify the bearer token and attach the authenticated user's identity to the request.

The frontend currently displays an under-development notice for Google sign-in and offers guest access. The backend authentication routes and JWT middleware remain in place for future reactivation.

### 4. Guest mode

Guest access is an explicit request mode, not a replacement for the authenticated flow:

- `POST /api/judgment/analyze` accepts `X-Guest-Mode: true` without requiring a JWT.
- The backend performs PDF extraction and AI analysis without inserting a summary into MySQL.
- The full extracted PDF text is chunked, embedded, and indexed in Qdrant under a random document ID. The ID is returned as `summaryId` for the current browser session.
- `POST /api/chat` accepts the same header and uses that document ID to retrieve the top five relevant original passages from Qdrant.
- Guest chat and analysis remain temporary: no MySQL summary or chat history is persisted. The Qdrant vectors remain until explicitly deleted or the free cluster is removed.

Requests without the guest-mode header continue through JWT verification. Do not treat the guest header as proof of a user identity.

### 5. Retrieval-Augmented Generation (RAG)

SAKSHYA uses Qdrant Cloud as its vector database. This lets Guest Mode use original-document RAG without requiring a MySQL account or saved-summary row.

**Indexing pipeline**

1. The PDF parser extracts text while preserving page boundaries.
2. Each page is normalized and divided into overlapping chunks (default: 1,100 characters with 180 characters of overlap).
3. The OpenAI-compatible embeddings endpoint generates vectors in batches of up to 32 chunks.
4. The backend creates the `sakshya_judgments` Qdrant collection on first use, using the embedding vector dimension and cosine distance.
5. Each vector is stored with payload metadata: document ID, owner scope, page number, chunk index, and original passage text.

**Retrieval pipeline**

1. The user's question is converted into an embedding.
2. Qdrant performs cosine-similarity vector search, filtered by both document ID and owner scope.
3. The five highest-scoring original passages are included in the chat system prompt.
4. The assistant is instructed to ground document-specific answers in retrieved passages and cite them as `[Page N]`.

**Guest isolation**

- Each guest PDF receives a cryptographically random document ID.
- Guest vectors use a document-specific owner scope, and chat searches are filtered to that exact ID/scope pair.
- The frontend sends the returned document ID as `summaryId` on subsequent chat requests.
- Guest documents are not written to MySQL. They remain in Qdrant until manually removed or the cluster is deleted; configure a retention/cleanup policy before using this for sensitive production documents.

**Authenticated users**

Authenticated indexing continues to associate Qdrant vectors with the saved MySQL summary ID and the user's email scope. Retrieval first checks that the summary belongs to the authenticated user, then searches Qdrant. This authenticated flow still requires a working MySQL database.

If embeddings or Qdrant are unavailable, analysis can still complete, but the response reports that RAG indexing did not complete and chat falls back to the structured analysis.

### 6. AI provider integration

Chat completions use the OpenRouter-compatible endpoint through the OpenAI SDK. The default chat model is `openai/gpt-4o-mini`. RAG embeddings use a separately configurable embedding model, defaulting to `openai/text-embedding-3-small`.

Keep provider keys on the backend only. Never expose `OPENROUTER_API_KEY`, embedding keys, `JWT_SECRET`, or database credentials in frontend variables or source control.

## API reference

| Method | Endpoint | Purpose | Access |
|---|---|---|---|
| GET | `/` | Basic service response | Public |
| GET | `/api/health` | API health check | Public |
| GET | `/test-db` | MySQL connectivity check | Public; diagnostic only |
| POST | `/auth/google` | Verify Google ID token and issue JWT | Public endpoint; requires valid Google token |
| GET | `/auth/profile` | Return account profile and recent summaries | JWT |
| POST | `/api/judgment/analyze` | Extract and analyze a PDF | JWT or explicit guest header |
| GET | `/api/judgment/history` | List saved judgment history | JWT |
| POST | `/api/chat` | Ask a question about supplied analysis | JWT or explicit guest header |
| GET | `/api/chat/history/:summaryId` | Load saved chat history | JWT |

For guest analysis and chat, send the header:

```http
X-Guest-Mode: true
Content-Type: application/json
```

Authenticated requests use:

```http
Authorization: Bearer <application-jwt>
Content-Type: application/json
```

## Local setup

### Requirements

- Node.js LTS and npm
- MySQL server/database for authenticated accounts and history (Guest Mode does not require it)
- OpenRouter API key for AI analysis, chat, and embeddings
- Qdrant Cloud cluster and API key for RAG

### Install

```bash
git clone https://github.com/Sheetal-cell/SAKSHYA-backend.git
cd SAKSHYA-backend
npm install
```

### Environment variables

Create a local `.env` file in the backend root:

```env
PORT=5000
FRONTEND_URL=http://localhost:5173

# MySQL
DB_HOST=localhost
DB_PORT=3306
DB_USER=root
DB_PASSWORD=your_mysql_password
DB_NAME=sakshya_db
DB_SSL=false

# AI provider
OPENROUTER_API_KEY=your_openrouter_api_key

# Authentication
GOOGLE_CLIENT_ID=your_google_oauth_client_id
JWT_SECRET=use_a_long_random_secret

# Qdrant Cloud vector database (required for RAG)
QDRANT_URL=https://your-cluster-endpoint
QDRANT_API_KEY=your_qdrant_api_key
QDRANT_COLLECTION=sakshya_judgments

# Optional embedding overrides (otherwise OPENROUTER_API_KEY is reused)
RAG_EMBEDDING_API_KEY=your_embeddings_api_key
RAG_EMBEDDING_BASE_URL=https://openrouter.ai/api/v1
RAG_EMBEDDING_MODEL=openai/text-embedding-3-small
```

`RAG_EMBEDDING_API_KEY` is optional and falls back to `OPENROUTER_API_KEY`. The selected provider and model must support the OpenAI-compatible `/embeddings` endpoint.

Create the MySQL database named in `DB_NAME`. The application expects the account, summary, and chat-history tables used by the authentication and route queries. RAG vectors are stored in the Qdrant collection configured by `QDRANT_COLLECTION` (default: `sakshya_judgments`). No MySQL vector table is required.

Never commit `.env` or real credentials.

### Run

```bash
# Development
npm run dev

# Production
npm start
```

The API listens on the configured `PORT` (5000 by default).

## Deployment notes

The backend can run on a Node hosting service such as Render. Configure all required environment variables in the hosting dashboard, set `FRONTEND_URL` to the deployed frontend origin, and add that origin to the CORS allowlist in `server.js`. Configure the frontend's `VITE_API_BASE_URL` with the deployed backend origin.

Guest analysis, Qdrant indexing, and guest RAG chat can run without a working MySQL database when the OpenRouter and Qdrant credentials are configured. Google account persistence, saved history, and authenticated RAG ownership checks still require a reachable and correctly initialized MySQL database.

## Current limitations

- The database layer is MySQL-specific (`mysql2`); PostgreSQL is not a drop-in replacement without changing the connection and SQL implementation.
- Guest sessions are stateless and do not save PDF analyses or chat history.
- Guest chat uses structured analysis only; original-passage RAG is available only for saved, authenticated judgments.
- PDF text extraction does not currently perform OCR for scanned/image-only documents.
- Analysis input is capped at 12,000 extracted characters.
- Guest documents are temporary at the application/session level but their Qdrant vectors require an explicit cleanup/retention strategy. The free Qdrant cluster can also suspend after inactivity and has limited storage.
- AI output is generated content and should be reviewed against the original judgment; SAKSHYA is an assistance tool, not a substitute for professional legal judgment.

## Related repository

- [SAKSHYA Frontend](https://github.com/Sheetal-cell/SAKSHYA-frontend) — React/Vite user interface and browser-side API integration.
