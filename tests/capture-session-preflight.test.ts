import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCaptureSessionPreflight } from "../src/capture-session-preflight.ts";

class FakeChild extends EventEmitter {
	stdin = new PassThrough();
	stdout = new PassThrough();
	stderr = new PassThrough();
	killed = false;
	kill() {
		this.killed = true;
		return true;
	}
}

async function workspaceWithHelper(): Promise<{ root: string; helper: string; dispose(): Promise<void> }> {
	const root = await realpath(await mkdtemp(join(tmpdir(), "pitgram-preflight-")));
	await mkdir(join(root, "tools"));
	const helper = join(root, "tools", "capture_session.py");
	await writeFile(helper, "# fixture helper\n");
	return { root, helper, dispose: () => rm(root, { recursive: true, force: true }) };
}

test("capture-session subprocess uses fixed argv, canonical cwd, and unchanged context stdin", async () => {
	const workspace = await workspaceWithHelper();
	const source = { kind: "telegram", text: "/session synthetic", captureScopeSupported: true };
	let command = "";
	let args: string[] = [];
	let spawnOptions: any;
	let input = "";
	try {
		const spawnMock = ((file: string, argv: string[], options: unknown) => {
			command = file;
			args = argv;
			spawnOptions = options;
			const child = new FakeChild();
			child.stdin.on("data", chunk => input += chunk.toString());
			child.stdin.on("finish", () => setImmediate(() => {
				child.stdout.end(JSON.stringify({ status: "handled", message: "captured", capture_ref: "a1b2c3d4" }));
				child.emit("close", 0);
			}));
			return child;
		}) as any;
		const result = await runCaptureSessionPreflight(workspace.root, source, { spawn: spawnMock });
		assert.deepEqual(result, { status: "handled", message: "captured" });
		assert.equal(command, "python3");
		assert.deepEqual(args, [workspace.helper, "--telegram-context-stdin", "--json"]);
		assert.deepEqual(spawnOptions, { cwd: workspace.root, shell: false, stdio: ["pipe", "pipe", "pipe"] });
		assert.deepEqual(JSON.parse(input), { version: 1, available: true, source });
	} finally {
		await workspace.dispose();
	}
});

test("missing helper passes through; malformed output and timeout fail closed", async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "pitgram-preflight-missing-")));
	try {
		assert.deepEqual(await runCaptureSessionPreflight(root, {}), { status: "missing" });
	} finally {
		await rm(root, { recursive: true, force: true });
	}

	const workspace = await workspaceWithHelper();
	try {
		const malformedSpawn = ((..._args: unknown[]) => {
			const child = new FakeChild();
			child.stdin.on("finish", () => setImmediate(() => {
				child.stdout.end("{}");
				child.emit("close", 0);
			}));
			return child;
		}) as any;
		await assert.rejects(runCaptureSessionPreflight(workspace.root, {}, { spawn: malformedSpawn }), /invalid result/);

		let child: FakeChild | undefined;
		const hangingSpawn = ((..._args: unknown[]) => child = new FakeChild()) as any;
		await assert.rejects(runCaptureSessionPreflight(workspace.root, {}, {
			spawn: hangingSpawn,
			timeoutMs: 10,
		}), /timed out/);
		assert.equal(child?.killed, true);
	} finally {
		await workspace.dispose();
	}
});
