import PDFParser from "pdf2json";
import { NextResponse } from "next/server";
import type { Sql } from "postgres";

import { getSql } from "@/lib/db";

export const runtime = "nodejs";

const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;

type ParseAction = "create_project" | "replace_primary" | "add_subpdf";

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
          (
            page: { Texts?: Array<{ x: number; y: number; R?: Array<{ T: string }> }> },
            index: number
          ) => {
            const segments = (page.Texts ?? [])
              .map((item) => ({
                x: item.x,
                y: item.y,
                text: (item.R ?? [])
                  .map((run) => decodePdfText(run.T ?? ""))
                  .join("")
                  .trim(),
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
              lastLine.text = `${lastLine.text} ${segment.text}`
                .replace(/\s+/g, " ")
                .trim();
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

function normalizeProjectTitle(filename: string) {
  return filename.replace(/\.pdf$/i, "").trim() || "Untitled project";
}

async function ensureSchema(sql: Sql) {
  await sql`create extension if not exists pgcrypto`;

  await sql`
    do $$
    begin
      if exists (select 1 from information_schema.tables where table_name = 'paper_extractions') then
        drop table paper_extractions;
      end if;
    end
    $$;
  `;

  await sql`
    create table if not exists projects (
      id uuid primary key default gen_random_uuid(),
      title text not null default 'Untitled project',
      primary_file_id uuid,
      feasibility_status text,
      feasibility_result_json jsonb,
      method_status text not null default 'idle',
      method_error text,
      method_result_json jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `;

  await sql`
    alter table projects
    add column if not exists method_error text
  `;

  await sql`
    create table if not exists project_files (
      id uuid primary key default gen_random_uuid(),
      project_id uuid not null references projects(id) on delete cascade,
      is_primary boolean not null default false,
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

  await sql`
    create unique index if not exists project_single_primary_idx
    on project_files(project_id)
    where is_primary = true
  `;
}

export async function POST(request: Request) {
  try {
    const sql = getSql();
    await ensureSchema(sql);

    const formData = await request.formData();
    const file = formData.get("file");
    const actionRaw = formData.get("action");
    const projectIdRaw = formData.get("projectId");
    const clientLastModifiedRaw = formData.get("lastModified");

    if (!(file instanceof File)) {
      return NextResponse.json(
        { success: false, error: "File is required." },
        { status: 400 }
      );
    }

    if (file.type !== "application/pdf") {
      return NextResponse.json(
        { success: false, error: "Only PDF uploads are supported." },
        { status: 400 }
      );
    }

    if (file.size > MAX_FILE_SIZE_BYTES) {
      return NextResponse.json(
        { success: false, error: "File exceeds 10MB limit." },
        { status: 413 }
      );
    }

    const action: ParseAction =
      actionRaw === "replace_primary" || actionRaw === "add_subpdf"
        ? actionRaw
        : "create_project";
    const projectId =
      typeof projectIdRaw === "string" && projectIdRaw.trim().length > 0
        ? projectIdRaw.trim()
        : null;

    if (action !== "create_project" && !projectId) {
      return NextResponse.json(
        { success: false, error: "projectId is required for this action." },
        { status: 400 }
      );
    }

    const clientLastModified =
      typeof clientLastModifiedRaw === "string" && clientLastModifiedRaw.length > 0
        ? new Date(Number(clientLastModifiedRaw))
        : null;

    const arrayBuffer = await file.arrayBuffer();
    const parsed = await parsePdfBuffer(Buffer.from(arrayBuffer));

    if (action === "create_project") {
      const projectRows = await sql<{ id: string }[]>`
        insert into projects (title, updated_at)
        values (${normalizeProjectTitle(file.name)}, now())
        returning id
      `;
      const createdProjectId = projectRows[0]?.id;
      if (!createdProjectId) {
        throw new Error("Failed to create project.");
      }

      const fileRows = await sql<{ id: string }[]>`
        insert into project_files (
          project_id,
          is_primary,
          original_filename,
          size_bytes,
          mime_type,
          client_last_modified,
          page_count,
          extracted_text,
          pages_json,
          processing_status,
          processing_error
        )
        values (
          ${createdProjectId},
          true,
          ${file.name},
          ${file.size},
          ${file.type || "application/pdf"},
          ${clientLastModified && !Number.isNaN(clientLastModified.getTime())
            ? clientLastModified.toISOString()
            : null},
          ${parsed.pageCount},
          ${parsed.text},
          ${sql.json(parsed.pages)},
          'ready',
          null
        )
        returning id
      `;

      const createdFileId = fileRows[0]?.id;
      if (!createdFileId) {
        throw new Error("Failed to create project file.");
      }

      await sql`
        update projects
        set primary_file_id = ${createdFileId}, updated_at = now()
        where id = ${createdProjectId}
      `;

      return NextResponse.json({
        success: true,
        projectId: createdProjectId,
        fileId: createdFileId,
      });
    }

    if (action === "replace_primary") {
      await sql`
        update project_files
        set is_primary = false
        where project_id = ${projectId} and is_primary = true
      `;

      const fileRows = await sql<{ id: string }[]>`
        insert into project_files (
          project_id,
          is_primary,
          original_filename,
          size_bytes,
          mime_type,
          client_last_modified,
          page_count,
          extracted_text,
          pages_json,
          processing_status,
          processing_error
        )
        values (
          ${projectId},
          true,
          ${file.name},
          ${file.size},
          ${file.type || "application/pdf"},
          ${clientLastModified && !Number.isNaN(clientLastModified.getTime())
            ? clientLastModified.toISOString()
            : null},
          ${parsed.pageCount},
          ${parsed.text},
          ${sql.json(parsed.pages)},
          'ready',
          null
        )
        returning id
      `;

      const replacedFileId = fileRows[0]?.id;
      if (!replacedFileId) {
        throw new Error("Failed to replace primary file.");
      }

      await sql`
        update projects
        set
          title = ${normalizeProjectTitle(file.name)},
          primary_file_id = ${replacedFileId},
          feasibility_status = null,
          feasibility_result_json = null,
          method_status = 'idle',
          method_error = null,
          method_result_json = null,
          updated_at = now()
        where id = ${projectId}
      `;

      return NextResponse.json({
        success: true,
        projectId,
        fileId: replacedFileId,
      });
    }

    const addedRows = await sql<{ id: string }[]>`
      insert into project_files (
        project_id,
        is_primary,
        original_filename,
        size_bytes,
        mime_type,
        client_last_modified,
        page_count,
        extracted_text,
        pages_json,
        processing_status,
        processing_error
      )
      values (
        ${projectId},
        false,
        ${file.name},
        ${file.size},
        ${file.type || "application/pdf"},
        ${clientLastModified && !Number.isNaN(clientLastModified.getTime())
          ? clientLastModified.toISOString()
          : null},
        ${parsed.pageCount},
        ${parsed.text},
        ${sql.json(parsed.pages)},
        'ready',
        null
      )
      returning id
    `;

    await sql`update projects set updated_at = now() where id = ${projectId}`;

    return NextResponse.json({
      success: true,
      projectId,
      fileId: addedRows[0]?.id ?? null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Extraction failed.";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
