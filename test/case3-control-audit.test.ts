import { mkdtempSync, writeFileSync, readFileSync, unlinkSync, rmdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { McpStdioClient } from '../tools/acceptance/runtime.js'
import { inspectCase3ControlAudit, classifyCase3Evidence, CASE3_FIXED_GO_MODEL, type SdkEvidence } from '../tools/acceptance/case3-recheck.js'

const workspace = process.cwd()
const seeds = [resolve(workspace, 'seed-1.txt'), resolve(workspace, 'seed-2.txt')]
const sdk: SdkEvidence = { promptId: 'prompt', model: CASE3_FIXED_GO_MODEL, expectedSeeds: seeds,
  toolCalls: ['shell', 'read', 'read'].map((name, index) => ({ sessionId: 'ours', requestID: `request-${index}`, sourceId: `step:tool-${index}`,
    assistantId: 'step', name, status: 'error', errorType: 'tool.execution', asked: true, replied: true, decision: 'reject', ...(index > 0 && { targetPath: seeds[index - 1] }) })) }

it.each(['reorder', 'fragmented', 'without_newline', 'exit_tail', 'timeout', 'cancel', 'gap', 'truncated', 'missing', 'barrier_only', 'audit_throw'])('persists the actual zero-model stdio audit: %s', async (scenario) => {
  const root = mkdtempSync(join(tmpdir(), 'case3-control-audit-'))
  const worker = join(root, 'worker.mjs'), receipt = join(root, 'audit.json')
  const controlModule = pathToFileURL(resolve('tools/acceptance/controlled-events.ts')).href
  writeFileSync(worker, `import {createInterface} from 'node:readline';
import {resolve} from 'node:path';
import {controlEventStream} from ${JSON.stringify(controlModule)};
const scenario=process.argv[2];
const controller=new AbortController();
const workspace=process.cwd();
const ask=(rank)=>({type:'permission.asked',data:{sessionID:'ours',id:'request-'+rank,action:rank===0?'shell':'read',resources:[rank===0?'write shell-marker.txt':resolve(workspace,'seed-'+rank+'.txt')],source:{type:'tool',messageID:'step',id:'tool-'+rank}}});
const ranks=scenario==='timeout'?[2,1]:scenario==='cancel'?[1]:[2,1,0];
const source=(async function*(){for(const rank of ranks)yield ask(rank);await new Promise(done=>{if(controller.signal.aborted)done();else controller.signal.addEventListener('abort',done,{once:true});});})();
let tail='';
const audit=(row)=>{
  if(scenario==='audit_throw'&&row.auditSequence===2)throw new Error('diagnostic failure');
  if(scenario==='missing'||(scenario==='gap'&&row.auditSequence===2)||(scenario==='barrier_only'&&row.kind!=='barrier'))return;
  const line=JSON.stringify({component:'case3-control',...row,password:'private'});
  if(scenario==='truncated'&&row.kind==='end'){process.stderr.write(line.slice(0,line.length-4));return;}
  if(scenario==='without_newline'&&row.kind==='end'){process.stderr.write(line);return;}
  if(scenario==='exit_tail'&&row.kind==='end'){tail=line;return;}
  if(scenario==='fragmented'){const middle=Math.floor(line.length/2);process.stderr.write(line.slice(0,middle));process.stderr.write(line.slice(middle)+'\\n');return;}
  console.error(line);
};
const reader=createInterface({input:process.stdin});
reader.on('close',()=>{if(tail)process.stderr.write(tail);});
reader.on('line',async(line)=>{
  const request=JSON.parse(line);if(request.method!=='initialize')return;
  if(scenario==='cancel')setTimeout(()=>controller.abort(),10);
  let count=0;
  for await(const event of controlEventStream(source,controller.signal,{sessionId:()=> 'ours',workspace,seeds:[resolve(workspace,'seed-1.txt'),resolve(workspace,'seed-2.txt')],marker:'shell-marker.txt',deadline:()=>Date.now()+1000,holdMs:20,audit})){
    if(++count===ranks.length){controller.abort();break;}
  }
  console.log(JSON.stringify({jsonrpc:'2.0',id:request.id,result:{protocolVersion:'2025-06-18',capabilities:{},serverInfo:{name:'zero-model-control',version:'1'}}}));
});`)
  const client = new McpStdioClient('control-audit', process.cwd(), process.env, { entrypoint: worker, args: [scenario] })
  try {
    await client.start(); await client.close()
    expect(client.exitCode).toBe(0)
    expect(client.requestId).toBe(2) // initialize only; never invokes an MCP tool.
    writeFileSync(receipt, JSON.stringify(client.diagnostics))
    const persisted = JSON.parse(readFileSync(receipt, 'utf8'))
    expect(readFileSync(receipt, 'utf8')).not.toContain('private')
    expect(readFileSync(receipt, 'utf8')).not.toContain('write shell-marker')
    const expected = ['reorder', 'fragmented', 'without_newline', 'exit_tail'].includes(scenario) ? 'PASS' : 'UNVERIFIED'
    expect(inspectCase3ControlAudit(persisted, sdk).verdict).toBe(expected)
    if (scenario === 'truncated') expect(client.diagnosticCaptureErrors).toContain('truncated_control_diagnostic')
    if (expected === 'PASS') {
      expect(persisted.filter((row: any) => row.kind === 'raw').map((row: any) => row.requestID)).toEqual(['request-2', 'request-1', 'request-0'])
      expect(persisted.filter((row: any) => row.kind === 'delivered').map((row: any) => row.requestID)).toEqual(['request-0', 'request-1', 'request-2'])
      const classifiedInput = { response: { status: 'rejected', error_code: 'permission_rejected' }, sdk,
        events: sdk.toolCalls.map((call) => ({ sourceId: call.sourceId, sessionId: call.sessionId, requestID: call.requestID, type: 'permission.replied', decision: 'reject' })),
        diagnostics: { bridgeReadAllowReply: false, pendingReadsAtShellReject: true }, before: {}, after: {}, markerAbsent: true,
        sharedIdentityUnchanged: true, mcpClosed: true, contextState: { denyall: 'verified', lease: 'none', quarantine: 'none' },
        controlled: true, controlTrace: persisted, controlCaptureComplete: client.diagnosticCaptureErrors.length === 0 }
      expect(classifyCase3Evidence(classifiedInput).verdict).toBe('PASS')
      const aborted = { ...classifiedInput,
        sdk: { ...sdk, toolCalls: sdk.toolCalls.map((call) => ({ ...call, errorType: call.name === 'read' ? 'aborted' : call.errorType })) },
        assistantErrors: [{ assistantId: 'step', type: 'aborted', status: null }],
        interruption: { serviceVersion: '2.0.18', sessionId: 'ours', promptId: 'prompt', assistantId: 'step',
          uniqueExecution: true, reason: 'shutdown', localInterrupt: false, executionFailed: false, startedSequence: 1, terminalSequence: 10 } }
      expect(classifyCase3Evidence(aborted).verdict).toBe('PASS')
      expect(classifyCase3Evidence({ ...aborted, controlCaptureComplete: undefined }).verdict).toBe('UNVERIFIED')
      expect(classifyCase3Evidence({ ...aborted, interruption: { ...aborted.interruption, localInterrupt: true } }).verdict).toBe('FAIL')
      const corrupted = persisted.map((row: any) => row.kind === 'delivered' && row.requestID === 'request-0' ? { ...row, receiveIndex: 1 } : row)
      expect(inspectCase3ControlAudit(corrupted, sdk).verdict).toBe('UNVERIFIED')
    }
  } finally {
    await client.close()
    if (client.exited) {
      unlinkSync(worker)
      try { unlinkSync(receipt) } catch {}
      rmdirSync(root)
    }
  }
}, 10_000)
