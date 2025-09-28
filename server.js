
// =============================================================
// Seattle Trading — server.js - Why The Fuck Are You Looking At My Code?
// =============================================================

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

app.get('/', (_req, res) => res.send('Seattle Trading API is up'));


// Add products with prices (in cents)
const PRODUCTS = {
  "us-1000-length-12\"-milky-white": 14999,
  "us-2000-pro-3.5-ice-blue": 14499,
  "us-1000-length-12\"-hot-pink": 14499,
  "us-1000-pro-3.5-hot-pink": 12499,
  "us-2,000-pro-3.0-cobalt-blue":  14499,
  "us-1,000-pro-6.0-coal-black": 16499,
  "us-1000-pro-5.0-coal-black": 15999,
  "us-1000-pro-3.5-coal-black": 12499,
  "us-1000-3.5-s": 14999,
  "qube-latex-exam-powder": 5499,
  "qube-nitrile-exam-powder-free": 5499,
  "qube-latex-exam-powder-free": 5499,
  "polysilk-18000-s": 5499,
  "action-16000-s": 6499,
  "action-69000-s": 6499,
  "action-83000-s": 5799,
  "action-808120-s": 6499,
  "action-17700-s": 5799,
  "shamrock-14000-s": 5499,
  "shamrock-15000-s": 5499,
  "shamrock-6000-s": 5499,
  "shamrock-sup-60500-s": 5499,
  "shamrock-30000-s": 5499,
  "shamrock-80000-s": 5499,
  "shamrock-sup-50359-s": 5499, 
  "shamrock-10000-s": 5499,
  "shamrock-68000-s": 5499,
  "shamrock-86000-s": 12499,
  "shamrock-20000-s": 5499, 
  "excel-nitrile-exam": 6499, 
  "walletz-nitrile-exam": 6499,
  "icon-nitrile-exam": 5499,
  "qube-nitrile-exam": 5499,
  "qube-nitrile-exam-10bx": 5499
};

// Helpers
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
      amount: unitAmount,           
      reference: id,                // SKU/id
      tax_behavior: 'exclusive',    
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
    // REQUIRED by Stripe API
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
      // shipping_cost: { amount: 0 }, // uncomment if tax shipping - Do if $100 or more -> No Shipping Fee
    });

    return res.json({
      id: calc.id,
      subtotal: subtotalCents,
      tax: (calc.tax_amount_exclusive || 0) + (calc.tax_amount_inclusive || 0),
      total: subtotalCents + ((calc.tax_amount_exclusive || 0) + (calc.tax_amount_inclusive || 0)),
    });
  } catch (err) {
    console.error('tax-preview error:', err && err.raw ? err.raw : err);
    return res.status(400).json({ error: err.message || 'Tax preview failed' });
  }
});

// ----- CREATE PAYMENT INTENT  -------
app.post('/create-payment-intent', async (req, res) => {
  try {
    const { items, shipping, calc_id, email, name, cart } = req.body || {};
    console.log('create-payment-intent payload:', JSON.stringify(req.body));

    let amount;
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

    // NEW: stash customer + compact cart in metadata
    if (email) metadata.email = String(email);
    if (name)  metadata.name  = String(name);
    if (Array.isArray(cart)) {
      metadata.cart = JSON.stringify(cart.map(i => ({
        id: String(i.id || ''),
        qty: Math.max(1, Number(i.qty || 1) | 0),
        p:   Math.max(0, Number(i.p || i.price_cents || 0) | 0)
      })));
    }

    const params = {
      amount,
      currency: 'usd',
      description,
      metadata,
      automatic_payment_methods: { enabled: true }
    };
    if (isAddressComplete(shipping)) params.shipping = shipping;

    const pi = await stripe.paymentIntents.create(params);
    return res.json({ clientSecret: pi.client_secret });
  } catch (err) {
    console.error('Payment error:', err && err.raw ? err.raw : err);
    return res.status(500).json({ error: err.message || 'Server error' });
  }
});

app.get('/pi/:id', async (req, res) => {
  try {
    const pi = await stripe.paymentIntents.retrieve(
      req.params.id,
      { expand: ['charges'] }
    );
    const ch = pi.charges?.data?.[0];

    // Parse compact cart safely
    let cart = [];
    try { cart = JSON.parse(pi.metadata?.cart || '[]'); } catch (_) {}

    res.json({
      ok: true,
      order: {
        id:       pi.id,
        status:   pi.status,
        amount:   pi.amount,             // cents
        currency: pi.currency,
        email:    pi.metadata?.email || ch?.billing_details?.email || '',
        name:     pi.metadata?.name  || ch?.billing_details?.name  || '',
        cart,
        receipt_url: ch?.receipt_url || ''
      }
    });
  } catch (err) {
    console.error('GET /pi error:', err && err.raw ? err.raw : err);
    res.status(400).json({ ok: false, error: 'Cannot retrieve payment' });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Payment server running on http://localhost:${PORT}`);
});