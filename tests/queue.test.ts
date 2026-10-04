import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";

const testHome = await mkdtemp(join(os.tmpdir(), "pitgram-queue-"));
const originalHomedir = os.homedir;
os.homedir = () => testHome;
syncBuiltinESMExports();
const { default: pitgram } = await import("../dist/index.js");
await mkdir(join(testHome, ".pi", "agent"), { recursive: true });

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const queuePath = join(testHome, ".pi", "agent", "pitgram", "queue", createHash("sha256").update("TEST_TOKEN").digest("hex") + ".json");
const stored = async () => JSON.parse(await readFile(queuePath, "utf8"));
async function eventually(predicate: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await pause(5);
  }
  assert.fail("Timed out waiting for mocked dispatch");
}

async function fixture(initialIdle = true, count = 2, recover = false) {
  if (!recover) await rm(join(testHome, ".pi", "agent", "pitgram"), { recursive: true, force: true });
  await writeFile(join(testHome, ".pi", "agent", "telegram.json"), JSON.stringify({
    botToken: "TEST_TOKEN", allowedUserId: 42, lastUpdateId: 100,
  }));
  const originalFetch = globalThis.fetch;
  const handlers = new Map<string, any>();
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const notifications: string[] = [];
  const sent: any[] = [];
  let idle = initialIdle;
  let batchReturned = false;
  let backlogFetched = false;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    assert.ok(url.startsWith("https://api.telegram.org/botTEST_TOKEN/"));
    const method = url.split("/").pop();
    const body = JSON.parse(String(init.body));
    let result: any = true;
    if (method === "getUpdates") {
      if (!batchReturned) {
        batchReturned = true;
        result = Array.from({ length: count }, (_, i) => ({
          update_id: 101 + i,
          message: { message_id: 201 + i, date: 1700000000 + i,
            chat: { id: 42, type: "private" }, from: { id: 42 },
            text: `offline-retention-test ${i === 0 ? "A" : "B"}` },
        }));
      } else {
        backlogFetched = recover ? body.offset > 100 : body.offset === 101 + count;
        if (!recover) {
          const persisted = await stored();
          assert.equal(persisted.lastUpdateId, 100 + count, "Checkpoint must already be durable before acknowledging to Telegram");
          assert.equal(persisted.entries.length, count, "Raw batch must survive even before agent_start");
        }
        await new Promise<void>(resolve => {
          if (init.signal?.aborted) resolve();
          else init.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        result = [];
      }
    } else if (method === "sendMessage" || method === "sendMessageDraft") {
      result = { message_id: 500 };
    } else assert.ok(["deleteWebhook", "sendChatAction"].includes(method!));
    return { ok: true, json: async () => ({ ok: true, result }) } as Response;
  }) as typeof fetch;
  const ctx: any = {
    mode: "tui", isIdle: () => idle, abort() {},
    ui: { setStatus() {}, notify(text: string) { notifications.push(text); }, theme: { fg: (_name: string, text: string) => text } },
  };
  pitgram({
    on: (name: string, handler: any) => handlers.set(name, handler),
    registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand: (name: string, command: any) => commands.set(name, command),
    // Deliberately leave isIdle true until agent_start: real Pi preflight awaits
    // input hooks/auth before marking the agent busy. This reproduces the burst race.
    sendUserMessage: (content: any, options: any) => {
      assert.equal(options.deliverAs, "followUp");
      sent.push(content);
    },
  } as any);
  await handlers.get("session_start")({}, ctx);
  await eventually(() => backlogFetched);
  if (initialIdle) await eventually(() => sent.length === 1);
  return {
    handlers, sent, ctx, notifications,
    async command(name: string, args = "") { await commands.get(name).handler(args, ctx); },
    async source() { return (await tools.get("pitgram_context").execute("test", {})).details; },
    async start(index: number) {
      await handlers.get("before_agent_start")({ prompt: sent[index][0].text, systemPrompt: "" }, ctx);
      idle = false;
      await handlers.get("agent_start")({}, ctx);
    },
    async end(stopReason = "stop") {
      await handlers.get("agent_end")({ messages: [{ role: "assistant", stopReason, content: [] }] }, ctx);
      // Pi remains busy after agent_end (listeners/retries/compaction still run).
    },
    async settle() {
      idle = true;
      await handlers.get("agent_settled")({}, ctx);
    },
    async close() {
      await handlers.get("session_shutdown")({}, ctx);
      globalThis.fetch = originalFetch;
    },
  };
}

