import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { classifyPrompt, classifyToolCall } from "../../src/capture/classify.js";
import { getContext, resetContextCache } from "../../src/context.js";
import { handlers } from "../../src/hooks/index.js";
import { commandSegments, literalOf, suggest, withoutHeredocs } from "../../src/hooks/routing.js";
import type { HookInput } from "../../src/hooks/types.js";
import { search } from "../../src/search/pipeline.js";
import { renderWithin } from "../../src/session/guide.js";
import { formatRoutingStats, routingStats } from "../../src/session/routing-stats.js";
import { liveServers, markServerAlive } from "../../src/session/server-alive.js";
import { closeAllStorage, getStorage } from "../../src/storage/index.js";
import type { EventRow } from "../../src/storage/types.js";

let root: string;
let unmark: () => void;
const base = (over: Partial<HookInput>): HookInput => ({
  session_id: "s1",
  cwd: root,
  hook_event_name: "x",
  ...over,
});

/** A git repository: routing sends history reads to em_history only inside one. */
function gitRepo(dir: string): void {
  spawnSync("git", ["init", "-q"], { cwd: dir });
}

/** A new folder with no git repository at or above it, or undefined when no temp base has none. */
function outsideAnyRepo(prefix: string): string | undefined {
  const inRepo = (d: string): boolean =>
    existsSync(join(d, ".git")) || (dirname(d) !== d && inRepo(dirname(d)));
  for (const base of [tmpdir(), "/tmp", "/var/tmp"]) {
    try {
      const real = realpathSync(base);
      if (!inRepo(real)) return mkdtempSync(join(real, prefix));
    } catch {
      // that base does not exist here
    }
  }
  return undefined;
}

beforeAll(() => {
  process.env.EMINIAR_HOME = mkdtempSync(join(tmpdir(), "em-home-"));
  process.env.EMINIAR_ROUTING_MODE = "enforce";
  root = mkdtempSync(join(tmpdir(), "em-root-"));
  writeFileSync(join(root, "package.json"), "{}");
  // context-mode may be installed on the dev machine; the test wants hard routing regardless
  writeFileSync(
    join(root, "eminiar.config.json"),
    JSON.stringify({ routing: { mode: "enforce", deferToContextMode: false } }),
  );
  writeFileSync(join(root, "big.log"), "x".repeat(30 * 1024));
  gitRepo(root);
  resetContextCache();
  // enforce only denies while a server is marked live for the project; this process stands in
  unmark = markServerAlive(getContext(root));
});
afterAll(() => {
  unmark();
  closeAllStorage();
  delete process.env.EMINIAR_HOME;
  delete process.env.EMINIAR_ROUTING_MODE;
});

describe("classify", () => {
  it("extracts decisions, constraints and intent from prompts", () => {
    const cats = classifyPrompt("Let's go with better-sqlite3. We must never commit secrets.").map(
      (d) => d.category,
    );
    expect(cats).toContain("user_prompt");
    expect(cats).toContain("decision");
    expect(cats).toContain("constraint");
    expect(cats).toContain("intent");
  });
  it("classifies tool calls", () => {
    const edit = classifyToolCall({
      toolName: "Edit",
      toolInput: { file_path: `${root}/src/a.ts` },
      root,
    });
    expect(edit.find((d) => d.category === "files")?.payload.path).toBe("src/a.ts");
    const git = classifyToolCall({
      toolName: "Bash",
      toolInput: { command: "git commit -m x" },
      root,
    });
    expect(git.map((d) => d.category)).toContain("git");
    const slowFail = classifyToolCall({
      toolName: "Bash",
      toolInput: { command: "npm test" },
      toolResponse: { stdout: "", stderr: "boom", exit_code: 1 },
      durationMs: 9000,
      root,
    });
    expect(slowFail.map((d) => d.category)).toEqual(expect.arrayContaining(["latency", "error"]));
  });

  describe("secrets in what is stored", () => {
    const token = "ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
    const payloads = (drafts: ReturnType<typeof classifyToolCall>, category: string) =>
      drafts.filter((d) => d.category === category).map((d) => JSON.stringify(d.payload));

    it("masks a token in the tool_call and latency summaries", () => {
      const drafts = classifyToolCall({
        toolName: "Bash",
        toolInput: { command: `curl -H "Authorization: Bearer ${token}" https://api.example.com` },
        durationMs: 9000,
        root,
      });
      for (const category of ["tool_call", "latency"]) {
        const [p] = payloads(drafts, category);
        expect(p, category).toBeDefined();
        expect(p).toContain("Bearer ***");
        expect(p).not.toContain("ghp_");
        expect(p).not.toContain(token.slice(4));
      }
    });

    it("masks a token in the error summary and text", () => {
      const drafts = classifyToolCall({
        toolName: "Bash",
        toolInput: { command: `GH_TOKEN=${token} gh api /user` },
        toolResponse: { stdout: "", stderr: `fatal: bad credentials ${token}`, exit_code: 1 },
        root,
      });
      const [p] = payloads(drafts, "error");
      expect(p).toContain("GH_TOKEN=***");
      expect(p).toContain("bad credentials ghp_***");
      expect(p).not.toContain(token.slice(4));
    });

    it("masks before it cuts an error to 400 characters", () => {
      // 385 characters, then a whole token: the cut falls inside it, and a cut token is too short
      // for its shape rule, so its prefix would be stored as typed
      const stderr = `${"x".repeat(384)} ${token}`;
      const drafts = classifyToolCall({
        toolName: "Bash",
        toolInput: { command: "make" },
        toolResponse: { stdout: "", stderr: `${stderr}\n`, exit_code: 2 },
        root,
      });
      const error = drafts.find((d) => d.category === "error")?.payload.error as string;
      expect(error).toContain("x".repeat(384));
      expect(error).toContain("ghp_***");
      expect(error).not.toContain("A1b2C3");
      expect(error.length).toBeLessThanOrEqual(400);
    });
  });
});

