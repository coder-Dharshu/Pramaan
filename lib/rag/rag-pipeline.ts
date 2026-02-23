import {
  GoogleGenerativeAI,
  HarmCategory,
  HarmBlockThreshold,
} from "@google/generative-ai";
import { createClient } from "@supabase/supabase-js";
import Groq from "groq-sdk";

const genAI    = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY! });

// ── Types
export interface RAGChunk {
  id:         string;
  content:    string;
  metadata:   Record<string, unknown>;
  similarity: number;
}

export interface RAGResult {
  chunks:  RAGChunk[];
  answer:  string;
  source:  "pgvector" | "gemini_search";
}

// ================================================================
//  STEP 1  EMBED — Gemini text-embedding-004
//  Free tier · 768 dimensions · multilingual
// ================================================================
export async function embedText(text: string): Promise<number[]> {
  const model  = genAI.getGenerativeModel({ model: "text-embedding-004" });
  const result = await model.embedContent(text.slice(0, 2000));
  return result.embedding.values;
}

// ================================================================
//  STEP 2  RETRIEVE — pgvector ANN cosine search
//  Calls match_documents() RPC defined in schema_v3.sql
// ================================================================
async function pgvectorSearch(
  embedding: number[],
  table:     "law_sections" | "court_cases",
  topK:      number,
  threshold: number,
  caseType?: string
): Promise<RAGChunk[]> {
  const { data, error } = await supabase.rpc("match_documents", {
    query_embedding:  embedding,
    match_table:      table,
    match_threshold:  threshold,
    match_count:      topK,
    filter_case_type: caseType ?? null,
  });

  if (error) {
    console.error(`[RAG retrieve] ${table}:`, error.message);
    return [];
  }

  return ((data ?? []) as Array<{
    id: string; content: string;
    metadata: Record<string, unknown>; similarity: number;
  }>).map(r => ({
    id:         r.id,
    content:    r.content,
    metadata:   r.metadata ?? {},
    similarity: r.similarity,
  }));
}

// ================================================================
//  STEP 3  RERANK — Groq LLM cross-encoder
//  Scores each chunk 0-10, blends with cosine score
// ================================================================
async function rerankChunks(
  query:  string,
  chunks: RAGChunk[],
  topK:   number
): Promise<RAGChunk[]> {
  if (chunks.length <= topK) return chunks;

  try {
    const res = await groq.chat.completions.create({
      model:    "llama-3.3-70b-versatile",
      messages: [{
        role:    "user",
        content: `You are a legal relevance judge for Indian law.
Score each document 0-10 for relevance to this query.
Reply ONLY as a JSON array of integers, nothing else.

Query: "${query.slice(0, 180)}"

Documents:
${chunks.map((c, i) => `[${i}]: ${c.content.slice(0, 160)}`).join("\n")}`,
      }],
      max_tokens: 80, temperature: 0,
    });

    const raw    = res.choices[0]?.message?.content ?? "[]";
    const match  = raw.match(/\[[\d,\s]+\]/);
    const scores = match ? (JSON.parse(match[0]) as number[]) : [];

    return chunks
      .map((c, i) => ({
        ...c,
        similarity: c.similarity * 0.55 + ((scores[i] ?? 5) / 10) * 0.45,
      }))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, topK);
  } catch {
    return chunks.slice(0, topK);
  }
}

// ================================================================
//  STEP 4+5  AUGMENT + GENERATE — Groq grounded generation
// ================================================================
async function generateGrounded(
  systemPrompt: string,
  query:        string,
  chunks:       RAGChunk[],
  maxTokens:    number
): Promise<string> {
  const context = chunks
    .map((c, i) =>
      `[Source ${i + 1}]\n` +
      `Info: ${JSON.stringify(c.metadata)}\n` +
      `Relevance: ${(c.similarity * 100).toFixed(0)}%\n` +
      `Text: ${c.content}`
    )
    .join("\n\n---\n\n");

  const res = await groq.chat.completions.create({
    model:    "llama-3.3-70b-versatile",
    messages: [{
      role:    "user",
      content: `${systemPrompt}

══ RETRIEVED KNOWLEDGE BASE ══
${context}
═════════════════════════════

Query: ${query}`,
    }],
    max_tokens: maxTokens, temperature: 0.15,
  });

  return res.choices[0]?.message?.content ?? "";
}

