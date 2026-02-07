import { createClient } from "@supabase/supabase-js";

type JsonValue = string | number | boolean | null | { [key: string]: JsonValue } | JsonValue[];

type SupabaseSchema = {
  public: {
    Tables: {
      projects: {
        Row: Record<string, JsonValue>;
        Insert: Record<string, JsonValue>;
        Update: Record<string, JsonValue>;
        Relationships: [];
      };
      project_files: {
        Row: Record<string, JsonValue>;
        Insert: Record<string, JsonValue>;
        Update: Record<string, JsonValue>;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};

declare global {
  var __supabase_admin__: ReturnType<typeof createClient<SupabaseSchema>> | undefined;
}

export function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
  }

  const client =
    global.__supabase_admin__ ??
    createClient<SupabaseSchema>(url, serviceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    });

  global.__supabase_admin__ = client;
  return client;
}
