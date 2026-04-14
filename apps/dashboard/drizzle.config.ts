import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { defineConfig } from "drizzle-kit";

/**
 * Drizzle Kit runs in plain Node, not inside Electron, so it cannot call `app.getPath("userData")`.
 * Point at the same folder the app uses: set `MAPOS_APP_STATE_DIR`, or rely on the defaults below
 * (they mirror Electron’s `userData` when main calls `app.setName("MapOS")`).
 */
function sqliteDirForDrizzleKit(): string {
  const fromEnv = process.env.MAPOS_APP_STATE_DIR?.trim();
  if (fromEnv) return resolve(fromEnv);
  switch (process.platform) {
    case "darwin":
      return join(homedir(), "Library", "Application Support", "MapOS");
    case "win32":
      return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "MapOS");
    default:
      return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "MapOS");
  }
}

export default defineConfig({
  schema: "./src/main/db.ts",
  dialect: "sqlite",
  dbCredentials: { url: join(sqliteDirForDrizzleKit(), "index.db") }
});
