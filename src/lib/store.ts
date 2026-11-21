// Small JSON-file store for idempotency and an audit trail.
// Good enough for a demo; swap for Postgres or Redis in production.

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";

type Record_ = { firstSeen: string; result?: unknown };

export class LeadStore {
  private seen = new Map<string, Record_>();
  private file: string | null;

  constructor(file: string | null = "data/leads.json") {
    this.file = file;
    if (file && existsSync(file)) {
      const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, Record_>;
      for (const [k, v] of Object.entries(raw)) this.seen.set(k, v);
    }
  }

  /** Returns true the first time a key is claimed, false for every repeat (webhook retries, double submits). */
  claim(key: string): boolean {
    if (this.seen.has(key)) return false;
    this.seen.set(key, { firstSeen: new Date().toISOString() });
    this.flush();
    return true;
  }

  saveResult(key: string, result: unknown): void {
    const rec = this.seen.get(key) ?? { firstSeen: new Date().toISOString() };
    rec.result = result;
    this.seen.set(key, rec);
    this.flush();
  }

  get(key: string): Record_ | undefined {
    return this.seen.get(key);
  }

  private flush(): void {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(Object.fromEntries(this.seen), null, 2));
  }
}