describe("routing suggestions", () => {
  // Read routing reads ~/.claude/settings.json; keep the developer's own rules out of it.
  const home = process.env.HOME;
  beforeAll(() => {
    process.env.HOME = mkdtempSync(join(tmpdir(), "em-userhome-"));
  });
  afterAll(() => {
    if (home === undefined) delete process.env.HOME;
    else process.env.HOME = home;
  });

  it("flags heavy bash, big reads, content grep, webfetch and agents; leaves tiny calls alone", () => {
    expect(suggest("Bash", { command: "git log --oneline -50" }, root)?.tool).toBe("em_history");
    expect(suggest("Bash", { command: "git diff HEAD~3" }, root)?.tool).toBe("em_execute");
    expect(suggest("Bash", { command: "ls -la | grep foo" }, root)?.tool).toBe("em_execute");
    expect(suggest("Bash", { command: "git status" }, root)).toBeUndefined();
    expect(suggest("Bash", { command: "pwd" }, root)).toBeUndefined();
    expect(suggest("Read", { file_path: "big.log" }, root)?.tool).toBe("em_execute_file");
    expect(suggest("Read", { file_path: "package.json" }, root)).toBeUndefined();
    expect(suggest("Grep", { pattern: "x", output_mode: "content" }, root)?.tool).toBe(
      "em_execute",
    );
    expect(suggest("Grep", { pattern: "x" }, root)).toBeUndefined();
    expect(suggest("WebFetch", { url: "https://x" }, root)?.tool).toBe("em_fetch_and_index");
    expect(suggest("Agent", { prompt: "p" }, root)?.prefixPrompt).toBeDefined();
  });

  it("judges one simple command at a time: bounded pipes and small reads stay native", () => {
    writeFileSync(join(root, "notes.txt"), "x".repeat(1000));
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "y.ts"), "export const y = 1;\n");
    const bash = (command: string) => suggest("Bash", { command }, root);
    // a trailing head / tail / wc caps whatever came before it
    expect(bash("ls -la | head -40")).toBeUndefined();
    expect(bash("npm test 2>&1 | tail -20")).toBeUndefined();
    expect(bash("find . -name '*.ts' | wc -l")).toBeUndefined();
    expect(bash("git status --short | head -5; git stash list | head -3")).toBeUndefined();
    expect(bash("git diff | head -5000")?.rule).toBe("heavy");
    expect(bash("git diff | grep -c foo")?.rule).toBe("heavy");
    // cat / grep over named files small enough for Read print no more than Read would
    expect(bash("cat -n package.json notes.txt")).toBeUndefined();
    expect(bash("cat ~/no-such-file-anywhere")).toBeUndefined();
    expect(bash("cat big.log")?.rule).toBe("big-read");
    expect(bash("cat *.log")?.rule).toBe("heavy");
    expect(bash("cat src/")?.rule).toBe("heavy");
    expect(bash("grep -n foo notes.txt src/y.ts")).toBeUndefined();
    expect(bash("grep -rln foo src")).toBeUndefined();
    expect(bash("grep -rn foo src")?.rule).toBe("heavy");
    expect(bash("sed -n '10,60p' src/y.ts | grep foo")).toBeUndefined();
    expect(bash("sed -n '1,900p' src/y.ts | grep foo")?.rule).toBe("pipe");
    expect(bash("du -sh node_modules")).toBeUndefined();
    expect(bash("head -50 big.log")).toBeUndefined();
    // the heavy part of a compound command is named, wherever it sits
    expect(bash("cd src && npm test")?.rule).toBe("heavy");
    expect(bash("echo start; cat notes.txt; git diff")?.reason).toContain("`git diff`");
    expect(bash("cat notes.txt; git log --oneline -20")?.tool).toBe("em_history");
    expect(bash("git log --oneline -1 && git status --short | wc -l")).toBeUndefined();
    // a command that changes something stays native, whatever else it prints
    expect(bash("git add -A && git commit -m x && git log --oneline -20")).toBeUndefined();
    expect(bash("git checkout -q main && git pull -q && npm test")).toBeUndefined();
    expect(bash("cat >> notes.txt <<'EOF'\nfoo | bar\nEOF\nnpx tsc 2>&1 | head")).toBeUndefined();
    expect(bash("npm test > out.log 2>&1")).toBeUndefined();
    expect(bash("npm test 2>/dev/null")?.rule).toBe("heavy");
    expect(bash("npm test 2>&1")?.rule).toBe("heavy");
    expect(
      bash("git commit -q -m \"$(cat <<'EOF'\nfix | tidy\nEOF\n)\" && git log -3"),
    ).toBeUndefined();
  });

  it("splits commands at unquoted separators only", () => {
    expect(commandSegments(`grep -n "a;b" x.ts && echo 'c||d'; ls\nwc -l`)).toEqual([
      `grep -n "a;b" x.ts`,
      `echo 'c||d'`,
      "ls",
      "wc -l",
    ]);
  });

  it("leaves a big Read to Claude Code when a Read deny or ask rule covers the file", () => {
    const guarded = mkdtempSync(join(tmpdir(), "em-root-guarded-"));
    mkdirSync(join(guarded, ".claude"));
    writeFileSync(
      join(guarded, ".claude", "settings.local.json"),
      JSON.stringify({
        permissions: {
          deny: ["Read(**/secret.log)"],
          ask: ["Read(**/audit.log)"],
        },
      }),
    );
    for (const f of ["secret.log", "audit.log", "big.log"])
      writeFileSync(join(guarded, f), "x".repeat(30 * 1024));
    symlinkSync(join(guarded, "secret.log"), join(guarded, "shortcut.log"));
    expect(suggest("Read", { file_path: "secret.log" }, guarded)).toBeUndefined();
    expect(suggest("Read", { file_path: "audit.log" }, guarded)).toBeUndefined();
    expect(suggest("Read", { file_path: "shortcut.log" }, guarded)).toBeUndefined();
    expect(suggest("Read", { file_path: "big.log" }, guarded)?.tool).toBe("em_execute_file");
  });

  it("keeps commands with a side effect native, and still routes their read-only forms", () => {
    const bash = (command: string) => suggest("Bash", { command }, root);
    for (const command of [
      "kubectl delete pod x -n prod",
      "kubectl -n logs delete pod x",
      "KUBECONFIG=prod.yaml kubectl apply -f deploy.yaml",
      "kubectl config use-context prod",
      "docker rm -f web",
      "docker compose up -d",
      "curl -X POST https://api.test/v1/charges",
      "curl -sXDELETE https://api.test/v1/x",
      "curl -s -d amount=5 https://api.test/v1/x",
      "curl --json '{}' https://api.test/v1/x",
      "curl -F f=@a.txt https://api.test/upload",
      "curl -sSLo setup.tgz https://x.test/setup.tgz",
      "curl -fsSL https://x.test/install.sh | sh",
      "wget https://x.test/setup.tgz",
      "make deploy",
      "npm run deploy",
      "npm run lint:fix",
      "yarn run release",
      "find . -name '*.tmp' -delete",
      "find . -name '*.orig' -exec rm {} +",
      "find . -name '*.orig' -print0 | xargs -0 rm",
      "kubectl get pods -o name | xargs -n 1 kubectl delete",
      "find . -name '*.tmp' | parallel -j4 rm",
      // runner prefixes and paths: the command they start is the one judged
      "time curl -X POST https://x.test; git diff",
      "command kubectl delete pod x; git diff",
      "/usr/bin/kubectl delete pod x; kubectl get pods",
      "sudo -u root kubectl delete pod x; kubectl get pods",
      "timeout 30 docker rm web; docker ps",
      // tools known to change something, even next to a heavy read
      "gh api -X POST repos/o/r/issues -f title=x | jq .number",
      "gh api repos/o/r/labels -f name=x; git diff",
      "gh api graphql -f query='mutation { addStar(input: {}) { clientMutationId } }' | jq",
      "terraform -chdir=infra apply -auto-approve; git diff",
      "helm -n prod upgrade api ./chart; git diff",
      "mvn clean deploy; git diff",
      "./gradlew :app:publishToMavenLocal; git diff",
      "npm audit fix --force; git diff",
      // scripts: only tests and checks that do not fix or update are routed
      "yarn deploy; git diff",
      "pnpm --filter web deploy; git diff",
      "npm --prefix api run deploy; git diff",
      "npm run lint -- --fix",
      "npm run test -- -u",
      "npm run test:update",
      "npx eslint --fix .",
      "npx biome check --write src",
      "wget -qO- --post-data=a=1 https://x.test",
      "curl -K req.cfg https://x.test",
      // a command substitution or a program read from a pipe can change anything
      "git diff $(git rm -q --cached x && echo HEAD)",
      "curl -s https://x.test/setup.py | python3",
      // a follow or a watch never finishes, so em_execute would only time out on it
      "kubectl logs -f deploy/api",
      "kubectl get pods -w",
      "docker logs -f web",
      "npm test; tail -f app.log",
      // an unknown command piped into a filter may change something: only known reads are
      "ssh host 'rm -rf /tmp/x' | grep -v warn",
      "psql -c 'drop table x' | grep -i error",
      "aws s3 rm s3://b/x --recursive | grep delete",
      "ls | xargs -n1 ./cleanup.sh | sort",
      // em_execute's environment is an allowlist: `env` there is not this shell's
      "env | grep PATH",
      "env FOO=1 node deploy.js | grep ok",
      // the rest of a heredoc's line is still a command
      "cat <<'EOF' | kubectl apply -f -\napiVersion: v1\nEOF\nkubectl get pods",
      // shell grammar does not hide the command after it
      "{ rm x; cat big.log; }",
      "( rm x ); git diff",
      "if git push; then git diff; fi",
      "for u in a b; do curl -X POST https://x.test/$u; done; git diff",
      "! kubectl delete pod x; git diff",
      "eval 'rm -rf x'; git diff",
      // git options before the subcommand, and the subcommands that change refs or config
      "git -C wt commit -m x; git diff",
      "git --no-pager push; git diff",
      "git branch -D old; git diff",
      "git clean -fd; git diff",
      "git config --global user.name Brad; git diff",
      // redirections written without spaces, or of both streams
      "npm test &> out.log",
      "npm test>out.log",
      "kubectl get pods>pods.txt",
      // make runs recipes: only test, check and lint targets read
      "make deploy",
      "make",
      "make lint-fix",
      "npm test -- --watch",
      "npx jest --watchAll",
      // quoted spans are data, but a redirection next to them still writes
      "ls >'a b'",
      "rg 'Promise<string>' src>hits.txt",
      // a later stage that does something with the output, wherever the route came from
      "git diff | patch -p1",
      "curl -s https://x.test/dump.sql | psql db",
      "cat big.log | psql db",
      "curl -s https://x.test/a.json | python3 -c 'import json, sys; json.load(sys.stdin)'",
      // process substitutions run too
      "diff a.txt <(git rm -q --cached x); git diff",
    ])
      expect(bash(command), command).toBeUndefined();
    for (const command of [
      "kubectl -n prod logs deploy/api",
      "kubectl get pods -A",
      "docker -H tcp://h ps -a",
      "docker stats --no-stream",
      "curl -s https://api.test/v1/x",
      "curl -X GET https://api.test/v1/x | jq .",
      "wget -qO- https://x.test/feed",
      "npm run test:unit",
      "pnpm run typecheck",
      "yarn test",
      "npx vitest run",
      "find . -name '*.ts'",
      "curl -sXGET https://api.test/v1/x",
      "gh api -X GET search/issues -f q=bug; git diff",
      "gh api graphql -f query='query { viewer { login } }'; git diff",
      "mvn test",
      "git diff $(git merge-base HEAD main)",
      "curl -s https://api.test/v1/x | python3 -m json.tool",
      "ls -la | grep foo",
      "git ls-files | sort",
      "ls | grep x | sort",
      "git branch -a | grep feat",
      "git config --get user.name; git diff",
      "echo 'a => a'; git diff",
      "gh pr view 12 --comments | grep LGTM",
      "gh run view 1 --log | grep error",
      "gh api repos/o/r/pulls | jq .",
      "make test",
      "make -j4 test",
      "make -j 4 test",
      "rg 'Promise<string>' src",
      "grep -rn 'Array<string>' src",
      "rg '<div>'",
      "kubectl get pods -o json | jq '.items[] | select(.restartCount>3)'",
      "npm test | grep FAIL",
      "curl -s https://api.test/v1/x | jq .",
      "diff <(git show HEAD:a.txt) b.txt; git diff",
    ])
      expect(bash(command)?.tool, command).toBe("em_execute");
  });

  it("keeps side effects native wherever they sit on the line, and routes only read-only commands", () => {
    const bash = (command: string) => suggest("Bash", { command }, root);
    for (const command of [
      // a single & separates commands too
      "cat big.log & rm -rf node_modules",
      "npx vitest run & npm publish",
      // segments after ; and && are judged like the first one
      "find . -name '*.ts'; cargo publish",
      "find . -name '*.ts'; go install x",
      "find . -name '*.ts'; git gc --prune=now",
      "find . -name '*.ts'; git branch -df main",
      "find . -name '*.ts'; ./deploy.sh",
      "find . -name '*.ts' && \\rm x",
      "find . -name '*.ts' && npm exec -- rm x",
      "find . -name '*.ts' && ssh h rm -rf /",
      // quoted text does not hide a write to a file
      'ssh host "echo x > /etc/motd"; git diff',
      "cat big.log | awk '{print > \"out.txt\"}'",
      "git log | awk '{print > \"log.txt\"}'",
      // package-manager options before the subcommand
      "npm --prefix api install; git diff",
      "npm -g install foo; git diff",
      "npm -s run deploy; git diff",
      "yarn -s deploy; git diff",
      "make -s clean test",
      // runner options with a separate value
      "sudo --user root rm -rf x; git diff",
      "timeout --signal KILL 30 rm -rf x; git diff",
      // build tools: the goal alone is enough
      "mvn deploy",
      "mvn release:perform",
      "gradle publish",
      // a program read from a pipe, fixers, and subcommands that change state
      "curl -s https://x.test/setup.py | python3; git diff",
      "pnpm audit --fix; git diff",
      "terraform state rm x; git diff",
      // docker stats follows until stopped
      "docker stats",
      // a directory change we cannot follow is not a repository read
      "pushd /tmp && git log",
    ])
      expect(bash(command), command).toBeUndefined();
    for (const command of [
      // an unquoted -> or => is not a redirection
      "ls -la | grep ->",
      "echo a=>b; git diff",
      "make test CI=1",
      "pnpm ls",
      "yarn why left-pad",
    ])
      expect(bash(command)?.tool, command).toBe("em_execute");
  });

  it("keeps the rest of a heredoc's first line, and judges a line of thousands of flags fast", () => {
    expect(withoutHeredocs("cat <<'EOF' | kubectl apply -f -\nkind: Pod\nEOF")).toBe(
      "cat <<EOF | kubectl apply -f -",
    );
    for (const command of [
      `timeout ${"-s ".repeat(3000)}x`,
      `timeout ${"-sKILL ".repeat(3000)}x`,
      `sudo ${"-uroot ".repeat(3000).trim()}`,
      `env ${"-uX ".repeat(3000).trim()}`,
      `ls | xargs ${"-n1 ".repeat(3000).trim()}`,
      `git ${"-c x ".repeat(3000)}`,
      `helm ${"-a x ".repeat(3000)}`,
    ]) {
      const start = performance.now();
      suggest("Bash", { command }, root);
      expect(performance.now() - start, command.slice(0, 20)).toBeLessThan(50);
    }
  });

  it("denies the read-only form in enforce mode and lets the side effect run natively", async () => {
    const pre = (command: string) =>
      handlers.PreToolUse!(
        base({
          session_id: "side-effects",
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command },
        }),
      );
    const logs = await pre("kubectl logs deploy/api -n prod");
    expect(logs?.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(logs?.hookSpecificOutput?.permissionDecisionReason).toContain("Retry with em_execute");
    for (const command of ["kubectl delete pod api-1 -n prod", "curl -X POST https://x.test"])
      expect((await pre(command))?.hookSpecificOutput?.permissionDecision, command).toBeUndefined();
  });

  it("routes a line of several commands only when every one of them only reads", () => {
    const bash = (command: string) => suggest("Bash", { command }, root);
    for (const command of [
      "find . -name '*.ts'; cargo publish",
      "find . -name '*.ts' && go install x",
      "find . -name '*.ts'; git gc --prune=now",
      "find . -name '*.ts'; git branch -df main",
      "find . -name '*.ts'; ./deploy.sh",
      "find . -name '*.ts'; \\rm x",
      "find . -name '*.ts'; npm exec -- rm",
      "find . -name '*.ts' & rm -rf node_modules",
      "cat big.log & npm publish",
      "find . -name '*.ts'; npm --prefix api install",
      "find . -name '*.ts'; npm -g install foo",
      "find . -name '*.ts'; npm -s run deploy",
      "find . -name '*.ts'; yarn -s deploy",
      "find . -name '*.ts'; make -s clean test",
      "find . -name '*.ts'; sudo --user root rm -rf x",
      "find . -name '*.ts'; timeout --signal KILL 30 rm -rf x",
      "find . -name '*.ts'; nice --adjustment=5 rm -rf x",
      "find . -name '*.ts'; mvn deploy",
      "find . -name '*.ts'; mvn release:perform",
      "find . -name '*.ts'; gradle publish",
      "find . -name '*.ts'; gh workflow run x",
      "find . -name '*.ts'; git diff --output=f",
      'ssh host "echo x > /etc/motd"; git diff',
      "cat big.log | awk '{print > \"out.txt\"}'",
      "git log | awk '{print > \"log.txt\"}'",
    ]) {
      expect(bash(command), command).toBeUndefined();
    }
    for (const command of [
      "find . -name '*.ts'; git diff",
      "find . -name '*.ts' && git status",
      "cat big.log & git diff",
      "find . -name '*.ts'; npm -s test",
      "find . -name '*.ts'; make -s test",
      "find . -name '*.ts'; sudo --user root cat x",
    ]) {
      expect(bash(command)?.tool, command).toBe("em_execute");
    }
  });

  it("sends a git history read to em_history only when it reads the root's own repository", () => {
    const bash = (command: string, at = root) => suggest("Bash", { command }, at);
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "vendor", "lib"), { recursive: true });
    gitRepo(join(root, "vendor", "lib"));
    expect(bash("git log --oneline -20")?.tool).toBe("em_history");
    expect(bash("git log --oneline | head -50")?.tool).toBe("em_history");
    expect(bash("cd src && git log -5")?.tool).toBe("em_history");
    expect(bash("git -C src log -5")?.tool).toBe("em_history");
    // `git log -C` is copy detection, not a directory
    expect(bash("git log -C --stat")?.tool).toBe("em_history");
    // another repository, or one only the shell can name: judged like any other command
    expect(bash("git -C /tmp/other log -5")).toBeUndefined();
    expect(bash("git --git-dir=/tmp/other/.git log -5")).toBeUndefined();
    // another repository's working directory stays native: em_execute runs in the root
    expect(bash(`cd ${tmpdir()} && git log -5`)).toBeUndefined();
    expect(bash("cd vendor/lib && git log -5")).toBeUndefined();
    expect(bash("cd $REPO && git log -5")?.tool).toBe("em_execute");
    // a root that is not a git repository: nothing for em_history to classify. The temp folder
    // can itself sit in a checkout (TMPDIR inside a repository or worktree): then any folder
    // made there is in that repository, so this is checked only where no repository is above.
    const plain = outsideAnyRepo("em-root-nogit-");
    if (plain) expect(bash("git log --oneline -20", plain)?.tool).toBe("em_execute");
  });

  it("leaves a big Read native when em_execute_file would refuse it or a window is asked", () => {
    const outside = mkdtempSync(join(tmpdir(), "em-outside-"));
    writeFileSync(join(outside, "tool-output.txt"), "x".repeat(300 * 1024));
    expect(suggest("Read", { file_path: join(outside, "tool-output.txt") }, root)).toBeUndefined();
    expect(suggest("Read", { file_path: "big.log", offset: 100 }, root)).toBeUndefined();
    expect(suggest("Read", { file_path: "big.log", limit: 50 }, root)).toBeUndefined();
    expect(suggest("Read", { file_path: join(root, "big.log") }, root)?.tool).toBe(
      "em_execute_file",
    );
  });
});

