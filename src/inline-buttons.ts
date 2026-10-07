import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

export const INLINE_BUTTON_TTL_MS = 24 * 60 * 60 * 1000;
export const INLINE_BUTTON_MAX_GRANTS = 4096;
const INLINE_BUTTON_FILE_MAX_BYTES = 32 * 1024 * 1024;

export interface InlineButtonGrant {
	id: string;
	userId: number;
	chatId: number;
	messageId: number;
	originCwd: string;
	data: string;
	label: string;
	createdAt: number;
	expiresAt: number;
}

interface Snapshot {
	version: 1;
	botScope: string;
	grants: InlineButtonGrant[];
}

function isPositiveSafeInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) > 0;
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
	return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function isGrant(value: unknown): value is InlineButtonGrant {
	if (!value || typeof value !== "object") return false;
	const grant = value as Record<string, unknown>;
	return hasExactKeys(grant, ["id", "userId", "chatId", "messageId", "originCwd", "data", "label", "createdAt", "expiresAt"])
		&& typeof grant.id === "string" && /^[a-f0-9]{32}$/.test(grant.id)
		&& isPositiveSafeInteger(grant.userId) && Number.isSafeInteger(grant.chatId)
		&& isPositiveSafeInteger(grant.messageId) && typeof grant.originCwd === "string"
		&& isAbsolute(grant.originCwd) && grant.originCwd.length <= 4096
		&& typeof grant.data === "string" && Buffer.byteLength(grant.data, "utf8") > 0 && Buffer.byteLength(grant.data, "utf8") <= 2048
		&& typeof grant.label === "string" && [...grant.label].length > 0 && [...grant.label].length <= 64
		&& Number.isSafeInteger(grant.createdAt) && Number.isSafeInteger(grant.expiresAt)
		&& (grant.expiresAt as number) > (grant.createdAt as number)
		&& (grant.expiresAt as number) - (grant.createdAt as number) <= INLINE_BUTTON_TTL_MS;
}

export class InlineButtonRegistry {
	readonly path: string;
	private readonly botScope: string;
	private readonly maxFileBytes: number;
	private grants: InlineButtonGrant[] = [];
	private loaded = false;
	private tail: Promise<unknown> = Promise.resolve();

