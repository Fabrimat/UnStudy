import { Injectable } from '@nestjs/common';
import { createTransport } from 'nodemailer';
import { config } from '../config';

@Injectable()
export class MailService {
  private transport = createTransport(config.smtpUrl);

  async send(to: string, subject: string, text: string) {
    await this.transport.sendMail({ from: config.mailFrom, to, subject, text });
  }
}
