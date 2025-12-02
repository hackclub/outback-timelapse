require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const ffmpeg = require('fluent-ffmpeg');

// Set FFmpeg path (for Docker/Alpine Linux)
// In Alpine, FFmpeg is typically at /usr/bin/ffmpeg
const { execSync } = require('child_process');
let ffmpegPath = null;

// Try common locations for FFmpeg binary (Alpine Linux default is /usr/bin/ffmpeg)
const commonPaths = ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/bin/ffmpeg'];
for (const p of commonPaths) {
  if (fs.existsSync(p)) {
    ffmpegPath = p;
    break;
  }
}

// If not found in common paths, try to find it in PATH
if (!ffmpegPath) {
  try {
    ffmpegPath = execSync('which ffmpeg', { encoding: 'utf8', timeout: 2000 }).trim();
  } catch (e) {
    // which command failed, continue with common paths check
  }
}

if (ffmpegPath) {
  ffmpeg.setFfmpegPath(ffmpegPath);
  console.log(`FFmpeg path set to: ${ffmpegPath}`);
  
  // Verify FFmpeg is accessible
  try {
    execSync(`${ffmpegPath} -version`, { timeout: 2000 });
    console.log('FFmpeg is accessible and working');
  } catch (e) {
    console.error('Warning: FFmpeg binary found but not executable:', e.message);
  }
} else {
  console.error('ERROR: Could not find FFmpeg binary. Timelapse generation will fail.');
  console.error('Searched paths:', commonPaths);
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 3000;
const RECORDINGS_DIR = path.join(__dirname, 'recordings');

// Ensure recordings directory exists
if (!fs.existsSync(RECORDINGS_DIR)) {
  fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
}

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Serve HLS recordings
app.use('/recordings', express.static(RECORDINGS_DIR));

// Store active streams and FFmpeg processes
const activeStreams = new Map();
const ffmpegProcesses = new Map();
const timelapseProcesses = new Map();

// Helper function to get stream key
function getStreamKey(userId, challengeNum) {
  return `${userId}_${challengeNum}`;
}

// Helper function to get recording path
function getRecordingPath(userId, challengeNum) {
  const streamKey = getStreamKey(userId, challengeNum);
  return path.join(RECORDINGS_DIR, streamKey);
}

// Helper function to generate timelapse (60x speed)
function generateTimelapse(userId, challengeNum, callback) {
  const streamKey = getStreamKey(userId, challengeNum);
  const recordingPath = getRecordingPath(userId, challengeNum);
  const inputFile = path.join(recordingPath, 'input.webm');
  const timelapsePlaylist = path.join(recordingPath, 'timelapse.m3u8');

  // Check if input file exists
  if (!fs.existsSync(inputFile)) {
    return callback(new Error('Input file not found'));
  }

  // Check if timelapse already exists and is recent
  if (fs.existsSync(timelapsePlaylist)) {
    const inputStats = fs.statSync(inputFile);
    const timelapseStats = fs.statSync(timelapsePlaylist);
    // If timelapse is newer than input, use existing
    if (timelapseStats.mtime >= inputStats.mtime) {
      return callback(null, timelapsePlaylist);
    }
  }

  // Check if timelapse is already being generated
  if (timelapseProcesses.has(streamKey)) {
    return callback(new Error('Timelapse generation already in progress'));
  }

  console.log(`Generating timelapse for ${streamKey}...`);

  // Create timelapse with 60x speed using setpts filter
  const ffmpegProcess = ffmpeg(inputFile)
    .inputOptions([
      '-fflags', '+genpts'
    ])
    .videoFilters([
      'setpts=0.01667*PTS' // 60x speed (1/60 = 0.01667)
    ])
    .audioFilters([
      'atempo=2.0,atempo=2.0,atempo=2.0,atempo=2.0,atempo=1.875' // 60x audio speed (2.0 * 2.0 * 2.0 * 2.0 * 1.875 = 60.0)
    ])
    .outputOptions([
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-c:a', 'aac',
      '-f', 'hls',
      '-hls_time', '2',
      '-hls_list_size', '0',
      '-hls_flags', 'delete_segments',
      '-hls_segment_filename', path.join(recordingPath, 'timelapse_segment_%03d.ts'),
      '-hls_playlist_type', 'vod'
    ])
    .output(timelapsePlaylist)
    .on('start', (commandLine) => {
      console.log(`Timelapse FFmpeg started for ${streamKey}`);
    })
    .on('progress', (progress) => {
      console.log(`Timelapse progress for ${streamKey}: ${progress.percent}%`);
    })
    .on('end', () => {
      console.log(`Timelapse generation completed for ${streamKey}`);
      timelapseProcesses.delete(streamKey);
      callback(null, timelapsePlaylist);
    })
    .on('error', (err) => {
      console.error(`Timelapse FFmpeg error for ${streamKey}:`, err.message);
      timelapseProcesses.delete(streamKey);
      callback(err);
    });

  timelapseProcesses.set(streamKey, ffmpegProcess);
  ffmpegProcess.run();
}

// WebSocket handlers for streaming
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  socket.on('start-stream', async ({ userId, challengeNum }) => {
    const streamKey = getStreamKey(userId, challengeNum);
    console.log(`Starting stream: ${streamKey}`);

    // Create recording directory
    const recordingPath = getRecordingPath(userId, challengeNum);
    if (!fs.existsSync(recordingPath)) {
      fs.mkdirSync(recordingPath, { recursive: true });
    }

    const outputPlaylist = path.join(recordingPath, 'playlist.m3u8');
    const inputFile = path.join(recordingPath, 'input.webm');
    
    // Create a write stream for incoming WebM chunks
    const writeStream = fs.createWriteStream(inputFile);

    // Store socket in active streams
    activeStreams.set(streamKey, {
      socketId: socket.id,
      userId,
      challengeNum,
      startTime: Date.now(),
      recordingPath,
      writeStream
    });

    // Start FFmpeg process to transcode to HLS
    // Use a small delay to ensure some data is written before FFmpeg starts
    setTimeout(() => {
      const ffmpegProcess = ffmpeg(inputFile)
        .inputOptions([
          '-fflags', '+genpts+discardcorrupt',
          '-flags', 'low_delay',
          '-strict', 'experimental',
          '-analyzeduration', '1000000',
          '-probesize', '1000000'
        ])
        .outputOptions([
          '-c:v', 'libx264',
          '-preset', 'ultrafast',
          '-tune', 'zerolatency',
          '-c:a', 'aac',
          '-f', 'hls',
          '-hls_time', '2',
          '-hls_list_size', '5',
          '-hls_flags', 'delete_segments+append_list',
          '-hls_segment_filename', path.join(recordingPath, 'segment_%03d.ts'),
          '-hls_playlist_type', 'event',
          '-start_number', '0'
        ])
        .output(outputPlaylist)
        .on('start', (commandLine) => {
          console.log(`FFmpeg started for ${streamKey}`);
        })
        .on('error', (err) => {
          console.error(`FFmpeg error for ${streamKey}:`, err.message);
          // Try to restart FFmpeg if it fails
          if (activeStreams.has(streamKey)) {
            setTimeout(() => {
              if (activeStreams.has(streamKey)) {
                console.log(`Retrying FFmpeg for ${streamKey}`);
                const retryProcess = ffmpeg(inputFile)
                  .inputOptions([
                    '-fflags', '+genpts+discardcorrupt',
                    '-flags', 'low_delay',
                    '-strict', 'experimental'
                  ])
                  .outputOptions([
                    '-c:v', 'libx264',
                    '-preset', 'ultrafast',
                    '-tune', 'zerolatency',
                    '-c:a', 'aac',
                    '-f', 'hls',
                    '-hls_time', '2',
                    '-hls_list_size', '5',
                    '-hls_flags', 'delete_segments+append_list',
                    '-hls_segment_filename', path.join(recordingPath, 'segment_%03d.ts'),
                    '-hls_playlist_type', 'event'
                  ])
                  .output(outputPlaylist)
                  .run();
                ffmpegProcesses.set(streamKey, retryProcess);
              }
            }, 2000);
          }
        })
        .on('end', () => {
          console.log(`FFmpeg finished for ${streamKey}`);
        });

      ffmpegProcess.run();
      ffmpegProcesses.set(streamKey, ffmpegProcess);
    }, 2000);

    socket.join(streamKey);
    socket.emit('stream-ready', { streamKey });
  });

  socket.on('stream-chunk', ({ userId, challengeNum, chunk }) => {
    const streamKey = getStreamKey(userId, challengeNum);
    const streamInfo = activeStreams.get(streamKey);
    
    if (streamInfo && streamInfo.writeStream) {
      // Write chunk to file
      const buffer = Buffer.from(chunk, 'base64');
      streamInfo.writeStream.write(buffer);
    }
  });

  socket.on('stop-stream', ({ userId, challengeNum }) => {
    const streamKey = getStreamKey(userId, challengeNum);
    console.log(`Stopping stream: ${streamKey}`);

    const streamInfo = activeStreams.get(streamKey);
    if (streamInfo && streamInfo.writeStream) {
      streamInfo.writeStream.end();
    }

    // Stop FFmpeg process if running
    if (ffmpegProcesses.has(streamKey)) {
      const ffmpegProcess = ffmpegProcesses.get(streamKey);
      ffmpegProcess.kill('SIGTERM');
      ffmpegProcesses.delete(streamKey);
    }

    activeStreams.delete(streamKey);
    socket.leave(streamKey);
    socket.emit('stream-stopped');
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    // Clean up any streams associated with this socket
    for (const [streamKey, streamInfo] of activeStreams.entries()) {
      if (streamInfo.socketId === socket.id) {
        if (streamInfo.writeStream) {
          streamInfo.writeStream.end();
        }
        const processKey = streamKey;
        if (ffmpegProcesses.has(processKey)) {
          const ffmpegProcess = ffmpegProcesses.get(processKey);
          ffmpegProcess.kill('SIGTERM');
          ffmpegProcesses.delete(processKey);
        }
        activeStreams.delete(streamKey);
      }
    }
  });
});

