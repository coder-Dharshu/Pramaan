//  Agent pipeline:
//
//  [A1] IntakeAgent ─────────── chat/voice → fills case profile slots
//         │ (profile complete → auto-chain)
//         ▼
//  [A3] CasePrepAgent ────────── key facts + strength score
//         ▼
//  [A4] SectionFinderAgent ───── RAG → pgvector law_sections
//         ▼
//  [A5] PrecedentAgent ───────── RAG → pgvector court_cases
//
//  [A2] FileUploadAgent ──────── OCR + embed → re-runs A3→A4→A5
//
//  [A6] PDFGeneratorAgent ────── formal legal complaint document
//         ▼ (auto-chains)
//  [A7] CommunicationAgent ───── pre-litigation notices/letters
//
//  [A8] LawyerConnectorAgent ─── score-match + assign + briefing
//
// ================================================================

import { createClient }       from "@supabase/supabase-js";
import Groq                   from "groq-sdk";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { runRAG, embedText }  from "./rag/pipeline";
import type { RAGChunk }      from "./rag/pipeline";

const sb   = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY! });
const gem  = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);

// ================================================================
//  SHARED TYPES
// ================================================================
export interface CaseContext {
  caseId:   string;
  userId:   string;
  language: string;                   // en | hi | ta | te | kn | bn | mr

  // Agent 1 ── Intake
  caseType:       string | null;
  incident:       string | null;
  incidentDate:   string | null;
  otherParty:     string | null;
  location:       string | null;
  documentsDesc:  string | null;
  desiredOutcome: string | null;
  readyToFile:    boolean;

  // Agent 2 ── Evidence
  evidenceIds:     string[];
  evidenceSummary: string;

  // Agent 3 ── Case Prep
  keyFacts:           string[];
  strengthPercentage: number;
  strategy:           string;

  // Agent 4 ── Section Finder (RAG)
  applicableLaws: LawSection[];

  // Agent 5 ── Precedent Finder (RAG)
  similarCases: CourtCase[];

  // Agent 6 ── PDF Generator
  draftDocument: string;

  // Agent 7 ── Communication
  noticesDrafted: Notice[];

  // Agent 8 ── Lawyer Connector
  lawyerAssigned: string | null;
  lawyerName:     string | null;

  // Pipeline
  stage:           string;
  completedAgents: string[];
  agentOutputs:    Record<string, unknown>;
}

export interface LawSection  { section: string; act: string; description: string; sourceUrl: string; relevanceScore: number; }
export interface CourtCase   { title: string; citation: string; year: number; court: string; outcome: string; summary: string; sourceUrl: string; relevanceScore: number; }
export interface Notice      { type: string; subject: string; body: string; recipient: string; }
export interface AgentResult { success: boolean; agentName: string; context: CaseContext; output: Record<string, unknown>; error?: string; }

// ================================================================
//  AGENT 1  —  IntakeAgent
//  Slot-filling intake for chat and voice messages.
//  Reads the FULL conversation, extracts structured profile.
//  Never repeats a question already answered.
//  Builds a state-aware response that asks only the next gap.
// ================================================================
export class IntakeAgent {
  readonly name = "IntakeAgent";

  async run(messages: Array<{ role: string; content: string }>, ctx: CaseContext): Promise<AgentResult> {
    // ── Extract profile from full conversation ─────────────
    const profile = await this.extractProfile(messages);

    const updated: CaseContext = {
      ...ctx,
      caseType:       profile.caseType       ?? ctx.caseType,
      incident:       profile.incident       ?? ctx.incident,
      incidentDate:   profile.incidentDate   ?? ctx.incidentDate,
      otherParty:     profile.otherParty     ?? ctx.otherParty,
      location:       profile.location       ?? ctx.location,
      documentsDesc:  profile.documentsDesc  ?? ctx.documentsDesc,
      desiredOutcome: profile.desiredOutcome ?? ctx.desiredOutcome,
      language:       profile.language       || ctx.language,
      readyToFile:    profile.readyToFile,
      completedAgents: [...new Set([...ctx.completedAgents, "intake"])],
    };

    const response = await this.buildResponse(messages, updated);
    return { success: true, agentName: this.name, context: updated, output: { response, profile } };
  }

