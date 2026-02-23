import { NextRequest, NextResponse } from "next/server";
import { createClient }              from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function GET(req: NextRequest) {
  try {
    const userId = req.nextUrl.searchParams.get("userId");
    if (!userId) return NextResponse.json({ error: "userId required" }, { status: 400 });

    // ── Fetch user's cases with assigned lawyer info ─────────
    const { data: cases, error: casesErr } = await supabase
      .from("cases")
      .select(`
        id, title, status, case_type, created_at, updated_at,
        strength_percentage, strategy, lawyer_id,
        lawyers ( id, name, specialization, city, rating, cases_handled )
      `)
      .eq("user_id", userId)
      .order("updated_at", { ascending: false });

    if (casesErr) throw new Error(casesErr.message);

    // ── Fetch connected lawyers (distinct from all user cases) ──
    const lawyerIds = [...new Set(
      (cases ?? []).map(c => c.lawyer_id).filter(Boolean)
    )];

    let lawyers: unknown[] = [];
    if (lawyerIds.length > 0) {
      const { data: lData } = await supabase
        .from("lawyers")
        .select("id, name, specialization, city, rating, cases_handled")
        .in("id", lawyerIds);
      lawyers = lData ?? [];
    }

    // ── Build notifications from case events ─────────────────
    const notifications: { title: string; body: string }[] = [];

    (cases ?? []).forEach(c => {
      const date = new Date(c.updated_at).toLocaleDateString("en-IN", {
        day: "numeric", month: "short"
      });
      if (c.status === "filed" && c.lawyers) {
        notifications.push({
          title: `🔔 Lawyer assigned to your case`,
          body:  `${c.lawyers.name} accepted your ${c.case_type || "case"} · ${date}`,
        });
      }
      if (c.status === "filed") {
        notifications.push({
          title: `📄 Case dossier ready`,
          body:  `Pramaan Dossier for "${c.title}" is ready · ${date}`,
        });
      }
    });

    return NextResponse.json({
      cases:         cases ?? [],
      lawyers,
      notifications: notifications.slice(0, 10),
    });

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Unexpected error";
    console.error("[dashboard]", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}