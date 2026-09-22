# Ojarun agent claim & delivery queue

Developer handoff for the **exclusive order claim** system: one invited agent owns **shopping + delivery** for an order. Customer payment still goes to **Ojarun**; Ojarun settles agents offline.

**Design rule:**  
**Notify everyone on duty → only one agent can claim.**  
Second claim → `409 Conflict`. No shared ownership.

---

## Summary

| Concern | Behaviour |
|--------|-----------|
| Who can work | Invite-only admin accounts with role `agent` (also `admin` / `superadmin`) |
| Signup | **No public form** — `POST /admins/invite` → accept-invite email |
| Scope of claim | One claim covers **shopping and delivery** end-to-end |
| Exclusivity | At most one `accepted` / `in_progress` assignment per order (DB unique index) |
| Money | Customer → Ojarun (Paystack / cash). Agent payout is **out of band** |
| Admin UI | `/deliveries` — Open queue + My jobs; claim/release also on order detail |

---

## What changed (high level)

### Before

- New order WhatsApp alert went to all on-duty agents
- Each alert **created a pending `OrderAssignment`** for every notified agent
- No accept/claim API — anyone could update any order status
- Two agents could “own” the same job in practice

### After

- Alerts still go to on-duty agents (WhatsApp) — **notify only**
- Agents **claim** via API / admin UI
- Only the claimer (or admin/superadmin override) can advance order status
- Release puts the job back in the open queue
- Delivered completes the assignment; cancel releases it

Pin-first delivery **pricing** is unchanged (see `DELIVERY.md`). This doc is only about **who does the job**.

---

## Agent accounts (signup)

| Step | How |
|------|-----|
| Create agent | Admin/superadmin: `POST /admins/invite` with `role: "agent"` |
| Accept | Email link → admin app `/accept-invite` → set password |
| WhatsApp | Required for agents (new-order alerts) |
| On duty | `isOnDuty` in Settings — controls who gets WhatsApp alerts |

Public `POST /auth/register` remains bootstrap-only (first superadmin). There is **no** “sign up as rider” form.

---

## Claim lifecycle

```
Order created / paid
        │
        ▼
WhatsApp alert → all on-duty agents (no assignment row)
        │
        ▼
Agent claims  ──► Assignment status: accepted
        │         (other agents get 409 if they try)
        ▼
Status → shopping / purchased / dispatched
        │         Assignment → in_progress
        ▼
Status → delivered (admin or customer confirm)
        │         Assignment → completed
        │
        └─ Release / cancel → Assignment rejected, order back in queue
```

**Claimable order statuses:**  
`pending`, `awaiting_payment`, `confirmed`, `shopping`, `purchased`, `dispatched`  
(Not `delivered` / `cancelled`.)

---

## Backend APIs

All require **admin JWT** (`Authorization: Bearer …`).  
Roles: `agent`, `admin`, `superadmin`.

### Open queue

`GET /assignments/queue`

Unclaimed orders still open for work.

### My jobs

`GET /assignments/mine`  
Optional query: `?status=accepted|in_progress|completed|…`

### Who owns an order

`GET /assignments/order/:orderId`  
→ claim object or `null`.

### Claim (exclusive)

`POST /assignments/order/:orderId/claim`

- Success → assignment `accepted`
- Already yours → idempotent success
- Owned by someone else → `409` with message

### Release

`POST /assignments/order/:orderId/release`  
Body (optional): `{ "reason": "…" }`

Claimer or admin/superadmin only. Status → `rejected`; order reappears in queue.

### Order status (gated)

`PATCH /orders/:id/status`

- **Agents** must have an active claim first → else `403`
- **Admin / superadmin** can always override
- Advancing to shopping/purchased/dispatched → assignment `in_progress`
- `delivered` → assignment `completed`
- `cancelled` → assignment released (`rejected`)

`GET /orders/:id` includes:

```json
"assignment": {
  "assignmentId": "...",
  "status": "accepted",
  "assignedAt": "...",
  "agent": { "id": "...", "name": "...", "email": "...", "role": "agent" }
}
```

or `"assignment": null`.

---

## Database

### Existing model: `order_assignments`

