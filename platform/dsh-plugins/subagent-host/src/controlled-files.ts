import type { Context } from '@deepseek-ai/cordis'

export const CLOSED_TEXT_PROFILE='platform-closed-text-v1'
export const CLOSED_FILES_PROFILE='platform-closed-text-files-v1'
export const CONTROLLED_FILE_TOOL='generate_text_artifact'
export interface ControlledTextFile {name:string;media_type:string;text:string}
const media:Record<string,string>={txt:'text/plain; charset=utf-8',md:'text/markdown; charset=utf-8',csv:'text/csv; charset=utf-8',json:'application/json'}

export function validateControlledFile(value:unknown):asserts value is ControlledTextFile{
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Controlled file requires an object')
  const file=value as Record<string,unknown>
  if(Object.keys(file).some(key=>!['name','media_type','text'].includes(key))||typeof file.name!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,115}\.(txt|md|csv|json)$/u.test(file.name)||file.name.includes('..')
    ||typeof file.text!=='string'||!file.text.length||file.text.includes('\0')||Buffer.byteLength(file.text)>32768||Buffer.from(file.text).toString('utf8')!==file.text
    ||media[file.name.split('.').at(-1)!]!==file.media_type)throw new Error('Controlled file requires a safe leaf name, matching media type and 1..32768 UTF-8 bytes')
  if(file.media_type==='application/json'){try{JSON.parse(file.text)}catch{throw new Error('Controlled JSON file must be valid JSON')}}
}

/** Only this closure owns the complete output set. Tool calls cannot choose a
 * storage key, overwrite a prior entry, or register a pre-existing host file. */
export class ControlledFiles {
  private readonly files=new Map<string,ControlledTextFile>()
  private total=0
  private sealed=false
  add(value:unknown):{name:string;bytes:number}{
    if(this.sealed)throw new Error('Controlled output set is sealed')
    validateControlledFile(value)
    const name=value.name.toLowerCase(),size=Buffer.byteLength(value.text)
    if(this.files.has(name))throw new Error('Controlled file names cannot be overwritten')
    if(this.files.size>=16||this.total+size>256*1024)throw new Error('Controlled output exceeds 16 files or 256 KiB')
    this.files.set(name,{...value});this.total+=size
    return {name:value.name,bytes:size}
  }
  seal():ControlledTextFile[]{this.sealed=true;return [...this.files.values()].map(file=>({...file}))}
  install(ctx:Context,sessionRef:string):void{
    ctx.tools.register({
      name:CONTROLLED_FILE_TOOL,
      description:'Generate one immutable UTF-8 text deliverable for independent review. Accepts text only; no filesystem, URL, executable or external operation is available. Allowed suffixes: .txt, .md, .csv, .json. Each file at most 32 KiB; at most 16 files / 256 KiB total. Names cannot be reused.',
      parameters:{type:'object',additionalProperties:false,required:['name','media_type','text'],properties:{name:{type:'string'},media_type:{type:'string',enum:Object.values(media)},text:{type:'string',minLength:1,maxLength:32768}}},
      output:{schema:{type:'object',properties:{name:{type:'string'},bytes:{type:'integer'}}},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},
      execute:(args,exec)=>{
        exec.signal.throwIfAborted()
        if(!exec.agent||String(exec.agent.session.id)!==sessionRef)throw new Error('Controlled file tool requires its exact execution Session')
        return Promise.resolve(this.add(args))
      },
    })
  }
}
