// The selected swarm in the Configuration Studio: name and description with a live topology
// preview, the topology picker, capacity (max_agents vs Σ count), pipeline stages, the roles
// grid, instructions and context overrides. Pure UI over the draft: every change goes up as a
// new SwarmDocSwarm (or a rename) and the studio re-validates.
import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { SwarmConfigMeta, SwarmDocWarning, SwarmTopology } from "../../api.js";
import { toast } from "../../components.js";
import { Badge, Card, Field, Gauge, Stepper } from "../../ds.js";
import { cls } from "../../util.js";
import { ConfigTopology } from "../ConfigTopology.js";
import { startCommand } from "../run-helpers.js";
import { GLYPH, TOPOLOGY_GLYPH } from "../style.js";
import {
  capacity,
  DEFAULT_MAX_AGENTS,
  deleteBlock,
  isLocked,
  issuesUnder,
  missingStages,
  moveStage,
  type PathIssue,
  type SwarmDoc,
  type SwarmDocSwarm,
  setIn,
  uniqueName,
} from "./draft.js";
import { ContextEditor, mergedContext } from "./fields.js";
import { RoleCard } from "./RoleCard.js";
import { CountedText, NameInput } from "./RoleDrawer.js";
import { TopologyPicker } from "./TopologyPicker.js";

const lim = (meta: SwarmConfigMeta, k: string, d: number): number => {
  const v = meta.limits[k];
  return typeof v === "number" ? v : d;
};

function CopyCommand({ text }: { text: string }): JSX.Element {
  return (
    <span class="sw-copy-row swc-cmd">
      <code>{text}</code>
      <button
        type="button"
        class="ghost sm"
        title="copy to the clipboard"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            toast("copied");
          } catch {
            toast("could not copy: select the line and copy it by hand", true);
          }
        }}
      >
        Copy
      </button>
    </span>
  );
}

