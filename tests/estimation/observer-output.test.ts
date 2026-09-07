import {expect, it} from 'vitest';
import {createObserverOutputParser} from '../../src/estimation/codex-output.js';

const interpretation = {relation: 'replace', status: 'running', summary: 'Build the report',
  estimate: {remainingSeconds: 14400, errorPercent: 30}};
function stream(value: unknown, usage: unknown = {input_tokens: 500, output_tokens: 50, cached_input_tokens: 100}) {
  return Buffer.from([
    {type: 'turn.started'},
    {type: 'item.completed', item: {id: 'answer', type: 'agent_message', text: JSON.stringify(value)}},
    {type: 'turn.completed', usage}
  ].map(event => JSON.stringify(event)).join('\n'));
}

it('decodes independent goal interpretation with usage through the bounded CLI stream', () => {
  const parser = createObserverOutputParser();
  expect(parser.push(stream(interpretation))).toBe(true);
  expect(parser.end()).toEqual({ok: true, interpretation,
    usage: {kind: 'subscription-tokens', inputTokens: 500, outputTokens: 50, cachedInputTokens: 100}, error: null,
    framingValid: true, predictionStatus: 'numeric', usageStatus: 'known'});
});

it('preserves explicit uncertainty as a successful interpretation, not a transport error', () => {
  const unknown = {relation: 'unknown', status: 'unknown', summary: null, estimate: null};
  const parser = createObserverOutputParser(); parser.push(stream(unknown));
  expect(parser.end()).toMatchObject({ok: true, interpretation: unknown,
    framingValid: true, predictionStatus: 'unknown', usageStatus: 'known'});
});

it('rejects model-supplied identity and contradictory interpretation without echoing them', () => {
  for (const value of [
    {...interpretation, sessionKey: 'PRIVATE forbidden identity'},
    {...interpretation, relation: 'unknown'},
    {...interpretation, estimate: {remainingSeconds: -1, errorPercent: 30}}
  ]) {
    const parser = createObserverOutputParser(); parser.push(stream(value));
    expect(parser.end()).toMatchObject({ok: false, interpretation: null, usage: {
      kind: 'subscription-tokens', inputTokens: 500, outputTokens: 50, cachedInputTokens: 100},
      framingValid: true, predictionStatus: 'invalid', usageStatus: 'known', error: 'invalid_prediction'});
    expect(JSON.stringify(parser.end())).not.toContain('PRIVATE');
  }
});

it('rejects attempted tools in the observer stream before accepting an answer', () => {
  const parser = createObserverOutputParser();
  expect(parser.push(Buffer.from(JSON.stringify({type: 'item.started',
    item: {type: 'command_execution', command: 'PRIVATE command'}}) + '\n'))).toBe(false);
  expect(parser.end()).toMatchObject({ok: false, interpretation: null, usage: null,
    error: 'unexpected_tool', framingValid: false, predictionStatus: 'invalid', usageStatus: 'unknown'});
});

it('retains a bounded basis category without accepting free-form reasoning',()=>{
  const parser=createObserverOutputParser();parser.push(stream({...interpretation,basis:'known_wait'}));
  expect(parser.end()).toMatchObject({ok:true,interpretation:{basis:'known_wait'}});
  const invalid=createObserverOutputParser();invalid.push(stream({...interpretation,basis:'PRIVATE reasoning here'}));
  expect(invalid.end()).toMatchObject({ok:false,interpretation:null, error:'invalid_prediction'});
  expect(JSON.stringify(invalid.end())).not.toContain('PRIVATE');
});

it('preserves a valid framed interpretation when final usage is absent', () => {
  const parser = createObserverOutputParser();
  expect(parser.push(Buffer.from([
    {type: 'turn.started'},
    {type: 'item.completed', item: {id: 'answer', type: 'agent_message', text: JSON.stringify(interpretation)}},
    {type: 'turn.completed'}
  ].map(event => JSON.stringify(event)).join('\n')))).toBe(true);
  expect(parser.end()).toEqual({ok: false, interpretation,
    usage: null, error: 'missing_usage', framingValid: true,
    predictionStatus: 'numeric', usageStatus: 'unknown'});
});

it('preserves a valid framed interpretation when final usage is invalid', () => {
  const parser = createObserverOutputParser();
  parser.push(stream(interpretation, {input_tokens: 500}));
  expect(parser.end()).toMatchObject({ok: false, interpretation,
    usage: null, error: 'missing_usage', framingValid: true,
    predictionStatus: 'numeric', usageStatus: 'unknown'});
});

it('continues after a semantic-invalid answer to collect valid final usage', () => {
  const parser = createObserverOutputParser();
  expect(parser.push(stream({relation: 'unknown', status: 'running', summary: null, estimate: null}))).toBe(true);
  expect(parser.end()).toEqual({ok: false, interpretation: null,
    usage: {kind: 'subscription-tokens', inputTokens: 500, outputTokens: 50, cachedInputTokens: 100},
    error: 'invalid_prediction', framingValid: true,
    predictionStatus: 'invalid', usageStatus: 'known'});
});

it('does not classify partial usage as complete known usage', () => {
  const parser = createObserverOutputParser();
  parser.push(stream(interpretation, {input_tokens: 500, output_tokens: null}));
  expect(parser.end()).toMatchObject({framingValid: true, interpretation,
    usage: null, error: 'missing_usage', predictionStatus: 'numeric', usageStatus: 'unknown'});
});

it('rejects malformed framing without exposing a previously parsed interpretation', () => {
  const parser = createObserverOutputParser();
  expect(parser.push(Buffer.from([
    {type: 'turn.started'},
    {type: 'item.completed', item: {id: 'answer', type: 'agent_message', text: JSON.stringify(interpretation)}}
  ].map(event => JSON.stringify(event)).join('\n') + '\nnot-json\n'))).toBe(false);
  expect(parser.end()).toEqual({ok: false, interpretation: null, usage: null,
    error: 'protocol', framingValid: false, predictionStatus: 'invalid', usageStatus: 'unknown'});
});

it('rejects multiple answers and cancels before returning a usable interpretation', () => {
  const parser = createObserverOutputParser();
  const answer = (value: unknown) => ({type: 'item.completed', item: {
    id: 'answer', type: 'agent_message', text: JSON.stringify(value)}});
  expect(parser.push(Buffer.from([
    {type: 'turn.started'}, answer(interpretation), answer(interpretation)
  ].map(event => JSON.stringify(event)).join('\n') + '\n'))).toBe(false);
  expect(parser.end()).toMatchObject({ok: false, interpretation: null, usage: null,
    error: 'protocol', framingValid: false, predictionStatus: 'invalid', usageStatus: 'unknown'});
});

it('retains observer stream guards for encoding and total size', () => {
  const encoding = createObserverOutputParser();
  expect(encoding.push(Uint8Array.of(0xff))).toBe(false);
  expect(encoding.end()).toMatchObject({error: 'encoding', framingValid: false,
    interpretation: null, usage: null, predictionStatus: 'invalid', usageStatus: 'unknown'});

  const line = createObserverOutputParser();
  expect(line.push(Buffer.alloc(16_385, 32))).toBe(false);
  expect(line.end()).toMatchObject({error: 'output_limit', framingValid: false,
    interpretation: null, usage: null, predictionStatus: 'invalid', usageStatus: 'unknown'});

  const total = createObserverOutputParser();
  expect(total.push(Buffer.alloc(262_145))).toBe(false);
  expect(total.end()).toMatchObject({error: 'output_limit', framingValid: false,
    interpretation: null, usage: null, predictionStatus: 'invalid', usageStatus: 'unknown'});
});
