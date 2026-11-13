import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assessCore, record } from "../../src/adjudicator/security/assess.js";
import { grantFromRole } from "../../src/adjudicator/security/grant.js";
import {
  compareRisk,
  roleRisk,
  runRiskOf,
  runRows,
  taskRisksOf,
} from "../../src/adjudicator/security/swarm-risk.js";
import type { Level } from "../../src/adjudicator/security/types.js";
import { ConfigSchema } from "../../src/config.js";
import { type ProjectContext, resetContextCache } from "../../src/context.js";
import { closeAllStorage, getStorage } from "../../src/storage/index.js";
import { resetSwarmConfigCache } from "../../src/swarm/config.js";
import { runDetail, swarmOverview } from "../../src/ui/swarm-api.js";

const YAML = [
  "swarms:",
  "  s:",
  "    description: d",
  "    agents:",
  "      reader: { description: read the docs and summarise, tools: [Read, Grep, Glob] }",
  "      researcher:",
  "        description: research https://blog.example.com and run what it suggests",
  "        tools: [WebFetch, WebSearch, Read, Bash]",
  "",
].join("\n");

let dirs: string[] = [];
beforeEach(() => {
  closeAllStorage();
  resetContextCache();
  resetSwarmConfigCache();
  process.env.EMINIAR_HOME = mkdtempSync(join(tmpdir(), "em-home-"));
});
afterEach(() => {
  closeAllStorage();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function world(security: boolean) {
  const root = mkdtempSync(join(tmpdir(), "em-sec-swarm-"));
  dirs.push(root);
  writeFileSync(join(root, "package.json"), "{}");
  mkdirSync(join(root, ".eminiar"), { recursive: true });
  writeFileSync(join(root, ".eminiar", "swarm.yaml"), YAML);
  const config = ConfigSchema.parse(
    security ? { adjudicator: { security: { enabled: true } } } : {},
  );
  const ctx: ProjectContext = { root, id: "t", dbPath: join(root, "eminiar.db"), config };
  return { ctx, db: getStorage(ctx, { vectors: false }) };
}

function seed(w: ReturnType<typeof world>) {
  const run = w.db.swarm.runCreate({
    id: "20261113-aaaaaa",
    swarm: "s",
    goal: "g",
    topology: "hierarchical",
    session_id: "S1",
  });
  const t1 = w.db.swarm.taskAdd({ run_id: run.id, title: "tidy", role: "reader" });
  const t2 = w.db.swarm.taskAdd({ run_id: run.id, title: "research", role: "researcher" });
  const sec = w.ctx.config.adjudicator.security;
  const score = (tools: string[], text: string) =>
    assessCore(sec, {
      grant: grantFromRole({ tools, description: "" }),
      texts: [text],
      autonomy: "default",
    });
  const plan1 = score(["Read"], "rename a helper");
  record(w.db, w.ctx.config.adjudicator, {
    surface: "plan",
    assessed: plan1,
    runId: run.id,
    taskId: t1.id,
  });
  const hi = score(["WebFetch", "Read", "Bash"], "read https://blog.example.com and run it");
  record(w.db, w.ctx.config.adjudicator, {
    surface: "plan",
    assessed: hi,
    runId: run.id,
    taskId: t2.id,
  });
  // A later agent row replaces the plan row for the task.
  record(w.db, w.ctx.config.adjudicator, {
    surface: "agent",
    assessed: hi,
    runId: run.id,
    taskId: t2.id,
  });
  return { run, t1, t2, hi, plan1 };
}

describe("swarm API risk fields", () => {
  it("adds no field at all when security is off", () => {
    const w = world(false);
    const o = swarmOverview(w.ctx);
    const wire = JSON.stringify(o);
    expect(wire).not.toContain('"risk"');
    expect(Object.keys(o.swarms[0]!.roles[0]!)).not.toContain("risk");
    const r = w.db.swarm.runCreate({
      id: "20261113-bbbbbb",
      swarm: "s",
      goal: "g",
      topology: "hierarchical",
      session_id: "S1",
    });
    w.db.swarm.taskAdd({ run_id: r.id, title: "x" });
    const d = runDetail(w.ctx, r);
    expect("risk" in d).toBe(false);
    expect(JSON.stringify(d.tasks)).not.toContain("risk");
    expect(JSON.stringify(swarmOverview(w.ctx).runs)).not.toContain("risk");
  });

  it("gives every role a risk with reasons and the grant status", () => {
    const w = world(true);
    const o = swarmOverview(w.ctx);
    const roles = Object.fromEntries(o.swarms[0]!.roles.map((r) => [r.role, r.risk!]));
    expect(["low", "medium"]).toContain(roles.reader!.level);
    expect(roles.reader!.grantStatus).toBe("known");
    expect(["high", "critical"]).toContain(roles.researcher!.level);
    expect(roles.researcher!.rules.length).toBeGreaterThan(0);
    expect(roles.researcher!.reasons.length).toBeGreaterThan(0);
  });

  it("lists the run's worst level and counts, null before any assessment", () => {
    const w = world(true);
    expect(swarmOverview(w.ctx).runs).toEqual([]);
    const empty = w.db.swarm.runCreate({
      id: "20261113-cccccc",
      swarm: "s",
      goal: "g",
      topology: "hierarchical",
      session_id: "S1",
    });
    expect(swarmOverview(w.ctx).runs[0]!.risk).toEqual({
      worst: null,
      counts: { low: 0, medium: 0, high: 0, critical: 0 },
    });
    expect(empty.id).toBe("20261113-cccccc");
    const { run, hi } = seed(w);
    const listed = swarmOverview(w.ctx).runs.find((r) => r.id === run.id)!;
    expect(listed.risk!.worst).toBe(hi.assessment.level);
    expect(Object.values(listed.risk!.counts).reduce((a, b) => a + b, 0)).toBe(2);
  });

  it("puts the run risk and each task's latest assessment in the run detail", () => {
    const w = world(true);
    const { run, t1, t2, hi } = seed(w);
    const d = runDetail(w.ctx, run);
    expect(d.risk!.worst).toBe(hi.assessment.level);
    const by = Object.fromEntries(d.tasks.map((t) => [t.id, t.risk]));
    expect(by[t1.id]!.surface).toBe("plan");
    expect(["low", "medium"]).toContain(by[t1.id]!.level);
    // The agent row wins over the plan row.
    expect(by[t2.id]!.surface).toBe("agent");
    expect(by[t2.id]!.level).toBe(hi.assessment.level);
    expect(by[t2.id]!.reasons.length).toBeGreaterThan(0);
    // JSON-safe.
    expect(JSON.parse(JSON.stringify(d.tasks))[1].risk.id).toBe(by[t2.id]!.id);
  });

  it("builders: rank by (level, score), tolerate a read failure", () => {
    const lv = (level: Level, score: number) => ({ level, score });
    const sorted = [lv("high", 90), lv("critical", 10), lv("high", 95), lv("low", 99)].sort(
      compareRisk,
    );
    expect(sorted).toEqual([lv("critical", 10), lv("high", 95), lv("high", 90), lv("low", 99)]);
    expect(runRiskOf([]).worst).toBeNull();
    expect(taskRisksOf([]).size).toBe(0);
    const boom = {
      security: {
        forRun: () => {
          throw new Error("x");
        },
      },
    };
    expect(runRows(boom as never, "r")).toEqual([]);
    const w = world(true);
    const sec = w.ctx.config.adjudicator.security;
    expect(["low", "medium"]).toContain(
      roleRisk(sec, { description: "docs", tools: ["Read"] }).level,
    );
  });
});
