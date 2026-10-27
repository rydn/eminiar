import type { JSX } from "preact";
import { useState } from "preact/hooks";
import type { SwarmNote } from "../api.js";
import { cls } from "../util.js";
import { Head, RoleChip } from "./bits.js";
import { rel } from "./style.js";

export function Blackboard({
  notes,
  roles,
  now,
}: {
  notes: SwarmNote[];
  roles: string[];
  now: number;
}): JSX.Element {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div class="card">
      <Head title="Blackboard" meta={`${notes.length} key${notes.length === 1 ? "" : "s"}`} />
      {notes.length ? (
        <div class="sw-notes">
          {notes.map((n) => {
            const isOpen = open === n.key;
            const author = n.author ?? "n/a";
            return (
              <div
                class={cls("sw-note-row", isOpen && "open")}
                onClick={() => setOpen(isOpen ? null : n.key)}
                title={isOpen ? undefined : "show the value"}
              >
                <div class="h">
                  <code class="k">{n.key}</code>
                  <span class="v">v{n.version}</span>
                  <RoleChip role={author.split("@")[0]} roles={roles} label={author} />
                  <span class="age" title={new Date(n.ts).toLocaleString()}>
                    {rel(n.ts, now)}
                  </span>
                </div>
                {isOpen ? (
                  <pre class="sw-pre" onClick={(e) => e.stopPropagation()}>
                    {n.value}
                  </pre>
                ) : (
                  <div class="p">{n.value.trim().split("\n")[0]?.slice(0, 160)}</div>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <div class="empty small">
          Nothing shared yet. Workers post with{" "}
          <code>em_swarm {'{action:"post", key, value}'}</code>.
        </div>
      )}
    </div>
  );
}
