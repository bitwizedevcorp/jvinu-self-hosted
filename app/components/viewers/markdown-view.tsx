"use client";

import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Markdown as GitHub shows it — tables, task lists, strikethrough — with raw HTML left out,
 * so a README in a bucket can't run anything here. Relative links and images resolve inside
 * the folder: images load through this app, links to files open them.
 */
export function MarkdownView({
  source,
  connectionId,
  folder,
  onOpenKey,
}: {
  source: string;
  connectionId: string;
  /** The folder the file sits in, "a/b/" — relative paths start here. */
  folder: string;
  /** A relative link to another file or folder in the bucket was clicked. */
  onOpenKey?: (key: string) => void;
}) {
  const resolve = (href: string): string | null => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("#") || href.startsWith("//")) return null;
    const parts = (href.startsWith("/") ? href.slice(1) : folder + href).split("/");
    const out: string[] = [];
    for (const part of parts) {
      if (part === "..") out.pop();
      else if (part !== "." && part !== "") out.push(part);
    }
    const trailing = href.endsWith("/") ? "/" : "";
    return out.join("/") + trailing;
  };

  return (
    <div className="markdown-view text-[14px] leading-relaxed text-ink">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={(url) => defaultUrlTransform(url)}
        components={{
          a: ({ href = "", children }) => {
            const key = resolve(href);
            if (key !== null && onOpenKey) {
              return (
                <a
                  href="#"
                  onClick={(event) => {
                    event.preventDefault();
                    onOpenKey(key);
                  }}
                >
                  {children}
                </a>
              );
            }
            return (
              <a href={href} target="_blank" rel="noreferrer noopener">
                {children}
              </a>
            );
          },
          img: ({ src = "", alt = "" }) => {
            const raw = typeof src === "string" ? src : "";
            const key = resolve(raw);
            // Images from elsewhere aren't loaded: fetching one would tell its owner who opened
            // this file, and when (a tracking pixel). They're offered as a link instead.
            if (key === null) {
              return /^https?:\/\//i.test(raw) ? (
                <a href={raw} target="_blank" rel="noreferrer noopener" title={raw}>
                  [external image{alt ? `: ${alt}` : ""}]
                </a>
              ) : null;
            }
            // eslint-disable-next-line @next/next/no-img-element -- images from the bucket, through this app
            return <img src={`/api/connections/${connectionId}/object?key=${encodeURIComponent(key)}`} alt={alt} loading="lazy" />;
          },
        }}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}