  private async extractProfile(msgs: Array<{ role: string; content: string }>) {
    if (!msgs.length) return EMPTY_PROFILE();
    const convo = msgs.map(m => `${m.role}: ${m.content}`).join("\n");

    const res = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [{
        role: "user", content:
`Extract structured case info from this Indian legal conversation.
INTERPRET PLAIN LANGUAGE — examples:
"relative took my land/property" → caseType:Property, otherParty:relative
"company fired me / sacked without notice" → Employment
"builder not giving flat / cheating" → Consumer
"wife left with kids / husband beating" → Family
"police filed false case / police harassment" → Criminal
"shopkeeper sold fake / broken item" → Consumer
"government office not replying" → RTI
"cheque bounced" → Cheque
"husband/wife domestic violence" → Domestic

Conversation:
${convo}

Reply ONLY as valid JSON (null for unknown fields):
{"caseType":"Property|Consumer|Employment|Family|Criminal|RTI|Cheque|Domestic|Other|null",
 "incident":"what happened|null","incidentDate":"date or period|null",
 "otherParty":"who did it|null","location":"city/district/state|null",
 "documentsDesc":"documents user has|null","desiredOutcome":"what they want|null",
 "language":"en|hi|ta|te|kn|bn|mr|gu|pa","readyToFile":false}
Set readyToFile:true ONLY when caseType+incident+otherParty+desiredOutcome are ALL non-null.`
      }],
      max_tokens: 400, temperature: 0,
    });

    try {
      const txt = res.choices[0]?.message?.content ?? "{}";
      const m   = txt.match(/\{[\s\S]*\}/);
      return m ? { ...EMPTY_PROFILE(), ...JSON.parse(m[0]) } : EMPTY_PROFILE();
    } catch { return EMPTY_PROFILE(); }
  }

  private async buildResponse(msgs: Array<{ role: string; content: string }>, ctx: CaseContext): Promise<string> {
    const SLOTS = ["caseType","incident","incidentDate","otherParty","documentsDesc","desiredOutcome"] as const;
    const missing = SLOTS.filter(s => !ctx[s]);
    const filled  = SLOTS.length - missing.length;

    const ASKS: Record<string, string> = {
      caseType:      "Ask what KIND of legal problem: property/land, consumer (product/service), job issue, family/divorce, police/criminal, RTI (government not replying), cheque bounced — with examples.",
      incident:      "Ask them to describe in their OWN WORDS what happened. No legal terms needed.",
      incidentDate:  "Ask WHEN this happened. Approximate is fine — last year, month/year.",
      otherParty:    "Ask WHO did this — name, company, or relationship (uncle/boss/builder/landlord).",
      documentsDesc: "Ask what DOCUMENTS or PROOF they have — deeds, receipts, WhatsApp screenshots, photos, salary slips etc.",
      desiredOutcome:"Ask what OUTCOME they want — money back, get property, job back, maintenance, punish the person?",
    };

    const known = [
      ctx.caseType     && `Case: ${ctx.caseType}`,
      ctx.incident     && `Issue: ${ctx.incident.slice(0,50)}`,
      ctx.otherParty   && `Against: ${ctx.otherParty}`,
      ctx.incidentDate && `When: ${ctx.incidentDate}`,
      ctx.location     && `Where: ${ctx.location}`,
    ].filter(Boolean).join(" | ");

    const system = ctx.readyToFile
      ? `You are PRAMAAN, a warm Indian legal AI.
ALL INFORMATION COLLECTED (${filled}/${SLOTS.length} fields).
Known: ${known}
1. Say warmly that you have everything needed.
2. Summarise their case in 2 clear sentences.
3. Name ONE relevant Indian law (e.g. Consumer Protection Act 2019).
4. Tell them to click "Next: Upload Evidence" to continue.
Be encouraging. Under 130 words. Respond in the user's language.`
      : `You are PRAMAAN, a warm patient Indian legal AI assistant.
WHAT YOU KNOW (${filled}/${SLOTS.length}): ${known || "nothing yet"}
NEXT: ${missing[0] ? ASKS[missing[0]] : "wrap up"}
RULES:
1. Acknowledge user's last message in ONE sentence.
2. Ask ONLY the next missing field — one question only.
3. NEVER ask about info already in "WHAT YOU KNOW" above.
4. Use simple everyday words, zero legal jargon.
5. If user answered multiple fields at once, skip to the first still-unknown one.
6. Under 90 words. Reply in the SAME LANGUAGE as the user.`;

    const res = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
        { role: "system", content: system },
        ...msgs.slice(-8).map(m => ({ role: (m.role === "user" ? "user" : "assistant") as "user"|"assistant", content: m.content })),
      ],
      max_tokens: 280, temperature: 0.6,
    });
    return res.choices[0]?.message?.content ?? "Please describe your legal problem.";
  }
}

