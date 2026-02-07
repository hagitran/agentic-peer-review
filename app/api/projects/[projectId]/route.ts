import { NextResponse } from "next/server";

import { getSql } from "@/lib/db";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ projectId: string }> }
) {
  try {
    const { projectId } = await params;
    const sql = getSql();
    await sql`
      alter table projects
      add column if not exists method_error text
    `;

    const projectRows = await sql<{
      id: string;
      title: string;
      primary_file_id: string | null;
      feasibility_status: string | null;
      feasibility_result_json: unknown;
      method_status: string;
      method_error: string | null;
      method_result_json: unknown;
      created_at: string;
      updated_at: string;
    }[]>`
      select
        id,
        title,
        primary_file_id,
        feasibility_status,
        feasibility_result_json,
        method_status,
        method_error,
        method_result_json,
        created_at,
        updated_at
      from projects
      where id = ${projectId}
      limit 1
    `;

    const project = projectRows[0];
    if (!project) {
      return NextResponse.json(
        { success: false, error: "Project not found." },
        { status: 404 }
      );
    }

    const fileRows = await sql<{
      id: string;
      project_id: string;
      is_primary: boolean;
      original_filename: string;
      size_bytes: number;
      mime_type: string;
      client_last_modified: string | null;
      uploaded_at: string;
      page_count: number;
      extracted_text: string;
      pages_json: unknown;
      processing_status: string;
      processing_error: string | null;
    }[]>`
      select
        id,
        project_id,
        is_primary,
        original_filename,
        size_bytes,
        mime_type,
        client_last_modified,
        uploaded_at,
        page_count,
        extracted_text,
        pages_json,
        processing_status,
        processing_error
      from project_files
      where project_id = ${projectId}
      order by is_primary desc, uploaded_at desc
    `;

    return NextResponse.json({
      success: true,
      project: {
        ...project,
        files: fileRows,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load project.";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
