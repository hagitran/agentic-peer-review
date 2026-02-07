import { NextResponse } from "next/server";

import { getSql } from "@/lib/db";

export const runtime = "nodejs";

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ fileId: string }> }
) {
  try {
    const { fileId } = await params;
    const sql = getSql();

    const rows = await sql<{ id: string; is_primary: boolean }[]>`
      select id, is_primary
      from project_files
      where id = ${fileId}
      limit 1
    `;

    const file = rows[0];
    if (!file) {
      return NextResponse.json(
        { success: false, error: "File not found." },
        { status: 404 }
      );
    }

    if (file.is_primary) {
      return NextResponse.json(
        { success: false, error: "Primary file cannot be deleted." },
        { status: 400 }
      );
    }

    await sql`delete from project_files where id = ${fileId}`;
    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Delete failed.";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
