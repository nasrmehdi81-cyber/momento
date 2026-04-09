// Momento Service Worker v2 — Background Price Alerts + Periodic Sync

const DB_NAME = 'momento-sw';
const DB_VERSION = 1;
const STORE_ALERTS = 'alerts';

// ─── IndexedDB helpers ──────────────────────────────────────────────────────

function openDB() {
  return new Promise(function(resolve, reject) {
    var req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = function(e) {
      var db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_ALERTS)) {
        db.createObjectStore(STORE_ALERTS, { keyPath: 'id' });
      }
    };
    req.onsuccess = function(e) { resolve(e.target.result); };
    req.onerror   = function(e) { reject(e.target.error); };
  });
}

function getAllAlerts(db) {
  return new Promise(function(resolve, reject) {
    var tx = db.transaction(STORE_ALERTS, 'readonly');
    var req = tx.objectStore(STORE_ALERTS).getAll();
    req.onsuccess = function(e) { resolve(e.target.result || []); };
    req.onerror   = function(e) { reject(e.target.error); };
  });
}

function putAlerts(db, alerts) {
  return new Promise(function(resolve, reject) {
    var tx = db.transaction(STORE_ALERTS, 'readwrite');
    var store = tx.objectStore(STORE_ALERTS);
    store.clear();
    alerts.forEach(function(a) { store.put(a); });
    tx.oncomplete = resolve;
    tx.onerror = function(e) { reject(e.target.error); };
  });
}

// ─── Price fetching ─────────────────────────────────────────────────────────

async function fetchPrices() {
  var prices = {};
  try {
    var res = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum&vs_currencies=usd',
      { signal: AbortSignal.timeout ? AbortSignal.timeout(10000) : undefined }
    );
    if (res.ok) {
      var d = await res.json();
      if (d.bitcoin)  prices['BTC'] = d.bitcoin.usd;
      if (d.ethereum) prices['ETH'] = d.ethereum.usd;
    }
  } catch (e) {
    console.warn('[SW] CoinGecko fetch failed:', e.message);
  }

  try {
    var res2 = await fetch('https://open.er-api.com/v6/latest/USD',
      { signal: AbortSignal.timeout ? AbortSignal.timeout(10000) : undefined }
    );
    if (res2.ok) {
      var d2 = await res2.json();
      if (d2.rates) {
        if (d2.rates.JPY) prices['USDJPY'] = parseFloat(d2.rates.JPY.toFixed(4));
        if (d2.rates.EUR) prices['EURUSD'] = parseFloat((1 / d2.rates.EUR).toFixed(4));
        if (d2.rates.GBP) prices['GBPUSD'] = parseFloat((1 / d2.rates.GBP).toFixed(4));
        if (d2.rates.AUD) prices['AUDUSD'] = parseFloat((1 / d2.rates.AUD).toFixed(4));
        if (d2.rates.CAD) prices['USDCAD'] = parseFloat(d2.rates.CAD.toFixed(4));
      }
    }
  } catch (e) {
    console.warn('[SW] ExchangeRate fetch failed:', e.message);
  }

  return prices;
}

// ─── Alert checking ─────────────────────────────────────────────────────────

function pairToKey(pair) {
  // Convert pair string like 'BTC/USD' → 'BTC', 'USD/JPY' → 'USDJPY'
  if (!pair) return '';
  if (pair.includes('BTC'))  return 'BTC';
  if (pair.includes('ETH'))  return 'ETH';
  var clean = pair.replace('/', '').replace(/\s/g, '');
  return clean;
}

async function checkAndNotify() {
  var db, alerts, prices;
  try {
    db = await openDB();
    alerts = await getAllAlerts(db);
    if (!alerts.length) return;
    prices = await fetchPrices();
  } catch (e) {
    console.warn('[SW] checkAndNotify error:', e.message);
    return;
  }

  var triggered = [];
  alerts.forEach(function(a) {
    if (a.triggered) return;
    var key = pairToKey(a.pair);
    var current = prices[key];
    if (!current) return;

    var hit = false;
    if (a.dir === 'above' && current >= a.target) hit = true;
    if (a.dir === 'below' && current <= a.target) hit = true;

    if (hit) {
      triggered.push(a);
      a.triggered = true;
    }
  });

  if (triggered.length && db) {
    await putAlerts(db, alerts);
  }

  triggered.forEach(function(a) {
    var fmt = function(p) {
      if (p >= 10000) return p.toLocaleString('en', { maximumFractionDigits: 0 });
      if (p >= 100)   return p.toFixed(2);
      return p.toFixed(4);
    };
    var key = pairToKey(a.pair);
    var cur = prices[key];
    self.registration.showNotification('Momento Alert — ' + a.pair, {
      body: a.pair + ' ' + (a.dir === 'above' ? 'reached ↑' : 'dropped ↓') +
            ' your target ' + fmt(a.target) +
            (cur ? ' · Current: ' + fmt(cur) : ''),
      tag: 'momento-alert-' + a.id,
      icon: '/icons/icon-192.png',
      badge: '/icons/badge-72.png',
      requireInteraction: true,
      vibrate: [200, 100, 200],
      data: { pair: a.pair }
    });
  });
}

// ─── Service Worker lifecycle ────────────────────────────────────────────────

self.addEventListener('install', function(e) {
  self.skipWaiting();
});

self.addEventListener('activate', function(e) {
  e.waitUntil(self.clients.claim());
});

// ─── Push (server-sent) ─────────────────────────────────────────────────────

self.addEventListener('push', function(e) {
  var data = e.data
    ? e.data.json()
    : { title: 'Momento Alert', body: 'Price target reached!' };
  e.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      tag: 'momento-alert',
      icon: '/icons/icon-192.png',
      requireInteraction: true,
      vibrate: [200, 100, 200]
    })
  );
});

// ─── Periodic Sync — check prices every 15 minutes ──────────────────────────

self.addEventListener('periodicsync', function(e) {
  if (e.tag === 'check-alerts') {
    e.waitUntil(checkAndNotify());
  }
});

// ─── Notification click ──────────────────────────────────────────────────────

self.addEventListener('notificationclick', function(e) {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(list) {
      for (var i = 0; i < list.length; i++) {
        if (list[i].url && list[i].focus) {
          return list[i].focus();
        }
      }
      return clients.openWindow('/');
    })
  );
});

// ─── Message from app — sync alerts into IndexedDB ──────────────────────────

self.addEventListener('message', function(e) {
  if (e.data && e.data.type === 'SYNC_ALERTS') {
    openDB().then(function(db) {
      return putAlerts(db, e.data.alerts || []);
    }).catch(function(err) {
      console.warn('[SW] SYNC_ALERTS failed:', err.message);
    });
  }
});
