/** Canonical list; menuName is set only for names allowed by Telegram's API. */
export const TELEGRAM_COMMANDS = [
    { name: "start", description: "Start the bot and show help", section: "Help", help: "/start — start the bot and show this help.", menuName: "start" },
    { name: "help", description: "Show available PiBot and Pitgram commands", section: "Help", help: "/help — show available PiBot and Pitgram commands.", menuName: "help" },
    { name: "capture", description: "Save a private note or supported image", section: "Capture and notes", help: "/capture <text> or send a supported image — save a private capture.", menuName: "capture" },
    { name: "session", description: "Start or replace conference capture", section: "Capture and notes", help: "/session [label] [tags] — start or replace conference capture for this workspace; ordinary messages are captured as notes.", menuName: "session" },
    { name: "end", description: "End the current conference capture", section: "Capture and notes", help: "/end — end conference capture. /sessions still lists Pi conversation history.", menuName: "end" },
    { name: ";c", description: "Capture raw text with the ;c prefix", section: "Capture and notes", help: ";c <text> — save raw text whether or not conference capture is active." },
    { name: "inbox", description: "Review or manage saved captures", section: "Capture and notes", help: "/inbox — review saved captures.", menuName: "inbox" },
    { name: "recall", description: "Find saved notes", section: "Capture and notes", help: "/recall <query> — find saved notes.", menuName: "recall" },
    { name: "task", description: "Add an explicit task", section: "Tasks and reminders", help: "/task <text> — add an explicit task.", menuName: "task" },
    { name: "done", description: "Complete an explicit task", section: "Tasks and reminders", help: "/done <title> — complete an explicit task.", menuName: "done" },
    { name: "undo", description: "Undo the displayed completion", section: "Tasks and reminders", help: "/undo — undo the displayed completion.", menuName: "undo" },
    { name: "shoot", description: "Summarize open tasks", section: "Tasks and reminders", help: "/shoot — summarize open tasks.", menuName: "shoot" },
    { name: "remind", description: "Schedule an explicit reminder", section: "Tasks and reminders", help: "/remind <time>: <text> — schedule an explicit reminder.", menuName: "remind" },
    { name: "reminders", description: "List or control reminders", section: "Tasks and reminders", help: "/reminders — list or manage reminders.", menuName: "reminders" },
    { name: "status", description: "Show Pi model and usage status", section: "Pi conversation controls", help: "/status — show usage metrics.", menuName: "status" },
    { name: "compact", description: "Compact Pi conversation history", section: "Pi conversation controls", help: "/compact — compact session history.", menuName: "compact" },
    { name: "sessions", description: "List Pi conversation sessions", section: "Pi conversation controls", help: "/sessions — list Pi conversation sessions.", menuName: "sessions" },
    { name: "new", description: "Start a new Pi conversation session", section: "Pi conversation controls", help: "/new [name] — start a new Pi conversation session.", menuName: "new" },
    { name: "switch", description: "Switch Pi conversation session", section: "Pi conversation controls", help: "/switch <session> — switch Pi conversation session.", menuName: "switch" },
    { name: "fork", description: "Fork the current Pi conversation", section: "Pi conversation controls", help: "/fork — fork the current Pi conversation.", menuName: "fork" },
    { name: "model", description: "Show or change the Pi model", section: "Pi conversation controls", help: "/model — show or change the Pi model.", menuName: "model" },
    { name: "thinking", description: "Show or change thinking level", section: "Pi conversation controls", help: "/thinking — show or change reasoning level.", menuName: "thinking" },
    { name: "settings", description: "Show current Pi settings", section: "Pi conversation controls", help: "/settings — show current session settings.", menuName: "settings" },
    { name: "stop", description: "Abort the current Pi turn", section: "Pi conversation controls", help: "stop — abort the current Pi turn." },
    { name: "pitgram-status", description: "Show Telegram bridge status", section: "Pitgram bridge", help: "/pitgram-status — show Telegram bridge status." },
    { name: "pitgram-connect", description: "Connect the Telegram bridge", section: "Pitgram bridge", help: "/pitgram-connect — connect the Telegram bridge." },
    { name: "pitgram-disconnect", description: "Disconnect the Telegram bridge", section: "Pitgram bridge", help: "/pitgram-disconnect — disconnect the Telegram bridge." },
    { name: "pitgram-retry", description: "Retry failed Telegram updates", section: "Pitgram bridge", help: "/pitgram-retry <update-id|all> — retry failed Telegram updates." },
    { name: "pitgram-setup", description: "Configure the Telegram bot", section: "Pitgram bridge", help: "/pitgram-setup — configure the Telegram bot." },
    { name: "pitgram-relay-setup", description: "Configure the optional relay", section: "Pitgram bridge", help: "/pitgram-relay-setup — configure the optional relay." },
    { name: "pitgram-relay-disable", description: "Disable the optional relay", section: "Pitgram bridge", help: "/pitgram-relay-disable — disable the optional relay." },
];
export const TELEGRAM_MENU_COMMANDS = TELEGRAM_COMMANDS
    .filter((entry) => entry.menuName !== undefined)
    .map(({ menuName, description }) => ({ command: menuName, description }));
export function formatTelegramHelp() {
    const sections = [];
    let currentSection = "";
    for (const command of TELEGRAM_COMMANDS) {
        if (command.section !== currentSection) {
            currentSection = command.section;
            sections.push(`${currentSection}:`);
        }
        sections.push(command.help);
    }
    sections.push("", "Send a message to PiBot to forward it to Pi.");
    return sections.join("\n");
}
