import { Fragment, type ReactNode } from "react";

function inline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let index = 0;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index));
    const token = match[0];
    if (token.startsWith("`")) {
      nodes.push(<code key={`${keyPrefix}-c-${index++}`}>{token.slice(1, -1)}</code>);
    } else {
      nodes.push(<strong key={`${keyPrefix}-b-${index++}`}>{token.slice(2, -2)}</strong>);
    }
    lastIndex = match.index + token.length;
  }
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}

export function Markdown({ children }: { children: string }): ReactNode {
  const blocks = children.replace(/\r\n/g, "\n").split(/```/);
  return (
    <div className="markdown">
      {blocks.map((block, blockIndex) => {
        if (blockIndex % 2 === 1) {
          const lines = block.split("\n");
          const language = lines[0]?.trim() ?? "";
          const code = language.length > 0 && !language.includes(" ") ? lines.slice(1).join("\n") : block;
          return (
            <pre key={`code-${blockIndex}`} className="code-block">
              {language.length > 0 && !language.includes(" ") ? <span className="code-lang">{language}</span> : null}
              <code>{code.trimEnd()}</code>
            </pre>
          );
        }
        const lines = block.split("\n");
        const rendered: ReactNode[] = [];
        let list: string[] = [];
        const flushList = () => {
          if (list.length === 0) return;
          rendered.push(
            <ul key={`ul-${blockIndex}-${rendered.length}`}>
              {list.map((item, itemIndex) => (
                <li key={itemIndex}>{inline(item, `li-${blockIndex}-${itemIndex}`)}</li>
              ))}
            </ul>,
          );
          list = [];
        };
        for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
          const line = lines[lineIndex] ?? "";
          const trimmed = line.trim();
          const listMatch = /^[-*]\s+(.*)$/.exec(trimmed);
          const numberedMatch = /^\d+\.\s+(.*)$/.exec(trimmed);
          if (listMatch?.[1] !== undefined) {
            list.push(listMatch[1]);
            continue;
          }
          if (numberedMatch?.[1] !== undefined) {
            list.push(numberedMatch[1]);
            continue;
          }
          flushList();
          if (trimmed.length === 0) continue;
          const heading = /^(#{1,4})\s+(.*)$/.exec(trimmed);
          if (heading?.[2] !== undefined) {
            const level = Math.min(4, heading[1]?.length ?? 2);
            const Tag = (`h${level}` as unknown) as "h2";
            rendered.push(<Tag key={`h-${blockIndex}-${lineIndex}`}>{inline(heading[2], `h-${lineIndex}`)}</Tag>);
            continue;
          }
          if (trimmed.startsWith("> ")) {
            rendered.push(
              <blockquote key={`q-${blockIndex}-${lineIndex}`}>{inline(trimmed.slice(2), `q-${lineIndex}`)}</blockquote>,
            );
            continue;
          }
          rendered.push(
            <p key={`p-${blockIndex}-${lineIndex}`}>
              {inline(line, `p-${blockIndex}-${lineIndex}`).map((node, nodeIndex) => (
                <Fragment key={nodeIndex}>{node}</Fragment>
              ))}
            </p>,
          );
        }
        flushList();
        return <Fragment key={`block-${blockIndex}`}>{rendered}</Fragment>;
      })}
    </div>
  );
}
