import { ServiceUnavailableException } from '@nestjs/common';

describe('MailService with Resend', () => {
  let MailService: typeof import('../src/auth/mail.service').MailService;
  const fetchMock = jest.fn();

  beforeAll(async () => {
    // config is read at import time, so set the env before loading the service
    process.env.RESEND_API_KEY = 're_test_key';
    process.env.MAIL_FROM = 'UnStudy <login@example.com>';
    ({ MailService } = await import('../src/auth/mail.service'));
    global.fetch = fetchMock as unknown as typeof fetch;
  });
  beforeEach(() => fetchMock.mockReset());

  it('posts the email to the Resend API', async () => {
    fetchMock.mockResolvedValue({ ok: true });
    await new MailService().send('ada@example.com', 'Your login link', 'Open it');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.resend.com/emails');
    expect(init.headers.Authorization).toBe('Bearer re_test_key');
    expect(JSON.parse(init.body)).toEqual({
      from: 'UnStudy <login@example.com>', to: ['ada@example.com'], subject: 'Your login link', text: 'Open it',
    });
  });

  it('turns a provider rejection into a 503', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 403, text: async () => 'domain not verified' });
    await expect(new MailService().send('ada@example.com', 's', 't')).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
