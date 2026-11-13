"use client";

import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import markdown from "highlight.js/lib/languages/markdown";
import php from "highlight.js/lib/languages/php";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import scss from "highlight.js/lib/languages/scss";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import { useMemo } from "react";

const LANGUAGES = { bash, cpp, csharp, css, dockerfile, go, ini, java, javascript, json, kotlin, markdown, php, python, ruby, rust, scss, sql, swift, typescript, xml, yaml };
for (const [name, language] of Object.entries(LANGUAGES)) hljs.registerLanguage(name, language);

const BY_EXTENSION: Record<string, keyof typeof LANGUAGES> = {
  sh: "bash", bash: "bash", zsh: "bash", fish: "bash",
  c: "cpp", h: "cpp", cc: "cpp", cpp: "cpp", hpp: "cpp",
  cs: "csharp", css: "css", less: "css", scss: "scss",
  dockerfile: "dockerfile", go: "go",
  ini: "ini", cfg: "ini", conf: "ini", toml: "ini", env: "ini", editorconfig: "ini",
  java: "java", kt: "kotlin",
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
  json: "json", jsonl: "json", ndjson: "json", lock: "json",
  md: "markdown", markdown: "markdown",
  php: "php", py: "python", rb: "ruby", rs: "rust", sql: "sql", swift: "swift",
  ts: "typescript", tsx: "typescript",
  xml: "xml", html: "xml", htm: "xml", svg: "xml",
  yml: "yaml", yaml: "yaml",
};

/** The highlighter for a file name, if there is one. */
export function languageOf(name: string): string | null {
  const lower = name.toLowerCase();
  if (lower === "dockerfile" || lower.endsWith(".dockerfile")) return "dockerfile";
  const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : lower;
  return BY_EXTENSION[ext] ?? null;
}

/** Past this, highlighting costs more than it's worth: plain text instead. */
const HIGHLIGHT_LIMIT = 200 * 1024;

/**
 * Text with line numbers, highlighted when the file name says what language it is.
 * highlight.js escapes the source itself, so its HTML is safe to set.
 */
export function CodeView({ text, name, className = "" }: { text: string; name: string; className?: string }) {
  const html = useMemo(() => {
    const language = languageOf(name);
    if (!language || text.length > HIGHLIGHT_LIMIT) return null;
    try {
      return hljs.highlight(text, { language, ignoreIllegals: true }).value;
    } catch {
      return null;
    }
  }, [text, name]);
  const lines = useMemo(() => text.split("\n").length, [text]);

  return (
    <div className={`code-view flex min-w-max font-mono text-[12px] leading-[1.6] ${className}`}>
      <div aria-hidden="true" className="tnum sticky left-0 select-none border-r border-line bg-surface-raised px-3 py-3 text-right text-ink-faint">
        {Array.from({ length: lines }, (_, index) => (
          <div key={index}>{index + 1}</div>
        ))}
      </div>
      {html === null ? (
        <pre className="whitespace-pre px-4 py-3 text-ink">{text}</pre>
      ) : (
        <pre className="hljs whitespace-pre px-4 py-3 text-ink" dangerouslySetInnerHTML={{ __html: html }} />
      )}
    </div>
  );
}
