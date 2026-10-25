import { createGroq } from '@ai-sdk/groq'
import { transcribe } from 'ai'

export interface Transcriber {
  transcribe(audio: Buffer): Promise<string>
}

/** Speech-to-text with Whisper on Groq (free tier). */
export class GroqTranscriber implements Transcriber {
  private readonly groq

  constructor(
    apiKey: string,
    private readonly modelId: string,
  ) {
    this.groq = createGroq({ apiKey })
  }

  async transcribe(audio: Buffer): Promise<string> {
    const result = await transcribe({
      model: this.groq.transcription(this.modelId),
      audio,
      abortSignal: AbortSignal.timeout(30_000),
    })
    return result.text.trim()
  }
}
