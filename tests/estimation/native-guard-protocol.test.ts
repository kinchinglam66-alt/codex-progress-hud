import {expect,it} from 'vitest';
import {encodeNativeGuardRequest,decodeNativeGuardResponse} from '../../src/estimation/native-guard-protocol.js';

it('encodes only bounded fixed operations',()=>{
 expect(encodeNativeGuardRequest(1,{op:'verify_storage'})).toBe('{"v":1,"id":1,"op":"verify_storage"}\n');
 expect(encodeNativeGuardRequest(2,{op:'owner_exited',pid:23,creationIdentity:'123'})).toBe('{"v":1,"id":2,"op":"owner_exited","pid":23,"creationIdentity":"123"}\n');
});
it.each([
 {op:'verify_storage',path:'C:/elsewhere'}, {op:'kill'},
 {op:'owner_exited',pid:0,creationIdentity:'12'},
 {op:'owner_exited',pid:4294967296,creationIdentity:'12'},
 {op:'owner_exited',pid:1,creationIdentity:'1; exit'},
 {op:'owner_exited',pid:1,creationIdentity:'1'.repeat(21)},
])('rejects malformed request %j',request=>{
 expect(()=>encodeNativeGuardRequest(1,request as never)).toThrow();
});
it.each([0,-1,1.5,Number.MAX_SAFE_INTEGER+1])('rejects invalid request id %s',id=>{
 expect(()=>encodeNativeGuardRequest(id,{op:'verify_storage'})).toThrow();
});
it('accepts only operation-specific matched results',()=>{
 expect(decodeNativeGuardResponse('{"v":1,"id":1,"op":"verify_storage","result":"ok"}',1,'verify_storage')).toBe('ok');
 expect(decodeNativeGuardResponse('{"v":1,"id":2,"op":"owner_exited","result":"live"}',2,'owner_exited')).toBe('live');
 expect(decodeNativeGuardResponse('{"v":1,"id":2,"op":"owner_exited","result":"exited"}',2,'owner_exited')).toBe('exited');
});
it.each([
 '{"v":1,"id":1,"id":2,"op":"verify_storage","result":"ok"}',
 '{"v":1,"id":2,"op":"verify_storage","result":"ok","extra":0}',
 '{"v":1,"id":3,"op":"verify_storage","result":"ok"}',
 '{"v":1,"id":2,"op":"owner_exited","result":"ok"}',
 '{"v":1,"id":2,"op":"verify_storage","result":"exited"}',
 '{"v":1,"id":2,"op":"verify_storage","result":"failed"}',
 '{"v":1,"id":2,"op":"verify_storage","result":"ok"}\n{}',
 ' '.repeat(1025),
])('rejects unsafe response %s',line=>{
 expect(()=>decodeNativeGuardResponse(line,2,'verify_storage')).toThrow();
});
