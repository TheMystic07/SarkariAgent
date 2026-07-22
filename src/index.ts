import { run } from "@grammyjs/runner";
import { createBot, registerCommandMenu } from "./bot";
import { closeAll } from "./browser";
import { startDashboard } from "./dashboard";

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error("TELEGRAM_BOT_TOKEN is not set. Copy .env.example to .env and fill it in.");
  process.exit(1);
}

const bot = createBot(token);
startDashboard();

try {
  await registerCommandMenu(bot.api);
} catch (err) {
  console.warn("Could not register command menu with Telegram:", err);
}

// Concurrent update processing: different chats are handled in parallel, so one
// user's long browser/form-fill turn no longer blocks everyone else. Per-chat
// ordering and the CAPTCHA/OTP mid-turn wait are handled by our own chat lock
// and interaction waiter (so we deliberately do NOT sequentialize, which would
// deadlock a turn that's paused waiting for the user's reply).
const runner = run(bot);

bot.api
  .getMe()
  .then((me) => console.log(`@${me.username} is running (concurrent long polling)…`))
  .catch(() => {});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.once(sig, async () => {
    await closeAll();
    if (runner.isRunning()) await runner.stop();
    process.exit(0);
  });
}
