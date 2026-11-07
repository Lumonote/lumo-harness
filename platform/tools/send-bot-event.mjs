#!/usr/bin/env node
// Generic channel adapter helper. Secrets and payloads are never printed.
import { createHmac } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'

try {
  const { values } = parseArgs({ options: {
    url: { type: 'string' }, channel: { type: 'string' }, 'message-id': { type: 'string' },
    subject: { type: 'string' },
    'secret-env': { type: 'string' }, 'payload-file': { type: 'string' },
  } })
  const { url, channel, subject, 'message-id': id, 'secret-env': secretEnv, 'payload-file': file } = values
  if (!url || !channel || !id || !secretEnv || !file) throw new Error('Usage: node send-bot-event.mjs --url ORIGIN --channel ID --message-id ID [--subject EXTERNAL_ID] --secret-env ENV_NAME --payload-file FILE')
  const origin = new URL(url)
  if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/' || !['https:', 'http:'].includes(origin.protocol)) throw new Error('--url must be an HTTP(S) origin')
  if (origin.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)) throw new Error('Use HTTPS for remote channels')
  if (!/^[A-Za-z0-9_-]{1,64}$/u.test(channel) || !/^[A-Za-z0-9_.:-]{1,200}$/u.test(id)) throw new Error('Invalid channel or message ID')
  if (subject !== undefined && !/^[A-Za-z0-9_.:-]{1,200}$/u.test(subject)) throw new Error('Invalid external subject')
  const secret = process.env[secretEnv]
  if (!secret || Buffer.byteLength(secret) < 32) throw new Error('Channel secret must contain at least 32 bytes')
  const body = await readFile(file)
  if (body.length > 1 << 20) throw new Error('Payload exceeds 1 MiB')
  JSON.parse(body.toString('utf8'))
  const timestamp = String(Math.floor(Date.now() / 1000))
  const version = subject === undefined ? 'v1' : 'v2'
  const signedPrefix = `${timestamp}\n${channel}\n${id}\n${subject === undefined ? '' : `${subject}\n`}`
  const signature = createHmac('sha256', secret).update(signedPrefix).update(body).digest('hex')
  const response = await fetch(new URL(`/v1/bot/events/${channel}`, origin), {
    method: 'POST', body, signal: AbortSignal.timeout(15_000), redirect: 'error',
    headers: { 'Content-Type': 'application/json', 'X-Lumo-Bot-Id': id, 'X-Lumo-Bot-Timestamp': timestamp, 'X-Lumo-Bot-Signature': `${version}=${signature}`, ...(subject === undefined ? {} : { 'X-Lumo-Bot-Subject': subject }) },
  })
  // Ingress responses contain only a status, receipt ID, or error code.
  const receipt = await response.json()
  console.log(JSON.stringify({ http_status: response.status, status: receipt.status, trigger_id: receipt.trigger_id, duplicate: receipt.duplicate, error: receipt.error }))
  if (!response.ok) process.exitCode = 1
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Bot event delivery failed')
  process.exitCode = 1
}
