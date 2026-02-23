// app/api/upload-evidence/route.ts
// PRAMAAN — Agent 2: File Upload + OCR + Groq Summary
//
// OCR Stack:
//   Images → Tesseract.js  (free, local, no API key needed)
//   PDFs   → pdf-parse     (direct text extraction, instant)
//   Summary→ Groq llama-3.3-70b (free, 14K req/day)

import { NextRequest, NextResponse } from "next/server";
import { createClient }              from "@supabase/supabase-js";
import Groq                          from "groq-sdk";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY! });

const ALLOWED_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "audio/mpeg",
  "audio/wav",
  "audio/webm",
  "audio/mp4",
];

// ── Extract text from PDF ─────────────────────────────────────
async function extractPdfText(buffer: Buffer): Promise<string> {
  try {
    const pdfParse = (await import("pdf-parse")).default;
    const data = await pdfParse(buffer);
    return data.text.trim();
  } catch (err) {
    console.warn("[OCR] pdf-parse failed:", err);
    return "";
  }
}

// ── OCR image using Tesseract.js ──────────────────────────────
async function ocrImage(buffer: Buffer, mimeType: string): Promise<string> {
  try {
    const { createWorker } = await import("tesseract.js");
    const worker  = await createWorker("eng");
    const base64  = buffer.toString("base64");
    const dataUrl = `data:${mimeType};base64,${base64}`;
    const { data: { text } } = await worker.recognize(dataUrl);
    await worker.terminate();
    return text.trim();
  } catch (err) {
    console.warn("[OCR] Tesseract failed:", err);
    return "";
  }
}

// ── Summarize with Groq ───────────────────────────────────────
async function summarizeWithGroq(text: string, fileName: string): Promise<string> {
  if (!text || text.length < 20) return "";
  try {
    const res = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [{
        role: "user",
        content: `You are a legal document analyst for Indian courts.
Summarize this document in 1-2 sentences for a legal case file.

File: ${fileName}
Extracted text:
${text.slice(0, 1500)}

Write ONLY the summary. No preamble.
Example: "Aadhaar card for Rahul Sharma (XXXX-XXXX-4521), address in Bangalore, Karnataka."`,
      }],
      max_tokens: 100, temperature: 0.1,
    });
    return res.choices[0]?.message?.content?.trim() ?? "";
  } catch {
    return text.slice(0, 200);
  }
}

export async function POST(req: NextRequest) {
  try {
    const form   = await req.formData();
    const file   = form.get("file")    as File   | null;
    const caseId = form.get("case_id") as string | null;
    const userId = form.get("user_id") as string | null;

    if (!file)   return fail("No file provided.", 400);
    if (!caseId) return fail("case_id is required.", 400);
    if (!userId) return fail("user_id is required.", 400);

    if (!ALLOWED_TYPES.includes(file.type))
      return fail(`File type "${file.type}" not supported.`, 400);

    if (file.size > 10 * 1024 * 1024)
      return fail("File exceeds 10 MB limit.", 400);

    // ── Upload to Supabase Storage ───────────────────────────
    const buffer      = Buffer.from(await file.arrayBuffer());
    const safeName    = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
    const storagePath = `evidence/${userId}/${caseId}/${Date.now()}-${safeName}`;

    const { error: storErr } = await supabase.storage
      .from("evidence")
      .upload(storagePath, buffer, { contentType: file.type, upsert: false });

    if (storErr) return fail(`Storage error: ${storErr.message}`, 500);

    // ── Extract text ─────────────────────────────────────────
    let ocrText = "";

    if (file.type === "application/pdf") {
      console.log("[upload-evidence] Extracting PDF text with pdf-parse...");
      ocrText = await extractPdfText(buffer);
    } else if (file.type.startsWith("image/")) {
      console.log("[upload-evidence] Running Tesseract OCR on image...");
      ocrText = await ocrImage(buffer, file.type);
    }

    // ── Summarize with Groq ───────────────────────────────────
    let summary = "";
    if (ocrText.length > 20) {
      console.log("[upload-evidence] Summarizing with Groq...");
      summary = await summarizeWithGroq(ocrText, file.name);
    }

    // ── Save to DB ───────────────────────────────────────────
    const { data: evRow, error: dbErr } = await supabase
      .from("evidence")
      .insert({
        case_id:      caseId,
        user_id:      userId,
        file_name:    file.name,
        file_size:    file.size,
        mime_type:    file.type,
        storage_path: storagePath,
        ocr_text:     ocrText || null,
        summary:      summary || null,
        status:       ocrText ? "processed" : "uploaded",
      })
      .select()
      .single();

    if (dbErr) return fail(`Database error: ${dbErr.message}`, 500);

    // ── Signed URL for preview ────────────────────────────────
    const { data: signedData } = await supabase.storage
      .from("evidence")
      .createSignedUrl(storagePath, 3600);

    return NextResponse.json({
      success:    true,
      evidenceId: evRow?.id             ?? null,
      fileName:   file.name,
      summary:    summary               || null,
      ocrPreview: ocrText.slice(0, 300) || null,
      signed_url: signedData?.signedUrl ?? null,
    });

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Unexpected error";
    console.error("[upload-evidence]", msg);
    return fail(msg, 500);
  }
}

function fail(message: string, status: number) {
  return NextResponse.json({ error: message, success: false }, { status });
}