// Endpoint to get stream page (for screen sharing)
app.get('/stream/:userId/:challengeNum', (req, res) => {
  const { userId, challengeNum } = req.params;
  const streamKey = getStreamKey(userId, challengeNum);
  
  // Serve HTML page for screen sharing
  const html = `
<!DOCTYPE html>
<html>
<head>
  <title>Stream - ${streamKey}</title>
  <script src="${getProtocol(req)}://${req.get('host')}/socket.io/socket.io.js"></script>
  <style>
    body {
      font-family: Arial, sans-serif;
      max-width: 1200px;
      margin: 0 auto;
      padding: 20px;
      background: #1a1a1a;
      color: #fff;
    }
    .container {
      background: #2a2a2a;
      padding: 20px;
      border-radius: 8px;
    }
    button {
      background: #4CAF50;
      color: white;
      border: none;
      padding: 12px 24px;
      font-size: 16px;
      border-radius: 4px;
      cursor: pointer;
      margin: 10px 5px;
    }
    button:hover {
      background: #45a049;
    }
    button:disabled {
      background: #666;
      cursor: not-allowed;
    }
    button.stop {
      background: #f44336;
    }
    button.stop:hover {
      background: #da190b;
    }
    #video {
      width: 100%;
      max-width: 800px;
      border-radius: 8px;
      background: #000;
      margin: 20px 0;
    }
    .status {
      padding: 10px;
      margin: 10px 0;
      border-radius: 4px;
      background: #333;
    }
    .status.connected {
      background: #4CAF50;
    }
    .status.error {
      background: #f44336;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>Stream: ${streamKey}</h1>
    <div id="status" class="status">Ready to start streaming</div>
    <div>
      <button id="startBtn" onclick="startStream()">Start Screen Share</button>
      <button id="stopBtn" class="stop" onclick="stopStream()" disabled>Stop Streaming</button>
    </div>
    <video id="video" autoplay muted></video>
    <div>
      <p>Stream URL: <code>${streamKey}</code></p>
      <p>Watch URL: <a href="/watch/${userId}/${challengeNum}" target="_blank">/watch/${userId}/${challengeNum}</a></p>
    </div>
  </div>

  <script>
    // Connect to Socket.io server
    const socket = io(window.location.origin);
    const userId = '${userId}';
    const challengeNum = '${challengeNum}';
    let localStream = null;
    let mediaRecorder = null;
    let isStreaming = false;

    const video = document.getElementById('video');
    const startBtn = document.getElementById('startBtn');
    const stopBtn = document.getElementById('stopBtn');
    const status = document.getElementById('status');

    function updateStatus(message, type = '') {
      status.textContent = message;
      status.className = 'status ' + type;
    }

    async function startStream() {
      try {
        updateStatus('Requesting screen share...', '');
        startBtn.disabled = true;

        // Get screen share
        localStream = await navigator.mediaDevices.getDisplayMedia({
          video: { 
            mediaSource: 'screen',
            width: { ideal: 1920 },
            height: { ideal: 1080 }
          },
          audio: true
        });

        video.srcObject = localStream;
        updateStatus('Screen share active. Starting recording...', '');

        // Start stream on server
        socket.emit('start-stream', { userId, challengeNum });

        // Wait for server to be ready
        socket.once('stream-ready', () => {
          try {
            // Create MediaRecorder
            const options = {
              mimeType: 'video/webm;codecs=vp8,opus',
              videoBitsPerSecond: 2500000
            };

            if (!MediaRecorder.isTypeSupported(options.mimeType)) {
              options.mimeType = 'video/webm';
            }

            mediaRecorder = new MediaRecorder(localStream, options);

            // Handle data available
            mediaRecorder.ondataavailable = (event) => {
              if (event.data && event.data.size > 0) {
                // Convert blob to base64 and send to server
                const reader = new FileReader();
                reader.onloadend = () => {
                  const base64data = reader.result.split(',')[1];
                  socket.emit('stream-chunk', {
                    userId,
                    challengeNum,
                    chunk: base64data
                  });
                };
                reader.readAsDataURL(event.data);
              }
            };

            // Handle stop
            mediaRecorder.onstop = () => {
              socket.emit('stop-stream', { userId, challengeNum });
            };

            // Start recording with 1 second chunks
            mediaRecorder.start(1000);
            updateStatus('Streaming active! Recording...', 'connected');
            isStreaming = true;
            stopBtn.disabled = false;
          } catch (error) {
            console.error('Error starting MediaRecorder:', error);
            updateStatus('Error: ' + error.message, 'error');
            cleanup();
          }
        });

        // Handle stream stopped from server
        socket.on('stream-stopped', () => {
          updateStatus('Stream stopped', '');
          cleanup();
        });

        // Handle stream end (user stops sharing)
        localStream.getVideoTracks()[0].onended = () => {
          stopStream();
        };

      } catch (error) {
        console.error('Error starting stream:', error);
        updateStatus('Error: ' + error.message, 'error');
        startBtn.disabled = false;
        cleanup();
      }
    }

    function stopStream() {
      if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        mediaRecorder.stop();
      }
      if (isStreaming) {
        socket.emit('stop-stream', { userId, challengeNum });
      }
      cleanup();
    }

    function cleanup() {
      if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        localStream = null;
      }
      if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        mediaRecorder.stop();
        mediaRecorder = null;
      }
      isStreaming = false;
      startBtn.disabled = false;
      stopBtn.disabled = true;
      video.srcObject = null;
    }

    // Cleanup on page unload
    window.addEventListener('beforeunload', cleanup);
  </script>
</body>
</html>
  `;
  
  res.send(html);
});

