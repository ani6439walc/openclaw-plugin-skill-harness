const MAX_QMD_QUERY_BYTES = 8_192;
const QUERY_TRUNCATION_MARKER = "\n…\n";

export function boundQmdQuery(query: string): string {
  if (Buffer.byteLength(query, "utf8") <= MAX_QMD_QUERY_BYTES) return query;

  const codePoints = Array.from(query);
  const sideBudget = Math.floor(
    (MAX_QMD_QUERY_BYTES - Buffer.byteLength(QUERY_TRUNCATION_MARKER, "utf8")) /
      2,
  );
  let headEnd = 0;
  let headBytes = 0;
  while (headEnd < codePoints.length) {
    const nextBytes = Buffer.byteLength(codePoints[headEnd] ?? "", "utf8");
    if (headBytes + nextBytes > sideBudget) break;
    headBytes += nextBytes;
    headEnd += 1;
  }

  let tailStart = codePoints.length;
  let tailBytes = 0;
  while (tailStart > headEnd) {
    const nextBytes = Buffer.byteLength(
      codePoints[tailStart - 1] ?? "",
      "utf8",
    );
    if (tailBytes + nextBytes > sideBudget) break;
    tailBytes += nextBytes;
    tailStart -= 1;
  }

  return `${codePoints.slice(0, headEnd).join("")}${QUERY_TRUNCATION_MARKER}${codePoints.slice(tailStart).join("")}`;
}
