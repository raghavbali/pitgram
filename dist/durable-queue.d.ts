export interface QueueUpdate {
    update_id: number;
}
export interface QueueEntry<T> {
    update: T;
    state: "pending" | "running" | "failed";
    attempts: number;
}
export declare class DurableQueue<T extends QueueUpdate> {
    private snapshot;
    private tail;
    private ownership;
    readonly path: string;
    constructor(directory: string, botIdentity: string);
    load(): Promise<void>;
    get lastUpdateId(): number | undefined;
    get entries(): QueueEntry<T>[];
    get counts(): {
        pending: number;
        running: number;
        failed: number;
    };
    ingest(updates: T[]): Promise<void>;
    running(ids: number[]): Promise<void>;
    complete(ids: number[]): Promise<void>;
    fail(ids: number[]): Promise<void>;
    retry(id?: number): Promise<number[]>;
    settled(): Promise<void>;
    close(): Promise<void>;
    private mutate;
}
