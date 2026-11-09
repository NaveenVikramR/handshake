// A small markdown subset for the shopkeeper assistant's replies: paragraphs, bullet and numbered
// lists, **bold**, *italic* and `code`. It builds React elements only (never innerHTML), so a model
// reply can't inject markup or links. Plain createElement keeps it testable without a JSX transform.
import { createElement as h, type ReactNode } from "react";

const INLINE = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*|_[^_\s][^_]*_)/g;

export function inline(text: string): ReactNode[] {
  return text.split(INLINE).map((part, i) => {
    if (part.length > 4 && part.startsWith("**") && part.endsWith("**")) return h("strong", { key: i }, part.slice(2, -2));
    if (part.length > 2 && part.startsWith("`") && part.endsWith("`")) return h("code", { key: i }, part.slice(1, -1));
    if (part.length > 2 && /^([*_]).+\1$/.test(part)) return h("em", { key: i }, part.slice(1, -1));
    return part;
  });
}

type Block = { kind: "p" | "ul" | "ol"; lines: string[] };

function blocks(text: string): Block[] {
  const out: Block[] = [];
  for (const raw of text.replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.trim();
    const kind = /^[-*•]\s+/.test(line) ? "ul" : /^\d+[.)]\s+/.test(line) ? "ol" : line ? "p" : null;
    if (!kind) {
      out.push({ kind: "p", lines: [] });
      continue;
    }
    const content = kind === "p" ? line.replace(/^#{1,6}\s+/, "") : line.replace(/^([-*•]|\d+[.)])\s+/, "");
    const last = out.at(-1);
    if (last && last.kind === kind && (kind !== "p" || last.lines.length > 0)) last.lines.push(content);
    else out.push({ kind, lines: [content] });
  }
  return out.filter((b) => b.lines.length > 0);
}

export function Markdown({ text }: { text: string }) {
  return h(
    "div",
    { className: "md" },
    blocks(text).map((b, i) =>
      b.kind === "p"
        ? h("p", { key: i }, b.lines.flatMap((l, j) => (j === 0 ? inline(l) : [h("br", { key: `b${j}` }), ...inline(l)])))
        : h(b.kind, { key: i }, b.lines.map((l, j) => h("li", { key: j }, inline(l)))),
    ),
  );
}