// ================================================================
//  AGENT 2  —  FileUploadAgent
//  OCR (Gemini Vision for images/PDFs, Whisper for audio),
//  generates pgvector embedding, updates evidence row in Supabase.
// ================================================================
export class FileUploadAgent {
  readonly name = "FileUploadAgent";

  async run(
    payload: { fileBuffer: Buffer; fileName: string; mimeType: string; evidenceId: string },
    ctx:     CaseContext
  ): Promise<AgentResult> {
    let ocrText = "";
    let summary = "";

    if (payload.mimeType.startsWith("image/") || payload.mimeType === "application/pdf") {
      ocrText = await this.ocr(payload.fileBuffer, payload.mimeType);
      if (ocrText) summary = await this.summarise(ocrText, payload.fileName, ctx);
    } else if (payload.mimeType.startsWith("audio/")) {
      ocrText = await this.transcribe(payload.fileBuffer, payload.fileName, payload.mimeType);
      summary = ocrText.slice(0, 300);
    }

    if (ocrText) {
      const embedding = await embedText(`${payload.fileName}: ${ocrText.slice(0, 1200)}`);
      await sb.from("evidence").update({ ocr_text: ocrText, summary, embedding, status: "processed" }).eq("id", payload.evidenceId);
    }

    return {
      success: true, agentName: this.name,
      context: {
        ...ctx,
        evidenceIds:     [...new Set([...ctx.evidenceIds, payload.evidenceId])],
        evidenceSummary: ctx.evidenceSummary
          ? `${ctx.evidenceSummary}\n• ${payload.fileName}: ${summary || "uploaded"}`
          : `• ${payload.fileName}: ${summary || "uploaded"}`,
        completedAgents: [...new Set([...ctx.completedAgents, "fileUpload"])],
      },
      output: { ocrText: ocrText.slice(0, 300), summary },
    };
  }

  private async ocr(buffer: Buffer, mimeType: string): Promise<string> {
    try {
      const model  = gem.getGenerativeModel({ model: "gemini-1.5-flash" });
      const result = await model.generateContent([
        { inlineData: { mimeType, data: buffer.toString("base64") } },
        "Extract ALL text from this document. Return only the raw text, no commentary.",
      ]);
      return result.response.text().trim();
    } catch { return ""; }
  }

  private async transcribe(buffer: Buffer, fileName: string, mimeType: string): Promise<string> {
    try {
      const file = new File([buffer], fileName, { type: mimeType });
      const tx   = await groq.audio.transcriptions.create({ file, model: "whisper-large-v3", response_format: "json" });
      return tx.text.trim();
    } catch { return ""; }
  }

  private async summarise(text: string, fileName: string, ctx: CaseContext): Promise<string> {
    const res = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [{ role: "user", content: `Summarise in 2 sentences what this legal evidence document proves, for a ${ctx.caseType ?? "legal"} case.\nFile: ${fileName}\nText: ${text.slice(0, 800)}` }],
      max_tokens: 120, temperature: 0.2,
    });
    return res.choices[0]?.message?.content?.trim() ?? "";
  }
}

// ================================================================
//  AGENT 3  —  CasePrepAgent
//  Builds structured key facts, strength score (0-100), strategy.
//  Uses the full CaseContext: profile + evidence + laws + cases.
// ================================================================
export class CasePrepAgent {
  readonly name = "CasePrepAgent";

  async run(ctx: CaseContext): Promise<AgentResult> {
    const res = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [{
        role: "user", content:
`You are a senior Indian advocate preparing a case brief. Analyse and reply ONLY as valid JSON.

CASE:
  Type:          ${ctx.caseType}
  Incident:      ${ctx.incident}
  Date:          ${ctx.incidentDate ?? "not specified"}
  Against:       ${ctx.otherParty}
  Location:      ${ctx.location ?? "not specified"}
  Desired:       ${ctx.desiredOutcome}
  Evidence:      ${ctx.evidenceSummary || "none yet"}
  Laws (RAG):    ${ctx.applicableLaws.map(l => l.section + ", " + l.act).join(" | ") || "pending"}
  Precedents:    ${ctx.similarCases.map(c => c.title).join(" | ") || "pending"}

{"keyFacts":["Fact 1 — specific and provable","Fact 2","Fact 3","Fact 4"],
 "strengthPercentage":72,
 "strategy":"3-4 sentence actionable legal strategy citing specific sections and precedents."}

Strength: 80-100 strong, 60-79 moderate, 40-59 challenging, <40 weak.`
      }],
      max_tokens: 600, temperature: 0.15,
    });

    let out = { keyFacts: [] as string[], strengthPercentage: 60, strategy: "" };
    try {
      const m = (res.choices[0]?.message?.content ?? "{}").match(/\{[\s\S]*\}/);
      if (m) out = { ...out, ...JSON.parse(m[0]) };
    } catch { /* keep defaults */ }

    return {
      success: true, agentName: this.name,
      context: { ...ctx, ...out, completedAgents: [...new Set([...ctx.completedAgents, "casePrep"])], agentOutputs: { ...ctx.agentOutputs, casePrep: out } },
      output: out,
    };
  }
}

