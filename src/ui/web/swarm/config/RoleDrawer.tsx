// The role editor: a ds Drawer with one ds Field per role setting, each with its hint and the
// server's inline error (matched by issue path). Locked paths (anchors, merge keys, hooks) are
// read-only with a pointer to the YAML.
import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { SwarmConfigMeta } from "../../api.js";
import { Badge, ChipInput, Drawer, Field, Segmented, Stepper, Switch } from "../../ds.js";
import { cls } from "../../util.js";
import {
  deleteBlock,
  isLocked,
  issuesUnder,
  nameProblem,
  type PathIssue,
  READ_ONLY_TOOLS,
  type SwarmDoc,
  type SwarmDocRole,
} from "./draft.js";
import { ContextEditor, ModelPolicyControl, mergedContext } from "./fields.js";
import { AGENT_COLOR_CSS } from "./RoleCard.js";

const lim = (meta: SwarmConfigMeta, k: string, d: number): number => {
  const v = meta.limits[k];
  return typeof v === "number" ? v : d;
};

/** A name input that commits on Enter or blur, only when the name is valid and free. */
export function NameInput({
  value,
  taken,
  disabled,
  id,
  onCommit,
}: {
  value: string;
  taken: string[];
  disabled?: boolean | undefined;
  id?: string | undefined;
  onCommit: (name: string) => void;
}): JSX.Element {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const problem = text === value ? undefined : nameProblem(text, taken);
  const commit = () => {
    if (text !== value && !problem) onCommit(text);
  };
  return (
    <div class="swc-name">
      <input
        id={id}
        type="text"
        class={cls("mono", problem && "bad-input")}
        value={text}
        disabled={disabled}
        spellcheck={false}
        autocomplete="off"
        onInput={(e) => setText((e.target as HTMLInputElement).value.trim())}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape" && text !== value) {
            e.stopPropagation();
            setText(value);
          }
        }}
      />
      {problem ? (
        <div class="ds-field-error">{problem}</div>
      ) : text !== value ? (
        <div class="ds-field-hint">Enter to rename</div>
      ) : null}
    </div>
  );
}

/** A text area with a live character count against its limit. */
export function CountedText({
  value,
  max,
  rows = 4,
  id,
  placeholder,
  disabled,
  mono,
  onChange,
}: {
  value: string;
  max: number;
  rows?: number;
  id?: string | undefined;
  placeholder?: string | undefined;
  disabled?: boolean | undefined;
  mono?: boolean | undefined;
  onChange: (v: string) => void;
}): JSX.Element {
  const n = value.length;
  return (
    <div class="swc-counted">
      <textarea
        id={id}
        rows={rows}
        class={cls(!mono && "swc-prose")}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        spellcheck={!mono}
        onInput={(e) => onChange((e.target as HTMLTextAreaElement).value)}
      />
      <span class={cls("swc-count", n > max ? "bad" : n > max * 0.8 ? "warn" : "muted")}>
        {n.toLocaleString("en-US")} / {max.toLocaleString("en-US")}
      </span>
    </div>
  );
}

const EFFORT_DEFAULT = "default";
const LOCKABLE = [
  "description",
  "model",
  "model_range",
  "effort",
  "color",
  "count",
  "max_turns",
  "isolation",
  "tools_profile",
  "tools",
  "disallowed_tools",
  "skills",
  "scope",
  "memory_tags",
  "context",
  "prompt",
];

