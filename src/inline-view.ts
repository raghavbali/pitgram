import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

const MAX_INLINE_VIEW_BYTES = 128 * 1024;
const MAX_INLINE_VIEW_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_MESSAGE_LENGTH = 4096;
const MAX_ROWS = 8;
const MAX_BUTTONS = 40;

export interface InlineViewButton {
	text: string;
	data: string;
}

export interface InlineView {
	text: string;
	buttons: InlineViewButton[][];
	suppressFinalReply: boolean;
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
	return Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
}

function inside(parent: string, child: string): boolean {
	const rel = relative(parent, child);
	return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function validIso(value: unknown): value is string {
	if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value)
		|| !Number.isFinite(Date.parse(value))) return false;
	const normalized = new Date(value).toISOString();
	return value === normalized || value === normalized.replace(".000Z", "Z");
}

function validateButtons(value: unknown): value is InlineViewButton[][] {
	if (!Array.isArray(value) || value.length < 1 || value.length > MAX_ROWS) return false;
	let count = 0;
	for (const row of value) {
		if (!Array.isArray(row) || row.length < 1) return false;
		for (const button of row) {
			if (!button || typeof button !== "object") return false;
			const item = button as Record<string, unknown>;
			if (!exactKeys(item, ["text", "data"]) || typeof item.text !== "string" || [...item.text].length < 1 || [...item.text].length > 64
				|| typeof item.data !== "string" || Buffer.byteLength(item.data, "utf8") < 1 || Buffer.byteLength(item.data, "utf8") > 2048) return false;
			count++;
		}
	}
	return count <= MAX_BUTTONS;
}

/** Read and validate a private, cwd-bound Python-produced inline view. */
export async function readInlineView(viewPath: string, expectedSha256: string, actor: {
	chatId: number;
	userId: number;
	originCwd: string;
}, now = Date.now()): Promise<InlineView> {
	if (typeof viewPath !== "string" || !isAbsolute(viewPath) || typeof expectedSha256 !== "string" || !/^[a-f0-9]{64}$/.test(expectedSha256)) {
		throw new Error("Invalid inline view reference");
	}
	if (!Number.isSafeInteger(actor.chatId) || !Number.isSafeInteger(actor.userId) || actor.userId <= 0
		|| typeof actor.originCwd !== "string" || !isAbsolute(actor.originCwd) || !Number.isSafeInteger(now)) {
		throw new Error("Invalid inline view actor binding");
	}
	const cwd = resolve(actor.originCwd);
	if (cwd !== actor.originCwd) throw new Error("Inline view working directory is not canonical");
	const resolvedPath = resolve(viewPath);
	if (resolvedPath !== viewPath) throw new Error("Inline view path is not canonical");
	const fileName = viewPath.split(sep).at(-1) ?? "";
	if (!/^[a-f0-9]{32}\.json$/.test(fileName)) throw new Error("Invalid inline view filename");
	const parent = resolve(viewPath, "..");
	if (parent !== viewPath.slice(0, viewPath.length - fileName.length - 1) || parent.split(sep).at(-1) !== "telegram_inline_views"
		|| !inside(cwd, parent)) throw new Error("Inline view path is outside the authorized workspace");
	const canonicalCwd = await realpath(cwd);
	const canonicalParent = await realpath(parent);
	if (canonicalCwd !== cwd || canonicalParent !== parent) throw new Error("Inline view path contains a symlink");

	let current = cwd;
	const relParent = relative(cwd, parent);
	for (const component of relParent.split(sep).filter(Boolean)) {
		current = resolve(current, component);
		const info = await lstat(current);
		if (info.isSymbolicLink() || !info.isDirectory()) {
			throw new Error("Inline view directory is not private");
		}
	}
	const dirInfo = await lstat(parent);
	if ((dirInfo.mode & 0o777) !== 0o700 || (typeof process.getuid === "function" && dirInfo.uid !== process.getuid())) {
		throw new Error("Inline view directory is not private");
	}

	const noFollow = constants.O_NOFOLLOW ?? 0;
	const file = await open(viewPath, constants.O_RDONLY | noFollow);
	try {
		const before = await file.stat();
		if (!before.isFile() || before.size < 1 || before.size > MAX_INLINE_VIEW_BYTES || before.nlink !== 1
			|| (before.mode & 0o777) !== 0o600 || (typeof process.getuid === "function" && before.uid !== process.getuid())) {
			throw new Error("Inline view file is not private or exceeds its size limit");
		}
		const bounded = Buffer.alloc(MAX_INLINE_VIEW_BYTES + 1);
		let bytesRead = 0;
		while (bytesRead < bounded.length) {
			const result = await file.read(bounded, bytesRead, bounded.length - bytesRead, bytesRead);
			if (result.bytesRead === 0) break;
			bytesRead += result.bytesRead;
		}
		if (bytesRead > MAX_INLINE_VIEW_BYTES) throw new Error("Inline view exceeds its size limit");
		const bytes = bounded.subarray(0, bytesRead);
		const after = await file.stat();
		if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || bytes.length !== before.size) {
			throw new Error("Inline view changed while being read");
		}
		if (createHash("sha256").update(bytes).digest("hex") !== expectedSha256) throw new Error("Inline view digest mismatch");
		let parsed: unknown;
		try { parsed = JSON.parse(bytes.toString("utf8")); }
		catch { throw new Error("Invalid inline view JSON"); }
		if (!parsed || typeof parsed !== "object") throw new Error("Invalid inline view schema");
		const value = parsed as Record<string, unknown>;
		const keys = ["version", "chatId", "userId", "originCwd", "createdAt", "expiresAt", "text", "buttons", "suppressFinalReply"];
		if (!exactKeys(value, keys) || value.version !== 1 || value.chatId !== actor.chatId || value.userId !== actor.userId
			|| value.originCwd !== cwd || value.suppressFinalReply !== true || typeof value.text !== "string"
			|| value.text.length < 1 || value.text.length > MAX_MESSAGE_LENGTH || !validateButtons(value.buttons)
			|| !validIso(value.createdAt) || !validIso(value.expiresAt)) throw new Error("Inline view does not match the authorized source");
		const createdAt = Date.parse(value.createdAt);
		const expiresAt = Date.parse(value.expiresAt);
		if (createdAt > now + 60_000 || expiresAt <= now || expiresAt <= createdAt || expiresAt - createdAt > MAX_INLINE_VIEW_TTL_MS) {
			throw new Error("Inline view has expired or has an invalid lifetime");
		}
		return { text: value.text, buttons: value.buttons, suppressFinalReply: true };
	} finally {
		await file.close();
	}
}
