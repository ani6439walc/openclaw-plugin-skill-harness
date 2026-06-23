import * as fs from "node:fs";
import * as path from "node:path";
import matter from "gray-matter";
import { IntentCatalog } from "./intent-loader.js";

const STANDARD_SECTIONS = [
  "Guidelines",
  "Skills & Tools",
  "Response Strategy",
  "Concrete Workflow",
  "Experience",
];

export type IntentValidationResult = {
  valid: boolean;
  errors: string[];
  intents: Array<{ id: string; file: string }>;
};

export function validateIntentDirectory(
  intentDirectory: string,
  targetIntentIds: readonly string[] = [],
): IntentValidationResult {
  const errors: string[] = [];
  const intents: Array<{ id: string; file: string }> = [];
  const seenIds = new Map<string, string>();
  const files = fs.existsSync(intentDirectory)
    ? fs
        .readdirSync(intentDirectory)
        .filter((file) => file.endsWith(".md"))
        .sort()
    : [];

  if (files.length === 0)
    errors.push(`no intent Markdown files found in ${intentDirectory}`);

  for (const file of files) {
    const filePath = path.join(intentDirectory, file);
    try {
      const parsed = matter(fs.readFileSync(filePath, "utf-8"));
      const data = parsed.data as Record<string, unknown>;
      const id = file.slice(0, -".md".length);
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
      const domainRaw = data.domain;
      const keywordsRaw = data.keywords;
      const body = parsed.content.trim();

      for (const staleField of ["id", "name", "enabled"]) {
        if (staleField in data) {
          errors.push(`${file}: stale frontmatter field ${staleField}`);
        }
      }
      if (triggers.length === 0)
        errors.push(`${file}: triggers must contain at least one string`);
      if (examples.length === 0)
        errors.push(`${file}: examples must contain at least one string`);
      if (typeof domainRaw !== "string" || !domainRaw.trim()) {
        errors.push(`${file}: domain must be a non-empty string`);
      }
      if (
        keywordsRaw !== undefined &&
        (!Array.isArray(keywordsRaw) ||
          keywordsRaw.some(
            (value) => typeof value !== "string" || !value.trim(),
          ))
      ) {
        errors.push(`${file}: keywords must contain only non-empty strings`);
      }
      if (!body) errors.push(`${file}: Markdown body is empty`);

      const key = id.toLowerCase();
      const duplicate = seenIds.get(key);
      if (duplicate)
        errors.push(
          `${file}: duplicate intent id ${id} already used by ${duplicate}`,
        );
      else seenIds.set(key, file);
      intents.push({ id, file });

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

  const available = new Set(intents.map((intent) => intent.id));
  for (const target of targetIntentIds) {
    if (!available.has(target))
      errors.push(`target intent not found: ${target}`);
  }

  try {
    const catalog = IntentCatalog.create(path.dirname(intentDirectory));
    catalog.load(path.basename(intentDirectory), { silent: true });
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
