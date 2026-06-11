import * as fs from "node:fs";
import * as path from "node:path";
import matter from "gray-matter";
import { IntentCatalog } from "./intent-loader.js";

const STANDARD_SECTIONS = [
  "Guidelines",
  "Skills & Tools",
  "Response Strategy",
  "Concrete Workflow",
];

export type IntentValidationResult = {
  valid: boolean;
  errors: string[];
  intents: Array<{ id: string; file: string }>;
};

export function validateIntentDirectory(
  intentsDir: string,
  targetIntentIds: readonly string[] = [],
): IntentValidationResult {
  const errors: string[] = [];
  const intents: Array<{ id: string; file: string }> = [];
  const seenIds = new Map<string, string>();
  const files = fs.existsSync(intentsDir)
    ? fs
        .readdirSync(intentsDir)
        .filter((file) => file.endsWith(".md"))
        .sort()
    : [];

  if (files.length === 0)
    errors.push(`no intent Markdown files found in ${intentsDir}`);

  for (const file of files) {
    const filePath = path.join(intentsDir, file);
    try {
      const parsed = matter(fs.readFileSync(filePath, "utf-8"));
      const data = parsed.data as Record<string, unknown>;
      const id = typeof data.id === "string" ? data.id.trim() : "";
      const name = typeof data.name === "string" ? data.name.trim() : "";
      const triggers = Array.isArray(data.triggers)
        ? data.triggers.filter(
            (value): value is string =>
              typeof value === "string" && !!value.trim(),
          )
        : [];
      const examples = Array.isArray(data.examples)
        ? data.examples.filter(
            (value): value is string =>
              typeof value === "string" && !!value.trim(),
          )
        : [];
      const body = parsed.content.trim();

      if (!id) errors.push(`${file}: missing frontmatter id`);
      if (!name) errors.push(`${file}: missing frontmatter name`);
      if (triggers.length === 0)
        errors.push(`${file}: triggers must contain at least one string`);
      if (examples.length === 0)
        errors.push(`${file}: examples must contain at least one string`);
      if (!body) errors.push(`${file}: Markdown body is empty`);

      if (id) {
        const key = id.toLowerCase();
        const duplicate = seenIds.get(key);
        if (duplicate)
          errors.push(
            `${file}: duplicate intent id ${id} already used by ${duplicate}`,
          );
        else seenIds.set(key, file);
        intents.push({ id, file });
      }

      const headings = [...body.matchAll(/^## (.+)$/gm)].map((match) =>
        match[1].trim(),
      );
      for (const section of STANDARD_SECTIONS) {
        if (headings.filter((heading) => heading === section).length > 1) {
          errors.push(`${file}: duplicate ## ${section} section`);
        }
      }
      for (const required of ["Guidelines", "Response Strategy"]) {
        if (!headings.includes(required))
          errors.push(`${file}: missing ## ${required} section`);
      }
      const ordered = headings.filter((heading) =>
        STANDARD_SECTIONS.includes(heading),
      );
      const indexes = ordered.map((heading) =>
        STANDARD_SECTIONS.indexOf(heading),
      );
      if (
        indexes.some((value, index) => index > 0 && value < indexes[index - 1])
      ) {
        errors.push(`${file}: standard sections are out of order`);
      }
    } catch (error) {
      errors.push(
        `${file}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const available = new Set(intents.map((intent) => intent.id.toLowerCase()));
  for (const target of targetIntentIds) {
    if (!available.has(target.toLowerCase()))
      errors.push(`target intent not found: ${target}`);
  }

  try {
    const catalog = IntentCatalog.create(path.dirname(intentsDir));
    catalog.load(path.basename(intentsDir), { silent: true });
    if (catalog.count !== intents.length) {
      errors.push(
        `intent catalog loaded ${catalog.count} of ${intents.length} parsed intent definitions`,
      );
    }
  } catch (error) {
    errors.push(
      `intent catalog load failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return { valid: errors.length === 0, errors, intents };
}
