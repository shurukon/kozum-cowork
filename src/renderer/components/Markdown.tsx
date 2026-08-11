/**
 * Kozum Cowork — safe markdown renderer.
 *
 * Builds React elements from parsed tokens. Never uses dangerouslySetInnerHTML.
 * HTML-like content (e.g. `<script>`) is emitted as literal text because React
 * escapes all text node values automatically.
 */

import { useState, useCallback, type ReactNode } from "react";
import { Copy, Check } from "lucide-react";
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
      case "image": {
        // Only render http/https images. file:/javascript:/data: are blocked —
        // a model that read untrusted web data could otherwise load a tracking
        // pixel or a local-file path. The src is displayed as a link fallback.
        const safeSrc = /^https?:\/\//i.test(t.src) ? t.src : "";
        if (!safeSrc) {
          return (
            <span key={k} className={styles.imgFallback} title={t.src}>
              {t.alt || t.src}
            </span>
          );
        }
        return (
          <img
            key={k}
            src={safeSrc}
            alt={t.alt}
            className={styles.inlineImage}
            loading="lazy"
          />
        );
      }
      default: {
        const _never: never = t;
        void _never;
        return null;
      }
    }
  });
}

// ── Block renderer ─────────────────────────────────────────────────────────

// F-2g: code block with copy button + language badge. Renders a header strip
// above the <pre> with the language label (or "text") and a copy button that
// writes the raw code to the clipboard. Falls back to bare <pre> only if the
// clipboard API is unavailable.
function CodeBlock({ code, lang }: { code: string; lang: string }): ReactNode {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard may be unavailable (e.g. insecure context) — silently ignore */
    }
  }, [code]);

  return (
    <div className={styles.codeBlockWrap}>
      <div className={styles.codeBlockHeader}>
        <span className={styles.codeLang}>{lang || "text"}</span>
        <button
          type="button"
          className={styles.copyBtn}
          onClick={handleCopy}
          aria-label={copied ? "Copied" : "Copy code"}
          title={copied ? "Copied" : "Copy code"}
        >
          {copied ? <Check size={12} aria-hidden={true} /> : <Copy size={12} aria-hidden={true} />}
        </button>
      </div>
      <pre className={styles.pre}>
        <code className={lang ? styles.codeWithLang : undefined} data-lang={lang || undefined}>
          {code}
        </code>
      </pre>
    </div>
  );
}

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
      return <CodeBlock key={k} code={token.code} lang={token.lang} />;
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
    case "table": {
      // Map column index → optional alignment for the colgroup / cell style.
      const alignStyle = (a: "left" | "center" | "right" | null): React.CSSProperties =>
        a ? { textAlign: a } : {};
      return (
        <div key={k} className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                {token.header.map((cell, ci) => (
                  <th key={ci} className={styles.th} style={alignStyle(token.align[ci] ?? null)}>
                    {renderInline(cell, `${k}-h-${ci}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {token.rows.map((row, ri) => (
                <tr key={ri}>
                  {row.map((cell, ci) => (
                    <td key={ci} className={styles.td} style={alignStyle(token.align[ci] ?? null)}>
                      {renderInline(cell, `${k}-${ri}-${ci}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    case "task_list":
      return (
        <ul key={k} className={styles.taskList}>
          {token.items.map((item, ii) => (
            <li key={ii} className={styles.taskItem}>
              {/* Static checkbox glyph — NOT a real input, so the user cannot
                  mutate a model-authored list. The `checked` state is visual. */}
              <span
                className={`${styles.taskCheckbox} ${item.checked ? styles.taskChecked : ""}`}
                aria-checked={item.checked}
                role="checkbox"
                aria-label={item.checked ? "Completed" : "Not done"}
              >
                {item.checked ? "\u2713" : ""}
              </span>
              <div className={styles.taskBody}>
                {item.children.map((child, ci) => renderBlock(child, ci))}
              </div>
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
