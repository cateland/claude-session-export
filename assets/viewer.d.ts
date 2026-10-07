// Types for the pure part of viewer.js, which the mod's tests import.
export type Block =
  | { type: 'text' | 'thinking'; text: string }
  | { type: 'tool'; id: string; name: string; input: Record<string, unknown>; result?: { text: string; isError: boolean } }
export type Entry = { id: string; ts?: string; kind: 'user' | 'command' | 'assistant' | 'meta' | 'event' } & Record<string, any>
export type Stats = {
  prompts: number; assistant: number; tools: number; errors: number; models: string[]
  first: string | null; last: string | null
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number }
  context: { final: Record<Origin, number>; total: number; peak: number; window: number }
}
export type Origin = 'system' | 'you' | 'claude' | 'tools' | 'skills' | 'injected'
export function parseJsonl(text: string): unknown[]
export function buildEntries(records: unknown[]): { entries: Entry[]; stats: Stats }
