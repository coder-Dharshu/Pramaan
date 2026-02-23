// lib/ai/legal-agent.ts
// ══════════════════════════════════════════════════════════════
// PRAMAAN — Smart Legal Agent v3
//
// Upgrades:
//   ✅ Rich interactive responses with follow-up questions
//   ✅ Empathy + emotional acknowledgment
//   ✅ Victory direction analysis with real case precedents
//   ✅ Proactive tips (what documents help, what to avoid)
//   ✅ Deeper slot extraction (adds witnesses, urgency, amount)
//   ✅ Real-time case strength hints during conversation
//   ✅ Structured chat bubbles (bold, numbered, emoji cues)
// ══════════════════════════════════════════════════════════════

import Groq from "groq-sdk";
import {
  getLawsByType,
  getSimilarCases,
  type LawSection,
  type CourtCase,
} from "../mcp/legal-kb-mcp";

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ── Extended Case profile ─────────────────────────────────────
export interface CaseProfile {
  caseType:        string | null;
  incident:        string | null;
  incidentDate:    string | null;
  otherParty:      string | null;
  location:        string | null;
  documents:       string | null;
  desiredOutcome:  string | null;
  witnesses:       string | null;
  amountInvolved:  string | null;
  urgency:         string | null;
  readyToFile:     boolean;
}

const CORE_SLOTS = [
  "caseType",
  "incident",
  "incidentDate",
  "otherParty",
  "documents",
  "desiredOutcome",
] as const;

// ══════════════════════════════════════════════════════════════
// Extract full structured profile from conversation
// ══════════════════════════════════════════════════════════════
export async function extractCaseProfile(
  messages: { role: string; content: string }[]
): Promise<CaseProfile> {
  if (messages.length === 0) {
    return {
      caseType: null, incident: null, incidentDate: null,
      otherParty: null, location: null, documents: null,
      desiredOutcome: null, witnesses: null, amountInvolved: null,
      urgency: null, readyToFile: false,
    };
  }

  const convo = messages.map((m) => `${m.role}: ${m.content}`).join("\n");

  const res = await groq.chat.completions.create({
    model:    "llama-3.3-70b-versatile",
    messages: [{
      role:    "user",
      content: `Extract structured legal case information from this conversation. 
The person uses PLAIN EVERYDAY LANGUAGE — interpret meaning generously.

CASE TYPE EXAMPLES:
- "relative/neighbour took my land/property" → Property
- "company fired/sacked me without warning/notice" → Employment
- "builder not giving flat / cheated in purchase" → Consumer
- "wife/husband left / divorce / custody of kids" → Family
- "police harassing / false FIR filed on me" → Criminal
- "government office not replying to application" → RTI
- "cheque bounced / money not returned" → Cheque
- "shopkeeper sold broken/fake product" → Consumer
- "landlord not returning deposit / illegal eviction" → Property
- "boss not paying salary / unpaid wages" → Employment
- "accident / injury / negligence" → Tort
- "domestic violence / harassment at home" → Domestic

Conversation:
${convo}

Return ONLY valid JSON (null for unknown):
{
  "caseType": "Property|Consumer|Employment|Family|Criminal|RTI|Cheque|Domestic|Tort|Other|null",
  "incident": "clear plain description of what happened or null",
  "incidentDate": "when it happened — approximate is fine or null",
  "otherParty": "who did this — name, relationship, or company name or null",
  "location": "city, district or state or null",
  "documents": "documents/proof they mentioned having or null",
  "desiredOutcome": "what they want to achieve or null",
  "witnesses": "any witnesses mentioned or null",
  "amountInvolved": "any money/property value mentioned or null",
  "urgency": "any urgency or deadline mentioned or null",
  "readyToFile": false
}
Set readyToFile=true ONLY when caseType, incident, incidentDate, otherParty AND desiredOutcome are ALL non-null.`,
    }],
    max_tokens:  500,
    temperature: 0,
  });

  const defaults: CaseProfile = {
    caseType: null, incident: null, incidentDate: null,
    otherParty: null, location: null, documents: null,
    desiredOutcome: null, witnesses: null, amountInvolved: null,
    urgency: null, readyToFile: false,
  };

  try {
    const text  = res.choices[0]?.message?.content ?? "";
    const match = text.match(/\{[\s\S]*\}/);
    return match ? { ...defaults, ...JSON.parse(match[0]) } : defaults;
  } catch {
    return defaults;
  }
}

