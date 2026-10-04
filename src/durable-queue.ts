import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface QueueUpdate { update_id: number }
export interface QueueEntry<T> {
  update: T;
  state: "pending" | "running" | "failed";
  attempts: number;
}
interface Snapshot<T> {
  version: 1;
  lastUpdateId?: number;
  completedIds: number[];
  entries: QueueEntry<T>[];
}

// A single bridge owns a bot's polling offset and this local journal.
// Every mutation replaces a synced snapshot atomically; failed writes never
// change the in-memory view or allow the polling offset to advance.
export class DurableQueue<T extends QueueUpdate> {
  private snapshot: Snapshot<T> = { version: 1, entries: [], completedIds: [] };
  private tail: Promise<unknown> = Promise.resolve();
  private ownership: { exec(sql: string): void; close(): void } | undefined;
  readonly path: string;

  constructor(directory: string, botIdentity: string) {
    const identity = createHash("sha256").update(botIdentity).digest("hex");
    this.path = join(directory, `${identity}.json`);
  }

  async load(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await chmod(dirname(this.path), 0o700);
    // Hold a SQLite writer lock on a separate ownership file. The operating
    // system releases it on crash; unlike PID files it has no stale-owner race.
    const sqliteModule = "node:sqlite";
    const { DatabaseSync } = await import(sqliteModule);
    const ownership = new DatabaseSync(`${this.path}.owner.sqlite`, { timeout: 0 });
    try {
      ownership.exec("BEGIN IMMEDIATE");
      await chmod(`${this.path}.owner.sqlite`, 0o600);
      this.ownership = ownership;
    } catch {
      ownership.close();
      throw new Error("Another Pitgram bridge owns this bot's durable queue. Disconnect it first.");
    }
    this.snapshot = { version: 1, entries: [], completedIds: [] };
    let contents: string;
    try { contents = await readFile(this.path, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      await this.close();
      throw new Error("Cannot read Pitgram durable queue; stored messages preserved.");
    }
    try {
      const parsed = JSON.parse(contents);
      if (parsed.version !== 1 || !Array.isArray(parsed.entries)
        || !Array.isArray(parsed.completedIds) || parsed.completedIds.some((id: any) => !Number.isSafeInteger(id))
        || (parsed.lastUpdateId !== undefined && !Number.isSafeInteger(parsed.lastUpdateId))
        || parsed.entries.some((entry: any) => !Number.isSafeInteger(entry.update?.update_id)
          || !["pending", "running", "failed"].includes(entry.state)
          || !Number.isSafeInteger(entry.attempts) || entry.attempts < 0)
        || new Set(parsed.entries.map((entry: any) => entry.update.update_id)).size !== parsed.entries.length) {
        throw new Error("Invalid Pitgram durable queue; polling stopped to preserve stored messages.");
      }
      this.snapshot = parsed;
      await chmod(this.path, 0o600);
      // A running entry has no live owner after a full restart. Retry it once;
      // explicit failures remain held for a user-requested retry.
      await this.mutate(next => {
        for (const entry of next.entries) if (entry.state === "running") entry.state = "pending";
      });
    } catch {
      await this.close();
      throw new Error("Invalid or unwritable Pitgram durable queue; stored messages preserved.");
    }
  }

  get lastUpdateId(): number | undefined { return this.snapshot.lastUpdateId; }
  get entries(): QueueEntry<T>[] { return structuredClone(this.snapshot.entries); }
  get counts() {
    return {
      pending: this.snapshot.entries.filter(entry => entry.state === "pending").length,
      running: this.snapshot.entries.filter(entry => entry.state === "running").length,
      failed: this.snapshot.entries.filter(entry => entry.state === "failed").length,
    };
  }

  async ingest(updates: T[]): Promise<void> {
    if (!updates.length) return;
    await this.mutate(next => {
      for (const update of [...updates].sort((a, b) => a.update_id - b.update_id)) {
        if (!Number.isSafeInteger(update.update_id)) throw new Error("Invalid Telegram update identity");
        if (next.completedIds.includes(update.update_id) || next.entries.some(entry => entry.update.update_id === update.update_id)) continue;
        next.entries.push({ update: structuredClone(update), state: "pending", attempts: 0 });
        next.lastUpdateId = update.update_id;
      }
      next.entries.sort((a, b) => a.update.update_id - b.update.update_id);
    });
  }

  async running(ids: number[]): Promise<void> {
    await this.mutate(next => {
      for (const entry of next.entries) if (ids.includes(entry.update.update_id)) {
        entry.state = "running";
        entry.attempts++;
      }
    });
  }

  async complete(ids: number[]): Promise<void> {
    await this.mutate(next => {
      next.entries = next.entries.filter(entry => !ids.includes(entry.update.update_id));
      next.completedIds = [...new Set([...next.completedIds, ...ids])].slice(-1000);
    });
  }

  async fail(ids: number[]): Promise<void> {
    await this.mutate(next => {
      for (const entry of next.entries) if (ids.includes(entry.update.update_id)) entry.state = "failed";
    });
  }

  async retry(id?: number): Promise<number[]> {
    const ids: number[] = [];
    await this.mutate(next => {
      for (const entry of next.entries) if (entry.state === "failed" && (id === undefined || id === entry.update.update_id)) {
        entry.state = "pending";
        ids.push(entry.update.update_id);
      }
    });
    return ids;
  }

  async settled(): Promise<void> { await this.tail; }

  async close(): Promise<void> {
    await this.settled();
    this.ownership?.close();
    this.ownership = undefined;
  }

  private async mutate(change: (snapshot: Snapshot<T>) => void): Promise<void> {
    const operation = this.tail.then(async () => {
      if (!this.ownership) throw new Error("Durable Telegram queue is not open");
      const next = structuredClone(this.snapshot);
      change(next);
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      try {
        const file = await open(temporary, "wx", 0o600);
        try { await file.writeFile(JSON.stringify(next) + "\n"); await file.sync(); }
        finally { await file.close(); }
        await rename(temporary, this.path);
        const directory = await open(dirname(this.path), "r");
        try { await directory.sync(); } finally { await directory.close(); }
        this.snapshot = next;
      } finally { await unlink(temporary).catch(() => undefined); }
    });
    this.tail = operation.catch(() => undefined);
    await operation;
  }
}
