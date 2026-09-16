import {
  Body,
  Controller,
  Get,
  HttpCode,
  Logger,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  MessageDirection,
  Prisma,
  Channel,
  OrderStatus,
  PaymentStatus,
} from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { WhatsappService } from "../whatsapp/whatsapp.service";
import { WhatsappSignatureGuard } from "./signature.guard";
import { getDeliveryWindow, explainDeliveryTiming, looksLikeDeliveryTimingQuestion } from "./delivery.util";
import { AiService, AiChatResult, OrderDraftItem } from "./ai.service";
import { ConversationService } from "./conversation.service";
import { EmailService } from "../email/email.service";
import { PaystackService } from "../paystack/paystack.service";
import { AddressValidationService } from "./address-validation.service";
import { AdminNotificationService } from "../admins/admin-notification.service";
import { CatalogLookupService } from "./catalog-lookup.service";
import {
  parseBudgetNaira,
  applyBudgetHintsFromMessage,
  extractBudgetItemsFromMessage,
  extractPlainItemNames,
  extractMeasuredItemsFromMessage,
  extractRemovalsFromMessage,
  looksLikeListEdit,
  canonicalItemName,
  MEASURE_UNITS,
} from "./budget.util";
import { matchCatalogProduct } from "./product-match.util";
import {
  findLiveProduct,
  formatNaira,
  priceBoardLine,
  quoteQuantityPrompt,
} from "./live-price.util";
import { generateUniqueReferralCode } from "../common/referral-code.util";
import { randomBytes } from "crypto";

// Deterministic safety net: tool-calling isn't 100% reliable across every
// model, and this is the single highest-stakes moment in the flow (it's what
// actually creates the order). Rather than trust the model to pick
// confirm_order every time, catch the common exact confirmation phrases
// here first — same pattern the MENU/ORDER/HELP keyword routing already uses.
const CONFIRM_PHRASES = new Set([
  "THATS ALL",
  "THAT'S ALL",
  "THAT IS ALL",
  "THATS IT",
  "THAT'S IT",
  "CONFIRM",
  "CONFIRM ORDER",
  "PLACE ORDER",
  "PLACE THE ORDER",
  "GO AHEAD",
  "DONE",
  "COMPLETE ORDER",
  "FINISH ORDER",
  "YES CONFIRM",
  "OK CONFIRM",
  "YES PLEASE CONFIRM",
  "THAT WILL BE ALL",
]);

