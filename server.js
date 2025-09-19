
// server.js — Seattle Trading payment server
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Stripe = require('stripe');

const app = express();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const PORT = process.env.PORT || 4242;

// CORS: during local dev you can allow both localhost & 127.0.0.1
const origins = (process.env.ALLOWED_ORIGIN || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || origins.includes(origin)) return cb(null, true);
    cb(new Error(`Origin not allowed: ${origin}`));
  }
}));
console.log('CORS allowed from:', origins);
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

// Map your products with prices (in cents)
const PRODUCTS = {
  "st-nitrile-blue-100": 1299,
  "st-nitrile-black-100": 1449,
  "st-latex-100": 1099,
  "st-vinyl-100":  849
};

// --- helpers --------------------------------------------------
function normalizeItems(items = []) {
  if (!Array.isArray(items)) return [];
  return items.filter(Boolean).map(it => ({
    id: String(it.id || '').trim(),
    qty: Math.max(1, Number(it.qty || 1)|0),
  }));
}

function buildLineItems(rawItems) {
  return rawItems.map(({ id, qty }) => {
    const unitAmount = PRODUCTS[id];
    if (!unitAmount) throw new Error(`Unknown product id: ${id}`);
    return {
      amount: unitAmount,           // cents
      reference: id,                // your SKU/id
      tax_behavior: 'exclusive',    // tax added on top
      quantity: qty
    };
  });
}

function buildCustomerAddress(shipping = {}) {
  const a = shipping.address || {};
  return {
    address: {
      line1: String(a.line1 || '').trim(),
      city: String(a.city || '').trim(),
      state: String(a.state || '').trim().toUpperCase(),
      postal_code: String(a.postal_code || '').trim(),
      country: String(a.country || 'US').trim().toUpperCase(),
    },
    // 🔴 REQUIRED by your Stripe API version when you send an address
    address_source: 'shipping',
  };
}

function isAddressComplete(s) {
  if (!s || !s.address) return false;
  const { line1, city, state, postal_code, country } = s.address;
  return [line1, city, state, postal_code, country].every(
    v => typeof v === 'string' && v.trim() !== ''
  );
}

// ----- TAX PREVIEW (address-based) ----------------------------
app.post('/tax-preview', async (req, res) => {
  try {
    // Log what the browser actually sent (shows up in Node console)
    console.log('tax-preview payload:', JSON.stringify(req.body));

    // 1) Validate presence of items and shipping
    const items = req.body && Array.isArray(req.body.items) ? req.body.items : null;
    const shipping = req.body && req.body.shipping ? req.body.shipping : null;

    if (!items || !items.length) {
      return res.status(400).json({ error: 'Missing or empty items array' });
    }
    if (!shipping || !shipping.address) {
      return res.status(400).json({ error: 'Missing shipping.address' });
    }

    // 2) Require a complete US address (Stripe Tax needs these)
    const { line1, city, state, postal_code, country } = shipping.address || {};
    const missing = [];
    if (!line1)       missing.push('address.line1');
    if (!city)        missing.push('address.city');
    if (!state)       missing.push('address.state');
    if (!postal_code) missing.push('address.postal_code');
    if (!country)     missing.push('address.country');
    if (missing.length) {
      return res.status(400).json({ error: `Incomplete address: ${missing.join(', ')}` });
    }

    // 3) Build Stripe inputs and calculate tax
    const rawItems = normalizeItems(items);
    const line_items = buildLineItems(rawItems);
    const subtotalCents = line_items.reduce((sum, li) => sum + li.amount * li.quantity, 0);

    const customer_details = buildCustomerAddress(shipping);

    const calc = await stripe.tax.calculations.create({
      currency: 'usd',
      line_items,
      customer_details,
      // shipping_cost: { amount: 0 }, // uncomment if you tax shipping
    });

    return res.json({
      id: calc.id,
      subtotal: subtotalCents, // cents
      tax: (calc.tax_amount_exclusive || 0) + (calc.tax_amount_inclusive || 0), // cents
      total: subtotalCents + ((calc.tax_amount_exclusive || 0) + (calc.tax_amount_inclusive || 0)), // cents
    });
  } catch (err) {
    console.error('tax-preview error:', err && err.raw ? err.raw : err);
    return res.status(400).json({ error: err.message || 'Tax preview failed' });
  }
});

// ----- CREATE PAYMENT INTENT (uses calc_id if provided) -------
app.post('/create-payment-intent', async (req, res) => {
  try {
    const { items, shipping, calc_id } = req.body;
    console.log('create-payment-intent payload:', JSON.stringify(req.body));

    let amount;                       // cents
    let description = 'Seattle Trading Order';
    const metadata = {};

    if (calc_id) {
      const calc = await stripe.tax.calculations.retrieve(calc_id);
      amount = calc.amount_total;     // charge the previewed total
      description += ' (via tax calc)';
      metadata.calc_id = calc_id;
    } else {
      if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: 'No items' });
      }
      amount = items.reduce((sum, { id, qty }) => {
        const price = PRODUCTS[id];
        if (!price) throw new Error(`Unknown product: ${id}`);
        return sum + price * (qty || 1);
      }, 0);
      metadata.items = items.map(i => `${i.id}x${i.qty}`).join(', ');
    }

    const params = {
      amount,
      currency: 'usd',
      description,
      metadata,
    };
    if (isAddressComplete(shipping)) params.shipping = shipping;

    // IMPORTANT: do NOT include `automatic_tax` on your current API version
    const pi = await stripe.paymentIntents.create(params);
    return res.json({ clientSecret: pi.client_secret });
  } catch (err) {
    console.error('Payment error:', err && err.raw ? err.raw : err);
    return res.status(500).json({ error: err.message || 'Server error' });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Payment server running on http://localhost:${PORT}`);
});