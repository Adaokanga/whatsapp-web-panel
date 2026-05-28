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
  transports: ['websocket', 'polling'],
  allowEIO3: true
});

app.use(express.static('public'));
app.use(express.json());

const downloadsPath = path.join(__dirname, 'public', 'downloads');
if (!fs.existsSync(downloadsPath)) {
  fs.mkdirSync(downloadsPath, { recursive: true });
}

const waService = new WhatsAppService(io);

// ROTA API: Status geral
app.get('/api/status', (req, res) => {
  res.json({
    connected: waService.isConnected,
    hasQR: !!waService.qrCode,
    groupsCount: waService.groups.length,
    messagesCount: waService.messageCount
  });
});

// ROTA API: QR Code (Via API REST - alternativa ao WebSocket)
app.get('/api/qrcode', (req, res) => {
  if (waService.qrCode) {
    res.json({ 
      success: true, 
      qrCode: waService.qrCode, 
      connected: false,
      message: 'QR Code pronto para escanear'
    });
  } else if (waService.isConnected) {
    res.json({ 
      success: true, 
      qrCode: null, 
      connected: true, 
      message: 'WhatsApp já está conectado!' 
    });
  } else {
    res.json({ 
      success: false, 
      qrCode: null, 
      connected: false, 
      message: 'QR Code ainda não foi gerado. Aguarde...' 
    });
  }
});

// ROTA API: Forçar reconexão (gera novo QR)
app.get('/api/reconnect', (req, res) => {
  waService.cleanAuth();
  res.json({ 
    success: true, 
    message: 'Sessão limpa. Reconectando... Recarregue a página em 5 segundos.' 
  });
  setTimeout(() => waService.connect(), 2000);
});

// ROTA API: Listar grupos
app.get('/api/groups', (req, res) => {
  res.json({ 
    success: true, 
    groups: waService.groups, 
    total: waService.groups.length 
  });
});

// ROTA API: Mensagens (opcional: filtrar por grupo)
app.get('/api/messages/:groupId?', (req, res) => {
  const { groupId } = req.params;
  let messages = waService.recentMessages;
  if (groupId) messages = messages.filter(m => m.groupId === groupId);
  res.json({ 
    success: true, 
    messages: messages.slice(-100), 
    total: messages.length 
  });
});

// DOWNLOAD: JSON com todos os grupos
app.get('/api/download/groups-json', (req, res) => {
  const data = {
    exportDate: new Date().toISOString(),
    totalGroups: waService.groups.length,
    groups: waService.groups
  };
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename=grupos_whatsapp.json');
  res.send(JSON.stringify(data, null, 2));
});

// DOWNLOAD: TXT com nomes e IDs
app.get('/api/download/groups-txt', (req, res) => {
  const txt = waService.groups
    .map(g => `${g.name} = ${g.id}`)
    .join('\n');
  res.setHeader('Content-Type', 'text/plain');
  res.setHeader('Content-Disposition', 'attachment; filename=grupos_ids.txt');
  res.send(txt);
});

// DOWNLOAD: ZIP com tudo (JSON + TXT + Mensagens)
app.get('/api/download/all', (req, res) => {
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename=whatsapp_data.zip');
  
  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.pipe(res);
  
  // Adicionar JSON de grupos
  archive.append(
    JSON.stringify({
      exportDate: new Date().toISOString(),
      totalGroups: waService.groups.length,
      groups: waService.groups
    }, null, 2), 
    { name: 'grupos_whatsapp.json' }
  );
  
  // Adicionar TXT de IDs
  archive.append(
    waService.groups.map(g => `${g.name} = ${g.id}`).join('\n'),
    { name: 'grupos_ids.txt' }
  );
  
  // Adicionar mensagens (se existirem)
  if (waService.recentMessages.length > 0) {
    archive.append(
      JSON.stringify({
        exportDate: new Date().toISOString(),
        totalMessages: waService.recentMessages.length,
        messages: waService.recentMessages.slice(-500)
      }, null, 2),
      { name: 'mensagens.json' }
    );
  }
  
  archive.finalize();
});

// ROTA: Página inicial
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// WEBSOCKET: Conexão em tempo real
io.on('connection', (socket) => {
  console.log('🟢 Cliente conectado ao WebSocket');
  
  // Enviar QR Code imediatamente se já existir
  if (waService.qrCode) {
    socket.emit('qr-code', waService.qrCode);
  }
  
  // Enviar status atual
  socket.emit('status-update', {
    connected: waService.isConnected,
    groups: waService.groups,
    messages: waService.recentMessages.slice(-20)
  });
  
  // Cliente solicita QR Code
  socket.on('get-qr', () => {
    if (waService.qrCode) {
      socket.emit('qr-code', waService.qrCode);
    }
  });
  
  // Cliente solicita grupos
  socket.on('get-groups', () => {
    socket.emit('groups-update', waService.groups);
  });
  
  socket.on('disconnect', () => {
    console.log('🔴 Cliente desconectado do WebSocket');
  });
});

// AUTO-PING: Manter serviço vivo no Render
setInterval(() => {
  const url = process.env.RENDER_EXTERNAL_URL;
  if (url) {
    http.get(url + '/api/status', (res) => {
      console.log('🔄 Ping de manutenção:', res.statusCode);
    }).on('error', () => {});
  }
}, 600000); // A cada 10 minutos

// INICIAR SERVIDOR
const PORT = process.env.PORT || 10000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 Painel rodando na porta ${PORT}`);
  console.log(`📱 Acesse o painel para escanear o QR Code\n`);
  
  // Iniciar WhatsApp com pequeno delay
  setTimeout(() => {
    waService.connect();
  }, 2000);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('👋 Encerrando servidor...');
  server.close();
  process.exit(0);
});
