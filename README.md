# ⚖️ PRAMAAN — Justice Within Reach

> AI-powered free legal access for every Indian citizen

[![Next.js](https://img.shields.io/badge/Next.js-16-black?logo=next.js)](https://nextjs.org)
[![Groq](https://img.shields.io/badge/Groq-llama--3.3--70b-orange)](https://groq.com)
[![Supabase](https://img.shields.io/badge/Supabase-PostgreSQL-green?logo=supabase)](https://supabase.com)
[![License](https://img.shields.io/badge/License-MIT-blue)](LICENSE)

---

## 🇮🇳 The Problem

India has over **300 million citizens** who cannot access justice — not because their case is weak, but because legal help is expensive, complex, and inaccessible. A first-generation farmer in Karnataka or a daily-wage worker in Bihar has no idea how to file a consumer complaint, fight a property dispute, or challenge wrongful termination.

**PRAMAAN bridges this gap.**

---

## 🤖 What is PRAMAAN?

PRAMAAN is an **agentic AI legal assistant** that transforms a citizen's spoken or typed problem into a complete, court-ready legal case — automatically. It identifies applicable Indian laws, finds relevant Supreme Court precedents, drafts a formal complaint, and connects the user with a NALSA-empanelled lawyer — all for free.

---

## ✨ Key Features

| Feature | Description |
|---------|-------------|
| 🎤 **Voice Input** | Speak your problem in English — AI transcribes and processes |
| 💬 **Smart Chat** | Guided AI conversation extracts all legal facts automatically |
| 📷 **Camera Capture** | Capture documents live using phone camera |
| 🎙️ **Audio Evidence** | Record witness statements as audio evidence with live waveform |
| 📄 **OCR Processing** | Extracts text from uploaded PDFs and images using Tesseract.js |
| ⚖️ **Law Finder** | Finds real Indian law sections (IPC, CPC, Consumer Protection Act, etc.) |
| 💼 **Precedent Search** | Retrieves real Supreme Court and High Court judgments |
| 📋 **PDF Dossier** | Generates a formatted, court-ready legal complaint PDF |
| 👤 **Lawyer Connect** | Matches with NALSA-empanelled lawyers based on case type |
| 🌙 **Dark/Light Mode** | Clean UI that works on all devices |

---

## 🧠 Architecture — 8 Agentic AI Pipeline

PRAMAAN is not a single AI call. It is a chain of **8 specialized agents** that work together:

```
User Input
    │
    ▼
┌─────────────────┐
│  Agent 1        │  IntakeAgent — guided conversation, extracts 6 key facts
│  IntakeAgent    │  (caseType, incident, date, otherParty, documents, outcome)
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Agent 2        │  EvidenceAgent — OCR on uploaded files, Groq summary
│  EvidenceAgent  │  (Tesseract.js for images, pdf-parse for PDFs)
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Agent 3        │  CasePrepAgent — structures facts into legal profile
│  CasePrepAgent  │
└────────┬────────┘
         │
    ┌────┴────┐
    ▼         ▼
┌────────┐ ┌────────┐
│Agent 4 │ │Agent 5 │  Parallel execution for speed
│Section │ │Prece-  │
│Finder  │ │dent    │  SectionFinder → real Indian law sections
│        │ │Finder  │  PrecedentFinder → real SC/HC judgments
└────┬───┘ └───┬────┘
     └────┬────┘
          ▼
┌─────────────────┐
│  Agent 6        │  DraftAgent — generates formal legal complaint
│  DraftAgent     │  (Consumer Forum / Civil Court / Labour Court format)
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Agent 7        │  NoticeAgent — drafts legal notice to opposing party
│  NoticeAgent    │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Agent 8        │  LawyerMatchAgent — matches NALSA lawyer by case type
│  LawyerMatch    │
└─────────────────┘
```

---

## 🔧 Tech Stack

### Frontend
- **HTML / CSS / JavaScript** — no framework, works on any device
- **jsPDF** — client-side PDF generation with PRAMAAN branding
- **Tesseract.js** — local OCR for images (no API needed)
- **Web Speech API** — voice input with English support

### Backend
- **Next.js 16** (App Router) — TypeScript API routes
- **Groq** (`llama-3.3-70b-versatile`) — primary AI for chat, law search, case search, summarization, drafting
- **Groq Whisper** (`whisper-large-v3`) — audio transcription fallback
- **pdf-parse** — server-side PDF text extraction

### Database & Storage
- **Supabase (PostgreSQL)** — cases, messages, evidence, lawyers, users
- **Supabase Storage** — evidence files (PDFs, images, audio)
- **pgvector** — vector similarity search for RAG pipeline

### AI / RAG
- **Gemini text-embedding-004** — 768-dim embeddings for law/case knowledge base
- **RAG Pipeline** — embed → retrieve → rerank → generate
- **MCP (Model Context Protocol)** — `legal-kb-mcp.ts` provides 3 tools to agents:
  - `searchLaws(query, caseType)` — finds applicable Indian law sections
  - `searchCases(query, caseType)` — finds real court judgments
  - `searchLegalQuery(query)` — answers specific legal questions

---

## 📁 Project Structure

```
pramaan/
├── public/
│   ├── index.html          # Single-page frontend
│   ├── script.js           # All frontend logic (chat, voice, camera, upload)
│   ├── style.css           # Styling (dark/light theme)
│   └── hero-image.png      # Hero section image
│
├── app/
│   └── api/
│       ├── chat/route.ts           # Agent 1 — intake conversation
│       ├── upload-evidence/route.ts # Agent 2 — OCR + file upload
│       ├── generate-case/route.ts   # Agents 3-7 — analysis + drafting
│       ├── orchestrate/route.ts     # Master orchestrator
│       └── dashboard/route.ts       # User dashboard data
│
├── lib/
│   ├── ai/legal-agent.ts           # Core agent logic
│   ├── mcp/legal-kb-mcp.ts         # MCP tools (laws + cases via Groq)
│   └── rag/rag-pipeline.ts         # RAG — embed, retrieve, rerank, generate
│
├── schema_v3.sql           # Supabase database schema with pgvector
├── .env.local              # API keys (never commit this)
└── package.json
```

---

## 🚀 Getting Started

### Prerequisites
- Node.js 18+
- Supabase account
- Groq API key (free at [console.groq.com](https://console.groq.com))

### 1. Clone the repo
```bash
git clone https://github.com/YOUR_USERNAME/pramaan.git
cd pramaan
```

### 2. Install dependencies
```bash
npm install
npm install tesseract.js pdf-parse
npm install --save-dev @types/pdf-parse
```

### 3. Set up environment variables
Create `.env.local` in the root:
```env
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
GROQ_API_KEY=gsk_your_groq_key
GEMINI_API_KEY=AIza_your_gemini_key
```

### 4. Set up Supabase database
- Create a new Supabase project
- Run `schema_v3.sql` in the Supabase SQL editor
- Enable the `pgvector` extension in Supabase

### 5. Run the development server
```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000)

---

## 🌐 API Routes

| Route | Method | Description |
|-------|--------|-------------|
| `/api/chat` | POST | Intake conversation + voice transcription |
| `/api/upload-evidence` | POST | File upload + OCR + summarization |
| `/api/generate-case` | POST | Full case analysis (laws + cases + strategy) |
| `/api/orchestrate` | POST | Master agent orchestrator |
| `/api/dashboard` | GET | User's cases, lawyers, notifications |

---

## 🔑 Why Groq?

PRAMAAN uses **Groq** as its primary AI provider because:
- **Speed** — fastest token generation available (crucial for real-time chat)
- **Free tier** — 14,400 requests/day, sufficient for demos and early users
- **Quality** — `llama-3.3-70b` has strong knowledge of Indian law
- **Reliability** — no rate limit issues during live hackathon demos

---

## 🏗️ Why This is Agentic AI

PRAMAAN qualifies as agentic AI because:
- **Autonomous decision-making** — agents decide what to ask, which laws apply, which cases match
- **Multi-step planning** — orchestrator chains 8 agents, each building on previous output
- **Tool use via MCP** — agents call external tools to fetch real legal data
- **Parallel execution** — SectionFinder and PrecedentFinder run simultaneously
- **Fallback handling** — automatic fallbacks if any component fails
- **Goal-directed** — entire system works toward one goal: a court-ready legal dossier

---

## 📸 Screenshots

> Add screenshots of your app here

---

## 🤝 Contributing

1. Fork the repo
2. Create a feature branch: `git checkout -b feature/your-feature`
3. Commit your changes: `git commit -m 'feat: add your feature'`
4. Push to the branch: `git push origin feature/your-feature`
5. Open a Pull Request to `dev`

---

## 📄 License

MIT License — free to use, modify, and distribute.

---

## 🙏 Acknowledgements

- [Groq](https://groq.com) — blazing fast LLM inference
- [Supabase](https://supabase.com) — open source Firebase alternative
- [Indian Kanoon](https://indiankanoon.org) — Indian legal database
- [NALSA](https://nalsa.gov.in) — National Legal Services Authority
- [Tesseract.js](https://tesseract.projectnaptha.com) — open source OCR

---

<div align="center">
  <strong>Built for India. Built for justice. Built for everyone.</strong><br/>
  <em>PRAMAAN — because justice should never be a privilege.</em>
</div>
