import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";

export type CaptureSessionPreflightResult =
	| { status: "missing" | "pass_through" }
	| { status: "handled"; message: string };

export interface CaptureSessionPreflightOptions {
	timeoutMs?: number;
	maxOutputBytes?: number;
	spawn?: typeof nodeSpawn;
}

const MAX_INPUT_BYTES = 256 * 1024;
const MAX_MESSAGE_LENGTH = 4096;

/** Run the workspace-local capture/session gate before a direct Telegram turn reaches Pi. */
export async function runCaptureSessionPreflight(
	workspaceCwd: string,
	source: unknown,
	options: CaptureSessionPreflightOptions = {},
): Promise<CaptureSessionPreflightResult> {
	if (!isAbsolute(workspaceCwd)) throw new Error("Capture-session workspace path is not absolute");
	let cwd: string;
	try { cwd = await realpath(workspaceCwd); }
	catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return { status: "missing" };
		throw new Error("Capture-session workspace could not be inspected");
	}
	const helperPath = join(cwd, "tools", "capture_session.py");
	let helperInfo;
	try {
		helperInfo = await lstat(helperPath);
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return { status: "missing" };
		throw new Error("Capture-session helper could not be inspected");
	}
	if (!helperInfo.isFile() || helperInfo.isSymbolicLink()) throw new Error("Capture-session helper is not a regular file");
	const canonicalHelper = await realpath(helperPath);
	const helperRelativePath = relative(join(cwd, "tools"), canonicalHelper);
	if (helperRelativePath !== "capture_session.py") throw new Error("Capture-session helper resolved outside its workspace path");

	const input = JSON.stringify({ version: 1, available: true, source });
	if (Buffer.byteLength(input, "utf8") > MAX_INPUT_BYTES) throw new Error("Capture-session context exceeds its input limit");
	const output = await invokeHelper(cwd, helperPath, input, {
		timeoutMs: options.timeoutMs ?? 10_000,
		maxOutputBytes: options.maxOutputBytes ?? 64 * 1024,
		spawn: options.spawn ?? nodeSpawn,
	});
	let parsed: unknown;
	try { parsed = JSON.parse(output); }
	catch { throw new Error("Capture-session helper returned invalid JSON"); }
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("Capture-session helper returned an invalid result");
	}
	const result = parsed as Record<string, unknown>;
	if (result.status === "pass_through" && Object.keys(result).length === 1) {
		return { status: "pass_through" };
	}
	const allowedHandledKeys = new Set([
		"status", "message", "route", "action", "session", "previous_ref",
		"capture_id", "capture_ref", "capture_status", "kind",
	]);
	if (result.status === "handled" && Object.keys(result).every(key => allowedHandledKeys.has(key))
		&& typeof result.message === "string" && result.message.trim().length > 0
		&& result.message.length <= MAX_MESSAGE_LENGTH) {
		return { status: "handled", message: result.message };
	}
	throw new Error("Capture-session helper returned an invalid result");
}

function invokeHelper(
	cwd: string,
	helperPath: string,
	input: string,
	options: { timeoutMs: number; maxOutputBytes: number; spawn: typeof nodeSpawn },
): Promise<string> {
	return new Promise((resolveOutput, rejectOutput) => {
		let child: ChildProcessWithoutNullStreams;
		try {
			child = options.spawn("python3", [helperPath, "--telegram-context-stdin", "--json"], {
				cwd,
				shell: false,
				stdio: ["pipe", "pipe", "pipe"],
			}) as ChildProcessWithoutNullStreams;
		} catch {
			rejectOutput(new Error("Capture-session helper could not start"));
			return;
		}
		let settled = false;
		let stdout = Buffer.alloc(0);
		const finish = (error?: Error, result?: string): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (error) rejectOutput(error);
			else resolveOutput(result ?? "");
		};
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			finish(new Error("Capture-session helper timed out"));
		}, options.timeoutMs);
		child.stdout.on("data", (chunk: Buffer | string) => {
			if (settled) return;
			const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			if (stdout.length + part.length > options.maxOutputBytes) {
				child.kill("SIGKILL");
				finish(new Error("Capture-session helper output exceeded its limit"));
				return;
			}
			stdout = Buffer.concat([stdout, part]);
		});
		// Drain stderr to avoid child-process backpressure, but never expose it to users or logs.
		child.stderr.on("data", () => undefined);
		child.on("error", () => finish(new Error("Capture-session helper could not start")));
		child.on("close", (code: number | null) => {
			if (code !== 0) finish(new Error("Capture-session helper failed"));
			else finish(undefined, stdout.toString("utf8"));
		});
		child.stdin.on("error", () => finish(new Error("Capture-session helper input failed")));
		child.stdin.end(input, "utf8");
	});
}
