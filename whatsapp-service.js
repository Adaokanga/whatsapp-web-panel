const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore
} = require('@whiskeysockets/baileys');

const pino = require('pino');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');
const NodeCache = require('node-cache');

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
    this.retryCount = 0;
    this.maxRetries = 10;
  }

  async connect() {
    try {
      // Limpar QR anterior
      this.qrCode = null;
      this.io.emit('qr-code', null);
      
      const { state, saveCreds } = await useMultiFileAuthState('auth_baileys');
      
      const { version } = await fetchLatestBaileysVersion();
      
      this.sock = makeWASocket({
        version,
        printQRInTerminal: true,
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
        },
        logger: pino({ level: 'silent' }),
        browser: ['WhatsApp Panel', 'Chrome', '20.0.0'],
        markOnlineOnConnect: true,
        syncFullHistory: false,
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        generateHighQualityLinkPreview: true,
        patchMessageBeforeSending: (message) => {
          return message;
        },
        getMessage: async (key) => {
          return { conversation: 'Mensagem não disponível' };
        }
      });

      this.sock.ev.on('creds.update', saveCreds);

      this.sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        console.log('Status conexão:', connection, qr ? 'QR disponível' : '');

        if (qr) {
          try {
            const qrImage = await qrcode.toDataURL(qr);
            this.qrCode = qrImage;
            this.io.emit('qr-code', qrImage);
            console.log('📱 QR Code gerado!');
          } catch (err) {
            console.error('Erro ao gerar QR:', err);
          }
        }

        if (connection === 'open') {
          this.isConnected = true;
          this.qrCode = null;
          this.retryCount = 0;
          this.startTime = new Date();
          console.log('✅ WhatsApp conectado!');
          
          this.io.emit('connection-status', { connected: true });
          this.io.emit('qr-code', null);
          
          await this.loadGroups();
          this.monitorMessages();
        }

        if (connection === 'close') {
          const statusCode = lastDisconnect?.error?.output?.statusCode;
          console.log('❌ Conexão fechada - Status:', statusCode);
          
          this.isConnected = false;
          
          if (statusCode === DisconnectReason.loggedOut) {
            console.log('Sessão expirada. Limpando auth...');
            this.cleanAuth();
            this.qrCode = null;
            this.io.emit('connection-status', { connected: false, reason: 'logged_out' });
            this.io.emit('qr-code', null);
            
            setTimeout(() => this.connect(), 5000);
          } else if (statusCode === DisconnectReason.badSession) {
            console.log('Sessão inválida. Limpando...');
            this.cleanAuth();
            setTimeout(() => this.connect(), 3000);
          } else if (this.retryCount < this.maxRetries) {
            this.retryCount++;
            const delay = Math.min(1000 * Math.pow(2, this.retryCount), 60000);
            console.log(`Tentativa ${this.retryCount}/${this.maxRetries} em ${delay/1000}s`);
            
            this.io.emit('connection-status', { 
              connected: false, 
              reason: 'reconnecting',
              attempt: this.retryCount
            });
            
            setTimeout(() => this.connect(), delay);
          } else {
            console.log('Máximo de tentativas atingido');
            this.io.emit('connection-status', { connected: false, reason: 'max_retries' });
          }
        }
      });

      return this.sock;
    } catch (error) {
      console.error('Erro ao conectar:', error.message);
      this.io.emit('error', error.message);
      
      if (this.retryCount < this.maxRetries) {
        this.retryCount++;
        setTimeout(() => this.connect(), 10000);
      }
    }
  }

  cleanAuth() {
    const authPath = path.join(__dirname, 'auth_baileys');
    if (fs.existsSync(authPath)) {
      fs.rmSync(authPath, { recursive: true, force: true });
      console.log('Pasta auth_baileys removida');
    }
  }

  async loadGroups() {
    try {
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      const chats = await this.sock.groupFetchAllParticipating();
      
      if (chats && Object.keys(chats).length > 0) {
        this.groups = Object.entries(chats).map(([id, group]) => ({
          id: id,
          name: group.subject,
          participants: group.participants?.length || 0,
          description: group.desc || 'Sem descrição',
          createdAt: new Date(group.creation * 1000).toISOString()
        }));

        this.groups.sort((a, b) => a.name.localeCompare(b.name));
        
        this.saveGroupsToFile();
        this.io.emit('groups-update', this.groups);
        
        console.log(`📋 ${this.groups.length} grupos carregados`);
      } else {
        console.log('Nenhum grupo encontrado');
        this.io.emit('groups-update', []);
      }
    } catch (error) {
      console.error('Erro ao carregar grupos:', error.message);
      setTimeout(() => this.loadGroups(), 5000);
    }
  }

  saveGroupsToFile() {
    try {
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
    } catch (error) {
      console.error('Erro ao salvar arquivo:', error);
    }
  }

  monitorMessages() {
    if (!this.sock) return;

    this.sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type === 'notify') {
        for (const msg of messages) {
          if (msg.key?.remoteJid?.includes('@g.us')) {
            const messageData = {
              id: msg.key.id,
              groupId: msg.key.remoteJid,
              groupName: this.getGroupName(msg.key.remoteJid),
              from: msg.key.participant || msg.key.remoteJid,
              fromName: msg.pushName || 'Desconhecido',
              messageType: this.getMessageType(msg),
              content: this.extractMessageContent(msg),
              timestamp: new Date(msg.messageTimestamp * 1000).toISOString()
            };

            this.recentMessages.push(messageData);
            this.messageCount++;

            if (this.recentMessages.length > 1000) {
              this.recentMessages = this.recentMessages.slice(-500);
            }

            this.io.emit('new-message', messageData);
            this.io.emit('message-count', this.messageCount);

            const time = new Date().toLocaleTimeString('pt-BR');
            console.log(`[${time}] ${messageData.groupName}: ${messageData.content?.substring(0, 100)}`);
          }
        }
      }
    });
  }

  getGroupName(groupId) {
    const group = this.groups.find(g => g.id === groupId);
    return group ? group.name : 'Grupo Desconhecido';
  }

  getMessageType(msg) {
    if (msg.message) {
      const keys = Object.keys(msg.message);
      return keys[0] || 'unknown';
    }
    return 'unknown';
  }

  extractMessageContent(msg) {
    if (!msg.message) return '[Mensagem vazia]';

    const type = this.getMessageType(msg);
    const content = msg.message[type];

    switch (type) {
      case 'conversation':
        return content || '';
      case 'extendedTextMessage':
        return content?.text || '[Texto]';
      case 'imageMessage':
        return `📷 Imagem${content?.caption ? ': ' + content.caption : ''}`;
      case 'videoMessage':
        return `🎥 Vídeo${content?.caption ? ': ' + content.caption : ''}`;
      case 'audioMessage':
        return '🎵 Mensagem de áudio';
      case 'documentMessage':
        return `📄 ${content?.fileName || 'Documento'}`;
      case 'stickerMessage':
        return '🏷️ Figurinha';
      case 'locationMessage':
        return '📍 Localização';
      case 'contactMessage':
        return '👤 Contato';
      default:
        return `[${type}]`;
    }
  }
}

module.exports = WhatsAppService;