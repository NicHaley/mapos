import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/main/db.ts",
  dialect: "sqlite",
  dbCredentials: { url: `${process.env.HOME}/Documents/MapOS/.mapos/index.db` },
});