| Field | Role |
|-------|------|
| `order_id` | Order being worked |
| `admin_id` | Claiming agent |
| `status` | `pending` \| `accepted` \| `in_progress` \| `completed` \| `rejected` |
| `assigned_at` / `completed_at` / `notes` | Audit |

### New migration

`prisma/migrations/20260921180000_order_assignment_exclusive_claim/`

```sql
CREATE UNIQUE INDEX order_assignments_one_active_claim
  ON order_assignments (order_id)
  WHERE status IN ('accepted', 'in_progress');
```

Deploy: `npx prisma migrate deploy` (or your usual backend build that runs migrate).

Legacy `pending` rows from the old notify-creates-assignment path are rejected when someone claims.

---

## Admin UI (`Ojarun_Admin_dev` — separate repo)

Clone/work in its own directory (e.g. `C:\Users\User\Ojarun_Admin_dev`), not inside this backend repo.

| Surface | What it does |
|---------|----------------|
| **Sidebar → Deliveries** (`/deliveries`) | Tabs: Open queue \| My jobs |
| Open queue | List + **Claim** (conflict alert if beaten) |
| My jobs | Claimed / in progress / completed + **Release** / **Open** |
| Order details modal | Assignment block; Claim / Release; status advance only if claimed (admins override) |

### Key frontend files

| Path | Role |
|------|------|
| `src/lib/api.ts` | `listAssignmentQueue`, `listMyAssignments`, `claimOrder`, `releaseOrder` |
| `src/hooks/useAdminQueries.ts` | React Query hooks + cache invalidation |
| `src/app/(Dashboard)/deliveries/page.tsx` | Deliveries route |
| `src/app/(Dashboard)/deliveries/components/DeliveriesPanel.tsx` | Queue + mine UI |
| `src/app/(Dashboard)/orders/components/OrderDetailsModal.tsx` | Claim/release + gated status |
| `src/components/Sidebar.tsx` / `Header.tsx` | Nav + title |
| `src/middleware.ts` | Auth guard includes `/deliveries` |

---

## Backend key files

| Path | Role |
|------|------|
| `src/assignments/assignments.service.ts` | Queue, claim, release, exclusivity |
| `src/assignments/assignments.controller.ts` | HTTP routes |
| `src/assignments/assignments.module.ts` | Module |
| `src/admins/admin-notification.service.ts` | WhatsApp notify **without** creating assignments |
| `src/orders/orders.service.ts` | Status gate + complete/release assignment |
| `src/orders/orders.controller.ts` | Passes current admin into status/cancel |

---

## Settlement (explicit non-goal)

- Order totals (`subtotal`, `agent_fee`, `delivery_fee`) stay on the order for Ojarun accounting
- **No** agent wallet, commission split, or payout API in this work
- Ops settle agents separately (cash / transfer / payroll)

Queue payloads may include a note:  
`Customer pays Ojarun; Ojarun settles agents separately`

---

## How to test

### Backend

1. Apply migration: `npx prisma migrate deploy`
2. Invite two agents; both accept invite, set WhatsApp, stay on duty
3. Place a web/WhatsApp order
4. Agent A: `POST /assignments/order/:id/claim` → 200  
5. Agent B: same claim → **409**
6. Agent B: `PATCH /orders/:id/status` → **403**
7. Agent A: advance status through shopping → delivered → assignment `completed`
8. Or A releases → order returns to `GET /assignments/queue`

### Admin UI

1. Run admin on port 3001 against the backend
2. Open **Deliveries** → see order in Open queue
3. **Claim** → moves to My jobs; open modal and advance status
4. Second browser/agent tries Claim → error message
5. **Release** → job reappears in Open queue

---

## Known follow-ups

1. WhatsApp interactive **Claim** button (optional; UI already covers claim)
2. Filter queue by specialty (`Specialty.delivery` exists in schema but is unused)
3. Admin force-reassign UI (today: release then another agent claims, or admin overrides status)
4. Agent settlement reports / ledger (when product needs it)
5. Distinct icon for Deliveries in the sidebar (currently reuses Orders icon)

---

## Contact context

Built so invited agents can **race the open queue fairly**: first claim wins shopping + delivery, everyone else is blocked, and money stays with Ojarun until offline settlement.
