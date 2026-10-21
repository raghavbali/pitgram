export interface TelegramBotCommand {
    command: string;
    description: string;
}
interface HelpCommand {
    name: string;
    description: string;
    section: string;
    help: string;
    menuName?: string;
}
/** Canonical list; menuName is set only for names allowed by Telegram's API. */
export declare const TELEGRAM_COMMANDS: readonly HelpCommand[];
export declare const TELEGRAM_MENU_COMMANDS: readonly TelegramBotCommand[];
export declare function formatTelegramHelp(): string;
export {};
