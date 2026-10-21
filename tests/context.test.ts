import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, readFile, realpath, symlink, writeFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { voiceMetadata } from "../relay/lib/voice_metadata.js";
import { collectFileIds, minimalMessage } from "../relay/lib/telegram_message.js";
import { formatTelegramHelp, TELEGRAM_COMMANDS, TELEGRAM_MENU_COMMANDS } from "../src/telegram-help.ts";
import { runCaptureSessionPreflight } from "../src/capture-session-preflight.ts";

const testHome = await mkdtemp(join(tmpdir(), "pitgram-context-"));
const previousHome = process.env.HOME;
process.env.HOME = testHome;
const { default: pitgram } = await import("../dist/index.js");

function register(cwd = process.cwd()) {
  const handlers = new Map<string, any>();
  const tools = new Map<string, any>();
  const sent: any[] = [];
  const notifications: any[] = [];
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
    cwd,
    isIdle: () => idle,
    abort: () => {},
    ui: { setStatus: () => {}, notify: (...args: any[]) => notifications.push(args), theme: { fg: (_name: string, value: string) => value } },
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
    await handlers.get("agent_settled")({}, ctx);
  };
  return { handlers, sent, notifications, ctx, context, start, end, setIdle: (value: boolean) => { idle = value; } };
}

function fakeResponse(result: unknown) {
  return { ok: true, json: async () => ({ ok: true, result }) } as Response;
}

