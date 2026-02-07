import { NextResponse } from "next/server";

import { createAdminClient } from "@/utils/supabase/server";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ projectId: string }> }
) {
  try {
    const { projectId } = await params;
    const supabase = createAdminClient();

    const { data: project, error: projectError } = await supabase
      .from("projects")
      .select(
        "id, title, primary_file_id, feasibility_status, feasibility_result_json, method_status, method_error, method_result_json, created_at, updated_at"
      )
      .eq("id", projectId)
      .limit(1)
      .single();

    if (projectError || !project) {
      return NextResponse.json(
        { success: false, error: "Project not found." },
        { status: 404 }
      );
    }

    const { data: files, error: filesError } = await supabase
      .from("project_files")
      .select(
        "id, project_id, is_primary, original_filename, size_bytes, mime_type, client_last_modified, uploaded_at, page_count, extracted_text, pages_json, processing_status, processing_error"
      )
      .eq("project_id", projectId)
      .order("is_primary", { ascending: false })
      .order("uploaded_at", { ascending: false });

    if (filesError) {
      throw new Error(filesError.message || "Failed to load project files.");
    }

    return NextResponse.json({
      success: true,
      project: {
        ...project,
        files: files ?? [],
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load project.";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
