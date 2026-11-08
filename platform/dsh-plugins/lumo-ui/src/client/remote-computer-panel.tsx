import { useCallback, useEffect, useRef, useState } from 'react'
import type { RemoteComputerLocalRequest } from '../remote-computer-types.ts'
const states = { pending:'等待本机确认',running:'正在操作',completed:'已完成',failed:'执行失败',denied:'已拒绝',cancelled:'已停止',unknown:'结果待核对' }
const isObject = (value:unknown):value is Record<string,unknown> => value!==null&&typeof value==='object'&&!Array.isArray(value)
function requests(value:unknown):RemoteComputerLocalRequest[]{
 if(!isObject(value)||!Array.isArray(value.requests)||value.requests.length>200)throw Error('invalid')
 for(const row of value.requests){if(!isObject(row)||!isObject(row.envelope)||!isObject(row.plan)||typeof row.envelope.request_id!=='string'||!/^[A-Za-z0-9_-]{43}$/u.test(row.envelope.request_id)||typeof row.envelope.digest!=='string'||!/^sha256:[a-f0-9]{64}$/u.test(row.envelope.digest)||typeof row.state!=='string'||!Object.hasOwn(states,row.state)||typeof row.summary!=='string'||!['computer.observe','computer.interact'].includes(String(row.plan.capability))||typeof row.plan.expires_at!=='string'||!Number.isFinite(Date.parse(row.plan.expires_at))||['intent','node_id','owner_user_id','session_ref','channel','subject','sender_user_id','team_id','project_id'].some(key=>typeof (row.plan as Record<string,unknown>)[key]!=='string'))throw Error('invalid')}
 return value.requests as unknown as RemoteComputerLocalRequest[]
}
export function RemoteComputerPanel(){
 const [rows,setRows]=useState<RemoteComputerLocalRequest[]>([]),[error,setError]=useState(''),[busy,setBusy]=useState<string>(),[available,setAvailable]=useState(false)
 const generation=useRef(0),active=useRef(false),mutation=useRef(false),controller=useRef<AbortController>()
 const load=useCallback(async(id?:string,digest?:string,action?:'approve'|'deny'|'revoke')=>{
  if(mutation.current)return
  controller.current?.abort();const abort=new AbortController();controller.current=abort
  const version=++generation.current;mutation.current=Boolean(action);setBusy(id)
  const deadline=window.setTimeout(()=>abort.abort(),10_000)
  try{
   const suffix=action?`/${id}/${action==='revoke'?'revoke':'decide'}`:''
   const res=await fetch('/lumo/api/remote-computer'+suffix,{credentials:'same-origin',cache:'no-store',signal:abort.signal,...(action?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(action==='revoke'?{digest}:{digest,approve:action==='approve'})}:{})})
   if(!res.ok){if((res.status===401||res.status===403)&&active.current&&version===generation.current)setRows([]);if(res.status===503&&!action){if(active.current&&version===generation.current){setAvailable(false);setRows([])}return}throw Error(String(res.status))}
   const next=requests(await res.json());abort.signal.throwIfAborted();if(active.current&&version===generation.current){setRows(next);setAvailable(true);setError('')}
  }catch{if(active.current&&version===generation.current){setAvailable(false);setError(action?'决定的结果尚未确认，请刷新核对；不会自动再次执行。':'远程请求读取失败，请刷新。')}}
  finally{window.clearTimeout(deadline);if(active.current&&version===generation.current){mutation.current=false;setBusy(undefined)}}
 },[])
 useEffect(()=>{active.current=true;void load();const timer=window.setInterval(()=>{void load()},3000);return()=>{active.current=false;generation.current++;controller.current?.abort();window.clearInterval(timer)}},[load])
 if(!available&&!error)return null
 return <section className="lumo-computer-events" aria-labelledby="remote-computer-title"><header><h2 id="remote-computer-title">远程操作请求</h2><button type="button" className="lumo-secondary" disabled={busy!==undefined} onClick={()=>void load()}>刷新</button></header>
 {error?<p role="alert">{error}</p>:null}
 {rows.length===0?<p className="lumo-computer-empty">暂无远程操作请求。</p>:<ol>{rows.map(row=>{const id=row.envelope.request_id,digest=row.envelope.digest,pending=row.state==='pending',running=row.state==='running',expired=Date.parse(row.plan.expires_at)<=Date.now();return <li key={id} data-state={row.state}><div><strong>{row.plan.intent}</strong><span>{states[row.state]} · {row.plan.capability==='computer.observe'?'仅观察':'允许交互'}</span><span>来源 {row.plan.channel} / {row.plan.subject} · 发起人 {row.plan.sender_user_id}</span><span>团队 {row.plan.team_id} · 项目 {row.plan.project_id}</span><span>目标 {row.plan.node_id} · 对话 {row.plan.session_ref}</span><span>截止 {new Date(row.plan.expires_at).toLocaleString('zh-CN')}</span>{row.summary?<span>{row.summary}</span>:null}{pending||running?<div className="lumo-computer-actions">{pending?<><button type="button" className="lumo-button" disabled={!available||busy!==undefined||expired} onClick={()=>void load(id,digest,'approve')}>允许此次请求</button><button type="button" className="lumo-secondary" disabled={!available||busy!==undefined} onClick={()=>void load(id,digest,'deny')}>拒绝</button></>:<button type="button" className="lumo-secondary lumo-computer-stop" disabled={!available||busy!==undefined} onClick={()=>void load(id,digest,'revoke')}>停止此次请求</button>}</div>:null}</div></li>})}</ol>}
 </section>
}
