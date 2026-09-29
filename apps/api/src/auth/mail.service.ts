import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { createTransport, Transporter } from 'nodemailer';
import { config } from '../config';

const RESEND_URL = 'https://api.resend.com/emails';

@Injectable()
export class MailService {
  private logger = new Logger(MailService.name);
  // Resend's HTTPS API when configured (many PaaS plans block outbound SMTP), SMTP otherwise.
  // Short timeouts: a login request must fail fast instead of hanging on an unreachable server.
  private smtp: Transporter | null = config.resendApiKey
    ? null
    : createTransport({ url: config.smtpUrl!, connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000 });

  async send(to: string, subject: string, text: string) {
    try {
      if (this.smtp) {
        await this.smtp.sendMail({ from: config.mailFrom, to, subject, text });
        return;
      }
      const res = await fetch(RESEND_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.resendApiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: config.mailFrom, to: [to], subject, text }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`Resend answered ${res.status}: ${await res.text()}`);
    } catch (e) {
      // provider errors can echo the recipient: keep the domain only
      this.logger.error(`Could not send email: ${(e as Error).message.replace(/[^\s@<>"':,]+@/g, '***@')}`);
      throw new ServiceUnavailableException('Could not send the email, please try again later');
    }
  }
}
