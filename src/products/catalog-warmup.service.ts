import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ProductsService } from './products.service';

/**
 * After boot (including Render cold starts), prime the public catalog cache
 * so the first marketplace visitor does not wait on a cold Postgres query.
 */
@Injectable()
export class CatalogWarmupService implements OnModuleInit {
  private readonly logger = new Logger(CatalogWarmupService.name);

  constructor(private readonly products: ProductsService) {}

  onModuleInit() {
    // Don't block Nest listen(); warm in the background.
    void this.warm();
  }

  private async warm() {
    try {
      const rows = await this.products.findAllPublic();
      this.logger.log(`Catalog cache warmed (${rows.length} products)`);
    } catch (err) {
      this.logger.warn(
        `Catalog warmup skipped: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
}
