import type { ReactNode } from "react";
import { looksLikeSourceFile } from "@bando/core/targets";

/** Returns a click handler when inline code names something navigable (a file, folder or symbol). */
export type LinkResolver = (code: string) => (() => void) | undefined;

interface ListState {
  ordered: boolean;
  start: number;
  items: string[];
}

/**
 * Renders the Markdown subset the summaries use (headings, lists, paragraphs, fenced code,
 * **bold**, *italic*, `code`) as React elements, so model output is never injected as HTML.
 */
export function Markdown({ text, resolveLink }: { text: string; resolveLink?: LinkResolver }) {
  const inline = (value: string) => renderInline(value, resolveLink);
  const blocks: ReactNode[] = [];
  let list: ListState | undefined;
  let paragraph: string[] = [];
  let fence: string[] | undefined;
  // A blank line ends a paragraph, but a list only ends if something other than an item follows.
  let blankAfterList = false;

  const flushParagraph = () => {
    if (paragraph.length) blocks.push(<p key={blocks.length}>{inline(paragraph.join(" "))}</p>);
    paragraph = [];
  };
  const flushList = () => {
    if (!list) return;
    const items = list.items.map((item, i) => <li key={i}>{inline(item)}</li>);
    blocks.push(
      list.ordered ? (
        <ol key={blocks.length} start={list.start}>
          {items}
        </ol>
      ) : (
        <ul key={blocks.length}>{items}</ul>
      ),
    );
    list = undefined;
  };

  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();

    if (fence) {
      if (/^\s*```/.test(line)) {
        blocks.push(
          <pre key={blocks.length} className="code">
            {fence.join("\n")}
          </pre>,
        );
        fence = undefined;
      } else fence.push(raw);
      continue;
    }
    if (/^\s*```/.test(line) && !/```.*```/.test(line)) {
      flushParagraph();
      flushList();
      fence = [];
      continue;
    }

    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\s*(\d+)[.)]\s+(.*)$/.exec(line);

    if (!line.trim()) {
      flushParagraph();
      if (list) blankAfterList = true;
      continue;
    }
    if (bullet || numbered) {
      const ordered = Boolean(numbered);
      flushParagraph();
      if (list && list.ordered !== ordered) flushList();
      list ??= { ordered, start: numbered ? Number(numbered[1]) : 1, items: [] };
      list.items.push(numbered ? numbered[2]! : bullet![1]!);
      blankAfterList = false;
      continue;
    }
    if (list && !blankAfterList && /^\s+/.test(raw)) {
      // Continuation of the previous list item.
      list.items[list.items.length - 1] += ` ${line.trim()}`;
      continue;
    }
    flushList();
    blankAfterList = false;
    if (heading) blocks.push(<h4 key={blocks.length}>{inline(heading[1]!)}</h4>);
    else paragraph.push(line.trim());
  }
  if (fence) {
    blocks.push(
      <pre key={blocks.length} className="code">
        {fence.join("\n")}
      </pre>,
    );
  }
  flushParagraph();
  flushList();
  return <div className="markdown">{blocks}</div>;
}

const INLINE = /(```[^`]+```|`[^`]+`|\*\*.+?\*\*|\*[^*\s][^*]*\*|\b_[^_\s][^_]*_\b)/g;

function renderInline(text: string, resolveLink: LinkResolver | undefined): ReactNode[] {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    const token = match[0];
    const key = parts.length;
    if (token.startsWith("```")) {
      // Fenced code written on a single line: "```bash npm install```".
      parts.push(<code key={key}>{token.slice(3, -3).replace(/^(bash|sh|shell|console)\s+/, "").trim()}</code>);
    } else if (token.startsWith("`")) {
      parts.push(codeSpan(token.slice(1, -1), key, resolveLink));
    } else if (token.startsWith("**")) {
      parts.push(<strong key={key}>{renderInline(token.slice(2, -2), resolveLink)}</strong>);
    } else {
      parts.push(<em key={key}>{renderInline(token.slice(1, -1), resolveLink)}</em>);
    }
    last = match.index + token.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

function codeSpan(code: string, key: number, resolveLink: LinkResolver | undefined): ReactNode {
  const onClick = resolveLink?.(code);
  if (!onClick) {
    // A file path we can't resolve was most likely invented by the model.
    const missing = resolveLink && looksLikeSourceFile(code.trim());
    return missing ? (
      <code key={key} className="missing-ref" title="Este archivo no existe en el proyecto analizado">
        {code}
      </code>
    ) : (
      <code key={key}>{code}</code>
    );
  }
  return (
    <button key={key} className="code-link" onClick={onClick} title="Ir a…">
      <code>{code}</code>
    </button>
  );
}
