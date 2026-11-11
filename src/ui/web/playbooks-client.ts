// Typed client for the Playbooks API (GET /api/playbooks; writes are POST /api/playbooks/*).
// Kept out of api.ts so that file stays untouched; it uses api.ts's request helpers.
import type { PlaybookSuggestionUi, PlaybookUi } from "../playbooks-api.js";
import { api, post } from "./api.js";

export type { PlaybookSuggestionUi, PlaybookUi };

export interface PlaybookRunUi {
  id: number;
  playbook: string;
  ts: number;
  trigger: string;
  session_id: string | null;
  status: string;
  note: string | null;
}

export interface PlaybooksOverview {
  /** playbooks.viewing: false hides everything. */
  viewing: boolean;
  /** playbooks.adding: false makes the list read-only. */
  adding: boolean;
  /** playbooks.extraction.enabled: the suggested inbox exists only when true. */
  extraction: boolean;
  dir: string;
  privateDir: string;
  playbooks: PlaybookUi[];
  runs: PlaybookRunUi[];
  suggestions: PlaybookSuggestionUi[];
  /** Files in the playbook folders that could not be read (bad name, link, ...). */
  skipped: string[];
}

export interface PlaybookScanResult {
  dryRun: boolean;
  mode: "embeddings" | "lexical";
  prompts: number;
  clusters: number;
  suggested: number;
  known: number;
  candidates: Array<{ title: string; sessions: number; days: number; servers: string[] }>;
}

export interface PlaybookDraft {
  name?: string | undefined;
  title: string;
  prompt: string;
  params: Array<{ name: string; default?: string | undefined }>;
  schedule?: string | undefined;
  tags: string[];
  private: boolean;
  replace?: boolean | undefined;
}

export const playbooksApi = {
  overview: () => api<PlaybooksOverview>("/api/playbooks"),
  save: (d: PlaybookDraft) =>
    post<{ name: string; path: string; created: boolean }>("/api/playbooks/save", d),
  remove: (name: string) => post<{ removed: boolean }>("/api/playbooks/delete", { name }),
  recordRun: (name: string) => post<{ id: number }>("/api/playbooks/run", { name }),
  accept: (id: number, priv = false) =>
    post<{ name: string; path: string }>("/api/playbooks/suggestion/accept", {
      id,
      private: priv,
    }),
  scan: (dryRun: boolean) => post<PlaybookScanResult>("/api/playbooks/scan", { dryRun }),
  dismiss: (id: number) =>
    post<{ dismissed: boolean }>("/api/playbooks/suggestion/dismiss", { id }),
};

/** `{{name}}` filled from `values`, then the parameter default; gaps stay as written. */
export function fillPrompt(
  prompt: string,
  params: Array<{ name: string; default?: string | undefined }>,
  values: Record<string, string>,
): string {
  return prompt.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (whole, name: string) => {
    const v = Object.hasOwn(values, name) ? values[name] : undefined;
    return v || params.find((p) => p.name === name)?.default || whole;
  });
}
