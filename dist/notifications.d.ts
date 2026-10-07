export interface NotificationTarget {
    botId: string;
    chatId: number;
    userId: number;
    originCwd: string;
}
export type NotificationUnavailableReason = "not_connected" | "not_paired" | "relay_mode" | "wrong_workspace" | "identity_mismatch" | "shutting_down" | "invalid_request";
export type NotificationTargetResult = {
    status: "ready";
    target: NotificationTarget;
} | {
    status: "unavailable";
    reason: NotificationUnavailableReason;
};
export type NotificationSendResult = {
    status: "sent";
    messageId: number;
} | {
    status: "not_sent";
    reason: "invalid_request" | "target_unavailable" | "telegram_rejected";
} | {
    status: "uncertain";
    reason: "timeout" | "disconnected" | "network_error" | "invalid_response";
};
export declare const NOTIFICATION_STATUS_CHANNEL = "pitgram:notifications:status";
export declare const NOTIFICATION_SEND_CHANNEL = "pitgram:notifications:send";
export declare const NOTIFICATION_TIMEOUT_MS = 15000;
interface EventBusLike {
    on(channel: string, handler: (data: unknown) => void): () => void;
}
interface NotificationTransportOptions {
    resolveTarget(originCwd: string, context?: unknown): Promise<NotificationTargetResult>;
    timeoutMs?: number;
    send(target: NotificationTarget, text: string, signal: AbortSignal, context?: unknown, markRequestStarted?: () => boolean): Promise<{
        status: "sent";
        messageId: number;
    } | {
        status: "rejected";
    } | {
        status: "not_sent";
        reason: "target_unavailable";
    } | {
        status: "uncertain";
        reason: "network_error" | "invalid_response";
    }>;
}
export declare class NotificationTransport {
    private readonly events;
    private readonly options;
    private readonly unsubscribe;
    private readonly activeSends;
    private readonly tasks;
    private blockedReason;
    private closed;
    private readonly timeoutMs;
    constructor(events: EventBusLike, options: NotificationTransportOptions);
    get inFlightCount(): number;
    sendForWorkspace(originCwd: string, text: string, context?: unknown): Promise<NotificationSendResult>;
    activate(): void;
    block(reason?: "disconnected" | "shutting_down"): Promise<void>;
    close(): Promise<void>;
    private track;
    private handleStatus;
    private handleSend;
}
export {};
