const XML_INDENT = "  ";

export function indentXmlLines(value: string, levels = 1): string {
  const prefix = XML_INDENT.repeat(levels);
  return value
    .split("\n")
    .map((line) => (line.trim() ? `${prefix}${line}` : ""))
    .join("\n");
}

export function xmlBlock(
  tag: string,
  content: string,
  attributes = "",
): string {
  return `<${tag}${attributes}>\n${indentXmlLines(content)}\n</${tag}>`;
}
