import test from "node:test";
import assert from "node:assert/strict";
import {
	NOTIFICATION_SEND_CHANNEL,
	NOTIFICATION_STATUS_CHANNEL,
	NotificationTransport,
	type NotificationTarget,
	type NotificationTargetResult,
} from "../dist/notifications.js";

const target: NotificationTarget = {
	botId: "17", chatId: 42, userId: 42, originCwd: "/workspace/project",
};

function bus() {
	const handlers = new Map<string, (data: unknown) => void>();
	return {
		handlers,
		events: { on(channel: string, handler: (data: unknown) => void) {
			handlers.set(channel, handler);
			return () => handlers.delete(channel);
		} },
		emit(channel: string, data: unknown) { handlers.get(channel)?.(data); },
	};
}

function resultFor(cwd: string): NotificationTargetResult {
	return cwd === target.originCwd
		? { status: "ready", target: { ...target } }
		: { status: "unavailable", reason: "wrong_workspace" };
}

function request<T>(emit: (data: unknown) => void, data: Record<string, unknown>): Promise<T> {
	return new Promise(resolve => emit({ ...data, reply: resolve }));
}

test("direct notification transport reports a scoped target and sends independently of agent turns", async () => {
	const fixture = bus();
	let agentBusy = true;
	const sends: Array<{ target: NotificationTarget; text: string; signal: AbortSignal }> = [];
	const transport = new NotificationTransport(fixture.events, {
		resolveTarget: async cwd => resultFor(cwd),
		send: async (sendTarget, text, signal) => {
			sends.push({ target: sendTarget, text, signal });
			return { status: "sent", messageId: 501 };
		},
	});
	const status = await request<any>(data => fixture.emit(NOTIFICATION_STATUS_CHANNEL, data), {
		originCwd: target.originCwd,
	});
	assert.deepEqual(status, { status: "ready", target });
	const sent = await request<any>(data => fixture.emit(NOTIFICATION_SEND_CHANNEL, data), {
		target, text: "Reminder: review the draft",
	});
	assert.equal(agentBusy, true);
	assert.deepEqual(sent, { status: "sent", messageId: 501 });
	assert.deepEqual(sends.map(call => [call.target, call.text]), [[target, "Reminder: review the draft"]]);
	agentBusy = false;
	await transport.close();
});

test("status reports relay, workspace, pairing and bot ownership as unavailable", async () => {
	const fixture = bus();
	let availability: NotificationTargetResult = { status: "unavailable", reason: "relay_mode" };
	const transport = new NotificationTransport(fixture.events, {
		resolveTarget: async cwd => cwd === target.originCwd ? availability : { status: "unavailable", reason: "wrong_workspace" },
		send: async () => ({ status: "sent", messageId: 1 }),
	});
	assert.deepEqual(await request(fixture.emit.bind(null, NOTIFICATION_STATUS_CHANNEL), { originCwd: target.originCwd }),
		{ status: "unavailable", reason: "relay_mode" });
	assert.deepEqual(await request(fixture.emit.bind(null, NOTIFICATION_STATUS_CHANNEL), { originCwd: "/workspace/other" }),
		{ status: "unavailable", reason: "wrong_workspace" });
	availability = { status: "unavailable", reason: "not_paired" };
	assert.deepEqual(await request(fixture.emit.bind(null, NOTIFICATION_STATUS_CHANNEL), { originCwd: target.originCwd }),
		{ status: "unavailable", reason: "not_paired" });
	availability = { status: "unavailable", reason: "identity_mismatch" };
	assert.deepEqual(await request(fixture.emit.bind(null, NOTIFICATION_STATUS_CHANNEL), { originCwd: target.originCwd }),
		{ status: "unavailable", reason: "identity_mismatch" });
	await transport.close();
});

test("send rejects wrong actors, chats, bots and stale workspace targets before network", async () => {
	const fixture = bus();
	let sends = 0;
	const transport = new NotificationTransport(fixture.events, {
		resolveTarget: async cwd => resultFor(cwd),
		send: async () => { sends++; return { status: "sent", messageId: 1 }; },
	});
	for (const [altered, expected] of [
		[{ ...target, botId: "18" }, "target_unavailable"],
		[{ ...target, chatId: 43, userId: 43 }, "target_unavailable"],
		[{ ...target, userId: 43, chatId: 42 }, "invalid_request"],
		[{ ...target, originCwd: "/workspace/other" }, "target_unavailable"],
	]) {
		assert.deepEqual(await request(fixture.emit.bind(null, NOTIFICATION_SEND_CHANNEL), {
			target: altered, text: "hello",
		}), { status: "not_sent", reason: expected });
	}
	assert.equal(sends, 0);
	await transport.close();
});

