import { parseModels, parseProviders } from '../src/config';

const j = JSON.stringify;
const provider = { id: 'nvidia', baseUrl: 'https://x/v1' };
const model = { id: 'fast', label: 'Fast', model: 'p/fast', multiplier: 1 };

describe('parseProviders', () => {
  it('defaults to a single provider from LLM_BASE_URL', () => {
    expect(parseProviders(undefined, { LLM_BASE_URL: 'https://b/v1' })).toEqual([{ id: 'default', kind: 'openai', baseUrl: 'https://b/v1', tokenParam: 'max_tokens' }]);
    expect(parseProviders('  ', {})[0].id).toBe('default');
  });
  it('parses a full catalogue and applies defaults', () => {
    const list = parseProviders(
      j([provider, { id: 'openai', kind: 'openai', baseUrl: 'fake', apiKeyEnv: 'OPENAI_API_KEY', tokenParam: 'max_completion_tokens', maxConcurrency: 4 }]),
      {},
    );
    expect(list).toEqual([
      { id: 'nvidia', kind: 'openai', baseUrl: 'https://x/v1', tokenParam: 'max_tokens' },
      { id: 'openai', kind: 'openai', baseUrl: 'fake', apiKeyEnv: 'OPENAI_API_KEY', tokenParam: 'max_completion_tokens', maxConcurrency: 4 },
    ]);
  });
  it('throws on invalid providers without echoing values', () => {
    const bad = [
      '{oops', '[]', j({}), j([null]), j([{ ...provider, id: 'Bad Id' }]), j([provider, provider]), j([{ ...provider, kind: 'anthropic' }]),
      j([{ ...provider, baseUrl: '' }]), j([{ ...provider, tokenParam: 'max' }]), j([{ ...provider, maxConcurrency: 0 }]),
      j([{ ...provider, maxConcurrency: 65 }]), j([{ ...provider, maxConcurrency: 1.5 }]), j([{ ...provider, apiKeyEnv: 'sk-secret value' }]),
    ];
    for (const raw of bad) expect(() => parseProviders(raw, {})).toThrow();
    expect(() => parseProviders(j([{ ...provider, apiKeyEnv: 'sk-secret value' }]), {})).toThrow(/apiKeyEnv/);
    expect(() => parseProviders(j([{ ...provider, apiKeyEnv: 'sk-secret value' }]), {})).not.toThrow(/sk-secret/);
  });
});

describe('parseModels (multi-provider)', () => {
  const providers = [{ id: 'nvidia' }, { id: 'openai' }];
  it('applies defaults: first provider, temperature 0.4, not adminOnly', () => {
    expect(parseModels(j([model]), undefined, providers)).toEqual([{ ...model, provider: 'nvidia', temperature: 0.4, adminOnly: false }]);
  });
  it('accepts provider, null temperature, prices and adminOnly', () => {
    const list = parseModels(j([{ ...model, id: 'lab', adminOnly: true, provider: 'openai', temperature: null, priceIn: 0, priceOut: 1.5 }, model]), undefined, providers);
    expect(list[0]).toMatchObject({ provider: 'openai', temperature: null, priceIn: 0, priceOut: 1.5, adminOnly: true });
    expect(list.filter((m) => !m.adminOnly)[0].id).toBe('fast');
  });
  it('throws on unknown provider, bad numbers, non-boolean adminOnly and all-adminOnly', () => {
    const bad = [
      { ...model, provider: 'nope' }, { ...model, temperature: 2.5 }, { ...model, temperature: -1 }, { ...model, temperature: 'hot' },
      { ...model, priceIn: -1 }, { ...model, priceOut: 'x' }, { ...model, adminOnly: 'yes' },
    ];
    for (const e of bad) expect(() => parseModels(j([e]), undefined, providers)).toThrow();
    expect(() => parseModels(j([{ ...model, adminOnly: true }]), undefined, providers)).toThrow(/not adminOnly/);
  });
});
