# Ojarun delivery pricing (pin-first)

Developer handoff for the current delivery system across **backend** (`ojarun-backend`) and **customer webapp** (`ojarun_webapp`).

**Design rule (same idea as Bolt / Chowdeck):**  
**No map pin → no distance-based delivery fee.**  
Free-text address is only a rider note. Billing always comes from `lat` / `lng`.

---

## Summary

| Concern | Behaviour |
|--------|-----------|
| Origin | Bodija Market, Ibadan (`7.4359015`, `3.9157404`) |
| Distance | OpenRouteService (ORS) driving distance; Haversine × `roadFactor` only if ORS fails |
| Fee formula | ₦700 for first 3 km, then ₦150/km, round up to ₦50, cap ₦3,000 |
| Shopper fee | ₦1,200 on every order (web + WhatsApp) |
| Service area | Ibadan bounds + max ~35 km from Bodija |
| Web | MapLibre pin picker at checkout → quote → order with coords |
| WhatsApp | Customer shares WhatsApp location; text alone cannot confirm |

---

## Fee formula

```
billableKm = max(0, distanceKm - baseKm)   // default baseKm = 3
raw        = baseFee + billableKm * perKm  // default 700 + ×150
fee        = min(ceil(raw / 50) * 50, maxFee)  // default max 3000
```

Total charged:

```
total = subtotal + serviceFee + deliveryFee - discount
```

All three fee parts are **persisted on the order** (`subtotal`, `agent_fee`, `delivery_fee`, plus `delivery_distance_km`, `delivery_lat`, `delivery_lng`).

---

## Service area guards

A pin is **not serviceable** if any of these fail:

1. Outside Ibadan bounding box:  
   `lat ∈ [7.15, 7.65]`, `lng ∈ [3.7, 4.1]`
2. Driving distance from Bodija > `DELIVERY_MAX_KM` (default **35**)

Unserviceable pins are **rejected** (order not created). There is no flat-fee billing on the pin path.

---

## Architecture

```
Customer pin (web map OR WhatsApp location)
        │
        ▼
DeliveryPricingService.quoteForCoords(lat, lng)
        │
        ├─ OrsClient.isInIbadan?
        ├─ OrsClient.drivingDistanceKm(Bodija → pin)
        └─ feeForDistanceKm(distance)
        │
        ▼
Order created with fee + coords stored
```

Legacy free-text geocoding / area-table paths still exist in code for older tooling, but **web + WhatsApp order confirmation no longer bill from text**.

---

## Repos & key files

### Backend — `ojarun-backend`

| Path | Role |
|------|------|
| `src/delivery/delivery-pricing.service.ts` | Fee logic; `quoteForCoords` (pin-first) |
| `src/delivery/ors.client.ts` | ORS geocode + matrix routing |
| `src/delivery/delivery.controller.ts` | `POST /delivery/quote` |
| `src/delivery/dto/delivery-quote.dto.ts` | Quote body (`lat`, `lng`, optional label) |
| `src/orders/orders.service.ts` | `createFromWeb` re-quotes from pin |
| `src/orders/dto/order.dto.ts` | Create order requires `lat`/`lng` |
| `src/addresses/*` | Saved addresses require `lat`/`lng` |
| `src/webhooks/webhooks.controller.ts` | WhatsApp location handling + confirm |
| `src/config/configuration.ts` | Fees, origin, ORS, max km |
| `scripts/build-ibadan-areas.js` | Optional area table rebuild (legacy support) |
| `src/delivery/ibadan-areas.data.ts` | Precomputed areas (legacy / fallback tooling) |

### Webapp — `ojarun_webapp`

