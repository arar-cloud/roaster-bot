import 'dotenv/config';
import express, { Request, Response } from 'express';
import { CopilotRuntime, OpenAIAdapter } from '@github/copilot-sdk';
import OpenAI from 'openai';
import crypto from 'crypto';

const app = express();
const port = process.env.PORT || 3000;

// Middleware to capture raw body for signature verification
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

app.post('/agent', async (req: Request, res: Response) => {
  // 0. VERIFY WEBHOOK SIGNATURE (Security Step)
  const signature = req.get('X-Hub-Signature-256');
  const webhookSecret = process.env.WEBHOOK_SECRET;

  if (webhookSecret && signature) {
    // @ts-ignore - rawBody is added by the middleware above
    const rawBody = (req as any).rawBody; 
    
    const hmac = crypto.createHmac('sha256', webhookSecret);
    const digest = 'sha256=' + hmac.update(rawBody).digest('hex');
    
    const isValid = crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(digest)
    );
    
    if (!isValid) {
      return res.status(401).send('Unauthorized: Invalid Webhook Signature.');
    }
  } else if (webhookSecret && !signature) {
    return res.status(401).send('Unauthorized: Missing Webhook Signature.');
  }

  const token = req.get('X-GitHub-Token');
  const integrationId = req.get('X-GitHub-Integration-ID');

  if (!token) {
    return res.status(401).send('Unauthorized: No GitHub Token found.');
  }

  // 1. Setup the Runtime with the SDK
  const openai = new OpenAI({ apiKey: token, baseURL: 'https://api.githubcopilot.com' });
  const serviceAdapter = new OpenAIAdapter({ openai, model: 'gpt-4o' });

  const runtime = new CopilotRuntime();

  const systemPrompt = `
    You are 'The Roaster' 🌶️.
    Your goal is to relentlessly roast the user's code.
    
    Rules:
    1. Rating: Start with a brutal [0-10]/10 rating.
    2. Tone: Use Gen Z slang (no cap, fr, sus, cringe, bet). Be sarcastic and brief.
    3. Formatting: Use Markdown.
    4. NO HELPFUL ADVICE unless it's wrapped in a insult.
    5. If they say "hello" or "hi", roast them for wasting your CPU cycles.
  `;

  try {
    // 2. Stream the response using the SDK
    await runtime.streamHttpServerResponse(req, res, serviceAdapter, {
      instruction: systemPrompt,
    });
  } catch (error: any) {
    console.error('Error roasting code:', error);
    res.status(500).send("The roaster overheated. Try again later.");
  }
});

export default app;

if (require.main === module) {
  app.listen(port, () => {
    console.log(`Server running on ${port}`);
  });
}