// Helper to get the correct protocol (handles reverse proxies)
function getProtocol(req) {
  // Check for X-Forwarded-Proto header (set by reverse proxies like Coolify)
  const forwardedProto = req.get('x-forwarded-proto');
  if (forwardedProto) {
    return forwardedProto.split(',')[0].trim();
  }
  // Check if connection is secure
  return req.secure ? 'https' : req.protocol;
}

// Endpoint to watch recorded stream - returns HLS playlist as API
app.get('/watch/:userId/:challengeNum', (req, res) => {
  const { userId, challengeNum } = req.params;
  const recordingPath = getRecordingPath(userId, challengeNum);
  const playlistPath = path.join(recordingPath, 'playlist.m3u8');

  // Check if recording exists
  if (!fs.existsSync(playlistPath)) {
    return res.status(404).json({
      error: 'Recording not found',
      message: `No recording found for ${userId}/${challengeNum}`,
      userId,
      challengeNum
    });
  }

  // Set proper headers for HLS playlist
  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache');
  
  // Read and serve the playlist file
  let playlistContent = fs.readFileSync(playlistPath, 'utf8');
  
  // Update segment paths to be absolute URLs with correct protocol
  const protocol = getProtocol(req);
  const baseUrl = `${protocol}://${req.get('host')}/recordings/${userId}_${challengeNum}/`;
  // Replace relative segment paths with absolute URLs
  playlistContent = playlistContent.replace(/^(segment_\d+\.ts)$/gm, baseUrl + '$1');
  // Also handle paths that might already have a partial path
  playlistContent = playlistContent.replace(/^([^\/\n]+segment_\d+\.ts)$/gm, baseUrl + '$1');
  
  res.send(playlistContent);
});

