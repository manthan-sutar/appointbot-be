import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { getTodaysAppointments, getBusiness } from '../services/appointment.service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const router = express.Router();
const DEFAULT_BUSINESS_ID = parseInt(process.env.DEFAULT_BUSINESS_ID || '1', 10);

router.get('/', async (req, res) => {
  try {
    const [appointments, business] = await Promise.all([
      getTodaysAppointments(DEFAULT_BUSINESS_ID),
      getBusiness(DEFAULT_BUSINESS_ID),
    ]);

    const rows = appointments.map(a => {
      const time = new Date(a.scheduled_at).toLocaleTimeString('en-IN', {
        hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata',
      });
      const badgeClass = a.status === 'confirmed' ? 'badge-confirmed' : a.status === 'cancelled' ? 'badge-cancelled' : 'badge-completed';
      return `
        <tr>
          <td class="cell-time">${time}</td>
          <td>${a.service_name || '—'}</td>
          <td>${a.staff_name || '—'}</td>
          <td>${a.customer_name || '—'}</td>
          <td class="cell-phone">${a.customer_phone}</td>
          <td><span class="badge ${badgeClass}">${a.status}</span></td>
          <td class="cell-ref">#${a.id}</td>
        </tr>`;
    }).join('');

    const today = new Date().toLocaleDateString('en-IN', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata',
    });

    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Admin — ${business?.name || 'appointbot'}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #f8fafc;
      color: #0f172a;
      -webkit-font-smoothing: antialiased;
      min-height: 100vh;
    }
    .top-bar { height: 4px; background: #1e293b; flex-shrink: 0; }
    header {
      background: #0f172a;
      color: #fff;
      padding: 1rem 1.5rem 1.25rem;
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 0.75rem;
      border-bottom: 1px solid rgba(255,255,255,0.08);
    }
    .logo-wrap {
      display: flex;
      align-items: center;
      gap: 0.75rem;
    }
    .logo-icon {
      width: 40px; height: 40px;
      background: rgba(255,255,255,0.1);
      border-radius: 10px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 1.25rem;
    }
    header h1 { font-size: 1.25rem; font-weight: 700; letter-spacing: -0.02em; }
    .header-date { font-size: 0.875rem; color: #94a3b8; }
    .container { max-width: 1100px; margin: 0 auto; padding: 1.5rem 1.5rem 2rem; }
    .meta {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 1.25rem;
      flex-wrap: wrap;
      gap: 0.75rem;
    }
    .meta h2 { font-size: 1.125rem; font-weight: 600; color: #334155; }
    .meta-actions { display: flex; align-items: center; gap: 0.75rem; }
    .count {
      background: #0f172a;
      color: #fff;
      border-radius: 8px;
      padding: 0.35rem 0.75rem;
      font-size: 0.8125rem;
      font-weight: 600;
    }
    .refresh {
      background: #fff;
      border: 1px solid #e2e8f0;
      border-radius: 8px;
      padding: 0.5rem 1rem;
      font-size: 0.875rem;
      font-weight: 500;
      cursor: pointer;
      color: #475569;
      transition: background 0.15s, border-color 0.15s;
    }
    .refresh:hover { background: #f1f5f9; border-color: #cbd5e1; color: #0f172a; }
    .card {
      background: #fff;
      border-radius: 12px;
      border: 1px solid #e2e8f0;
      box-shadow: 0 1px 3px rgba(0,0,0,0.06);
      overflow: hidden;
    }
    table { width: 100%; border-collapse: collapse; }
    thead { background: #f8fafc; }
    th {
      padding: 0.75rem 1rem;
      text-align: left;
      font-size: 0.6875rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: #64748b;
    }
    td {
      padding: 0.875rem 1rem;
      font-size: 0.875rem;
      border-top: 1px solid #f1f5f9;
      color: #334155;
    }
    tr:hover td { background: #f8fafc; }
    .cell-time { font-weight: 600; color: #0f172a; }
    .cell-phone { font-family: ui-monospace, monospace; font-size: 0.8125rem; }
    .cell-ref { font-size: 0.8125rem; color: #94a3b8; }
    .badge {
      display: inline-block;
      padding: 0.2rem 0.5rem;
      border-radius: 6px;
      font-size: 0.75rem;
      font-weight: 600;
      text-transform: capitalize;
    }
    .badge-confirmed { background: #d1fae5; color: #065f46; }
    .badge-cancelled { background: #fee2e2; color: #991b1b; }
    .badge-completed { background: #dbeafe; color: #1e40af; }
    .empty {
      text-align: center;
      padding: 3rem 1.5rem;
      color: #64748b;
      font-size: 0.9375rem;
    }
    .empty-icon { font-size: 2.5rem; margin-bottom: 0.75rem; opacity: 0.6; }
    .empty-title { font-weight: 600; color: #475569; margin-bottom: 0.25rem; }
  </style>
</head>
<body>
  <div class="top-bar"></div>
  <header>
    <div class="logo-wrap">
      <div class="logo-icon">📅</div>
      <h1>${business?.name || 'appointbot'} — Admin</h1>
    </div>
    <span class="header-date">${today}</span>
  </header>
  <div class="container">
    <div class="meta">
      <h2>Today's Appointments</h2>
      <div class="meta-actions">
        <span class="count">${appointments.length} booking${appointments.length !== 1 ? 's' : ''}</span>
        <button class="refresh" type="button" onclick="location.reload()">↻ Refresh</button>
      </div>
    </div>
    <div class="card">
      ${appointments.length ? `
      <table>
        <thead>
          <tr>
            <th>Time</th><th>Service</th><th>Staff</th><th>Customer</th><th>Phone</th><th>Status</th><th>Ref</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>` : `
      <div class="empty">
        <div class="empty-icon">📅</div>
        <div class="empty-title">No appointments today</div>
        <div>Bookings for today will appear here.</div>
      </div>`}
    </div>
  </div>
</body>
</html>`);
  } catch (err) {
    console.error('[Admin] Error:', err);
    res.status(500).send('Error loading admin page.');
  }
});

export default router;
