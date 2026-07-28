/**
 * Kozum Cowork — safe markdown renderer.
 *
 * Builds React elements from parsed tokens. Never uses dangerouslySetInnerHTML.
 * HTML-like content (e.g. `<script>`) is emitted as literal text because React
 * escapes all text node values automatically.
 */

import type { ReactNode } from "react";
import {
  parseMarkdown,
  type BlockToken,
  type InlineToken,
} from "./Markdown.ts";
import styles from "./Markdown.module.css";

// ── Inline renderer ────────────────────────────────────────────────────────

function renderInline(tokens: InlineToken[], key?: string): ReactNode {
  return tokens.map((t, i) => {
    const k = `${key ?? "i"}-${i}`;
    switch (t.type) {
      case "text":
        return t.text;
      case "bold":
        return <strong key={k}>{renderInline(t.children, k)}</strong>;
      case "italic":
        return <em key={k}>{renderInline(t.children, k)}</em>;
      case "inline_code":
        return <code key={k} className={styles.inlineCode}>{t.code}</code>;
      case "link":
        return (
          <a
            key={k}
            href={t.href}
            target="_blank"
            rel="noopener noreferrer"
            className={styles.link}
          >
            {t.text}
          </a>
        );
      default: {
        const _never: never = t;
        void _never;
        return null;
      }
    }
  });
}

// ── Block renderer ─────────────────────────────────────────────────────────

function renderBlock(token: BlockToken, idx: number): ReactNode {
  const k = `b-${idx}`;
  switch (token.type) {
    case "heading": {
      const content = renderInline(token.children, k);
      switch (token.level) {
        case 1: return <h1 key={k} className={styles.h1}>{content}</h1>;
        case 2: return <h2 key={k} className={styles.h2}>{content}</h2>;
        case 3: return <h3 key={k} className={styles.h3}>{content}</h3>;
        case 4: return <h4 key={k} className={styles.h4}>{content}</h4>;
        case 5: return <h5 key={k} className={styles.h5}>{content}</h5>;
        case 6: return <h6 key={k} className={styles.h6}>{content}</h6>;
        default: return <h1 key={k} className={styles.h1}>{content}</h1>;
      }
    }
    case "paragraph":
      return <p key={k} className={styles.p}>{renderInline(token.children, k)}</p>;
    case "code_block":
      return (
        <pre key={k} className={styles.pre}>
          <code className={token.lang ? styles.codeWithLang : undefined} data-lang={token.lang || undefined}>
            {token.code}
          </code>
        </pre>
      );
    case "blockquote":
      return (
        <blockquote key={k} className={styles.blockquote}>
          {token.children.map((child, ci) => renderBlock(child, ci))}
        </blockquote>
      );
    case "list":
      if (token.ordered) {
        return (
          <ol key={k} className={styles.ol}>
            {token.items.map((item, ii) => (
              <li key={ii} className={styles.li}>
                {item.children.map((child, ci) => renderBlock(child, ci))}
              </li>
            ))}
          </ol>
        );
      }
      return (
        <ul key={k} className={styles.ul}>
          {token.items.map((item, ii) => (
            <li key={ii} className={styles.li}>
              {item.children.map((child, ci) => renderBlock(child, ci))}
            </li>
          ))}
        </ul>
      );
    case "hr":
      return <hr key={k} className={styles.hr} />;
    default: {
      const _never: never = token;
      void _never;
      return null;
    }
  }
}

// ── Component ──────────────────────────────────────────────────────────────

interface Props {
  content: string;
  className?: string;
}

export function Markdown({ content, className }: Props) {
  const tokens = parseMarkdown(content);
  return (
    <div className={`${styles.root} ${className ?? ""}`}>
      {tokens.map((t, i) => renderBlock(t, i))}
    </div>
  );
}
