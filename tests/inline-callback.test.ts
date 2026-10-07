import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";

const testHome = await mkdtemp(join(os.tmpdir(), "pitgram-inline-callback-"));
const originalHomedir = os.homedir;
os.homedir = () => testHome;
syncBuiltinESMExports();
const { default: pitgram } = await import("../dist/index.js");
await mkdir(join(testHome, ".pi", "agent"), { recursive: true });

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(predicate: () => boolean | Promise<boolean>) {
	for (let i = 0; i < 400; i++) {
		if (await predicate()) return;
		await pause(5);
	}
	assert.fail("Timed out waiting for inline callback flow");
}

test("direct inline callback is durable, authorized, serialized, and exposed only as a typed envelope", async () => {
	await writeFile(join(testHome, ".pi", "agent", "telegram.json"), JSON.stringify({
		botToken: "TEST_TOKEN", botId: 17, allowedUserId: 42, lastUpdateId: 0,
	}));
	const originalFetch = globalThis.fetch;
	const handlers = new Map<string, any>();
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const sentPrompts: any[] = [];
	const methodBodies: Array<{ method: string; body: any }> = [];
	const incoming: any[] = [{ update_id: 1, message: {
		message_id: 101, date: 1700000000, chat: { id: 42, type: "private" },
		from: { id: 42, is_bot: false, first_name: "Fixture" }, text: "show inbox",
	} }];
	let wakePoll: (() => void) | undefined;
	let idle = true;
	let localNextMessageId = 500;
	const queuePath = join(testHome, ".pi", "agent", "pitgram", "queue", createHash("sha256").update("17").digest("hex") + ".json");
	const registryPath = join(testHome, ".pi", "agent", "pitgram", "queue", `buttons-${createHash("sha256").update("17").digest("hex")}.json`);

	globalThis.fetch = (async (url: string, init?: RequestInit) => {
		const method = url.split("/").pop()!;
		const body = init?.body ? JSON.parse(String(init.body)) : {};
		methodBodies.push({ method, body });
		let result: any = true;
		if (method === "getUpdates") {
			if (incoming.length) result = incoming.splice(0);
			else {
				result = await new Promise(resolve => {
					const onAbort = () => resolve([]);
					wakePoll = () => {
						init?.signal?.removeEventListener("abort", onAbort);
						resolve(incoming.splice(0));
					};
					init?.signal?.addEventListener("abort", onAbort, { once: true });
				});
			}
		} else if (method === "sendMessage") {
			result = { message_id: ++localNextMessageId };
		} else if (method === "sendMessageDraft") {
			result = { message_id: 900 };
		} else if (method === "editMessageReplyMarkup") {
			result = true;
		} else if (!["deleteWebhook", "sendChatAction", "answerCallbackQuery", "editMessageText"].includes(method)) {
			throw new Error(`Unexpected Telegram API method ${method}`);
		}
		return { ok: true, json: async () => ({ ok: true, result }) } as Response;
	}) as typeof fetch;

	const ctx: any = {
		mode: "tui", cwd: "/workspace/project", isIdle: () => idle, abort() {},
		ui: { setStatus() {}, notify() {}, theme: { fg: (_name: string, text: string) => text } },
	};
	pitgram({
		on: (name: string, handler: any) => handlers.set(name, handler),
		registerTool: (tool: any) => tools.set(tool.name, tool),
		registerCommand: (name: string, command: any) => commands.set(name, command),
		sendUserMessage: (content: any, options: any) => {
			assert.equal(options.deliverAs, "followUp");
			sentPrompts.push(content);
		},
	} as any);

	try {
		await handlers.get("session_start")({}, ctx);
		await eventually(() => sentPrompts.length === 1);
		const firstPrompt = sentPrompts[0][0].text;
		await handlers.get("before_agent_start")({ prompt: firstPrompt, systemPrompt: "" }, ctx);
		idle = false;
		await handlers.get("agent_start")({}, ctx);
		const contextTool = tools.get("pitgram_context");
		const inlineTool = tools.get("pitgram_inline");
		assert.ok(inlineTool);
		const initialContext = (await contextTool.execute("test", {})).details.source;
		assert.equal(initialContext.delivery, "direct");
		assert.equal(initialContext.userId, 42);
		assert.equal(initialContext.inlineButtonsSupported, true);

		const opaqueData = "review:abc123:1:journal";
		await inlineTool.execute("test", { text: "Choose a destination", buttons: [[{ text: "Journal", data: opaqueData }]] });
		const markupCall = methodBodies.find(call => call.method === "editMessageReplyMarkup");
		assert.ok(markupCall);
		const callbackToken = markupCall.body.reply_markup.inline_keyboard[0][0].callback_data;
		assert.match(callbackToken, /^pg:[a-f0-9]{32}$/);
		assert.equal((await readFile(registryPath, "utf8")).includes(opaqueData), true);
		assert.equal((await readFile(queuePath, "utf8")).includes("TEST_TOKEN"), false);
		const updatesCall = methodBodies.find(call => call.method === "getUpdates");
		assert.deepEqual(updatesCall?.body.allowed_updates, ["message", "edited_message", "callback_query"]);

		incoming.push({ update_id: 2, callback_query: {
			id: "callback-42", from: { id: 42, is_bot: false, first_name: "Fixture" },
			message: { message_id: localNextMessageId, date: 1700000010, chat: { id: 42, type: "private" } },
			data: callbackToken,
		} });
		wakePoll?.();
		wakePoll = undefined;
		await eventually(async () => {
			try {
				const snapshot = JSON.parse(await readFile(queuePath, "utf8"));
				return snapshot.entries.some((entry: any) => entry.update.update_id === 2);
			} catch { return false; }
		});
		assert.equal(sentPrompts.length, 1, "callback waits while the current Pi turn is busy");
		await eventually(() => methodBodies.some(call => call.method === "answerCallbackQuery" && call.body.callback_query_id === "callback-42"));

		await handlers.get("agent_end")({ messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Choose a destination" }] }] }, ctx);
		idle = true;
		await handlers.get("agent_settled")({}, ctx);
		await eventually(() => sentPrompts.length === 2);
		const callbackPrompt = sentPrompts[1][0].text;
		assert.match(callbackPrompt, /Callback query: callback-42/);
		assert.equal(callbackPrompt.includes(opaqueData), false);
		await handlers.get("before_agent_start")({ prompt: callbackPrompt, systemPrompt: "" }, ctx);
		idle = false;
		await handlers.get("agent_start")({}, ctx);
		const callbackSource = (await contextTool.execute("test", {})).details.source;
		assert.deepEqual(Object.keys(callbackSource.callback).sort(), ["data", "grantId", "originCwd", "queryId"]);
		assert.deepEqual(callbackSource.callback, {
			data: opaqueData,
			grantId: callbackToken.slice(3),
			queryId: "callback-42",
			originCwd: "/workspace/project",
		});
		assert.equal(callbackSource.text, null);
		assert.equal(callbackSource.typedCaptureSupported, false);
		assert.equal(callbackSource.voiceCaptureSupported, false);
		assert.equal(callbackSource.userId, 42);
	} finally {
		await handlers.get("session_shutdown")({}, ctx);
		globalThis.fetch = originalFetch;
		os.homedir = originalHomedir;
		syncBuiltinESMExports();
		await rm(testHome, { recursive: true, force: true });
	}
});

test("a durable callback and its grant recover together after a bridge restart", async () => {
	os.homedir = () => testHome;
	syncBuiltinESMExports();
	await mkdir(join(testHome, ".pi", "agent"), { recursive: true });
	await writeFile(join(testHome, ".pi", "agent", "telegram.json"), JSON.stringify({
		botToken: "TEST_TOKEN", botId: 17, allowedUserId: 42, lastUpdateId: 1,
	}));
	const queueDirectory = join(testHome, ".pi", "agent", "pitgram", "queue");
	const callbackData = "discard-review:review-ref:1:1";
	const query = {
		id: "restart-callback-42",
		from: { id: 42, is_bot: false, first_name: "Fixture" },
		message: { message_id: 777, date: 1700000100, chat: { id: 42, type: "private" } },
		data: "",
	};
	const { DurableQueue } = await import("../dist/durable-queue.js");
	const { InlineButtonRegistry } = await import("../dist/inline-buttons.js");
	const queue = new DurableQueue(queueDirectory, "17");
	await queue.load();
	const registry = new InlineButtonRegistry(queueDirectory, "17");
	await registry.load();
	const [grant] = await registry.createBatch([{ label: "Delete", data: callbackData }], 42, 42, 777, "/workspace/project");
	query.data = `pg:${grant.id}`;
	await queue.ingest([{ update_id: 2, callback_query: query }]);
	await queue.close();

	const originalFetch = globalThis.fetch;
	const handlers = new Map<string, any>();
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const sentPrompts: any[] = [];
	let idle = true;
	let fetched = false;
	globalThis.fetch = (async (url: string, init?: RequestInit) => {
		const method = url.split("/").pop()!;
		let result: any = true;
		if (method === "getUpdates") {
			assert.ok(JSON.parse(String(init?.body)).offset >= 3);
			fetched = true;
			result = await new Promise(resolve => init?.signal?.addEventListener("abort", () => resolve([]), { once: true }));
		} else if (method === "sendMessageDraft") result = { message_id: 900 };
		else if (!["deleteWebhook", "sendChatAction", "answerCallbackQuery", "editMessageText", "sendMessage"].includes(method)) {
			throw new Error(`Unexpected Telegram API method ${method}`);
		}
		return { ok: true, json: async () => ({ ok: true, result }) } as Response;
	}) as typeof fetch;
	const ctx: any = {
		mode: "tui", cwd: "/workspace/project", isIdle: () => idle, abort() {},
		ui: { setStatus() {}, notify() {}, theme: { fg: (_name: string, text: string) => text } },
	};
	pitgram({
		on: (name: string, handler: any) => handlers.set(name, handler),
		registerTool: (tool: any) => tools.set(tool.name, tool),
		registerCommand: (name: string, command: any) => commands.set(name, command),
		sendUserMessage: (content: any) => sentPrompts.push(content),
	} as any);
	try {
		await handlers.get("session_start")({}, ctx);
		await eventually(() => fetched && sentPrompts.length === 1);
		const prompt = sentPrompts[0][0].text;
		assert.equal(prompt.includes(callbackData), false);
		await handlers.get("before_agent_start")({ prompt, systemPrompt: "" }, ctx);
		idle = false;
		await handlers.get("agent_start")({}, ctx);
		const source = (await tools.get("pitgram_context").execute("test", {})).details.source;
		assert.deepEqual(source.callback, {
			data: callbackData,
			grantId: grant.id,
			queryId: "restart-callback-42",
			originCwd: "/workspace/project",
		});
	} finally {
		await handlers.get("session_shutdown")({}, ctx);
		globalThis.fetch = originalFetch;
		os.homedir = originalHomedir;
		syncBuiltinESMExports();
		await rm(testHome, { recursive: true, force: true });
	}
});