// ================================================================
//  AGENT 4  —  SectionFinderAgent
//  RAG: embeds case query → pgvector search in law_sections
//  → LLM rerank → LLM synthesis of applicable Indian law sections
//  Auto-fallback to Gemini live search if index empty
// ================================================================
export class SectionFinderAgent {
  readonly name = "SectionFinderAgent";

  async run(ctx: CaseContext): Promise<AgentResult> {
    const query = [ctx.incident, ctx.desiredOutcome, `${ctx.caseType} law India`, ctx.otherParty && `against ${ctx.otherParty}`].filter(Boolean).join(". ");

    const { chunks, answer, source } = await runRAG({
      query, table: "law_sections", caseType: ctx.caseType ?? undefined,
      systemPrompt: `You are an expert Indian statutory law researcher. List the most relevant law sections for this ${ctx.caseType} case from the retrieved sources. For each: section number, act, description, why it applies. Be precise.`,
      topK: 6, maxTokens: 900,
    });

    const laws: LawSection[] = chunks.length > 0
      ? chunks.map((c: RAGChunk) => ({
          section:       String(c.metadata.section ?? ""),
          act:           String(c.metadata.act ?? ""),
          description:   c.content.split("\n")[1]?.slice(0, 220) ?? c.content.slice(0, 220),
          sourceUrl:     String(c.metadata.source_url ?? "https://indiankanoon.org"),
          relevanceScore: Math.round(c.similarity * 100),
        }))
      : parseLawsJSON(answer);

    return {
      success: true, agentName: this.name,
      context: { ...ctx, applicableLaws: laws, completedAgents: [...new Set([...ctx.completedAgents, "sectionFinder"])], agentOutputs: { ...ctx.agentOutputs, sectionFinder: { count: laws.length, source } } },
      output: { laws, source, answer },
    };
  }
}

// ================================================================
//  AGENT 5  —  PrecedentAgent
//  RAG: embeds case query → pgvector search in court_cases
//  → LLM rerank → synthesis of similar Indian court judgments
//  Prioritises Supreme Court > High Court > Tribunal
// ================================================================
export class PrecedentAgent {
  readonly name = "PrecedentAgent";

  async run(ctx: CaseContext): Promise<AgentResult> {
    const query = [ctx.incident, ctx.caseType, ctx.desiredOutcome, ctx.otherParty && `party: ${ctx.otherParty}`].filter(Boolean).join(". ");

    const { chunks, answer, source } = await runRAG({
      query, table: "court_cases", caseType: ctx.caseType ?? undefined,
      systemPrompt: `You are an expert Indian case law researcher. Identify the most relevant court precedents for this ${ctx.caseType} case. For each: case name + citation, court, year, what was decided, and how it applies. Prioritise Supreme Court rulings.`,
      topK: 5, maxTokens: 900,
    });

    const cases: CourtCase[] = chunks.length > 0
      ? chunks.map((c: RAGChunk) => ({
          title:         String(c.metadata.title ?? "Unknown"),
          citation:      String(c.metadata.citation ?? ""),
          year:          Number(c.metadata.year ?? 0),
          court:         String(c.metadata.court ?? "Indian Court"),
          outcome:       "See full judgment",
          summary:       c.content.slice(0, 260),
          sourceUrl:     String(c.metadata.source_url ?? "https://indiankanoon.org"),
          relevanceScore: Math.round(c.similarity * 100),
        }))
      : parseCasesJSON(answer);

    return {
      success: true, agentName: this.name,
      context: { ...ctx, similarCases: cases, completedAgents: [...new Set([...ctx.completedAgents, "precedent"])], agentOutputs: { ...ctx.agentOutputs, precedent: { count: cases.length, source } } },
      output: { cases, source, answer },
    };
  }
}

