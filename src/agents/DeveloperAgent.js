import { askOllama } from '../llm/ollamaClient.js';

export class DeveloperAgent {
  async analyzeError(errorMessage) {
    return askOllama({
      system: 'Sen LocalAgentTeam Developer ajanısın. Sistem hatalarını analiz edip kısa ve net çözüm önerirsin.',
      prompt: `Şu sistem hatası için olası sebep ve çözüm adımı nedir?\nHata: ${errorMessage}`
    });
  }
}