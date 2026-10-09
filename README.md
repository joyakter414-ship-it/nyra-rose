# Nyra Rose 🌹
> Intelligent 24/7 WhatsApp AI Assistant powered by Cloudflare Workers AI (Neurons), D1 Database, R2 Object Storage, and GitHub Cloud Runner.

An exquisite personal AI companion and secretary on WhatsApp: witty, warm, sharp, and remarkably capable.

---

## 🌟 Architecture

```
[ WhatsApp User ]
       │
       ▼ (WebSocket / Multi-device)
[ Nyra Rose Gateway (24/7 on GitHub Cloud / Container) ]
       │
       ▼ (Encrypted HTTPS REST Relay)
[ Nyra Rose Brain (Cloudflare Pages Functions) ]
  ├── 📜 Rule Book Engine (Instant Triggers & AI Guidelines)
  ├── 📝 Quick Notes & Memory Store (D1 Database)
  ├── ✅ Task & To-Do Tracker (D1 Database)
  ├── 🧠 Cloudflare Workers AI (Llama 4 Scout / Meta Neurons)
  ├── 🗄️ Cloudflare D1 Database (Chat History & Deduplication)
  └── 📦 Cloudflare R2 Bucket (Encrypted Session Backup)
       │
       ▼
[ Web Dashboard ]
  ├── 🌹 Live WhatsApp Status & QR Scanner
  ├── 💬 Interactive Test Chat
  ├── 📜 Dedicated Rule Book (Instant Auto-replies & Guidelines)
  ├── 📝 Notes & Context Memory Manager
  ├── ✅ Task & To-Do List Manager
  ├── 👥 Chat Histories & Management
  └── ⚙️ Model, Persona & Safety Settings
```

---

## 🚀 Key Features

* **100% Free Edge Compute:** Runs on Cloudflare's 10,000 free daily Neurons (Llama 4 Scout, Llama 3.3 70B, etc.).
* **Instant Auto-Replies:** Keyword triggers respond in ~50ms with 0 Neurons consumed.
* **Smart AI Rules:** Behavioral rules strictly followed by the AI model.
* **Notes & Memory Store:** Save notes on WhatsApp with `/note <text>`, view with `/notes`, or manage in dashboard.
* **Tasks & To-Do Tracker:** Create tasks with `/todo <task>`, view with `/todos`, mark done with `/done <num>`.
* **Encrypted Cloud Persistence:** WhatsApp multi-device authentication is encrypted with AES-256-GCM and mirrored to Cloudflare R2, enabling seamless restarts without re-scanning QR codes.
* **Multi-Language:** Fluent in English, Bengali (বাংলা), and Banglish.
* **24/7 Cloud Operation:** Runs continuously in GitHub Actions Cloud with auto-relay dispatch.

---

## 🛠️ Components

* `/worker`: Cloudflare Worker, Pages UI, D1 Database schema, and Workers AI integration.
* `/gateway`: WhatsApp multi-device gateway using Baileys and Cloudflare session sync.
* `/.github/workflows`: Continuous 24/7 cloud runner for GitHub Actions.
