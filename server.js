const express = require('express');
const cors = require('cors');
const pool = require('./db/mysql');
const { createUnitID, toSQLDateAndTime, toSQLDate, getPayDay } = require('./routes/stringUtils'); // adjust path

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.text({ type: '*/*', limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

const PORT = 3000;

const users = {};
const attendance = [];
const devices = {};
const commandQueue = [];
let cmdSeq = 1;
let commandsQueued = false;

// SSE clients
const sseClients = new Set();

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(client => client.write(msg));
}

function parseUsers(body) {
  const found = [];
  body.split('\n').forEach(line => {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (/^USER/i.test(trimmed)) {
      const parts = trimmed.replace(/^USER\s*/i, '').split('\t');
      found.push({
        pin: parts[0] || '',
        name: parts[1] || '',
        password: parts[2] || '',
        card: parts[3] || '',
        role: parts[4] === '14' ? 'Admin' : 'User',
      });
    }
  });
  return found;
}

function parseAttLog(body) {
  const found = [];
  body.split('\n').forEach(line => {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (/^ATTLOG/i.test(trimmed)) {
      const data = trimmed.replace(/^ATTLOG\s*/i, '');
      const parts = data.split('\t');
      if (parts.length === 1) {
        const sp = data.split(' ');
        found.push({ pin: sp[0] || '', date: sp[1] || '', time: sp[2] || '', status: sp[3] || '0', verify: sp[4] || '0' });
      } else {
        found.push({ pin: parts[0] || '', date: parts[1] || '', time: parts[2] || '', status: parts[3] || '0', verify: parts[4] || '0' });
      }
      return;
    }
    const tp = trimmed.split('\t');
    if (tp.length >= 3 && /^\d+$/.test(tp[0])) {
      const dt = (tp[1] || '').split(' ');
      found.push({ pin: tp[0], date: dt[0] || '', time: dt[1] || '', status: tp[2] || '0', verify: tp[3] || '0' });
    }
  });
  return found;
}

function queuePullCommands() {
  if (commandsQueued) return;
  commandsQueued = true;
  commandQueue.push(`C:${cmdSeq++}:DATA QUERY USERINFO`);
  commandQueue.push(`C:${cmdSeq++}:DATA QUERY ATTLOG StartTime=2000-01-01 00:00:00&EndTime=2099-12-31 23:59:59`);
  commandQueue.push(`C:${cmdSeq++}:DATA QUERY OPERLOG`);
}

// ══════════════════════════════════════════════
//  SSE STREAM
// ══════════════════════════════════════════════

app.get('/api/stream', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  // Send current state on connect
  res.write(`event: init\ndata: ${JSON.stringify({
    users: Object.values(users),
    attendance: attendance.slice(-100), // last 100
    summary: {
      devices: Object.keys(devices).length,
      users: Object.keys(users).length,
      attendance: attendance.length,
    }
  })}\n\n`);

  sseClients.add(res);

  // Heartbeat every 20s to keep connection alive
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 20000);

  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
  });
});

// ══════════════════════════════════════════════
//  JSON API
// ══════════════════════════════════════════════

app.get('/api/users', (req, res) => {
  res.json({ total: Object.keys(users).length, users: Object.values(users) });
});

app.get('/api/attendance', (req, res) => {
  const { pin, date } = req.query;
  let logs = [...attendance];
  if (pin) logs = logs.filter(r => r.pin === pin);
  if (date) logs = logs.filter(r => r.date === date);
  res.json({ total: logs.length, filters: { pin: pin || null, date: date || null }, attendance: logs });
});

app.get('/api/devices', (req, res) => {
  res.json({ total: Object.keys(devices).length, devices: Object.values(devices) })
  res.json(req.ip);
});

app.get('/api/summary', (req, res) => {
  res.json({
    devices: Object.keys(devices).length,
    users: Object.keys(users).length,
    attendance: attendance.length,
    timestamp: new Date().toISOString(),
  });
});

app.post('/api/sync', (req, res) => {
  commandsQueued = false;
  queuePullCommands();
  res.json({ message: 'Sync queued', pending: commandQueue.length });
});

// ══════════════════════════════════════════════
//  ZKTECO ADMS PROTOCOL
// ══════════════════════════════════════════════

app.get('/iclock/cdata', (req, res) => {
  const sn = req.query.SN || 'UNKNOWN';
  devices[sn] = { sn, ip: req.ip, lastSeen: new Date().toISOString() };
  commandsQueued = false;
  queuePullCommands();
  broadcast('device', { sn, ip: req.ip, lastSeen: devices[sn].lastSeen });
  res.set('Content-Type', 'text/plain');
  res.send(
    `GET OPTION FROM: ${sn}\r\n` +
    `ATTLOGStamp=None\r\nOPERLOGStamp=None\r\nATTPHOTOStamp=None\r\n` +
    `ErrorDelay=30\r\nDelay=1\r\nTransTimes=00:00;23:59\r\nTransInterval=1\r\n` +
    `TransFlag=TransData AttLog OpLog EnrollUser\r\nRealtime=1\r\nEncrypt=None\r\n`
  );
});

app.get('/iclock/getrequest', (req, res) => {
  const sn = req.query.SN || 'UNKNOWN';
  if (devices[sn]) devices[sn].lastSeen = new Date().toISOString();
  queuePullCommands();
  res.set('Content-Type', 'text/plain');
  res.send(commandQueue.length > 0 ? commandQueue.shift() + '\r\n' : 'OK\r\n');
});

app.post('/iclock/cdata', async (req, res) => {
  const sn = req.query.SN || 'UNKNOWN';
  const body = typeof req.body === 'string' ? req.body : '';
  const deviceIP = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;

  if (devices[sn]) {
    devices[sn].ip = deviceIP;
    devices[sn].lastSeen = new Date().toISOString();
  } else {
    devices[sn] = { sn, ip: deviceIP, lastSeen: new Date().toISOString() };
  }

  const newUsers = parseUsers(body);
  const records = parseAttLog(body);

  newUsers.forEach(u => {
    users[u.pin] = { ...u, sn, updatedAt: new Date().toISOString() };
    broadcast('user', users[u.pin]);
  });

  const twoDaysAgo = new Date();
  twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
  twoDaysAgo.setHours(0, 0, 0, 0);

  const recentRecords = records.filter(r => new Date(`${r.date} ${r.time}`) >= twoDaysAgo);

  for (const r of recentRecords) {
    const record = { ...r, sn, receivedAt: new Date().toISOString() };
    attendance.push(record);

    const user = users[r.pin];
    broadcast('punch', { ...record, name: user?.name || '' });
  }

  res.set('Content-Type', 'text/plain');
  res.send(`OK: ${body.split('\n').filter(Boolean).length}\r\n`);
});

  res.set('Content-Type', 'text/plain');
  res.send(`OK: ${body.split('\n').filter(Boolean).length}\r\n`);
});

app.post('/iclock/devicecmd', (req, res) => {
  res.set('Content-Type', 'text/plain');
  res.send('OK\r\n');
});

// ══════════════════════════════════════════════
//  START
// ══════════════════════════════════════════════

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