// ================================================================
//  AGENT 6  —  PDFGeneratorAgent
//  Generates a complete formal Indian legal complaint document.
//  Integrates ALL prior agent outputs: profile + key facts +
//  laws (A4) + cases (A5) + evidence summaries (A2).
//  Output is court-ready for the correct filing forum.
// ================================================================
export class PDFGeneratorAgent {
  readonly name = "PDFGeneratorAgent";

  async run(ctx: CaseContext): Promise<AgentResult> {
    const forum   = FILING_FORUM[ctx.caseType ?? ""] ?? "District Court";
    const caseRef = `CC/${new Date().getFullYear()}/${String(Math.floor(Math.random()*9000)+1000)}`;

    const res = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [{
        role: "user", content:
`Draft a complete formal Indian legal complaint for court submission.

CASE REF:      ${caseRef}
FORUM:         ${forum}
DATE:          ${new Date().toLocaleDateString("en-IN", { dateStyle: "long" })}

COMPLAINANT:   [COMPLAINANT FULL NAME], S/O or D/O [PARENT NAME]
               [FULL ADDRESS: Village/Street, District, State, PIN]
               Phone: [PHONE]

RESPONDENT:    ${ctx.otherParty ?? "[RESPONDENT FULL NAME AND ADDRESS]"}

CASE TYPE:     ${ctx.caseType}
INCIDENT:      ${ctx.incident}
DATE:          ${ctx.incidentDate ?? "[DATE OF INCIDENT]"}
LOCATION:      ${ctx.location ?? "[LOCATION]"}
RELIEF SOUGHT: ${ctx.desiredOutcome}

KEY FACTS:
${ctx.keyFacts.map((f,i)=>`${i+1}. ${f}`).join("\n") || "[Facts to be detailed in body]"}

EVIDENCE:
${ctx.evidenceSummary || "Documents to be produced at hearing"}

APPLICABLE LAWS:
${ctx.applicableLaws.map(l=>`• ${l.section}, ${l.act} — ${l.description}`).join("\n") || "[Laws pending]"}

PRECEDENTS:
${ctx.similarCases.slice(0,3).map(c=>`• ${c.title} ${c.citation} (${c.court}, ${c.year})`).join("\n") || "[Cases pending]"}

STRATEGY: ${ctx.strategy}

Write the complete complaint with ALL sections:
1. HEADING — court/forum name, case number, full party names
2. JURISDICTION — cite statute giving this court jurisdiction
3. FACTS — numbered paragraphs, chronological, specific dates/amounts
4. LEGAL GROUNDS — each law section cited with full act + why it applies
5. PRECEDENTS — cite each supporting judgment briefly
6. PRAYER — numbered specific reliefs exactly as desired
7. VERIFICATION — "I, [Name], do hereby solemnly affirm and declare that the contents of this complaint are true and correct to the best of my knowledge and belief and nothing material has been concealed."
8. SIGNATURE BLOCK — date, place, complainant, advocate

Use [PLACEHOLDER] for all personal details. Professional Indian legal English.`
      }],
      max_tokens: 2800, temperature: 0.05,
    });

    const draft = res.choices[0]?.message?.content ?? "Draft could not be generated.";
    await sb.from("cases").update({ draft_document: draft, status: "document_ready" }).eq("id", ctx.caseId);

    return {
      success: true, agentName: this.name,
      context: { ...ctx, draftDocument: draft, stage: "document_ready", completedAgents: [...new Set([...ctx.completedAgents, "pdfGenerator"])] },
      output: { draft },
    };
  }
}

// ================================================================
//  AGENT 7  —  CommunicationAgent
//  Drafts pre-litigation legal notices and demand letters.
//  Sent BEFORE going to court — often settles disputes faster.
//  Generates 1-2 notices appropriate to the case type.
// ================================================================
export class CommunicationAgent {
  readonly name = "CommunicationAgent";