| Path | Role |
|------|------|
| `src/app/(Marketplace)/checkout/page.tsx` | Holds pin + live quote state |
| `src/app/(Marketplace)/checkout/components/DeliveryAddress.tsx` | Address modal + pin flow |
| `src/app/(Marketplace)/checkout/components/AddressMapPicker.tsx` | MapLibre draggable pin |
| `src/app/(Marketplace)/checkout/components/OrderSummary.tsx` | Shows live fees; places order with coords |
| `src/lib/delivery.ts` | `quoteDelivery()` client |
| `src/lib/addresses.ts` | Saved addresses include `lat`/`lng` |
| `src/lib/orders.ts` | `createOrder` sends `lat`/`lng` |

Admin (`ojarun_admin`) only **displays** delivery address on orders; it does not set pins.

---

## API contracts

All customer endpoints below need **customer JWT** (`Authorization: Bearer …`).

### 1. Quote delivery

`POST /delivery/quote`

**Request**

```json
{
  "lat": 7.4467,
  "lng": 3.9137,
  "deliveryAddress": "Agbowo, near UI gate"
}
```

- `lat` / `lng` **required** (validated to Ibadan bounds)
- `deliveryAddress` optional label only

**Response**

```json
{
  "deliveryFee": 750,
  "serviceFee": 1200,
  "distanceKm": 2.69,
  "lat": 7.4467,
  "lng": 3.9137,
  "formattedAddress": "Agbowo, near UI gate",
  "neighborhood": null,
  "estimated": false,
  "serviceable": true,
  "origin": "Bodija Market, Ibadan",
  "message": null
}
```

If `serviceable: false`, `message` explains why. Client must not allow checkout.

> Server **re-quotes** on order create. Never trust the client’s displayed fee for billing.

### 2. Create order (web)

`POST /orders`

**Request (relevant fields)**

```json
{
  "items": [ /* … */ ],
  "deliveryAddress": "Agbowo, near UI gate",
  "lat": 7.4467,
  "lng": 3.9137,
  "note": "Call on arrival",
  "paymentMethod": "cash",
  "promoCode": "OPTIONAL"
}
```

Missing / out-of-bounds pin → `400` with Ibadan message.

### 3. Saved addresses

`POST /customer-addresses`

```json
{
  "address": "…",
  "landmark": "optional",
  "label": "Home",
  "lat": 7.4467,
  "lng": 3.9137,
  "isDefault": true
}
```

`lat` / `lng` are **required** on create. Old rows without coords need the customer to re-pin (“Needs a map pin”).

---

## WhatsApp flow

1. Customer shops by text (list / quantities) as before.
2. When ready to confirm, they must **share location**  
   (WhatsApp: 📎 → Location → send current / pinned location).
3. Bot handles `msg.type === "location"`:
   - Validates pin via `quoteForCoords`
   - Stores address meta with `lat` / `lng`
   - Replies with delivery fee + distance
4. Text address (if typed) is stored as a **note only** — **no lat/lng from geocode**.
5. On “that’s all” / confirm:
   - No pin → ask for location again
   - Unserviceable pin → reject
   - Else create order with same fee fields as web

Handler: `handleLocationPin` in `webhooks.controller.ts`.

---

## Web checkout UX

1. Checkout → **Delivery address** → **Drop a new pin**
2. Map (MapLibre + MapTiler style):
   - Drag pin / tap map / “Use my current location”
   - Reverse-geocode label via MapTiler (fallback: `Pin lat, lng`)
3. Optional landmark + label
4. **Save & use** or **Use once without saving**
5. Page calls `POST /delivery/quote` → Order summary shows:
   - Shopper fee
   - Delivery (~X km)
   - Total
6. Place order sends `deliveryAddress` + `lat` + `lng`

Hardcoded ₦700 delivery / ₦1200 agent fees are **removed** from the summary UI; numbers come from the quote.

---

## Environment variables

### Backend (`ojarun-backend`)

