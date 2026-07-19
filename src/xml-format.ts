const XML_INDENT = "  ";

export function indentXmlLines(value: string, levels = 1): string {
  const prefix = XML_INDENT.repeat(levels);
  return value
    .split("\n")
    .map((line) => (line.trim() ? `${prefix}${line}` : ""))
    .join("\n");
}
