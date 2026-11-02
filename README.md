# ⚖️ SAKSHYA — Legal Intelligence Backend

SAKSHYA is a legal judgment intelligence system. This repository contains the Node.js/Express REST API responsible for PDF text extraction, AI-powered judgment analysis, legal chat, authentication, MySQL persistence, and retrieval-augmented generation (RAG).

**Frontend repository:** https://github.com/Sheetal-cell/SAKSHYA-frontend

## Architecture

The backend acts as the application and data layer between the React frontend, AI services, and MySQL.

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
  OpenRouter API                 MySQL (mysql2/promise)
  - Chat completions             - users
  - Embeddings (RAG)              - pdf_summaries
                                  - chat_history
                                  - judgment_chunks
```

## Technology stack

- Node.js and Express 4
- MySQL 8-compatible database access through `mysql2/promise`
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
- The backend performs PDF extraction and AI analysis, then returns the result without inserting a summary into MySQL or indexing RAG chunks.
- `POST /api/chat` accepts the same header and answers using the structured analysis supplied in the request.
- Guest requests do not receive database-backed original-passage retrieval or persistent history.

Requests without the guest-mode header continue through JWT verification. Do not treat the guest header as proof of a user identity.

### 5. Retrieval-Augmented Generation (RAG)

RAG improves document-specific chat by retrieving relevant text from the original judgment rather than relying only on the generated summary.

**Indexing pipeline**

1. The PDF text is split on page boundaries.
2. Each page is normalized and divided into overlapping text chunks (default: 1,100 characters with 180 characters of overlap).
3. The embedding client sends batches of up to 32 chunks to an OpenAI-compatible embeddings endpoint.
4. Each chunk, page number, owner, judgment ID, and JSON-serialized embedding vector is stored in the MySQL `judgment_chunks` table.

**Retrieval pipeline**

1. A user's question is converted into an embedding.
2. The backend loads chunks belonging to the requested judgment and authenticated user.
3. Cosine similarity is calculated between the question vector and stored chunk vectors.
4. The five highest-scoring passages are added to the chat system prompt.
5. The assistant is instructed to ground document-specific answers in supplied passages and cite them as `[Page N]`.

The current implementation stores vectors as JSON in MySQL and computes cosine similarity in application code; it does not use a separate vector database.

If embeddings are unavailable or indexing fails, judgment analysis can still complete and chat can fall back to structured analysis. Guest mode intentionally skips this database-backed RAG pipeline.

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
- MySQL server/database
- OpenRouter API key for AI analysis and chat

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

# Optional RAG embedding configuration
RAG_EMBEDDING_API_KEY=your_embeddings_api_key
RAG_EMBEDDING_BASE_URL=https://openrouter.ai/api/v1
RAG_EMBEDDING_MODEL=openai/text-embedding-3-small
```

`RAG_EMBEDDING_API_KEY` is optional and falls back to `OPENROUTER_API_KEY`. The selected provider and model must support the OpenAI-compatible `/embeddings` endpoint.

Create the MySQL database named in `DB_NAME`. The application expects the account, summary, and chat-history tables used by the authentication and route queries. The RAG service creates `judgment_chunks` automatically when indexing is first attempted; its foreign key references `pdf_summaries(id)`.

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

Guest analysis/chat can run without a working MySQL database as long as the backend process starts and the OpenRouter key is valid. Account authentication, saved history, and authenticated RAG indexing/retrieval require a reachable and correctly initialized MySQL database.

## Current limitations

- The database layer is MySQL-specific (`mysql2`); PostgreSQL is not a drop-in replacement without changing the connection and SQL implementation.
- Guest sessions are stateless and do not save PDF analyses or chat history.
- Guest chat uses structured analysis only; original-passage RAG is available only for saved, authenticated judgments.
- PDF text extraction does not currently perform OCR for scanned/image-only documents.
- Analysis input is capped at 12,000 extracted characters.
- RAG vectors are stored as JSON in MySQL and compared in application code, which may not scale as well as a dedicated vector store for large collections.
- AI output is generated content and should be reviewed against the original judgment; SAKSHYA is an assistance tool, not a substitute for professional legal judgment.

## Related repository

- [SAKSHYA Frontend](https://github.com/Sheetal-cell/SAKSHYA-frontend) — React/Vite user interface and browser-side API integration.
