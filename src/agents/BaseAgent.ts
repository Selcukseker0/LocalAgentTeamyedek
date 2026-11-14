interface OllamaChatResponse {
  message?: {
    content?: string;
  };
  error?: string;
}

export class BaseAgent {
  private readonly name: string;
  private readonly instructions: string;
  private readonly model: string;
  private readonly endpoint: string;
  private readonly timeoutMs: number;

  constructor(name: string, _role: string, instructions: string) {
    this.name = name;
    this.instructions = instructions;
    this.model = process.env.OLLAMA_MODEL ?? "qwen2.5:3b";
    this.endpoint = process.env.OLLAMA_URL ?? "http://127.0.0.1:11434/api/chat";
    this.timeoutMs = Number(process.env.OLLAMA_TIMEOUT_MS ?? 120_000);
  }

  async run(task: string): Promise<string> {
    console.log(`\n[${this.name}] Görev başladı...`);

    let response: Response;
    try {
      response = await fetch(this.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(this.timeoutMs),
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: "system", content: this.instructions },
            { role: "user", content: task },
          ],
          stream: false,
        }),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Ollama bağlantısı kurulamadı (${this.endpoint}). Ollama'nın çalıştığını ve '${this.model}' modelinin yüklü olduğunu kontrol et. Ayrıntı: ${reason}`,
      );
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`Ollama HTTP ${response.status}: ${detail || response.statusText}`);
    }

    const data = (await response.json()) as OllamaChatResponse;
    const content = data.message?.content;
    if (typeof content !== "string" || content.trim().length === 0) {
      throw new Error(data.error ?? `${this.name} boş yanıt aldı.`);
    }

    console.log(`[${this.name}] Görev tamamlandı.`);
    return content.trim();
  }
}
