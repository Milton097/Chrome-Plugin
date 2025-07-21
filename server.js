// Improved backend with better error handling and FFmpeg detection
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { exec, spawn } = require('child_process');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({
  origin: ['https://meet.google.com', 'chrome-extension://*'],
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

class MeetRecorderBackend {
  constructor() {
    this.ffmpegPath = 'ffmpeg'; 
    this.activeSessions = new Map();
    this.recordingsDir = path.join(__dirname, 'recordings');
    this.init();

    if (!fs.existsSync(this.recordingsDir)) {
      fs.mkdirSync(this.recordingsDir, { recursive: true });
    }
    
    this.checkFFmpegInstallation();
  }
  async init() {
    await this.checkFFmpegPath();              // Set path if ffmpeg.exe is in local folder
    const isFFmpegOK = await this.checkFFmpegInstallation();

    console.log('[🔍] System check:', {
      ffmpeg: isFFmpegOK,
      platform: process.platform,
      nodejs: process.version,
    });
  }

async checkFFmpegPath() {
    const localFFmpeg = path.join(__dirname, 'ffmpeg.exe');

    try {
      await fs.promises.access(localFFmpeg);
      this.ffmpegPath = localFFmpeg;
      console.log(`[✅] Found FFmpeg at: ${this.ffmpegPath}`);
    } catch {
      this.ffmpegPath = 'ffmpeg';
      console.log(`[✅] Looking for FFmpeg in PATH: ${this.ffmpegPath}`);
    }
  }

async checkFFmpegInstallation() {
  return new Promise(resolve => {
    const check = spawn(this.ffmpegPath, ['-version']);
    check.on('error', () => resolve(false));
    check.on('exit', code => resolve(code === 0));
  });
}

getAudioDevices() {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', ['-list_devices', 'true', '-f', 'dshow', '-i', 'dummy']);
    let stderr = '';

    ffmpeg.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    ffmpeg.on('close', () => {
      console.log('[🔍] Raw FFmpeg output:\n', stderr);

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
      resolve(audioDevices);
    });

    ffmpeg.on('error', reject);
  });
}

getWindowRecordingArgs(sessionId, audioDevice) {
  const outputPath = path.join(this.recordingsDir, `${sessionId}.mp4`);

  const ffmpegArgs = [
    '-y',
    
    // Video input: screen
    '-f', 'gdigrab',
    '-framerate', '30',
    '-i', 'desktop',

    // Audio input (optional)
    ...(audioDevice ? ['-f', 'dshow', '-i', `audio=${audioDevice}`] : []),

    // Correct mapping (not filter_complex)
    ...(audioDevice ? ['-map', '0:v', '-map', '1:a'] : []),

    // Encoding
    '-c:v', 'libvpx-vp9',           // mp4 compatible video codec
    '-crf', '30',                   // quality
    '-b:v', '1M',
    '-pix_fmt', 'yuv420p',
    ...(audioDevice ? ['-c:a', 'libopus', '-b:a', '128k'] : ['-an']), // Use libopus for .mp4

    outputPath
  ];

  return ffmpegArgs;
}

startFFmpegRecording(sessionId, audioDevice) {
  const outputPath = path.join(this.recordingsDir, `${sessionId}.mp4`);
  
  const ffmpegArgs = [
    '-y',
    '-f', 'gdigrab',
    '-framerate', '25',
    '-i', 'desktop',

    ...(audioDevice ? ['-f', 'dshow', '-i', `audio=${audioDevice}`] : []),

    // Ensure FFmpeg syncs timestamps
    '-fflags', '+genpts',
    '-use_wallclock_as_timestamps', '1',

    '-map', '0:v:0',
    ...(audioDevice ? ['-map', '1:a:0'] : []),

    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '23',

    ...(audioDevice ? ['-c:a', 'aac', '-b:a', '128k'] : ['-an']),

    '-pix_fmt', 'yuv420p',

    outputPath
  ];

  const ffmpegProcess = spawn(this.ffmpegPath, ffmpegArgs);

  ffmpegProcess.stderr.on('data', (data) => {
    console.log(`[FFmpeg] ${data.toString()}`);
  });

  ffmpegProcess.on('error', (err) => {
    console.error(`[❌] FFmpeg failed:`, err);
  });

  return { ffmpegProcess };
}

async startRecording(meetUrl, sessionId, options = {}) {
  try {
    const ffmpegAvailable = await this.checkFFmpegInstallation();
    if (!ffmpegAvailable) {
      throw new Error('FFmpeg is not installed or not accessible. Please install FFmpeg and add it to your PATH.');
    }

    console.log(`[🎬] Starting screen recording for session: ${sessionId}`);

    const outputPath = path.join(this.recordingsDir, `${sessionId}.mp4`);

  let audioDevice = options.audioDevice;
  if (!audioDevice) {
    const devices = await this.getAudioDevices();
    if (devices.length > 0) {
      audioDevice = devices[0]; // fallback
      console.log(`[🎤] Using fallback audio device: ${audioDevice}`);
    }
  }

    const { ffmpegProcess } = await this.startFFmpegRecording(sessionId, audioDevice);
    this.activeSessions.set(sessionId, {
      ffmpegProcess,
      startTime: new Date(),
      meetUrl,
      emailId: options?.email_id || null,
      extensionId: options?.extension_id || null,
      options
    });

    console.log(`[✅] Screen recording started successfully for session: ${sessionId}`);
    return { success: true, sessionId, outputPath };

  } catch (error) {
    console.error(`[❌] Error starting recording:`, error);
    throw error;
  }
}

async stopRecording(sessionId) {
  try {
    const session = this.activeSessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);

    console.log(`[🛑] Stopping recording for session: ${sessionId}`);

    if (session.ffmpegProcess) {
      // Preferred way: send 'q' to gracefully stop FFmpeg
      if (session.ffmpegProcess.stdin) {
        session.ffmpegProcess.stdin.write('q');
      }

      // Wait for FFmpeg to exit
      await new Promise(resolve => {
        let exited = false;
        session.ffmpegProcess.on('exit', () => {
          exited = true;
          resolve();
        });

        // Fallback force kill after 5s if not exited
        setTimeout(() => {
          if (!exited) {
            console.warn(`[⚠️] FFmpeg did not exit, forcing kill.`);
            session.ffmpegProcess.kill('SIGKILL');
            resolve();
          }
        }, 5000);
      });
    }

    const duration = new Date() - session.startTime;
    const durationMinutes = Math.floor(duration / 60000);

    this.activeSessions.delete(sessionId);

    console.log(`[✅] Recording stopped successfully. Duration: ${durationMinutes} minutes`);

    return {
      success: true,
      sessionId,
      outputPath: session.outputPath,
      duration: durationMinutes
    };

  } catch (error) {
    console.error(`[❌] Error stopping recording:`, error);
    throw error;
  }
}

  async getActiveRecordings() {
    const recordings = [];
    for (const [sessionId, session] of this.activeSessions) {
      recordings.push({
        sessionId,
        meetUrl: session.meetUrl,
        startTime: session.startTime,
        duration: new Date() - session.startTime
      });
    }
    return recordings;
  }

  getRecordingsList() {
    const recordings = [];
    if (fs.existsSync(this.recordingsDir)) {
      const files = fs.readdirSync(this.recordingsDir);
      files.forEach(file => {
        if (file.endsWith('.mp4')) {
          const filePath = path.join(this.recordingsDir, file);
          const stats = fs.statSync(filePath);
          recordings.push({
            filename: file,
            size: stats.size,
            created: stats.birthtime,
            modified: stats.mtime
          });
        }
      });
    }
    return recordings;
  }

  // New method to check system requirements
  async checkSystemRequirements() {
    const requirements = {
      ffmpeg: false,
      audioDevices: [],
      platform: os.platform(),
      nodejs: process.version
    };

    // Check FFmpeg
    requirements.ffmpeg = await this.checkFFmpegInstallation();
    
    // Check audio devices
    if (requirements.ffmpeg) {
      requirements.audioDevices = await this.getAudioDevices();
    }

    return requirements;
  }
}

