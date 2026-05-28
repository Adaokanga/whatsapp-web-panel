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
      
      console.log('🔄 Iniciando conexão com WhatsApp...');
      
      const { state, saveCreds } = await useMultiFileAuthState('auth_baileys');
      const { version } = await fetchLatestBaileysVersion();
      
      this.sock = makeWASocket({
        version,
        printQRInTerminal: false,
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
        },
        logger: pino({ level: 'silent' }),
        browser: ['WhatsApp Panel', 'Chrome', '20.0.0'],
        markOnlineOnConnect: true,
        syncFullHistory: false,
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000
      });

      // Salvar credenciais quando atualizadas
      this.sock.ev.on('creds.update', saveCreds);

      // Monitorar atualizações de conexão
      this.sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        console.log('📡 Status:', connection || 'iniciando', qr ? '| QR disponível' : '');

        // QR Code gerado
        if (qr) {
          try {
            const qrImage = await qrcode.toDataURL(qr);
            this.qrCode = qrImage;
            this.io.emit('qr-code', qrImage);
            console.log('📱 QR Code gerado com sucesso!');
          } catch (err) {
            console.error('❌ Erro ao gerar QR Code:', err.message);
          }
        }

        // Conexão estabelecida
        if (connection === 'open') {
          this.isConnected = true;
          this.qrCode = null;
          this.retryCount = 0;
          this.startTime = new Date();
          
          console.log('✅ WhatsApp conectado com sucesso!');
          console.log('📋 Carregando grupos...');
          
          this.io.emit('connection-status', { connected: true });
          this.io.emit('qr-code', null);
          
          // Carregar grupos e monitorar mensagens
          await this.loadGroups();
          this.monitorMessages();
        }

        // Conexão fechada
        if (connection === 'close') {
          const statusCode = lastDisconnect?.error?.output?.statusCode;
          console.log('❌ Conexão fechada - Código:', statusCode);
          
          this.isConnected = false;
          
          // Logout detectado
          if (statusCode === DisconnectReason.loggedOut) {
            console.log('🔄 Sessão expirada. Gerando novo QR Code...');
            this.cleanAuth();
            this.qrCode = null;
            this.io.emit('connection-status', { connected: false, reason: 'logged_out' });
            this.io.emit('qr-code', null);
            setTimeout(() => this.connect(), 3000);
          } 
          // Sessão inválida
          else if (statusCode === DisconnectReason.badSession) {
            console.log('🔄 Sessão inválida. Limpando e reconectando...');
            this.cleanAuth();
            setTimeout(() => this.connect(), 3000);
          } 
          // Tentar reconectar
          else if (this.retryCount < this.maxRetries) {
            this.retryCount++;
            const delay = Math.min(2000 * Math.pow(2, this.retryCount), 60000);
            console.log(`🔄 Tentativa ${this.retryCount}/${this.maxRetries} em ${delay/1000}s`);
            
            this.io.emit('connection-status', { 
              connected: false, 
              reason: 'reconnecting',
              attempt: this.retryCount
            });
            
            setTimeout(() => this.connect(), delay);
          } 
          // Máximo de tentativas
          else {
            console.log('❌ Máximo de tentativas atingido. Reinicie o serviço.');
            this.io.emit('connection-status', { 
              connected: false, 
              reason: 'max_retries' 
            });
          }
        }
      });

      return this.sock;
    } catch (error) {
      console.error('❌ Erro ao conectar:', error.message);
      if (this.retryCount < this.maxRetries) {
        this.retryCount++;
        setTimeout(() => this.connect(), 10000);
      }
    }
  }

  // Limpar pasta de autenticação
  cleanAuth() {
    const authPath = path.join(__dirname, 'auth_baileys');
    if (fs.existsSync(authPath)) {
      try {
        fs.rmSync(authPath, { recursive: true, force: true });
        console.log('🗑️ Pasta auth_baileys removida');
      } catch (error) {
        console.error('❌ Erro ao remover auth:', error.message);
      }
    }
  }

  // Carregar lista de grupos
  async loadGroups() {
    try {
      // Pequeno delay para garantir conexão estável
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      const chats = await this.sock.groupFetchAllParticipating();
      
      if (chats && Object.keys(chats).length > 0) {
        this.groups = Object.entries(chats).map(([id, group]) => ({
          id: id,
          name: group.subject || 'Sem nome',
          participants: group.participants?.length || 0,
          description: group.desc || 'Sem descrição',
          createdAt: new Date((group.creation || 0) * 1000).toISOString()
        }));

        // Ordenar alfabeticamente
        this.groups.sort((a, b) => a.name.localeCompare(b.name));
        
        // Salvar em arquivo
        this.saveGroupsToFile();
        
        // Enviar para frontend
        this.io.emit('groups-update', this.groups);
        
        console.log(`📋 ${this.groups.length} grupos carregados`);
        this.groups.forEach(g => {
          console.log(`  📌 ${g.name} (${g.participants} participantes)`);
        });
      } else {
        console.log('ℹ️ Nenhum grupo encontrado');
        this.io.emit('groups-update', []);
      }
    } catch (error) {
      console.error('❌ Erro ao carregar grupos:', error.message);
      // Tentar novamente em 5 segundos
      setTimeout(() => this.loadGroups(), 5000);
    }
  }

  // Salvar grupos em arquivo JSON
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
      console.log('💾 Grupos salvos em JSON');
    } catch (error) {
      console.error('❌ Erro ao salvar arquivo:', error.message);
    }
  }

  // Monitorar mensagens em tempo real
  monitorMessages() {
    if (!this.sock) return;

    this.sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type === 'notify') {
        for (const msg of messages) {
          // Apenas mensagens de grupos
          if (msg.key?.remoteJid?.includes('@g.us')) {
            const messageData = {
              id: msg.key.id,
              groupId: msg.key.remoteJid,
              groupName: this.getGroupName(msg.key.remoteJid),
              from: msg.key.participant || msg.key.remoteJid,
              fromName: msg.pushName || 'Desconhecido',
              messageType: this.getMessageType(msg),
              content: this.extractMessageContent(msg),
              timestamp: new Date((msg.messageTimestamp || 0) * 1000).toISOString()
            };

            // Armazenar mensagem
            this.recentMessages.push(messageData);
            this.messageCount++;

            // Limitar a 1000 mensagens em memória
            if (this.recentMessages.length > 1000) {
              this.recentMessages = this.recentMessages.slice(-500);
            }

            // Enviar para frontend em tempo real
            this.io.emit('new-message', messageData);
            this.io.emit('message-count', this.messageCount);

            // Log resumido
            const time = new Date().toLocaleTimeString('pt-BR');
            const preview = messageData.content?.substring(0, 80) || '';
            console.log(`💬 [${time}] ${messageData.groupName}: ${preview}${preview.length > 80 ? '...' : ''}`);
          }
        }
      }
    });

    console.log('👂 Monitoramento de mensagens ativado');
  }

  // Obter nome do grupo pelo ID
  getGroupName(groupId) {
    const group = this.groups.find(g => g.id === groupId);
    return group ? group.name : 'Grupo Desconhecido';
  }

  // Identificar tipo de mensagem
  getMessageType(msg) {
    if (msg.message) {
      const keys = Object.keys(msg.message);
      return keys[0] || 'unknown';
    }
    return 'unknown';
  }

  // Extrair conteúdo da mensagem
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
        return `🎵 Áudio${content?.ptt ? ' (Mensagem de voz)' : ''}`;
      case 'documentMessage':
        return `📄 Documento: ${content?.fileName || 'Arquivo'}`;
      case 'stickerMessage':
        return '🏷️ Figurinha';
      case 'locationMessage':
        return '📍 Localização compartilhada';
      case 'contactMessage':
        return '👤 Contato compartilhado';
      case 'reactionMessage':
        return `❤️ Reação: ${content?.text || 'emoji'}`;
      case 'pollCreationMessage':
        return `📊 Enquete: ${content?.name || 'Sem título'}`;
      default:
        return `[${type}]`;
    }
  }
}

module.exports = WhatsAppService;