// ══════════════════════════════════════════════════════════════
// Build rich, interactive system prompt
// ══════════════════════════════════════════════════════════════
function buildSystemPrompt(profile: CaseProfile, turnCount: number): string {
  const missing  = CORE_SLOTS.filter((s) => !profile[s]);
  const nextSlot = missing[0];
  const filled   = CORE_SLOTS.length - missing.length;
  const pct      = Math.round((filled / CORE_SLOTS.length) * 100);

  // Rich slot-specific instructions with follow-up probing
  const slotInstructions: Record<string, string> = {
    caseType: `Ask what kind of problem they are facing. 
Give clear examples in simple language:
"Is it about property or land? A job problem? A consumer complaint (product/service)? Family issue (divorce/custody)? Police/criminal matter? Government office not responding? Cheque bounce or money not returned?"
Make it feel like a concerned friend asking, not a form.`,

    incident: `Ask them to describe exactly what happened — who did what, where, how.
Tell them: "Don't worry about legal words — just tell me the full story in your own words."
If they give a vague answer, ask ONE follow-up: "Can you give me more details about what exactly happened?"
Show empathy based on case type: property disputes → "That must be very stressful"; job loss → "I understand how difficult this must be".`,

    incidentDate: `Ask when this happened. Tell them approximate is fine — "last year", "3 months ago", "in 2022" all work.
Also ask if they already tried to report it anywhere (police, company HR, consumer forum). This shows initiative and helps the case.`,

    otherParty: `Ask WHO did this to them — full name if possible, their relationship (uncle, employer, builder, shopkeeper), and if it's a company, the company name.
Also ask: "Are they a private person or a company/government body?" This affects which court/forum we file in.`,

    documents: `Ask what documents or proof they have. Give helpful examples:
📄 Written: agreements, receipts, bills, appointment letters, salary slips
📱 Digital: WhatsApp messages, emails, screenshots, photos, videos  
🏛️ Official: FIR copies, government letters, court orders
Tell them: "Even a WhatsApp message or a photo counts as evidence. Don't worry if you don't have everything."
Also ask if they have witnesses who can support their case.`,

    desiredOutcome: `Ask what they want to happen — what is their goal?
Give examples: "Get money back? Get your property returned? Get your job back? Get compensation for damages? Want the person punished? Just want an official written apology?"
Tell them: "There is no wrong answer — knowing your goal helps us pick the right legal path."`,
  };

  const knownLines = [
    profile.caseType       && `✓ Case type: ${profile.caseType}`,
    profile.incident       && `✓ What happened: ${profile.incident}`,
    profile.incidentDate   && `✓ When: ${profile.incidentDate}`,
    profile.otherParty     && `✓ Other party: ${profile.otherParty}`,
    profile.location       && `✓ Location: ${profile.location}`,
    profile.documents      && `✓ Documents: ${profile.documents}`,
    profile.desiredOutcome && `✓ Goal: ${profile.desiredOutcome}`,
    profile.witnesses      && `✓ Witnesses: ${profile.witnesses}`,
    profile.amountInvolved && `✓ Amount: ${profile.amountInvolved}`,
  ].filter(Boolean);

  // All info collected — give victory direction
  if (profile.readyToFile) {
    return `You are PRAMAAN, a warm expert AI legal assistant for Indian citizens.

ALL CASE INFORMATION COLLECTED (${pct}%):
${knownLines.join("\n")}

Now give the user a POWERFUL, STRUCTURED RESPONSE with:

1. **Warm acknowledgment** (1 sentence — acknowledge how difficult this must be)

2. **Case Summary** — 2-3 sentences summarizing their situation clearly

3. **Your Legal Position** — Tell them 2-3 specific Indian laws that protect them:
   Format: "⚖️ **[Law Name]** — [what it means for them in plain words]"
   Examples: Consumer Protection Act 2019, Transfer of Property Act 1882, 
   Industrial Disputes Act 1947, IPC Section 406 (cheating), etc.

4. **Victory Direction** — THIS IS THE MOST IMPORTANT PART:
   Based on their case type, evidence, and typical court outcomes, tell them:
   "🏆 **How to Win This Case:**"
   - Which forum/court to approach (Consumer Forum / Labour Court / Civil Court / Criminal Court)
   - What is the strongest argument they should make
   - What additional evidence would dramatically strengthen their case
   - One real type of similar case that was won (e.g. "Consumer forums regularly rule in favour of buyers when builders delay possession")
   - Timeline: realistic timeframe for resolution

5. **Immediate Next Steps** — 3 numbered action steps they should take RIGHT NOW

6. **Encouragement** — Tell them to click "Next: Upload Evidence →" to continue

Format with **bold** for headings, emoji for visual cues, keep it warm and empowering.
Max 250 words. This person is counting on you.`;
  }

  // Early turn — be warmer and more exploratory
  const isEarlyTurn = turnCount <= 2;

  return `You are PRAMAAN, a warm, empathetic AI legal assistant for Indian citizens. Many users are distressed and need emotional support alongside legal guidance.

WHAT YOU KNOW (${pct}% / ${filled}/${CORE_SLOTS.length} key facts collected):
${knownLines.length > 0 ? knownLines.join("\n") : "Nothing collected yet — this is the start of the conversation."}

NEXT FIELD TO COLLECT: **${nextSlot}**
HOW TO ASK: ${slotInstructions[nextSlot] ?? "Ask about " + nextSlot}

RESPONSE STRUCTURE — follow this exactly:
${isEarlyTurn ? `
1. Give a warm welcome (first message only) and show you are here to help
2. Ask about "${nextSlot}" using the instruction above
3. Reassure them their information is safe and the service is free
` : `
1. ACKNOWLEDGE their last message in 1-2 sentences — show you understood and empathize
2. If their answer reveals something concerning (violence, urgency, large amount), acknowledge it specifically
3. Ask ONLY about "${nextSlot}" — use the instruction above
4. If it feels natural, add ONE brief tip: e.g. "Having a written agreement will really strengthen your case" or "Filing sooner is better as courts consider delays"
`}

CRITICAL RULES:
- Ask about ONLY "${nextSlot}" — do not ask about already-collected fields
- DO NOT repeat any question already answered
- Use **bold** for emphasis on important words
- Use emojis naturally (✅ ⚖️ 📄 💪 🏆) — not excessively
- Keep response under 100 words
- Be warm, never clinical or robotic
- If user seems upset, acknowledge feelings before asking questions`;
}