describe("hook handlers end to end", () => {
  it("records a session, routes in enforce mode, snapshots and replays a guide", async () => {
    const start = await handlers.SessionStart!(
      base({ hook_event_name: "SessionStart", source: "startup" }),
    );
    expect(start?.hookSpecificOutput?.additionalContext).toContain(
      "eminiar is active (routing: enforce)",
    );

    await handlers.UserPromptSubmit!(
      base({
        hook_event_name: "UserPromptSubmit",
        prompt: "Fix the flaky test; let's go with vitest",
      }),
    );
    await handlers.PostToolUse!(
      base({
        hook_event_name: "PostToolUse",
        tool_name: "Edit",
        tool_input: { file_path: `${root}/src/x.ts` },
        tool_response: {},
      }),
    );
    for (let i = 0; i < 3; i++) {
      await handlers.PostToolUse!(
        base({
          hook_event_name: "PostToolUse",
          tool_name: "Bash",
          tool_input: { command: "npm test" },
          tool_response: { exit_code: 1, stderr: "fail" },
        }),
      );
    }
    await handlers.Stop!(
      base({
        hook_event_name: "Stop",
        last_assistant_message: "Fixed the flaky test by awaiting the promise.",
      }),
    );

    const deny = await handlers.PreToolUse!(
      base({
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "git log" },
      }),
    );
    expect(deny?.hookSpecificOutput?.permissionDecision).toBe("deny");
    const agent = await handlers.PreToolUse!(
      base({
        hook_event_name: "PreToolUse",
        tool_name: "Agent",
        tool_input: { prompt: "do x" },
      }),
    );
    expect(agent?.hookSpecificOutput?.updatedInput?.prompt).toMatch(/^Use the eminiar tools/);

    const allowed = await handlers.PreToolUse!(
      base({
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "git status --short | head -5" },
      }),
    );
    expect(allowed?.hookSpecificOutput?.permissionDecision).toBeUndefined();

    await handlers.PreCompact!(base({ hook_event_name: "PreCompact", trigger: "auto" }));
    const db = getStorage(getContext(root), { vectors: false });
    // every routed native call leaves one routing event: the denial and the allowed one
    const routing = db.eventsBySession("s1", { categories: ["routing"] }).map(
      (e) =>
        JSON.parse(e.payload) as {
          tool: string;
          decision: string;
          target?: string;
        },
    );
    expect(routing).toContainEqual(
      expect.objectContaining({
        tool: "Bash",
        decision: "deny",
        target: "em_history",
      }),
    );
    expect(routing).toContainEqual(expect.objectContaining({ tool: "Bash", decision: "allow" }));
    expect(formatRoutingStats("routing", routingStats(db.eventsBySession("s1")))).toContain(
      "Bash 1/2 denied (50%)",
    );
    const snap = db.snapshotLatestUnconsumed("s1");
    expect(snap).toBeDefined();
    expect(snap!.bytes).toBeLessThanOrEqual(2048);
    expect(snap!.body).toMatch(/\*\*Files Modified\*\*: .*src\/x\.ts/);
    expect(snap!.body).toContain("**Loops**");
    expect(snap!.body).toContain("**Key Decisions**");

    const resume = await handlers.SessionStart!(
      base({ hook_event_name: "SessionStart", source: "compact" }),
    );
    expect(resume?.hookSpecificOutput?.additionalContext).toContain("## Session Guide (eminiar)");
    expect(db.snapshotLatestUnconsumed("s1")).toBeUndefined();
  });
});

