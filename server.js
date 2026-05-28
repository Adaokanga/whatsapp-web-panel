const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const path = require('path');
const fs = require('fs');
const archiver = require('archiver');
const WhatsAppService = require('./whatsapp-service');

const app = express();
const server = http.createServer(app);
const io = socketIO(server);

// Servir arquivos estáticos
app.use(express.static('public'));
app.use(express.json());

// Instanciar serviço do WhatsApp
const waService = new WhatsAppService(io);

// Rotas da API
app.get('/api/status', (req, res) => {
  res.json({
    connected: waService.isConnected,
    qrCode: waService.qrCode,
    groups: waService.groups,
    messages: waService.recentMessages.slice(-50)
  });
});

app.get('/api/groups', (req, res) => {
  res.json({
    groups: waService.groups,
    total: waService.groups.length
  });
});

app.get('/api/messages/:groupId?', (req, res) => {
  const { groupId } = req.params;
  let messages = waService.recentMessages;
  
  if (groupId) {
    messages = messages.filter(m => m.groupId === groupId);
  }
  
  res.json({
    messages: messages.slice(-100),
    total: messages.length
  });
});

// Rota para download do JSON
app.get('/api/download/groups-json', (req, res) => {
  const groupsData = {
    exportDate: new Date().toISOString(),
    totalGroups: waService.groups.length,
    groups: waService.groups
  };
  
  const jsonContent = JSON.stringify(groupsData, null, 2);
  
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename=grupos_whatsapp.json');
  res.send(jsonContent);
});

// Rota para download do TXT
app.get('/api/download/groups-txt', (req, res) => {
  const txtContent = waService.groups
    .map(g => `${g.name} = ${g.id}`)
    .join('\n');
  
  res.setHeader('Content-Type', 'text/plain');
  res.setHeader('Content-Disposition', 'attachment; filename=grupos_ids.txt');
  res.send(txtContent);
});

// Rota para download do ZIP com tudo
app.get('/api/download/all', (req, res) => {
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename=whatsapp_data.zip');
  
  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.pipe(res);
  
  // Adicionar JSON
  const groupsJSON = JSON.stringify({
    exportDate: new Date().toISOString(),
    totalGroups: waService.groups.length,
    groups: waService.groups
  }, null, 2);
  archive.append(groupsJSON, { name: 'grupos_whatsapp.json' });
  
  // Adicionar TXT com IDs
  const idsTXT = waService.groups.map(g => `${g.name} = ${g.id}`).join('\n');
  archive.append(idsTXT, { name: 'grupos_ids.txt' });
  
  // Adicionar mensagens se existirem
  if (waService.recentMessages.length > 0) {
    const messagesJSON = JSON.stringify({
      exportDate: new Date().toISOString(),
      totalMessages: waService.recentMessages.length,
      messages: waService.recentMessages
    }, null, 2);
    archive.append(messagesJSON, { name: 'mensagens.json' });
  }
  
  archive.finalize();
});

// Rota para página inicial
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// WebSocket connection
io.on('connection', (socket) => {
  console.log('🟢 Cliente conectado ao painel');
  
  socket.on('get-status', () => {
    socket.emit('status-update', {
      connected: waService.isConnected,
      qrCode: waService.qrCode,
      groups: waService.groups,
      messages: waService.recentMessages.slice(-20)
    });
  });
  
  socket.on('request-groups', () => {
    socket.emit('groups-update', waService.groups);
  });
  
  socket.on('disconnect', () => {
    console.log('🔴 Cliente desconectado');
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🚀 Painel rodando em: http://localhost:${PORT}`);
  console.log('📱 Abra o navegador e escaneie o QR Code\n');
  
  // Iniciar conexão WhatsApp
  waService.connect();
});
