import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import * as https from 'https';
import axios, { AxiosError } from 'axios';
// Transitive dep via axios/nest; used for multipart file upload.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const FormData = require('form-data');

type UploadFile = {
  buffer: Buffer;
  mimetype: string;
  originalname: string;
  size: number;
};

@Injectable()
export class CloudinaryService {
  private readonly logger = new Logger(CloudinaryService.name);

  constructor(private readonly config: ConfigService) {}

  async uploadImage(
    file: UploadFile,
    folder?: string,
  ): Promise<{ url: string; publicId: string }> {
    const cloudName = this.config.get<string>('cloudinary.cloudName');
    const apiKey = this.config.get<string>('cloudinary.apiKey');
    const apiSecret = this.config.get<string>('cloudinary.apiSecret');
    const defaultFolder =
      this.config.get<string>('cloudinary.folder') || 'ojarun/products';

    if (!cloudName || !apiKey || !apiSecret) {
      throw new ServiceUnavailableException(
        'Cloudinary is not configured. Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET.',
      );
    }

    if (!file?.buffer?.length) {
      throw new BadRequestException('No image file provided');
    }

    if (!file.mimetype?.startsWith('image/')) {
      throw new BadRequestException('Only image uploads are allowed');
    }

    const timestamp = Math.floor(Date.now() / 1000);
    const uploadFolder = folder || defaultFolder;
    const paramsToSign = `folder=${uploadFolder}&timestamp=${timestamp}`;
    const signature = createHash('sha1')
      .update(paramsToSign + apiSecret)
      .digest('hex');

    const form = new FormData();
    form.append('file', file.buffer, {
      filename: file.originalname || 'upload.jpg',
      contentType: file.mimetype,
    });
    form.append('api_key', apiKey);
    form.append('timestamp', String(timestamp));
    form.append('signature', signature);
    form.append('folder', uploadFolder);

    const endpoint = `https://api.cloudinary.com/v1_1/${cloudName}/image/upload`;
    const tlsInsecure =
      this.config.get<boolean>('cloudinary.tlsInsecure') === true ||
      (this.config.get<string>('env') ?? 'development') !== 'production';

    try {
      const { data } = await axios.post(endpoint, form, {
        headers: form.getHeaders(),
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        timeout: 30_000,
        ...(tlsInsecure
          ? { httpsAgent: new https.Agent({ rejectUnauthorized: false }) }
          : {}),
      });

      if (!data?.secure_url || !data?.public_id) {
        this.logger.error(`Cloudinary upload failed: ${JSON.stringify(data)}`);
        throw new BadRequestException(
          data?.error?.message || 'Cloudinary upload failed',
        );
      }

      return { url: data.secure_url, publicId: data.public_id };
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      if (err instanceof ServiceUnavailableException) throw err;

      const ax = err as AxiosError<any>;
      const reason =
        ax.response?.data?.error?.message ||
        ax.message ||
        'Could not upload image';
      this.logger.error(`Cloudinary upload error: ${reason}`);
      throw new ServiceUnavailableException(reason);
    }
  }
}
