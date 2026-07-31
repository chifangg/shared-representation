import ReactMarkdown, { type Options } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

/**
 * Shared markdown renderer for assistant text. Styling comes from the
 * `.prose` classes already defined in `src/styles.css` — tables, code
 * blocks, links, blockquotes, and lists all pick them up.
 *
 * GFM plugin adds tables, task lists, strikethrough, and autolinks.
 * Anything beyond that (math, mermaid, custom components) is a fork
 * concern — pass `components` or additional `remarkPlugins` via props.
 */
/** Module constant, NOT an inline literal. A fresh `[remarkGfm]` array on
 *  every render changes the prop identity, which defeats react-markdown's
 *  memoization and re-parses the whole message through remark each time. */
const REMARK_PLUGINS = [remarkGfm];

export function Markdown({
  children,
  className,
  components,
  ...rest
}: Omit<Options, "children"> & {
  children: string;
  className?: string;
}) {
  return (
    <div className={cn("prose prose-sm max-w-none", className)}>
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={components} {...rest}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
