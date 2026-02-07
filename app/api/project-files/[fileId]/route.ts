import { NextResponse } from "next/server";

import { createAdminClient } from "@/utils/supabase/server";

export const runtime = "nodejs";

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ fileId: string }> }
) {
  try {
    const { fileId } = await params;
    const supabase = createAdminClient();

    const { data: file, error: fileError } = await supabase
      .from("project_files")
      .select("id, is_primary")
      .eq("id", fileId)
      .limit(1)
      .single();

    if (fileError || !file) {
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

    const { error: deleteError } = await supabase.from("project_files").delete().eq("id", fileId);
    if (deleteError) {
      throw new Error(deleteError.message || "Delete failed.");
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Delete failed.";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
