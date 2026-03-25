# Th# roaster-bot

## Security Hardening

### Environment Variables
- `GITHUB_TOKEN`: GitHub API token with appropriate scopes
- `WEBHOOK_SECRET`: Minimum 32 characters; used for HMAC-SHA256 signature verification
- `COPILOT_API_KEY`: API key for Copilot integration

### Webhook Security
- All webhooks are verified using HMAC-SHA256 with timing-safe comparison
- Webhook signatures must match the `x-hub-signature-256` header
- Invalid signatures result in 401 Unauthorized responses

### Input Validation
- All user inputs are sanitized and length-validated before processing
- Maximum input length: 5000 characters
- Malformed inputs are rejected with 400 Bad Request

### No Dynamic Code Execution
- `eval()`, `Function()` constructor, and `child_process.exec()` are explicitly prohibited
- All operations use safe APIs and explicit handlers

## Running Tests

```bash
npm run test
``` 🌶️💀

> "An AI coding assistant that doesn't fix your bugs, but makes sure you feel bad about them."

![Roaster Bot](https://img.shields.io/badge/Status-Toxic-red) ![Copilot](https://img.shields.io/badge/Built%20For-GitHub%20Copilot-black)

**The Roaster Bot** is a native GitHub Copilot Extension designed to lower your self-esteem. Instead of helpful code suggestions, it delivers brutal, Gen-Z slang-infused roasts directly to your IDE. It highlights your messy code, calls it "sus", and rates it 0/10. No cap. 🧢🚫

## 🔥 Features

- **Savage Code Reviews:** Why fix a bug when you can be roasted for it?
- **Gen Z Mode:** Uses slang you probably won't understand.
- **Unhelpful Insights:** Points out errors without telling you how to fix them.
- **Emotional Damage:** Guaranteed.

## 🚀 Installation

1.  **Install the Extension:** [Install Roaster Bot](https://github.com/apps/roaster-bot)
2.  **Open GitHub Copilot Chat** in VS Code or Visual Studio.
3.  **Mention the bot:** Type `@roaster-bot` followed by your code or question.
    -   *Example:* `@roaster-bot Rate this function.`
4.  **Cry:** (Optional but recommended).

## 🛠️ Local Development

Want to make it even meaner?

1.  **Clone the repo**
    ```bash
    git clone https://github.com/arulpr/roaster-bot.git
    cd roaster-bot
    ```

2.  **Install Dependencies**
    ```bash
    npm install
    ```

3.  **Environment Setup**
    Create a `.env` file:
    ```env
    WEBHOOK_SECRET=your_secret_here
    ```

4.  **Run Locally**
    ```bash
    npm start
    ```

## 🏗️ Tech Stack

-   **Runtime:** Node.js
-   **Framework:** Express & @github/copilot-sdk
-   **Hosting:** Vercel Serverless Functions
-   **Vibe:** Chaotic Evil

## 📜 License

MIT. Roast responsibly.