async function fixture(config: Record<string, unknown>, fetchMock: typeof fetch, recover = false, cwd = process.cwd()) {
  if (!recover) await rm(join(testHome, ".pi", "agent", "pitgram"), { recursive: true, force: true });
  await mkdir(join(testHome, ".pi", "agent"), { recursive: true });
  await writeFile(join(testHome, ".pi", "agent", "telegram.json"), JSON.stringify(config));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchMock;
  const app = register(cwd);
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

async function eventually(predicate: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 200; i++) {
    if (await predicate()) return;
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
  let menuCommands: unknown;
  const fetchMock = async (url: string, init?: RequestInit) => {
    const method = url.split("/").pop();
    if (method === "setMyCommands") {
      menuCommands = JSON.parse(String(init?.body)).commands;
      return fakeResponse(true);
    }
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
  const app = await fixture({ botToken: "17:TEST_TOKEN", allowedUserId: 42, lastUpdateId: 0 }, fetchMock as typeof fetch);
  try {
    await eventually(() => app.sent.length >= 1);
    assert.deepEqual(await app.context(), { version: 1, available: false, source: null });
    await app.start("[telegram] a local fake message");
    assert.equal((await app.context()).available, false);
    await app.end();
    await app.start(app.sent[0][0].text);
    const first = await app.context();
    assert.equal(first.version, 1);
    assert.equal(first.available, true);
    assert.equal(first.source.kind, "telegram");
    assert.equal(first.source.delivery, "direct");
    assert.deepEqual(first.source.attachments, []);
    assert.equal(first.source.text, "  remember this  \n");
    assert.equal(first.source.chatId, 42);
    assert.equal(first.source.messageId, 101);
    assert.equal(first.source.timestamp, 1700000000);
    assert.equal(first.source.relayTurnId, null);
    assert.equal(first.source.typedCaptureSupported, true);
    assert.equal(first.source.voiceCaptureSupported, false);
    assert.equal(first.source.captureScopeSupported, true);
    assert.deepEqual(first.source.captureScope, {
      botId: "17", chatId: 42, userId: 42, originCwd: first.source.originCwd,
    });
    assert.deepEqual(menuCommands, TELEGRAM_MENU_COMMANDS);
    assert.ok(TELEGRAM_MENU_COMMANDS.length <= 100);
    assert.match(formatTelegramHelp(), /\/session \[label\] \[tags\]/);
    assert.match(formatTelegramHelp(), /\/sessions still lists Pi conversation history/);
    for (const command of TELEGRAM_COMMANDS) assert.ok(formatTelegramHelp().includes(command.help));
    for (const command of TELEGRAM_MENU_COMMANDS) {
      assert.match(command.command, /^[a-z0-9_]{1,32}$/);
      assert.ok(command.description.length >= 1 && command.description.length <= 256);
    }
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

test("workspace capture-session helper handles the original direct source before Pi dispatch", async () => {
  const temporaryWorkspace = await mkdtemp(join(tmpdir(), "pitgram-session-gate-"));
  const workspace = await realpath(temporaryWorkspace);
  const workspaceAlias = `${temporaryWorkspace}-alias`;
  await symlink(workspace, workspaceAlias, "dir");
  const toolsDirectory = join(workspace, "tools");
  const markerPath = join(workspace, "helper-input.json");
  await mkdir(toolsDirectory);
  const referenceRoot = process.env.PIBOT_CAPTURE_SESSION_SOURCE_ROOT;
  if (referenceRoot) {
    await cp(join(referenceRoot, "tools", "capture_session.py"), join(toolsDirectory, "capture_session.py"));
    await cp(join(referenceRoot, "pibot"), join(workspace, "pibot"), { recursive: true });
  } else {
    await writeFile(join(toolsDirectory, "capture_session.py"), [
      "import json, sys",
      `open(${JSON.stringify(markerPath)}, "w").write(json.dumps(json.load(sys.stdin)))`,
      'print(json.dumps({"status":"handled","message":"Saved in the active capture."}))',
      "",
    ].join("\n"));
    assert.deepEqual(await runCaptureSessionPreflight(workspace, { text: "direct probe" }), {
      status: "handled", message: "Saved in the active capture.",
    });
    await rm(markerPath, { force: true });
  }
  let updatePending = true;
  const replies: string[] = [];
  const fetchMock = async (url: string, init?: RequestInit) => {
    const method = url.split("/").pop();
    if (method === "setMyCommands") return fakeResponse(true);
    if (method === "getUpdates") {
      if (updatePending) {
        updatePending = false;
        return fakeResponse([{ update_id: 11, message: {
          message_id: 201, date: 1700000000, chat: { id: 42, type: "private" },
          from: { id: 42 }, text: "/session launch #planning",
        } }]);
      }
      await new Promise<void>((resolve) => init?.signal?.addEventListener("abort", () => resolve(), { once: true }));
      return fakeResponse([]);
    }
    if (method === "deleteWebhook") return fakeResponse(true);
    if (method === "sendMessage") {
      replies.push(JSON.parse(String(init?.body)).text);
      return fakeResponse({ message_id: 900 });
    }
    throw Error("Unexpected network call: " + url);
  };
  const app = await fixture({ botToken: "31:TEST_TOKEN", allowedUserId: 42 }, fetchMock as typeof fetch, false, workspaceAlias);
  try {
    if (!referenceRoot) {
      await eventually(async () => {
        try { await readFile(markerPath); return true; }
        catch { return false; }
      });
      const envelope = JSON.parse(await readFile(markerPath, "utf8"));
      assert.deepEqual(Object.keys(envelope).sort(), ["available", "source", "version"]);
      assert.equal(envelope.version, 1);
      assert.equal(envelope.available, true);
      assert.equal(envelope.source.text, "/session launch #planning");
      assert.equal(envelope.source.originCwd, workspace);
      assert.deepEqual(envelope.source.captureScope, {
        botId: "31", chatId: 42, userId: 42, originCwd: workspace,
      });
    }
    await eventually(() => replies.length === 1);
    if (referenceRoot) assert.match(replies[0], /^Capture session started:/);
    else assert.deepEqual(replies, ["Saved in the active capture."]);
    assert.equal(app.sent.length, 0, "handled controls must not reach the Pi model");
  } finally {
    await app.close();
    await rm(temporaryWorkspace, { recursive: true, force: true });
    await rm(workspaceAlias, { force: true });
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
    assert.equal(source.kind, "telegram");
    assert.equal(source.delivery, "relay");
    assert.deepEqual(source.attachments, []);
    assert.equal(source.text, "edited queue text");
    assert.equal(source.messageId, null);
    assert.equal(source.relayTurnId, 77);
    assert.equal(source.timestamp, 1700000002);
    assert.equal(source.typedCaptureSupported, true);
    assert.equal(source.captureScopeSupported, undefined);
    assert.equal(source.captureScope, undefined);
    await app.end();
    assert.equal((await app.context()).available, false);
  } finally {
    await app.close();
  }
});

test("Telegram command-menu timeout warns without preventing polling", async () => {
  let pollingStarted = false;
  const fetchMock = async (url: string, init?: RequestInit) => {
    const method = url.split("/").pop();
    if (method === "setMyCommands") {
      return await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return reject(new Error("missing menu timeout signal"));
        signal.addEventListener("abort", () => reject(new DOMException("Timed out", "AbortError")), { once: true });
      });
    }
    if (method === "deleteWebhook") return fakeResponse(true);
    if (method === "getUpdates") {
      pollingStarted = true;
      await new Promise<void>((resolve) => init?.signal?.addEventListener("abort", () => resolve(), { once: true }));
      return fakeResponse([]);
    }
    throw Error("Unexpected network call: " + url);
  };
  const app = await fixture({ botToken: "29:TEST_TOKEN", allowedUserId: 42, lastUpdateId: 0 }, fetchMock as typeof fetch);
  try {
    await eventually(() => pollingStarted);
    assert.equal(app.notifications.some(([message]) => String(message).includes("Use /help")), true);
  } finally {
    await app.close();
  }
});

test("direct voice context is limited to one eligible voice note", async () => {
  for (const [media, expectedVoice] of [
    [{ voice: { file_id: "voice", mime_type: "audio/ogg", duration: 9 } }, true],
    [{ voice: { file_id: "voice", duration: 9 } }, true],
    [{ voice: { file_id: "voice", mime_type: "audio/ogg", duration: -1 } }, false],
    [{ voice: { file_id: "voice", mime_type: "audio/ogg", duration: 1.5 } }, false],
    [{ caption: "transcript", voice: { file_id: "voice", mime_type: "audio/ogg" } }, false],
    [{ document: { file_id: "document", file_name: "note.txt", mime_type: "audio/ogg" } }, false],
    [{ audio: { file_id: "audio", mime_type: "audio/ogg" } }, false],
    [{ media_group_id: "album", voice: { file_id: "voice", mime_type: "audio/ogg" } }, false],
    [{ voice: { file_id: "voice", mime_type: "audio/mpeg" } }, false],
    [{ voice: { file_id: "voice", mime_type: "audio/ogg" }, document: { file_id: "extra", file_name: "x" } }, false],
  ]) {
    let dispatched = false;
    const fetchMock = async (url: string, init?: RequestInit) => {
      const method = url.split("/").pop();
      if (method === "getUpdates") {
        if (!dispatched) {
          dispatched = true;
          return fakeResponse([{ update_id: 1, message: {
            message_id: 101, date: media.voice ? 1700000000 : undefined,
            chat: { id: 42, type: "private" }, from: { id: 42 }, ...media,
          } }]);
        }
        await new Promise<void>((resolve) => init?.signal?.addEventListener("abort", () => resolve(), { once: true }));
        return fakeResponse([]);
      }
      if (method === "getFile") return fakeResponse({ file_path: "fixture" });
      if (url.includes("/file/bot")) return new Response("offline media fixture");
      if (method === "deleteWebhook" || method === "sendChatAction") return fakeResponse(true);
      if (method === "sendMessage" || method === "sendMessageDraft") return fakeResponse({ message_id: 500 });
      throw Error("Unexpected fixture network call");
    };
    const app = await fixture({ botToken: "TEST_TOKEN", allowedUserId: 42, lastUpdateId: 0 }, fetchMock as typeof fetch);
    try {
      await eventually(() => app.sent.length > 0);
      await app.start(app.sent[0][0].text);
      const envelope = await app.context();
      assert.equal(envelope.available, true);
      assert.equal(envelope.source.typedCaptureSupported, false);
      assert.equal(envelope.source.voiceCaptureSupported, expectedVoice);
      assert.equal(envelope.source.attachments.length, media.voice && media.document ? 2 : 1);
      assert.equal(envelope.source.attachments[0].temporary, true);
      assert.equal(envelope.source.attachments[0].mediaKind, expectedVoice ? "voice" : undefined);
      assert.equal(envelope.source.attachments[0].durationSeconds, expectedVoice ? (media.voice?.duration ?? null) : undefined);
      if (expectedVoice) assert.equal(envelope.source.attachments[0].mimeType, "audio/ogg");
      assert.equal(envelope.source.timestamp, media.voice ? 1700000000 : null);
      await app.end();
    } finally {
      await app.close();
    }
  }
});

test("direct image context marks only one supported current photo or document", async () => {
  const cases: Array<[Record<string, any>, boolean]> = [
    [{ photo: [{ file_id: "p", width: 10, height: 10 }], caption: "caption" }, true],
    [{ photo: [{ file_id: "p", width: 10, height: 10 }], caption: "/capture remember this" }, true],
    [{ photo: [{ file_id: "p", width: 10, height: 10 }] }, true],
    [{ document: { file_id: "d", mime_type: "image/jpeg", file_name: "x.jpg" } }, true],
    [{ document: { file_id: "d", mime_type: "image/png", file_name: "x.png" }, caption: "/capture" }, true],
    [{ document: { file_id: "d", mime_type: "IMAGE/WEBP", file_name: "x.webp" } }, true],
    [{ document: { file_id: "d", mime_type: "image/gif", file_name: "x.jpg" } }, false],
    [{ document: { file_id: "d", mime_type: "application/octet-stream", file_name: "x.png" } }, false],
    [{ photo: [{ file_id: "p", width: 10, height: 10 }], media_group_id: "album" }, false],
    [{ photo: [{ file_id: "p", width: 10, height: 10 }], video: { file_id: "v" } }, false],
    [{ photo: [{ file_id: "p", width: 10, height: 10 }], text: "mixed" }, false],
  ];
  for (const [media, expected] of cases) {
    let dispatched = false;
    const fetchMock = async (url: string, init?: RequestInit) => {
      const method = url.split("/").pop();
      if (method === "getUpdates") {
        if (!dispatched) {
          dispatched = true;
          return fakeResponse([{ update_id: 1, message: { message_id: 101, date: 1700000000,
            chat: { id: 42, type: "private" }, from: { id: 42 }, ...media } }]);
        }
        await new Promise<void>((resolve) => init?.signal?.addEventListener("abort", () => resolve(), { once: true }));
        return fakeResponse([]);
      }
      if (method === "getFile") return fakeResponse({ file_path: "fixture" });
      if (url.includes("/file/bot")) return new Response("image fixture");
      if (method === "deleteWebhook" || method === "sendChatAction") return fakeResponse(true);
      if (method === "sendMessage" || method === "sendMessageDraft") return fakeResponse({ message_id: 500 });
      throw Error("Unexpected fixture network call");
    };
    const app = await fixture({ botToken: "TEST_TOKEN", allowedUserId: 42, lastUpdateId: 0 }, fetchMock as typeof fetch);
    try {
      await eventually(() => app.sent.length > 0);
      await app.start(app.sent[0][0].text);
      const source = (await app.context()).source;
      assert.equal(source.imageCaptureSupported, expected ? true : undefined);
      assert.equal(source.attachments[0].mediaKind, expected ? "image" : undefined);
      if (expected) assert.equal(source.attachments[0].mimeType, String(media.document?.mime_type ?? "image/jpeg").toLowerCase());
      assert.equal(source.voiceCaptureSupported, false);
      if (media.caption !== undefined) assert.equal(source.text, media.caption);
      await app.end();
    } finally {
      await app.close();
    }
  }
});

test("relay preserves actual message identity and refuses flagged media without downloads", async () => {
  for (const hasMedia of [false, true]) {
    let claimed = false;
    const fetchMock = async (url: string, init?: RequestInit) => {
      if (url.includes("cloud.telegram.org")) {
        const { args } = JSON.parse(String(init?.body));
        let result: any = { ok: true };
        if (args.op === "next") {
          result.turn = claimed ? null : { id: 77, chatId: 42,
            userText: "idea: this is a test idea", payload: { messageId: 101, hasMedia } };
          claimed = true;
        }
        return { ok: true, json: async () => ({ ok: true, result: { result } }) } as Response;
      }
      return fakeResponse({ message_id: 501 });
    };
    const app = await fixture({ botToken: "TEST_TOKEN", allowedUserId: 42,
      relayEnabled: true, relayToken: "app123:TEST" }, fetchMock as typeof fetch);
    try {
      await eventually(() => app.sent.length > 0);
      await app.start(app.sent[0][0].text);
      const envelope = await app.context();
      assert.equal(envelope.version, 1);
      assert.equal(envelope.available, true);
      assert.equal(envelope.source.text, "idea: this is a test idea");
      assert.equal(envelope.source.messageId, 101);
      assert.equal(envelope.source.relayTurnId, 77);
      assert.equal(envelope.source.timestamp, null);
      assert.equal(envelope.source.typedCaptureSupported, !hasMedia);
      assert.equal(envelope.source.voiceCaptureSupported, false);
      await app.end();
    } finally {
      await app.close();
    }
  }
});

test("relay voice context requires explicit voice metadata and one uncaptioned Ogg attachment", async () => {
  for (const [turn, expectedVoice] of [
    [{ userText: "", payload: { messageId: 101, date: 1700000000, text: "", hasMedia: true, voice: { mimeType: "audio/ogg", durationSeconds: 6 } }, attachments: [{ fileId: "v", mimeType: "audio/ogg", fileName: "voice.ogg" }] }, true],
    [{ userText: "", payload: { messageId: 101, date: 1700000000, text: "", hasMedia: true, voice: { mimeType: "audio/ogg", durationSeconds: null } }, attachments: [{ fileId: "v", mimeType: "audio/ogg", fileName: "voice.ogg" }] }, true],
    [{ userText: "", payload: { messageId: 101, text: "", hasMedia: true }, attachments: [{ fileId: "v", mimeType: "audio/ogg", fileName: "voice.ogg" }] }, false],
    [{ userText: "caption", payload: { messageId: 101, text: "caption", hasMedia: true, voice: { mimeType: "audio/ogg", durationSeconds: 6 } }, attachments: [{ fileId: "v", mimeType: "audio/ogg" }] }, false],
    [{ userText: "", payload: { messageId: 101, text: " ", hasMedia: true, voice: { mimeType: "audio/ogg", durationSeconds: 6 } }, attachments: [{ fileId: "v", mimeType: "audio/ogg" }] }, false],
    [{ userText: " ", payload: { messageId: 101, text: "", hasMedia: true, voice: { mimeType: "audio/ogg", durationSeconds: 6 } }, attachments: [{ fileId: "v", mimeType: "audio/ogg" }] }, false],
    [{ userText: "", payload: { messageId: 101, text: "", hasMedia: true, voice: { mimeType: "audio/ogg", durationSeconds: -1 } }, attachments: [{ fileId: "v", mimeType: "audio/ogg" }] }, false],
    [{ userText: "", payload: { messageId: 101, text: "", hasMedia: true, voice: { mimeType: "audio/ogg", durationSeconds: 1.5 } }, attachments: [{ fileId: "v", mimeType: "audio/ogg" }] }, false],
    [{ userText: "", payload: { messageId: 101, text: "", hasMedia: true, voice: { mimeType: "audio/ogg", durationSeconds: 6 } }, attachments: [{ fileId: "v", mimeType: "audio/ogg" }, { fileId: "x", mimeType: "audio/ogg" }] }, false],
    [{ userText: "", payload: { messageId: 101, text: "", hasMedia: true, voice: { mimeType: "audio/ogg", durationSeconds: 6 } }, attachments: [{ fileId: "v", mimeType: "audio/mpeg" }] }, false],
  ] as const) {
    let claimed = false;
    const fetchMock = async (url: string, init?: RequestInit) => {
      if (url.includes("cloud.telegram.org")) {
        const { args } = JSON.parse(String(init?.body));
        const result: any = { ok: true };
        if (args.op === "next") { result.turn = claimed ? null : { id: 77, chatId: 42, ...turn }; claimed = true; }
        return { ok: true, json: async () => ({ ok: true, result: { result } }) } as Response;
      }
      if (url.includes("/file/bot")) return new Response("voice fixture");
      if (url.endsWith("/getFile")) return fakeResponse({ file_path: "fixture" });
      return fakeResponse({ message_id: 501 });
    };
    const app = await fixture({ botToken: "TEST_TOKEN", allowedUserId: 42, relayEnabled: true, relayToken: "app123:TEST" }, fetchMock as typeof fetch);
    try {
      await eventually(() => app.sent.length > 0);
      await app.start(app.sent[0][0].text);
      const source = (await app.context()).source;
      assert.equal(source.voiceCaptureSupported, expectedVoice);
      assert.equal(source.messageId, 101);
      assert.equal(source.timestamp, expectedVoice ? 1700000000 : null);
      assert.equal(source.attachments[0].mediaKind, expectedVoice ? "voice" : undefined);
      assert.equal(source.attachments[0].durationSeconds, expectedVoice ? turn.payload.voice.durationSeconds : undefined);
      await app.end();
      assert.equal((await app.context()).available, false);
    } finally { await app.close(); }
  }
});

test("relay voice metadata producer defaults missing voice MIME and rejects other media, text, and invalid durations", () => {
  const message = { message_id: 101, date: 1700000000, chat: { id: 42 }, voice: { file_id: "voice" } };
  const voiceFile = collectFileIds(message);
  assert.equal(voiceFile[0].mimeType, "audio/ogg");
  assert.deepEqual(minimalMessage(message, "").voice, { mimeType: "audio/ogg", durationSeconds: null });
  assert.equal(minimalMessage(message, "").date, 1700000000);
  for (const message of [
    { voice: { file_id: "voice" }, caption: " " },
    { voice: { file_id: "voice" }, text: "\t" },
    { voice: { file_id: "voice" }, document: { file_id: "doc" } },
    { voice: { file_id: "voice", duration: -1 } },
    { voice: { file_id: "voice", duration: 1.25 } },
  ]) {
    assert.equal(voiceMetadata(message, voiceFile), null);
    assert.equal(minimalMessage({ ...message, chat: { id: 42 }, message_id: 101 }, "").voice, undefined);
  }
  assert.equal(voiceMetadata({ voice: { file_id: "voice" } }, [{ ...voiceFile[0], isImage: true }]), null);
});

test("a media group survives shutdown during aggregation and recovers both raw attachment identities", async () => {
  let fetched = false;
  let acknowledged = false;
  let downloads = 0;
  const fetchMock = (async (url: string, init?: RequestInit) => {
    const method = url.split("/").pop();
    if (method === "getUpdates") {
      if (!fetched) {
        fetched = true;
        return fakeResponse([1, 2].map(id => ({ update_id: id, message: {
          message_id: 100 + id, chat: { id: 42, type: "private" }, from: { id: 42 },
          media_group_id: "album", document: { file_id: `file-${id}`, file_name: `note-${id}.txt` },
        } })));
      }
      acknowledged = JSON.parse(String(init?.body)).offset === 3;
      await new Promise<void>(resolve => {
        if (init?.signal?.aborted) resolve();
        else init?.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return fakeResponse([]);
    }
    if (method === "getFile") { downloads++; return fakeResponse({ file_path: "fixture" }); }
    if (url.includes("/file/bot")) return new Response("media fixture");
    if (["deleteWebhook", "sendChatAction"].includes(method!)) return fakeResponse(true);
    if (["sendMessage", "sendMessageDraft"].includes(method!)) return fakeResponse({ message_id: 500 });
    throw new Error("Unexpected fixture network call");
  }) as typeof fetch;
  const config = { botToken: "TEST_TOKEN", allowedUserId: 42, lastUpdateId: 0 };
  const first = await fixture(config, fetchMock);
  await eventually(() => acknowledged);
  assert.equal(downloads, 0, "Aggregation has not yet dispatched or downloaded");
  await first.close();
  const recovered = await fixture(config, fetchMock, true);
  try {
    await eventually(() => recovered.sent.length === 1);
    await recovered.start(recovered.sent[0][0].text);
    assert.equal(downloads, 2);
    assert.equal((await recovered.context()).source.attachments.length, 2);
    await recovered.end("stop");
    const identity = createHash("sha256").update("TEST_TOKEN").digest("hex");
    const snapshot = JSON.parse(await readFile(join(testHome, ".pi/agent/pitgram/queue", `${identity}.json`), "utf8"));
    assert.deepEqual(snapshot.entries, []);
  } finally { await recovered.close(); }
});

test.after(async () => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  await rm(testHome, { recursive: true, force: true });
});