// Endpoint to watch timelapse (60x speed) - returns HLS playlist as API
app.get('/timelapse/:userId/:challengeNum', (req, res) => {
  const { userId, challengeNum } = req.params;
  const recordingPath = getRecordingPath(userId, challengeNum);
  const inputFile = path.join(recordingPath, 'input.webm');
  const timelapsePlaylist = path.join(recordingPath, 'timelapse.m3u8');

  // Check if original recording exists
  if (!fs.existsSync(inputFile)) {
    return res.status(404).json({
      error: 'Recording not found',
      message: `No recording found for ${userId}/${challengeNum}`,
      userId,
      challengeNum
    });
  }

  // Check if timelapse already exists
  if (fs.existsSync(timelapsePlaylist)) {
    // Set proper headers for HLS playlist
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-cache');
    
    // Read and serve the playlist file
    let playlistContent = fs.readFileSync(timelapsePlaylist, 'utf8');
    
    // Update segment paths to be absolute URLs
    const protocol = getProtocol(req);
    const baseUrl = `${protocol}://${req.get('host')}/recordings/${userId}_${challengeNum}/`;
    // Replace relative segment paths with absolute URLs
    playlistContent = playlistContent.replace(/^(timelapse_segment_\d+\.ts)$/gm, baseUrl + '$1');
    // Also handle paths that might already have a partial path
    playlistContent = playlistContent.replace(/^([^\/\n]+timelapse_segment_\d+\.ts)$/gm, baseUrl + '$1');
    
    return res.send(playlistContent);
  }

  // Generate timelapse
  generateTimelapse(userId, challengeNum, (err, playlistPath) => {
    if (err) {
      // If timelapse is being generated, return 202 Accepted
      if (err.message === 'Timelapse generation already in progress') {
        return res.status(202).json({
          status: 'generating',
          message: 'Timelapse is being generated. Please retry in a few moments.',
          userId,
          challengeNum
        });
      }
      return res.status(500).json({
        error: 'Timelapse generation failed',
        message: err.message,
        userId,
        challengeNum
      });
    }

    // Set proper headers for HLS playlist
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-cache');
    
    // Read and serve the playlist file
    let playlistContent = fs.readFileSync(playlistPath, 'utf8');
    
    // Update segment paths to be absolute URLs with correct protocol
    const protocol = getProtocol(req);
    const baseUrl = `${protocol}://${req.get('host')}/recordings/${userId}_${challengeNum}/`;
    // Replace relative segment paths with absolute URLs
    playlistContent = playlistContent.replace(/^(timelapse_segment_\d+\.ts)$/gm, baseUrl + '$1');
    // Also handle paths that might already have a partial path
    playlistContent = playlistContent.replace(/^([^\/\n]+timelapse_segment_\d+\.ts)$/gm, baseUrl + '$1');
    
    res.send(playlistContent);
  });
});

// Health check endpoint
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'outback-streaming',
    activeStreams: activeStreams.size
  });
});

// Start server
server.listen(PORT, () => {
  console.log(`Streaming server running on port ${PORT}`);
  console.log(`Recordings directory: ${RECORDINGS_DIR}`);
});

