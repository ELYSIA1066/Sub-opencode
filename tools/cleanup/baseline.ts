import { createHash, randomUUID } from "node:crypto";
import { lstatSync, promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..", "..");

const DIR_TARGETS = ["src", "test", "tools"];
const FILE_TARGETS = [
  "README.md",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "vitest.config.ts",
];

// Directories never traversed. `work` holds cleanup output itself.
const EXCLUDED_DIR_NAMES = new Set(["node_modules", "work", ".git"]);

// Database artifacts that must never enter the baseline.
const DB_EXTENSIONS = new Set([
  ".db",
  ".db3",
  ".sqlite",
  ".sqlite3",
  ".sqlite3-journal",
  ".mdb",
  ".accdb",
  ".ldb",
  ".sdf",
]);

// Authentication / credential artifacts that must never enter the baseline.
const AUTH_EXTENSIONS = new Set([
  ".pem",
  ".key",
  ".p12",
  ".pfx",
  ".jks",
  ".keystore",
  ".der",
]);

const AUTH_FILENAMES = new Set([
  ".env",
  ".npmrc",
  ".netrc",
  ".htpasswd",
  "credentials",
  "credentials.json",
  "auth.json",
  "secrets.json",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
]);

function isExcludedFile(name: string): boolean {
  const lower = name.toLowerCase();
  const ext = path.extname(lower);
  if (DB_EXTENSIONS.has(ext)) return true;
  if (AUTH_EXTENSIONS.has(ext)) return true;
  if (AUTH_FILENAMES.has(lower)) return true;
  if (lower === ".env" || lower.startsWith(".env.")) return true;
  return false;
}

function toPosix(rel: string): string {
  return rel.split(path.sep).join("/");
}

const files: string[] = [];

async function collect(relTarget: string): Promise<void> {
  const absTarget = path.join(projectRoot, relTarget);

  let st;
  try {
    st = lstatSync(absTarget);
  } catch {
    return;
  }

  // Skip symbolic links entirely.
  if (st.isSymbolicLink()) return;

  if (st.isDirectory()) {
    const entries = await fs.readdir(absTarget, { withFileTypes: true });
    for (const entry of entries) {
      const childRel = path.join(relTarget, entry.name);
      const childAbs = path.join(absTarget, entry.name);

      let childSt;
      try {
        childSt = lstatSync(childAbs);
      } catch {
        continue;
      }

      if (childSt.isSymbolicLink()) continue;

      if (childSt.isDirectory()) {
        if (EXCLUDED_DIR_NAMES.has(entry.name.toLowerCase())) continue;
        await collect(childRel);
      } else if (childSt.isFile()) {
        if (isExcludedFile(entry.name)) continue;
        files.push(childRel);
      }
    }
    return;
  }

  if (st.isFile()) {
    if (!isExcludedFile(path.basename(relTarget))) files.push(relTarget);
  }
}

async function main(): Promise<void> {
  for (const target of DIR_TARGETS) await collect(target);
  for (const target of FILE_TARGETS) await collect(target);

  // Deterministic ordering, project-relative POSIX paths only.
  const relativeFiles = files.map(toPosix).sort((a, b) => a.localeCompare(b));

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const runId = `${stamp}-${randomUUID()}`;

  const baselineDir = path.join(projectRoot, "work", "cleanup", runId, "baseline");
  await fs.mkdir(baselineDir, { recursive: true });

  const manifestFiles: Array<{ path: string; bytes: number; sha256: string }> = [];

  for (const rel of relativeFiles) {
    const srcAbs = path.join(projectRoot, rel);
    const destAbs = path.join(baselineDir, ...rel.split("/"));

    await fs.mkdir(path.dirname(destAbs), { recursive: true });
    await fs.copyFile(srcAbs, destAbs);

    const content = await fs.readFile(srcAbs);
    manifestFiles.push({
      path: rel,
      bytes: content.length,
      sha256: createHash("sha256").update(content).digest("hex"),
    });
  }

  const manifest = {
    runId,
    createdAt: new Date().toISOString(),
    algorithm: "sha256",
    baseDir: "baseline",
    fileCount: manifestFiles.length,
    files: manifestFiles,
  };

  const manifestPath = path.join(baselineDir, "manifest.json");
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");

  process.stdout.write(
    JSON.stringify(
      {
        runId,
        fileCount: manifestFiles.length,
        manifestPath: path.resolve(manifestPath),
      },
      null,
      2,
    ) + "\n",
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
