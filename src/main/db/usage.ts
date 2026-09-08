import { getDb } from './index'

export interface SessionUsage {
  inputTokens: number
  outputTokens: number
}

/** Additive — called once per orchestrator round, so a turn that errors out mid-way still keeps the tokens it actually spent. */
export function addUsage(sessionId: string, inputTokens: number, outputTokens: number): void {
  getDb()
    .prepare(
      `INSERT INTO session_usage (session_id, input_tokens, output_tokens) VALUES (?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         input_tokens = input_tokens + excluded.input_tokens,
         output_tokens = output_tokens + excluded.output_tokens`
    )
    .run(sessionId, inputTokens, outputTokens)
}

export function getUsage(sessionId: string): SessionUsage {
  const row = getDb()
    .prepare('SELECT input_tokens AS inputTokens, output_tokens AS outputTokens FROM session_usage WHERE session_id = ?')
    .get(sessionId) as SessionUsage | undefined
  return row ?? { inputTokens: 0, outputTokens: 0 }
}