// ══════════════════════════════════════════════════════════════
// MAIN AGENT — rich interactive conversation
// ══════════════════════════════════════════════════════════════
export async function runLegalAgent(
  messages: { role: string; content: string }[]
): Promise<{ response: string; profile: CaseProfile }> {

  const profile    = await extractCaseProfile(messages);
  const turnCount  = messages.filter(m => m.role === "user").length;
  const systemPrompt = buildSystemPrompt(profile, turnCount);

  const formatted = messages.map((m) => ({
    role:    (m.role === "user" ? "user" : "assistant") as "user" | "assistant",
    content: m.content,
  }));

  const completion = await groq.chat.completions.create({
    model:    "llama-3.3-70b-versatile",
    messages: [
      { role: "system", content: systemPrompt },
      ...formatted,
    ],
    max_tokens:  400,
    temperature: 0.7,
  });

  const response =
    completion.choices[0]?.message?.content ??
    "I'm here to help. Could you tell me a bit more about your situation?";

  return { response, profile };
}

// ══════════════════════════════════════════════════════════════
// Case type extraction
// ══════════════════════════════════════════════════════════════
export async function extractCaseType(
  messages: { role: string; content: string }[]
): Promise<string> {
  const profile = await extractCaseProfile(messages);
  return profile.caseType ?? "Other";
}

// ══════════════════════════════════════════════════════════════
// Full case analysis with victory direction
// ══════════════════════════════════════════════════════════════
export async function analyzeCase(
  caseType: string,
  messages: { role: string; content: string }[]
) {
  const profile = await extractCaseProfile(messages);
  const summary = [profile.incident, profile.otherParty, profile.location, profile.amountInvolved]
    .filter(Boolean).join(", ");

  const [laws, similarCases] = await Promise.all([
    getLawsByType(caseType, summary),
    getSimilarCases(caseType, summary),
  ]);

  const convo = messages.map((m) => `${m.role}: ${m.content}`).join("\n");

  const res = await groq.chat.completions.create({
    model:    "llama-3.3-70b-versatile",
    messages: [{
      role:    "user",
      content: `You are a senior Indian legal analyst with 20 years of experience.
Analyse this case thoroughly and provide a victory direction.

CASE PROFILE:
- Type: ${caseType}
- Incident: ${profile.incident ?? "not specified"}
- Date: ${profile.incidentDate ?? "not specified"}
- Other party: ${profile.otherParty ?? "not specified"}
- Location: ${profile.location ?? "not specified"}
- Documents: ${profile.documents ?? "not specified"}
- Witnesses: ${profile.witnesses ?? "none mentioned"}
- Amount involved: ${profile.amountInvolved ?? "not specified"}
- Urgency: ${profile.urgency ?? "none mentioned"}
- Desired outcome: ${profile.desiredOutcome ?? "not specified"}

APPLICABLE LAWS FOUND:
${laws.map((l: LawSection) => `• ${l.section}, ${l.act}: ${l.description}`).join("\n")}

SIMILAR CASES FOUND:
${similarCases.map((c: CourtCase) => `• ${c.title} ${c.citation ?? ""} (${c.court}, ${c.year}): ${c.outcome} — ${c.summary}`).join("\n")}

FULL CONVERSATION:
${convo}

Reply ONLY as valid JSON:
{
  "strengthPercentage": 72,
  "strategy": "4-5 sentence strategic direction citing specific laws and real case precedents. Include: (1) strongest legal argument, (2) which court/forum to approach, (3) what evidence is critical, (4) one real similar case that supports them, (5) realistic timeline.",
  "victoryPath": "2-3 sentences on the single most effective path to winning — be specific and actionable",
  "warnings": "1-2 sentences on what could weaken their case or common mistakes to avoid",
  "forum": "exact forum/court name to file in e.g. District Consumer Disputes Redressal Commission / Labour Court / Civil Court"
}`,
    }],
    max_tokens:  600,
    temperature: 0.2,
  });

  let analysis = {
    strengthPercentage: 65,
    strategy: `Your case has grounds under ${laws[0]?.section ?? "applicable law"} (${laws[0]?.act ?? "relevant Act"}). ${
      similarCases[0]
        ? `The ${similarCases[0].court} has decided similar cases — see ${similarCases[0].title}.`
        : ""
    } Upload your evidence and the assigned lawyer will evaluate fully.`,
    victoryPath: "File your complaint with the appropriate forum with all available documentary evidence.",
    warnings: "Ensure you act within the limitation period applicable to your case.",
    forum: "Appropriate Court/Forum",
  };

  try {
    const text  = res.choices[0]?.message?.content ?? "";
    const match = text.match(/\{[\s\S]*\}/);
    if (match) analysis = { ...analysis, ...JSON.parse(match[0]) };
  } catch { /* keep defaults */ }

  return { laws, similarCases, analysis, profile };
}

