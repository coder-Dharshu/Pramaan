// app/api/chat/route.ts
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import Groq from "groq-sdk";
import { runLegalAgent, analyzeCase } from "@/lib/ai/legal-agent";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

export async function POST(req: NextRequest) {
  try {
    let message   = "";
    let caseId    = "";
    let userId    = "";
    let audioUsed = false;

    const contentType = req.headers.get("content-type") ?? "";

    // ── Voice: audio file → Groq Whisper → text ──────────────
    if (contentType.includes("multipart/form-data")) {
      const form  = await req.formData();
      const audio = form.get("audio") as File | null;
      caseId      = (form.get("caseId")  as string) ?? "";
      userId      = (form.get("userId")  as string) ?? "";

      if (!audio) return err("No audio provided.", 400);

      const tx = await groq.audio.transcriptions.create({
        file:            audio,
        model:           "whisper-large-v3",
        response_format: "json",
        // language: "hi"  // uncomment to force Hindi; leave blank for auto-detect
      });

      message   = tx.text.trim();
      audioUsed = true;

      if (!message) return err("Could not transcribe audio.", 400);

    // ── Text input ─────────────────────────────────────────────
    } else {
      const body = await req.json();
      message    = body.message;
      caseId     = body.caseId  ?? "";
      userId     = body.userId  ?? "";
    }

    if (!message) return err("message is required.", 400);
    if (!userId)  return err("userId is required.", 400);

    // ── Ensure user exists ────────────────────────────────────
    await supabase
      .from("users")
      .upsert({ id: userId }, { onConflict: "id", ignoreDuplicates: true });

    // ── Get or create case ────────────────────────────────────
    let activeCaseId = caseId || null;

    if (!activeCaseId) {
      const { data: newCase, error: caseErr } = await supabase
        .from("cases")
        .insert({ user_id: userId, status: "intake", title: "New Case" })
        .select()
        .single();

      if (caseErr || !newCase) return err("Failed to create case.", 500);
      activeCaseId = newCase.id;
    }

    // ── Save user message ─────────────────────────────────────
    await supabase.from("case_messages").insert({
      case_id: activeCaseId,
      role:    "user",
      content: message,
    });

    // ── Load full conversation ────────────────────────────────
    const { data: dbMessages } = await supabase
      .from("case_messages")
      .select("role, content")
      .eq("case_id", activeCaseId)
      .order("created_at", { ascending: true });

    const allMessages = dbMessages ?? [];

    // ── Smart agent response ──────────────────────────────────
    const { response: aiResponse, profile } = await runLegalAgent(allMessages);

    // ── Save AI response ──────────────────────────────────────
    await supabase.from("case_messages").insert({
      case_id: activeCaseId,
      role:    "assistant",
      content: aiResponse,
    });

    // ── Update case title ─────────────────────────────────────
    if (profile.caseType && profile.incident) {
      await supabase
        .from("cases")
        .update({ title: `${profile.caseType}: ${profile.incident.slice(0, 60)}` })
        .eq("id", activeCaseId)
        .eq("title", "New Case");
    }

    // ── Auto-analyse when profile complete ────────────────────
    let analysisData = null;

    if (profile.readyToFile && profile.caseType) {
      analysisData = await analyzeCase(profile.caseType, allMessages);

      await supabase
        .from("cases")
        .update({
          case_type:           profile.caseType,
          applicable_laws:     analysisData.laws,
          similar_cases:       analysisData.similarCases,
          strategy:            analysisData.analysis.strategy,
          strength_percentage: analysisData.analysis.strengthPercentage,
          key_facts: [
            profile.incident,
            profile.otherParty,
            profile.incidentDate,
            profile.location,
          ].filter(Boolean),
          status: "analysis",
        })
        .eq("id", activeCaseId);
    }

    return NextResponse.json({
      response:    aiResponse,
      caseId:      activeCaseId,
      profile,
      analysis:    analysisData,
      transcribed: audioUsed ? message : null,
      readyToFile: profile.readyToFile,
    });

  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    console.error("[chat]", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

function err(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}
