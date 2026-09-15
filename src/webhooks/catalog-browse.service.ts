import { Injectable, Logger } from "@nestjs/common";
import { ProductsService } from "../products/products.service";
import {
  BrowseIntent,
  chunkWhatsAppText,
  clip,
  formatNaira,
} from "./catalog-browse.util";

export type CatalogProductView = {
  id: string;
  name: string;
  unit: string;
  currentPrice: number;
  category: string | null;
};

export type WhatsAppListSection = {
  title?: string;
  rows: Array<{ id: string; title: string; description?: string }>;
};

export type CatalogBrowseReply = {
  texts: string[];
  list?: {
    body: string;
    button: string;
    header?: string;
    footer?: string;
    sections: WhatsAppListSection[];
  };
};

const MAX_LIST_ROWS = 10;
const ORDER_HINT =
  `To order, send the item with quantity — e.g. *"2kg Garri"* or *"N5000 worth of rice"*.`;

@Injectable()
export class CatalogBrowseService {
  private readonly logger = new Logger(CatalogBrowseService.name);

  constructor(private readonly products: ProductsService) {}

  async buildReply(intent: BrowseIntent): Promise<CatalogBrowseReply> {
    try {
      if (intent.kind === "index") return this.buildIndex();
      if (intent.kind === "category") {
        return this.buildProductList(
          await this.products.findAllPublic(undefined, intent.category),
          intent.category,
        );
      }
      if (intent.kind === "product") {
        return this.buildSingleProduct(intent.productId);
      }
      return this.buildProductList(
        await this.products.findAllPublic(intent.query),
        intent.query,
        { isSearch: true },
      );
    } catch (err) {
      this.logger.error("Catalog browse failed", err as Error);
      return {
        texts: [
          "I couldn't load the market list just now. Abeg try *BROWSE* again in a moment, or send your shopping list and we'll shop it.",
        ],
      };
    }
  }

  private async buildIndex(): Promise<CatalogBrowseReply> {
    const products = await this.products.findAllPublic();
    if (products.length === 0) {
      return {
        texts: [
          `No products are listed right now. Send your shopping list (e.g. *"2kg tomatoes, 1 bag rice"*) and we'll buy it from the market.`,
        ],
      };
    }

    const categories = this.groupCategories(products);
    const intro =
      `🛒 *Today's OjaRun market*\nPrices are live — we update them as we restock.\n\n` +
      `Pick a category, or ask *HOW MUCH rice*.\n${ORDER_HINT}`;

    if (categories.length <= MAX_LIST_ROWS) {
      return {
        texts: [],
        list: {
          header: "OjaRun market",
          body: intro,
          button: "See categories",
          footer: "Reply BROWSE anytime",
          sections: [
            {
              title: "Categories",
              rows: categories.map((c) => ({
                id: `browse:cat:${c.name}`,
                title: clip(c.name, 24),
                description: clip(
                  `${c.count} item${c.count === 1 ? "" : "s"} · live prices`,
                  72,
                ),
              })),
            },
          ],
        },
      };
    }

    let text = `${intro}\n\n`;
    for (const c of categories) {
      text += `• *${c.name}* (${c.count})\n`;
    }
    text += `\nReply *BROWSE meals* (use the category name) to see items.`;
    return { texts: chunkWhatsAppText(text) };
  }

  private async buildProductList(
    products: CatalogProductView[],
    label: string,
    opts?: { isSearch?: boolean },
  ): Promise<CatalogBrowseReply> {
    if (products.length === 0) {
      return {
        texts: [
          opts?.isSearch
            ? `I no see *${label}* in today's list. Reply *BROWSE* to see everything, or send it with a quantity and we'll still shop it from the market.`
            : `Nothing in *${label}* right now. Reply *BROWSE* to see other categories, or send your list and we'll shop it.`,
        ],
      };
    }

    const heading = opts?.isSearch
      ? `🔍 Results for *${label}*`
      : `🛒 *${label}*`;
    const intro = `${heading}\nLive prices:\n`;

    if (products.length <= MAX_LIST_ROWS) {
      return {
        texts: [],
        list: {
          header: clip(label, 60),
          body: `${intro}${ORDER_HINT}`,
          button: "See items",
          footer: "Prices update as we restock",
          sections: [
            {
              title: clip(label, 24),
              rows: products.map((p) => ({
                id: `browse:product:${p.id}`,
                title: clip(p.name, 24),
                description: clip(
                  `${formatNaira(p.currentPrice)} / ${p.unit}`,
                  72,
                ),
              })),
            },
          ],
        },
      };
    }

    const grouped = this.groupProducts(products);
    let text = `${intro}\n`;
    for (const [category, items] of grouped) {
      text += `*${category}*\n`;
      for (const p of items) {
        text += `• ${p.name} — ${formatNaira(p.currentPrice)} / ${p.unit}\n`;
      }
      text += `\n`;
    }
    text += ORDER_HINT;
    text += `\nReply *BROWSE* to see categories.`;
    return { texts: chunkWhatsAppText(text.trim()) };
  }

  private async buildSingleProduct(
    productId: string,
  ): Promise<CatalogBrowseReply> {
    try {
      const product = await this.products.findOnePublic(productId);
      const categoryLine = product.category
        ? `\n📂 ${product.category}`
        : "";
      const desc = product.description ? `\n${product.description}` : "";
      return {
        texts: [
          `*${product.name}*${categoryLine}\n💰 *${formatNaira(product.currentPrice)}* / ${product.unit}${desc}\n\n${ORDER_HINT}\nReply *BROWSE* to keep looking.`,
        ],
      };
    } catch {
      return {
        texts: [
          `That item isn't available right now. Reply *BROWSE* to see today's list.`,
        ],
      };
    }
  }

  private groupCategories(products: CatalogProductView[]) {
    const map = new Map<string, { name: string; count: number }>();
    for (const p of products) {
      const name = (p.category || "Other").trim() || "Other";
      const key = name.toLowerCase();
      const cur = map.get(key);
      if (cur) cur.count += 1;
      else map.set(key, { name, count: 1 });
    }
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  private groupProducts(products: CatalogProductView[]) {
    const map = new Map<string, CatalogProductView[]>();
    for (const p of products) {
      const name = (p.category || "Other").trim() || "Other";
      const list = map.get(name) ?? [];
      list.push(p);
      map.set(name, list);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }
}
