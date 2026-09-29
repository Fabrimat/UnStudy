describe('LOG_LEVEL config', () => {
  const load = async (value: string) => {
    process.env.LOG_LEVEL = value;
    jest.resetModules();
    return import('../src/config');
  };

  it('defaults to info when unset', async () => {
    const { config } = await load('');
    expect(config.logLevel).toBe('info');
    expect(config.logLevels).toEqual(['error', 'warn', 'log']);
  });

  it('accepts a valid level case-insensitively', async () => {
    const { config } = await load('DEBUG');
    expect(config.logLevel).toBe('debug');
    expect(config.logLevels).toEqual(['error', 'warn', 'log', 'debug', 'verbose']);
  });

  it('fails fast on an invalid level', async () => {
    process.env.LOG_LEVEL = 'trace';
    jest.resetModules();
    await expect(import('../src/config')).rejects.toThrow('Invalid LOG_LEVEL');
  });
});

describe('maskEmail', () => {
  it('keeps the first letter and the domain', async () => {
    const { maskEmail } = await import('../src/auth/mask-email');
    expect(maskEmail('fabrizio@larosa.work')).toBe('f***@larosa.work');
  });

  it('hides short or malformed addresses', async () => {
    const { maskEmail } = await import('../src/auth/mask-email');
    expect(maskEmail('a@b.co')).toBe('***@b.co');
    expect(maskEmail('@b.co')).toBe('***');
    expect(maskEmail('nope')).toBe('***');
  });
});
