import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

const TERMII_SEND_URL = 'https://api.ng.termii.com/api/sms/send';
const FETCH_TIMEOUT_MS = 15_000;

@Injectable()
export class SmsService {
  private readonly logger = new Logger(SmsService.name);

  constructor(private readonly config: ConfigService) {}

  /**
   * Sends a plain SMS. If no Termii API key is configured (e.g. local dev),
   * logs the message instead of failing — lets the OTP flow be tested
   * end-to-end without a paid SMS account.
   */
  async send(to: string, message: string): Promise<void> {
    const apiKey = this.config.get<string>('sms.termiiApiKey');
    const senderId = this.config.get<string>('sms.senderId');

    if (!apiKey) {
      this.logger.warn(
        `TERMII_API_KEY not configured — SMS not sent. Would have sent to ${to}: "${message}"`,
      );
      return;
    }

    try {
      await axios.post(
        TERMII_SEND_URL,
        {
          api_key: apiKey,
          to,
          from: senderId,
          sms: message,
          type: 'plain',
          channel: 'generic',
        },
        { timeout: FETCH_TIMEOUT_MS },
      );
    } catch (err) {
      this.logger.error(`Failed to send SMS to ${to}`, err as Error);
      throw err;
    }
  }
}
