import type { AppEnv } from "../env";
import { clearNotes, createNote, createTodo, getNotes, getTodos, toggleTodo } from "../db";

export interface CommandResult {
  handled: boolean;
  reply?: string;
}

/**
 * Modular command dispatcher for Nyra Rose 🌹.
 * Enables instant, zero-neuron responses for utility tasks (notes, todos, system commands).
 */
export async function handleCommand(
  env: AppEnv,
  chatId: string,
  text: string
): Promise<CommandResult> {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) {
    return { handled: false };
  }

  const parts = trimmed.slice(1).split(/\s+/);
  const cmd = parts[0]?.toLowerCase();
  const args = trimmed.slice(cmd.length + 2).trim();

  switch (cmd) {
    case "help":
    case "start": {
      const help =
        `*Nyra Rose* 🌹 _Your Personal AI Assistant_\n\n` +
        `Here is what I can do for you:\n\n` +
        `💬 *Conversation:* Just send any message (English, বাংলা, Banglish) and I will respond.\n\n` +
        `📝 *Notes & Memory:*\n` +
        `• */note <text>* — Save a quick note or fact\n` +
        `• */notes* — View your saved notes\n` +
        `• */clearnotes* — Clear all notes\n\n` +
        `✅ *Tasks & To-Dos:*\n` +
        `• */todo <task>* — Add a new task\n` +
        `• */todos* — View your active tasks\n` +
        `• */done <number>* — Mark a task as completed\n\n` +
        `⚙️ *Controls:*\n` +
        `• */status* — Check model & usage stats\n` +
        `• */reset* — Clear conversation history & start fresh\n` +
        `• */help* — Show this menu`;
      return { handled: true, reply: help };
    }

    case "reset":
    case "new": {
      await env.DB.prepare("DELETE FROM messages WHERE chat_id = ?").bind(chatId).run();
      return {
        handled: true,
        reply: "Our conversation has been cleared — a fresh rose petal awaits. ✨🌹",
      };
    }

    case "note": {
      if (!args) {
        return { handled: true, reply: "Please provide a note to save! Example:\n*/note Remember to call Rafiq at 5 PM*" };
      }
      await createNote(env, chatId, args);
      return { handled: true, reply: `Saved note: "${args}" 📝` };
    }

    case "notes": {
      const notes = await getNotes(env, chatId);
      if (notes.length === 0) {
        return { handled: true, reply: "You don't have any saved notes yet. Use */note <text>* to add one! 📝" };
      }
      const list = notes.map((n, idx) => `${idx + 1}. ${n.content}`).join("\n");
      return { handled: true, reply: `*Your Notes:* 📝\n\n${list}` };
    }

    case "clearnotes": {
      await clearNotes(env, chatId);
      return { handled: true, reply: "All your saved notes have been cleared. 🗑️" };
    }

    case "todo": {
      if (!args) {
        return { handled: true, reply: "Please specify what you need to do! Example:\n*/todo Submit motion graphics proposal*" };
      }
      await createTodo(env, chatId, args);
      return { handled: true, reply: `Added to-do: "${args}" ✅` };
    }

    case "todos":
    case "tasks": {
      const todos = await getTodos(env, chatId);
      if (todos.length === 0) {
        return { handled: true, reply: "No active tasks! Add one with */todo <task>* ✨" };
      }
      const list = todos
        .map((t, idx) => `${idx + 1}. [${t.completed ? "✓" : " "}] ${t.task}`)
        .join("\n");
      return { handled: true, reply: `*Your Tasks:* ✅\n\n${list}` };
    }

    case "done": {
      if (!args) {
        return { handled: true, reply: "Please specify the task number! Example: */done 1*" };
      }
      const num = parseInt(args, 10);
      const todos = await getTodos(env, chatId);
      if (isNaN(num) || num < 1 || num > todos.length) {
        return { handled: true, reply: `Invalid task number. Check */todos* to see your current list.` };
      }
      const target = todos[num - 1];
      await toggleTodo(env, target.id, true);
      return { handled: true, reply: `Completed task: ~${target.task}~ 🎉` };
    }

    case "status": {
      const today = new Date().toISOString().slice(0, 10);
      const row = await env.DB.prepare("SELECT neurons, requests FROM usage WHERE day = ?").bind(today).first<{ neurons: number; requests: number }>();
      const usedNeurons = (row?.neurons ?? 0).toFixed(1);
      const reqCount = row?.requests ?? 0;
      return {
        handled: true,
        reply:
          `*Nyra Rose Status* 🌹\n\n` +
          `• *Brain:* Online on Cloudflare Workers AI\n` +
          `• *Today's Neurons:* ${usedNeurons} / 10,000 free\n` +
          `• *Replies today:* ${reqCount}\n` +
          `• *Uptime:* Continuous 24/7 Cloud Relay ⚡`,
      };
    }

    default:
      return { handled: false };
  }
}
