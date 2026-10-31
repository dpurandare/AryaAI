import { describe, expect, it } from 'vitest'
import { isKeyRejectedMessage, keyRejectedNotice } from './provider-errors'

describe('isKeyRejectedMessage', () => {
  it.each([
    "Error invoking remote method 'providers:list-models': Error: 401 {\"type\":\"error\",\"error\":{\"type\":\"authentication_error\",\"message\":\"invalid x-api-key\"}}",
    '401 Incorrect API key provided: sk-proj-****abcd. You can find your API key at https://platform.openai.com/account/api-keys.',
    '400 {"error":{"code":400,"message":"API key expired. Please renew the API key.","status":"INVALID_ARGUMENT"}}',
    '400 {"error":{"message":"API key not valid. Please pass a valid API key.","details":[{"reason":"API_KEY_INVALID"}]}}',
    '401 {"error":{"message":"Invalid API Key","type":"invalid_request_error","code":"invalid_api_key"}}',
    '401 Unauthorized',
    '403 {"error":{"type":"permission_error","message":"permission_denied"}}',
    'Error: 403 Forbidden'
  ])('recognises a rejected key: %s', (message) => {
    expect(isKeyRejectedMessage(message)).toBe(true)
  })

  it.each([
    'connect ECONNREFUSED 127.0.0.1:11450',
    'fetch failed',
    'Connection error.',
    '429 {"error":{"message":"Rate limit reached"}}',
    '404 model "mxbai-embed-large:latest" not found, try pulling it first',
    '500 Internal Server Error',
    'Request took 4015 ms',
    'No API key configured for anthropic.',
    '',
    undefined
  ])('does not call this a rejected key: %s', (message) => {
    expect(isKeyRejectedMessage(message)).toBe(false)
  })
})

describe('keyRejectedNotice', () => {
  it('names the provider and never contains a key', () => {
    expect(keyRejectedNotice('Anthropic')).toContain('Anthropic rejected this API key')
  })
})
