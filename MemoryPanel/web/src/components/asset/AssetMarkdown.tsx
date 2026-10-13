/**
 * AssetMarkdown —— Unified Markdown rendering component for asset pages.
 *
 * Consolidated from WikiSourcesPanel / CodeSourcesPanel: each side previously had its own copy-pasted
 * mdComponents, now consolidated here to avoid diverging again.
 *
 * Two densities (component library version differences):
 *   - default: larger font sizes used for Wiki detail body (text-sm / text-lg)
 *   - compact: compact font sizes used for Code detail search/explore results (text-[11px]~[13px])
 * Passing compact switches to the original Code-side styles, so neither page regresses visually.
 */
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

/** Wiki detail body density (default) */
export const mdComponents: Components = {
  h1: ({ children, ...p }) => (
    <h1 className="text-xl font-bold mb-3 mt-0 pb-2 border-b border-border text-foreground" {...p}>
      {children}
    </h1>
  ),
  h2: ({ children, ...p }) => (
    <h2 className="text-lg font-semibold mb-2 mt-6 text-foreground/85" {...p}>
      {children}
    </h2>
  ),
  h3: ({ children, ...p }) => (
    <h3 className="text-base font-semibold mb-1.5 mt-4 text-foreground/85" {...p}>
      {children}
    </h3>
  ),
  h4: ({ children, ...p }) => (
    <h4 className="text-sm font-semibold mb-1 mt-3 text-foreground/85" {...p}>
      {children}
    </h4>
  ),
  p: ({ children, ...p }) => (
    <p className="text-sm leading-relaxed mb-3 text-foreground/70" {...p}>
      {children}
    </p>
  ),
  ul: ({ children, ...p }) => (
    <ul className="text-sm list-disc pl-5 mb-3 space-y-1 text-foreground/70" {...p}>
      {children}
    </ul>
  ),
  ol: ({ children, ...p }) => (
    <ol className="text-sm list-decimal pl-5 mb-3 space-y-1 text-foreground/70" {...p}>
      {children}
    </ol>
  ),
  li: ({ children, ...p }) => (
    <li className="text-sm leading-relaxed" {...p}>
      {children}
    </li>
  ),
  code: ({ children, className, ...p }) => {
    if (className?.includes('language-'))
      return (
        <pre className="rounded-lg bg-muted p-4 text-xs font-mono overflow-x-auto my-3 border border-border">
          <code {...p}>{children}</code>
        </pre>
      );
    return (
      <code className="rounded bg-muted px-1.5 py-0.5 text-xs font-mono" {...p}>
        {children}
      </code>
    );
  },
  pre: ({ children, ...p }) => (
    <div {...(p as React.HTMLAttributes<HTMLDivElement>)}>{children}</div>
  ),
  hr: () => <hr className="my-5 border-border" />,
  strong: ({ children, ...p }) => (
    <strong className="font-semibold text-foreground/85" {...p}>
      {children}
    </strong>
  ),
  a: ({ children, href, ...p }) => (
    <a
      className="text-primary underline underline-offset-2 hover:text-primary/80"
      href={href}
      {...p}
    >
      {children}
    </a>
  ),
  blockquote: ({ children, ...p }) => (
    <blockquote
      className="border-l-[3px] border-primary/40 pl-4 italic text-muted-foreground my-3"
      {...p}
    >
      {children}
    </blockquote>
  ),
  table: ({ children, ...p }) => (
    <div className="overflow-x-auto my-3">
      <table className="w-full text-xs border-collapse border border-border" {...p}>
        {children}
      </table>
    </div>
  ),
  th: ({ children, ...p }) => (
    <th className="border border-border px-3 py-2 bg-muted text-left text-xs font-semibold" {...p}>
      {children}
    </th>
  ),
  td: ({ children, ...p }) => (
    <td className="border border-border px-3 py-2 text-xs" {...p}>
      {children}
    </td>
  ),
};

/** Code detail search/explore result density (compact, original CodeSourcesPanel implementation) */
const mdComponentsCompact: Components = {
  h2: ({ children, ...p }) => (
    <h2 className="text-[13px] font-semibold mb-2 mt-4 text-foreground/85" {...p}>
      {children}
    </h2>
  ),
  h3: ({ children, ...p }) => (
    <h3 className="text-[12px] font-semibold mb-1 mt-3 font-mono text-foreground/85" {...p}>
      {children}
    </h3>
  ),
  p: ({ children, ...p }) => (
    <p className="text-[12px] text-muted-foreground mb-2 leading-relaxed" {...p}>
      {children}
    </p>
  ),
  ul: ({ children, ...p }) => (
    <ul className="text-[12px] text-muted-foreground list-disc pl-4 mb-2 space-y-0.5" {...p}>
      {children}
    </ul>
  ),
  ol: ({ children, ...p }) => (
    <ol className="text-[12px] text-muted-foreground list-decimal pl-4 mb-2 space-y-0.5" {...p}>
      {children}
    </ol>
  ),
  li: ({ children, ...p }) => (
    <li className="text-[12px]" {...p}>
      {children}
    </li>
  ),
  code: ({ children, className, ...p }) => {
    if (className?.includes('language-'))
      return (
        <pre className="rounded-lg bg-muted p-3 text-[11px] font-mono overflow-x-auto my-2 border border-border">
          <code {...p}>{children}</code>
        </pre>
      );
    return (
      <code className="rounded bg-muted px-1 py-0.5 text-[11px] font-mono" {...p}>
        {children}
      </code>
    );
  },
  pre: ({ children, ...p }) => (
    <div {...(p as React.HTMLAttributes<HTMLDivElement>)}>{children}</div>
  ),
  hr: () => <hr className="my-3 border-border" />,
  strong: ({ children, ...p }) => (
    <strong className="font-semibold text-foreground/85" {...p}>
      {children}
    </strong>
  ),
  table: ({ children, ...p }) => (
    <div className="overflow-x-auto my-2">
      <table className="w-full text-[11px] border-collapse border border-border" {...p}>
        {children}
      </table>
    </div>
  ),
  th: ({ children, ...p }) => (
    <th
      className="border border-border px-2 py-1.5 bg-muted text-left text-[11px] font-semibold"
      {...p}
    >
      {children}
    </th>
  ),
  td: ({ children, ...p }) => (
    <td className="border border-border px-2 py-1.5 text-[11px]" {...p}>
      {children}
    </td>
  ),
};

/** Render a piece of Markdown body (unified gfm plugin + shared styles; compact is for the small-font Code detail scenario) */
export function AssetMarkdown({ content, compact = false }: { content: string; compact?: boolean }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={compact ? mdComponentsCompact : mdComponents}>
      {content}
    </ReactMarkdown>
  );
}