	constructor(directory: string, botIdentity: string, maxFileBytes = INLINE_BUTTON_FILE_MAX_BYTES) {
		if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes < 1) throw new Error("Invalid inline-button registry size limit");
		this.botScope = createHash("sha256").update(botIdentity).digest("hex");
		this.maxFileBytes = maxFileBytes;
		this.path = join(directory, `buttons-${this.botScope}.json`);
	}

	async load(): Promise<void> {
		await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
		await chmod(dirname(this.path), 0o700);
		let file;
		try {
			file = await open(this.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				this.grants = [];
				this.loaded = true;
				return;
			}
			throw new Error("Cannot safely open Pitgram inline-button registry");
		}
		try {
			const info = await file.stat();
			if (!info.isFile() || info.size > this.maxFileBytes) {
				throw new Error("Invalid Pitgram inline-button registry file");
			}
			await file.chmod(0o600);
			const contents = await file.readFile({ encoding: "utf8" });
			let parsed: unknown;
			try { parsed = JSON.parse(contents); }
			catch { throw new Error("Invalid Pitgram inline-button registry JSON"); }
			if (!parsed || typeof parsed !== "object") throw new Error("Invalid Pitgram inline-button registry snapshot");
			const snapshot = parsed as Partial<Snapshot>;
			if (!hasExactKeys(snapshot as Record<string, unknown>, ["version", "botScope", "grants"])
				|| snapshot.version !== 1 || snapshot.botScope !== this.botScope || !Array.isArray(snapshot.grants)
				|| snapshot.grants.length > INLINE_BUTTON_MAX_GRANTS || !snapshot.grants.every(isGrant)
				|| new Set(snapshot.grants.map(grant => grant.id)).size !== snapshot.grants.length) {
				throw new Error("Invalid or mismatched Pitgram inline-button registry");
			}
			this.grants = snapshot.grants;
			this.loaded = true;
		} finally {
			await file.close();
		}
	}

	async createBatch(buttons: Array<{ data: string; label: string }>, userId: number, chatId: number, messageId: number, originCwd: string, now = Date.now()): Promise<InlineButtonGrant[]> {
		this.assertLoaded();
		if (!Array.isArray(buttons) || buttons.length < 1 || buttons.length > 40) throw new Error("Invalid inline-button batch size");
		for (const { data, label } of buttons) {
			if (typeof data !== "string" || Buffer.byteLength(data, "utf8") === 0 || Buffer.byteLength(data, "utf8") > 2048) {
				throw new Error("Inline button data must contain 1 to 2048 UTF-8 bytes");
			}
			if (typeof label !== "string" || [...label].length < 1 || [...label].length > 64) {
				throw new Error("Inline button text must contain 1 to 64 characters");
			}
		}
		if (!isPositiveSafeInteger(userId) || !Number.isSafeInteger(chatId) || !isPositiveSafeInteger(messageId) || !Number.isSafeInteger(now)
			|| typeof originCwd !== "string" || !isAbsolute(originCwd) || originCwd.length > 4096) {
			throw new Error("Invalid inline-button grant binding");
		}
		const created = buttons.map(({ data, label }): InlineButtonGrant => ({
			id: randomUUID().replaceAll("-", ""), userId, chatId, messageId, originCwd,
			data, label, createdAt: now, expiresAt: now + INLINE_BUTTON_TTL_MS,
		}));
		await this.mutate(grants => {
			const current = grants.filter(item => item.expiresAt > now);
			if (current.length + created.length > INLINE_BUTTON_MAX_GRANTS) throw new Error("Inline-button registry is full; wait for old buttons to expire");
			current.push(...created);
			return current;
		});
		return structuredClone(created);
	}

	async get(id: string, now = Date.now()): Promise<InlineButtonGrant | undefined> {
		this.assertLoaded();
		if (!/^[a-f0-9]{32}$/.test(id) || !Number.isSafeInteger(now)) return undefined;
		await this.prune(now);
		const grant = this.grants.find(item => item.id === id && item.expiresAt > now);
		return grant ? structuredClone(grant) : undefined;
	}

	private assertLoaded(): void {
		if (!this.loaded) throw new Error("Pitgram inline-button registry is not loaded");
	}

	private async prune(now: number): Promise<void> {
		if (this.grants.some(grant => grant.expiresAt <= now)) {
			await this.mutate(grants => grants.filter(grant => grant.expiresAt > now));
		}
	}

	private async mutate(change: (grants: InlineButtonGrant[]) => InlineButtonGrant[]): Promise<void> {
		const operation = this.tail.then(async () => {
			this.assertLoaded();
			const next = change(structuredClone(this.grants));
			if (next.length > INLINE_BUTTON_MAX_GRANTS || !next.every(isGrant)) throw new Error("Invalid inline-button registry mutation");
			const snapshot: Snapshot = { version: 1, botScope: this.botScope, grants: next };
			const serialized = JSON.stringify(snapshot) + "\n";
			if (Buffer.byteLength(serialized, "utf8") > this.maxFileBytes) throw new Error("Pitgram inline-button registry size limit reached");
			const temporary = `${this.path}.${randomUUID()}.tmp`;
			try {
				const file = await open(temporary, "wx", 0o600);
				try {
					await file.writeFile(serialized);
					await file.sync();
				} finally { await file.close(); }
				await rename(temporary, this.path);
				const directory = await open(dirname(this.path), "r");
				try { await directory.sync(); } finally { await directory.close(); }
				this.grants = next;
			} finally { await unlink(temporary).catch(() => undefined); }
		});
		this.tail = operation.catch(() => undefined);
		await operation;
	}
}
