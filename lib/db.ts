import postgres from "postgres";

declare global {
  var __sql__: ReturnType<typeof postgres> | undefined;
}

export function getSql() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required");
  }

  const sql =
    global.__sql__ ??
    postgres(connectionString, {
      prepare: false,
      max: 1,
    });

  if (process.env.NODE_ENV !== "production") {
    global.__sql__ = sql;
  }

  return sql;
}