  async run(ctx: CaseContext): Promise<AgentResult> {
    const noticeTypes = NOTICE_TYPES[ctx.caseType ?? ""] ?? ["Legal Notice"];
    const notices: Notice[] = [];

    for (const noticeType of noticeTypes) {
      const res = await groq.chat.completions.create({
        model: "llama-3.3-70b-versatile",
        messages: [{
          role: "user", content:
`Draft a "${noticeType}" for an Indian citizen's ${ctx.caseType} dispute.

FROM:      [COMPLAINANT NAME AND ADDRESS]
TO:        ${ctx.otherParty ?? "[RESPONDENT]"}
DATE:      ${new Date().toLocaleDateString("en-IN")}
SUBJECT:   ${noticeType} — ${ctx.caseType} — Ref: ${ctx.caseId.slice(0,8).toUpperCase()}

ISSUE:     ${ctx.incident}
DATE:      ${ctx.incidentDate ?? "as described"}
RELIEF:    ${ctx.desiredOutcome}
LAW:       ${ctx.applicableLaws[0]?.section ?? "applicable provisions"}, ${ctx.applicableLaws[0]?.act ?? "relevant Act"}

Include:
• "TAKE NOTICE THAT..." opening
• Facts in 2-3 sentences
• Legal basis citing the law above
• Specific demand with clear amount / action required
• "...within 15 days of receipt of this notice"
• "Failing which, legal proceedings shall be initiated without further notice."
• Professional closing

Under 280 words. Firm, professional Indian legal letter style.`
        }],
        max_tokens: 500, temperature: 0.15,
      });

      notices.push({
        type:      noticeType,
        subject:   `${noticeType} — ${ctx.caseType} — ${ctx.otherParty ?? "Respondent"}`,
        body:      res.choices[0]?.message?.content ?? "",
        recipient: ctx.otherParty ?? "[Respondent]",
      });
    }

    await sb.from("cases").update({ notices_drafted: notices }).eq("id", ctx.caseId);

    return {
      success: true, agentName: this.name,
      context: { ...ctx, noticesDrafted: notices, completedAgents: [...new Set([...ctx.completedAgents, "communication"])] },
      output: { notices },
    };
  }
}

// ================================================================
//  AGENT 8  —  LawyerConnectorAgent
//  Scores all available lawyers by:
//    +30 specialisation match   +20 city match   +10 state match
//    +15 language match         +10 NALSA tag     ×10 star rating
//  Assigns best match, drafts personalised briefing email.
// ================================================================
export class LawyerConnectorAgent {
  readonly name = "LawyerConnectorAgent";

  async run(ctx: CaseContext): Promise<AgentResult> {
    const { data: lawyers } = await sb.from("lawyers").select("*").eq("is_available", true).order("rating", { ascending: false }).limit(25);

    if (!lawyers?.length)
      return { success: false, agentName: this.name, context: ctx, output: {}, error: "No lawyers available" };

    const scored = lawyers.map(l => {
      let s = (l.rating ?? 0) * 10;
      if ((l.specialization ?? "").toLowerCase().includes((ctx.caseType ?? "").toLowerCase())) s += 30;
      if ((l.city  ?? "").toLowerCase() === (ctx.location ?? "").toLowerCase())               s += 20;
      if ((l.state ?? "").toLowerCase().includes((ctx.location ?? "").toLowerCase()))         s += 10;
      if ((l.languages ?? []).includes(ctx.language))                                         s += 15;
      if (l.is_nalsa) s += 10;
      return { ...l, score: s };
    }).sort((a, b) => b.score - a.score);

    const best = scored[0];
    await sb.from("cases").update({ lawyer_id: best.id, lawyer_notified_at: new Date().toISOString(), status: "lawyer_assigned" }).eq("id", ctx.caseId);

    const emailRes = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [{
        role: "user", content:
`Write a professional 120-word briefing email from PRAMAAN AI to NALSA lawyer ${best.name}.

CASE: ${ctx.caseType} | ${ctx.incident?.slice(0,80)}
AGAINST: ${ctx.otherParty}
KEY FACTS: ${ctx.keyFacts.slice(0,2).join("; ")}
STRENGTH: ${ctx.strengthPercentage}% | STRATEGY: ${ctx.strategy?.slice(0,120)}

Tell the lawyer:
1. PRAMAAN has prepared an 80% ready case dossier (laws found, precedents found, draft complaint written)
2. Brief case summary in 2 sentences
3. Request to contact client within 48 hours
Professional sign-off.`
      }],
      max_tokens: 260, temperature: 0.3,
    });

    const briefing = emailRes.choices[0]?.message?.content ?? "";

    return {
      success: true, agentName: this.name,
      context: { ...ctx, lawyerAssigned: best.id, lawyerName: best.name, stage: "lawyer_assigned", completedAgents: [...new Set([...ctx.completedAgents, "lawyerConnect"])], agentOutputs: { ...ctx.agentOutputs, lawyerConnect: { lawyer: best, briefing } } },
      output: { lawyer: best, briefing },
    };
  }
}

