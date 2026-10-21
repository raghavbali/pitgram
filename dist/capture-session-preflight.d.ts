import { spawn as nodeSpawn } from "node:child_process";
export type CaptureSessionPreflightResult = {
    status: "missing" | "pass_through";
} | {
    status: "handled";
    message: string;
};
export interface CaptureSessionPreflightOptions {
    timeoutMs?: number;
    maxOutputBytes?: number;
    spawn?: typeof nodeSpawn;
}
/** Run the workspace-local capture/session gate before a direct Telegram turn reaches Pi. */
export declare function runCaptureSessionPreflight(workspaceCwd: string, source: unknown, options?: CaptureSessionPreflightOptions): Promise<CaptureSessionPreflightResult>;
