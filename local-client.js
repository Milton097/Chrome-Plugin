// Enhanced Local client that integrates with content script - handles FFmpeg and local resources
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const os = require('os');

class LocalMeetRecorderClient {
  constructor(globalServerUrl = 'wss://chrome-plugin-backend.onrender.com') { // Update with your Render URL
    this.globalServerUrl = globalServerUrl;
    this.clientId = this.generateClientId();
    this.ws = null;
    this.reconnectInterval = 5000;
    this.ffmpegPath = 'ffmpeg';
    this.activeSessions = new Map();
    this.recordingsDir = path.join(os.homedir(), 'Downloads', 'MeetRecordings');
    this.audioMuted = false; // Track if user muted audio in meet
    this.lastAudioCheck = Date.now();
    
    this.init();
  }

  generateClientId() {
    return `client_${os.hostname()}_${Date.now()}`;
  }

  async init() {
    await this.checkFFmpegPath();
    this.ensureRecordingsDir();
    this.connectToGlobalServer();
    this.setupLocalAPIServer(); // For content script communication
    
    console.log(`[🏠] Local client initialized: ${this.clientId}`);
    console.log(`[📁] Recordings directory: ${this.recordingsDir}`);
    console.log(`[🌐] Global server: ${this.globalServerUrl}`);
  }

  ensureRecordingsDir() {
    if (!fs.existsSync(this.recordingsDir)) {
      fs.mkdirSync(this.recordingsDir, { recursive: true });
    }
  }

  async checkFFmpegPath() {
    const isWindows = process.platform === 'win32';
    const localFFmpeg = path.join(__dirname, isWindows ? 'ffmpeg.exe' : 'ffmpeg');

    try {
      await fs.promises.access(localFFmpeg, fs.constants.X_OK);
      this.ffmpegPath = localFFmpeg;
      console.log(`[✅] Found local FFmpeg at: ${this.ffmpegPath}`);
    } catch {
      this.ffmpegPath = 'ffmpeg'; // fallback to system PATH
      console.log(`[⚠️] Local FFmpeg not found. Using system PATH: ${this.ffmpegPath}`);
    }
  }

