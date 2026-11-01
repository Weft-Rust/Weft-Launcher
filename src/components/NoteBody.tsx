import { ReactNode } from "react";

// `**bold**` and `code`: the only inline marks release notes use.
function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/).map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      return <strong key={i}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      return <code key={i}>{part.slice(1, -1)}</code>;
    }
    return part;
  });
}

/** Release notes as written on GitHub: just enough Markdown not to show its marks. */
export function NoteBody({ text }: { text: string }) {
  return (
    <>
      {text.split(/\r?\n/).map((line, i) => {
        const heading = line.match(/^#{1,6}\s+(.*)$/);
        if (heading) return <h3 key={i}>{inline(heading[1])}</h3>;
        const item = line.match(/^\s*[-*]\s+(.*)$/);
        if (item) return <p key={i} className="note-item">{inline(item[1])}</p>;
        if (!line.trim()) return <p key={i} className="note-gap" />;
        return <p key={i}>{inline(line)}</p>;
      })}
    </>
  );
}
