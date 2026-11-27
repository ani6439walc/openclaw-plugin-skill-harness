import matter from "gray-matter";

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

function rejectUnsupportedFormat(): never {
  throw new Error("Unsupported frontmatter format");
}

const DISABLED_NON_YAML_ENGINES = {
  javascript: { parse: rejectUnsupportedFormat },
  js: { parse: rejectUnsupportedFormat },
  json: { parse: rejectUnsupportedFormat },
  coffee: { parse: rejectUnsupportedFormat },
  coffeescript: { parse: rejectUnsupportedFormat },
  cson: { parse: rejectUnsupportedFormat },
};

export interface ParsedFrontmatter {
  data: Record<string, unknown>;
  content: string;
}

/**
 * Parse Markdown YAML frontmatter using only inert YAML loading.
 * Unsupported opening-fence formats (such as `---js` or `---json`) are
 * rejected before parsing so no executable engine can ever run.
 */
export function parseInertYamlFrontmatter(raw: string): ParsedFrontmatter {
  if (!raw.startsWith("---") || raw.startsWith("----")) {
    return { data: {}, content: raw };
  }
  const lineEnd = raw.search(/\r?\n/);
  const headerTag = (lineEnd === -1 ? raw.slice(3) : raw.slice(3, lineEnd))
    .trim()
    .toLowerCase();
  if (headerTag !== "" && headerTag !== "yaml" && headerTag !== "yml") {
    rejectUnsupportedFormat();
  }
  const parsed = matter(raw, {
    language: "yaml",
    engines: DISABLED_NON_YAML_ENGINES,
  });
  if (parsed.data === undefined || parsed.data === null) {
    return { data: {}, content: parsed.content };
  }
  if (!isPlainObject(parsed.data)) {
    throw new Error("Invalid frontmatter data");
  }
  return { data: parsed.data, content: parsed.content };
}