  // Setup local HTTP server for content script communication
  setupLocalAPIServer() {
    const express = require('express');
    const cors = require('cors');
    const app = express();
    
    app.use(cors({
      origin: ['https://meet.google.com', 'chrome-extension://*'],
      credentials: true
    }));
    app.use(express.json());

    // Health check endpoint
    app.get('/api/health', (req, res) => {
      res.json({ 
        status: 'OK', 
        clientId: this.clientId,
        ffmpegAvailable: true,
        activeSessions: this.activeSessions.size
      });
    });

    // Start recording endpoint (called by content script)
    app.post('/api/start-recording', async (req, res) => {
      try {
        const { meetUrl, sessionId, options } = req.body;
        
        // Forward to global server with this client ID
        const result = await this.forwardToGlobalServer('START_RECORDING', {
          meetUrl,
          sessionId: sessionId || `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          clientId: this.clientId,
          options: {
            ...options,
            userName: options?.userName || 'Unknown',
            userRole: options?.userRole || 'participant'
          }
        });

        res.json(result);
      } catch (error) {
        console.error('[❌] Start recording error:', error);
        res.status(500).json({ error: error.message });
      }
    });

    // Stop recording endpoint
    app.post('/api/stop-recording', async (req, res) => {
      try {
        const { sessionId } = req.body;
        
        const result = await this.forwardToGlobalServer('STOP_RECORDING', {
          sessionId,
          clientId: this.clientId
        });

        res.json(result);
      } catch (error) {
        console.error('[❌] Stop recording error:', error);
        res.status(500).json({ error: error.message });
      }
    });

    // Audio mute state endpoint
    app.post('/api/audio-mute', (req, res) => {
      const { isMuted } = req.body;
      this.updateMuteState(isMuted);
      res.json({ success: true, audioMuted: this.audioMuted });
    });

    // Get audio devices
    app.get('/api/audio-devices', async (req, res) => {
      try {
        const devices = await this.getAudioDevices();
        res.json({ devices, success: true });
      } catch (error) {
        res.status(500).json({ error: error.message, devices: [] });
      }
    });

    // Download recording
    app.get('/api/download/:sessionId', (req, res) => {
      const { sessionId } = req.params;
      const session = this.activeSessions.get(sessionId);
      
      if (!session || !session.outputPath) {
        return res.status(404).json({ error: 'Recording not found' });
      }

      const filePath = session.outputPath;
      if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'Recording file not found' });
      }

      const fileName = path.basename(filePath);
      res.download(filePath, fileName, (err) => {
        if (err) {
          console.error('[❌] Download error:', err);
          res.status(500).json({ error: 'Download failed' });
        }
      });
    });

    const LOCAL_PORT = 3001; // Different from global server
    app.listen(LOCAL_PORT, () => {
      console.log(`[🚀] Local API server running on port ${LOCAL_PORT}`);
    });
  }

  // Forward commands to global server via WebSocket
  async forwardToGlobalServer(command, data) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('Not connected to global server'));
        return;
      }

      const messageId = Date.now().toString();
      const message = {
        type: 'FORWARD_COMMAND',
        id: messageId,
        command,
        data,
        clientId: this.clientId
      };

      // Set up response handler
      const responseHandler = (event) => {
        try {
          const response = JSON.parse(event.data);
          if (response.id === messageId) {
            this.ws.removeEventListener('message', responseHandler);
            if (response.success) {
              resolve(response.data);
            } else {
              reject(new Error(response.error));
            }
          }
        } catch (e) {
          // Ignore parsing errors for other messages
        }
      };

      this.ws.addEventListener('message', responseHandler);
      
      // Send command
      this.ws.send(JSON.stringify(message));

      // Timeout after 30 seconds
      setTimeout(() => {
        this.ws.removeEventListener('message', responseHandler);
        reject(new Error('Global server response timeout'));
      }, 30000);
    });
  }

  connectToGlobalServer() {
    try {
      this.ws = new WebSocket(this.globalServerUrl);

      this.ws.on('open', () => {
        console.log(`[🔌] Connected to global server`);
        this.registerWithServer();
      });

      this.ws.on('message', (data) => {
        this.handleServerMessage(JSON.parse(data.toString()));
      });

      this.ws.on('close', () => {
        console.log(`[🔌] Disconnected from global server. Reconnecting in ${this.reconnectInterval}ms...`);
        setTimeout(() => this.connectToGlobalServer(), this.reconnectInterval);
      });

      this.ws.on('error', (error) => {
        console.error(`[❌] WebSocket error:`, error);
      });

    } catch (error) {
      console.error(`[❌] Connection error:`, error);
      setTimeout(() => this.connectToGlobalServer(), this.reconnectInterval);
    }
  }

  registerWithServer() {
    this.sendToServer({
      type: 'REGISTER_CLIENT',
      clientId: this.clientId,
      platform: os.platform(),
      hostname: os.hostname()
    });
  }

  sendToServer(message) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

async handleServerMessage(message) {
    console.log(`[📨] Message from server:`, message.command || message.type);

    try {
      let response = { id: message.id, success: true };

      switch (message.command || message.type) {
        case 'START_RECORDING':
          response.data = await this.startRecording(
            message.data.meetUrl,
            message.data.sessionId,
            message.data.options
          );
          break;

        case 'STOP_RECORDING':
          response.data = await this.stopRecording(message.data.sessionId);
          break;

        case 'SYSTEM_CHECK':
          response.data = await this.checkSystemRequirements();
          break;

        case 'MUTE_AUDIO':
          this.audioMuted = true;
          this.restartRecordingWithoutAudio();
          response.data = { audioMuted: true };
          break;

        case 'UNMUTE_AUDIO':
          this.audioMuted = false;
          this.restartRecordingWithAudio();
          response.data = { audioMuted: false };
          break;

        case 'REGISTRATION_SUCCESS':
          console.log(`[✅] Registered with server as: ${message.clientId}`);
          return; // Don't send response for this

        default:
          response.success = false;
          response.error = `Unknown command: ${message.command || message.type}`;
      }

      // Only send response if we have an ID (meaning it expects a response)
      if (message.id) {
        this.sendToServer({
          type: 'RESPONSE',
          ...response
        });
      }

    } catch (error) {
      if (message.id) {
        this.sendToServer({
          type: 'RESPONSE',
          id: message.id,
          success: false,
          error: error.message
        });
      }
    }
  }
  
  async checkFFmpegInstallation() {
    return new Promise(resolve => {
      const check = spawn(this.ffmpegPath, ['-version']);
      check.on('error', () => resolve(false));
      check.on('exit', code => resolve(code === 0));
    });
  }

  async getAudioDevices() {
    return new Promise((resolve, reject) => {
      const isWindows = process.platform === 'win32';
      
      if (!isWindows) {
        // For non-Windows systems, use different approach
        resolve(['Default Audio Device']);
        return;
      }

      const ffmpeg = spawn(this.ffmpegPath, ['-list_devices', 'true', '-f', 'dshow', '-i', 'dummy']);
      let stderr = '';

      ffmpeg.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      ffmpeg.on('close', () => {
        const lines = stderr.split('\n');
        const audioDevices = [];

        lines.forEach((line) => {
          const trimmed = line.trim();
          const match = trimmed.match(/"([^"]+)"\s+\(audio\)/i);
          if (match) {
            audioDevices.push(match[1]);
          }
        });

        console.log('[🎤] Detected audio devices:', audioDevices);
        resolve(audioDevices.length > 0 ? audioDevices : ['Default Audio Device']);
      });

      ffmpeg.on('error', (err) => {
        console.warn('[⚠️] Error getting audio devices:', err);
        resolve(['Default Audio Device']);
      });
    });
  }

  startFFmpegRecording(sessionId, audioDevice, options = {}) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const userInfo = options.userName ? `_${options.userName.replace(/[^a-zA-Z0-9]/g, '')}` : '';
    const outputPath = path.join(this.recordingsDir, `${sessionId}${userInfo}_${timestamp}.mp4`);
    
    const isWindows = process.platform === 'win32';
    
    let ffmpegArgs;
    
    if (isWindows) {
      // Windows screen capture
      ffmpegArgs = [
        '-y',
        '-f', 'gdigrab',
        '-framerate', '25',
        '-i', 'desktop',
        
        // Only add audio if not muted and device available
        ...(audioDevice && !this.audioMuted ? ['-f', 'dshow', '-i', `audio=${audioDevice}`] : []),
        
        '-fflags', '+genpts',
        '-use_wallclock_as_timestamps', '1',
        
        '-map', '0:v:0',
        ...(audioDevice && !this.audioMuted ? ['-map', '1:a:0'] : []),
        
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-crf', '23',
        
        ...(audioDevice && !this.audioMuted ? ['-c:a', 'aac', '-b:a', '128k'] : ['-an']),
        
        '-pix_fmt', 'yuv420p',
        outputPath
      ];
    } else {
      // macOS/Linux screen capture
      ffmpegArgs = [
        '-y',
        '-f', 'avfoundation', // macOS
        '-framerate', '25',
        '-i', this.audioMuted ? '1:none' : '1:0', // Screen:Audio (none if muted)
        
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-crf', '23',
        
        ...(this.audioMuted ? ['-an'] : ['-c:a', 'aac', '-b:a', '128k']),
        
        '-pix_fmt', 'yuv420p',
        outputPath
      ];
    }

    console.log(`[🎬] FFmpeg command: ${this.ffmpegPath} ${ffmpegArgs.join(' ')}`);
    const ffmpegProcess = spawn(this.ffmpegPath, ffmpegArgs);

    ffmpegProcess.stderr.on('data', (data) => {
      const output = data.toString();
      // Only log important FFmpeg messages to avoid spam
      if (output.includes('error') || output.includes('Error') || output.includes('failed')) {
        console.log(`[FFmpeg Error] ${output}`);
      }
    });

    ffmpegProcess.on('error', (err) => {
      console.error(`[❌] FFmpeg failed:`, err);
    });

    ffmpegProcess.on('exit', (code, signal) => {
      console.log(`[🎬] FFmpeg process exited with code ${code}, signal ${signal}`);
    });

    return { ffmpegProcess, outputPath };
  }

  async startRecording(meetUrl, sessionId, options = {}) {
    try {
      const ffmpegAvailable = await this.checkFFmpegInstallation();
      if (!ffmpegAvailable) {
        throw new Error('FFmpeg is not installed or not accessible');
      }

      console.log(`[🎬] Starting local recording for session: ${sessionId}`);
      console.log(`[👤] User: ${options.userName} (${options.userRole})`);

      let audioDevice = options.audioDevice;
      if (!audioDevice && process.platform === 'win32') {
        const devices = await this.getAudioDevices();
        if (devices.length > 0) {
          audioDevice = devices[0];
          console.log(`[🎤] Using audio device: ${audioDevice}`);
        }
      }

      const { ffmpegProcess, outputPath } = this.startFFmpegRecording(sessionId, audioDevice, options);
      
      this.activeSessions.set(sessionId, {
        ffmpegProcess,
        outputPath,
        startTime: new Date(),
        meetUrl,
        audioDevice,
        options,
        audioMuted: this.audioMuted
      });

      console.log(`[✅] Local recording started: ${sessionId}`);
      console.log(`[📁] Output: ${outputPath}`);
      return { success: true, sessionId, outputPath };

    } catch (error) {
      console.error(`[❌] Local recording error:`, error);
      throw error;
    }
  }

  async stopRecording(sessionId) {
    const session = this.activeSessions.get(sessionId);

    if (!session || !session.ffmpegProcess) {
      return { success: false, message: 'No active recording found' };
    }

    return new Promise((resolve) => {
      const { ffmpegProcess } = session;
      console.log(`[🛑] Stopping local FFmpeg process for session: ${sessionId}`);

      let resolved = false;

      // Graceful shutdown
      try {
        ffmpegProcess.stdin.write('q');
      } catch (err) {
        console.warn(`[⚠️] Failed to write 'q' to FFmpeg stdin:`, err);
      }

      const forceKillTimeout = setTimeout(() => {
        if (!resolved) {
          console.log(`[💣] Force killing FFmpeg PID ${ffmpegProcess.pid}`);
          if (!ffmpegProcess.killed) {
            ffmpegProcess.kill('SIGINT');
            setTimeout(() => {
              if (!ffmpegProcess.killed) {
                ffmpegProcess.kill('SIGKILL');
              }
            }, 2000);
          }
          this.activeSessions.delete(sessionId);
          resolved = true;
          resolve({ success: false, message: 'FFmpeg forcefully killed', sessionId });
        }
      }, 5000); // Increased timeout

      ffmpegProcess.on('exit', (code, signal) => {
        if (!resolved) {
          clearTimeout(forceKillTimeout);
          console.log(`[✅] FFmpeg exited (code: ${code}, signal: ${signal})`);
          
          const duration = new Date() - session.startTime;
          const durationMin = Math.floor(duration / 60000);
          const durationSec = Math.floor((duration % 60000) / 1000);
          
          console.log(`[⏱️] Recording duration: ${durationMin}:${String(durationSec).padStart(2, '0')}`);
          
          this.activeSessions.delete(sessionId);
          resolved = true;
          resolve({ 
            success: true, 
            code, 
            signal, 
            sessionId, 
            outputPath: session.outputPath,
            duration: duration
          });
        }
      });
    });
  }

  // Handle dynamic audio mute/unmute during recording
  updateMuteState(isMuted) {
    if (this.audioMuted === isMuted) return; // No change
    
    this.audioMuted = isMuted;
    console.log(`[🎤] Audio mute state changed: ${isMuted ? 'MUTED' : 'UNMUTED'}`);
    
    // Restart all active recordings with new audio state
    for (const [sessionId, session] of this.activeSessions) {
      if (session.ffmpegProcess && !session.ffmpegProcess.killed) {
        console.log(`[🔄] Restarting recording ${sessionId} with new audio state`);
        this.restartRecordingForSession(sessionId);
      }
    }
  }

  async restartRecordingForSession(sessionId) {
    const session = this.activeSessions.get(sessionId);
    if (!session) return;

    try {
      // Stop current recording
      const oldProcess = session.ffmpegProcess;
      oldProcess.stdin.write('q');
      
      // Wait a moment then start new recording
      setTimeout(() => {
        const { ffmpegProcess: newProcess, outputPath: newPath } = 
          this.startFFmpegRecording(sessionId, session.audioDevice, session.options);
        
        // Update session with new process
        session.ffmpegProcess = newProcess;
        session.outputPath = newPath;
        session.audioMuted = this.audioMuted;
        
        console.log(`[✅] Recording restarted for session: ${sessionId}`);
      }, 1000);
      
    } catch (error) {
      console.error(`[❌] Error restarting recording:`, error);
    }
  }

  async checkSystemRequirements() {
    const requirements = {
      ffmpeg: false,
      audioDevices: [],
      platform: os.platform(),
      nodejs: process.version,
      clientId: this.clientId,
      recordingsDir: this.recordingsDir
    };

    requirements.ffmpeg = await this.checkFFmpegInstallation();
    
    if (requirements.ffmpeg) {
      requirements.audioDevices = await this.getAudioDevices();
    }

    return requirements;
  }
}

// Usage
const globalServerUrl = process.env.GLOBAL_SERVER_URL || 'wss://chrome-plugin-backend.onrender.com';
const client = new LocalMeetRecorderClient(globalServerUrl);

// Handle graceful shutdown
process.on('SIGINT', async () => {
  console.log('[🛑] Shutting down local client...');
  
  // Stop all active recordings
  for (const [sessionId] of client.activeSessions) {
    await client.stopRecording(sessionId);
  }
  
  if (client.ws) {
    client.ws.close();
  }
  
  process.exit(0);
});

module.exports = { LocalMeetRecorderClient };