import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { InlineButtonRegistry, INLINE_BUTTON_TTL_MS } from "../dist/inline-buttons.js";

async function fixture(botIdentity = "fixture-bot") {
	const directory = await mkdtemp(join(os.tmpdir(), "pitgram-inline-buttons-"));
	const registry = new InlineButtonRegistry(directory, botIdentity);
	await registry.load();
	return {
		directory,
		registry,
		async close() { await rm(directory, { recursive: true, force: true }); },
	};
}

test("opaque grants persist with owner-only permissions and bot-scoped message bindings", async () => {
	const app = await fixture();
	try {
		const [grant] = await app.registry.createBatch(
			[{ label: "Journal", data: "review:deadbeef:1:journal" }], 42, 42, 501, "/workspace/project", 1000,
		);
		assert.match(grant.id, /^[a-f0-9]{32}$/);
		assert.equal(grant.expiresAt, 1000 + INLINE_BUTTON_TTL_MS);
		assert.equal((await stat(app.directory)).mode & 0o777, 0o700);
		assert.equal((await stat(app.registry.path)).mode & 0o777, 0o600);
		const snapshot = JSON.parse(await readFile(app.registry.path, "utf8"));
		assert.equal(snapshot.botScope.includes("fixture-bot"), false);
		assert.equal(snapshot.grants[0].messageId, 501);
		assert.equal(snapshot.grants[0].originCwd, "/workspace/project");

		const recovered = new InlineButtonRegistry(app.directory, "fixture-bot");
		await recovered.load();
		assert.deepEqual(await recovered.get(grant.id, 1001), grant);
		const otherBot = new InlineButtonRegistry(app.directory, "other-bot");
		await otherBot.load();
		assert.equal(await otherBot.get(grant.id, 1001), undefined);
	} finally { await app.close(); }
});

test("expired grants are pruned and cannot be replayed", async () => {
	const app = await fixture();
	try {
		const [grant] = await app.registry.createBatch([{ label: "Undo", data: "undo:action-id" }], 42, 42, 501, "/workspace", 1000);
		assert.equal(await app.registry.get(grant.id, grant.expiresAt), undefined);
		assert.deepEqual(JSON.parse(await readFile(app.registry.path, "utf8")).grants, []);
	} finally { await app.close(); }
});

test("corrupt registry state is preserved and symlink files are refused", async () => {
	const app = await fixture();
	try {
		await writeFile(app.registry.path, "{broken");
		const broken = new InlineButtonRegistry(app.directory, "fixture-bot");
		await assert.rejects(broken.load(), /Invalid Pitgram inline-button registry JSON/);
		assert.equal(await readFile(app.registry.path, "utf8"), "{broken");
	} finally { await app.close(); }

	const linked = await fixture();
	try {
		await rm(linked.registry.path, { force: true });
		const target = join(linked.directory, "target.json");
		await writeFile(target, JSON.stringify({ version: 1, grants: [] }));
		await symlink(target, linked.registry.path);
		const unsafe = new InlineButtonRegistry(linked.directory, "fixture-bot");
		await assert.rejects(unsafe.load(), /Cannot safely open/);
		assert.equal((await stat(target)).isFile(), true);
	} finally { await linked.close(); }
});

test("malformed grant fields and serialized-size overflow fail closed", async () => {
	const app = await fixture();
	try {
		const [grant] = await app.registry.createBatch([{ label: "Task", data: "task:abc" }], 42, 42, 501, "/workspace", 1000);
		const snapshot = JSON.parse(await readFile(app.registry.path, "utf8"));
		snapshot.grants[0].expiresAt = grant.createdAt + INLINE_BUTTON_TTL_MS + 1;
		await writeFile(app.registry.path, JSON.stringify(snapshot));
		const invalidTtl = new InlineButtonRegistry(app.directory, "fixture-bot");
		await assert.rejects(invalidTtl.load(), /Invalid or mismatched/);
	} finally { await app.close(); }

	const limited = await mkdtemp(join(os.tmpdir(), "pitgram-inline-buttons-size-"));
	try {
		const registry = new InlineButtonRegistry(limited, "fixture-bot", 128);
		await registry.load();
		await assert.rejects(registry.createBatch([{ label: "Task", data: "task:abc" }], 42, 42, 501, "/workspace"), /size limit/);
		assert.equal(await registry.get("0".repeat(32)), undefined);
	} finally { await rm(limited, { recursive: true, force: true }); }
});

test("invalid grants and persistence failures never publish a callback mapping", async () => {
	const app = await fixture();
	try {
		await assert.rejects(app.registry.createBatch([{ label: "", data: "x" }], 42, 42, 501, "/workspace"), /button text/);
		await assert.rejects(app.registry.createBatch([{ label: "Task", data: "x" }], 42, 42, 0, "/workspace"), /binding/);
		await rm(app.registry.path, { force: true });
		await import("node:fs/promises").then(({ mkdir }) => mkdir(app.registry.path));
		await assert.rejects(app.registry.createBatch([{ label: "Task", data: "task" }], 42, 42, 501, "/workspace"));
		assert.equal(await app.registry.get("0".repeat(32)), undefined);
	} finally { await app.close(); }
});
