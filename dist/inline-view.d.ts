export interface InlineViewButton {
    text: string;
    data: string;
}
export interface InlineView {
    text: string;
    buttons: InlineViewButton[][];
    suppressFinalReply: boolean;
}
/** Read and validate a private, cwd-bound Python-produced inline view. */
export declare function readInlineView(viewPath: string, expectedSha256: string, actor: {
    chatId: number;
    userId: number;
    originCwd: string;
}, now?: number): Promise<InlineView>;
