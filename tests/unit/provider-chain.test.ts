import { describe, expect, it } from 'vitest';
import { ProviderChain } from '../../src/service/provider-chain';
import type {
  Language,
  ProviderConfig,
  ProviderError,
  ProviderType,
  Segment,
  TranslatedSegment,
  TranslationProvider,
} from '../../src/shared/types';

// ---- 桩 ----

class StubProvider implements TranslationProvider {
  readonly name: ProviderType = 'openai-compatible';
  readonly batchLimit = 10;
  readonly maxCharsPerReq = 16_000;
  calls = 0;
  constructor(
    private readonly behaviors: Array<(segments: Segment[]) => TranslatedSegment[]>,
  ) {}
  async detectLanguage(): Promise<Language> {
    return 'auto';
  }
  async translateBatch(segments: Segment[]): Promise<TranslatedSegment[]> {
    this.calls += 1;
    const behavior = this.behaviors[Math.min(this.calls - 1, this.behaviors.length - 1)];
    return behavior(segments);
  }
  abort(): void {}
}

function failAll(segments: Segment[], code: ProviderError['code']): TranslatedSegment[] {
  return segments.map((s) => ({ id: s.id, text: '', error: { code } as ProviderError }));
}

function okAll(prefix: string) {
  return (segments: Segment[]): TranslatedSegment[] =>
    segments.map((s) => ({ id: s.id, text: `${prefix}:${s.id}` }));
}

const baseSeg = (id: string): Segment => ({ id, text: 'x' });
const cfg = (type: ProviderType, enabled = true): ProviderConfig => ({ type, enabled });

function makeChain(stubs: StubProvider[], configs: ProviderConfig[]): ProviderChain {
  let i = 0;
  return new ProviderChain(() => configs, () => stubs[i++] as TranslationProvider);
}

describe('ProviderChain', () => {
  it('主失败 → 自动降级到次；主只调用一次', async () => {
    const primary = new StubProvider([(segs) => failAll(segs, 'E_PROVIDER_DOWN')]);
    const secondary = new StubProvider([okAll('sec')]);
    const chain = makeChain([primary, secondary], [cfg('openai-compatible'), cfg('google-free')]);
    const res = await chain.translateBatch([baseSeg('1')], 'auto', 'zh-CN');
    expect(res.items[0]?.text).toBe('sec:1');
    expect(res.error).toBeUndefined();
    expect(primary.calls).toBe(1);
  });

  it('全部失败 → 返回最后一家 items 与 error', async () => {
    const a = new StubProvider([(segs) => failAll(segs, 'E_RATE_LIMITED')]);
    const b = new StubProvider([(segs) => failAll(segs, 'E_TIMEOUT')]);
    const chain = makeChain([a, b], [cfg('google-free'), cfg('microsoft-free')]);
    const res = await chain.translateBatch([baseSeg('1')], 'auto', 'zh-CN');
    expect(res.error?.code).toBe('E_TIMEOUT');
    expect(res.items).toHaveLength(1);
  });

  it('全部禁用 → E_PROVIDER_DOWN(no enabled provider)，零调用', async () => {
    const stub = new StubProvider([okAll('mid')]);
    const chain = makeChain([stub], [cfg('openai-compatible', false)]);
    const res = await chain.translateBatch([baseSeg('1')], 'auto', 'zh-CN');
    expect(res.error?.code).toBe('E_PROVIDER_DOWN');
    expect((res.error as { detail?: string } | undefined)?.detail).toBe('no enabled provider');
    expect(stub.calls).toBe(0);
  });

  it('部分成功不算整批失败（不降级）', async () => {
    const primary = new StubProvider([
      (segs) =>
        segs.map((s, i) => ({
          id: s.id,
          text: i === 0 ? 'ok' : '',
          error: i === 0 ? undefined : { code: 'E_TIMEOUT' } as ProviderError,
        })),
    ]);
    const secondary = new StubProvider([okAll('sec')]);
    const chain = makeChain([primary, secondary], [cfg('openai-compatible'), cfg('google-free')]);
    const res = await chain.translateBatch([baseSeg('1'), baseSeg('2')], 'auto', 'zh-CN');
    expect(res.items[0]?.text).toBe('ok');
    expect(secondary.calls).toBe(0);
  });

  it('detectLanguage：第一失败自动跳到下一家', async () => {
    class ThrowingProvider extends StubProvider {
      async detectLanguage(): Promise<Language> {
        throw new Error('network');
      }
    }
    const chain = makeChain(
      [new ThrowingProvider([okAll('x')]), new StubProvider([okAll('y')])],
      [cfg('google-free'), cfg('microsoft-free')],
    );
    expect(await chain.detectLanguage('hi')).toBe('auto');
  });

  it('abort 转发给所有 provider', async () => {
    let aborted = 0;
    class Abortable extends StubProvider {
      override abort(): void {
        aborted += 1;
      }
    }
    const chain = makeChain(
      [new Abortable([okAll('a')]), new Abortable([okAll('b')])],
      [cfg('openai-compatible'), cfg('google-free')],
    );
    chain.abort();
    expect(aborted).toBe(2);
  });
});