// ================================================================
//  MASTER ORCHESTRATOR
// ================================================================
export class PraamanOrchestrator {
  private readonly A1 = new IntakeAgent();
  private readonly A2 = new FileUploadAgent();
  private readonly A3 = new CasePrepAgent();
  private readonly A4 = new SectionFinderAgent();
  private readonly A5 = new PrecedentAgent();
  private readonly A6 = new PDFGeneratorAgent();
  private readonly A7 = new CommunicationAgent();
  private readonly A8 = new LawyerConnectorAgent();

  // ── Load context ─────────────────────────────────────────────
  async loadContext(caseId: string, userId: string): Promise<CaseContext> {
    const { data } = await sb.from("cases").select("*").eq("id", caseId).eq("user_id", userId).single();
    if (!data) return emptyCtx(caseId, userId);
    return {
      caseId, userId,
      language:           data.language            ?? "en",
      caseType:           data.case_type            ?? null,
      incident:           data.incident             ?? null,
      incidentDate:       data.incident_date         ?? null,
      otherParty:         data.other_party           ?? null,
      location:           data.location              ?? null,
      documentsDesc:      data.documents_desc        ?? null,
      desiredOutcome:     data.desired_outcome        ?? null,
      readyToFile:        !!(data.case_type && data.incident && data.other_party && data.desired_outcome),
      evidenceIds:        [], evidenceSummary: "",
      keyFacts:           data.key_facts             ?? [],
      strengthPercentage: data.strength_percentage   ?? 0,
      strategy:           data.strategy              ?? "",
      applicableLaws:     data.applicable_laws        ?? [],
      similarCases:       data.similar_cases          ?? [],
      draftDocument:      data.draft_document         ?? "",
      noticesDrafted:     data.notices_drafted        ?? [],
      lawyerAssigned:     data.lawyer_id              ?? null,
      lawyerName:         null,
      stage:              data.status                ?? "intake",
      completedAgents:    data.completed_agents       ?? [],
      agentOutputs:       data.agent_outputs          ?? {},
    };
  }

  // ── Save context ─────────────────────────────────────────────
  async saveContext(ctx: CaseContext): Promise<void> {
    await sb.from("cases").update({
      language: ctx.language, case_type: ctx.caseType, incident: ctx.incident,
      incident_date: ctx.incidentDate, other_party: ctx.otherParty, location: ctx.location,
      documents_desc: ctx.documentsDesc, desired_outcome: ctx.desiredOutcome,
      key_facts: ctx.keyFacts, strength_percentage: ctx.strengthPercentage, strategy: ctx.strategy,
      applicable_laws: ctx.applicableLaws, similar_cases: ctx.similarCases,
      draft_document: ctx.draftDocument, notices_drafted: ctx.noticesDrafted,
      lawyer_id: ctx.lawyerAssigned, status: ctx.stage,
      completed_agents: ctx.completedAgents, agent_outputs: ctx.agentOutputs,
      updated_at: new Date().toISOString(),
    }).eq("id", ctx.caseId);
  }