function normalizeForConfirmCheck(text: string): string {
  return text
    .trim()
    .toUpperCase()
    .replace(/[.,!?'’]/g, "");
}

function looksLikeCancelRequest(text: string): boolean {
  if (!text) return false;
  const t = normalizeForConfirmCheck(text);
  if (!t) return false;
  if (/\b(DONT|DO NOT|NEVER)\b/.test(t) && /\bCANCEL\b/.test(t)) {
    return false;
  }

  const exact = new Set([
    "CANCEL",
    "CANCEL ORDER",
    "CANCEL THE ORDER",
    "CANCEL MY ORDER",
    "CANCEL AM",
    "CANCEL IT",
    "CANCEL THIS",
    "CANCEL THIS ORDER",
    "START OVER",
    "START AGAIN",
    "START FRESH",
    "START AFRESH",
    "START NEW",
    "NEW ORDER",
    "FRESH ORDER",
    "RESET",
    "RESET ORDER",
    "CLEAR",
    "CLEAR CART",
    "CLEAR LIST",
    "CLEAR ORDER",
    "ABORT",
    "NEVERMIND",
    "NEVER MIND",
    "FORGET IT",
    "FORGET AM",
    "SCRATCH THAT",
    "I WAN CANCEL",
    "I WANT TO CANCEL",
    "I WANNA CANCEL",
    "I WAN CANCEL ORDER",
    "I WANT TO CANCEL THE ORDER",
    "CANCEL ABEG",
    "ABEG CANCEL",
    "PLEASE CANCEL",
    "CANCEL PLEASE",
  ]);
  if (exact.has(t)) return true;

  return (
    /^(PLEASE |ABEG )?(CANCEL|STOP) (MY |THE |THIS )?(ORDER|LIST|CART|AM)( ABEG| PLEASE)?$/.test(
      t,
    ) || /^(I )?(WAN|WANT TO|WANNA) (CANCEL|START OVER|START AGAIN)$/.test(t)
  );
}

function looksLikeCartRequest(text: string): boolean {
  const t = text.trim().toLowerCase().replace(/[?.!]/g, "");
  if (/^(my\s+)?(cart|order|orders|list)$/.test(t)) return true;
  if (
    /^(show|see|view|wetin|what's|whats)\b/.test(t) &&
    /\b(cart|order|orders|list)\b/.test(t)
  ) {
    return true;
  }
  return (
    /\b(cart|list|orders?)\b/.test(t) &&
    /\b(see|show|view|wetin|what's|whats|my)\b/.test(t)
  );
}

// ===== Expanded market items list =====
/** Fallback only — live matching prefers CatalogLookupService (DB products). */
const MARKET_ITEMS_FALLBACK = [
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
  "kote",
  "kot",
  "irish potato",
  "sweet potato",
  "fish",
  "chicken",
  "turkey",
  "beef",
  "goat",
  "egg",
  "milk",
  "butter",
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
  "waterleaf",
  "cabbage",
  "carrot",
  "garlic",
  "ginger",
  "thyme",
  "curry",
  "pepper soup",
  "pomo",
  "shaki",
  "roundabout",
  "beef tripe",
  "cow foot",
  "goat head",
  "cocoyam",
  "watermelon",
  "pawpaw",
  "pineapple",
  "banana",
  "orange",
  "apple",
  "grape",
  "mango",
  "avocado",
  "coconut",
  "live chicken",
  "ofada rice",
  "ponmo",
  "bread",
  "bread loaf",
  "semo",
  "semovita",
  "amala",
  "eba",
  "pounded yam flour",
  "tomato paste",
  "dry pepper",
];

/** Words that must never become cart / quantity-prompt items. */
const NEVER_ITEMS = new Set([
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
]);

function normalizeMessage(text: string): string {
  return text.trim().toLowerCase().replace(/\n/g, " ").replace(/\s+/g, " ");
}

function isJunkItemName(name: string): boolean {
  const n = name.trim().toLowerCase().replace(/[’']/g, "");
  return NEVER_ITEMS.has(n) || NEVER_ITEMS.has(name.trim().toLowerCase());
}

type ItemGate = {
  isKnownItem(name: string): boolean;
  mentionsKnownItem(text: string): boolean;
};

function isCatalogItem(name: string, gate?: ItemGate | null): boolean {
  if (gate) return gate.isKnownItem(name);
  const n = canonicalItemName(name).toLowerCase();
  if (!n || isJunkItemName(n)) return false;
  if (MARKET_ITEMS_FALLBACK.some((item) => item === n)) return true;
  return MARKET_ITEMS_FALLBACK.some(
    (item) => item.length >= 3 && (n.includes(item) || item.includes(n)),
  );
}

/**
 * Strip junk / unknown lines out of a draft. Prefers live DB catalog when a
 * gate is provided; otherwise falls back to the static vocabulary list.
 */
function sanitizeDraftItems<T extends { name: string }>(
  items: T[],
  gate?: ItemGate | null,
): T[] {
  return items.filter((item) => isCatalogItem(item.name, gate));
}

/**
 * Customer is asking the bot to change language — never treat this as a list.
 */
function looksLikeLanguagePreference(text: string): "en" | "pidgin" | null {
  if (!text) return null;
  const t = normalizeMessage(text);

  const wantsEnglish =
    /don['’]?t\s+(speak|talk|use|write)\s+pidgin/.test(t) ||
    /do\s+not\s+(speak|talk|use|write)\s+pidgin/.test(t) ||
    /\bno\s+pidgin\b/.test(t) ||
    /\bstop\s+(speaking|talking|using)?\s*pidgin\b/.test(t) ||
    /\bspeak\s+(proper\s+)?english\b/.test(t) ||
    /\benglish\s+please\b/.test(t) ||
    /\bin\s+english\b/.test(t) ||
    /\bnot\s+(in\s+)?pidgin\b/.test(t) ||
    /\buse\s+english\b/.test(t);

  if (wantsEnglish) return "en";

  const wantsPidgin =
    /\bspeak\s+pidgin\b/.test(t) ||
    /\btalk\s+pidgin\b/.test(t) ||
    /\buse\s+pidgin\b/.test(t) ||
    /\bin\s+pidgin\b/.test(t);

  if (wantsPidgin) return "pidgin";

  return null;
}

/** Frustration / instructions about the bot, not groceries. */
function looksLikeMetaOrComplaint(text: string): boolean {
  if (!text) return false;
  if (looksLikeLanguagePreference(text)) return true;
  const t = normalizeMessage(text);
  if (looksLikeRepeatList(text)) return false;
  return (
    /\bhow many times\b/.test(t) ||
    /\bwould i say\b/.test(t) ||
    /\bi (already|keep) (told|said|asked)\b/.test(t) ||
    /\bstop (doing|saying|speaking|talking)\b/.test(t) ||
    /\b(don['’]?t|do not)\s+(speak|talk|use)\s+(pidgin|english)\b/.test(t)
  );
}

function looksLikeRepeatList(text: string): boolean {
  const t = normalizeMessage(text);
  return (
    /\b(i (already )?(sent|gave|dropped|told you)|already sent|i sent (the|my|it))\b/.test(
      t,
    ) && /\b(list|order|items?|foodstuff|it)\b/.test(t)
  );
}

function looksLikeWantsToShop(text: string): boolean {
  const t = normalizeMessage(text);
  return /\b(buy|foodstuffs?|food stuffs?|grocer(?:y|ies)|shopping list|market list|deliver(?:y|ed)?|this evening|this afternoon)\b/.test(
    t,
  );
}

const ENGLISH_GREETING =
  "Hi — welcome to OjaRun. I run market errands in Ibadan. Send your shopping list and I'll quote today's prices as we go, or reply *CANCEL* to start over.";

const LANGUAGE_EN_ACK =
  "Got it — I'll speak English from here on. What would you like to buy?";

const LANGUAGE_PIDGIN_ACK =
  "No wahala — I go talk pidgin from now. Wetin you wan buy?";

const META_ACK = "Understood. How can I help with your market list?";

/**
 * Check if the message is just a greeting (not an order).
 */
function looksLikeGreeting(text: string): boolean {
  if (!text) return false;
  if (looksLikeLanguagePreference(text) || looksLikeMetaOrComplaint(text)) {
    return false;
  }
  const t = text.trim().toLowerCase();
  const greetings = [
    "hello",
    "hi",
    "hey",
    "good morning",
    "good afternoon",
    "good evening",
    "how are you",
    "howdy",
    "yo",
    "sup",
    "what's up",
    "wassup",
    "morning",
    "afternoon",
    "evening",
    "night",
  ];
  const words = t.split(/\s+/);
  if (words.length > 3) return false;
  return greetings.some((g) => t === g || (t.includes(g) && words.length <= 2));
}

/** First message already contains a shopping request — don't bury it under welcome. */
function looksLikeOrderIntent(
  text: string,
  gate?: ItemGate | null,
): boolean {
  if (!text) return false;
  if (looksLikeLanguagePreference(text) || looksLikeMetaOrComplaint(text)) {
    return false;
  }

  const t: string = text.trim().toLowerCase().replace(/\n/g, " ");

  const hasMarketItem = gate
    ? gate.mentionsKnownItem(t)
    : MARKET_ITEMS_FALLBACK.some((item: string) => {
        const pattern = new RegExp(
          `\\b${item.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
          "i",
        );
        return pattern.test(t);
      });
  if (hasMarketItem) return true;
  if (extractMeasuredItemsFromMessage(text).length > 0) return true;
  if (
    looksLikeWantsToShop(text) &&
    /\b(list|foodstuffs?|buy|order|deliver)\b/.test(t) &&
    !/\b(road|street|close|estate|near|behind|ibadan|bodija|soka|agodi|mokola|dugbe|challenge|landmark|area|gate)\b/.test(
      t,
    )
  ) {
    return true;
  }

  const hasNumberWithItem: boolean =
    /\b(\d+)\s*(?:kg|kilo|bag|bottle|pack|cups?|pieces?|tuber|tubers|congo|tray|trays|derica|dirica)\s+\w+/i.test(
      t,
    );
  if (hasNumberWithItem) return true;

  const hasMoneyWithItem: boolean =
    /\b(\w+)\s+\d+[k]?\b/.test(t) || /\b\d+[k]?\s+\w+\b/.test(t);
  if (hasMoneyWithItem && hasMarketItem) return true;

  return (
    /\b(\d+\s*k\b|\d+\s*thousand|naira|₦|\bkg\b|\bbag\b|\bkilo\b|\bkilos\b|\bderica\b|\bdirica\b)\b/.test(
      t,
    ) && hasMarketItem
  );
}

function looksLikePayNowRequest(text: string): boolean {
  const t = text.trim().toLowerCase().replace(/[?.!]/g, "");
  return (
    /^pay\s*now$/.test(t) ||
    /^make\s*payment$/.test(t) ||
    /^payment\s*link$/.test(t) ||
    /^send\s*(me\s*)?(the\s*)?pay(ment)?\s*link$/.test(t) ||
    /^how\s*(do\s*i\s*)?pay$/.test(t)
  );
}

function looksLikeSameAddressRequest(text: string): boolean {
  return /\bsame\s+(address|location|place|delivery)\b/i.test(text);
}

// ===== Improved: Check if message looks like an address =====
function looksLikeAddress(text: string, gate?: ItemGate | null): boolean {
  if (!text) return false;
  const t = text.trim().toLowerCase();

  if (looksLikeLanguagePreference(text) || looksLikeMetaOrComplaint(text)) {
    return false;
  }
  if (looksLikeGreeting(text)) return false;
  if (looksLikeOrderIntent(text, gate)) return false;
  if (extractMeasuredItemsFromMessage(text).length > 0) return false;

  if (t.length < 3) return false;

  const addressKeywords = [
    "road",
    "street",
    "avenue",
    "close",
    "crescent",
    "drive",
    "lane",
    "way",
    "boulevard",
    "estate",
    "village",
    "town",
    "area",
    "junction",
    "roundabout",
    "behind",
    "beside",
    "near",
    "opposite",
    "along",
    "house",
    "flat",
    "apartment",
    "block",
    "plot",
    "gate",
    "compound",
    "quarters",
    "barracks",
    "ibadan",
    "oyo",
    "lagos",
    "abuja",
    "ilorin",
    "osun",
    "ogun",
    "ondo",
    "ekiti",
    "kwara",
    "kogi",
    "niger",
    "kaduna",
    "kano",
    "port harcourt",
    "benin",
    "enugu",
    "owerri",
    "aba",
    "umudike",
    "nsukka",
    "ife",
    "ijebu",
    "bodija",
    "soka",
    "agodi",
    "alaafin",
    "apata",
    "challenge",
    "eleyele",
    "gbagi",
    "jericho",
    "mokola",
    "monatan",
    "ojo",
    "sabo",
    "tanki",
    "uch",
    "ui",
    "university",
    "oyoroad",
    "ringroad",
    "dugbe",
    "oke ado",
    "oke aro",
    "igando",
  ];

  const hasKeyword = addressKeywords.some((keyword) => t.includes(keyword));
  if (hasKeyword) return true;

  if (/^\d+[,\s]/.test(t)) return true;

  const words = t.split(/\s+/);
  if (words.length === 1 && words[0].length >= 3) {
    const commonLocations = [
      "igando",
      "bodija",
      "soka",
      "agodi",
      "alaafin",
      "apata",
      "challenge",
      "eleyele",
      "gbagi",
      "jericho",
      "mokola",
      "monatan",
      "ojo",
      "sabo",
      "tanki",
      "uch",
      "ui",
      "dugbe",
      "ibadan",
      "oyo",
      "lagos",
      "abuja",
      "kano",
      "ilorin",
      "osun",
      "ogun",
      "ondo",
      "ekiti",
      "kwara",
      "kogi",
    ];
    if (commonLocations.some((loc) => t === loc || t.includes(loc))) {
      return true;
    }
  }

  return false;
}

@Controller("webhooks/whatsapp")
export class WebhooksController {
  private readonly logger = new Logger(WebhooksController.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly whatsapp: WhatsappService,
    private readonly ai: AiService,
    private readonly conversations: ConversationService,
    private readonly email: EmailService,
    private readonly paystack: PaystackService,
    private readonly addressValidation: AddressValidationService,
    private readonly adminNotification: AdminNotificationService,
    private readonly catalog: CatalogLookupService,
  ) {}

  private get gate(): ItemGate {
    return this.catalog;
  }

  @Get()
  verify(
    @Query("hub.mode") mode: string,
    @Query("hub.verify_token") token: string,
    @Query("hub.challenge") challenge: string,
  ): string {
    const expected = this.config.get<string>("whatsapp.verifyToken");
    if (mode === "subscribe" && token === expected) {
      this.logger.log("Webhook verified successfully");
      return challenge;
    }
    this.logger.warn("Webhook verification failed: token mismatch");
    return "";
  }

  @Post()
  @HttpCode(200)
  @UseGuards(WhatsappSignatureGuard)
  async receive(@Body() body: any): Promise<{ ok: true }> {
    for (const entry of body?.entry ?? []) {
      for (const change of entry?.changes ?? []) {
        const value = change?.value;
        if (!value) continue;
        for (const msg of value.messages ?? []) {
          try {
            await this.handleInboundMessage(msg, value.contacts ?? []);
          } catch (error) {
            this.logger.error(
              `Failed to process inbound message wamid=${msg?.id}`,
              error as Error,
            );
          }
        }
      }
    }
    return { ok: true };
  }

  private async handleInboundMessage(
    msg: any,
    contacts: Array<{ wa_id: string; profile?: { name?: string } }>,
  ): Promise<void> {
    const wamid: string = msg.id;
    const from: string = msg.from;

    const existing = await this.prisma.message.findUnique({
      where: { whatsappMessageId: wamid },
    });
    if (existing) {
      this.logger.debug(`Skipping duplicate message wamid=${wamid}`);
      return;
    }

    const whatsappNumber = from.startsWith("+") ? from : `+${from}`;
    const profileName = contacts.find((c) => c.wa_id === from)?.profile?.name;

    const existingCustomer = await this.prisma.customer.findUnique({
      where: { whatsappNumber },
    });
    const isNewCustomer = !existingCustomer;

    const customer = await this.prisma.customer.upsert({
      where: { whatsappNumber },
      create: {
        whatsappNumber,
        name: profileName ?? null,
        referralCode: await generateUniqueReferralCode(this.prisma),
      },
      update: profileName ? { name: profileName } : {},
    });

    const conversation = await this.conversations.getOrCreateActive(
      customer.id,
    );
    await this.catalog.ensureFresh();
    const gate = this.catalog;

    const bodyText = msg.type === "text" ? (msg.text?.body ?? null) : null;

    let processedText = bodyText;
    if (msg.type === "interactive") {
      const listReply = msg.interactive?.list_reply;
      const buttonReply = msg.interactive?.button_reply;
      processedText =
        listReply?.id ||
        buttonReply?.id ||
        listReply?.title ||
        buttonReply?.title ||
        null;
    }
    if (bodyText && bodyText.includes("\n")) {
      const lines = bodyText.split("\n").filter((line: string) => line.trim());
      processedText = lines.join(" ");
      this.logger.log(
        `📝 Multi-line message detected (${lines.length} lines): ${processedText}`,
      );
    }

    const threadHistory = processedText
      ? await this.prisma.message.findMany({
          where: { sessionId: conversation.id, body: { not: null } },
          orderBy: { createdAt: "desc" },
          take: 12,
        })
      : [];

    const formattedHistory = threadHistory.reverse().map((m) => ({
      role: (m.direction === MessageDirection.inbound
        ? "user"
        : "assistant") as "user" | "assistant",
      content: m.body!,
    }));

    try {
      await this.prisma.message.create({
        data: {
          customerId: customer.id,
          sessionId: conversation.id,
          whatsappMessageId: wamid,
          direction: MessageDirection.inbound,
          body: processedText,
          raw: msg as Prisma.InputJsonValue,
        },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        this.logger.debug(
          `Caught race-condition duplicate via unique constraint: wamid=${wamid}`,
        );
        return;
      }
      throw error;
    }

    await this.conversations.touch(conversation.id);
    this.logger.log(
      `Inbound [${whatsappNumber}]: ${processedText ?? `[${msg.type}]`}`,
    );

    const handoff = await this.prisma.conversations.findUnique({
      where: { customer_id: customer.id },
      select: { mode: true, assigned_admin_id: true },
    });
    if (handoff?.mode === "human") {
      this.logger.log(
        `Handoff active for ${whatsappNumber} (admin=${handoff.assigned_admin_id ?? "unassigned"}) — skipping bot reply`,
      );
      return;
    }

    if (msg.type === "audio") {
      await this.sendAndLog(
        customer.id,
        conversation.id,
        whatsappNumber,
        `Sorry, I can't listen to voice notes yet. Please type your message. Reply *MENU* for options.`,
      );
      return;
    }

    // Language / "don't speak pidgin" MUST run before quantity collection
    // and before any item extraction. Otherwise "Don't speak pidgin to me…"
    // becomes pending items: Don't, Speak, Pidgin, Me, How.
    if (processedText) {
      const languagePref = looksLikeLanguagePreference(processedText);
      if (languagePref) {
        const junkPending = (
          await this.conversations.getPendingItems(conversation.id)
        ).filter((name) => !gate.isKnownItem(name));
        if (junkPending.length > 0) {
          const kept = (
            await this.conversations.getPendingItems(conversation.id)
          ).filter((name) => gate.isKnownItem(name));
          await this.conversations.setPendingItems(conversation.id, kept);
        }
        // Self-heal: also strip any junk lines that already made it into the
        // draft cart itself (e.g. from before this fix, or any future miss).
        await this.sanitizeStoredDraft(conversation.id);
        await this.sendAndLog(
          customer.id,
          conversation.id,
          whatsappNumber,
          languagePref === "en" ? LANGUAGE_EN_ACK : LANGUAGE_PIDGIN_ACK,
        );
        await this.conversations.touch(conversation.id);
        return;
      }

      if (looksLikeMetaOrComplaint(processedText)) {
        await this.sanitizeStoredDraft(conversation.id);
        await this.sendAndLog(
          customer.id,
          conversation.id,
          whatsappNumber,
          META_ACK,
        );
        await this.conversations.touch(conversation.id);
        return;
      }
    }

    if (processedText && looksLikeCancelRequest(processedText)) {
      await this.handleCancelRequest(
        customer.id,
        conversation.id,
        whatsappNumber,
      );
      return;
    }

    if (!processedText) {
      await this.sendAndLog(
        customer.id,
        conversation.id,
        whatsappNumber,
        `Please type your shopping list as text (e.g. "2 congo rice, 1kg turkey") and I'll quote today's prices.`,
      );
      return;
    }

    if (looksLikeRepeatList(processedText)) {
      await this.replyWithCurrentList(
        customer.id,
        conversation.id,
        whatsappNumber,
        "I have this from you so far:",
      );
      return;
    }

    if (looksLikeDeliveryTimingQuestion(processedText)) {
      const measured = extractMeasuredItemsFromMessage(processedText);
      if (measured.length > 0 || gate.mentionsKnownItem(processedText)) {
        // Timing + list in one message — answer timing, then take the order
        await this.sendAndLog(
          customer.id,
          conversation.id,
          whatsappNumber,
          explainDeliveryTiming(),
        );
        await this.processOrderMessage(
          customer.id,
          conversation.id,
          whatsappNumber,
          processedText,
          formattedHistory,
          customer.contextSummary,
        );
        return;
      }
      await this.sendAndLog(
        customer.id,
        conversation.id,
        whatsappNumber,
        explainDeliveryTiming(),
      );
      return;
    }

    const earlyDraft = await this.getSanitizedDraft(conversation.id);

    if (
      looksLikeWantsToShop(processedText) &&
      extractMeasuredItemsFromMessage(processedText).length === 0 &&
      !gate.mentionsKnownItem(processedText)
    ) {
      await this.sendAndLog(
        customer.id,
        conversation.id,
        whatsappNumber,
        explainDeliveryTiming(),
      );
      return;
    }

    if (processedText && looksLikeOrderIntent(processedText, gate)) {
      await this.processOrderMessage(
        customer.id,
        conversation.id,
        whatsappNumber,
        processedText,
        formattedHistory,
        customer.contextSummary,
      );
      return;
    }

    const pendingItems = (
      await this.conversations.getPendingItems(conversation.id)
    ).filter((name) => gate.isKnownItem(name));
    const rawPending = await this.conversations.getPendingItems(
      conversation.id,
    );
    if (rawPending.length !== pendingItems.length) {
      await this.conversations.setPendingItems(conversation.id, pendingItems);
    }
    if (pendingItems.length > 0 && processedText) {
      const handled = await this.handleQuantityResponse(
        customer.id,
        conversation.id,
        whatsappNumber,
        processedText,
        pendingItems,
      );
      if (handled) {
        await this.conversations.touch(conversation.id);
        return;
      }
    }

    if (processedText && looksLikeGreeting(processedText)) {
      if (earlyDraft.items.length > 0) {
        await this.replyWithCurrentList(
          customer.id,
          conversation.id,
          whatsappNumber,
          "Welcome back — here's your list so far:",
        );
      } else {
        await this.sendAndLog(
          customer.id,
          conversation.id,
          whatsappNumber,
          ENGLISH_GREETING,
        );
      }
      await this.conversations.touch(conversation.id);
      return;
    }

    const draft = earlyDraft;
    const hasItemsButNoAddress =
      draft.items.length > 0 && !draft.deliveryAddress;

    if (
      hasItemsButNoAddress &&
      processedText &&
      looksLikeAddress(processedText, this.catalog) &&
      !looksLikeOrderIntent(processedText, this.catalog)
    ) {
      const result =
        await this.addressValidation.validateAndFormatResponse(processedText);
      if (result.valid && result.validatedAddress) {
        await this.conversations.setDeliveryAddress(
          conversation.id,
          result.validatedAddress.fullAddress,
          {
            formatted: result.validatedAddress.formatted,
            neighborhood: result.validatedAddress.neighborhood,
            landmark: result.validatedAddress.landmark,
          },
        );

        const updatedDraft = await this.getSanitizedDraft(conversation.id);
        const addressInfo = await this.conversations.getDeliveryAddress(
          conversation.id,
        );
        let draftSummary = `Noted! Here's your list so far:\n\n`;
        draftSummary += await this.formatDraftItemLines(updatedDraft.items);
        draftSummary += `\n📍 *Delivery to:* ${addressInfo.formatted || addressInfo.address}`;
        if (addressInfo.neighborhood) {
          draftSummary += `\n📍 *Area:* ${addressInfo.neighborhood}`;
        }
        draftSummary += `\n\nAdd more items anytime, or say *"that's all"* when you're ready to confirm.`;
        await this.sendAndLog(
          customer.id,
          conversation.id,
          whatsappNumber,
          draftSummary,
        );
        await this.conversations.touch(conversation.id);
        return;
      }
    }

    if (processedText && looksLikeAddress(processedText, this.catalog)) {
      const addressHandled = await this.handleAddressInput(
        customer.id,
        conversation.id,
        whatsappNumber,
        processedText,
      );
      if (addressHandled) {
        await this.conversations.touch(conversation.id);
        return;
      }
    }

    const replyKey = this.resolveReplyKey(processedText, isNewCustomer);

    if (replyKey === "order_prompt") {
      await this.prisma.pendingOrder.upsert({
        where: { phone: whatsappNumber },
        create: { phone: whatsappNumber, completed: false },
        update: { startedAt: new Date(), completed: false, remindedAt: null },
      });
    }

    if (replyKey === "default" && processedText) {
      await this.processOrderMessage(
        customer.id,
        conversation.id,
        whatsappNumber,
        processedText,
        formattedHistory,
        customer.contextSummary,
      );
      return;
    }

    const botResponse = await this.prisma.botResponse.findUnique({
      where: { key: replyKey },
    });

    let staticMessageBody =
      botResponse?.body ??
      `Hi — welcome to OjaRun. Send your shopping list and I'll run your market errands in Ibadan.`;

    staticMessageBody = customer.name
      ? staticMessageBody.replace(/\{\{name\}\}/g, customer.name)
      : staticMessageBody.replace(/,?\s*\{\{name\}\}/g, "");

    staticMessageBody = staticMessageBody
      .split("\n")
      .filter((line) => !/\bBROWSE\b/i.test(line))
      .join("\n")
      .replace(/\n{3,}/g, "\n\n");

    if (replyKey === "menu") {
      staticMessageBody =
        `Wetin dey do 🛒\n\n` +
        `🛍️ *ORDER* — start a new market order\n` +
        `❌ *CANCEL* — clear your list and start fresh\n` +
        `📦 Type what you want (e.g. "rice") — I'll quote today's live price\n` +
        `📍 *LOCATION* — see where we dey deliver\n` +
        `❓ *HELP* — how OjaRun works\n\n` +
        `Wetin you wan do today?`;
    }

    if (replyKey === "order_prompt") {
      const { window, day } = getDeliveryWindow();
      staticMessageBody += `\n\n📦 Delivery window for orders now is *${window} ${day}*.`;
    }

    await this.sendAndLog(
      customer.id,
      conversation.id,
      whatsappNumber,
      staticMessageBody,
    );
  }

  private async processOrderMessage(
    customerId: string,
    conversationId: string,
    whatsappNumber: string,
    bodyText: string,
    history: { role: "user" | "assistant"; content: string }[],
    customerContext: string | null,
  ): Promise<void> {
    if (
      looksLikeLanguagePreference(bodyText) ||
      looksLikeMetaOrComplaint(bodyText)
    ) {
      await this.sanitizeStoredDraft(conversationId);
      await this.sendAndLog(
        customerId,
        conversationId,
        whatsappNumber,
        looksLikeLanguagePreference(bodyText) === "pidgin"
          ? LANGUAGE_PIDGIN_ACK
          : LANGUAGE_EN_ACK,
      );
      return;
    }

    const existingDraft = await this.getSanitizedDraft(conversationId);
    const isDeterministicConfirm =
      CONFIRM_PHRASES.has(normalizeForConfirmCheck(bodyText)) &&
      existingDraft.items.length > 0;

    const removals = extractRemovalsFromMessage(bodyText);
    if (
      !isDeterministicConfirm &&
      (removals.length > 0 || looksLikeListEdit(bodyText)) &&
      existingDraft.items.length > 0
    ) {
      const handled = await this.applyListEdits(
        customerId,
        conversationId,
        whatsappNumber,
        bodyText,
        existingDraft.items,
      );
      if (handled) return;
    }

    if (!isDeterministicConfirm && looksLikePayNowRequest(bodyText)) {
      const handled = await this.handlePayNowRequest(
        customerId,
        conversationId,
        whatsappNumber,
      );
      if (handled) return;
    }

    if (!isDeterministicConfirm && looksLikeSameAddressRequest(bodyText)) {
      const lastAddress = await this.getLastDeliveryAddress(customerId);
      if (lastAddress) {
        const validated =
          await this.addressValidation.validateAddress(lastAddress);
        const { items, deliveryAddress } = await this.conversations.mergeDraft(
          conversationId,
          [],
          lastAddress,
        );
        const cleanItems = sanitizeDraftItems(items, this.catalog);

        let draftSummary = `Noted! Here's your list so far:\n\n`;
        if (cleanItems.length === 0) {
          draftSummary += `(No items yet — send what you'd like to buy.)\n`;
        } else {
          draftSummary += await this.formatDraftItemLines(cleanItems);
          draftSummary += `\n`;
        }

        if (validated) {
          draftSummary += `\n📍 *Delivery to:* ${validated.formatted}`;
          if (validated.neighborhood) {
            draftSummary += `\n📍 *Area:* ${validated.neighborhood}`;
          }
        } else {
          draftSummary += `\n📍 *Delivery to:* ${deliveryAddress}`;
        }

        draftSummary += `\n\nAdd more items anytime, or say *"that's all"* when you're ready to confirm.`;
        await this.sendAndLog(
          customerId,
          conversationId,
          whatsappNumber,
          draftSummary,
        );
        return;
      }
    }

    if (!isDeterministicConfirm && looksLikeCartRequest(bodyText)) {
      if (existingDraft.items.length === 0) {
        await this.sendAndLog(
          customerId,
          conversationId,
          whatsappNumber,
          `Your cart is empty — send the items you want and I'll start the list.`,
        );
        return;
      }
      let cartSummary = `Your current order:\n\n`;
      cartSummary += await this.formatDraftItemLines(existingDraft.items);
      cartSummary += existingDraft.deliveryAddress
        ? `\n📍 Delivery to: ${existingDraft.deliveryAddress}`
        : `\n⚠️ Still need your delivery address.`;
      cartSummary += `\n\nChange anything with *"remove turkey"* or *"rice 3 congo"*. Say *"that's all"* when you're ready.`;
      await this.sendAndLog(
        customerId,
        conversationId,
        whatsappNumber,
        cartSummary,
      );
      return;
    }

    const aiResult: AiChatResult | null = isDeterministicConfirm
      ? { type: "confirm_order" }
      : await this.ai.chat(bodyText, history, customerContext);

    const resolved = this.resolveDraftFromAiOrMessage(bodyText, aiResult);

    if (resolved?.type === "draft_update") {
      const catalogItems = resolved.items.filter(
        (item) => !isJunkItemName(item.name),
      );

      const QUANTITY_TOKEN_RE = new RegExp(
        String.raw`\d+\s*(${MEASURE_UNITS})\b|[n₦]\s*\d|\d+\s*(k\b|thousand|hundred|naira|ngn|worth)`,
        "i",
      );

      const realMissingQty = catalogItems.filter(
        (item) =>
          isCatalogItem(item.name, this.catalog) &&
          (item.quantity <= 0 ||
            (item.unit === "pieces" &&
              item.quantity === 1 &&
              !QUANTITY_TOKEN_RE.test(bodyText))),
      );
      const withQty = catalogItems.filter(
        (item) =>
          isCatalogItem(item.name, this.catalog) &&
          !realMissingQty.some(
            (m) => m.name.toLowerCase() === item.name.toLowerCase(),
          ),
      );

      if (withQty.length > 0) {
        await this.conversations.mergeDraft(
          conversationId,
          withQty,
          resolved.deliveryAddress,
        );
      }

      if (realMissingQty.length > 0 && !resolved.deliveryAddress) {
        const itemNames = realMissingQty.map((item) => item.name);
        await this.conversations.setPendingItems(conversationId, itemNames);
        await this.replyWithCurrentList(
          customerId,
          conversationId,
          whatsappNumber,
          `Got it. Today's prices are below — reply with any missing amounts in *one message*.`,
        );
        return;
      }

      if (catalogItems.length > 0) {
        await this.conversations.setPendingItems(conversationId, []);
        const { items, deliveryAddress } = await this.conversations.mergeDraft(
          conversationId,
          catalogItems,
          resolved.deliveryAddress,
        );
        const cleanItems = sanitizeDraftItems(items, this.catalog);

        let draftSummary = `Noted! Here's your list so far:\n\n`;
        if (cleanItems.length === 0) {
          draftSummary += `(No items yet — send what you'd like to buy.)\n`;
        } else {
          draftSummary += await this.formatDraftItemLines(cleanItems);
          draftSummary += `\n`;
        }

        const addressInfo =
          await this.conversations.getDeliveryAddress(conversationId);
        if (addressInfo.address) {
          if (addressInfo.formatted) {
            draftSummary += `\n📍 *Delivery to:* ${addressInfo.formatted}`;
          } else {
            draftSummary += `\n📍 *Delivery to:* ${addressInfo.address}`;
          }
          if (addressInfo.neighborhood) {
            draftSummary += `\n📍 *Area:* ${addressInfo.neighborhood}`;
          }
        } else if (deliveryAddress) {
          draftSummary += `\n📍 *Delivery to:* ${deliveryAddress}`;
        } else {
          draftSummary += `\n⚠️ Still need your delivery address — just drop it whenever you're ready.`;
        }

        draftSummary += `\n\nChange anything with *"remove turkey"* or *"rice 3 congo"*. Say *"that's all"* when you're ready to confirm.`;

        await this.sendAndLog(
          customerId,
          conversationId,
          whatsappNumber,
          draftSummary,
        );
        return;
      }

      if (resolved.items.length > 0 && catalogItems.length === 0) {
        await this.sendAndLog(
          customerId,
          conversationId,
          whatsappNumber,
          META_ACK,
        );
        return;
      }
    }

    if (resolved?.type === "confirm_order") {
      await this.confirmOrder(customerId, conversationId, whatsappNumber);
      return;
    }

    if (resolved?.type === "text") {
      if (
        /<function[=/(]|update_order_items\s*\)?\s*\(?\s*\{|confirm_order\s*\(/i.test(
          resolved.content,
        )
      ) {
        this.logger.warn(
          `Suppressed outbound tool-syntax leak: ${resolved.content.slice(0, 160)}`,
        );
        return;
      }
      await this.sendAndLog(
        customerId,
        conversationId,
        whatsappNumber,
        resolved.content,
      );
      return;
    }
  }

  private async confirmOrder(
    customerId: string,
    conversationId: string,
    whatsappNumber: string,
  ): Promise<void> {
    // Always read the sanitized draft here — this is the point where an
    // order is actually created, so junk line items (from a mis-parsed
    // complaint/language message, past or future) must never reach checkout.
    const draft = await this.getSanitizedDraft(conversationId);
    const addressInfo =
      await this.conversations.getDeliveryAddress(conversationId);

    if (draft.items.length === 0) {
      await this.sendAndLog(
        customerId,
        conversationId,
        whatsappNumber,
        `You haven't told me what you'd like to buy yet — send your list and we'll start.`,
      );
      return;
    }

    if (!draft.deliveryAddress && !addressInfo.address) {
      await this.sendAndLog(
        customerId,
        conversationId,
        whatsappNumber,
        `Almost there! 📍 I still need your delivery address before I can place this order — just drop it and say *"that's all"* again to confirm.`,
      );
      return;
    }

    const finalAddress =
      addressInfo.formatted || addressInfo.address || draft.deliveryAddress;

    const pricedItems = await this.priceDraftItems(draft.items);
    const totalNaira = pricedItems.reduce(
      (sum, item) => sum + item.lineTotal,
      0,
    );
    const allPriced = pricedItems.every((item) => item.unitPrice > 0);
    const paystackRef = `oja_${randomBytes(8).toString("hex")}`;

    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
      select: { name: true, whatsappNumber: true },
    });

    const createdOrder = await this.prisma.$transaction(async (tx) => {
      await tx.pendingOrder.updateMany({
        where: { phone: whatsappNumber, completed: false },
        data: { completed: true },
      });

      const order = await tx.order.create({
        data: {
          customerId: customerId,
          channel: Channel.whatsapp,
          status: OrderStatus.pending,
          paymentStatus: PaymentStatus.unpaid,
          total: new Prisma.Decimal(totalNaira.toFixed(2)),
          customerNotes: finalAddress,
          paystackReference: paystackRef,
        },
      });

      for (const item of pricedItems) {
        await tx.orderItem.create({
          data: {
            orderId: order.id,
            productId: item.productId,
            productNameSnapshot: item.name,
            unitSnapshot: item.unit,
            unitPriceSnapshot: new Prisma.Decimal(item.unitPrice.toFixed(2)),
            quantity: new Prisma.Decimal(item.quantity),
          },
        });
      }

      return order;
    });

    try {
      await this.adminNotification.notifyAdminsOfNewOrder(
        {
          ...createdOrder,
          customer: {
            name: customer?.name ?? null,
            whatsappNumber: customer?.whatsappNumber ?? whatsappNumber,
          },
        },
        pricedItems,
        whatsappNumber,
      );
    } catch (error) {
      this.logger.error("Admin notification failed", error);
    }

    await this.conversations.clearDraft(conversationId);
    await this.conversations.clearPendingItems(conversationId);
    await this.conversations.closeSession(conversationId);

    this.conversations
      .summarizeSession(conversationId)
      .catch((err) =>
        this.logger.error(
          `Immediate summarization failed for session ${conversationId}`,
          err,
        ),
      );

    this.logger.log(`Order processed transactionally for ${whatsappNumber}`);

    try {
      await this.email.sendNewOrderNotification({
        orderId: createdOrder.id,
        customerName: customer?.name ?? null,
        whatsappNumber: whatsappNumber,
        items: draft.items.map((item) => ({
          name: item.name,
          quantity: item.quantity,
          unit: item.unit,
        })),
        deliveryAddress: finalAddress ?? null,
        createdAt: createdOrder.createdAt,
      });
    } catch (emailError) {
      this.logger.error(
        `Failed to send order notification email for order ${createdOrder.id}`,
        emailError,
      );
    }

    const { window, day } = getDeliveryWindow();
    let customerInvoiceReceipt = `All set. I have compiled your OjaRun market order list:\n\n`;
    pricedItems.forEach((item) => {
      const priceBit =
        item.unitPrice > 0
          ? ` — ₦${item.lineTotal.toLocaleString("en-NG")}`
          : "";
      customerInvoiceReceipt += `🔸 *${item.name}* — ${item.quantity} ${item.unit}${priceBit}\n`;
    });
    customerInvoiceReceipt += `\n📍 *Delivery to:* ${finalAddress}`;
    if (addressInfo.neighborhood) {
      customerInvoiceReceipt += `\n📍 *Area:* ${addressInfo.neighborhood}`;
    }
    customerInvoiceReceipt += `\n🚴 *Delivery Schedule:* ${window} ${day}`;

    if (allPriced && totalNaira >= 1) {
      customerInvoiceReceipt += `\n\n💰 *Subtotal:* ₦${totalNaira.toLocaleString("en-NG")}`;

      if (!this.paystack.isConfigured()) {
        this.logger.warn(
          `Order ${createdOrder.id} priced (₦${totalNaira}) but Paystack keys are missing`,
        );
        customerInvoiceReceipt += `\n\nOrder received — a payment link will follow shortly.`;
      } else {
        const webAppUrl = this.config.get<string>("webAppUrl") || "";
        const callbackUrl = webAppUrl
          ? `${webAppUrl.replace(/\/$/, "")}/payment/callback`
          : undefined;
        const payEmail = `${whatsappNumber.replace(/\D/g, "")}@whatsapp.ojarun.ng`;

        const payment = await this.paystack.initializeTransaction({
          email: payEmail,
          amountNaira: totalNaira,
          reference: paystackRef,
          callbackUrl,
          metadata: {
            orderId: createdOrder.id,
            channel: "whatsapp",
            customerId: customerId,
          },
        });

        if (payment.ok && payment.authorizationUrl) {
          await this.prisma.order.update({
            where: { id: createdOrder.id },
            data: {
              status: OrderStatus.awaiting_payment,
              paymentStatus: PaymentStatus.pending,
              paymentUrl: payment.authorizationUrl,
            },
          });

          customerInvoiceReceipt += `\n\nTap *Pay now* to complete checkout. Once payment clears, our market shoppers start shopping.`;

          await this.sendPaymentAndLog(
            customerId,
            conversationId,
            whatsappNumber,
            customerInvoiceReceipt,
            payment.authorizationUrl,
          );
          return;
        }

        this.logger.error(
          `Paystack init failed for order ${createdOrder.id}: ${payment.error}`,
        );
        customerInvoiceReceipt += `\n\nThe payment link didn't open just now — our team will send it shortly.`;
      }
    } else {
      const unpriced = pricedItems
        .filter((i) => i.unitPrice <= 0)
        .map((i) => i.name);
      this.logger.warn(
        `Order ${createdOrder.id}: no payment link — allPriced=${allPriced} total=₦${totalNaira} paystack=${this.paystack.isConfigured()} unpriced=[${unpriced.join(", ")}]`,
      );
      customerInvoiceReceipt += `\n\nOur market shoppers are handling it. We will send over your subtotal breakdown once pricing finishes.`;
    }

    await this.sendAndLog(
      customerId,
      conversationId,
      whatsappNumber,
      customerInvoiceReceipt,
    );
  }

  private async handleAddressInput(
    customerId: string,
    conversationId: string,
    whatsappNumber: string,
    bodyText: string,
  ): Promise<boolean> {
    const result =
      await this.addressValidation.validateAndFormatResponse(bodyText);

    if (!result.valid) {
      await this.sendAndLog(
        customerId,
        conversationId,
        whatsappNumber,
        result.message,
      );
      return true;
    }

    if (result.validatedAddress) {
      await this.conversations.setDeliveryAddress(
        conversationId,
        result.validatedAddress.fullAddress,
        {
          formatted: result.validatedAddress.formatted,
          neighborhood: result.validatedAddress.neighborhood,
          landmark: result.validatedAddress.landmark,
        },
      );

      const draft = await this.getSanitizedDraft(conversationId);
      const addressInfo =
        await this.conversations.getDeliveryAddress(conversationId);

      let draftSummary = `Noted! Here's your list so far:\n\n`;

      if (draft.items.length === 0) {
        draftSummary += `(No items yet — send what you'd like to buy.)\n`;
      } else {
        draftSummary += await this.formatDraftItemLines(draft.items);
        draftSummary += `\n`;
      }

      draftSummary += `\n📍 *Delivery to:* ${addressInfo.formatted || addressInfo.address}`;

      if (addressInfo.neighborhood) {
        draftSummary += `\n📍 *Area:* ${addressInfo.neighborhood}`;
      }

      draftSummary += `\n\nAdd more items anytime, or say *"that's all"* when you're ready to confirm.`;

      await this.sendAndLog(
        customerId,
        conversationId,
        whatsappNumber,
        draftSummary,
      );
      return true;
    }

    return false;
  }

  private async handleQuantityResponse(
    customerId: string,
    conversationId: string,
    whatsappNumber: string,
    bodyText: string,
    pendingItems: string[],
  ): Promise<boolean> {
    const catalogPending = pendingItems.filter((name) =>
      isCatalogItem(name, this.catalog),
    );
    if (catalogPending.length === 0) {
      await this.conversations.setPendingItems(conversationId, []);
      return false;
    }

    const removals = extractRemovalsFromMessage(bodyText);
    const measured = extractMeasuredItemsFromMessage(bodyText).filter((item) =>
      isCatalogItem(item.name, this.catalog),
    );

    if (removals.length > 0 || measured.length > 0) {
      const draft = await this.getSanitizedDraft(conversationId);
      const updates: OrderDraftItem[] = [
        ...removals.map((name) => {
          const match = draft.items.find(
            (item) =>
              canonicalItemName(item.name).toLowerCase() ===
                canonicalItemName(name).toLowerCase() ||
              item.name.toLowerCase().includes(name.toLowerCase()) ||
              name.toLowerCase().includes(item.name.toLowerCase()),
          );
          return {
            name: match?.name || canonicalItemName(name),
            quantity: 0,
            unit: "pieces",
          };
        }),
        ...measured,
      ];
      await this.conversations.mergeDraft(conversationId, updates, null);
      const stillPending = catalogPending.filter(
        (name) =>
          !measured.some(
            (item) =>
              canonicalItemName(item.name).toLowerCase() ===
                canonicalItemName(name).toLowerCase() ||
              item.name.toLowerCase().includes(name.toLowerCase()),
          ) &&
          !removals.some((removed) =>
            name.toLowerCase().includes(removed.toLowerCase()),
          ),
      );
      await this.conversations.setPendingItems(conversationId, stillPending);
      await this.replyWithCurrentList(
        customerId,
        conversationId,
        whatsappNumber,
        stillPending.length
          ? `Updated. I still need quantity for: *${stillPending.join(", ")}*.`
          : "Updated — here's the list with today's prices:",
      );
      return true;
    }

    const quantity = this.conversations.parseQuantity(bodyText);
    if (quantity && catalogPending.length === 1) {
      await this.conversations.mergeDraft(
        conversationId,
        [
          {
            name: catalogPending[0],
            quantity: quantity.value,
            unit: quantity.unit,
          },
        ],
        null,
      );
      await this.conversations.setPendingItems(conversationId, []);
      await this.replyWithCurrentList(
        customerId,
        conversationId,
        whatsappNumber,
        "Updated — here's the list with today's prices:",
      );
      return true;
    }

    await this.replyWithCurrentList(
      customerId,
      conversationId,
      whatsappNumber,
      catalogPending.length > 1
        ? `Please send the remaining amounts together, e.g. "pepper N2000, turkey 1kg". You can also *"remove turkey"*.`
        : `Sorry, I didn't catch that � see today's price below and reply with the amount.`,
    );
    return true;
  }

  /**
   * Prefer structured AI draft updates, but always correct Nigerian "2k" money
   * shorthand and fall back to deterministic parsing when the model fails.
   */
  private resolveDraftFromAiOrMessage(
    bodyText: string,
    aiResult: AiChatResult | null,
  ): AiChatResult | null {
    if (
      looksLikeLanguagePreference(bodyText) ||
      looksLikeMetaOrComplaint(bodyText)
    ) {
      return {
        type: "text",
        content:
          looksLikeLanguagePreference(bodyText) === "pidgin"
            ? LANGUAGE_PIDGIN_ACK
            : LANGUAGE_EN_ACK,
      };
    }

    const fromMessage = extractBudgetItemsFromMessage(bodyText).filter(
      (item) => !isJunkItemName(item.name),
    );
    const measured = extractMeasuredItemsFromMessage(bodyText)
      .filter((item) => isCatalogItem(item.name, this.catalog))
      .map((item) => ({
        ...item,
        name: this.catalog.displayName(item.name),
      }));

    if (aiResult?.type === "draft_update") {
      const corrected = applyBudgetHintsFromMessage(
        bodyText,
        aiResult.items,
      ).filter((item) => !isJunkItemName(item.name));
      const byName = new Map(
        corrected.map((item) => {
          const name = this.catalog.displayName(item.name);
          return [name.toLowerCase(), { ...item, name }];
        }),
      );
      for (const item of [...fromMessage, ...measured]) {
        const name = this.catalog.displayName(item.name);
        const key = name.toLowerCase();
        const incoming = { ...item, name };
        const existing = byName.get(key);
        if (!existing) {
          byName.set(key, incoming);
          continue;
        }
        const measuredWins =
          incoming.quantity > 1 ||
          (incoming.unit && incoming.unit !== "pieces");
        if (measuredWins) byName.set(key, incoming);
      }
      return {
        type: "draft_update",
        items: [...byName.values()],
        deliveryAddress: aiResult.deliveryAddress,
      };
    }

    if (aiResult?.type === "confirm_order") {
      return aiResult;
    }

    if (measured.length > 0) {
      return {
        type: "draft_update",
        items: measured,
        deliveryAddress: null,
      };
    }

    if (fromMessage.length > 0) {
      this.logger.warn(
        `AI miss on "${bodyText.slice(0, 80)}" — recovered ${fromMessage.length} budget item(s) from message`,
      );
      return {
        type: "draft_update",
        items: fromMessage,
        deliveryAddress: null,
      };
    }

    if (looksLikeGreeting(bodyText) || looksLikeLanguagePreference(bodyText)) {
      return null;
    }

    const plainItems = extractPlainItemNames(bodyText).filter(
      (name) => isCatalogItem(name, this.catalog) && !isJunkItemName(name),
    );
    if (plainItems.length > 0) {
      this.logger.warn(
        `No budget items found, extracted ${plainItems.length} plain item(s) from message: ${plainItems.join(", ")}`,
      );
      const draftItems = plainItems.map((name) => ({
        name: name.charAt(0).toUpperCase() + name.slice(1),
        quantity: 1,
        unit: "pieces",
      }));
      return {
        type: "draft_update",
        items: draftItems,
        deliveryAddress: null,
      };
    }

    return aiResult;
  }

  /**
   * Read the current draft and strip out any non-catalog / junk items
   * before it's shown to the customer or used for pricing. This is the
   * main defensive read path — use this instead of a bare
   * `this.conversations.getDraft(...)` anywhere the draft's item list is
   * displayed, priced, or persisted onward.
   */
  private async getSanitizedDraft(
    conversationId: string,
  ): Promise<{ items: OrderDraftItem[]; deliveryAddress: string | null }> {
    const draft = await this.conversations.getDraft(conversationId);
    return {
      ...draft,
      items: sanitizeDraftItems(draft.items, this.catalog),
    };
  }

  /**
   * Self-healing cleanup: if a draft has accumulated junk line items (e.g.
   * from before this fix, or from any future extraction bug), strip them
   * and persist the corrected item list back to storage so the customer's
   * cart is clean going forward, not just clean when displayed.
   */
  private async sanitizeStoredDraft(conversationId: string): Promise<void> {
    const draft = await this.conversations.getDraft(conversationId);
    const cleanItems = sanitizeDraftItems(draft.items, this.catalog);
    if (cleanItems.length === draft.items.length) {
      return; // nothing to clean
    }
    const removed = draft.items
      .filter((item) => !isCatalogItem(item.name, this.catalog))
      .map((item) => item.name);
    this.logger.warn(
      `Sanitizing draft for session ${conversationId} — removing junk item(s): ${removed.join(", ")}`,
    );
    await this.conversations.clearDraft(conversationId);
    if (cleanItems.length > 0 || draft.deliveryAddress) {
      await this.conversations.mergeDraft(
        conversationId,
        cleanItems,
        draft.deliveryAddress ?? null,
      );
    }
  }

  /**
   * Price draft lines from catalog OR customer budget wording
   */
  private async priceDraftItems(
    items: { name: string; quantity: number; unit: string }[],
  ): Promise<
    {
      name: string;
      quantity: number;
      unit: string;
      productId: string | null;
      unitPrice: number;
      lineTotal: number;
    }[]
  > {
    const products = await this.loadAvailableProducts();

    return items.map((item) => {
      const match =
        this.catalog.match(item.name) ||
        matchCatalogProduct(item.name, products);
      const quantity = Number(item.quantity) || 0;
      const budget = parseBudgetNaira(item.unit, item.name);

      if (budget != null) {
        return {
          name: match?.name ?? this.catalog.displayName(item.name),
          quantity: quantity > 0 ? quantity : 1,
          unit: item.unit,
          productId: match?.id ?? null,
          unitPrice: budget,
          lineTotal: budget,
        };
      }

      const unitPrice = match ? Number(match.currentPrice) : 0;
      return {
        name: match?.name ?? this.catalog.displayName(item.name),
        quantity,
        unit: match?.unit || item.unit,
        productId: match?.id ?? null,
        unitPrice,
        lineTotal: unitPrice * quantity,
      };
    });
  }

  private async getLastDeliveryAddress(
    customerId: string,
  ): Promise<string | null> {
    const last = await this.prisma.order.findFirst({
      where: { customerId, customerNotes: { not: null } },
      orderBy: { createdAt: "desc" },
      select: { customerNotes: true },
    });
    const addr = last?.customerNotes?.trim();
    return addr || null;
  }

  /** Resend Paystack link for the customer's latest unpaid order. */
  private async handlePayNowRequest(
    customerId: string,
    conversationId: string,
    whatsappNumber: string,
  ): Promise<boolean> {
    const order = await this.prisma.order.findFirst({
      where: {
        customerId,
        paymentStatus: { in: [PaymentStatus.unpaid, PaymentStatus.pending] },
        status: { in: [OrderStatus.pending, OrderStatus.awaiting_payment] },
      },
      orderBy: { createdAt: "desc" },
      include: { items: true },
    });

    if (!order) {
      await this.sendAndLog(
        customerId,
        conversationId,
        whatsappNumber,
        `I don't see any open order waiting for payment — send a fresh list, or check if you already paid.`,
      );
      return true;
    }

    const totalNaira = Number(order.total);
    let paymentUrl = order.paymentUrl;
    let displayTotal = totalNaira;

    if (totalNaira < 1 || !paymentUrl) {
      const repriced = await this.repriceOrderItems(order.id, order.items);
      displayTotal = repriced.total;
      if (
        displayTotal >= 1 &&
        this.paystack.isConfigured() &&
        order.paystackReference
      ) {
        const payEmail = `${whatsappNumber.replace(/\D/g, "")}@whatsapp.ojarun.ng`;
        const webAppUrl = this.config.get<string>("webAppUrl") || "";
        let reference = order.paystackReference;
        let payment = await this.paystack.initializeTransaction({
          email: payEmail,
          amountNaira: displayTotal,
          reference,
          callbackUrl: webAppUrl
            ? `${webAppUrl.replace(/\/$/, "")}/payment/callback`
            : undefined,
          metadata: { orderId: order.id, channel: "whatsapp", customerId },
        });
        if (!payment.ok && /reference/i.test(payment.error || "")) {
          reference = `oja_${randomBytes(8).toString("hex")}`;
          payment = await this.paystack.initializeTransaction({
            email: payEmail,
            amountNaira: displayTotal,
            reference,
            callbackUrl: webAppUrl
              ? `${webAppUrl.replace(/\/$/, "")}/payment/callback`
              : undefined,
            metadata: { orderId: order.id, channel: "whatsapp", customerId },
          });
        }
        if (payment.ok && payment.authorizationUrl) {
          paymentUrl = payment.authorizationUrl;
          await this.prisma.order.update({
            where: { id: order.id },
            data: {
              total: new Prisma.Decimal(displayTotal.toFixed(2)),
              status: OrderStatus.awaiting_payment,
              paymentStatus: PaymentStatus.pending,
              paymentUrl,
              paystackReference: reference,
            },
          });
        }
      }

      if (!paymentUrl) {
        await this.sendAndLog(
          customerId,
          conversationId,
          whatsappNumber,
          `Your order *${order.id.slice(0, 8).toUpperCase()}* is still waiting for pricing.\n\nAdd *Titus* (and other items) with prices in admin, or the customer can send budget amounts like "titus 5k".`,
        );
        return true;
      }
    }

    let body = `Here's your payment link again 💳\n\n`;
    order.items.forEach((item) => {
      body += `🔸 *${item.productNameSnapshot}* — ${item.quantity} ${item.unitSnapshot}\n`;
    });
    if (order.customerNotes) {
      body += `\n📍 *Delivery to:* ${order.customerNotes}`;
    }
    body += `\n\n💰 *Total:* ₦${displayTotal.toLocaleString("en-NG")}`;
    body += `\n\nTap *Pay now* below to complete checkout.`;

    await this.sendPaymentAndLog(
      customerId,
      conversationId,
      whatsappNumber,
      body,
      paymentUrl!,
    );
    return true;
  }

  /** Re-price order line items from catalog */
  private async repriceOrderItems(
    orderId: string,
    items: Array<{
      id: string;
      productNameSnapshot: string;
      unitSnapshot: string;
      quantity: { toString(): string };
      unitPriceSnapshot: { toString(): string };
    }>,
  ): Promise<{ total: number; allPriced: boolean }> {
    const priced = await this.priceDraftItems(
      items.map((i) => ({
        name: i.productNameSnapshot,
        quantity: Number(i.quantity),
        unit: i.unitSnapshot,
      })),
    );

    let total = 0;
    let allPriced = true;
    for (let i = 0; i < items.length; i++) {
      const line = priced[i];
      if (line.unitPrice <= 0) allPriced = false;
      total += line.lineTotal;
      if (line.unitPrice > 0) {
        await this.prisma.orderItem.update({
          where: { id: items[i].id },
          data: {
            unitPriceSnapshot: new Prisma.Decimal(line.unitPrice.toFixed(2)),
            productId: line.productId,
          },
        });
      }
    }

    if (allPriced && total >= 1) {
      await this.prisma.order.update({
        where: { id: orderId },
        data: { total: new Prisma.Decimal(total.toFixed(2)) },
      });
    }

    return { total, allPriced };
  }

  private async sendAndLog(
    customerId: string,
    conversationId: string,
    whatsappNumber: string,
    body: string,
  ): Promise<void> {
    try {
      const sentPayload = await this.whatsapp.sendText(whatsappNumber, body);
      await this.prisma.message.create({
        data: {
          customerId,
          sessionId: conversationId,
          whatsappMessageId: sentPayload.wamid!,
          direction: MessageDirection.outbound,
          body,
          raw: { sentPayload } as Prisma.InputJsonValue,
        },
      });
      await this.conversations.touch(conversationId);
    } catch (error) {
      this.logger.error(
        `Failed to send/log outbound message to ${whatsappNumber}`,
        error as Error,
      );
    }
  }

  private async sendPaymentAndLog(
    customerId: string,
    conversationId: string,
    whatsappNumber: string,
    body: string,
    paymentUrl: string,
  ): Promise<void> {
    try {
      const sentPayload = await this.whatsapp.sendPaymentLink(
        whatsappNumber,
        body,
        paymentUrl,
        "Pay now",
      );
      await this.prisma.message.create({
        data: {
          customerId,
          sessionId: conversationId,
          whatsappMessageId: sentPayload.wamid!,
          direction: MessageDirection.outbound,
          body: `${body}\n\n${paymentUrl}`,
          raw: { sentPayload, paymentUrl } as Prisma.InputJsonValue,
        },
      });
      await this.conversations.touch(conversationId);
    } catch (error) {
      this.logger.error(
        `Failed to send/log payment link to ${whatsappNumber}`,
        error as Error,
      );
    }
  }

  private resolveReplyKey(body: string | null, isNewCustomer: boolean): string {
    if (!body) {
      if (isNewCustomer) return "welcome";
      return "default";
    }

    if (looksLikeLanguagePreference(body) || looksLikeMetaOrComplaint(body)) {
      return "default";
    }

    const text = body.trim().toUpperCase();

    if (looksLikeOrderIntent(body, this.catalog)) {
      return "default";
    }

    if (isNewCustomer) {
      return "welcome";
    }

    if (text === "MENU" || text.includes("WETIN DEY")) return "menu";
    if (text === "ORDER" || text === "I WANT TO BUY" || text === "I WAN BUY")
      return "order_prompt";
    if (text === "HELP") return "help";
    if (text.includes("LOCATION") || text.includes("IBADAN")) return "location";
    if (
      text.includes("PRICE") ||
      text.includes("HOW MUCH") ||
      text.includes("₦")
    )
      return "pricing";

    return "default";
  }

  private async handleCancelRequest(
    customerId: string,
    conversationId: string,
    whatsappNumber: string,
  ): Promise<void> {
    const draft = await this.getSanitizedDraft(conversationId);
    const pendingCount = (
      await this.conversations.getPendingItems(conversationId)
    ).length;
    const hadDraft = draft.items.length > 0 || pendingCount > 0 || !!draft.deliveryAddress;

    const unpaidOrders = await this.prisma.order.findMany({
      where: {
        customerId,
        paymentStatus: { in: [PaymentStatus.unpaid, PaymentStatus.pending] },
        status: { in: [OrderStatus.pending, OrderStatus.awaiting_payment] },
      },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });

    const inProgress = await this.prisma.order.findFirst({
      where: {
        customerId,
        status: {
          in: [
            OrderStatus.confirmed,
            OrderStatus.shopping,
            OrderStatus.purchased,
            OrderStatus.dispatched,
          ],
        },
      },
      orderBy: { createdAt: "desc" },
      select: { id: true, status: true },
    });

    await this.conversations.resetConversationState(conversationId);
    await this.prisma.pendingOrder.updateMany({
      where: { phone: whatsappNumber, completed: false },
      data: { completed: true },
    });

    const cancelledIds: string[] = [];
    for (const order of unpaidOrders) {
      await this.prisma.order.update({
        where: { id: order.id },
        data: {
          status: OrderStatus.cancelled,
          cancelReason: "Cancelled by customer on WhatsApp",
        },
      });
      cancelledIds.push(order.id.slice(0, 8).toUpperCase());
    }

    await this.conversations.closeSession(conversationId);

    let body = "";
    if (cancelledIds.length > 0) {
      body =
        cancelledIds.length === 1
          ? `Done — I cancelled order *${cancelledIds[0]}* and cleared your list.`
          : `Done — I cancelled orders *${cancelledIds.join(", ")}* and cleared your list.`;
    } else if (hadDraft) {
      body = `Done — I cleared your list so you can start fresh.`;
    } else {
      body = `Nothing to cancel — no open list or unpaid order.`;
    }

    body += `\n\nSend a new shopping list whenever you're ready.`;

    if (inProgress) {
      body += `\n\n⚠️ Order *${inProgress.id.slice(0, 8).toUpperCase()}* is already being processed, so that one stays. Message us if you need help with it.`;
    }

    await this.sendAndLog(
      customerId,
      conversationId,
      whatsappNumber,
      body,
    );
  }

  private async loadAvailableProducts() {
    await this.catalog.ensureFresh();
    const cached = this.catalog.getProducts();
    if (cached.length > 0) return cached;
    return this.prisma.product.findMany({
      where: { isAvailable: true },
      select: { id: true, name: true, unit: true, currentPrice: true },
    });
  }

  private async quantityPromptFor(itemName: string): Promise<string> {
    const products = await this.loadAvailableProducts();
    return quoteQuantityPrompt(itemName, findLiveProduct(itemName, products));
  }

  /** Compact live-price board for every pending item — one block, not one chat each. */
  private async formatPendingPriceBoard(pendingNames: string[]): Promise<string> {
    if (pendingNames.length === 0) return "";
    const products = await this.loadAvailableProducts();
    const lines = pendingNames.map((name) =>
      priceBoardLine(name, findLiveProduct(name, products)),
    );
    const example =
      pendingNames.length === 1
        ? `Reply with how much, e.g. "${pendingNames[0]} N2000" or "${pendingNames[0]} 1 kg".`
        : `Reply with *all remaining amounts in one message*, e.g. "pepper N2000, turkey 1kg".`;
    return `💰 *Today's prices*\n${lines.join("\n")}\n\n${example}`;
  }

  private async formatDraftItemLines(
    items: { name: string; quantity: number; unit: string }[],
  ): Promise<string> {
    if (items.length === 0) return "";
    const priced = await this.priceDraftItems(items);
    return priced
      .map((item) => {
        const line = `🔸 *${item.name}* — ${item.quantity} ${item.unit}`;
        return item.unitPrice > 0
          ? `${line} — ${formatNaira(item.lineTotal)}`
          : line;
      })
      .join("\n");
  }

  private async replyWithCurrentList(
    customerId: string,
    conversationId: string,
    whatsappNumber: string,
    intro: string,
  ): Promise<void> {
    const draft = await this.getSanitizedDraft(conversationId);
    const pending = (
      await this.conversations.getPendingItems(conversationId)
    ).filter((name) => this.catalog.isKnownItem(name));
    const addressInfo =
      await this.conversations.getDeliveryAddress(conversationId);

    if (draft.items.length === 0 && pending.length === 0) {
      await this.sendAndLog(
        customerId,
        conversationId,
        whatsappNumber,
        `I don't have a list yet. Please send everything in one message, e.g. "2 congo rice, 2 congo beans, 1kg turkey".`,
      );
      return;
    }

    let body = `${intro}\n\n`;
    if (draft.items.length > 0) {
      body += await this.formatDraftItemLines(draft.items);
      body += "\n";
    }

    if (pending.length > 0) {
      body += `\n${await this.formatPendingPriceBoard(pending)}`;
    }

    if (addressInfo.address) {
      body += `\n\n📍 *Delivery to:* ${addressInfo.formatted || addressInfo.address}`;
    } else {
      body += `\n\n📍 Send your area/landmark when you're ready (e.g. "Bodija, near UI gate").`;
    }

    body += `\n\nChange anything with *"remove turkey"* or *"pepper N2000"*. Say *"that's all"* when the list is right.`;

    await this.sendAndLog(customerId, conversationId, whatsappNumber, body);
  }

  private async applyListEdits(
    customerId: string,
    conversationId: string,
    whatsappNumber: string,
    bodyText: string,
    currentItems: OrderDraftItem[],
  ): Promise<boolean> {
    const removals = extractRemovalsFromMessage(bodyText);
    const measured = extractMeasuredItemsFromMessage(bodyText).filter((item) =>
      isCatalogItem(item.name, this.catalog),
    );
    if (removals.length === 0 && measured.length === 0) return false;

    const updates: OrderDraftItem[] = [
      ...removals.map((name) => {
        const match = currentItems.find(
          (item) =>
            canonicalItemName(item.name).toLowerCase() ===
              canonicalItemName(name).toLowerCase() ||
            item.name.toLowerCase().includes(name.toLowerCase()) ||
            name.toLowerCase().includes(item.name.toLowerCase()),
        );
        return {
          name: match?.name || canonicalItemName(name),
          quantity: 0,
          unit: "pieces",
        };
      }),
      ...measured,
    ];
    await this.conversations.mergeDraft(conversationId, updates, null);
    await this.replyWithCurrentList(
      customerId,
      conversationId,
      whatsappNumber,
      "Updated — here's the list with today's prices:",
    );
    return true;
  }
}
