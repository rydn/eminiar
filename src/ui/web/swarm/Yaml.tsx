import type { JSX } from "preact";
import { cls } from "../util.js";

/** Split a line at its comment (`#` at the start or after a space, outside quotes). */
function splitComment(line: string): [string, string] {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "#" && (i === 0 || line[i - 1] === " "))
      return [line.slice(0, i), line.slice(i)];
  }
  return [line, ""];
}

function scalar(v: string): JSX.Element | string {
  const t = v.trim();
  if (!t) return v;
  const lead = v.slice(0, v.length - v.trimStart().length);
  const tail = v.slice(v.trimEnd().length);
  let c = "";
  if (/^(true|false|null|~|\||>|\|-|>-)$/.test(t)) c = "tok-kw";
  else if (/^-?\d+(\.\d+)?$/.test(t)) c = "tok-num";
  else if (/^\[.*\]$/.test(t) || /^\{.*\}$/.test(t)) c = "tok-pn";
  else c = "tok-str";
  return (
    <>
      {lead}
      <span class={c}>{t}</span>
      {tail}
    </>
  );
}

/**
 * Read-only YAML with line numbers and a light highlight (keys, scalars, comments, block
 * scalars). Enough for the starter file; `marks` flags lines that carry a validation issue.
 */
export function Yaml({ text, marks }: { text: string; marks?: Set<number> }): JSX.Element {
  const lines = text.replace(/\n$/, "").split("\n");
  let blockIndent = -1;
  return (
    <pre class="sw-yaml">
      {lines.map((line, i) => {
        const indent = line.length - line.trimStart().length;
        const n = i + 1;
        let body: JSX.Element | string;
        if (blockIndent >= 0 && (line.trim() === "" || indent > blockIndent)) {
          body = <span class="tok-str">{line}</span>;
        } else {
          blockIndent = -1;
          const [code, comment] = splitComment(line);
          const m = /^(\s*)(- )?([A-Za-z0-9_.-]+)(:)(.*)$/.exec(code);
          if (m) {
            const rest = m[5] ?? "";
            if (/^\s*[|>]-?\s*$/.test(rest)) blockIndent = indent + (m[2] ? 2 : 0);
            body = (
              <>
                {m[1]}
                {m[2] ? <span class="tok-pn">{m[2]}</span> : null}
                <span class="tok-ty">{m[3]}</span>
                <span class="tok-pn">{m[4]}</span>
                {scalar(rest)}
                {comment ? <span class="tok-cm">{comment}</span> : null}
              </>
            );
          } else {
            const item = /^(\s*)(- )(.*)$/.exec(code);
            body = (
              <>
                {item ? (
                  <>
                    {item[1]}
                    <span class="tok-pn">{item[2]}</span>
                    {scalar(item[3] ?? "")}
                  </>
                ) : (
                  code
                )}
                {comment ? <span class="tok-cm">{comment}</span> : null}
              </>
            );
          }
        }
        return (
          <span class={cls("l", marks?.has(n) && "mark")}>
            <span class="ln">{n}</span>
            {body}
          </span>
        );
      })}
    </pre>
  );
}