// ══════════════════════════════════════════════════════════════
// Generate legal case draft for filing
// ══════════════════════════════════════════════════════════════
export async function generateCaseDraft(
  profile:  CaseProfile,
  evidence: Array<{ file_name: string; ocr_text?: string }>,
  caseType: string,
  laws:     LawSection[],
  cases:    CourtCase[]
): Promise<string> {
  const evidenceSummary = evidence.length > 0
    ? evidence.map((e) =>
        `• ${e.file_name}${e.ocr_text ? ` — extracted text: "${e.ocr_text.slice(0, 150)}..."` : ""}`
      ).join("\n")
    : "No evidence uploaded yet.";

  const res = await groq.chat.completions.create({
    model:    "llama-3.3-70b-versatile",
    messages: [{
      role:    "user",
      content: `Draft a formal legal complaint for Indian court/forum submission.

COMPLAINANT: [COMPLAINANT NAME AND ADDRESS — to be filled by lawyer]
RESPONDENT: ${profile.otherParty ?? "[RESPONDENT NAME]"}
CASE TYPE: ${caseType}
INCIDENT: ${profile.incident ?? "[INCIDENT DESCRIPTION]"}
DATE OF INCIDENT: ${profile.incidentDate ?? "[DATE]"}
LOCATION: ${profile.location ?? "[LOCATION]"}
AMOUNT/VALUE: ${profile.amountInvolved ?? "Not specified"}
WITNESSES: ${profile.witnesses ?? "None mentioned"}
RELIEF SOUGHT: ${profile.desiredOutcome ?? "[RELIEF]"}

EVIDENCE ON RECORD:
${evidenceSummary}

APPLICABLE LAWS:
${laws.map((l) => `• ${l.section}, ${l.act} — ${l.description}`).join("\n")}

SUPPORTING PRECEDENTS:
${cases.slice(0, 3).map((c) => `• ${c.title} ${c.citation ?? ""} (${c.court}, ${c.year}) — ${c.outcome}`).join("\n")}

Write a complete, professional Indian legal complaint with:
1. HEADING — appropriate authority name (Consumer Forum / Civil Court / Labour Court / etc.)
2. COMPLAINT/PETITION NUMBER: [TO BE ASSIGNED BY COURT]
3. IN THE MATTER OF — parties section with full details
4. FACTS OF THE CASE — numbered paragraphs, clear and chronological
5. LEGAL GROUNDS — cite every applicable section above with explanation
6. PRECEDENTS — cite the supporting cases above
7. RELIEFS CLAIMED — specific, numbered list
8. PRAYER — formal prayer for relief
9. VERIFICATION — standard verification declaration
10. DATE, PLACE, and SIGNATURE BLOCK

Use [PLACEHOLDER] for all personal details. 
Write formally but clearly. Number all paragraphs. Be thorough.`,
    }],
    max_tokens: 2500,
    temperature: 0.1,
  });

  return res.choices[0]?.message?.content ?? "Could not generate case draft.";
}