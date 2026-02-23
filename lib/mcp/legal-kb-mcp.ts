import Groq from "groq-sdk";

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY ?? "" });

// ── Types ─────────────────────────────────────────────────────
export interface LawSection {
  section:     string;
  act:         string;
  description: string;
  source_url:  string;
}

export interface CourtCase {
  title:      string;
  year:       number;
  court:      string;
  outcome:    string;
  relevance:  number;
  citation:   string;
  source_url: string;
  summary:    string;
}

// ── Parse JSON safely ─────────────────────────────────────────
function parseJSON<T>(text: string, fallback: T): T {
  try {
    const clean = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    const match = clean.match(/\[[\s\S]*\]/);
    return match ? JSON.parse(match[0]) : fallback;
  } catch {
    return fallback;
  }
}

// ══════════════════════════════════════════════════════════════
// TOOL 1 — searchLaws
// ══════════════════════════════════════════════════════════════
export async function searchLaws(
  query:      string,
  caseType:   string,
  maxResults: number = 5
): Promise<LawSection[]> {
  console.log(`[MCP searchLaws] "${query}"`);

  try {
    const res = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [{
        role: "user",
        content: `You are an Indian legal expert with deep knowledge of Indian statutes and constitutional law.

List the ${maxResults} most relevant Indian law sections for this legal situation.

Legal Issue: "${query}"
Case Type: ${caseType}

Return ONLY a valid JSON array, no explanation, no markdown fences:
[
  {
    "section": "Section 14",
    "act": "Consumer Protection Act 2019",
    "description": "Exact one-sentence description of what this section says",
    "source_url": "https://indiankanoon.org/search/?formInput=${encodeURIComponent(caseType)}"
  }
]

Requirements:
- Use REAL section numbers from REAL Indian Acts (IPC, CPC, Constitution, Consumer Protection Act, Transfer of Property Act, etc.)
- Every section must be genuinely applicable to "${caseType}" cases
- Include at least one Constitutional provision if fundamental rights are involved
- Return exactly ${maxResults} distinct sections`,
      }],
      max_tokens:  900,
      temperature: 0.1,
    });

    const text = res.choices[0]?.message?.content ?? "[]";
    return parseJSON<LawSection[]>(text, []);
  } catch (err) {
    console.error("[MCP searchLaws] error:", err);
    return [];
  }
}

// ══════════════════════════════════════════════════════════════
// TOOL 2 — searchCases
// ══════════════════════════════════════════════════════════════
export async function searchCases(
  query:      string,
  caseType:   string,
  maxResults: number = 5
): Promise<CourtCase[]> {
  console.log(`[MCP searchCases] "${query}"`);

  try {
    const res = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [{
        role: "user",
        content: `You are an Indian legal expert with knowledge of Supreme Court and High Court judgments.

List ${maxResults} real landmark Indian court cases relevant to this situation.

Situation: "${query}"
Case Type: ${caseType}

Return ONLY a valid JSON array, no explanation, no markdown fences:
[
  {
    "title": "Lucknow Development Authority vs M.K. Gupta",
    "year": 1994,
    "court": "Supreme Court of India",
    "outcome": "Plaintiff won — housing authority held liable for deficient service",
    "relevance": 95,
    "citation": "(1994) 1 SCC 243",
    "source_url": "https://indiankanoon.org/search/?formInput=${encodeURIComponent(caseType)}+Supreme+Court",
    "summary": "The Supreme Court held that housing boards and development authorities are 'service providers' under consumer law and can be sued for deficiency. This established the right of citizens to claim compensation from government housing bodies."
  }
]

Requirements:
- Only include REAL cases that genuinely exist in Indian legal records
- Prioritise Supreme Court landmark judgments, then High Courts
- All cases must be directly relevant to "${caseType}" situations
- Include correct SCC/AIR citations
- Summary must explain WHY the case is relevant to the user's situation
- Return exactly ${maxResults} cases`,
      }],
      max_tokens:  1000,
      temperature: 0.1,
    });

    const text = res.choices[0]?.message?.content ?? "[]";
    return parseJSON<CourtCase[]>(text, []);
  } catch (err) {
    console.error("[MCP searchCases] error:", err);
    return [];
  }
}

// ══════════════════════════════════════════════════════════════
// TOOL 3 — searchLegalQuery (general purpose)
// ══════════════════════════════════════════════════════════════
export async function searchLegalQuery(query: string): Promise<string> {
  console.log(`[MCP searchLegalQuery] "${query}"`);

  try {
    const res = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [{
        role: "user",
        content: `Answer this Indian legal question concisely with real law sections and case citations:

Question: "${query}"

Provide:
1. Relevant law sections with real section numbers
2. 1-2 landmark Supreme Court cases on this point
3. Practical steps a citizen can take

Keep under 200 words. Be specific and factual.`,
      }],
      max_tokens:  400,
      temperature: 0.2,
    });

    return res.choices[0]?.message?.content ?? "Could not fetch legal information.";
  } catch (err) {
    console.error("[MCP searchLegalQuery] error:", err);
    return "Could not fetch legal information. Please try again.";
  }
}

// ══════════════════════════════════════════════════════════════
// SMART WRAPPERS — parallel searches for maximum coverage
// Called by legal-agent.ts → analyzeCase()
// ══════════════════════════════════════════════════════════════
export async function getLawsByType(
  caseType:    string,
  userSummary: string = ""
): Promise<LawSection[]> {
  const query = userSummary
    ? `${userSummary} ${caseType} India`
    : `${caseType} rights remedies India constitutional statutory`;

  const [broad, specific] = await Promise.all([
    searchLaws(`${caseType} fundamental rights Constitution India`, caseType, 3),
    searchLaws(query, caseType, 3),
  ]);

  // Merge and deduplicate by section name
  const seen = new Set<string>();
  const all: LawSection[] = [];
  for (const l of [...broad, ...specific]) {
    const key = l.section.toLowerCase();
    if (!seen.has(key)) { seen.add(key); all.push(l); }
  }

  return all.slice(0, 6);
}

export async function getSimilarCases(
  caseType:    string,
  userSummary: string = ""
): Promise<CourtCase[]> {
  const broadQuery    = `${caseType} Supreme Court landmark judgment India`;
  const specificQuery = userSummary
    ? `${userSummary} India court judgment`
    : `${caseType} High Court India recent judgment`;

  const [sc, specific] = await Promise.all([
    searchCases(broadQuery,    caseType, 3),
    searchCases(specificQuery, caseType, 3),
  ]);

  // Merge, deduplicate by title
  const seen = new Set<string>();
  const all: CourtCase[] = [];
  for (const c of [...sc, ...specific]) {
    const key = c.title.toLowerCase().slice(0, 40);
    if (!seen.has(key)) { seen.add(key); all.push(c); }
  }

  return all.slice(0, 5);
}