export function SwarmEditor({
  name,
  swarm,
  doc,
  meta,
  issues,
  warnings,
  locked,
  swarmNames,
  activeRun,
  selectedRole,
  onChange,
  onRename,
  onDuplicate,
  onDelete,
  onOpenRole,
  onAddRole,
}: {
  name: string;
  swarm: SwarmDocSwarm;
  doc: SwarmDoc;
  meta: SwarmConfigMeta;
  issues: PathIssue[];
  warnings: SwarmDocWarning[];
  locked: string[];
  swarmNames: string[];
  /** A run of this swarm is active (renaming or removing roles affects it). */
  activeRun: string | undefined;
  selectedRole: string | undefined;
  onChange: (s: SwarmDocSwarm) => void;
  onRename: (to: string) => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onOpenRole: (role: string) => void;
  /** Add a role (blank, or a copy of `from`) and open it. */
  onAddRole: (role: string, from?: string) => void;
}): JSX.Element {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [copyFrom, setCopyFrom] = useState("");
  useEffect(() => {
    setConfirmDelete(false);
    setCopyFrom("");
  }, [name]);
  const at = `swarms.${name}`;
  const blockedWhy = deleteBlock(locked, at);
  const err = (k: string) => {
    const l = issuesUnder(issues, `${at}.${k}`);
    return l.length ? l.map((i) => i.message).join("; ") : undefined;
  };
  const warn = (k: string) =>
    warnings
      .filter((w) => w.path === `${at}.${k}`)
      .map((w) => w.message)
      .join("; ") || undefined;
  const nameErr =
    issues
      .filter((i) => i.path === at)
      .map((i) => i.message)
      .join("; ") || undefined;
  const lk = (k: string) => isLocked(locked, `${at}.${k}`);
  const set = (k: keyof SwarmDocSwarm, v: unknown) => onChange(setIn(swarm, [k], v));
  const topology: SwarmTopology = swarm.topology ?? "hierarchical";
  const roles = Object.keys(swarm.agents);
  const cap = capacity(swarm);
  const maxAgents = swarm.max_agents ?? DEFAULT_MAX_AGENTS;
  const stages = swarm.stages ?? [];
  const missing = topology === "pipeline" ? missingStages(swarm) : [];
  const inheritedCtx = mergedContext(meta.defaultContext, doc.defaults?.context);
  return (
    <div class="swc-editor">
      <section class="ds-hero swc-hero">
        <div class="ds-hero-main">
          <div class="ds-eyebrow">
            <span aria-hidden="true">{TOPOLOGY_GLYPH[topology]}</span> {topology} swarm
            {activeRun ? (
              <Badge tone="accent" dot title={`run ${activeRun} is active`}>
                run active
              </Badge>
            ) : null}
          </div>
          <div class="swc-hero-name">
            <NameInput
              value={name}
              taken={swarmNames.filter((n) => n !== name)}
              onCommit={onRename}
            />
            {nameErr ? <div class="ds-field-error">{nameErr}</div> : null}
          </div>
          <Field label="Description" htmlFor="swc-s-desc" error={err("description")}>
            <CountedText
              id="swc-s-desc"
              rows={3}
              value={swarm.description}
              max={lim(meta, "description", 500)}
              disabled={lk("description")}
              placeholder="What this swarm is for: the coordinator reads it when it plans a run."
              onChange={(v) => set("description", v)}
            />
          </Field>
          <div class="ds-hero-meta">
            <CopyCommand text={startCommand(name)} />
            <span class="spacer" />
            {confirmDelete ? (
              <span class="swc-confirm inline" role="alertdialog" aria-label={`delete ${name}`}>
                <span class="small">
                  Delete {name} and its {roles.length} role{roles.length === 1 ? "" : "s"}?
                </span>
                <button type="button" class="sm" onClick={() => setConfirmDelete(false)}>
                  Cancel
                </button>
                <button type="button" class="sm danger" onClick={onDelete}>
                  Delete swarm
                </button>
              </span>
            ) : (
              <>
                <button type="button" class="sm" onClick={onDuplicate}>
                  Duplicate
                </button>
                <button
                  type="button"
                  class="sm ghost"
                  disabled={!!blockedWhy}
                  title={blockedWhy && `Cannot delete: ${blockedWhy}`}
                  onClick={() => setConfirmDelete(true)}
                >
                  Delete…
                </button>
              </>
            )}
          </div>
        </div>
        <div class="ds-hero-aside swc-hero-aside">
          <ConfigTopology
            class="swc-live-topo"
            topology={topology}
            roles={roles.map((r) => ({ name: r, count: swarm.agents[r]?.count ?? 1 }))}
            stages={stages}
            maxAgents={maxAgents}
          />
          <span class="swc-live-cap small muted">
            live preview · {cap.total} slot{cap.total === 1 ? "" : "s"}
          </span>
        </div>
      </section>

      <Card title="Shape" sub="how the coordinator and the workers work together" raised>
        <TopologyPicker
          value={topology}
          disabled={lk("topology")}
          onChange={(t) => {
            let next = setIn(swarm, ["topology"], t);
            // A pipeline needs an order: start it from the roles as listed.
            if (t === "pipeline" && !swarm.stages?.length) next = setIn(next, ["stages"], roles);
            onChange(next);
          }}
        />
        {err("topology") ? <div class="ds-field-error">{err("topology")}</div> : null}
        <div class="swc-cap">
          <Gauge
            value={cap.max ? cap.total / cap.max : 0}
            size={76}
            tone={cap.over ? "warn" : "accent"}
            label={
              <span class="ds-num">
                {cap.total}/{cap.max}
              </span>
            }
            caption="slots"
            title={`${cap.total} worker slots (Σ count) against max_agents ${cap.max}`}
          />
          <div class="swc-cap-text">
            <Field
              label="Max agents"
              hint="workers running at once across all runs of the swarm (1-16)"
              error={err("max_agents")}
            >
              {lk("max_agents") ? (
                <span class="ds-num">{maxAgents}</span>
              ) : (
                <Stepper
                  label="max agents"
                  value={maxAgents}
                  min={1}
                  max={lim(meta, "maxAgents", 16)}
                  onChange={(n) => set("max_agents", n)}
                />
              )}
            </Field>
            <span class={cls("small", cap.over ? "warn" : "muted")}>
              {cap.over
                ? `${GLYPH.blocked} ${warn("max_agents") ?? `${cap.total} slots but max_agents ${cap.max}: only ${cap.max} run at once`}`
                : `${cap.total} slot${cap.total === 1 ? "" : "s"} configured (Σ count); ${cap.max - cap.total} spare.`}
            </span>
          </div>
        </div>
        {topology === "pipeline" ? (
          <Field
            label="Stages"
            hint="the order work moves through; every role should appear once"
            error={err("stages") ?? warn("stages")}
          >
            <ol class="swc-stages">
              {stages.map((s, i) => (
                <li>
                  <span class="swc-stage-n">{i + 1}</span>
                  <code>{s}</code>
                  {roles.includes(s) ? null : <Badge tone="bad">no such role</Badge>}
                  <span class="spacer" />
                  <button
                    type="button"
                    class="ghost sm"
                    aria-label={`move ${s} up`}
                    disabled={i === 0 || lk("stages")}
                    onClick={() => set("stages", moveStage(stages, i, -1))}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    class="ghost sm"
                    aria-label={`move ${s} down`}
                    disabled={i === stages.length - 1 || lk("stages")}
                    onClick={() => set("stages", moveStage(stages, i, 1))}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    class="ghost sm"
                    aria-label={`remove ${s} from the stages`}
                    disabled={lk("stages")}
                    onClick={() =>
                      set(
                        "stages",
                        stages.filter((_, j) => j !== i),
                      )
                    }
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ol>
            {missing.length ? (
              <div class="row tight">
                <span class="small muted">Not in the stages:</span>
                {missing.map((r) => (
                  <button
                    type="button"
                    class="chip"
                    disabled={lk("stages")}
                    onClick={() => set("stages", [...stages, r])}
                  >
                    + {r}
                  </button>
                ))}
              </div>
            ) : null}
          </Field>
        ) : null}
      </Card>

      <Card
        title="Roles"
        sub={`${roles.length} role${roles.length === 1 ? "" : "s"} · click one to edit`}
        raised
        right={
          err("agents") ? (
            <Badge tone="bad">
              {GLYPH.failed} {err("agents")}
            </Badge>
          ) : null
        }
      >
        <div class="swc-roles">
          {roles.map((r) => (
            <RoleCard
              name={r}
              role={swarm.agents[r]!}
              doc={doc}
              names={roles}
              issues={issuesUnder(issues, `${at}.agents.${r}`).length}
              selected={r === selectedRole}
              countLocked={lk(`agents.${r}.count`)}
              maxCount={lim(meta, "count", 8)}
              onOpen={() => onOpenRole(r)}
              onCount={(n) => set("agents", setIn(swarm.agents, [r, "count"], n))}
            />
          ))}
          <div class="swc-add-role">
            <span class="swc-add-plus" aria-hidden="true">
              ＋
            </span>
            <b>Add a role</b>
            <span class="small muted">A worker type with its own prompt, model and tools.</span>
            <div class="row tight">
              <button
                type="button"
                class="sm primary"
                disabled={lk("agents")}
                onClick={() =>
                  onAddRole(uniqueName(copyFrom || "worker", roles), copyFrom || undefined)
                }
              >
                {copyFrom ? `Copy ${copyFrom}` : "Blank role"}
              </button>
              {roles.length ? (
                <select
                  aria-label="copy from a role"
                  value={copyFrom}
                  onChange={(e) => setCopyFrom((e.target as HTMLSelectElement).value)}
                >
                  <option value="">blank</option>
                  {roles.map((r) => (
                    <option value={r}>copy of {r}</option>
                  ))}
                </select>
              ) : null}
            </div>
          </div>
        </div>
      </Card>

      <Card
        title="Instructions"
        sub="what the coordinator follows when it plans and runs this swarm"
        raised
      >
        <Field label="" htmlFor="swc-s-instr" error={err("instructions")}>
          <CountedText
            id="swc-s-instr"
            mono
            rows={7}
            value={swarm.instructions ?? ""}
            max={lim(meta, "prompt", 20_000)}
            disabled={lk("instructions")}
            placeholder="Order of work, how tasks are split, when the run is done…"
            onChange={(v) => set("instructions", v || undefined)}
          />
        </Field>
      </Card>

      <details class="swc-details card-like" open={!!swarm.context}>
        <summary>
          Context overrides for every role of {name}{" "}
          {swarm.context ? (
            <Badge tone="accent">{Object.keys(swarm.context).length} set</Badge>
          ) : null}
        </summary>
        <ContextEditor
          value={swarm.context}
          inherited={inheritedCtx}
          inheritedFrom="the defaults"
          disabled={lk("context")}
          onChange={(c) => set("context", c)}
        />
        {err("context") ? <div class="ds-field-error">{err("context")}</div> : null}
      </details>
    </div>
  );
}
