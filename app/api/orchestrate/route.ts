import { NextRequest, NextResponse } from "next/server";
import { createClient }              from "@supabase/supabase-js";
import Groq                          from "groq-sdk";
import { PraamanOrchestrator, emptyCtx } from "@/lib/orchestrator";

const sb  = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY! });
const orch = new PraamanOrchestrator();

export async function POST(req: NextRequest) {
  try {
    const ct = req.headers.get("content-type") ?? "";

    let task = "", userId = "", caseId = "";
    let payload: Record<string, unknown> = {};
    let transcribed: string | null = null;

    // ── Multipart (voice or file upload) ─────────────────────
    if (ct.includes("multipart/form-data")) {
      const form = await req.formData();
      task   = (form.get("task")   as string) ?? "";
      userId = (form.get("userId") as string) ?? "";
      caseId = (form.get("caseId") as string) ?? "";

      // ── Voice: transcribe audio → treat as chat_message ────
      if (task === "voice_message") {
        const audio = form.get("audio") as File | null;
        if (!audio) return fail("No audio file", 400);

        const tx = await groq.audio.transcriptions.create({
          file: audio, model: "whisper-large-v3", response_format: "json",
        });
        transcribed = tx.text.trim();
        if (!transcribed) return fail("Could not transcribe audio", 400);

        task    = "chat_message";    // handled exactly like a text message
        payload = { transcribed };

      // ── File upload: save to storage + create evidence row ──
      } else if (task === "file_upload") {
        const file = form.get("file") as File | null;
        if (!file) return fail("No file", 400);

        // Validate caseId exists before upload
        if (!caseId) return fail("caseId required for file upload", 400);

        const buffer      = Buffer.from(await file.arrayBuffer());
        const storagePath = `evidence/${userId}/${caseId}/${Date.now()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, "_")}`;

        const { error: storErr } = await sb.storage
          .from("evidence")
          .upload(storagePath, buffer, { contentType: file.type, upsert: false });

        if (storErr) return fail(`Storage error: ${storErr.message}`, 500);

        const { data: evRow } = await sb
          .from("evidence")
          .insert({ case_id: caseId, user_id: userId, file_name: file.name, file_size: file.size, mime_type: file.type, storage_path: storagePath, status: "uploaded" })
          .select().single();

        payload = { fileBuffer: buffer, fileName: file.name, mimeType: file.type, evidenceId: evRow?.id ?? "" };
      }

    // ── JSON body ─────────────────────────────────────────────
    } else {
      const body = await req.json();
      task   = body.task   ?? "";
      userId = body.userId ?? "";
      caseId = body.caseId ?? "";
      payload = body;
    }

    if (!userId) return fail("userId required", 400);
    if (!task)   return fail("task required",   400);

    // ── Ensure user row exists (upsert) ───────────────────────
    await sb.from("users").upsert({ id: userId }, { onConflict: "id", ignoreDuplicates: true });

    // ── Get or create case ────────────────────────────────────
    let activeCaseId = caseId;
    if (!activeCaseId) {
      const { data: newCase, error } = await sb
        .from("cases")
        .insert({ user_id: userId, status: "intake", title: "New Case" })
        .select().single();
      if (error) return fail(`Could not create case: ${error.message}`, 500);
      activeCaseId = newCase.id;
    }

    // ── Load CaseContext from Supabase ────────────────────────
    let ctx = await orch.loadContext(activeCaseId, userId);

    // ── Persist chat messages ─────────────────────────────────
    if (task === "chat_message") {
      const message = String(transcribed ?? payload.message ?? "");
      if (!message) return fail("message required", 400);

      await sb.from("case_messages").insert({
        case_id: activeCaseId, role: "user",
        content: message, agent: "user",
      });

      // Pass full conversation history to IntakeAgent for slot-filling
      const { data: history } = await sb
        .from("case_messages")
        .select("role, content")
        .eq("case_id", activeCaseId)
        .order("created_at", { ascending: true });

      payload.messages = history ?? [];
    }

    // Return current state if that's all that's asked
    if (task === "get_context") {
      return ok({ caseId: activeCaseId, context: ctx });
    }

    // ── Run through orchestrator ──────────────────────────────
    const result = await orch.route(task, payload, ctx);
    ctx = result.context;

    // ── Save AI response to DB ────────────────────────────────
    if (task === "chat_message" && result.output.response) {
      const aiText = String(result.output.response);
      await sb.from("case_messages").insert({
        case_id: activeCaseId, role: "assistant",
        content: aiText, agent: result.agentName,
      });

      // Auto-update case title once caseType + incident known
      if (ctx.caseType && ctx.incident) {
        await sb.from("cases")
          .update({ title: `${ctx.caseType}: ${ctx.incident.slice(0, 55)}` })
          .eq("id", activeCaseId)
          .eq("title", "New Case");
      }
    }

    // ── Build response
    return ok({
      success:    result.success,
      caseId:     activeCaseId,
      task,
      agentRan:   result.agentName,

      // Chat
      response:    result.output.response ?? null,
      transcribed: transcribed,

      // Profile (for frontend progress bar + facts panel)
      profile: {
        caseType:       ctx.caseType,
        incident:       ctx.incident,
        incidentDate:   ctx.incidentDate,
        otherParty:     ctx.otherParty,
        location:       ctx.location,
        documentsDesc:  ctx.documentsDesc,
        desiredOutcome: ctx.desiredOutcome,
        readyToFile:    ctx.readyToFile,
        language:       ctx.language,
      },

      // Analysis (available after A3→A4→A5 pipeline)
      analysis: ctx.completedAgents.includes("sectionFinder") ? {
        laws:               ctx.applicableLaws,
        cases:              ctx.similarCases,
        keyFacts:           ctx.keyFacts,
        strengthPercentage: ctx.strengthPercentage,
        strategy:           ctx.strategy,
      } : null,

      // Document output (Agent 6)
      draft:   ctx.draftDocument || null,

      // Notices (Agent 7)
      notices: ctx.noticesDrafted,

      // Lawyer (Agent 8)
      lawyer: ctx.lawyerAssigned
        ? { id: ctx.lawyerAssigned, name: ctx.lawyerName }
        : null,

      // Evidence (Agent 2)
      evidenceProcessed: result.output.summary ?? null,

      // Pipeline state
      stage:           ctx.stage,
      completedAgents: ctx.completedAgents,

      error: result.error ?? null,
    });

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Unexpected error";
    console.error("[orchestrate]", msg);
    return fail(msg, 500);
  }
}

// ── Helpers 
function ok(body: Record<string, unknown>)       { return NextResponse.json(body); }
function fail(msg: string, status: number)        { return NextResponse.json({ error: msg, success: false }, { status }); }
