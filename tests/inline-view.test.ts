import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { chmod, link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readInlineView } from "../src/inline-view.ts";

const now = Date.parse("2026-10-07T12:00:00.000Z");

async function fixture() {
	const cwd = await realpath(await mkdtemp(join(os.tmpdir(), "pitgram-inline-view-")));
	const directory = join(cwd, "data", "telegram_inline_views");
	await mkdir(directory, { recursive: true, mode: 0o700 });
	await chmod(join(cwd, "data"), 0o755);
	await chmod(directory, 0o700);
	const path = join(directory, `${randomBytes(16).toString("hex")}.json`);
	const artifact = {
		version: 1,
		chatId: 42,
		userId: 42,
		originCwd: cwd,
		createdAt: new Date(now - 1000).toISOString().replace(".000Z", "Z"),
		expiresAt: new Date(now + 60_000).toISOString().replace(".000Z", "Z"),
		text: "Inbox page",
		buttons: [[{ text: "Task", data: "opaque:task" }, { text: "Delete", data: "opaque:delete" }]],
		suppressFinalReply: true,
	};
	const bytes = Buffer.from(JSON.stringify(artifact));
	await writeFile(path, bytes, { mode: 0o600 });
	await chmod(path, 0o600);
	const viewSha256 = createHash("sha256").update(bytes).digest("hex");
	return { cwd, path, artifact, viewSha256, cleanup: () => rm(cwd, { recursive: true, force: true }) };
}

test("reads a matching private inline view and returns only its bounded display payload", async () => {
	const f = await fixture();
	try {
		const result = await readInlineView(f.path, f.viewSha256, { chatId: 42, userId: 42, originCwd: f.cwd }, now);
		assert.deepEqual(result, { text: "Inbox page", buttons: f.artifact.buttons, suppressFinalReply: true });
	} finally { await f.cleanup(); }
});

test("rejects digest, actor, cwd, expiry, schema, and path mismatches", async () => {
	const f = await fixture();
	try {
		const actor = { chatId: 42, userId: 42, originCwd: f.cwd };
		await assert.rejects(readInlineView(f.path, "0".repeat(64), actor, now), /digest/);
		await assert.rejects(readInlineView(f.path, f.viewSha256, { ...actor, userId: 43 }, now), /authorized source/);
		await assert.rejects(readInlineView(f.path, f.viewSha256, { ...actor, originCwd: `${f.cwd}-other` }, now), /outside|working directory/);
		await assert.rejects(readInlineView(f.path, f.viewSha256, actor, now + 60_001), /expired/);
		const outside = join(os.tmpdir(), `${randomBytes(16).toString("hex")}.json`);
		await assert.rejects(readInlineView(outside, f.viewSha256, actor, now), /filename|outside/);
	} finally { await f.cleanup(); }
});

test("rejects a symlink artifact directory", async () => {
	const f = await fixture();
	const aliasParent = join(f.cwd, "other");
	const alias = join(aliasParent, "telegram_inline_views");
	try {
		await mkdir(aliasParent, { recursive: true, mode: 0o700 });
		await chmod(aliasParent, 0o700);
		await symlink(join(f.cwd, "data", "telegram_inline_views"), alias, "dir");
		const path = join(alias, f.path.split("/").at(-1)!);
		await assert.rejects(readInlineView(path, f.viewSha256, { chatId: 42, userId: 42, originCwd: f.cwd }, now));
	} finally { await f.cleanup(); }
});

test("rejects non-private files/directories, hard links, and symlink artifacts", async () => {
	const f = await fixture();
	try {
		const actor = { chatId: 42, userId: 42, originCwd: f.cwd };
		await chmod(f.path, 0o644);
		await assert.rejects(readInlineView(f.path, f.viewSha256, actor, now), /private/);
		await chmod(f.path, 0o600);
		const linked = join(f.cwd, "data", "telegram_inline_views", `${randomBytes(16).toString("hex")}.json`);
		await link(f.path, linked);
		await assert.rejects(readInlineView(f.path, f.viewSha256, actor, now), /private|hardlink|size/);
		await rm(linked);
		const linkedName = join(f.cwd, "data", "telegram_inline_views", `${randomBytes(16).toString("hex")}.json`);
		await symlink(f.path, linkedName);
		await assert.rejects(readInlineView(linkedName, f.viewSha256, actor, now));
		await rm(linkedName);
		await chmod(join(f.cwd, "data", "telegram_inline_views"), 0o755);
		await assert.rejects(readInlineView(f.path, f.viewSha256, actor, now), /private/);
	} finally { await f.cleanup(); }
});

test("rejects extra schema keys, oversized artifacts, and lifetimes beyond 24 hours", async () => {
	const f = await fixture();
	try {
		const actor = { chatId: 42, userId: 42, originCwd: f.cwd };
		const rewrite = async (value: unknown) => {
			const bytes = Buffer.from(JSON.stringify(value));
			await writeFile(f.path, bytes, { mode: 0o600 });
			await chmod(f.path, 0o600);
			return createHash("sha256").update(bytes).digest("hex");
		};
		const extraKey = { ...f.artifact, unexpected: true };
		await assert.rejects(readInlineView(f.path, await rewrite(extraKey), actor, now), /schema|authorized source/);
		await assert.rejects(readInlineView(f.path, await rewrite({ ...f.artifact, expiresAt: "2026-10-08T12:00:01Z" }), actor, now), /lifetime/);
		const oversized = { ...f.artifact, text: "x".repeat(128 * 1024) };
		await assert.rejects(readInlineView(f.path, await rewrite(oversized), actor, now), /size/);
	} finally { await f.cleanup(); }
});
