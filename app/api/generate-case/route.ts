// Generates a formal legal complaint document from case profile + evidence
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { generateCaseDraft, analyzeCase } from "@/lib/ai/legal-agent";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function POST(req: NextRequest) {
  try {
    const { caseId, userId, profile } = await req.json();

    if (!caseId || !userId) {
      return NextResponse.json({ error: "caseId and userId required" }, { status: 400 });
    }

    // Load evidence for this case
    const { data: evidence } = await supabase
      .from("evidence")
      .select("file_name, ocr_text, mime_type, storage_path")
      .eq("case_id", caseId)
      .eq("user_id", userId);

    // Load conversation messages for analysis context
    const { data: messages } = await supabase
      .from("case_messages")
      .select("role, content")
      .eq("case_id", caseId)
      .order("created_at", { ascending: true });

    const caseType = profile?.caseType ?? "Other";
    const allMsgs  = messages ?? [];

    // Get laws + cases for the filing document
    const analysis = await analyzeCase(caseType, allMsgs);

    // Generate the legal complaint draft
    const draft = await generateCaseDraft(
      profile,
      evidence ?? [],
      caseType,
      analysis.laws,
      analysis.similarCases
    );

    // Save the draft to the case
    await supabase
      .from("cases")
      .update({
        status:              "filed",
        strategy:            analysis.analysis.strategy,
        strength_percentage: analysis.analysis.strengthPercentage,
        applicable_laws:     analysis.laws,
        similar_cases:       analysis.similarCases,
      })
      .eq("id", caseId);

    return NextResponse.json({ draft, analysis, success: true });

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.error("[generate-case]", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
