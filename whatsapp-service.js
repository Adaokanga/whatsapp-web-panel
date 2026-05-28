const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  makeInMemoryStore,
  fetchLatestBaileysVersion,
  delay
} = require('@whiskeysockets/baileys');

const pino = require('pino');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');

class WhatsAppService {
  constructor(io) {
    this.io = io;
    this.sock = null;
    this.isConnected = false;
    this.qrCode = null;
    this.groups = [];
    this.recentMessages = [];
    this.messageCount = 0;
    this.startTime = null;
  }

  async connect() {
    try {
      const { state, saveCreds } = await useMultiFileAuthState('auth_baileys');
      
      this.sock = makeWASocket({
        printQRInTerminal: false,
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: ['WhatsApp Panel', 'Chrome', '1.0.0'],
        markOnlineOnConnect: true,
        syncFullHistory: false,
        connectTimeoutMs: 60000
      });

      this.sock.ev.on('creds.update', saveCreds);

      this.sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          // Gerar QR Code em base64 para o frontend
          const qrImage = await qrcode.toDataURL(qr);
          this.qrCode = qrImage;
          this.io.emit('qr-code', qrImage);
          console.log('📱 QR Code gerado! Escaneie no WhatsApp.');
        }

        if (connection === 'open') {
          this.isConnected = true;
          this.qrCode = null;
          this.startTime = new Date();
          console.log('✅ WhatsApp conectado!');
          this.io.emit('connection-status', { connected: true });
          
          // Carregar grupos
          await this.loadGroups();
          
          // Iniciar monitoramento
          this.monitorMessages();
        }

        if (connection === 'close') {
          this.isConnected = false;
          const statusCode = lastDisconnect?.error?.output?.statusCode;
          
          console.log('❌ Conexão fechada:', statusCode);
          this.io.emit('connection-status', { 
            connected: false, 
            reason: statusCode === DisconnectReason.loggedOut ? 'logged_out' : 'reconnecting' 
          });
          
          if (statusCode !== DisconnectReason.loggedOut) {
            setTimeout(() => this.connect(), 3000);
          } else {
            this.qrCode = null;
            this.io.emit('qr-code', null);
          }
        }
      });

      return this.sock;
    } catch (error) {
      console.error('Erro ao conectar:', error);
      this.io.emit('error', error.message);
    }
  }

  async loadGroups() {
    try {
      const chats = await this.sock.groupFetchAllParticipating();
      
      this.groups = Object.entries(chats).map(([id, group]) => ({
        id: id,
        name: group.subject,
        participants: group.participants.length,
        description: group.desc || 'Sem descrição',
        createdAt: new Date(group.creation * 1000).toISOString()
      }));

      // Ordenar por nome
      this.groups.sort((a, b) => a.name.localeCompare(b.name));

      // Salvar automaticamente
      this.saveGroupsToFile();
      
      // Emitir para o frontend
      this.io.emit('groups-update', this.groups);
      
      console.log(`📋 ${this.groups.length} grupos carregados`);
    } catch (error) {
      console.error('Erro ao carregar grupos:', error);
    }
  }

  saveGroupsToFile() {
    const data = {
      exportDate: new Date().toISOString(),
      totalGroups: this.groups.length,
      groups: this.groups
    };

    const filePath = path.join(__dirname, 'public', 'downloads');
    if (!fs.existsSync(filePath)) {
      fs.mkdirSync(filePath, { recursive: true });
    }

    fs.writeFileSync(
      path.join(filePath, 'grupos_whatsapp.json'),
      JSON.stringify(data, null, 2),
      'utf8'
    );
  }

  monitorMessages() {
    if (!this.sock) return;

    this.sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type === 'notify') {
        for (const msg of messages) {
          // Processar apenas mensagens de grupos
          if (msg.key.remoteJid && msg.key.remoteJid.includes('@g.us')) {
            const messageData = {
              id: msg.key.id,
              groupId: msg.key.remoteJid,
              groupName: this.getGroupName(msg.key.remoteJid),
              from: msg.key.participant || msg.key.remoteJid,
              fromName: msg.pushName || 'Desconhecido',
              messageType: this.getMessageType(msg),
              content: this.extractMessageContent(msg),
              timestamp: new Date(msg.messageTimestamp * 1000).toISOString(),
              raw: msg
            };

            this.recentMessages.push(messageData);
            this.messageCount++;

            // Manter apenas últimas 1000 mensagens
            if (this.recentMessages.length > 1000) {
              this.recentMessages = this.recentMessages.slice(-1000);
            }

            // Emitir nova mensagem em tempo real
            this.io.emit('new-message', messageData);
            this.io.emit('message-count', this.messageCount);

            // Log no console
            const time = new Date().toLocaleTimeString('pt-BR');
            console.log(`[${time}] ${messageData.groupName} - ${messageData.fromName}: ${messageData.content}`);
          }
        }
      }
    });
  }

  getGroupName(groupId) {
    const group = this.groups.find(g => g.id === groupId);
    return group ? group.name : groupId;
  }

  getMessageType(msg) {
    if (msg.message) {
      const types = Object.keys(msg.message);
      return types[0] || 'unknown';
    }
    return 'unknown';
  }

  extractMessageContent(msg) {
    if (!msg.message) return '[Mensagem vazia]';

    const messageType = this.getMessageType(msg);
    const messageContent = msg.message[messageType];

    switch (messageType) {
      case 'conversation':
        return messageContent;
      case 'extendedTextMessage':
        return messageContent.text || '[Mensagem de texto]';
      case 'imageMessage':
        return `📷 Imagem${messageContent.caption ? ': ' + messageContent.caption : ''}`;
      case 'videoMessage':
        return `🎥 Vídeo${messageContent.caption ? ': ' + messageContent.caption : ''}`;
      case 'audioMessage':
        return '🎵 Áudio';
      case 'documentMessage':
        return `📄 Documento: ${messageContent.fileName || 'Arquivo'}`;
      case 'stickerMessage':
        return '🏷️ Figurinha';
      case 'locationMessage':
        return '📍 Localização';
      case 'contactMessage':
        return '👤 Contato';
      case 'reactionMessage':
        return `Reação: ${messageContent.text || '❤️'}`;
      case 'pollCreationMessage':
        return `📊 Enquete: ${messageContent.name || 'Sem título'}`;
      default:
        return `[${messageType}]`;
    }
  }

  async disconnect() {
    if (this.sock) {
      await this.sock.logout();
      this.sock = null;
      this.isConnected = false;
      this.qrCode = null;
      this.io.emit('connection-status', { connected: false, reason: 'user_disconnect' });
    }
  }
}

module.exports = WhatsAppService;
