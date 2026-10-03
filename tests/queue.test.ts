import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";

const testHome = await mkdtemp(join(os.tmpdir(), "pitgram-queue-"));
const originalHomedir = os.homedir;
os.homedir = () => testHome;
syncBuiltinESMExports();
const { default: pitgram } = await import("../dist/index.js");
await mkdir(join(testHome, ".pi", "agent"), { recursive: true });

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(predicate: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await pause(5);
  }
  assert.fail("Timed out waiting for mocked dispatch");
}

async function fixture(initialIdle = true, count = 2) {
  await writeFile(join(testHome, ".pi", "agent", "telegram.json"), JSON.stringify({
    botToken: "TEST_TOKEN", allowedUserId: 42, lastUpdateId: 100,
  }));
  const originalFetch = globalThis.fetch;
  const handlers = new Map<string, any>();
  const tools = new Map<string, any>();
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
        backlogFetched = body.offset === 101 + count;
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
    ui: { setStatus() {}, theme: { fg: (_name: string, text: string) => text } },
  };
  pitgram({
    on: (name: string, handler: any) => handlers.set(name, handler),
    registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand() {},
    // Deliberately leave isIdle true until agent_start: real Pi preflight awaits
    // input hooks/auth before marking the agent busy. This reproduces the burst race.
    sendUserMessage: (content: any, options: any) => {
      assert.equal(options.deliverAs, "followUp");
      sent.push(content);
    },
  } as any);
  await handlers.get("session_start")({}, ctx);
  await eventually(() => backlogFetched);
  return {
    handlers, sent, ctx,
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

test.after(async () => {
  os.homedir = originalHomedir;
  syncBuiltinESMExports();
  await rm(testHome, { recursive: true, force: true });
});
