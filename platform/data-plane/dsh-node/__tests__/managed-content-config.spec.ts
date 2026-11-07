import { describe,expect,it } from 'vitest'
import { managedContentSettings } from '../src/managed-content-config.ts'

describe('managed content deployment policy',()=>{
  it('defaults physical deletion off while preserving explicit zero retention and grace',()=>{
    expect(managedContentSettings({},'minio:store/bucket')).toEqual({storageId:'minio:store/bucket',retentionMs:604800000,graceMs:86400000,deleteEnabled:false,ioTimeoutMs:30000,gcIntervalMs:60000})
    expect(managedContentSettings({LUMO_MANAGED_CONTENT_RETENTION_MS:'0',LUMO_MANAGED_CONTENT_GRACE_MS:'0',LUMO_MANAGED_CONTENT_GC_ENABLED:'true'},'store')).toMatchObject({retentionMs:0,graceMs:0,deleteEnabled:true})
  })
  it('rejects misspelled switches and malformed or out-of-range values before boot',()=>{
    for(const value of ['', '-1', '1.5', '1e3', ' 1000', '01', 'Infinity', '315360000001','9007199254740992']) {
      for(const key of ['LUMO_MANAGED_CONTENT_RETENTION_MS','LUMO_MANAGED_CONTENT_GRACE_MS'])expect(()=>managedContentSettings({[key]:value},'store')).toThrow(key)
    }
    for(const [key,value] of Object.entries({LUMO_MANAGED_CONTENT_IO_TIMEOUT_MS:'99',LUMO_MANAGED_CONTENT_GC_INTERVAL_MS:'2147483648',LUMO_MANAGED_CONTENT_GC_ENABLED:'TRUE',LUMO_MANAGED_CONTENT_STORE_ID:' '}))expect(()=>managedContentSettings({[key]:value},'store')).toThrow(key)
  })
})
