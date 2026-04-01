# Th# roaster-bot

## Security Fixes Applied
- **issue-1bcbc74383**: Enhanced helmet security headers with CSP, HSTS, frameguard, and referrer policy
- **issue-36e612c4b8**: Improved rate-limiting with proper error handling and response headers
- **issue-1a30ebc138**: Added input validation for API endpoints to prevent malformed requests 🌶️💀

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
