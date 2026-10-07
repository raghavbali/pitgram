export const NOTIFICATION_STATUS_CHANNEL = "pitgram:notifications:status";
export const NOTIFICATION_SEND_CHANNEL = "pitgram:notifications:send";
export const NOTIFICATION_TIMEOUT_MS = 15_000;
const MAX_TEXT_LENGTH = 4096;
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isReply(value) {
    return typeof value === "function";
}
function isTarget(value) {
    if (!isRecord(value))
        return false;
    const keys = Object.keys(value).sort().join(",");
    return keys === "botId,chatId,originCwd,userId"
        && typeof value.botId === "string" && /^\d+$/.test(value.botId)
        && Number.isSafeInteger(value.chatId) && value.chatId > 0
        && Number.isSafeInteger(value.userId) && value.userId > 0
        && value.chatId === value.userId
        && typeof value.originCwd === "string" && value.originCwd.startsWith("/");
}
function sameTarget(left, right) {
    return left.botId === right.botId && left.chatId === right.chatId
        && left.userId === right.userId && left.originCwd === right.originCwd;
}
function replyOnce(reply, result) {
    try {
        reply(result);
    }
    catch { /* Extension event consumers are isolated. */ }
}
export class NotificationTransport {
    events;
    options;
    unsubscribe;
    activeSends = new Set();
    tasks = new Set();
    blockedReason;
    closed = false;
    timeoutMs;
    constructor(events, options) {
        this.events = events;
        this.options = options;
        this.timeoutMs = options.timeoutMs ?? NOTIFICATION_TIMEOUT_MS;
        this.unsubscribe = [
            events.on(NOTIFICATION_STATUS_CHANNEL, data => this.track(this.handleStatus(data))),
            events.on(NOTIFICATION_SEND_CHANNEL, data => this.track(this.handleSend(data))),
        ];
    }
    get inFlightCount() { return this.tasks.size; }
    async sendForWorkspace(originCwd, text, context) {
        if (typeof originCwd !== "string" || !originCwd.startsWith("/")
            || typeof text !== "string" || text.length < 1 || text.length > MAX_TEXT_LENGTH) {
            return { status: "not_sent", reason: "invalid_request" };
        }
        if (this.closed || this.blockedReason)
            return { status: "not_sent", reason: "target_unavailable" };
        let target;
        try {
            const result = await this.options.resolveTarget(originCwd, context);
            if (result.status !== "ready")
                return { status: "not_sent", reason: "target_unavailable" };
            target = result.target;
        }
        catch {
            return { status: "not_sent", reason: "target_unavailable" };
        }
        if (this.closed || this.blockedReason)
            return { status: "not_sent", reason: "target_unavailable" };
        return new Promise(resolve => {
            this.track(this.handleSend({ target, text, reply: resolve }, context));
        });
    }
    activate() {
        if (!this.closed)
            this.blockedReason = undefined;
    }
    async block(reason = "disconnected") {
        this.blockedReason = reason;
        for (const active of this.activeSends) {
            active.reason = reason === "shutting_down" ? "disconnected" : reason;
            active.controller.abort();
        }
        await Promise.allSettled([...this.tasks]);
    }
    async close() {
        this.closed = true;
        this.unsubscribe.forEach(unsubscribe => {
            try {
                unsubscribe();
            }
            catch { /* Ignore already-removed listeners. */ }
        });
        await this.block("shutting_down");
    }
    track(task) {
        this.tasks.add(task);
        void task.finally(() => this.tasks.delete(task)).catch(() => undefined);
    }
    async handleStatus(data) {
        if (!isRecord(data) || !isReply(data.reply))
            return;
        const reply = data.reply;
        if (Object.keys(data).sort().join(",") !== "originCwd,reply"
            || typeof data.originCwd !== "string" || !data.originCwd.startsWith("/")) {
            replyOnce(reply, { status: "unavailable", reason: "invalid_request" });
            return;
        }
        if (this.closed || this.blockedReason) {
            replyOnce(reply, { status: "unavailable", reason: this.blockedReason ?? "shutting_down" });
            return;
        }
        try {
            const result = await this.options.resolveTarget(data.originCwd);
            replyOnce(reply, this.closed || this.blockedReason
                ? { status: "unavailable", reason: this.blockedReason ?? "shutting_down" }
                : result);
        }
        catch {
            replyOnce(reply, { status: "unavailable", reason: "not_connected" });
        }
    }
    async handleSend(data, context) {
        if (!isRecord(data) || !isReply(data.reply))
            return;
        const reply = data.reply;
        if (Object.keys(data).sort().join(",") !== "reply,target,text"
            || !isTarget(data.target) || typeof data.text !== "string"
            || data.text.length < 1 || data.text.length > MAX_TEXT_LENGTH) {
            replyOnce(reply, { status: "not_sent", reason: "invalid_request" });
            return;
        }
        if (this.closed || this.blockedReason) {
            replyOnce(reply, { status: "not_sent", reason: "target_unavailable" });
            return;
        }
        let current;
        try {
            current = await this.options.resolveTarget(data.target.originCwd, context);
        }
        catch {
            replyOnce(reply, { status: "not_sent", reason: "target_unavailable" });
            return;
        }
        if (current.status !== "ready" || !sameTarget(data.target, current.target)) {
            replyOnce(reply, { status: "not_sent", reason: "target_unavailable" });
            return;
        }
        if (this.closed || this.blockedReason) {
            replyOnce(reply, { status: "not_sent", reason: "target_unavailable" });
            return;
        }
        const active = { controller: new AbortController(), reason: "timeout", requestStarted: false };
        this.activeSends.add(active);
        let timeout;
        const aborted = new Promise(resolve => {
            active.controller.signal.addEventListener("abort", () => resolve({ status: "aborted" }), { once: true });
        });
        const markRequestStarted = () => {
            if (active.controller.signal.aborted || this.closed || this.blockedReason)
                return false;
            active.requestStarted = true;
            return true;
        };
        const request = Promise.resolve().then(() => this.options.send(data.target, data.text, active.controller.signal, context, markRequestStarted));
        try {
            timeout = setTimeout(() => active.controller.abort(), this.timeoutMs);
            const outcome = await Promise.race([
                request.then(result => ({ status: "response", result }), () => ({ status: "failure" })),
                aborted,
            ]);
            if (outcome.status === "aborted") {
                replyOnce(reply, active.requestStarted
                    ? { status: "uncertain", reason: active.reason }
                    : { status: "not_sent", reason: "target_unavailable" });
                await request.catch(() => undefined);
            }
            else if (outcome.status === "failure") {
                replyOnce(reply, { status: "uncertain", reason: "network_error" });
            }
            else if (outcome.result.status === "sent"
                && Number.isSafeInteger(outcome.result.messageId) && outcome.result.messageId > 0) {
                replyOnce(reply, { status: "sent", messageId: outcome.result.messageId });
            }
            else if (outcome.result.status === "rejected") {
                replyOnce(reply, { status: "not_sent", reason: "telegram_rejected" });
            }
            else if (outcome.result.status === "not_sent") {
                replyOnce(reply, { status: "not_sent", reason: outcome.result.reason });
            }
            else if (outcome.result.status === "uncertain") {
                replyOnce(reply, { status: "uncertain", reason: outcome.result.reason });
            }
            else {
                replyOnce(reply, { status: "uncertain", reason: "invalid_response" });
            }
        }
        finally {
            if (timeout !== undefined)
                clearTimeout(timeout);
            this.activeSends.delete(active);
        }
    }
}
