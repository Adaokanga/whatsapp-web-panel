const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const path = require('path');
const fs = require('fs');
const archiver = require('archiver');
const WhatsAppService = require('./whatsapp-service');

const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  transports: ['websocket', 'polling']
});

app.use(express.static('public'));
app.use(express.json());

const downloadsPath = path.join(__dirname, 'public', 'downloads');
if (!fs.existsSync(downloadsPath)) {
  fs.mkdirSync(downloadsPath, { recursive: true });
}

const waService = new WhatsAppService(io);

// API: Status
app.get('/api/status', (req, res) => {
  res.json({
    connected: waService.isConnected,
    hasQR: !!waService.qrCode,
    groupsCount: waService.groups.length,
    messagesCount: waService.messageCount
  });
});

// API: QR Code
app.get('/api/qrcode', (req, res) => {
  if (waService.qrCode) {
    res.json({ success: true, qrCode: waService.qrCode, connected: false });
  } else if (waService.isConnected) {
    res.json({ success: true, qrCode: null, connected: true });
  } else {
    res.json({ success: false, qrCode: null, connected: false });
  }
});

// API: Forçar carregamento de grupos
app.get('/api/load-groups', async (req, res) => {
  try {
    await waService.loadGroups();
    res.json({ success: true, groups: waService.groups, total: waService.groups.length });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// API: Listar grupos
app.get('/api/groups', (req, res) => {
  res.json({ success: true, groups: waService.groups, total: waService.groups.length });
});

// DOWNLOAD: JSON com grupos
app.get('/api/download/groups-json', (req, res) => {
  if (waService.groups.length === 0) {
    return res.json({ error: 'Nenhum grupo carregado ainda. Aguarde...' });
  }
  
  const data = {
    exportDate: new Date().toISOString(),
    totalGroups: waService.groups.length,
    groups: waService.groups.map(g => ({
      id: g.id,
      name: g.name,
      participants: g.participants
    }))
  };
  
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename=grupos_whatsapp.json');
  res.send(JSON.stringify(data, null, 2));
});

// DOWNLOAD: TXT com IDs
app.get('/api/download/groups-txt', (req, res) => {
  if (waService.groups.length === 0) {
    return res.send('Nenhum grupo carregado ainda.');
  }
  
  const txt = waService.groups.map(g => `${g.name} = ${g.id}`).join('\n');
  res.setHeader('Content-Type', 'text/plain');
  res.setHeader('Content-Disposition', 'attachment; filename=grupos_ids.txt');
  res.send(txt);
});

// DOWNLOAD: ZIP completo
app.get('/api/download/all', (req, res) => {
  if (waService.groups.length === 0) {
    return res.json({ error: 'Nenhum grupo carregado ainda.' });
  }
  
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename=whatsapp_data.zip');
  
  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.pipe(res);
  
  archive.append(
    JSON.stringify({
      exportDate: new Date().toISOString(),
      totalGroups: waService.groups.length,
      groups: waService.groups
    }, null, 2),
    { name: 'grupos_whatsapp.json' }
  );
  
  archive.append(
    waService.groups.map(g => `${g.name} = ${g.id}`).join('\n'),
    { name: 'grupos_ids.txt' }
  );
  
  archive.finalize();
});

// Página inicial
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// WebSocket
io.on('connection', (socket) => {
  console.log('🟢 Cliente conectado');
  
  if (waService.qrCode) socket.emit('qr-code', waService.qrCode);
  
  socket.emit('status-update', {
    connected: waService.isConnected,
    groups: waService.groups,
    messages: waService.recentMessages.slice(-20)
  });
  
  socket.on('get-qr', () => {
    if (waService.qrCode) socket.emit('qr-code', waService.qrCode);
  });
  
  socket.on('load-groups', async () => {
    await waService.loadGroups();
    socket.emit('groups-update', waService.groups);
  });
  
  socket.on('disconnect', () => console.log('🔴 Cliente desconectado'));
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 Painel rodando na porta ${PORT}`);
  setTimeout(() => waService.connect(), 2000);
});
