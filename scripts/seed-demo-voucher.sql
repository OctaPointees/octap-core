-- Local demo fixture. Run against octap_dev, never a production database.
-- Core currently creates vouchers as DRAFT and has no activation endpoint.
INSERT INTO vouchers (
  organization_id, code, title, description, points_cost,
  discount_type, total_supply, status, metadata
)
SELECT id, 'DEMO-TREAT-25', 'Demo coffee reward',
  'One demo coffee at checkout', 25, 'FREE_ITEM', 100, 'ACTIVE', '{"demo":true}'::jsonb
FROM organizations WHERE slug = 'octap-demo'
ON CONFLICT (organization_id, code) DO NOTHING;
