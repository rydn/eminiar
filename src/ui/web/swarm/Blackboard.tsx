import type { JSX } from "preact";
import { useState } from "preact/hooks";
import type { SwarmNote } from "../api.js";
import { cls } from "../util.js";
import { Head, pure, RoleChip, useNow } from "./bits.js";
import { rel } from "./style.js";

function BlackboardView({
  notes,
  roles,
  live,
  skew,
}: {
  notes: SwarmNote[];
  roles: string[];
  live: boolean;
  skew: number;
}): JSX.Element {
  const now = useNow(15_000, live, skew);
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
              <div key={n.key} class={cls("sw-note-row", isOpen && "open")}>
                <button
                  type="button"
                  class="sw-btn sw-note-sum"
                  aria-expanded={isOpen}
                  title={isOpen ? "hide the value" : "show the value"}
                  onClick={() => setOpen(isOpen ? null : n.key)}
                >
                  <div class="h">
                    <code class="k">{n.key}</code>
                    <span class="v">v{n.version}</span>
                    <RoleChip role={author.split("@")[0]} roles={roles} label={author} />
                    <span class="age" title={new Date(n.ts).toLocaleString()}>
                      {rel(n.ts, now)}
                    </span>
                  </div>
                  {isOpen ? null : (
                    <div class="p">{n.value.trim().split("\n")[0]?.slice(0, 160)}</div>
                  )}
                </button>
                {isOpen ? <pre class="sw-pre">{n.value}</pre> : null}
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

export const Blackboard = pure(BlackboardView);
