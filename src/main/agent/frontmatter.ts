/**
 * Frontmatter parser — YAML subset used for SKILL.md and agent .md files.
 *
 * Supports:
 *   - Plain scalars (strings, numbers, true/false)
 *   - Single/double-quoted strings
 *   - Inline arrays: [a, b, "c"]
 *   - Block lists:  - item
 *   - Missing or malformed frontmatter → {data:{}, body:text}
 */

export interface ParsedFrontmatter {
  data: Record<string, unknown>;
  body: string;
}

export function parseFrontmatter(text: string): ParsedFrontmatter {
  const empty = (): ParsedFrontmatter => ({ data: {}, body: text });

  if (!text.startsWith("---")) return empty();

  const end = text.indexOf("\n---", 3);
  if (end === -1) return empty();

  const yamlBlock = text.slice(3, end).replace(/^\n/, "");
  const bodyStart = end + 4; // skip \n---
  const body = text.slice(bodyStart).replace(/^\n/, "");

  try {
    const data = parseYamlSubset(yamlBlock);
    return { data, body };
  } catch {
    return empty();
  }
}

/* -------------------------------------------------------------- YAML subset */

function parseYamlSubset(yaml: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = yaml.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    i++;

    // Skip blank and comment lines
    if (!line.trim() || line.trimStart().startsWith("#")) continue;

    // Block list item under a previous key — shouldn't happen at root, skip
    if (line.trimStart().startsWith("- ")) continue;

    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;

    const key = line.slice(0, colonIdx).trim();
    if (!key) continue;

    const rest = line.slice(colonIdx + 1).trim();

    // Collect any following block list items
    const blockItems: string[] = [];
    while (i < lines.length && lines[i]!.trimStart().startsWith("- ")) {
      const item = lines[i]!.trimStart().slice(2).trim();
      blockItems.push(parseScalar(item));
      i++;
    }

    if (blockItems.length > 0) {
      result[key] = blockItems;
    } else if (rest === "" || rest === null) {
      result[key] = "";
    } else {
      result[key] = parseValue(rest);
    }
  }

  return result;
}

function parseValue(s: string): unknown {
  const t = s.trim();

  // Inline array
  if (t.startsWith("[")) {
    return parseInlineArray(t);
  }

  return parseScalar(t);
}

function parseScalar(s: string): string {
  const t = s.trim();

  // Quoted string
  if ((t.startsWith('"') && t.endsWith('"')) ||
      (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }

  return t;
}

function parseInlineArray(s: string): string[] {
  // Strip outer brackets
  const inner = s.trim();
  if (!inner.startsWith("[") || !inner.endsWith("]")) return [];

  const content = inner.slice(1, -1).trim();
  if (!content) return [];

  const items: string[] = [];
  let current = "";
  let inString = false;
  let stringChar = "";

  for (let i = 0; i < content.length; i++) {
    const ch = content[i]!;

    if (inString) {
      if (ch === stringChar) {
        inString = false;
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      inString = true;
      stringChar = ch;
    } else if (ch === ",") {
      items.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }

  // Last item
  const last = current.trim();
  if (last) items.push(last);

  return items;
}
