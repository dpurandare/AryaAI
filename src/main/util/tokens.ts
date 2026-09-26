import { Tiktoken } from 'js-tiktoken/lite'
import o200k_base from 'js-tiktoken/ranks/o200k_base'

let encoder: Tiktoken | undefined

/** Approximate token count (tiktoken o200k_base — the same estimator the app uses for non-Anthropic/Google providers). Good to about +/-10%. */
export function countTokens(text: string): number {
  encoder ??= new Tiktoken(o200k_base)
  return encoder.encode(text).length
}
