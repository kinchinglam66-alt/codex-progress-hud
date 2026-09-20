import {expect,it} from 'vitest';
import {parseEstimateTimeoutMs} from '../../src/estimation/request-timeout.js';
it('defaults to no total deadline and supports explicit limits',()=>{
 expect(parseEstimateTimeoutMs(undefined)).toBe(0);
 expect(parseEstimateTimeoutMs('')).toBe(0);
 expect(parseEstimateTimeoutMs('0')).toBe(0);
 expect(parseEstimateTimeoutMs('30000')).toBe(30000);
});
it.each(['-1','NaN','1.5','Infinity','2147483648'])('rejects invalid timer value %s',value=>{
 expect(()=>parseEstimateTimeoutMs(value)).toThrow('INVALID_ESTIMATE_TIMEOUT');
});