const recorder = new MeetRecorderBackend();

// API Routes
app.get('/api/system-check', async (req, res) => {
  try {
    const requirements = await recorder.checkSystemRequirements();
    res.status(200).json({
      success: true,
      ffmpegPath: recorder.ffmpegPath,
      audioDevices: requirements.audioDevices,
      screenOnly: requirements.audioDevices.length === 0,
      platform: requirements.platform,
      nodejs: requirements.nodejs
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/start-recording', async (req, res) => {
  try {
    const { meetUrl, sessionId, options } = req.body;
    
    if (!meetUrl || !sessionId) {
      return res.status(400).json({ 
        error: 'meetUrl and sessionId are required' 
      });
    }

    const result = await recorder.startRecording(meetUrl, sessionId, options);
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
    const recordings = [];

    for (const [sessionId, session] of recorder.activeSessions.entries()) {
      recordings.push({
        sessionId,
        meetUrl: session.meetUrl,
        startTime: session.startTime,
        duration: new Date() - session.startTime,
        emailId: session.emailId,
        extensionId: session.extensionId
      });
    }
    res.json({ recordings });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/recordings', (req, res) => {
  try {
    const recordings = recorder.getRecordingsList();
    res.json({ recordings });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/download/:sessionId', (req, res) => {
  try {
    const { sessionId } = req.params;
    const filePath = path.join(recorder.recordingsDir, `${sessionId}.mp4`);
    
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Recording not found' });
    }

    res.download(filePath, `google-meet-recording-${sessionId}.mp4`);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    platform: os.platform(),
    activeSessions: recorder.activeSessions.size,
    ffmpegPath: recorder.ffmpegPath
  });
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('[❌] Unhandled error:', error);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, async () => {
  console.log(`[🚀] Meet Recorder Backend running on port ${PORT}`);
  console.log(`[📁] Recordings directory: ${recorder.recordingsDir}`);
  console.log(`[💻] Platform: ${os.platform()}`);
  
  // Check system requirements on startup
  const requirements = await recorder.checkSystemRequirements();
  console.log(`[🔍] System check:`, requirements);
});
app.post('/api/ping', (req, res) => {
  res.json({ success: true, message: 'Backend is alive!' });
});

app.get('/api/audio-devices', async (req, res) => {
  try {
    const devices = await recorder.getAudioDevices();
    res.status(200).json({ success: true, devices });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = { MeetRecorderBackend };