export function RoleDrawer({
  swarm,
  name,
  role,
  doc,
  meta,
  issues,
  locked,
  taken,
  onChange,
  onRename,
  onDuplicate,
  onDelete,
  onRaw,
  onClose,
}: {
  swarm: string;
  name: string;
  role: SwarmDocRole;
  doc: SwarmDoc;
  meta: SwarmConfigMeta;
  issues: PathIssue[];
  locked: string[];
  /** The other role names of the swarm (a rename must not take one). */
  taken: string[];
  onChange: (r: SwarmDocRole) => void;
  onRename: (to: string) => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onRaw: () => void;
  onClose: () => void;
}): JSX.Element {
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => setConfirmDelete(false), [name]);
  const at = `swarms.${swarm}.agents.${name}`;
  const err = (k: string) => {
    const list = issuesUnder(issues, `${at}.${k}`);
    return list.length ? list.map((i) => i.message).join("; ") : undefined;
  };
  const lockedAt = (k: string) => isLocked(locked, `${at}.${k}`);
  const roleLocked = isLocked(locked, at);
  const blocked = deleteBlock(locked, at);
  /** Fields set through an anchor or merge key: shown, but edited in the YAML. */
  const lockedFields = LOCKABLE.filter((k) => !roleLocked && lockedAt(k));
  const set = <K extends keyof SwarmDocRole>(k: K, v: SwarmDocRole[K]) => {
    const next = { ...role, [k]: v };
    if (v === undefined) delete next[k];
    onChange(next);
  };
  const list = (k: "tools" | "disallowed_tools" | "skills" | "scope" | "memory_tags") => (
    <ChipInput
      label={k}
      value={role[k] ?? []}
      disabled={lockedAt(k)}
      placeholder={
        k === "scope"
          ? "src/ui/**"
          : k === "skills"
            ? "eminiar:em-history"
            : k === "memory_tags"
              ? "decision"
              : "Read, Bash, mcp__server__tool"
      }
      onChange={(v) => set(k, v.length ? v : undefined)}
    />
  );
  const swarmDef = doc.swarms[swarm];
  const inheritedCtx = mergedContext(meta.defaultContext, doc.defaults?.context, swarmDef?.context);
  const readOnly =
    READ_ONLY_TOOLS.every((t) => role.disallowed_tools?.includes(t)) && !role.tools?.length;
  const allTools = !role.tools?.length && !role.disallowed_tools?.length;
  return (
    <Drawer
      title={
        <>
          <span
            class="swc-role-dot sm"
            aria-hidden="true"
            style={
              {
                "--rc": (role.color && AGENT_COLOR_CSS[role.color]) || "var(--accent)",
              } as JSX.CSSProperties
            }
          >
            {(name[0] ?? "?").toUpperCase()}
          </span>{" "}
          {name} <span class="muted small">in {swarm}</span>
        </>
      }
      onClose={onClose}
      footer={
        confirmDelete ? (
          <>
            <span class="small bad swc-grow">
              Delete the role {name}? Its agent file goes on the next sync.
            </span>
            <button type="button" class="sm" onClick={() => setConfirmDelete(false)}>
              Cancel
            </button>
            <button type="button" class="sm danger" onClick={onDelete}>
              Delete role
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              class="sm ghost"
              disabled={!!blocked}
              title={blocked && `Cannot delete: ${blocked}`}
              onClick={() => setConfirmDelete(true)}
            >
              Delete…
            </button>
            <button type="button" class="sm" onClick={onDuplicate}>
              Duplicate
            </button>
            <span class="swc-grow" />
            <button type="button" class="sm primary" onClick={onClose}>
              Done
            </button>
          </>
        )
      }
    >
      {roleLocked ? (
        <div class="swc-note warn small">
          This role comes from a YAML anchor or merge key, so it is read-only here.{" "}
          <button type="button" class="ghost sm" onClick={onRaw}>
            Edit in YAML
          </button>
        </div>
      ) : lockedFields.length ? (
        <div class="swc-note warn small">
          Read-only here (set through a YAML anchor or merge key): {lockedFields.join(", ")}.{" "}
          <button type="button" class="ghost sm" onClick={onRaw}>
            Edit in YAML
          </button>
        </div>
      ) : null}
      <div class="swc-form-2">
        <Field
          label="Name"
          htmlFor="swc-r-name"
          hint={`agent swarm-${swarm}-${name}`}
          error={err("__name")}
        >
          <NameInput
            id="swc-r-name"
            value={name}
            taken={taken}
            disabled={roleLocked}
            onCommit={onRename}
          />
        </Field>
        <Field
          label="Workers at once"
          hint="count: parallel workers of this role (1-8)"
          error={err("count")}
        >
          {lockedAt("count") ? (
            <span class="ds-num">{role.count ?? 1}</span>
          ) : (
            <Stepper
              label="count"
              value={role.count ?? 1}
              min={1}
              max={lim(meta, "count", 8)}
              onChange={(n) => set("count", n)}
            />
          )}
        </Field>
      </div>
      <Field
        label="Description"
        htmlFor="swc-r-desc"
        hint="Claude Code shows it when choosing the agent; also the worker's one-line brief"
        error={err("description")}
      >
        <CountedText
          id="swc-r-desc"
          rows={2}
          value={role.description}
          max={lim(meta, "description", 500)}
          disabled={lockedAt("description")}
          onChange={(v) => set("description", v)}
        />
      </Field>
      <Field
        label="Model"
        hint="pin one model, or let the adjudicator pick a tier per task inside a range"
        error={err("model") ?? err("model_range")}
      >
        <ModelPolicyControl
          doc={doc}
          value={{ model: role.model, model_range: role.model_range }}
          models={meta.models}
          modelDisabled={lockedAt("model")}
          rangeDisabled={lockedAt("model_range")}
          onChange={(v) => {
            const next: SwarmDocRole = { ...role, model: v.model, model_range: v.model_range };
            if (v.model === undefined) delete next.model;
            if (v.model_range === undefined) delete next.model_range;
            onChange(next);
          }}
        />
      </Field>
      <Field label="Effort" hint="thinking effort of the worker's model" error={err("effort")}>
        <Segmented<string>
          label="effort"
          value={role.effort ?? EFFORT_DEFAULT}
          onChange={(v) =>
            !lockedAt("effort") &&
            set("effort", v === EFFORT_DEFAULT ? undefined : (v as SwarmDocRole["effort"]))
          }
          options={[EFFORT_DEFAULT, ...meta.efforts].map((e) => ({ id: e, label: e }))}
        />
      </Field>
      <Field label="Colour" hint="the agent's colour in Claude Code" error={err("color")}>
        <div class="swc-swatches" role="radiogroup" aria-label="colour">
          <button
            type="button"
            role="radio"
            aria-checked={!role.color}
            class={cls("swc-swatch none", !role.color && "on")}
            title="no colour"
            disabled={lockedAt("color")}
            onClick={() => set("color", undefined)}
          >
            ∅
          </button>
          {meta.colors.map((c) => (
            <button
              type="button"
              role="radio"
              aria-checked={role.color === c}
              aria-label={c}
              title={c}
              class={cls("swc-swatch", role.color === c && "on")}
              style={{ "--sw": AGENT_COLOR_CSS[c] ?? c } as JSX.CSSProperties}
              disabled={lockedAt("color")}
              onClick={() => set("color", c as SwarmDocRole["color"])}
            />
          ))}
        </div>
      </Field>
      <div class="swc-form-2">
        <Field
          label="Max turns"
          htmlFor="swc-r-turns"
          hint="stop the worker after this many turns (empty: no limit)"
          error={err("max_turns")}
        >
          <input
            id="swc-r-turns"
            type="number"
            min={1}
            max={lim(meta, "maxTurns", 500)}
            value={role.max_turns ?? ""}
            disabled={lockedAt("max_turns")}
            placeholder="no limit"
            onInput={(e) => {
              const v = (e.target as HTMLInputElement).value;
              set("max_turns", v === "" ? undefined : Math.round(Number(v)));
            }}
          />
        </Field>
        <Field
          label="Isolation"
          hint="run each worker in its own git worktree"
          error={err("isolation")}
        >
          <Switch
            checked={role.isolation === "worktree"}
            disabled={lockedAt("isolation")}
            label="worktree"
            onChange={(on) => set("isolation", on ? "worktree" : undefined)}
          />
        </Field>
        <Field
          label="Read-only profile"
          hint="allowlist read-only tools only: no Edit, Write or Bash"
          error={err("tools_profile")}
        >
          <Switch
            checked={role.tools_profile === "readonly"}
            disabled={lockedAt("tools_profile")}
            label="readonly"
            onChange={(on) => set("tools_profile", on ? "readonly" : undefined)}
          />
        </Field>
      </div>
      <Field
        label={
          <span class="swc-label-row">
            Tools
            <span class="swc-presets">
              <button
                type="button"
                class={cls("chip", allTools && "on")}
                disabled={lockedAt("tools") || lockedAt("disallowed_tools")}
                onClick={() => onChange({ ...role, tools: undefined, disallowed_tools: undefined })}
              >
                all tools
              </button>
              <button
                type="button"
                class={cls("chip", readOnly && "on")}
                disabled={lockedAt("tools") || lockedAt("disallowed_tools")}
                title="disallow Edit, Write and NotebookEdit"
                onClick={() =>
                  onChange({
                    ...role,
                    tools: undefined,
                    disallowed_tools: [
                      ...new Set([...(role.disallowed_tools ?? []), ...READ_ONLY_TOOLS]),
                    ],
                  })
                }
              >
                read-only
              </button>
            </span>
          </span>
        }
        hint="allowed tools (empty: every tool the session has)"
        error={err("tools")}
      >
        {list("tools")}
      </Field>
      <Field
        label="Disallowed tools"
        hint="removed from the worker's tools"
        error={err("disallowed_tools")}
      >
        {list("disallowed_tools")}
      </Field>
      <Field label="Skills" hint="skills preloaded into the worker" error={err("skills")}>
        {list("skills")}
      </Field>
      <Field
        label="Scope"
        hint="project-relative globs the worker may edit (empty: anywhere)"
        error={err("scope")}
      >
        {list("scope")}
      </Field>
      <Field
        label="Memory tags"
        hint="recall memories of these kinds or tags first"
        error={err("memory_tags")}
      >
        {list("memory_tags")}
      </Field>
      <Field
        label="Prompt"
        htmlFor="swc-r-prompt"
        hint="the worker's system prompt, after eminiar's swarm protocol"
        error={err("prompt")}
      >
        <CountedText
          id="swc-r-prompt"
          mono
          rows={9}
          value={role.prompt ?? ""}
          max={lim(meta, "prompt", 20_000)}
          placeholder="How this worker should work: what to read first, what to verify, what to report."
          disabled={lockedAt("prompt")}
          onChange={(v) => set("prompt", v || undefined)}
        />
      </Field>
      <details class="swc-details" open={!!role.context}>
        <summary>
          Context overrides{" "}
          {role.context ? (
            <Badge tone="accent">{Object.keys(role.context).length} set</Badge>
          ) : null}
        </summary>
        <ContextEditor
          value={role.context}
          inherited={inheritedCtx}
          inheritedFrom="the swarm and the defaults"
          disabled={lockedAt("context")}
          onChange={(c) => set("context", c)}
        />
        {err("context") ? <div class="ds-field-error">{err("context")}</div> : null}
      </details>
      <Field label="Hooks" hint="Claude Code hooks of the agent file">
        {role.hooks ? (
          <div class="swc-hooks">
            <pre class="mono small">{hookSummary(role.hooks)}</pre>
            <button type="button" class="sm" onClick={onRaw}>
              Edit in YAML
            </button>
          </div>
        ) : (
          <span class="small muted">
            none ·{" "}
            <button type="button" class="ghost sm" onClick={onRaw}>
              add in YAML
            </button>
          </span>
        )}
      </Field>
    </Drawer>
  );
}

/** `PostToolUse Edit|Write → node "…/format-edited.mjs" (30 s)` per hook command. */
function hookSummary(hooks: unknown): string {
  if (!hooks || typeof hooks !== "object") return String(hooks);
  const out: string[] = [];
  for (const [event, matchers] of Object.entries(hooks as Record<string, unknown>)) {
    if (!Array.isArray(matchers)) continue;
    for (const m of matchers as Array<{
      matcher?: string;
      hooks?: Array<{ command?: string; timeout?: number }>;
    }>)
      for (const h of m.hooks ?? [])
        out.push(
          `${event}${m.matcher ? ` ${m.matcher}` : ""} → ${h.command ?? "?"}${h.timeout ? ` (${h.timeout} s)` : ""}`,
        );
  }
  return out.join("\n") || JSON.stringify(hooks);
}
