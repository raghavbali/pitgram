import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const testHome = await mkdtemp(join(tmpdir(), "pitgram-context-"));
const previousHome = process.env.HOME;
process.env.HOME = testHome;
const { default: pitgram } = await import("../dist/index.js");

function register() {
  const handlers = new Map<string, any>();
  const tools = new Map<string, any>();
  const sent: any[] = [];
  const pi: any = {
    on: (name: string, handler: any) => handlers.set(name, handler),
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: () => {},
    sendUserMessage: (content: any) => sent.push(content),
  };
  pitgram(pi);
  let idle = true;
  const ctx: any = {
    mode: "tui",
    isIdle: () => idle,
    abort: () => {},
    ui: { setStatus: () => {}, theme: { fg: (_name: string, value: string) => value } },
  };
  const context = async () => (await tools.get("pitgram_context").execute("test", {})).details;
  const start = async (prompt: string) => {
    await handlers.get("before_agent_start")({ prompt, systemPrompt: "" }, ctx);
    idle = false;
    await handlers.get("agent_start")({}, ctx);
  };
  const end = async (stopReason = "aborted") => {
    await handlers.get("agent_end")({ messages: [{ role: "assistant", stopReason, content: [] }] }, ctx);
    idle = true;
  };
  return { handlers, sent, ctx, context, start, end, setIdle: (value: boolean) => { idle = value; } };
}

function fakeResponse(result: unknown) {
  return { ok: true, json: async () => ({ ok: true, result }) } as Response;
}

async function fixture(config: Record<string, unknown>, fetchMock: typeof fetch) {
  await mkdir(join(testHome, ".pi", "agent"), { recursive: true });
  await writeFile(join(testHome, ".pi", "agent", "telegram.json"), JSON.stringify(config));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchMock;
  const app = register();
  try {
    await app.handlers.get("session_start")({}, app.ctx);
    return { ...app, async close() {
      await app.handlers.get("session_shutdown")({}, app.ctx);
      assert.equal((await app.context()).available, false);
      globalThis.fetch = originalFetch;
    } };
  } catch (error) {
    globalThis.fetch = originalFetch;
    throw error;
  }
}

async function eventually(predicate: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("Timed out waiting for mocked turn dispatch");
}

test("direct turn preserves untrimmed text, isolates history and refuses local prompt spoofing", async () => {
  const updates = [
    { update_id: 1, message: { message_id: 101, date: 1700000000, chat: { id: 42, type: "private" }, from: { id: 42 }, text: "  remember this  \n" } },
    { update_id: 2, message: { message_id: 102, date: 1700000001, chat: { id: 42, type: "private" }, from: { id: 42 }, text: "idea: second" } },
  ];
  let wake: (() => void) | undefined;
  const fetchMock = async (url: string, init?: RequestInit) => {
    const method = url.split("/").pop();
    if (method === "getUpdates") {
      if (updates.length) return fakeResponse([updates.shift()]);
      await new Promise<void>((resolve) => {
        wake = resolve;
        init?.signal?.addEventListener("abort", resolve, { once: true });
      });
      return fakeResponse([]);
    }
    if (method === "deleteWebhook" || method === "sendChatAction") return fakeResponse(true);
    if (method === "sendMessage" || method === "sendMessageDraft") return fakeResponse({ message_id: 500 });
    throw Error("Unexpected network call: " + url);
  };
  const app = await fixture({ botToken: "TEST_TOKEN", allowedUserId: 42, lastUpdateId: 0 }, fetchMock as typeof fetch);
  try {
    await eventually(() => app.sent.length >= 1);
    assert.deepEqual(await app.context(), { version: 1, available: false, source: null });
    await app.start("[telegram] a local fake message");
    assert.equal((await app.context()).available, false);
    await app.end();
    await app.start(app.sent[0][0].text);
    const first = await app.context();
    assert.equal(first.source.text, "  remember this  \n");
    assert.equal(first.source.chatId, 42);
    assert.equal(first.source.messageId, 101);
    assert.equal(first.source.timestamp, 1700000000);
    assert.equal(first.source.relayTurnId, null);
    assert.equal(first.source.typedCaptureSupported, true);
    await eventually(() => updates.length === 0);
    await app.end();
    assert.equal((await app.context()).available, false);
    await eventually(() => app.sent.length >= 2);
    await app.start(app.sent.at(-1)[0].text);
    const second = await app.context();
    assert.equal(second.source.messageId, 102);
    assert.equal(second.source.text, "idea: second");
    await app.end();
  } finally {
    await app.close();
    wake?.();
  }
});

test("relay uses edited delivered text and a stable relay fallback when message ID is absent", async () => {
  const relayTurn = { id: 77, chatId: 42, userText: "edited queue text", payload: { messageId: undefined, text: "original queue text", date: 1700000002 } };
  let claimed = false;
  const fetchMock = async (url: string, init?: RequestInit) => {
    if (url.includes("cloud.telegram.org")) {
      const { args } = JSON.parse(String(init?.body));
      if (args.op === "next") {
        if (!claimed) {
          claimed = true;
          return { ok: true, json: async () => ({ ok: true, result: { result: { ok: true, turn: relayTurn } } }) } as Response;
        }
        return { ok: true, json: async () => ({ ok: true, result: { result: { ok: true, turn: null } } }) } as Response;
      }
      return { ok: true, json: async () => ({ ok: true, result: { result: { ok: true } } }) } as Response;
    }
    const method = url.split("/").pop();
    if (method === "sendChatAction" || method === "sendMessageDraft") return fakeResponse(true);
    if (method === "sendMessage") return fakeResponse({ message_id: 501 });
    throw Error("Unexpected network call: " + url);
  };
  const app = await fixture({ botToken: "TEST_TOKEN", allowedUserId: 42, relayEnabled: true, relayToken: "app123:TEST" }, fetchMock as typeof fetch);
  try {
    await eventually(() => app.sent.length > 0);
    await app.start(app.sent[0][0].text);
    const source = (await app.context()).source;
    assert.equal(source.text, "edited queue text");
    assert.equal(source.messageId, null);
    assert.equal(source.relayTurnId, 77);
    assert.equal(source.timestamp, 1700000002);
    assert.equal(source.typedCaptureSupported, true);
    await app.end();
    assert.equal((await app.context()).available, false);
  } finally {
    await app.close();
  }
});

test.after(async () => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  await rm(testHome, { recursive: true, force: true });
});
