import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown } from "../lib/markdown";

const html = (text: string) => renderToStaticMarkup(createElement(Markdown, { text }));

describe("assistant markdown (lib/markdown.tsx)", () => {
  it("renders bold, italic, code, paragraphs and lists", () => {
    expect(html("The latest order is **ord_4Oc**. Status is *captured*, see `orders.get`.")).toBe(
      '<div class="md"><p>The latest order is <strong>ord_4Oc</strong>. Status is <em>captured</em>, see <code>orders.get</code>.</p></div>',
    );
    expect(html("Orders:\n- one **paid**\n- two\n\n1. first\n2. second")).toBe(
      '<div class="md"><p>Orders:</p><ul><li>one <strong>paid</strong></li><li>two</li></ul><ol><li>first</li><li>second</li></ol></div>',
    );
    expect(html("## Summary\nline one\nline two")).toBe('<div class="md"><p>Summary<br/>line one<br/>line two</p></div>');
  });

  it("never emits markup from the reply: tags and links stay text", () => {
    const out = html('<img src=x onerror=alert(1)> [click](javascript:alert(1)) **<b>x</b>**');
    expect(out).not.toContain("<img");
    expect(out).not.toContain("<a");
    expect(out).not.toContain("<b>");
    expect(out).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });
});
