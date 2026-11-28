import { useSyncExternalStore } from 'react'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'

export type EnvironmentConnection = Pick<ConnectionHandle, 'state' | 'reconnect'>
let connection: EnvironmentConnection | undefined
const listeners = new Set<() => void>()
const changed = () => listeners.forEach(listener => listener())
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
const snapshot = () => connection?.state.getSnapshot()

/** Observe the public host connection; its transport and credentials remain host-owned. */
export function installEnvironmentConnection(value: EnvironmentConnection) {
  if (!value?.state?.subscribe || !value.state.getSnapshot || !value.reconnect) return () => {}
  connection = value
  const dispose = value.state.subscribe(changed)
  changed()
  return () => { dispose(); if (connection === value) { connection = undefined; changed() } }
}

export function useEnvironmentConnection() {
  const state = useSyncExternalStore(subscribe, snapshot, () => undefined)
  const source = useSyncExternalStore(subscribe, () => connection, () => undefined)
  return { state, reconnect: source ? () => source.reconnect() : undefined }
}