  // ================================================================
  //  ROUTE  —  main dispatch
  // ================================================================
  async route(task: string, payload: Record<string, unknown>, ctx: CaseContext): Promise<AgentResult> {
    console.log(`[Orch] ▶ task="${task}"  stage="${ctx.stage}"`);
    try {
      let r: AgentResult;

      switch (task) {

        case "chat_message": {
          // A1: extract profile + build response
          const msgs = payload.messages as Array<{role:string;content:string}>;
          r = await this.A1.run(msgs, ctx);
          // Auto-chain analysis pipeline when profile is complete
          if (r.context.readyToFile && !r.context.completedAgents.includes("sectionFinder"))
            r = await this.analysisPipeline(r.context);
          break;
        }

        case "file_upload": {
          // A2: OCR + embed → then re-analyse with new evidence
          r = await this.A2.run(payload as Parameters<FileUploadAgent["run"]>[0], ctx);
          if (r.context.caseType)
            r = await this.analysisPipeline(r.context);
          break;
        }

        case "generate_document": {
          // Ensure analysis done first, then A6 → A7
          let c = ctx;
          if (!ctx.completedAgents.includes("sectionFinder"))
            c = (await this.analysisPipeline(ctx)).context;
          r = await this.A6.run(c);
          r = await this.A7.run(r.context);
          break;
        }

        case "connect_lawyer":
          r = await this.A8.run(ctx);
          break;

        case "analyze":
          r = await this.analysisPipeline(ctx);
          break;

        case "get_context":
          return { success: true, agentName: "Orchestrator", context: ctx, output: { ctx } };

        default:
          return { success: false, agentName: "Orchestrator", context: ctx, output: {}, error: `Unknown task: "${task}"` };
      }

      await this.saveContext(r.context);
      return r;

    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Orch] ✗ task="${task}":`, msg);
      return { success: false, agentName: task, context: ctx, output: {}, error: msg };
    }
  }

  // ── A3 → A4 → A5 analysis pipeline ─────────────────────────
  private async analysisPipeline(ctx: CaseContext): Promise<AgentResult> {
    console.log("[Orch] analysis pipeline: A3→A4→A5");
    let r = await this.A3.run(ctx);
        r = await this.A4.run(r.context);
        r = await this.A5.run(r.context);
    r.context.stage = "analysis";
    return r;
  }
}

// ================================================================
//  CONSTANTS
// ================================================================
const FILING_FORUM: Record<string, string> = {
  Consumer:   "District Consumer Disputes Redressal Commission",
  Property:   "Civil Court / District Court",
  Employment: "Labour Court / Industrial Tribunal",
  Family:     "Principal Family Court",
  Criminal:   "Court of Judicial Magistrate",
  RTI:        "State Information Commission",
  Cheque:     "Court of Judicial Magistrate (NI Act s.138)",
  Domestic:   "Protection Officer / JMFC Court",
};

const NOTICE_TYPES: Record<string, string[]> = {
  Consumer:   ["Demand Notice", "Legal Notice before Consumer Forum"],
  Property:   ["Legal Notice to Vacate/Restore Possession"],
  Employment: ["Legal Notice for Unpaid Dues / Wrongful Termination"],
  Family:     ["Maintenance Demand Notice"],
  Criminal:   ["Complaint Notice to Police Station"],
  Cheque:     ["Section 138 NI Act Statutory Demand Notice"],
  RTI:        ["First Appeal under RTI Act 2005"],
  Domestic:   ["Notice under Protection of Women from Domestic Violence Act 2005"],
};

// ================================================================
//  HELPERS
// ================================================================
function parseLawsJSON(text: string): LawSection[] {
  try {
    const m = text.match(/\[[\s\S]*?\]/);
    if (!m) return [];
    return (JSON.parse(m[0]) as Array<Record<string,unknown>>).map(l => ({
      section:       String(l.section ?? ""), act: String(l.act ?? ""),
      description:   String(l.description ?? ""),
      sourceUrl:     String(l.source_url ?? l.sourceUrl ?? "https://indiankanoon.org"),
      relevanceScore: 75,
    }));
  } catch { return []; }
}

function parseCasesJSON(text: string): CourtCase[] {
  try {
    const m = text.match(/\[[\s\S]*?\]/);
    if (!m) return [];
    return (JSON.parse(m[0]) as Array<Record<string,unknown>>).map(c => ({
      title:    String(c.title ?? ""), citation: String(c.citation ?? ""),
      year:     Number(c.year ?? 0),  court:    String(c.court ?? "Indian Court"),
      outcome:  String(c.outcome ?? ""), summary: String(c.summary ?? ""),
      sourceUrl: String(c.source_url ?? c.sourceUrl ?? "https://indiankanoon.org"),
      relevanceScore: 75,
    }));
  } catch { return []; }
}

function EMPTY_PROFILE() {
  return { caseType: null, incident: null, incidentDate: null, otherParty: null, location: null, documentsDesc: null, desiredOutcome: null, language: "en", readyToFile: false };
}

export function emptyCtx(caseId: string, userId: string): CaseContext {
  return {
    caseId, userId, language: "en",
    caseType: null, incident: null, incidentDate: null, otherParty: null, location: null, documentsDesc: null, desiredOutcome: null, readyToFile: false,
    evidenceIds: [], evidenceSummary: "",
    keyFacts: [], strengthPercentage: 0, strategy: "",
    applicableLaws: [], similarCases: [],
    draftDocument: "", noticesDrafted: [],
    lawyerAssigned: null, lawyerName: null,
    stage: "intake", completedAgents: [], agentOutputs: {},
  };
}
