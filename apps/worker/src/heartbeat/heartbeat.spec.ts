import { heartbeatKey, heartbeatTtlSeconds } from './heartbeat.js';

describe('heartbeat helpers', () => {
  it('namespaces keys', () => {
    expect(heartbeatKey('host-1')).toBe('ssrs:v1:worker:heartbeat:host-1');
  });

  it('expires after three missed intervals, rounded up to whole seconds', () => {
    expect(heartbeatTtlSeconds(15_000)).toBe(45);
    expect(heartbeatTtlSeconds(1_500)).toBe(5);
  });
});
