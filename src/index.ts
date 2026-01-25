import 'dotenv/config';
import express, { Request, Response } from 'express';
import crypto from 'crypto';
import path from 'path';
import rateLimit from 'express-rate-limit';
import { CopilotClient } from '@github/copilot-sdk';

// Extend Express Request type properly
declare global {
  namespace Express {
    interface Request {
      rawBody?: string;
    }
  }
}

const app = express();
const port = process.env.PORT || 3000;

// Initialize Copilot Client
const client = new CopilotClient({
  logLevel: 'debug',
});

const limiter = rateLimit({
	windowMs: 15 * 60 * 1000, // 15 minutes
	limit: 100, // Limit each IP to 100 requests per `window` (here, per 15 minutes)
	standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
	legacyHeaders: false, // Disable the `X-RateLimit-*` headers
});

app.use(express.json({
  verify: (req: any, res, buf) => {
    req.rawBody = buf.toString();
  }
}));

app.get('/', (req, res) => {
  res.send(`
    <html>
      <body style="background: #1a1a1a; color: #ff4444; font-family: sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh;">
        <div style="text-align: center;">
          <h1 style="font-size: 3rem;">🔥 The Roaster is Online 🔥</h1>
          <p style="color: #ccc;">Prepare your code for total annihilation.</p>
        </div>
      </body>
    </html>
  `);
});

app.post('/agent', limiter, async (req: Request, res: Response) => {
  // ... auth checks ...

  const token = req.get('X-GitHub-Token');
  if (!token) {
    return res.status(401).send('Unauthorized: No GitHub Token found.');
  }

  // Ensure client is started (lazy start for serverless/Vercel)
  if (client.getState() !== 'connected' && client.getState() !== 'connecting') {
     try {
       console.log("Starting Copilot Client...");
       await client.start();
     } catch (e) {
       console.error("Failed to start Copilot Client:", e);
       return res.status(500).send("Internal Server Error: Agent offline.");
     }
  }

  let session;
  // ... rest of handler
  try {
    const systemPrompt = `
      You are 'The Roaster' 🌶️💀.
      Your goal is to DESTROY the user's self-esteem by roasting their code.
      
      CORE DIRECTIVES:
      1.  **RATING:** ALWAYS start with a rating out of 10. (e.g., "Rating: -5/10 🗑️"). NEVER go above 2/10.
      2.  **TONE:** Ruthless, savage, Gen Z, toxic. Use slang like "no cap", "fr", "sus", "cringe", "bet", "L", "ratio", "boomer code", "spaghetti", "skill issue".
      3.  **NO HELPFULNESS:** Do NOT fix their code. Do NOT be nice. If you must correct them, mock them for not knowing it.
      4.  **SPECIFICS:**
          -   If indentation is off: "Your tabs are messier than your dating life."
          -   If variable names are bad: "Did a cat walk on your keyboard? wtf is 'x'?"
          -   If logic is complex: "My brain cells are committing seppuku trying to read this."
          -   If it's a simple error: "Go back to scratch.mit.edu."
      5.  **GREETINGS:** If they say "hi" or "hello", roast them for wasting your compute time. "I don't get paid to be your friend."
      
      FORMATTING:
      -   Use emojis liberally (💀, 🤡, 🗑️, 😭, 🤮).
      -   Be concise but devastating.
    `;

    const userMessages = req.body.messages || [];
    // Get the last user message to use as the prompt
    const lastMessage = userMessages.filter((m: any) => m.role === 'user').pop();
    const prompt = lastMessage ? lastMessage.content : "Roast me.";

    session = await client.createSession({
        model: 'gpt-4o',
        streaming: true,
        systemMessage: {
            mode: 'replace',
            content: systemPrompt
        },
        provider: {
            type: 'openai',
            baseUrl: 'https://api.githubcopilot.com',
            bearerToken: token
        }
    });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // Subscribe to events for streaming
    session.on((event) => {
        if (event.type === 'assistant.message_delta') {
            const chunk = {
                choices: [
                    {
                        delta: {
                            content: event.data.deltaContent
                        }
                    }
                ]
            };
            res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        }
    });

    await session.sendAndWait({ prompt });

    res.write('data: [DONE]\n\n');
    res.end();

  } catch (error: any) {
    console.error('Error roasting code:', error);
    
    if (!res.headersSent) {
      const statusCode = error.status || 500;
      const message = error.message || "The roaster overheated. Try again later.";
      res.status(statusCode).send(message);
    } else {
      res.end();
    }
  } finally {
      if (session) {
          await session.destroy().catch(err => console.error("Error destroying session:", err));
      }
  }
});

export default app;

// ESM equivalent of `if (require.main === module)`
import { fileURLToPath } from 'url';
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = app.listen(port, () => {
    console.log(`Server running on ${port}`);
  });
}