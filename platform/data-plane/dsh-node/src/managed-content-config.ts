/** Parse lifecycle deployment settings before generating the server patch.
 * Explicit invalid values must never silently change retention or GC policy. */
export function managedContentSettings(env: NodeJS.ProcessEnv, defaultStorageId: string) {
  const integer=(name:string,fallback:number,min:number,max:number):number=>{
    const raw=env[name]
    if(raw===undefined)return fallback
    if(!/^(?:0|[1-9][0-9]*)$/u.test(raw))throw new Error(`${name} must be a decimal integer`)
    const value=Number(raw)
    if(!Number.isSafeInteger(value)||value<min||value>max)throw new Error(`${name} must be ${min}–${max}`)
    return value
  }
  const enabled=env['LUMO_MANAGED_CONTENT_GC_ENABLED']
  if(enabled!==undefined&&enabled!=='false'&&enabled!=='true')throw new Error('LUMO_MANAGED_CONTENT_GC_ENABLED must be true or false')
  const storageId=env['LUMO_MANAGED_CONTENT_STORE_ID']??defaultStorageId
  if(!storageId.trim()||storageId.trim()!==storageId||storageId.length>256||/[\u0000-\u001f\u007f]/u.test(storageId))throw new Error('LUMO_MANAGED_CONTENT_STORE_ID must be a nonempty stable storage identity of at most 256 characters')
  return {
    storageId,
    retentionMs:integer('LUMO_MANAGED_CONTENT_RETENTION_MS',604800000,0,315360000000),
    graceMs:integer('LUMO_MANAGED_CONTENT_GRACE_MS',86400000,0,315360000000),
    deleteEnabled:enabled==='true',
    ioTimeoutMs:integer('LUMO_MANAGED_CONTENT_IO_TIMEOUT_MS',30000,100,120000),
    gcIntervalMs:integer('LUMO_MANAGED_CONTENT_GC_INTERVAL_MS',60000,1000,2147483647),
  }
}