// ================================================================
//  FULL PIPELINE  embed → retrieve → rerank → generate
// ================================================================
export async function runRAG(opts: {
  query:        string;
  table:        "law_sections" | "court_cases";
  systemPrompt: string;
  caseType?:    string;
  topK?:        number;
  maxTokens?:   number;
}): Promise<RAGResult> {
  const { query, table, systemPrompt, caseType, topK = 5, maxTokens = 900 } = opts;
  console.log(`[RAG] table=${table}  q="${query.slice(0, 55)}…"`);

  // 1. Embed query
  const embedding = await embedText(query);

  // 2. Retrieve: fetch 2× candidates to give reranker options
  const candidates = await pgvectorSearch(embedding, table, topK * 2, 0.48, caseType);

  // Fallback: index empty → use Gemini live search
  if (candidates.length === 0) {
    console.warn(`[RAG] ${table} has 0 results — Gemini Search fallback`);
    const answer = await geminiLiveSearch(query, table);
    return { chunks: [], answer, source: "gemini_search" };
  }

  // 3. Rerank
  const chunks = await rerankChunks(query, candidates, topK);

  // 4+5. Generate grounded answer
  const answer = await generateGrounded(systemPrompt, query, chunks, maxTokens);

  return { chunks, answer, source: "pgvector" };
}

// ================================================================
//  FALLBACK — Gemini 1.5 Flash + Google Search grounding
//  Activates when pgvector index hasn't been seeded yet.
//  Returns the same JSON format as the seeded data.
// ================================================================
async function geminiLiveSearch(
  query: string,
  table: "law_sections" | "court_cases"
): Promise<string> {
  try {
    const model = genAI.getGenerativeModel(
      {
        model: "gemini-1.5-flash",
        tools: [{ googleSearch: {} }],
        safetySettings: [
          { category: HarmCategory.HARM_CATEGORY_HARASSMENT,        threshold: HarmBlockThreshold.BLOCK_NONE },
          { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
        ],
      },
      { apiVersion: "v1beta" }
    );

    const prompt = table === "law_sections"
      ? `Find real Indian law sections for: "${query}".
         Search indiankanoon.org and indiacode.nic.in.
         Return ONLY a JSON array, no other text:
         [{"section":"Section 138","act":"Negotiable Instruments Act 1881","description":"...","source_url":"https://indiankanoon.org/..."}]`
      : `Find real Indian Supreme Court and High Court judgments for: "${query}".
         Search indiankanoon.org.
         Return ONLY a JSON array, no other text:
         [{"title":"Case Name vs Other","citation":"(2022) 3 SCC 456","court":"Supreme Court of India","year":2022,"outcome":"...","summary":"...","source_url":"https://indiankanoon.org/..."}]`;

    const result = await model.generateContent(prompt);
    return result.response.text();
  } catch (err) {
    console.error("[RAG gemini fallback]", err);
    return "[]";
  }
}

// ================================================================
//  SEED HELPERS  — called by scripts/seed-rag.ts
// ================================================================
export async function upsertLawSection(row: {
  section:    string;
  act:        string;
  description: string;
  full_text?: string;
  case_types: string[];
  source_url?: string;
}): Promise<void> {
  const content   = `${row.section} — ${row.act}\n${row.description}${row.full_text ? "\n\n" + row.full_text.slice(0, 600) : ""}`;
  const embedding = await embedText(content);
  const { error } = await supabase
    .from("law_sections")
    .upsert({ ...row, content, embedding }, { onConflict: "section,act" });
  if (error) console.error("[seed law]", row.section, error.message);
}

export async function upsertCourtCase(row: {
  title:       string;
  citation?:   string;
  year:        number;
  court:       string;
  case_type:   string;
  outcome:     string;
  summary:     string;
  source_url?: string;
}): Promise<void> {
  const content   = `${row.title} ${row.citation ?? ""} (${row.court}, ${row.year})\nOutcome: ${row.outcome}\n${row.summary}`;
  const embedding = await embedText(content);
  const { error } = await supabase
    .from("court_cases")
    .upsert({ ...row, content, embedding }, { onConflict: "title,citation" });
  if (error) console.error("[seed case]", row.title, error.message);
}
