-- appointbot seed data — demo businesses for testing
-- Run: psql $DATABASE_URL -f db/seed.sql

-- Demo salon
INSERT INTO businesses (name, type, phone, timezone)
VALUES ('Style Studio', 'salon', '+919000000001', 'Asia/Kolkata')
ON CONFLICT (phone) DO NOTHING;

-- Demo doctor clinic
INSERT INTO businesses (name, type, phone, timezone)
VALUES ('Dr. Sharma Clinic', 'doctor', '+919000000002', 'Asia/Kolkata')
ON CONFLICT (phone) DO NOTHING;

-- Staff for salon (id=1)
INSERT INTO staff (business_id, name, role)
SELECT id, 'Priya', 'Senior Stylist' FROM businesses WHERE phone = '+919000000001'
ON CONFLICT DO NOTHING;

INSERT INTO staff (business_id, name, role)
SELECT id, 'Rahul', 'Barber' FROM businesses WHERE phone = '+919000000001'
ON CONFLICT DO NOTHING;

-- Staff for clinic (id=2)
INSERT INTO staff (business_id, name, role)
SELECT id, 'Dr. Sharma', 'General Physician' FROM businesses WHERE phone = '+919000000002'
ON CONFLICT DO NOTHING;

-- Services for salon
INSERT INTO services (business_id, name, duration_minutes, price)
SELECT id, 'Haircut', 30, 300 FROM businesses WHERE phone = '+919000000001'
ON CONFLICT DO NOTHING;

INSERT INTO services (business_id, name, duration_minutes, price)
SELECT id, 'Hair Colour', 90, 1200 FROM businesses WHERE phone = '+919000000001'
ON CONFLICT DO NOTHING;

INSERT INTO services (business_id, name, duration_minutes, price)
SELECT id, 'Facial', 60, 800 FROM businesses WHERE phone = '+919000000001'
ON CONFLICT DO NOTHING;

-- Services for clinic
INSERT INTO services (business_id, name, duration_minutes, price)
SELECT id, 'General Consultation', 20, 500 FROM businesses WHERE phone = '+919000000002'
ON CONFLICT DO NOTHING;

-- Availability: salon staff Mon–Sat 10am–7pm
INSERT INTO availability (staff_id, day_of_week, start_time, end_time)
SELECT s.id, d.day, '10:00', '19:00'
FROM staff s
JOIN businesses b ON s.business_id = b.id,
(VALUES (1),(2),(3),(4),(5),(6)) AS d(day)
WHERE b.phone = '+919000000001'
ON CONFLICT DO NOTHING;

-- Availability: doctor Mon–Fri 9am–5pm
INSERT INTO availability (staff_id, day_of_week, start_time, end_time)
SELECT s.id, d.day, '09:00', '17:00'
FROM staff s
JOIN businesses b ON s.business_id = b.id,
(VALUES (1),(2),(3),(4),(5)) AS d(day)
WHERE b.phone = '+919000000002'
ON CONFLICT DO NOTHING;
