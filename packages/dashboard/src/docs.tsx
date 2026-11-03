// The guides in site/docs/, built into the dashboard: /dashboard/docs/<name> shows one (signed in or not), so a deploy always
// carries the guides for its own version. Each guide is its own chunk, loaded when opened.
import { Marked } from "marked";
import { type ReactNode, useEffect, useState } from "react";
import { Brand, Loading } from "./ui";

const GUIDES = import.meta.glob<string>("../../../site/docs/*.md", {
  query: "?raw",
  import: "default",
});
const load = (name: string) => GUIDES[`../../../site/docs/${name}.md`];
// The guides' screenshots (assets/… in the Markdown), bundled with hashed names so they resolve under /dashboard/docs/.
const ASSETS = import.meta.glob<string>(
  [
    "../../../site/docs/assets/app/*-light.png", // the dark variants are for the public site
    "../../../site/docs/assets/{meta,google}/*.{png,svg,jpg}", // the console steps
  ],
  { eager: true, query: "?url", import: "default" },
);

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** GitHub's heading anchors: "2. A refresh token" → "2-a-refresh-token", "Keys & tokens" → "keys--tokens". */
const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .trim()
    .replace(/\s/g, "-");

const md = new Marked({
  gfm: true,
  renderer: {
    heading({ tokens, depth, text }) {
      return `<h${depth} id="${slug(text)}">${this.parser.parseInline(tokens)}</h${depth}>\n`;
    },
    link({ href, tokens }) {
      const inner = this.parser.parseInline(tokens);
      // Another guide (and its section), a section of this one, a web page; files elsewhere in the repo stay text.
      const guide = /^([\w-]+)\.md(#.*)?$/.exec(href);
      if (guide && load(guide[1])) return `<a href="/dashboard/docs/${guide[1]}${guide[2] ?? ""}">${inner}</a>`;
      if (href.startsWith("#")) return `<a href="${href}">${inner}</a>`;
      if (/^https?:/.test(href)) return `<a href="${href}" target="_blank" rel="noopener noreferrer">${inner}</a>`;
      return inner;
    },
    // An image the bundle doesn't have (a screenshot not taken yet) shows its alt text rather than a broken picture.
    // Not lazy: the screenshot pipeline waits for every image on the page to load.
    image({ href, text }) {
      const url = href.startsWith("assets/") ? ASSETS[`../../../site/docs/${href}`] : undefined;
      if (!url) return escapeHtml(text);
      return `<img src="${url}" alt="${escapeHtml(text)}">`;
    },
  },
});

/** The guide a provider names ("site/docs/youtube.md" → "youtube"). */
export const guideName = (path: string) => /([\w-]+)\.md$/.exec(path)?.[1] ?? "";

/** A link to a guide, in a new tab so the form being filled stays where it is. */
export function GuideLink({ doc, children }: { doc: string; children?: ReactNode }) {
  const name = guideName(doc) || doc;
  if (!load(name)) return <>{children}</>;
  return (
    <a href={`/dashboard/docs/${name}`} target="_blank" rel="noopener">
      {children ?? "Setup guide"}
    </a>
  );
}

export function Guide({ name }: { name: string }) {
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const f = load(name);
    if (!f) {
      setError(`There's no guide called "${name}".`);
      return;
    }
    f()
      .then((text) => {
        setHtml(md.parse(text) as string);
        document.title = `${/^# (.+)$/m.exec(text)?.[1] ?? name} · Bongsu docs`;
      })
      .catch((e: Error) => setError(e.message));
  }, [name]);
  useEffect(() => {
    if (html && location.hash) document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView();
  }, [html]);
  return (
    <div className="docs">
      <header className="docs-head">
        <Brand href="/dashboard/" />
        <a href="/dashboard/docs/README">All guides</a>
      </header>
      {/* The public guides in site/docs/, bundled at build time. */}
      <main>
        {html ? (
          // biome-ignore lint/security/noDangerouslySetInnerHtml: our own docs, not user input
          <article className="prose" dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          <Loading error={error} />
        )}
      </main>
    </div>
  );
}
