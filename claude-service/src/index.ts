import Anthropic from "@anthropic-ai/sdk";
import express, { Request, Response, NextFunction } from "express";

const app = express();
app.use(express.json({ limit: "4mb" }));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.CLAUDE_MODEL ?? "claude-opus-4-8";
const MAX_TOKENS = parseInt(process.env.CLAUDE_MAX_TOKENS ?? "8192", 10);
const SERVICE_TOKEN = process.env.CLAUDE_SERVICE_TOKEN;

// ── Auth ──────────────────────────────────────────────────────────────────────

function authenticate(req: Request, res: Response, next: NextFunction): void {
  if (!SERVICE_TOKEN) { next(); return; }
  const auth = req.headers.authorization ?? "";
  if (auth === `Bearer ${SERVICE_TOKEN}`) { next(); return; }
  res.status(401).json({ error: "unauthorized" });
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface MessageParam {
  role: "user" | "assistant";
  content: string;
}

interface ChatBody {
  messages: MessageParam[];
  system?: string;
  max_tokens?: number;
}

// ── Routes ────────────────────────────────────────────────────────────────────

app.get("/health", (_req, res) => {
  res.json({ status: "ok", model: MODEL });
});

// POST /chat — returns full response as JSON
app.post("/chat", authenticate, async (req: Request, res: Response) => {
  const body = req.body as ChatBody;
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    res.status(400).json({ error: "messages array is required" });
    return;
  }

  try {
    const message = await anthropic.messages
      .stream({
        model: MODEL,
        max_tokens: body.max_tokens ?? MAX_TOKENS,
        thinking: { type: "adaptive" },
        system: body.system,
        messages: body.messages,
      })
      .finalMessage();

    const textBlock = message.content.find((b) => b.type === "text");
    res.json({
      id: message.id,
      content: textBlock?.type === "text" ? textBlock.text : "",
      stop_reason: message.stop_reason,
      usage: message.usage,
    });
  } catch (err) {
    const e = err as Error;
    res.status(500).json({ error: e.message });
  }
});

// POST /stream — streams response as SSE
app.post("/stream", authenticate, async (req: Request, res: Response) => {
  const body = req.body as ChatBody;
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    res.status(400).json({ error: "messages array is required" });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("X-Accel-Buffering", "no");

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const stream = anthropic.messages.stream({
      model: MODEL,
      max_tokens: body.max_tokens ?? MAX_TOKENS,
      thinking: { type: "adaptive" },
      system: body.system,
      messages: body.messages,
    });

    stream.on("text", (text) => send("text", { text }));

    stream.on("message", (msg) => {
      const textBlock = msg.content.find((b) => b.type === "text");
      send("done", {
        id: msg.id,
        content: textBlock?.type === "text" ? textBlock.text : "",
        stop_reason: msg.stop_reason,
        usage: msg.usage,
      });
    });

    stream.on("error", (err) => {
      send("error", { error: err.message });
      res.end();
    });

    await stream.finalMessage();
    res.end();
  } catch (err) {
    const e = err as Error;
    send("error", { error: e.message });
    res.end();
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT ?? "3000", 10);
app.listen(PORT, () => {
  console.log(`claude-service listening on :${PORT} model=${MODEL}`);
});
