// Enhanced Global server for Render deployment - handles API and session management with client forwarding
const express = require('express');
const cors = require('cors');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;

app.use(cors({
  origin: ['https://meet.google.com', 'chrome-extension://*', 'http://localhost:*', 'https://*.onrender.com'],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// Request logging
app.use((req, res, next) => {
  console.log(`[📡] ${req.method} ${req.path} - ${new Date().toISOString()}`);
  next();
});

class GlobalMeetRecorderBackend {
  constructor() {
    this.activeSessions = new Map();
    this.connectedClients = new Map(); // WebSocket connections to local clients
    this.clientHealth = new Map(); // Track client health status
    this.init();
  }

  init() {
    console.log('[🌐] Global server initialized');
    console.log('[🔍] System check:', {
      platform: process.platform,
      nodejs: process.version,
      environment: 'GLOBAL_SERVER',
      port: PORT
    });

    // Health check interval for connected clients
    setInterval(() => {
      this.performClientHealthCheck();
    }, 30000); // Every 30 seconds
  }

  // Register a local client (user's machine)
  registerClient(ws, clientData) {
    const { clientId, platform, hostname } = clientData;
    
    this.connectedClients.set(clientId, {
      ws,
      connected: true,
      lastPing: Date.now(),
      platform,
      hostname,
      registeredAt: new Date()
    });

    this.clientHealth.set(clientId, {
      status: 'healthy',
      lastHealthCheck: Date.now(),
      ffmpegAvailable: false
    });

    console.log(`[✅] Client registered: ${clientId} (${platform})`);
    
    // Immediately check client system requirements
    this.checkClientSystemRequirements(clientId).catch(console.error);
  }

  // Remove disconnected client
  removeClient(clientId) {
    this.connectedClients.delete(clientId);
    this.clientHealth.delete(clientId);
    
    // Clean up any active sessions for this client
    for (const [sessionId, session] of this.activeSessions) {
      if (session.clientId === clientId) {
        session.status = 'client_disconnected';
        console.log(`[⚠️] Session ${sessionId} marked as disconnected due to client removal`);
      }
    }
    
    console.log(`[❌] Client removed: ${clientId}`);
  }

  // Perform health check on all connected clients
  async performClientHealthCheck() {
    for (const [clientId, client] of this.connectedClients) {
      try {
        const healthData = await this.sendToLocalClient(clientId, 'SYSTEM_CHECK', {}, 10000); // 10s timeout
        
        this.clientHealth.set(clientId, {
          status: 'healthy',
          lastHealthCheck: Date.now(),
          ffmpegAvailable: healthData.ffmpeg || false,
          audioDevices: healthData.audioDevices || [],
          platform: healthData.platform
        });
        
        console.log(`[💚] Client ${clientId} health check passed`);
      } catch (error) {
        console.warn(`[💛] Client ${clientId} health check failed:`, error.message);
        
        this.clientHealth.set(clientId, {
          status: 'unhealthy',
          lastHealthCheck: Date.now(),
          error: error.message
        });
      }
    }
  }

  // Send command to local client with improved error handling
  async sendToLocalClient(clientId, command, data = {}, timeout = 30000) {
    const client = this.connectedClients.get(clientId);
    if (!client || !client.connected) {
      throw new Error(`Local client ${clientId} not connected`);
    }

    if (client.ws.readyState !== WebSocket.OPEN) {
      throw new Error(`Local client ${clientId} WebSocket not ready`);
    }

    return new Promise((resolve, reject) => {
      const messageId = `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      const message = {
        id: messageId,
        command,
        data,
        timestamp: new Date().toISOString()
      };

      let responseReceived = false;

      // Set up response handler
      const responseHandler = (event) => {
        try {
          const response = JSON.parse(event.data);
          if (response.type === 'RESPONSE' && response.id === messageId) {
            responseReceived = true;
            client.ws.removeEventListener('message', responseHandler);
            
            if (response.success) {
              resolve(response.data);
            } else {
              reject(new Error(response.error || 'Unknown client error'));
            }
          }
        } catch (e) {
          // Ignore parsing errors for other messages
        }
      };

      client.ws.addEventListener('message', responseHandler);
      
      // Send command
      try {
        client.ws.send(JSON.stringify(message));
        console.log(`[📤] Sent command ${command} to client ${clientId}`);
      } catch (sendError) {
        client.ws.removeEventListener('message', responseHandler);
        reject(new Error(`Failed to send command to client: ${sendError.message}`));
        return;
      }

      // Timeout handler
      const timeoutId = setTimeout(() => {
        if (!responseReceived) {
          client.ws.removeEventListener('message', responseHandler);
          reject(new Error(`Local client response timeout (${timeout}ms)`));
        }
      }, timeout);

      // Clean up timeout when response is received
      const originalResolve = resolve;
      const originalReject = reject;
      
      resolve = (value) => {
        clearTimeout(timeoutId);
        originalResolve(value);
      };
      
      reject = (error) => {
        clearTimeout(timeoutId);
        originalReject(error);
      };
    });
  }

  // Find best available client for recording
  findBestClient() {
    let bestClient = null;
    let bestScore = -1;

    for (const [clientId, health] of this.clientHealth) {
      if (health.status !== 'healthy' || !health.ffmpegAvailable) continue;
      
      const client = this.connectedClients.get(clientId);
      if (!client || !client.connected) continue;

      // Score based on various factors
      let score = 100;
      
      // Prefer clients with fewer active sessions
      const activeSessions = Array.from(this.activeSessions.values())
        .filter(s => s.clientId === clientId && s.status === 'recording').length;
      score -= (activeSessions * 10);
      
      // Prefer clients with more audio devices
      score += (health.audioDevices?.length || 0);
      
      // Prefer recent health checks
      const timeSinceHealthCheck = Date.now() - health.lastHealthCheck;
      if (timeSinceHealthCheck < 60000) score += 10; // Within last minute
      
      if (score > bestScore) {
        bestScore = score;
        bestClient = clientId;
      }
    }

    return bestClient;
  }

  async startRecording(meetUrl, sessionId, clientId, options = {}) {
    try {
      // If no specific client requested, find the best available one
      if (!clientId) {
        clientId = this.findBestClient();
        if (!clientId) {
          throw new Error('No healthy clients available for recording');
        }
      }

      console.log(`[🎬] Starting recording for session: ${sessionId} on client: ${clientId}`);
      
      // Send start command to local client
      const result = await this.sendToLocalClient(clientId, 'START_RECORDING', {
        meetUrl,
        sessionId,
        options
      });

      // Store session info
      this.activeSessions.set(sessionId, {
        clientId,
        meetUrl,
        startTime: new Date(),
        options,
        status: 'recording'
      });

      return { success: true, sessionId, ...result };
    } catch (error) {
      console.error(`[❌] Error starting recording:`, error);
      throw error;
    }
  }

  async stopRecording(sessionId) {
    const session = this.activeSessions.get(sessionId);
    if (!session) {
      return { success: false, message: 'No active recording found' };
    }

    try {
      console.log(`[🛑] Stopping recording for session: ${sessionId}`);

      // Send stop command to local client
      const result = await this.sendToLocalClient(session.clientId, 'STOP_RECORDING', {
        sessionId
      });

      // Update session status
      session.status = 'stopped';
      session.endTime = new Date();

      return { success: true, sessionId, ...result };
    } catch (error) {
      console.error(`[❌] Error stopping recording:`, error);
      throw error;
    }
  }

  async getActiveRecordings() {
    const recordings = [];
    for (const [sessionId, session] of this.activeSessions) {
      if (session.status === 'recording') {
        recordings.push({
          sessionId,
          clientId: session.clientId,
          meetUrl: session.meetUrl,
          startTime: session.startTime,
          duration: new Date() - session.startTime
        });
      }
    }
    return recordings;
  }

  async checkClientSystemRequirements(clientId) {
    try {
      const requirements = await this.sendToLocalClient(clientId, 'SYSTEM_CHECK');
      return requirements;
    } catch (error) {
      return { error: error.message };
    }
  }
}

const recorder = new GlobalMeetRecorderBackend();

// WebSocket connection handling
wss.on('connection', (ws, req) => {
  console.log('[🔌] New WebSocket connection');
  
ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      
      switch (data.type) {
        case 'REGISTER_CLIENT':
          recorder.registerClient(ws, data);
          ws.send(JSON.stringify({
            type: 'REGISTRATION_SUCCESS',
            clientId: data.clientId
          }));
          break;
          
        case 'FORWARD_COMMAND':
          // Handle command forwarding from local client to global server
          const { command, data: commandData, clientId, id } = data;
          
          // Execute the command and send response back
          (async () => {
            try {
              let result;
              
              switch (command) {
                case 'START_RECORDING':
                  result = await recorder.startRecording(
                    commandData.meetUrl, 
                    commandData.sessionId, 
                    commandData.clientId || clientId, 
                    commandData.options
                  );
                  break;
                  
                case 'STOP_RECORDING':
                  result = await recorder.stopRecording(commandData.sessionId);
                  break;
                  
                default:
                  throw new Error(`Unknown forwarded command: ${command}`);
              }
              
              ws.send(JSON.stringify({
                id,
                success: true,
                data: result
              }));
              
            } catch (error) {
              ws.send(JSON.stringify({
                id,
                success: false,
                error: error.message
              }));
            }
          })();
          break;
          
        case 'PING':
          ws.send(JSON.stringify({ type: 'PONG', timestamp: Date.now() }));
          break;
          
        case 'RESPONSE':
          // Response from local client - handled by sendToLocalClient promise
          break;
          
        default:
          console.log('[📨] Unknown message type:', data.type);
      }
    } catch (error) {
      console.error('[❌] WebSocket message error:', error);
    }
  });
  ws.on('close', () => {
    console.log('[🔌] WebSocket connection closed');
    // Remove client from connected clients
    for (const [clientId, client] of recorder.connectedClients) {
      if (client.ws === ws) {
        recorder.connectedClients.delete(clientId);
        console.log(`[❌] Client disconnected: ${clientId}`);
        break;
      }
    }
  });
});

// API Routes
app.get('/api/system-check/:clientId', async (req, res) => {
  try {
    const { clientId } = req.params;
    const requirements = await recorder.checkClientSystemRequirements(clientId);
    res.status(200).json({
      success: true,
      clientId,
      ...requirements
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/start-recording', async (req, res) => {
  try {
    const { meetUrl, sessionId, clientId, options } = req.body;
    
    if (!meetUrl || !sessionId || !clientId) {
      return res.status(400).json({ 
        error: 'meetUrl, sessionId, and clientId are required' 
      });
    }

    const result = await recorder.startRecording(meetUrl, sessionId, clientId, options);
    res.json(result);
  } catch (error) {
    console.error('[❌] Start recording error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/stop-recording', async (req, res) => {
  try {
    const { sessionId } = req.body;
    
    if (!sessionId) {
      return res.status(400).json({ error: 'sessionId is required' });
    }

    const result = await recorder.stopRecording(sessionId);
    res.json(result);
  } catch (error) {
    console.error('[❌] Stop recording error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/active-recordings', async (req, res) => {
  try {
    const recordings = await recorder.getActiveRecordings();
    res.json({ recordings });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/connected-clients', (req, res) => {
  try {
    const clients = [];
    for (const [clientId, client] of recorder.connectedClients) {
      clients.push({
        clientId,
        connected: client.connected,
        lastPing: client.lastPing
      });
    }
    res.json({ clients });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    platform: process.platform,
    activeSessions: recorder.activeSessions.size,
    connectedClients: recorder.connectedClients.size,
    environment: 'GLOBAL_SERVER'
  });
});

app.post('/api/ping', (req, res) => {
  res.json({ success: true, message: 'Global backend is alive!' });
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('[❌] Unhandled error:', error);
  res.status(500).json({ error: 'Internal server error' });
});

server.listen(PORT, () => {
  console.log(`[🚀] Global Meet Recorder Backend running on port ${PORT}`);
  console.log(`[💻] Platform: ${process.platform}`);
  console.log(`[🌐] Environment: GLOBAL_SERVER`);
});

module.exports = { GlobalMeetRecorderBackend };