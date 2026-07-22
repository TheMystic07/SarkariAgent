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

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.once(sig, async () => {
    await closeAll();
    await bot.stop();
    process.exit(0);
  });
}

bot.start({
  onStart: (me) => console.log(`@${me.username} is running (long polling)…`),
});
