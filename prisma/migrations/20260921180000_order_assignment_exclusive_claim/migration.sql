-- At most one active claim (accepted / in_progress) per order.
-- Agents claim shopping + delivery together; exclusivity is enforced here.
CREATE UNIQUE INDEX IF NOT EXISTS order_assignments_one_active_claim
  ON order_assignments (order_id)
  WHERE status IN ('accepted', 'in_progress');
