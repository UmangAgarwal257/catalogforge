import sanitizeHtml from "sanitize-html";

export function cleanDescription(value: string) {
  let meaningfulLoss = false;
  // This is a conservative review detector, not an HTML sanitizer. Include
  // unterminated comments and the HTML parser's alternate --!> terminator.
  // Never promote discarded comment text into supplier claims.
  const discardedComment = [...value.matchAll(/<!--([\s\S]*?)(?:--!?>|$)/g)]
    .some((match) => Boolean(match[1]?.trim()));
  const html = sanitizeHtml(value, {
    allowedTags: ["p", "br", "strong", "em", "ul", "ol", "li"], allowedAttributes: {},
    nonTextTags: ["script", "style", "iframe", "object", "svg", "math", "textarea", "select"],
    transformTags: {
      "*": (tagName, attribs) => {
        // These can carry business meaning that the basic HTML policy cannot retain.
        // Script/style removal and event-handler removal alone are nonblocking.
        if (["iframe", "object", "svg", "math", "textarea", "select", "s", "del", "ins", "sup", "sub", "canvas", "video", "audio", "table", "pre"].includes(tagName) ||
          ["alt", "title", "value", "aria-label", "style"].some((name) => Boolean(attribs[name]?.trim()))) meaningfulLoss = true;
        // Common supplier block wrappers still represent paragraph boundaries.
        if (["div", "section", "article", "blockquote", "h1", "h2", "h3", "h4", "h5", "h6", "dt", "dd"].includes(tagName)) return { tagName: "p", attribs };
        return { tagName: tagName === "b" ? "strong" : tagName === "i" ? "em" : tagName, attribs };
      }
    }
  });
  // Only process already-sanitized markup. Decode the sanitizer's escaped text
  // once, into a text value that must never be inserted as HTML.
  const separated = html.replace(/<br\s*\/?\s*>/g, "\n").replace(/<li>/g, "\n- ").replace(/<\/?(?:p|ul|ol)>|<\/li>/g, "\n");
  const escaped = sanitizeHtml(separated, { allowedTags: [], allowedAttributes: {} });
  const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" };
  const text = escaped.replace(/&(amp|lt|gt|quot|#39);/g, (_, name: string) => entities[name]!)
    .split("\n").map((line) => line.replace(/[\t \u00a0]+/g, " ").trim()).filter(Boolean).join("\n");
  return { html, text, changed: html !== value, meaningfulLoss, discardedComment };
}
