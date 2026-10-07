import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const testHome = await mkdtemp(join(os.tmpdir(), "pitgram-notifications-runtime-"));
const originalHomedir = os.homedir;
os.homedir = () => testHome;
syncBuiltinESMExports();
const { default: pitgram } = await import("../dist/index.js");
await mkdir(join(testHome, ".pi", "agent"), { recursive: true });

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(predicate: () => boolean | Promise<boolean>) {
	for (let i = 0; i < 300; i++) {
		if (await predicate()) return;
		await pause(5);
	}
	assert.fail("Timed out waiting for mocked direct polling");
}

function response(data: unknown): Response {
	return { ok: true, json: async () => data } as Response;
}

test("direct notification capability is workspace-bound and sends outside agent turns", async () => {
	await writeFile(join(testHome, ".pi", "agent", "telegram.json"), JSON.stringify({
		botToken: "17:TEST_SECRET", botId: 17, allowedUserId: 42, lastUpdateId: 0,
	}));
	const originalFetch = globalThis.fetch;
	const handlers = new Map<string, any>();
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const eventHandlers = new Map<string, (data: unknown) => void>();
	const sentPrompts: any[] = [];
	const sentNotifications: any[] = [];
	const telegramCalls: string[] = [];
	let deliveryMode: "sent" | "rejected" | "invalid" = "sent";
	let updateDelivered = false;
	let releaseUpdate!: () => void;
	const updateGate = new Promise<void>(resolve => { releaseUpdate = resolve; });
	let getUpdatesStarted!: () => void;
	const pollStarted = new Promise<void>(resolve => { getUpdatesStarted = resolve; });
	let idle = true;
	globalThis.fetch = async (input, init) => {
		const url = String(input);
		const method = url.slice(url.lastIndexOf("/") + 1);
		telegramCalls.push(method);
		if (method === "deleteWebhook") return response({ ok: true, result: true });
		if (method === "sendChatAction") return response({ ok: true, result: true });
		if (method === "getUpdates") {
			getUpdatesStarted();
			if (updateDelivered) return await new Promise<Response>((resolve, reject) => {
				const signal = init?.signal;
				if (!signal) return reject(new Error("missing poll abort signal"));
				if (signal.aborted) return reject(new DOMException("aborted", "AbortError"));
				signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
			});
			await updateGate;
			updateDelivered = true;
			const update = { update_id: 1, message: {
				message_id: 101, date: 1700000000, chat: { id: 42, type: "private" },
				from: { id: 42, is_bot: false, first_name: "Fixture" }, text: "Check tomorrow's schedule",
			} };
			return response({ ok: true, result: [update] });
		}
		if (method === "sendMessage") {
			const body = JSON.parse(String(init?.body));
			sentNotifications.push(body);
			if (deliveryMode === "rejected") return response({ ok: false, error_code: 403, description: "rejected" });
			if (deliveryMode === "invalid") return { ok: true, json: async () => { throw new Error("parse failure"); } } as Response;
			return response({ ok: true, result: { message_id: 701 } });
		}
		throw new Error(`Unexpected mocked Telegram method: ${method}`);
	};

	const eventBus = {
		on(channel: string, handler: (data: unknown) => void) {
			eventHandlers.set(channel, handler);
			return () => eventHandlers.delete(channel);
		},
	};
	const pi: any = {
		events: eventBus,
		on: (name: string, handler: any) => handlers.set(name, handler),
		registerTool: (tool: any) => tools.set(tool.name, tool),
		registerCommand: (name: string, options: any) => commands.set(name, options),
		sendUserMessage: (content: any) => sentPrompts.push(content),
	};
	pitgram(pi);
	const cwd = process.cwd();
	const ctx: any = {
		mode: "tui", cwd, hasUI: false,
		isIdle: () => idle,
		abort: () => {},
		ui: { setStatus() {}, notify() {}, theme: { fg: (_name: string, value: string) => value } },
	};
	try {
		await handlers.get("session_start")({}, ctx);
		await pollStarted;
		const ask = (channel: string, data: Record<string, unknown>) => new Promise<any>(resolve => {
			eventHandlers.get(channel)?.({ ...data, reply: resolve });
		});
		const earlyStatus = await ask("pitgram:notifications:status", { originCwd: cwd });
		assert.equal(earlyStatus.status, "ready");
		assert.equal(sentPrompts.length, 0);
		const notifyToolResult = await tools.get("pitgram_notify").execute("notify", {
			text: "The explicitly requested test message",
		}, undefined, undefined, ctx);
		assert.deepEqual(notifyToolResult.details, { status: "sent", messageId: 701 });
		assert.equal(sentPrompts.length, 0, "pitgram_notify must not create an agent turn");
		releaseUpdate();
		await eventually(() => sentPrompts.length === 1).catch(() => {
			assert.ok(telegramCalls.includes("getUpdates"));
			assert.equal(sentPrompts.length, 1, `authorized direct message was not dispatched; methods=${telegramCalls.join(",")}`);
		});
		await handlers.get("before_agent_start")({ prompt: sentPrompts[0][0].text, systemPrompt: "" }, ctx);
		await handlers.get("agent_start")({}, ctx);
		const context = await tools.get("pitgram_context").execute("context", {});
		assert.equal(context.details.source.notificationsSupported, true);
		assert.deepEqual(context.details.source.notificationTarget, {
			botId: "17", chatId: 42, userId: 42, originCwd: cwd,
		});

		const ready = await ask("pitgram:notifications:status", { originCwd: cwd });
		assert.equal(ready.status, "ready");
		assert.deepEqual(await ask("pitgram:notifications:status", { originCwd: join(cwd, "elsewhere") }),
			{ status: "unavailable", reason: "wrong_workspace" });

		idle = false; // A Pi turn is busy; notification delivery must remain independent.
		const notificationTarget = ready.target;
		assert.deepEqual(await ask("pitgram:notifications:send", {
			target: notificationTarget, text: "Reminder: check tomorrow's schedule",
		}), { status: "sent", messageId: 701 });
		assert.equal(sentPrompts.length, 1);
		assert.deepEqual(sentNotifications[1], { chat_id: 42, text: "Reminder: check tomorrow's schedule" });
		assert.equal(Object.hasOwn(sentNotifications[1], "parse_mode"), false);

		assert.deepEqual(await ask("pitgram:notifications:send", {
			target: { ...notificationTarget, botId: "18" }, text: "wrong bot",
		}), { status: "not_sent", reason: "target_unavailable" });
		assert.deepEqual(await ask("pitgram:notifications:send", {
			target: { ...notificationTarget, userId: 43 }, text: "wrong actor",
		}), { status: "not_sent", reason: "invalid_request" });
		assert.equal(sentNotifications.length, 2);

		deliveryMode = "rejected";
		assert.deepEqual(await ask("pitgram:notifications:send", {
			target: notificationTarget, text: "explicit rejection",
		}), { status: "not_sent", reason: "telegram_rejected" });
		deliveryMode = "invalid";
		assert.deepEqual(await ask("pitgram:notifications:send", {
			target: notificationTarget, text: "ambiguous response",
		}), { status: "uncertain", reason: "invalid_response" });
		assert.equal(sentPrompts.length, 1);

		const originalRealpath = fsPromises.realpath;
		let releaseRealpath!: () => void;
		const realpathGate = new Promise<void>(resolve => { releaseRealpath = resolve; });
		let bothPathsStarted!: () => void;
		const bothPaths = new Promise<void>(resolve => { bothPathsStarted = resolve; });
		let realpathCalls = 0;
		(fsPromises as any).realpath = async (...args: any[]) => {
			const resolved = await (originalRealpath as any)(...args);
			realpathCalls++;
			if (realpathCalls === 2) {
				bothPathsStarted();
				await realpathGate;
			}
			return resolved;
		};
		syncBuiltinESMExports();
		try {
			const staleSend = ask("pitgram:notifications:send", {
				target: notificationTarget, text: "must not cross bot identity",
			});
			await bothPaths;
			await writeFile(join(testHome, ".pi", "agent", "telegram.json"), JSON.stringify({
				botToken: "18:NEW_TEST_SECRET", botId: 18, allowedUserId: 42, lastUpdateId: 0,
			}));
			await handlers.get("session_start")({}, ctx);
			releaseRealpath();
			assert.deepEqual(await staleSend, { status: "not_sent", reason: "target_unavailable" });
			assert.equal(sentNotifications.length, 4, "stale target must never reach Telegram");
		} finally {
			(fsPromises as any).realpath = originalRealpath;
			syncBuiltinESMExports();
			releaseRealpath();
		}

		await commands.get("pitgram-disconnect").handler("", ctx);
		assert.deepEqual(await ask("pitgram:notifications:status", { originCwd: cwd }),
			{ status: "unavailable", reason: "disconnected" });
	} finally {
		await handlers.get("session_shutdown")({}, ctx);
		globalThis.fetch = originalFetch;
		os.homedir = originalHomedir;
		syncBuiltinESMExports();
		await rm(testHome, { recursive: true, force: true });
	}
});
