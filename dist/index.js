import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { homedir } from "node:os";
import { ExtensionRunner, SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
let activeRunner;
function patchExtensionRunnerClass(RunnerClass) {
    if (!RunnerClass || !RunnerClass.prototype)
        return;
    if (RunnerClass.prototype.__pitgram_patched)
        return;
    RunnerClass.prototype.__pitgram_patched = true;
    const origBindCore = RunnerClass.prototype.bindCore;
    if (typeof origBindCore === "function") {
        RunnerClass.prototype.bindCore = function (...args) {
            activeRunner = this;
            return origBindCore.apply(this, args);
        };
    }
    const origCreateContext = RunnerClass.prototype.createContext;
    if (typeof origCreateContext === "function") {
        RunnerClass.prototype.createContext = function (...args) {
            activeRunner = this;
            return origCreateContext.apply(this, args);
        };
    }
    const origCreateCommandContext = RunnerClass.prototype.createCommandContext;
    if (typeof origCreateCommandContext === "function") {
        RunnerClass.prototype.createCommandContext = function (...args) {
            activeRunner = this;
            return origCreateCommandContext.apply(this, args);
        };
    }
    const origEmit = RunnerClass.prototype.emit;
    if (typeof origEmit === "function") {
        RunnerClass.prototype.emit = function (...args) {
            activeRunner = this;
            return origEmit.apply(this, args);
        };
    }
}
// 1. Patch local imported ExtensionRunner
patchExtensionRunnerClass(ExtensionRunner);
// 2. Patch global/well-known installations of pi-coding-agent
const potentialModulePaths = [
    "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js",
    "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/runner.js",
    "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js",
    "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/runner.js",
];
for (const p of potentialModulePaths) {
    try {
        if (typeof require !== "undefined") {
            const mod = require(p);
            if (mod && mod.ExtensionRunner)
                patchExtensionRunnerClass(mod.ExtensionRunner);
        }
    }
    catch { }
}
// 3. Inspect require.cache if available
if (typeof require !== "undefined" && require.cache) {
    for (const key of Object.keys(require.cache)) {
        if (key.includes("pi-coding-agent") && require.cache[key]?.exports?.ExtensionRunner) {
            patchExtensionRunnerClass(require.cache[key].exports.ExtensionRunner);
        }
    }
}
const CONFIG_PATH = join(homedir(), ".pi", "agent", "telegram.json");
const TEMP_DIR = join(homedir(), ".pi", "agent", "tmp", "telegram");
const TELEGRAM_PREFIX = "[telegram]";
const MAX_MESSAGE_LENGTH = 4096;
const MAX_ATTACHMENTS_PER_TURN = 10;
const PREVIEW_THROTTLE_MS = 750;
const TELEGRAM_DRAFT_ID_MAX = 2_147_483_647;
const TELEGRAM_MEDIA_GROUP_DEBOUNCE_MS = 1200;
const SYSTEM_PROMPT_SUFFIX = `

Telegram bridge extension is active.
- Messages forwarded from Telegram are prefixed with "[telegram]".
- [telegram] messages may include local temp file paths for Telegram attachments. Read those files as needed.
- If a [telegram] user asked for a file or generated artifact, use the pitgram_attach tool with the local file path so the extension can send it with your next final reply.
- Do not assume mentioning a local file path in plain text will send it to Telegram. Use pitgram_attach.`;
export function isTelegramPrompt(prompt) {
    return prompt.trimStart().startsWith(TELEGRAM_PREFIX);
}
export function sanitizeFileName(name) {
    return name.replace(/[^a-zA-Z0-9._-]+/g, "_");
}
export function guessExtensionFromMime(mimeType, fallback) {
    if (!mimeType)
        return fallback;
    const normalized = mimeType.toLowerCase();
    if (normalized === "image/jpeg")
        return ".jpg";
    if (normalized === "image/png")
        return ".png";
    if (normalized === "image/webp")
        return ".webp";
    if (normalized === "image/gif")
        return ".gif";
    if (normalized === "audio/ogg")
        return ".ogg";
    if (normalized === "audio/mpeg")
        return ".mp3";
    if (normalized === "audio/wav")
        return ".wav";
    if (normalized === "video/mp4")
        return ".mp4";
    if (normalized === "application/pdf")
        return ".pdf";
    return fallback;
}
export function guessMediaType(path) {
    const ext = extname(path).toLowerCase();
    if (ext === ".jpg" || ext === ".jpeg")
        return "image/jpeg";
    if (ext === ".png")
        return "image/png";
    if (ext === ".webp")
        return "image/webp";
    if (ext === ".gif")
        return "image/gif";
    return undefined;
}
export function isImageMimeType(mimeType) {
    return mimeType?.toLowerCase().startsWith("image/") ?? false;
}
export function formatTokens(count) {
    if (count < 1000)
        return count.toString();
    if (count < 10000)
        return `${(count / 1000).toFixed(1)}k`;
    if (count < 1000000)
        return `${Math.round(count / 1000)}k`;
    if (count < 10000000)
        return `${(count / 1000000).toFixed(1)}M`;
    return `${Math.round(count / 1000000)}M`;
}
export function chunkParagraphs(text) {
    if (text.length <= MAX_MESSAGE_LENGTH)
        return [text];
    const normalized = text.replace(/\r\n/g, "\n");
    const paragraphs = normalized.split(/\n\n+/);
    const chunks = [];
    let current = "";
    const flushCurrent = () => {
        if (current.trim().length > 0)
            chunks.push(current);
        current = "";
    };
    const splitLongBlock = (block) => {
        if (block.length <= MAX_MESSAGE_LENGTH)
            return [block];
        const lines = block.split("\n");
        const lineChunks = [];
        let lineCurrent = "";
        for (const line of lines) {
            const candidate = lineCurrent.length === 0 ? line : `${lineCurrent}\n${line}`;
            if (candidate.length <= MAX_MESSAGE_LENGTH) {
                lineCurrent = candidate;
                continue;
            }
            if (lineCurrent.length > 0) {
                lineChunks.push(lineCurrent);
                lineCurrent = "";
            }
            if (line.length <= MAX_MESSAGE_LENGTH) {
                lineCurrent = line;
                continue;
            }
            for (let i = 0; i < line.length; i += MAX_MESSAGE_LENGTH) {
                lineChunks.push(line.slice(i, i + MAX_MESSAGE_LENGTH));
            }
        }
        if (lineCurrent.length > 0)
            lineChunks.push(lineCurrent);
        return lineChunks;
    };
    for (const paragraph of paragraphs) {
        if (paragraph.length === 0)
            continue;
        const parts = splitLongBlock(paragraph);
        for (const part of parts) {
            const candidate = current.length === 0 ? part : `${current}\n\n${part}`;
            if (candidate.length <= MAX_MESSAGE_LENGTH) {
                current = candidate;
            }
            else {
                flushCurrent();
                current = part;
            }
        }
    }
    flushCurrent();
    return chunks;
}
async function readConfig() {
    try {
        const content = await readFile(CONFIG_PATH, "utf8");
        const parsed = JSON.parse(content);
        return parsed;
    }
    catch {
        return {};
    }
}
async function writeConfig(config) {
    await mkdir(join(homedir(), ".pi", "agent"), { recursive: true });
    await writeFile(CONFIG_PATH, JSON.stringify(config, null, "\t") + "\n", "utf8");
}
export async function getConfiguredModels(ctx) {
    const modelsJsonPath = join(homedir(), ".pi", "agent", "models.json");
    try {
        const content = await readFile(modelsJsonPath, "utf8");
        const parsed = JSON.parse(content);
        if (parsed.providers) {
            const configured = [];
            const allModels = ctx.modelRegistry.getAll();
            for (const [provider, config] of Object.entries(parsed.providers)) {
                if (Array.isArray(config.models)) {
                    for (const mDef of config.models) {
                        if (!mDef.id)
                            continue;
                        const match = ctx.modelRegistry.find ? ctx.modelRegistry.find(provider, mDef.id) : undefined;
                        const modelObj = match || allModels.find((m) => m.provider === provider && m.id === mDef.id);
                        if (modelObj) {
                            configured.push(modelObj);
                        }
                    }
                }
            }
            if (configured.length > 0) {
                return configured;
            }
        }
    }
    catch {
        // ignore fallback
    }
    return ctx.modelRegistry.getAvailable();
}
export default function (pi) {
    let config = {};
    let pollingController;
    let pollingPromise;
    let queuedTelegramTurns = [];
    let activeTelegramTurn;
    let typingInterval;
    let currentAbort;
    let preserveQueuedTurnsAsHistory = false;
    let setupInProgress = false;
    let previewState;
    let draftSupport = "unknown";
    let nextDraftId = 0;
    const mediaGroups = new Map();
    let sessionCache = [];
    let modelCache = [];
    function allocateDraftId() {
        nextDraftId = nextDraftId >= TELEGRAM_DRAFT_ID_MAX ? 1 : nextDraftId + 1;
        return nextDraftId;
    }
    function updateStatus(ctx, error) {
        const theme = ctx.ui.theme;
        const label = theme.fg("accent", "telegram");
        if (error) {
            ctx.ui.setStatus("telegram", `${label} ${theme.fg("error", "error")} ${theme.fg("muted", error)}`);
            return;
        }
        if (!config.botToken) {
            ctx.ui.setStatus("telegram", `${label} ${theme.fg("muted", "not configured")}`);
            return;
        }
        if (!pollingPromise) {
            ctx.ui.setStatus("telegram", `${label} ${theme.fg("muted", "disconnected")}`);
            return;
        }
        if (!config.allowedUserId) {
            ctx.ui.setStatus("telegram", `${label} ${theme.fg("warning", "awaiting pairing")}`);
            return;
        }
        if (activeTelegramTurn || queuedTelegramTurns.length > 0) {
            const queued = queuedTelegramTurns.length > 0 ? theme.fg("muted", ` +${queuedTelegramTurns.length} queued`) : "";
            ctx.ui.setStatus("telegram", `${label} ${theme.fg("accent", "processing")}${queued}`);
            return;
        }
        ctx.ui.setStatus("telegram", `${label} ${theme.fg("success", "connected")}`);
    }
    async function callTelegram(method, body, options) {
        if (!config.botToken)
            throw new Error("Telegram bot token is not configured");
        const response = await fetch(`https://api.telegram.org/bot${config.botToken}/${method}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
            signal: options?.signal,
        });
        const data = (await response.json());
        if (!data.ok || data.result === undefined) {
            throw new Error(data.description || `Telegram API ${method} failed`);
        }
        return data.result;
    }
    async function callTelegramMultipart(method, fields, fileField, filePath, fileName, options) {
        if (!config.botToken)
            throw new Error("Telegram bot token is not configured");
        const form = new FormData();
        for (const [key, value] of Object.entries(fields)) {
            form.set(key, value);
        }
        const buffer = await readFile(filePath);
        form.set(fileField, new Blob([buffer]), fileName);
        const response = await fetch(`https://api.telegram.org/bot${config.botToken}/${method}`, {
            method: "POST",
            body: form,
            signal: options?.signal,
        });
        const data = (await response.json());
        if (!data.ok || data.result === undefined) {
            throw new Error(data.description || `Telegram API ${method} failed`);
        }
        return data.result;
    }
    async function downloadTelegramFile(fileId, suggestedName) {
        if (!config.botToken)
            throw new Error("Telegram bot token is not configured");
        const file = await callTelegram("getFile", { file_id: fileId });
        await mkdir(TEMP_DIR, { recursive: true });
        const targetPath = join(TEMP_DIR, `${Date.now()}-${sanitizeFileName(suggestedName)}`);
        const response = await fetch(`https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`);
        if (!response.ok)
            throw new Error(`Failed to download Telegram file: ${response.status}`);
        const arrayBuffer = await response.arrayBuffer();
        await writeFile(targetPath, Buffer.from(arrayBuffer));
        return targetPath;
    }
    function startTypingLoop(ctx, chatId) {
        const targetChatId = chatId ?? activeTelegramTurn?.chatId;
        if (typingInterval || targetChatId === undefined)
            return;
        const sendTyping = async () => {
            try {
                await callTelegram("sendChatAction", { chat_id: targetChatId, action: "typing" });
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                updateStatus(ctx, `typing failed: ${message}`);
            }
        };
        void sendTyping();
        typingInterval = setInterval(() => {
            void sendTyping();
        }, 4000);
    }
    function stopTypingLoop() {
        if (!typingInterval)
            return;
        clearInterval(typingInterval);
        typingInterval = undefined;
    }
    function isAssistantMessage(message) {
        return message.role === "assistant";
    }
    function getMessageText(message) {
        const value = message;
        const content = Array.isArray(value.content) ? value.content : [];
        return content
            .filter((block) => typeof block === "object" && block !== null && "type" in block)
            .filter((block) => block.type === "text" && typeof block.text === "string")
            .map((block) => block.text)
            .join("")
            .trim();
    }
    async function clearPreview(chatId) {
        const state = previewState;
        if (!state)
            return;
        if (state.flushTimer) {
            clearTimeout(state.flushTimer);
            state.flushTimer = undefined;
        }
        previewState = undefined;
        if (state.mode === "draft" && state.draftId !== undefined) {
            try {
                await callTelegram("sendMessageDraft", { chat_id: chatId, draft_id: state.draftId, text: "" });
            }
            catch {
                // ignore
            }
        }
    }
    async function flushPreview(chatId) {
        const state = previewState;
        if (!state)
            return;
        state.flushTimer = undefined;
        const text = state.pendingText.trim();
        if (!text || text === state.lastSentText)
            return;
        const truncated = text.length > MAX_MESSAGE_LENGTH ? text.slice(0, MAX_MESSAGE_LENGTH) : text;
        if (draftSupport !== "unsupported") {
            const draftId = state.draftId ?? allocateDraftId();
            state.draftId = draftId;
            try {
                await callTelegram("sendMessageDraft", { chat_id: chatId, draft_id: draftId, text: truncated });
                draftSupport = "supported";
                state.mode = "draft";
                state.lastSentText = truncated;
                return;
            }
            catch {
                draftSupport = "unsupported";
            }
        }
        if (state.messageId === undefined) {
            const sent = await callTelegram("sendMessage", { chat_id: chatId, text: truncated });
            state.messageId = sent.message_id;
            state.mode = "message";
            state.lastSentText = truncated;
            return;
        }
        await callTelegram("editMessageText", { chat_id: chatId, message_id: state.messageId, text: truncated });
        state.mode = "message";
        state.lastSentText = truncated;
    }
    function schedulePreviewFlush(chatId) {
        if (!previewState || previewState.flushTimer)
            return;
        previewState.flushTimer = setTimeout(() => {
            void flushPreview(chatId);
        }, PREVIEW_THROTTLE_MS);
    }
    async function finalizePreview(chatId) {
        const state = previewState;
        if (!state)
            return false;
        await flushPreview(chatId);
        const finalText = (state.pendingText.trim() || state.lastSentText).trim();
        if (!finalText) {
            await clearPreview(chatId);
            return false;
        }
        if (state.mode === "draft") {
            await callTelegram("sendMessage", { chat_id: chatId, text: finalText });
            await clearPreview(chatId);
            return true;
        }
        previewState = undefined;
        return state.messageId !== undefined;
    }
    async function sendTextReply(chatId, _replyToMessageId, text) {
        const chunks = chunkParagraphs(text);
        let lastMessageId;
        for (const chunk of chunks) {
            const sent = await callTelegram("sendMessage", {
                chat_id: chatId,
                text: chunk,
            });
            lastMessageId = sent.message_id;
        }
        return lastMessageId;
    }
    async function sendQueuedAttachments(turn) {
        for (const attachment of turn.queuedAttachments) {
            try {
                const mediaType = guessMediaType(attachment.path);
                const method = mediaType ? "sendPhoto" : "sendDocument";
                const fieldName = mediaType ? "photo" : "document";
                await callTelegramMultipart(method, {
                    chat_id: String(turn.chatId),
                }, fieldName, attachment.path, attachment.fileName);
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                await sendTextReply(turn.chatId, turn.replyToMessageId, `Failed to send attachment ${attachment.fileName}: ${message}`);
            }
        }
    }
    function extractAssistantText(messages) {
        for (let i = messages.length - 1; i >= 0; i--) {
            const message = messages[i];
            if (message.role !== "assistant")
                continue;
            const stopReason = typeof message.stopReason === "string" ? message.stopReason : undefined;
            const errorMessage = typeof message.errorMessage === "string" ? message.errorMessage : undefined;
            const content = Array.isArray(message.content) ? message.content : [];
            const text = content
                .filter((block) => typeof block === "object" && block !== null && "type" in block)
                .filter((block) => block.type === "text" && typeof block.text === "string")
                .map((block) => block.text)
                .join("")
                .trim();
            return { text: text || undefined, stopReason, errorMessage };
        }
        return {};
    }
    function collectTelegramFileInfos(messages) {
        const files = [];
        for (const message of messages) {
            if (Array.isArray(message.photo) && message.photo.length > 0) {
                const photo = [...message.photo].sort((a, b) => (a.file_size ?? 0) - (b.file_size ?? 0)).pop();
                if (photo) {
                    files.push({
                        file_id: photo.file_id,
                        fileName: `photo-${message.message_id}.jpg`,
                        mimeType: "image/jpeg",
                        isImage: true,
                    });
                }
            }
            if (message.document) {
                const fileName = message.document.file_name || `document-${message.message_id}${guessExtensionFromMime(message.document.mime_type, "")}`;
                files.push({
                    file_id: message.document.file_id,
                    fileName,
                    mimeType: message.document.mime_type,
                    isImage: isImageMimeType(message.document.mime_type),
                });
            }
            if (message.video) {
                const fileName = message.video.file_name || `video-${message.message_id}${guessExtensionFromMime(message.video.mime_type, ".mp4")}`;
                files.push({
                    file_id: message.video.file_id,
                    fileName,
                    mimeType: message.video.mime_type,
                    isImage: false,
                });
            }
            if (message.audio) {
                const fileName = message.audio.file_name || `audio-${message.message_id}${guessExtensionFromMime(message.audio.mime_type, ".mp3")}`;
                files.push({
                    file_id: message.audio.file_id,
                    fileName,
                    mimeType: message.audio.mime_type,
                    isImage: false,
                });
            }
            if (message.voice) {
                files.push({
                    file_id: message.voice.file_id,
                    fileName: `voice-${message.message_id}${guessExtensionFromMime(message.voice.mime_type, ".ogg")}`,
                    mimeType: message.voice.mime_type,
                    isImage: false,
                });
            }
            if (message.animation) {
                const fileName = message.animation.file_name || `animation-${message.message_id}${guessExtensionFromMime(message.animation.mime_type, ".mp4")}`;
                files.push({
                    file_id: message.animation.file_id,
                    fileName,
                    mimeType: message.animation.mime_type,
                    isImage: false,
                });
            }
            if (message.sticker) {
                files.push({
                    file_id: message.sticker.file_id,
                    fileName: `sticker-${message.message_id}.webp`,
                    mimeType: "image/webp",
                    isImage: true,
                });
            }
        }
        return files;
    }
    async function buildTelegramFiles(messages) {
        const downloaded = [];
        for (const file of collectTelegramFileInfos(messages)) {
            const path = await downloadTelegramFile(file.file_id, file.fileName);
            downloaded.push({ path, fileName: file.fileName, isImage: file.isImage, mimeType: file.mimeType });
        }
        return downloaded;
    }
    async function promptForConfig(ctx) {
        if (!ctx.hasUI || setupInProgress)
            return;
        setupInProgress = true;
        try {
            const token = await ctx.ui.input("Telegram bot token", "123456:ABCDEF...");
            if (!token)
                return;
            const nextConfig = { ...config, botToken: token.trim() };
            const response = await fetch(`https://api.telegram.org/bot${nextConfig.botToken}/getMe`);
            const data = (await response.json());
            if (!data.ok || !data.result) {
                ctx.ui.notify(data.description || "Invalid Telegram bot token", "error");
                return;
            }
            nextConfig.botId = data.result.id;
            nextConfig.botUsername = data.result.username;
            config = nextConfig;
            await writeConfig(config);
            ctx.ui.notify(`Telegram bot connected: @${config.botUsername ?? "unknown"}`, "info");
            ctx.ui.notify("Send /start to your bot in Telegram to pair this extension with your account.", "info");
            await startPolling(ctx);
            updateStatus(ctx);
        }
        finally {
            setupInProgress = false;
        }
    }
    async function stopPolling() {
        stopTypingLoop();
        pollingController?.abort();
        pollingController = undefined;
        await pollingPromise?.catch(() => undefined);
        pollingPromise = undefined;
    }
    function formatTelegramHistoryText(rawText, files) {
        let summary = rawText.length > 0 ? rawText : "(no text)";
        if (files.length > 0) {
            summary += `\nAttachments:`;
            for (const file of files) {
                summary += `\n- ${file.path}`;
            }
        }
        return summary;
    }
    async function createTelegramTurn(messages, historyTurns = []) {
        const firstMessage = messages[0];
        if (!firstMessage)
            throw new Error("Missing Telegram message for turn creation");
        const rawText = messages.map((message) => (message.text || message.caption || "").trim()).filter(Boolean).join("\n\n");
        const files = await buildTelegramFiles(messages);
        const content = [];
        let prompt = `${TELEGRAM_PREFIX}`;
        if (historyTurns.length > 0) {
            prompt += `\n\nEarlier Telegram messages arrived after an aborted turn. Treat them as prior user messages, in order:`;
            for (const [index, turn] of historyTurns.entries()) {
                prompt += `\n\n${index + 1}. ${turn.historyText}`;
            }
            prompt += `\n\nCurrent Telegram message:`;
        }
        if (rawText.length > 0) {
            prompt += historyTurns.length > 0 ? `\n${rawText}` : ` ${rawText}`;
        }
        if (files.length > 0) {
            prompt += `\n\nTelegram attachments were saved locally:`;
            for (const file of files) {
                prompt += `\n- ${file.path}`;
            }
        }
        content.push({ type: "text", text: prompt });
        for (const file of files) {
            if (!file.isImage)
                continue;
            const mediaType = file.mimeType || guessMediaType(file.path);
            if (!mediaType)
                continue;
            const buffer = await readFile(file.path);
            content.push({
                type: "image",
                data: buffer.toString("base64"),
                mimeType: mediaType,
            });
        }
        return {
            chatId: firstMessage.chat.id,
            replyToMessageId: firstMessage.message_id,
            queuedAttachments: [],
            content,
            historyText: formatTelegramHistoryText(rawText, files),
        };
    }
    async function dispatchAuthorizedTelegramMessages(messages, ctx) {
        const firstMessage = messages[0];
        if (!firstMessage)
            return;
        const rawText = messages.map((message) => (message.text || message.caption || "").trim()).find((text) => text.length > 0) || "";
        const lower = rawText.toLowerCase();
        if (lower === "stop" || lower === "/stop") {
            if (currentAbort) {
                if (queuedTelegramTurns.length > 0) {
                    preserveQueuedTurnsAsHistory = true;
                }
                currentAbort();
                updateStatus(ctx);
                await sendTextReply(firstMessage.chat.id, firstMessage.message_id, "Aborted current turn.");
            }
            else {
                await sendTextReply(firstMessage.chat.id, firstMessage.message_id, "No active turn.");
            }
            return;
        }
        if (lower === "/compact") {
            if (!ctx.isIdle()) {
                await sendTextReply(firstMessage.chat.id, firstMessage.message_id, "Cannot compact while pi is busy. Send \"stop\" first.");
                return;
            }
            ctx.compact({
                onComplete: () => {
                    void sendTextReply(firstMessage.chat.id, firstMessage.message_id, "Compaction completed.");
                },
                onError: (error) => {
                    const message = error instanceof Error ? error.message : String(error);
                    void sendTextReply(firstMessage.chat.id, firstMessage.message_id, `Compaction failed: ${message}`);
                },
            });
            await sendTextReply(firstMessage.chat.id, firstMessage.message_id, "Compaction started.");
            return;
        }
        if (lower === "/sessions") {
            try {
                const list = await SessionManager.list(ctx.cwd);
                sessionCache = list;
                if (list.length === 0) {
                    await sendTextReply(firstMessage.chat.id, firstMessage.message_id, "No active sessions found for this directory.");
                    return;
                }
                const lines = list.map((session, index) => {
                    const dateStr = session.modified ? new Date(session.modified).toLocaleDateString() : "unknown";
                    const nameStr = session.name ? `"${session.name}"` : "(unnamed)";
                    const firstMsg = session.firstMessage ? ` - ${session.firstMessage.split("\n")[0].slice(0, 50)}` : "";
                    return `[${index + 1}] ${nameStr} (${dateStr})${firstMsg}\nPath: ${basename(session.path)}`;
                });
                await sendTextReply(firstMessage.chat.id, firstMessage.message_id, `Sessions in current directory:\n\n${lines.join("\n\n")}`);
            }
            catch (error) {
                const msg = error instanceof Error ? error.message : String(error);
                await sendTextReply(firstMessage.chat.id, firstMessage.message_id, `Failed to list sessions: ${msg}`);
            }
            return;
        }
        if (lower.startsWith("/new")) {
            const name = rawText.slice(4).trim();
            void sendTextReply(firstMessage.chat.id, firstMessage.message_id, `Starting a new session${name ? ` "${name}"` : ""}...`).catch(() => undefined);
            setTimeout(async () => {
                try {
                    const cmdCtx = activeRunner ? activeRunner.createCommandContext() : ctx;
                    if (typeof cmdCtx.newSession !== "function") {
                        throw new Error("cmdCtx.newSession is not a function in current context");
                    }
                    await cmdCtx.newSession({
                        setup: async (sm) => {
                            if (name) {
                                sm.appendSessionInfo(name);
                            }
                        },
                        withSession: async (newCtx) => {
                            const actualName = name || newCtx.sessionManager.getSessionName() || newCtx.sessionManager.getSessionId();
                            await callTelegram("sendMessage", {
                                chat_id: firstMessage.chat.id,
                                text: `New session started: ${actualName}`,
                            });
                        }
                    });
                }
                catch (error) {
                    const msg = error instanceof Error ? error.message : String(error);
                    try {
                        await callTelegram("sendMessage", {
                            chat_id: firstMessage.chat.id,
                            text: `Failed to create new session: ${msg}`,
                        });
                    }
                    catch {
                        // ignore
                    }
                }
            }, 0);
            return;
        }
        if (lower.startsWith("/switch ")) {
            const arg = rawText.slice(8).trim();
            let targetPath = "";
            const index = parseInt(arg, 10);
            if (!isNaN(index) && sessionCache && index > 0 && index <= sessionCache.length) {
                targetPath = sessionCache[index - 1].path;
            }
            else {
                targetPath = arg;
            }
            void sendTextReply(firstMessage.chat.id, firstMessage.message_id, `Switching to session: ${targetPath}...`).catch(() => undefined);
            setTimeout(async () => {
                try {
                    const cmdCtx = activeRunner ? activeRunner.createCommandContext() : ctx;
                    if (typeof cmdCtx.switchSession !== "function") {
                        throw new Error("cmdCtx.switchSession is not a function in current context");
                    }
                    await cmdCtx.switchSession(targetPath, {
                        withSession: async (newCtx) => {
                            const sessionName = newCtx.sessionManager.getSessionName() || basename(targetPath);
                            await callTelegram("sendMessage", {
                                chat_id: firstMessage.chat.id,
                                text: `Successfully switched to session: ${sessionName}`,
                            });
                        }
                    });
                }
                catch (error) {
                    const msg = error instanceof Error ? error.message : String(error);
                    try {
                        await callTelegram("sendMessage", {
                            chat_id: firstMessage.chat.id,
                            text: `Failed to switch session: ${msg}`,
                        });
                    }
                    catch {
                        // ignore
                    }
                }
            }, 0);
            return;
        }
        if (lower === "/fork" || lower === "/clone") {
            const leafId = ctx.sessionManager.getLeafId();
            if (!leafId) {
                void sendTextReply(firstMessage.chat.id, firstMessage.message_id, "Cannot fork an empty session.").catch(() => undefined);
                return;
            }
            void sendTextReply(firstMessage.chat.id, firstMessage.message_id, "Forking current session...").catch(() => undefined);
            setTimeout(async () => {
                try {
                    const cmdCtx = activeRunner ? activeRunner.createCommandContext() : ctx;
                    if (typeof cmdCtx.fork !== "function") {
                        throw new Error("cmdCtx.fork is not a function in current context");
                    }
                    await cmdCtx.fork(leafId, {
                        position: "at",
                        withSession: async (newCtx) => {
                            const newSessionId = newCtx.sessionManager.getSessionId();
                            await callTelegram("sendMessage", {
                                chat_id: firstMessage.chat.id,
                                text: `Session successfully forked! New Session ID: ${newSessionId}`,
                            });
                        }
                    });
                }
                catch (error) {
                    const msg = error instanceof Error ? error.message : String(error);
                    try {
                        await callTelegram("sendMessage", {
                            chat_id: firstMessage.chat.id,
                            text: `Failed to fork session: ${msg}`,
                        });
                    }
                    catch {
                        // ignore
                    }
                }
            }, 0);
            return;
        }
        if (lower === "/status") {
            let totalInput = 0;
            let totalOutput = 0;
            let totalCacheRead = 0;
            let totalCacheWrite = 0;
            let totalCost = 0;
            for (const entry of ctx.sessionManager.getEntries()) {
                if (entry.type !== "message" || entry.message.role !== "assistant")
                    continue;
                totalInput += entry.message.usage.input;
                totalOutput += entry.message.usage.output;
                totalCacheRead += entry.message.usage.cacheRead;
                totalCacheWrite += entry.message.usage.cacheWrite;
                totalCost += entry.message.usage.cost.total;
            }
            const usage = ctx.getContextUsage();
            const lines = [];
            if (ctx.model) {
                lines.push(`Model: ${ctx.model.provider}/${ctx.model.id}`);
            }
            const tokenParts = [];
            if (totalInput)
                tokenParts.push(`↑${formatTokens(totalInput)}`);
            if (totalOutput)
                tokenParts.push(`↓${formatTokens(totalOutput)}`);
            if (totalCacheRead)
                tokenParts.push(`R${formatTokens(totalCacheRead)}`);
            if (totalCacheWrite)
                tokenParts.push(`W${formatTokens(totalCacheWrite)}`);
            if (tokenParts.length > 0) {
                lines.push(`Usage: ${tokenParts.join(" ")}`);
            }
            const usingSubscription = ctx.model ? ctx.modelRegistry.isUsingOAuth(ctx.model) : false;
            if (totalCost || usingSubscription) {
                lines.push(`Cost: $${totalCost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`);
            }
            if (usage) {
                const contextWindow = usage.contextWindow ?? ctx.model?.contextWindow ?? 0;
                const percent = usage.percent !== null ? `${usage.percent.toFixed(1)}%` : "?";
                lines.push(`Context: ${percent}/${formatTokens(contextWindow)}`);
            }
            else {
                lines.push("Context: unknown");
            }
            if (lines.length === 0) {
                lines.push("No usage data yet.");
            }
            await sendTextReply(firstMessage.chat.id, firstMessage.message_id, lines.join("\n"));
            return;
        }
        if (lower.startsWith("/model")) {
            const arg = rawText.slice(6).trim();
            if (!arg) {
                try {
                    const models = await getConfiguredModels(ctx);
                    const current = ctx.model;
                    const lines = models.map((model, index) => {
                        const isActive = current && current.provider === model.provider && current.id === model.id;
                        return `[${index + 1}] ${model.provider}/${model.id}${isActive ? " (active)" : ""}`;
                    });
                    modelCache = models;
                    await sendTextReply(firstMessage.chat.id, firstMessage.message_id, `Available models:\n\n${lines.join("\n")}\n\nTo switch, send:\n/model <index> or\n/model <provider>/<id>`);
                }
                catch (error) {
                    const msg = error instanceof Error ? error.message : String(error);
                    await sendTextReply(firstMessage.chat.id, firstMessage.message_id, `Failed to list models: ${msg}`);
                }
            }
            else {
                try {
                    const models = await getConfiguredModels(ctx);
                    let targetModel = null;
                    const index = parseInt(arg, 10);
                    if (!isNaN(index) && index > 0 && index <= models.length) {
                        targetModel = models[index - 1];
                    }
                    else if (!isNaN(index) && modelCache && index > 0 && index <= modelCache.length) {
                        targetModel = modelCache[index - 1];
                    }
                    else {
                        const lowerArg = arg.toLowerCase();
                        targetModel = models.find((m) => `${m.provider}/${m.id}`.toLowerCase() === lowerArg ||
                            m.id.toLowerCase() === lowerArg ||
                            m.id.toLowerCase().includes(lowerArg));
                    }
                    if (!targetModel) {
                        await sendTextReply(firstMessage.chat.id, firstMessage.message_id, `Model not found matching: ${arg}`);
                        return;
                    }
                    await sendTextReply(firstMessage.chat.id, firstMessage.message_id, `Switching model to ${targetModel.provider}/${targetModel.id}...`);
                    const success = await pi.setModel(targetModel);
                    if (success) {
                        await sendTextReply(firstMessage.chat.id, firstMessage.message_id, `Successfully switched model to ${targetModel.provider}/${targetModel.id}`);
                    }
                    else {
                        await sendTextReply(firstMessage.chat.id, firstMessage.message_id, `Failed to switch model: No API key or authorization found for ${targetModel.provider}`);
                    }
                }
                catch (error) {
                    const msg = error instanceof Error ? error.message : String(error);
                    await sendTextReply(firstMessage.chat.id, firstMessage.message_id, `Error switching model: ${msg}`);
                }
            }
            return;
        }
        if (lower.startsWith("/thinking")) {
            const arg = rawText.slice(9).trim().toLowerCase();
            const validLevels = ["off", "minimal", "low", "medium", "high", "xhigh"];
            if (!arg) {
                try {
                    const current = pi.getThinkingLevel();
                    await sendTextReply(firstMessage.chat.id, firstMessage.message_id, `Current thinking level: ${current}\nAvailable levels: ${validLevels.join(", ")}\n\nTo change, send:\n/thinking <level>`);
                }
                catch (error) {
                    const msg = error instanceof Error ? error.message : String(error);
                    await sendTextReply(firstMessage.chat.id, firstMessage.message_id, `Failed to get thinking level: ${msg}`);
                }
            }
            else {
                if (!validLevels.includes(arg)) {
                    await sendTextReply(firstMessage.chat.id, firstMessage.message_id, `Invalid thinking level: ${arg}. Valid levels: ${validLevels.join(", ")}`);
                    return;
                }
                try {
                    pi.setThinkingLevel(arg);
                    await sendTextReply(firstMessage.chat.id, firstMessage.message_id, `Thinking level set to: ${arg}`);
                }
                catch (error) {
                    const msg = error instanceof Error ? error.message : String(error);
                    await sendTextReply(firstMessage.chat.id, firstMessage.message_id, `Failed to set thinking level: ${msg}`);
                }
            }
            return;
        }
        if (lower === "/settings") {
            try {
                const currentModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none";
                const currentThinking = pi.getThinkingLevel();
                const activeTools = pi.getActiveTools().join(", ");
                const settingsSummary = [
                    `Settings Summary:`,
                    `Model: ${currentModel}`,
                    `Thinking Level: ${currentThinking}`,
                    `Active Tools: ${activeTools || "none"}`,
                    `Working Directory: ${ctx.cwd}`,
                    `Extension Mode: ${ctx.mode}`,
                ].join("\n");
                await sendTextReply(firstMessage.chat.id, firstMessage.message_id, settingsSummary);
            }
            catch (error) {
                const msg = error instanceof Error ? error.message : String(error);
                await sendTextReply(firstMessage.chat.id, firstMessage.message_id, `Failed to retrieve settings: ${msg}`);
            }
            return;
        }
        if (lower === "/help" || lower === "/start") {
            await sendTextReply(firstMessage.chat.id, firstMessage.message_id, `Send me a message and I will forward it to pi. Commands:\n- /status: show usage metrics\n- /compact: compact session history\n- /sessions: list sessions in this directory\n- /switch <index|path|id>: switch active session\n- /new [name]: start a new session\n- /fork: fork active session\n- /model [index|name]: show or switch LLM model\n- /thinking [level]: show or set reasoning level\n- /settings: show current session settings\n- stop: abort current turn`);
            if (config.allowedUserId === undefined && firstMessage.from) {
                config.allowedUserId = firstMessage.from.id;
                await writeConfig(config);
                updateStatus(ctx);
            }
            return;
        }
        const historyTurns = preserveQueuedTurnsAsHistory ? queuedTelegramTurns.splice(0) : [];
        preserveQueuedTurnsAsHistory = false;
        const turn = await createTelegramTurn(messages, historyTurns);
        queuedTelegramTurns.push(turn);
        if (ctx.isIdle()) {
            startTypingLoop(ctx, turn.chatId);
            updateStatus(ctx);
            pi.sendUserMessage(turn.content, { deliverAs: "followUp" });
        }
    }
    async function handleAuthorizedTelegramMessage(message, ctx) {
        if (message.media_group_id) {
            const key = `${message.chat.id}:${message.media_group_id}`;
            const existing = mediaGroups.get(key) ?? { messages: [] };
            existing.messages.push(message);
            if (existing.flushTimer)
                clearTimeout(existing.flushTimer);
            existing.flushTimer = setTimeout(() => {
                const state = mediaGroups.get(key);
                mediaGroups.delete(key);
                if (!state)
                    return;
                void dispatchAuthorizedTelegramMessages(state.messages, ctx);
            }, TELEGRAM_MEDIA_GROUP_DEBOUNCE_MS);
            mediaGroups.set(key, existing);
            return;
        }
        await dispatchAuthorizedTelegramMessages([message], ctx);
    }
    async function handleUpdate(update, ctx) {
        const message = update.message || update.edited_message;
        if (!message || message.chat.type !== "private" || !message.from || message.from.is_bot)
            return;
        if (config.allowedUserId === undefined) {
            config.allowedUserId = message.from.id;
            await writeConfig(config);
            updateStatus(ctx);
            await sendTextReply(message.chat.id, message.message_id, "Telegram bridge paired with this account.");
        }
        if (message.from.id !== config.allowedUserId) {
            await sendTextReply(message.chat.id, message.message_id, "This bot is not authorized for your account.");
            return;
        }
        await handleAuthorizedTelegramMessage(message, ctx);
    }
    async function pollLoop(ctx, signal) {
        if (!config.botToken)
            return;
        try {
            await callTelegram("deleteWebhook", { drop_pending_updates: false }, { signal });
        }
        catch {
            // ignore
        }
        if (config.lastUpdateId === undefined) {
            try {
                const updates = await callTelegram("getUpdates", { offset: -1, limit: 1, timeout: 0 }, { signal });
                const last = updates.at(-1);
                if (last) {
                    config.lastUpdateId = last.update_id;
                    await writeConfig(config);
                }
            }
            catch {
                // ignore
            }
        }
        while (!signal.aborted) {
            try {
                const updates = await callTelegram("getUpdates", {
                    offset: config.lastUpdateId !== undefined ? config.lastUpdateId + 1 : undefined,
                    limit: 10,
                    timeout: 30,
                    allowed_updates: ["message", "edited_message"],
                }, { signal });
                for (const update of updates) {
                    config.lastUpdateId = update.update_id;
                    await writeConfig(config);
                    await handleUpdate(update, ctx);
                }
            }
            catch (error) {
                if (signal.aborted)
                    return;
                if (error instanceof DOMException && error.name === "AbortError")
                    return;
                const message = error instanceof Error ? error.message : String(error);
                updateStatus(ctx, message);
                await new Promise((resolve) => setTimeout(resolve, 3000));
                updateStatus(ctx);
            }
        }
    }
    async function startPolling(ctx) {
        if (!config.botToken || pollingPromise)
            return;
        pollingController = new AbortController();
        pollingPromise = pollLoop(ctx, pollingController.signal).finally(() => {
            pollingPromise = undefined;
            pollingController = undefined;
            updateStatus(ctx);
        });
        updateStatus(ctx);
    }
    pi.registerTool({
        name: "pitgram_attach",
        label: "Pitgram Attach",
        description: "Queue one or more local files to be sent with the next Telegram reply.",
        promptSnippet: "Queue local files to be sent with the next Telegram reply.",
        promptGuidelines: [
            "When handling a [telegram] message and the user asked for a file or generated artifact, call pitgram_attach with the local path instead of only mentioning the path in text.",
        ],
        parameters: Type.Object({
            paths: Type.Array(Type.String({ description: "Local file path to attach" }), { minItems: 1, maxItems: MAX_ATTACHMENTS_PER_TURN }),
        }),
        async execute(_toolCallId, params) {
            if (!activeTelegramTurn) {
                throw new Error("pitgram_attach can only be used while replying to an active Telegram turn");
            }
            const added = [];
            for (const inputPath of params.paths) {
                const stats = await stat(inputPath);
                if (!stats.isFile()) {
                    throw new Error(`Not a file: ${inputPath}`);
                }
                if (activeTelegramTurn.queuedAttachments.length >= MAX_ATTACHMENTS_PER_TURN) {
                    throw new Error(`Attachment limit reached (${MAX_ATTACHMENTS_PER_TURN})`);
                }
                activeTelegramTurn.queuedAttachments.push({ path: inputPath, fileName: basename(inputPath) });
                added.push(inputPath);
            }
            return {
                content: [{ type: "text", text: `Queued ${added.length} Telegram attachment(s).` }],
                details: { paths: added },
            };
        },
    });
    pi.registerCommand("pitgram-setup", {
        description: "Configure Telegram bot token for Pitgram",
        handler: async (_args, ctx) => {
            await promptForConfig(ctx);
        },
    });
    pi.registerCommand("pitgram-status", {
        description: "Show Pitgram bridge status",
        handler: async (_args, ctx) => {
            const status = [
                `bot: ${config.botUsername ? `@${config.botUsername}` : "not configured"}`,
                `allowed user: ${config.allowedUserId ?? "not paired"}`,
                `polling: ${pollingPromise ? "running" : "stopped"}`,
                `active telegram turn: ${activeTelegramTurn ? "yes" : "no"}`,
                `queued telegram turns: ${queuedTelegramTurns.length}`,
            ];
            ctx.ui.notify(status.join(" | "), "info");
        },
    });
    pi.registerCommand("pitgram-connect", {
        description: "Start the Pitgram bridge in this pi session",
        handler: async (_args, ctx) => {
            config = await readConfig();
            if (!config.botToken) {
                await promptForConfig(ctx);
                return;
            }
            if (pollingPromise) {
                ctx.ui.notify("Pitgram bridge is already connected and polling.", "info");
                return;
            }
            await startPolling(ctx);
            updateStatus(ctx);
            ctx.ui.notify(`Pitgram bridge connected. Bot: @${config.botUsername ?? "unknown"}${config.allowedUserId ? "" : " (awaiting pairing)"}`, "info");
        },
    });
    pi.registerCommand("pitgram-disconnect", {
        description: "Stop the Pitgram bridge in this pi session",
        handler: async (_args, ctx) => {
            await stopPolling();
            updateStatus(ctx);
            ctx.ui.notify("Pitgram bridge disconnected.", "info");
        },
    });
    pi.on("session_start", async (_event, ctx) => {
        if (typeof require !== "undefined" && require.cache) {
            for (const key of Object.keys(require.cache)) {
                if (key.includes("pi-coding-agent") && require.cache[key]?.exports?.ExtensionRunner) {
                    patchExtensionRunnerClass(require.cache[key].exports.ExtensionRunner);
                }
            }
        }
        config = await readConfig();
        await mkdir(TEMP_DIR, { recursive: true });
        updateStatus(ctx);
        if (config.botToken && (ctx.mode === "tui" || ctx.mode === "rpc")) {
            await startPolling(ctx);
        }
    });
    pi.on("session_shutdown", async (_event, _ctx) => {
        queuedTelegramTurns = [];
        for (const state of mediaGroups.values()) {
            if (state.flushTimer)
                clearTimeout(state.flushTimer);
        }
        mediaGroups.clear();
        if (activeTelegramTurn) {
            await clearPreview(activeTelegramTurn.chatId);
        }
        activeTelegramTurn = undefined;
        currentAbort = undefined;
        preserveQueuedTurnsAsHistory = false;
        await stopPolling();
    });
    pi.on("before_agent_start", async (event) => {
        const suffix = isTelegramPrompt(event.prompt)
            ? `${SYSTEM_PROMPT_SUFFIX}\n- The current user message came from Telegram.`
            : SYSTEM_PROMPT_SUFFIX;
        return {
            systemPrompt: event.systemPrompt + suffix,
        };
    });
    pi.on("agent_start", async (_event, ctx) => {
        currentAbort = () => ctx.abort();
        if (!activeTelegramTurn && queuedTelegramTurns.length > 0) {
            const nextTurn = queuedTelegramTurns.shift();
            if (nextTurn) {
                activeTelegramTurn = { ...nextTurn };
                previewState = { mode: draftSupport === "unsupported" ? "message" : "draft", pendingText: "", lastSentText: "" };
                startTypingLoop(ctx);
            }
        }
        updateStatus(ctx);
    });
    pi.on("message_start", async (event, _ctx) => {
        if (!activeTelegramTurn || !isAssistantMessage(event.message))
            return;
        if (previewState && (previewState.pendingText.trim().length > 0 || previewState.lastSentText.trim().length > 0)) {
            await finalizePreview(activeTelegramTurn.chatId);
        }
        previewState = { mode: draftSupport === "unsupported" ? "message" : "draft", pendingText: "", lastSentText: "" };
    });
    pi.on("message_update", async (event, _ctx) => {
        if (!activeTelegramTurn || !isAssistantMessage(event.message))
            return;
        if (!previewState) {
            previewState = { mode: draftSupport === "unsupported" ? "message" : "draft", pendingText: "", lastSentText: "" };
        }
        previewState.pendingText = getMessageText(event.message);
        schedulePreviewFlush(activeTelegramTurn.chatId);
    });
    pi.on("agent_end", async (event, ctx) => {
        const turn = activeTelegramTurn;
        currentAbort = undefined;
        stopTypingLoop();
        activeTelegramTurn = undefined;
        updateStatus(ctx);
        if (!turn)
            return;
        const assistant = extractAssistantText(event.messages);
        if (assistant.stopReason === "aborted") {
            await clearPreview(turn.chatId);
            return;
        }
        if (assistant.stopReason === "error") {
            await clearPreview(turn.chatId);
            await sendTextReply(turn.chatId, turn.replyToMessageId, assistant.errorMessage || "Telegram bridge: pi failed while processing the request.");
            return;
        }
        const finalText = assistant.text;
        if (previewState) {
            previewState.pendingText = finalText ?? previewState.pendingText;
        }
        if (finalText && finalText.length <= MAX_MESSAGE_LENGTH) {
            const finalized = await finalizePreview(turn.chatId);
            if (!finalized && turn.queuedAttachments.length > 0 && !finalText) {
                await sendTextReply(turn.chatId, turn.replyToMessageId, "Attached requested file(s).");
            }
        }
        else {
            await clearPreview(turn.chatId);
            if (finalText) {
                await sendTextReply(turn.chatId, turn.replyToMessageId, finalText);
            }
            else if (turn.queuedAttachments.length > 0) {
                await sendTextReply(turn.chatId, turn.replyToMessageId, "Attached requested file(s).");
            }
        }
        await sendQueuedAttachments(turn);
        if (queuedTelegramTurns.length > 0 && !preserveQueuedTurnsAsHistory) {
            const nextTurn = queuedTelegramTurns[0];
            startTypingLoop(ctx, nextTurn.chatId);
            updateStatus(ctx);
            setTimeout(() => {
                pi.sendUserMessage(nextTurn.content, { deliverAs: "followUp" });
            }, 0);
        }
    });
}
