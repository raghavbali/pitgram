import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { existsSync, realpathSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const testHome = await mkdtemp(join(os.tmpdir(), "pitgram-runtime-"));
const originalHomedir = os.homedir;
os.homedir = () => testHome;
syncBuiltinESMExports();
// Exercise the installed host, whose version can differ from local peer dependencies.
const binary = process.env.PI_BINARY ?? "/opt/homebrew/bin/pi";
let hostDirectory: string | undefined;
if (existsSync(binary)) {
  let directory = dirname(realpathSync(binary));
  for (let i = 0; i < 4; i++, directory = dirname(directory)) {
    if (existsSync(join(directory, "index.js")) && existsSync(join(directory, "core/resource-loader.js"))) {
      hostDirectory = directory;
      break;
    }
  }
}
const pi: any = hostDirectory ? await import(pathToFileURL(join(hostDirectory, "index.js")).href) : undefined;
const AuthStorage = hostDirectory
  ? (await import(pathToFileURL(join(hostDirectory, "core/auth-storage.js")).href)).AuthStorage : undefined;
const hostRequire = hostDirectory ? createRequire(join(hostDirectory, "index.js")) : undefined;
const aiDirectory = hostRequire?.resolve.paths("@earendil-works/pi-ai")
  ?.map(path => join(path, "@earendil-works/pi-ai"))
  .find(path => existsSync(join(path, "dist/index.js")));
const createAssistantMessageEventStream = aiDirectory
  ? (await import(pathToFileURL(join(aiDirectory, "dist/index.js")).href)).createAssistantMessageEventStream : undefined;

async function runReconnectBatch(retryOnce = false, rejectPreflight = false) {
  const agentDir = join(testHome, ".pi/agent");
  await rm(join(agentDir, "pitgram"), { recursive: true, force: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "telegram.json"), JSON.stringify({
    botToken: "TEST_TOKEN", allowedUserId: 42, lastUpdateId: 100,
  }));
  const originalFetch = globalThis.fetch;
  const errors: string[] = [];
  const processed: string[] = [];
  const replies: string[] = [];
  let returnedBatch = false;
  let session: any;
  let settledRuns = 0;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    assert.ok(url.startsWith("https://api.telegram.org/botTEST_TOKEN/"), "No real Telegram or model network calls");
    const method = url.split("/").pop();
    const body = JSON.parse(String(init.body));
    let result: any = true;
    if (method === "getUpdates") {
      if (!returnedBatch) {
        returnedBatch = true;
        result = ["A", "B"].map((text, i) => ({ update_id: 101 + i,
          message: { message_id: 201 + i, date: 1700000000 + i, text,
            chat: { id: 42, type: "private" }, from: { id: 42 } },
        }));
      } else {
        await new Promise<void>(resolve => {
          if (init.signal?.aborted) resolve();
          else init.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        result = [];
      }
    } else if (method === "sendMessage" || method === "sendMessageDraft") {
      if (body.text?.startsWith("ACK")) replies.push(body.text);
      result = { message_id: 500 };
    } else assert.ok(["deleteWebhook", "sendChatAction"].includes(method!));
    return { ok: true, json: async () => ({ ok: true, result }) } as Response;
  }) as typeof fetch;
  try {
    const { initTheme } = await import(pathToFileURL(join(hostDirectory!, "modes/interactive/theme/theme.js")).href);
    initTheme("dark", false);
    const runtime = await pi.ModelRuntime.create({
      modelsPath: null, credentials: AuthStorage.inMemory(),
      modelsStorePath: join(testHome, "model-store.json"),
      allowModelNetwork: false, refreshOnCreate: false,
    });
    runtime.registerProvider("pitgram-fixture", {
      baseUrl: "https://fixture.invalid", api: "openai-completions", apiKey: "TEST_KEY",
      models: [{ id: "fixture", name: "Fixture", input: ["text"], reasoning: false,
        contextWindow: 8192, maxTokens: 128,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
      streamSimple(model: any, context: any) {
        const stream = createAssistantMessageEventStream();
        const lastUser = context.messages.filter((m: any) => m.role === "user").at(-1);
        const text = lastUser.content.map((part: any) => part.text ?? "").join("");
        processed.push(text);
        const message: any = { role: "assistant", content: [{ type: "text", text: `ACK ${text}` }],
          api: model.api, provider: model.provider, model: model.id, stopReason: "stop", timestamp: Date.now(),
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        if (retryOnce && processed.length === 1) {
          message.stopReason = "error";
          message.errorMessage = "503 service unavailable";
          message.content = [];
          queueMicrotask(() => { stream.push({ type: "error", reason: "error", error: message }); stream.end(message); });
        } else {
          queueMicrotask(() => { stream.push({ type: "done", reason: "stop", message }); stream.end(message); });
        }
        return stream;
      },
    });
    const settingsManager = pi.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: retryOnce, maxRetries: 1, baseDelayMs: 1 } });
    const loader = new pi.DefaultResourceLoader({ cwd: testHome, agentDir, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
      additionalExtensionPaths: [fileURLToPath(new URL("../dist/index.js", import.meta.url))] });
    await loader.reload();
    assert.equal(loader.getExtensions().errors.length, 0);
    ({ session } = await pi.createAgentSession({ cwd: testHome, agentDir,
      modelRuntime: runtime, model: runtime.getModel("pitgram-fixture", "fixture"),
      settingsManager, resourceLoader: loader, sessionManager: pi.SessionManager.inMemory(), tools: [] }));
    if (rejectPreflight) {
      const send = session.sendUserMessage.bind(session);
      let reject = true;
      session.sendUserMessage = async (...args: any[]) => {
        if (reject) { reject = false; throw new Error("fixture preflight rejection"); }
        return send(...args);
      };
    }
    session.subscribe((event: any) => { if (event.type === "agent_settled") settledRuns++; });
    await session.bindExtensions({ mode: "tui", onError: (error: any) => errors.push(error.error) });
    for (let i = 0; i < 400 && (settledRuns < (rejectPreflight ? 1 : 2) || !session.isIdle); i++) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.deepEqual(errors, rejectPreflight ? ["fixture preflight rejection"] : [], "The actual Pi extension sendUserMessage path must report only the fixture rejection");
    assert.deepEqual(processed, rejectPreflight ? ["[telegram] B"] : retryOnce ? ["[telegram] A", "[telegram] A", "[telegram] B"] : ["[telegram] A", "[telegram] B"]);
    assert.equal(settledRuns, rejectPreflight ? 1 : 2);
    if (!rejectPreflight) assert.ok(replies.some(text => text.includes("[telegram] A")));
    assert.ok(replies.some(text => text.includes("[telegram] B")));
  } finally {
    if (session) {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "shutdown" });
      session.dispose();
    }
    globalThis.fetch = originalFetch;
  }
}

const hostOptions = { skip: !pi?.ModelRuntime && "Set PI_BINARY to an installed Pi host with ModelRuntime" };
test("installed Pi session processes a reconnect batch without concurrent prompt errors", hostOptions, () => runReconnectBatch());
test("installed Pi automatic retry preserves Telegram reply ownership and delivers its successor", hostOptions, () => runReconnectBatch(true));
test("installed Pi preflight rejection retains the failed message and allows its successor to run", hostOptions, () => runReconnectBatch(false, true));

test.after(async () => {
  os.homedir = originalHomedir;
  syncBuiltinESMExports();
  await rm(testHome, { recursive: true, force: true });
});