test("one offline batch reserves the first prompt through preflight, then delivers FIFO only after settlement", async () => {
  const app = await fixture();
  try {
    assert.equal(app.sent.length, 1, "Second backlog message must not race the first prompt preflight");
    assert.equal((await app.source()).available, false);
    await app.start(0);
    assert.equal((await app.source()).source.text, "offline-retention-test A");
    await app.end();
    await pause(40);
    assert.equal(app.sent.length, 1, "agent_end is not the settled/idle boundary");
    await app.settle();
    await eventually(() => app.sent.length === 2);
    await app.start(1);
    assert.equal((await app.source()).source.text, "offline-retention-test B");
    assert.equal((await app.source()).source.messageId, 202);
    await app.end();
    await app.settle();
    await pause(20);
    assert.equal(app.sent.length, 2, "No duplicate submission after draining");
  } finally { await app.close(); }
});

test("direct messages received during a local turn drain after that unrelated turn settles", async () => {
  const app = await fixture(false, 1);
  try {
    assert.equal(app.sent.length, 0);
    await app.handlers.get("before_agent_start")({ prompt: "local work", systemPrompt: "" }, app.ctx);
    await app.handlers.get("agent_start")({}, app.ctx);
    assert.equal((await app.source()).available, false);
    await app.end();
    await pause(20);
    assert.equal(app.sent.length, 0);
    await app.settle();
    await eventually(() => app.sent.length === 1);
    await app.start(0);
    assert.equal((await app.source()).source.text, "offline-retention-test A");
  } finally { await app.close(); }
});

test("shutdown cancels deferred dispatch and clears active source context", async () => {
  const app = await fixture(false, 1);
  await app.settle();
  await app.close();
  await pause(20);
  assert.equal(app.sent.length, 0);
  assert.equal((await app.source()).available, false);
});

test("restart recovers an interrupted active turn and its queued successor in order", async () => {
  const first = await fixture();
  await first.start(0);
  await first.close();
  const recovered = await fixture(true, 0, true);
  try {
    assert.equal(recovered.sent[0][0].text, "[telegram] offline-retention-test A");
    await recovered.start(0);
    assert.equal((await recovered.source()).source.messageId, 201);
    await recovered.end(); await recovered.settle();
    await eventually(() => recovered.sent.length === 2);
    await recovered.start(1);
    assert.equal((await recovered.source()).source.messageId, 202);
    await recovered.end(); await recovered.settle();
    assert.deepEqual((await stored()).entries, []);
  } finally { await recovered.close(); }
  const completed = await fixture(false, 0, true);
  try { await completed.settle(); await pause(20); assert.equal(completed.sent.length, 0); }
  finally { await completed.close(); }
});

test("transient model error retains Telegram context until a successful automatic retry settles", async () => {
  const app = await fixture();
  try {
    await app.start(0); await app.end("error");
    assert.equal((await app.source()).source.messageId, 201);
    assert.equal((await stored()).entries[0].state, "running");
    await app.handlers.get("agent_start")({}, app.ctx); // Pi retries without before_agent_start.
    assert.equal((await app.source()).source.messageId, 201);
    await app.end(); await app.settle();
    await eventually(() => app.sent.length === 2);
    assert.equal((await stored()).entries.some((entry: any) => entry.update.update_id === 101), false);
  } finally { await app.close(); }
});

test("terminal model error is retained without replay and can be explicitly retried", async () => {
  const app = await fixture(true, 1);
  try {
    await app.start(0); await app.end("error"); await app.settle();
    assert.equal((await stored()).entries[0].state, "failed");
    await app.command("pitgram-status");
    assert.ok(app.notifications.at(-1)?.includes("failed=1"));
    await app.command("pitgram-retry", "101");
    await eventually(() => app.sent.length === 2);
    await app.start(1); await app.end(); await app.settle();
    assert.deepEqual((await stored()).entries, []);
  } finally { await app.close(); }
});

test.after(async () => {
  os.homedir = originalHomedir;
  syncBuiltinESMExports();
  await rm(testHome, { recursive: true, force: true });
});
