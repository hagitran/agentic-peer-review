import PDFParser from "pdf2json";
import { NextResponse } from "next/server";

import { createAdminClient } from "@/utils/supabase/server";

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

      parser.on("pdfParser_dataError", (error: unknown) => {
        const typedError = error as { parserError?: { toString?: () => string } } | undefined;
        const message =
          typedError?.parserError?.toString?.() ??
          "Unable to parse PDF. The file may be encrypted or malformed.";
        reject(new Error(message));
      });

      parser.on("pdfParser_dataReady", (data: unknown) => {
        const typedData = data as {
          Pages?: Array<{ Texts?: Array<{ x: number; y: number; R?: Array<{ T: string }> }> }>;
        } | null;
        const pages: ParsedPage[] = (typedData?.Pages ?? []).map(
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

export async function POST(request: Request) {
  try {
    const supabase = createAdminClient();

    const formData = await request.formData();
    const file = formData.get("file");
    const actionRaw = formData.get("action");
    const projectIdRaw = formData.get("projectId");
    const clientLastModifiedRaw = formData.get("lastModified");

    if (!(file instanceof File)) {
      return NextResponse.json({ success: false, error: "File is required." }, { status: 400 });
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

    const clientLastModifiedDate =
      typeof clientLastModifiedRaw === "string" && clientLastModifiedRaw.length > 0
        ? new Date(Number(clientLastModifiedRaw))
        : null;
    const clientLastModifiedIso =
      clientLastModifiedDate && !Number.isNaN(clientLastModifiedDate.getTime())
        ? clientLastModifiedDate.toISOString()
        : null;

    const arrayBuffer = await file.arrayBuffer();
    const parsed = await parsePdfBuffer(Buffer.from(arrayBuffer));
    const nowIso = new Date().toISOString();

    if (action === "create_project") {
      const { data: projectRow, error: projectError } = await supabase
        .from("projects")
        .insert({ title: normalizeProjectTitle(file.name), updated_at: nowIso })
        .select("id")
        .single();

      if (projectError || !projectRow?.id) {
        throw new Error(projectError?.message || "Failed to create project.");
      }

      const { data: fileRow, error: fileError } = await supabase
        .from("project_files")
        .insert({
          project_id: projectRow.id,
          is_primary: true,
          original_filename: file.name,
          size_bytes: file.size,
          mime_type: file.type || "application/pdf",
          client_last_modified: clientLastModifiedIso,
          page_count: parsed.pageCount,
          extracted_text: parsed.text,
          pages_json: parsed.pages,
          processing_status: "ready",
          processing_error: null,
        })
        .select("id")
        .single();

      if (fileError || !fileRow?.id) {
        throw new Error(fileError?.message || "Failed to create project file.");
      }

      const { error: updateProjectError } = await supabase
        .from("projects")
        .update({ primary_file_id: fileRow.id, updated_at: nowIso })
        .eq("id", projectRow.id);

      if (updateProjectError) {
        throw new Error(updateProjectError.message || "Failed to finalize project.");
      }

      return NextResponse.json({
        success: true,
        projectId: projectRow.id,
        fileId: fileRow.id,
      });
    }

    if (action === "replace_primary") {
      const targetProjectId = projectId as string;
      const { error: demoteError } = await supabase
        .from("project_files")
        .update({ is_primary: false })
        .eq("project_id", targetProjectId)
        .eq("is_primary", true);

      if (demoteError) {
        throw new Error(demoteError.message || "Failed to replace primary file.");
      }

      const { data: fileRow, error: fileError } = await supabase
        .from("project_files")
        .insert({
          project_id: targetProjectId,
          is_primary: true,
          original_filename: file.name,
          size_bytes: file.size,
          mime_type: file.type || "application/pdf",
          client_last_modified: clientLastModifiedIso,
          page_count: parsed.pageCount,
          extracted_text: parsed.text,
          pages_json: parsed.pages,
          processing_status: "ready",
          processing_error: null,
        })
        .select("id")
        .single();

      if (fileError || !fileRow?.id) {
        throw new Error(fileError?.message || "Failed to replace primary file.");
      }

      const { error: updateProjectError } = await supabase
        .from("projects")
        .update({
          title: normalizeProjectTitle(file.name),
          primary_file_id: fileRow.id,
          feasibility_status: null,
          feasibility_result_json: null,
          method_status: "idle",
          method_error: null,
          method_result_json: null,
          updated_at: nowIso,
        })
        .eq("id", targetProjectId);

      if (updateProjectError) {
        throw new Error(updateProjectError.message || "Failed to update project.");
      }

      return NextResponse.json({
        success: true,
        projectId: targetProjectId,
        fileId: fileRow.id,
      });
    }

    const targetProjectId = projectId as string;
    const { data: addedFile, error: addFileError } = await supabase
      .from("project_files")
      .insert({
        project_id: targetProjectId,
        is_primary: false,
        original_filename: file.name,
        size_bytes: file.size,
        mime_type: file.type || "application/pdf",
        client_last_modified: clientLastModifiedIso,
        page_count: parsed.pageCount,
        extracted_text: parsed.text,
        pages_json: parsed.pages,
        processing_status: "ready",
        processing_error: null,
      })
      .select("id")
      .single();

    if (addFileError) {
      throw new Error(addFileError.message || "Failed to add sub paper.");
    }

    const { error: touchProjectError } = await supabase
      .from("projects")
      .update({ updated_at: nowIso })
      .eq("id", targetProjectId);

    if (touchProjectError) {
      throw new Error(touchProjectError.message || "Failed to update project.");
    }

    return NextResponse.json({
      success: true,
      projectId: targetProjectId,
      fileId: addedFile?.id ?? null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Extraction failed.";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
