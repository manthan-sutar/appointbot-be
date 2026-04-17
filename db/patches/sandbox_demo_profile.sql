-- Rich demo data for the sandbox tenant created by `npm run sandbox:ensure`
-- (business slug: demo-sandbox). Safe to re-run: replaces staff/services/hours for that business only.
-- Usage: psql $DATABASE_URL -f db/patches/sandbox_demo_profile.sql

UPDATE businesses
SET
  name = 'Booklyft Demo Salon',
  type = 'salon',
  timezone = 'Asia/Kolkata'
WHERE slug = 'demo-sandbox';

DELETE FROM availability
WHERE staff_id IN (
  SELECT id FROM staff WHERE business_id = (SELECT id FROM businesses WHERE slug = 'demo-sandbox' LIMIT 1)
);

DELETE FROM staff
WHERE business_id = (SELECT id FROM businesses WHERE slug = 'demo-sandbox' LIMIT 1);

DELETE FROM services
WHERE business_id = (SELECT id FROM businesses WHERE slug = 'demo-sandbox' LIMIT 1);

INSERT INTO staff (business_id, name, role)
SELECT b.id, 'Priya', 'Senior Stylist'
FROM businesses b WHERE b.slug = 'demo-sandbox'
UNION ALL
SELECT b.id, 'Rahul', 'Stylist'
FROM businesses b WHERE b.slug = 'demo-sandbox';

INSERT INTO services (business_id, name, duration_minutes, price, active)
SELECT b.id, 'Haircut', 30, 399.00, TRUE FROM businesses b WHERE b.slug = 'demo-sandbox'
UNION ALL
SELECT b.id, 'Hair colour', 90, 2499.00, TRUE FROM businesses b WHERE b.slug = 'demo-sandbox'
UNION ALL
SELECT b.id, 'Facial', 60, 1299.00, TRUE FROM businesses b WHERE b.slug = 'demo-sandbox'
UNION ALL
SELECT b.id, 'Beard trim', 20, 199.00, TRUE FROM businesses b WHERE b.slug = 'demo-sandbox';

-- Mon–Sat 10:00–19:00 for each staff member
INSERT INTO availability (staff_id, day_of_week, start_time, end_time)
SELECT s.id, d.day, '10:00', '19:00'
FROM staff s
JOIN businesses b ON s.business_id = b.id
CROSS JOIN (VALUES (1), (2), (3), (4), (5), (6)) AS d(day)
WHERE b.slug = 'demo-sandbox';
