import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import {
  CatalogProduct,
  matchCatalogProduct,
} from "./product-match.util";
import { canonicalItemName } from "./budget.util";

/** Fallback names when DB is empty / offline — not the primary source of truth. */
const FALLBACK_ITEMS = [
  "beans",
  "garri",
  "pepper",
  "titus",
  "yam",
  "plantain",
  "corn",
  "rice",
  "flour",
  "sugar",
  "salt",
  "maggi",
  "tomato",
  "onion",
  "potato",
  "fish",
  "chicken",
  "turkey",
  "beef",
  "goat",
  "egg",
  "oil",
  "groundnut",
  "palm oil",
  "vegetable oil",
  "spaghetti",
  "noodles",
  "indomie",
  "crayfish",
  "dry fish",
  "stock fish",
  "okra",
  "spinach",
  "ugwu",
  "cabbage",
  "carrot",
  "garlic",
  "ginger",
  "thyme",
  "curry",
  "pomo",
  "ponmo",
  "shaki",
  "bread",
  "semo",
  "semovita",
  "amala",
  "eba",
  "ofada rice",
  "tomato paste",
  "dry pepper",
];

const JUNK = new Set([
  "a",
  "an",
  "the",
  "to",
  "for",
  "of",
  "and",
  "or",
  "i",
  "me",
  "my",
  "you",
  "your",
  "we",
  "us",
  "do",
  "don't",
  "dont",
  "not",
  "speak",
  "talk",
  "pidgin",
  "english",
  "language",
  "how",
  "many",
  "times",
  "would",
  "say",
  "that",
  "this",
  "please",
  "stop",
  "using",
  "write",
  "hi",
  "hello",
  "hey",
  "thanks",
  "thank",
  "ok",
  "okay",
  "yes",
  "no",
  "pls",
  "can",
  "get",
  "need",
  "want",
  "evening",
  "morning",
  "afternoon",
  "possible",
  "ordinary",
  "only",
  "deliver",
  "delivery",
  "address",
  "list",
  "order",
]);

const CACHE_TTL_MS = 60_000;

@Injectable()
export class CatalogLookupService implements OnModuleInit {
  private readonly logger = new Logger(CatalogLookupService.name);
  private products: CatalogProduct[] = [];
  private knownKeys = new Set<string>(FALLBACK_ITEMS);
  private loadedAt = 0;

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    await this.refresh().catch((err) =>
      this.logger.warn(`Initial catalog load failed: ${(err as Error).message}`),
    );
  }

  async ensureFresh(): Promise<void> {
    if (Date.now() - this.loadedAt < CACHE_TTL_MS && this.products.length > 0) {
      return;
    }
    await this.refresh();
  }

  async refresh(): Promise<void> {
    try {
      const rows = await this.prisma.product.findMany({
        where: { isAvailable: true },
        select: { id: true, name: true, unit: true, currentPrice: true },
        orderBy: { name: "asc" },
      });
      this.products = rows;
      const keys = new Set<string>(FALLBACK_ITEMS);
      for (const p of rows) {
        const full = p.name.trim().toLowerCase();
        if (full) keys.add(full);
        // Also index significant tokens so "Long Grain Rice" matches "rice"
        for (const token of full.split(/\s+/)) {
          if (token.length >= 3 && !JUNK.has(token)) keys.add(token);
        }
      }
      this.knownKeys = keys;
      this.loadedAt = Date.now();
      this.logger.log(`Catalog lookup ready: ${rows.length} live product(s)`);
    } catch (err) {
      this.logger.warn(
        `Catalog refresh failed — using fallback names: ${(err as Error).message}`,
      );
      this.knownKeys = new Set(FALLBACK_ITEMS);
      this.loadedAt = Date.now();
    }
  }

  getProducts(): CatalogProduct[] {
    return this.products;
  }

  isJunk(name: string): boolean {
    const n = name.trim().toLowerCase().replace(/[’']/g, "");
    return !n || JUNK.has(n);
  }

  /**
   * True if this name is a real grocery we should keep in the cart.
   * Prefers live DB names; falls back to common market vocabulary.
   */
  isKnownItem(name: string): boolean {
    const canon = canonicalItemName(name).toLowerCase();
    if (!canon || this.isJunk(canon)) return false;
    if (this.knownKeys.has(canon)) return true;
    if (this.match(canon)) return true;
    return [...this.knownKeys].some(
      (key) =>
        key.length >= 3 && (canon.includes(key) || key.includes(canon)),
    );
  }

  match(name: string): CatalogProduct | null {
    return matchCatalogProduct(canonicalItemName(name) || name, this.products);
  }

  /** Prefer catalog product title when we have a match. */
  displayName(name: string): string {
    const matched = this.match(name);
    if (matched) return matched.name;
    return canonicalItemName(name) || name.trim();
  }

  mentionsKnownItem(text: string): boolean {
    const t = text.trim().toLowerCase();
    if (!t) return false;
    for (const key of this.knownKeys) {
      if (key.length < 3) continue;
      const pattern = new RegExp(
        `\\b${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
        "i",
      );
      if (pattern.test(t)) return true;
    }
    return false;
  }
}
