import * as fs from "node:fs";
import * as path from "node:path";
import matter from "gray-matter";

const base = path.join(
  process.env.HOME || "",
  ".openclaw/plugins/skill-harness/experiences",
);

console.log("Starting migration for:", base);

if (!fs.existsSync(base)) {
  console.log("Experiences directory does not exist, skipping.");
  process.exit(0);
}

const entries = fs.readdirSync(base, { withFileTypes: true });
const skillDirs = entries.filter((d) => d.isDirectory());

let migratedCount = 0;
const errors = [];

// Phase 1: Read all legacy markdown files
const pendingMigrations = [];

for (const dir of skillDirs) {
  const dirPath = path.join(base, dir.name);
  const files = fs
    .readdirSync(dirPath, { withFileTypes: true })
    .filter((f) => f.isFile() && f.name.endsWith(".md"));

  for (const file of files) {
    const fullPath = path.join(dirPath, file.name);
    const entryId = file.name.slice(0, -".md".length);

    try {
      const raw = fs.readFileSync(fullPath, "utf8");
      const parsed = matter(raw);

      const skill =
        typeof parsed.data.skill === "string"
          ? parsed.data.skill.trim()
          : dir.name;
      const summary =
        typeof parsed.data.summary === "string"
          ? parsed.data.summary.trim()
          : "";
      const rawKeywords = Array.isArray(parsed.data.keywords)
        ? parsed.data.keywords
        : [];
      const keywords = rawKeywords
        .filter((k) => typeof k === "string" && k.trim())
        .map((k) => k.trim());
      const body = parsed.content.trim();

      if (!summary) throw new Error(`Missing summary in ${fullPath}`);
      if (keywords.length === 0)
        throw new Error(`Missing keywords in ${fullPath}`);
      if (!body) throw new Error(`Empty body in ${fullPath}`);

      pendingMigrations.push({
        oldPath: fullPath,
        skillDir: dirPath,
        id: entryId,
        skill,
        summary,
        keywords,
        body,
      });
    } catch (err) {
      errors.push({
        file: fullPath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

if (errors.length > 0) {
  console.error("Errors found during scan, aborting migration:", errors);
  process.exit(1);
}

console.log(`Scanned ${pendingMigrations.length} files successfully. Writing new folder structures...`);

// Temporary directory to stage all migrated folders
const tempStage = path.join(base, "__staging_migration__");
if (fs.existsSync(tempStage)) {
  fs.rmSync(tempStage, { recursive: true, force: true });
}
fs.mkdirSync(tempStage, { recursive: true });

for (const item of pendingMigrations) {
  const targetDir = path.join(tempStage, item.id);
  if (fs.existsSync(targetDir)) {
    throw new Error(`Duplicate entry id detected: ${item.id}`);
  }
  fs.mkdirSync(targetDir, { recursive: true });

  // Write summary.md
  fs.writeFileSync(path.join(targetDir, "summary.md"), `${item.summary}\n`, "utf8");

  // Write keywords.md
  const keywordsText = item.keywords.map((k) => `- ${k}`).join("\n");
  fs.writeFileSync(path.join(targetDir, "keywords.md"), `${keywordsText}\n`, "utf8");

  // Write body.md
  fs.writeFileSync(path.join(targetDir, "body.md"), `${item.body}\n`, "utf8");

  // Write skills.md
  if (item.skill) {
    fs.writeFileSync(path.join(targetDir, "skills.md"), `- ${item.skill}\n`, "utf8");
  } else {
    fs.writeFileSync(path.join(targetDir, "skills.md"), "", "utf8");
  }
}

// Phase 2: Remove old skill directories
for (const dir of skillDirs) {
  const dirPath = path.join(base, dir.name);
  fs.rmSync(dirPath, { recursive: true, force: true });
}

// Phase 3: Move all staged folders to base
const stagedFolders = fs.readdirSync(tempStage, { withFileTypes: true });
for (const folder of stagedFolders) {
  const src = path.join(tempStage, folder.name);
  const dest = path.join(base, folder.name);
  fs.renameSync(src, dest);
  migratedCount++;
}

fs.rmSync(tempStage, { recursive: true, force: true });

console.log(`Successfully migrated ${migratedCount} experiences to folder format!`);
