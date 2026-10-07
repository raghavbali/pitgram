export declare const INLINE_BUTTON_TTL_MS: number;
export declare const INLINE_BUTTON_MAX_GRANTS = 4096;
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
export declare class InlineButtonRegistry {
    readonly path: string;
    private readonly botScope;
    private readonly maxFileBytes;
    private grants;
    private loaded;
    private tail;
    constructor(directory: string, botIdentity: string, maxFileBytes?: number);
    load(): Promise<void>;
    createBatch(buttons: Array<{
        data: string;
        label: string;
    }>, userId: number, chatId: number, messageId: number, originCwd: string, now?: number): Promise<InlineButtonGrant[]>;
    get(id: string, now?: number): Promise<InlineButtonGrant | undefined>;
    private assertLoaded;
    private prune;
    private mutate;
}