test("send distinguishes explicit Telegram rejection from ambiguous network and response failures", async () => {
	const fixture = bus();
	let mode: "rejected" | "network" | "invalid" = "rejected";
	const transport = new NotificationTransport(fixture.events, {
		resolveTarget: async cwd => resultFor(cwd),
		send: async () => {
			if (mode === "network") return { status: "uncertain", reason: "network_error" };
			if (mode === "invalid") return { status: "uncertain", reason: "invalid_response" };
			return { status: "rejected" };
		},
	});
	const send = () => request<any>(fixture.emit.bind(null, NOTIFICATION_SEND_CHANNEL), { target, text: "hello" });
	assert.deepEqual(await send(), { status: "not_sent", reason: "telegram_rejected" });
	mode = "network";
	assert.deepEqual(await send(), { status: "uncertain", reason: "network_error" });
	mode = "invalid";
	assert.deepEqual(await send(), { status: "uncertain", reason: "invalid_response" });
	await transport.close();
});

test("disconnect and shutdown abort in-flight sends and return uncertain without leaking errors", async () => {
	const fixture = bus();
	let started!: () => void;
	const sendStarted = new Promise<void>(resolve => { started = resolve; });
	const transport = new NotificationTransport(fixture.events, {
		resolveTarget: async cwd => resultFor(cwd),
		async send(_sendTarget, _text, signal, _context, markRequestStarted) {
			markRequestStarted?.();
			started();
			return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("secret URL")), { once: true }));
		},
	});
	const sent = request<any>(fixture.emit.bind(null, NOTIFICATION_SEND_CHANNEL), { target, text: "hello" });
	await sendStarted;
	await transport.block("disconnected");
	assert.deepEqual(await sent, { status: "uncertain", reason: "disconnected" });
	assert.equal(transport.inFlightCount, 0);
	assert.deepEqual(await request(fixture.emit.bind(null, NOTIFICATION_STATUS_CHANNEL), { originCwd: target.originCwd }),
		{ status: "unavailable", reason: "disconnected" });
	await transport.close();
});

test("notification transport times out ambiguous sends at its bounded deadline", async () => {
	const fixture = bus();
	const transport = new NotificationTransport(fixture.events, {
		resolveTarget: async cwd => resultFor(cwd),
		timeoutMs: 10,
		send: async (_sendTarget, _text, signal, _context, markRequestStarted) => {
			markRequestStarted?.();
			return new Promise((_resolve, reject) => {
			signal.addEventListener("abort", () => reject(new Error("network request aborted")), { once: true });
			});
		},
	});
	assert.deepEqual(await request(fixture.emit.bind(null, NOTIFICATION_SEND_CHANNEL), { target, text: "hello" }),
		{ status: "uncertain", reason: "timeout" });
	await transport.close();
});

test("disconnect before the request boundary reports not_sent", async () => {
	const fixture = bus();
	let beginSend!: () => void;
	const sendBegun = new Promise<void>(resolve => { beginSend = resolve; });
	let releaseSend!: () => void;
	const sendGate = new Promise<void>(resolve => { releaseSend = resolve; });
	let observedSignal!: AbortSignal;
	const transport = new NotificationTransport(fixture.events, {
		resolveTarget: async cwd => resultFor(cwd),
		send: async (_sendTarget, _text, signal, _context, markRequestStarted) => {
			observedSignal = signal;
			beginSend();
			await sendGate;
			if (signal.aborted || !markRequestStarted?.()) return { status: "not_sent", reason: "target_unavailable" };
			return { status: "sent", messageId: 1 };
		},
	});
	const sent = request(fixture.emit.bind(null, NOTIFICATION_SEND_CHANNEL), { target, text: "hello" });
	await sendBegun;
	const blocked = transport.block("disconnected");
	assert.equal(observedSignal.aborted, true);
	releaseSend();
	await blocked;
	assert.deepEqual(await sent, { status: "not_sent", reason: "target_unavailable" });
	await transport.close();
});

test("notification requests validate payload bounds and exact target shape", async () => {
	const fixture = bus();
	const transport = new NotificationTransport(fixture.events, {
		resolveTarget: async cwd => resultFor(cwd),
		send: async () => ({ status: "sent", messageId: 1 }),
	});
	assert.deepEqual(await request(fixture.emit.bind(null, NOTIFICATION_SEND_CHANNEL), {
		target: { ...target, extra: true }, text: "hello",
	}), { status: "not_sent", reason: "invalid_request" });
	assert.deepEqual(await request(fixture.emit.bind(null, NOTIFICATION_SEND_CHANNEL), {
		target, text: "x".repeat(4097),
	}), { status: "not_sent", reason: "invalid_request" });
	await transport.close();
});
