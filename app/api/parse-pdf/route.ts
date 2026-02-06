import PDFParser from "pdf2json";
import { NextResponse } from "next/server";
import type { Sql } from "postgres";

import { getSql } from "@/lib/db";

export const runtime = "nodejs";

const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;

type ParsedPage = {
  pageNumber: number;
  text: string;
  lines: Array<{ y: number; text: string }>;
  segments: Array<{ x: number; y: number; text: string }>;
};

function decodePdfText(value: string) {
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    return value;
  }
}

function parsePdfBuffer(buffer: Buffer) {
  return new Promise<{ pageCount: number; text: string; pages: ParsedPage[] }>(
    (resolve, reject) => {
      const parser = new PDFParser();

      parser.on("pdfParser_dataError", (error) => {
        const message =
          error?.parserError?.toString?.() ??
          "Unable to parse PDF. The file may be encrypted or malformed.";
        reject(new Error(message));
      });

      parser.on("pdfParser_dataReady", (data) => {
        const pages: ParsedPage[] = (data?.Pages ?? []).map(
          (page: { Texts?: Array<{ x: number; y: number; R?: Array<{ T: string }> }> }, index: number) => {
            const segments = (page.Texts ?? [])
              .map((item) => ({
                x: item.x,
                y: item.y,
                text: decodePdfText(item.R?.[0]?.T ?? "").trim(),
              }))
              .filter((item) => item.text.length > 0)
              .sort((a, b) => (a.y === b.y ? a.x - b.x : a.y - b.y));

            const lines: ParsedPage["lines"] = [];
            for (const segment of segments) {
              const lastLine = lines[lines.length - 1];
              if (!lastLine || Math.abs(lastLine.y - segment.y) > 0.6) {
                lines.push({ y: segment.y, text: segment.text });
                continue;
              }
              lastLine.text = `${lastLine.text} ${segment.text}`.replace(/\s+/g, " ").trim();
            }

            return {
              pageNumber: index + 1,
              text: lines.map((line) => line.text).join("\n"),
              lines,
              segments,
            };
          }
        );

        const text = pages.map((page) => page.text).filter(Boolean).join("\n\n");

        resolve({
          pageCount: pages.length,
          text,
          pages,
        });
      });

      parser.parseBuffer(buffer);
    }
  );
}

async function ensureSchema(sql: Sql) {
  await sql`create extension if not exists pgcrypto`;
  await sql`
    create table if not exists paper_extractions (
      id uuid primary key default gen_random_uuid(),
      original_filename text not null,
      size_bytes bigint not null,
      mime_type text not null,
      client_last_modified timestamptz,
      uploaded_at timestamptz not null default now(),
      page_count integer not null default 0,
      extracted_text text not null default '',
      pages_json jsonb,
      processing_status text not null default 'queued',
      processing_error text
    )
  `;
}

export async function POST(request: Request) {
  let extractionId: string | null = null;
  let sql: Sql | null = null;

  try {
    sql = getSql();
    await ensureSchema(sql);

    const formData = await request.formData();
    const file = formData.get("file");
    const clientLastModifiedRaw = formData.get("lastModified");

    if (!(file instanceof File)) {
      return NextResponse.json({ success: false, error: "File is required." }, { status: 400 });
    }

    if (file.type !== "application/pdf") {
      return NextResponse.json({ success: false, error: "Only PDF uploads are supported." }, { status: 400 });
    }

    if (file.size > MAX_FILE_SIZE_BYTES) {
      return NextResponse.json(
        { success: false, error: "File exceeds 10MB limit." },
        { status: 413 }
      );
    }

    const clientLastModified =
      typeof clientLastModifiedRaw === "string" && clientLastModifiedRaw.length > 0
        ? new Date(Number(clientLastModifiedRaw))
        : null;

    const startedRows = await sql<{ id: string }[]>`
      insert into paper_extractions (
        original_filename,
        size_bytes,
        mime_type,
        client_last_modified,
        processing_status
      )
      values (
        ${file.name},
        ${file.size},
        ${file.type || "application/pdf"},
        ${clientLastModified && !Number.isNaN(clientLastModified.getTime())
          ? clientLastModified.toISOString()
          : null},
        'extracting'
      )
      returning id
    `;

    extractionId = startedRows[0]?.id ?? null;

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const parsed = await parsePdfBuffer(buffer);

    if (!extractionId) {
      throw new Error("Failed to initialize extraction record.");
    }

    await sql`
      update paper_extractions
      set
        page_count = ${parsed.pageCount},
        extracted_text = ${parsed.text},
        pages_json = ${sql.json(parsed.pages)},
        processing_status = 'ready',
        processing_error = null
      where id = ${extractionId}
    `;

    return NextResponse.json({
      success: true,
      id: extractionId,
      pageCount: parsed.pageCount,
      text: parsed.text,
      pages: parsed.pages,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Extraction failed.";

    if (extractionId && sql) {
      await sql`
        update paper_extractions
        set
          processing_status = 'failed',
          processing_error = ${message}
        where id = ${extractionId}
      `;
    }

    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