describe("graph context in hooks", () => {
  it("hints matching symbols for Grep, coverage gaps for Read, and briefs subagents", async () => {
    const ctx = getContext(root);
    const db = getStorage(ctx, { vectors: false });
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src/x.ts"), "export function parseThing() {}\n");
    writeFileSync(join(root, "src/ok.ts"), "export const ok = 1;\n");
    db.graphUpsertNodes([
      {
        id: "file:src/x.ts",
        kind: "file",
        name: "src/x.ts",
        path: "src/x.ts",
        source: "tree-sitter",
      },
      {
        id: "sym:src/x.ts#parseThing",
        kind: "function",
        name: "parseThing",
        path: "src/x.ts",
        startLine: 7,
        endLine: 9,
        source: "tree-sitter",
      },
    ]);
    db.fileIndexSet({
      path: "src/x.ts",
      hash: "h",
      mtime: 0,
      size: 1,
      language: "typescript",
      document_id: null,
      status: "partial",
      reason: "2 syntax errors recovered",
    });
    db.fileIndexSet({
      path: "src/ok.ts",
      hash: "h",
      mtime: 0,
      size: 1,
      language: "typescript",
      document_id: null,
    });
    db.metricsReplace([
      {
        node_id: "file:src/x.ts",
        kind: "file",
        path: "src/x.ts",
        fan_in: 3,
        fan_out: 0,
        loc: 9,
        complexity: 1,
        commits_90d: 2,
        score: 0.8,
        cluster: 0,
      },
    ]);
    expect(literalOf("parse\\w+Thing")).toBe("parse");
    expect(literalOf("\\.ts$")).toBeUndefined();

    const grep = await handlers.PreToolUse!(
      base({
        hook_event_name: "PreToolUse",
        tool_name: "Grep",
        tool_input: { pattern: "parseTh", output_mode: "files_with_matches" },
      }),
    );
    expect(grep?.hookSpecificOutput?.permissionDecision).toBeUndefined();
    expect(grep?.hookSpecificOutput?.additionalContext).toContain(
      "function parseThing (src/x.ts:7)",
    );
    // a denied content grep still carries the hint in its reason
    const denied = await handlers.PreToolUse!(
      base({
        hook_event_name: "PreToolUse",
        tool_name: "Grep",
        tool_input: { pattern: "parseThing", output_mode: "content" },
      }),
    );
    expect(denied?.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(denied?.hookSpecificOutput?.permissionDecisionReason).toContain("parseThing");

    const read = await handlers.PreToolUse!(
      base({
        hook_event_name: "PreToolUse",
        tool_name: "Read",
        tool_input: { file_path: `${root}/src/x.ts` },
      }),
    );
    expect(read?.hookSpecificOutput?.additionalContext).toContain("src/x.ts is partial");
    const readOk = await handlers.PreToolUse!(
      base({
        hook_event_name: "PreToolUse",
        tool_name: "Read",
        tool_input: { file_path: `${root}/src/ok.ts` },
      }),
    );
    expect(readOk).toBeUndefined();

    const agent = await handlers.PreToolUse!(
      base({
        hook_event_name: "PreToolUse",
        tool_name: "Agent",
        tool_input: { prompt: "do y" },
      }),
    );
    const prompt = String(agent?.hookSpecificOutput?.updatedInput?.prompt);
    expect(prompt).toMatch(/^Use the eminiar tools/);
    expect(prompt).toContain("Project brief (eminiar)");
    expect(prompt).toContain("Hot files (fan-in × churn): src/x.ts");
    expect(prompt.endsWith("do y")).toBe(true);

    const start = await handlers.SessionStart!(
      base({ hook_event_name: "SessionStart", source: "startup" }),
    );
    expect(start?.hookSpecificOutput?.additionalContext).toContain("Code graph: 1 files indexed");
    expect(start?.hookSpecificOutput?.additionalContext).toContain("1 with gaps");
  });
});

describe("subagent findings", () => {
  it("indexes SubagentStop messages so em_recall can find them", async () => {
    await handlers.SubagentStop!(
      base({
        hook_event_name: "SubagentStop",
        agent_type: "Explore",
        last_assistant_message: "The leak is in pool.ts where connections are never released.",
      }),
    );
    const db = getStorage(getContext(root), { vectors: false });
    const r = await search(db, "pool leak", {
      mode: "lexical",
      filters: { source: ["session"] },
    });
    expect(r.hits.some((h) => h.chunk.body.includes("pool.ts"))).toBe(true);
    expect(r.hits[0]?.chunk.document.title).toBe("agent_findings");
  });
});

describe("server liveness", () => {
  it("drops markers for dead pids and keeps live ones", () => {
    const ctx = getContext(root);
    // 2^22 is above the default pid_max on Linux and macOS, so it is never a live process
    const dead = markServerAlive(ctx, 4_194_304);
    expect(liveServers(ctx)).toContain(process.pid);
    expect(liveServers(ctx)).not.toContain(4_194_304);
    dead();
  });

  it("annotates instead of denying in enforce mode when no server is running", async () => {
    const other = mkdtempSync(join(tmpdir(), "em-root-noserver-"));
    writeFileSync(join(other, "package.json"), "{}");
    writeFileSync(
      join(other, "eminiar.config.json"),
      JSON.stringify({
        routing: { mode: "enforce", deferToContextMode: false },
      }),
    );
    gitRepo(other);
    const out = await handlers.PreToolUse!(
      base({
        hook_event_name: "PreToolUse",
        cwd: other,
        tool_name: "Bash",
        tool_input: { command: "git log" },
      }),
    );
    expect(out?.hookSpecificOutput?.permissionDecision).toBeUndefined();
    expect(out?.hookSpecificOutput?.additionalContext).toContain("em_history");
    expect(out?.hookSpecificOutput?.additionalContext).toContain("not running");
  });
});

describe("routing stats", () => {
  it("tallies calls, denials and annotations per native tool, target and rule", () => {
    const ev = (p: object): EventRow => ({
      id: 0,
      session_id: "s",
      ts: 0,
      category: "routing",
      priority: 4,
      tool: null,
      payload: JSON.stringify(p),
      document_id: null,
    });
    const s = routingStats([
      ev({
        tool: "Bash",
        decision: "deny",
        target: "em_execute",
        rule: "heavy",
      }),
      ev({ tool: "Bash", decision: "allow" }),
      ev({
        tool: "Read",
        decision: "deny",
        target: "em_execute_file",
        rule: "big-read",
      }),
      ev({
        tool: "Grep",
        decision: "annotate",
        target: "em_symbols",
        rule: "symbol",
      }),
      { ...ev({}), category: "recall" },
    ]);
    expect(s.decisions).toBe(4);
    expect(s.byTool.Bash).toEqual({
      calls: 2,
      denied: 1,
      annotated: 0,
      targets: { em_execute: 1 },
      rules: { heavy: 1 },
    });
    const text = formatRoutingStats("routing", s);
    expect(text).toContain("Bash 1/2 denied (50%)");
    expect(text).toContain("Grep 0/1 denied (0%), 1 annotated");
    expect(text).toContain(
      "denied → em_execute ×1, em_execute_file ×1; by rule: heavy ×1, big-read ×1",
    );
    expect(formatRoutingStats("routing", routingStats([]))).toContain("no routing decisions");
  });
});

describe("renderWithin", () => {
  it("drops low-priority sections and trims to the budget", () => {
    const sections = [
      { title: "Last Request", priority: 1, items: ["a".repeat(500)] },
      {
        title: "Files Modified",
        priority: 1,
        items: Array.from({ length: 50 }, (_, i) => `file${i}.ts`),
      },
      { title: "Intent", priority: 4, items: ["x".repeat(900)] },
      { title: "Slow Calls", priority: 3, items: ["y".repeat(900)] },
    ];
    const out = renderWithin(sections, 1024);
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(1024);
    expect(out).not.toContain("Intent");
    expect(out).toContain("Last Request");
  });
});