| Variable | Purpose | Default |
|----------|---------|---------|
| `ORS_API_KEY` | OpenRouteService routing | (required for real road km) |
| `ORS_BASE_URLS` | Comma-separated hosts | `https://api.openrouteservice.org,https://api.heigit.org` |
| `ORS_TLS_INSECURE` | Skip TLS verify (dev only) | auto non-prod |
| `SERVICE_FEE_NAIRA` / `AGENT_FEE_NAIRA` | Shopper fee | `1200` |
| `DELIVERY_ORIGIN_LAT` / `LNG` | Bodija | `7.4359015` / `3.9157404` |
| `DELIVERY_BASE_FEE` | Base fee ₦ | `700` |
| `DELIVERY_BASE_KM` | Included km | `3` |
| `DELIVERY_PER_KM` | ₦ per extra km | `150` |
| `DELIVERY_MAX_FEE` | Cap ₦ | `3000` |
| `DELIVERY_ROUND_TO` | Round-up step | `50` |
| `DELIVERY_MAX_KM` | Max service distance | `35` |
| `DELIVERY_ROAD_FACTOR` | Fallback if ORS down | `1.3` |
| `GOOGLE_MAPS_API_KEY` | Legacy text validation only | optional |

### Webapp (`ojarun_webapp`)

| Variable | Purpose |
|----------|---------|
| `NEXT_PUBLIC_API_URL` | Backend base URL (default `http://localhost:4000`) |
| `NEXT_PUBLIC_MAPTILER_KEY` | Map style + reverse geocode for pin picker |

Without `NEXT_PUBLIC_MAPTILER_KEY`, the pin picker shows a config error (tracking map uses the same key).

---

## Database

### Orders (already migrated)

- `subtotal`, `delivery_fee`, `agent_fee`
- `delivery_distance_km`, `delivery_lat`, `delivery_lng`

Migration: `prisma/migrations/20260916140000_order_delivery_pricing/`

### Geocode cache (optional performance)

Table `geocode_cache` — caches resolved text lookups. Pin path does not depend on it.

Migration: `prisma/migrations/20260917020000_geocode_cache/`

### Customer addresses (pin fields)

```sql
ALTER TABLE customer_addresses
  ADD COLUMN lat DOUBLE PRECISION,
  ADD COLUMN lng DOUBLE PRECISION;
```

Migration: `prisma/migrations/20260921120000_customer_address_coords/`

Deploy runs `prisma migrate deploy` as part of the backend build script.

---

## What is intentionally *not* used for billing anymore

- Free-text → Google/ORS geocode → fee (unreliable for Nigerian informal addresses)
- Flat ₦700 when geocode fails (under-charged far areas)
- Area-name table as primary billing path on web/WhatsApp confirm

Area table + old `quoteForAddress` remain in the codebase for tooling / gradual cleanup, but **checkout and WhatsApp confirm are pin-only**.

---

## How to test

### Web

1. Log in on webapp, add cart items, open checkout.
2. Drop a pin inside Ibadan → fee appears with distance.
3. Move pin far / outside Ibadan → `serviceable: false`, cannot place order.
4. Place order → DB row has `delivery_lat`, `delivery_lng`, `delivery_fee`, `delivery_distance_km`.

### WhatsApp

1. Send a shopping list.
2. Share location pin → bot replies with delivery ₦ and km.
3. Say “that’s all” → order created with same fee fields.
4. Confirm without pin → bot asks for location again.

### API smoke

```http
POST /delivery/quote
Authorization: Bearer <customer_jwt>
Content-Type: application/json

{ "lat": 7.4467, "lng": 3.9137, "deliveryAddress": "Agbowo test" }
```

---

## Known follow-ups

1. Old saved addresses without `lat`/`lng` must be re-pinned once.
2. Order tracking map still uses demo route coords in places — separate from checkout pricing.
3. Optional: zone list fallback if a customer refuses location on WhatsApp (not built).
4. Optional: prune unused free-text pricing paths once both channels are stable in production.

---

## Contact context

Built as a **unified pin-first** replacement for fragmented text/area/flat pricing so web and WhatsApp charge the same way: **pin → road distance → fee**.
