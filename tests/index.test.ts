import test from "node:test";
import assert from "node:assert/strict";
import {
	isTelegramPrompt,
	sanitizeFileName,
	guessExtensionFromMime,
	guessMediaType,
	isImageMimeType,
	formatTokens,
	chunkParagraphs,
	tgcloudAppId,
} from "../dist/index.js";
import { parseQueueFlag, stripQueueFlag } from "../relay/lib/queue_flags.js";

test("isTelegramPrompt identifies telegram prompt prefix", () => {
	assert.equal(isTelegramPrompt("[telegram] hello world"), true);
	assert.equal(isTelegramPrompt("  [telegram]\nLine 2"), true);
	assert.equal(isTelegramPrompt("hello world"), false);
});

test("tgcloudAppId validates Telegram Serverless CLI tokens", () => {
	assert.equal(tgcloudAppId("app1234:secret-value"), "app1234");
	assert.equal(tgcloudAppId("1234:secret-value"), undefined);
	assert.equal(tgcloudAppId("app1234:"), undefined);
});

test("relay queue flags support immediate and delayed delivery", () => {
	assert.deepEqual(parseQueueFlag("-q write this"), { delayMs: 0 });
	assert.deepEqual(parseQueueFlag("-q 2h30m write this"), { delayMs: 9_000_000 });
	assert.deepEqual(parseQueueFlag("write this --queue=45m"), { delayMs: 2_700_000 });
	assert.equal(parseQueueFlag("-quality matters"), null);
	assert.equal(stripQueueFlag("-q 2h30m write this"), "write this");
});

test("sanitizeFileName strips invalid characters", () => {
	assert.equal(sanitizeFileName("file name with spaces & special!chars?.png"), "file_name_with_spaces_special_chars_.png");
	assert.equal(sanitizeFileName("valid-file_123.jpg"), "valid-file_123.jpg");
});

test("guessExtensionFromMime maps MIME types to extensions", () => {
	assert.equal(guessExtensionFromMime("image/jpeg", ".dat"), ".jpg");
	assert.equal(guessExtensionFromMime("image/png", ".dat"), ".png");
	assert.equal(guessExtensionFromMime("audio/mpeg", ".dat"), ".mp3");
	assert.equal(guessExtensionFromMime("application/pdf", ".dat"), ".pdf");
	assert.equal(guessExtensionFromMime(undefined, ".txt"), ".txt");
});

test("guessMediaType identifies media types from paths", () => {
	assert.equal(guessMediaType("photo.jpg"), "image/jpeg");
	assert.equal(guessMediaType("IMAGE.PNG"), "image/png");
	assert.equal(guessMediaType("document.pdf"), undefined);
});

test("isImageMimeType correctly checks for image prefix", () => {
	assert.equal(isImageMimeType("image/webp"), true);
	assert.equal(isImageMimeType("application/json"), false);
	assert.equal(isImageMimeType(undefined), false);
});

test("formatTokens formats token counts into human readable strings", () => {
	assert.equal(formatTokens(500), "500");
	assert.equal(formatTokens(2500), "2.5k");
	assert.equal(formatTokens(45000), "45k");
	assert.equal(formatTokens(2500000), "2.5M");
});

test("chunkParagraphs splits large text blocks cleanly", () => {
	const shortText = "Hello world";
	assert.deepEqual(chunkParagraphs(shortText), ["Hello world"]);

	const paragraph1 = "A".repeat(2500);
	const paragraph2 = "B".repeat(2000);
	const combined = `${paragraph1}\n\n${paragraph2}`;
	const chunks = chunkParagraphs(combined);
	assert.equal(chunks.length, 2);
	assert.equal(chunks[0], paragraph1);
	assert.equal(chunks[1], paragraph2);
});

test("pitgram-connect and pitgram-disconnect commands emit terminal notifications", async () => {
	const pitgramExtensionModule = await import("../dist/index.js");
	const pitgramExtension = pitgramExtensionModule.default;

	const commands = new Map<string, any>();
	const mockApi: any = {
		on: () => {},
		registerTool: () => {},
		registerCommand: (name: string, options: any) => {
			commands.set(name, options);
		},
	};

	pitgramExtension(mockApi);

	assert.equal(commands.has("pitgram-connect"), true);
	assert.equal(commands.has("pitgram-disconnect"), true);
	assert.equal(commands.has("pitgram-relay-setup"), true);
	assert.equal(commands.has("pitgram-relay-disable"), true);

	const notifications: Array<{ message: string; type: string }> = [];
	const mockCtx: any = {
		ui: {
			notify: (message: string, type: string) => {
				notifications.push({ message, type });
			},
			setStatus: () => {},
			theme: { fg: (_color: string, text: string) => text },
		},
	};

	const connectCmd = commands.get("pitgram-connect");
	await connectCmd.handler("", mockCtx);
	assert.equal(notifications.length > 0, true);

	const disconnectCmd = commands.get("pitgram-disconnect");
	await disconnectCmd.handler("", mockCtx);
	assert.equal(notifications.length > 1, true);
	assert.equal(notifications.some((n) => n.message.includes("disconnected")), true);
});
