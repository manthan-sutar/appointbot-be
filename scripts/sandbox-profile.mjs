/**
 * Apply db/patches/sandbox_demo_profile.sql (staff, services, hours for demo-sandbox).
 */
import "dotenv/config";
import { execFileSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sql = path.join(__dirname, "..", "db", "patches", "sandbox_demo_profile.sql");
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}
execFileSync("psql", [url, "-v", "ON_ERROR_STOP=1", "-f", sql], { stdio: "inherit" });
