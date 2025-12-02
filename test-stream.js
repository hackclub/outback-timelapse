const io = require('socket.io-client');
const fs = require('fs');

const STREAMING_SERVER = process.env.STREAMING_SERVER || 'https://tkg8wsk0o8cc8scsw4cwk88s.a.selfhosted.hackclub.com';
const userId = 'TEST_USER';
const challengeNum = '999';
const TEST_VIDEO = '/tmp/test_video.webm';

console.log('Connecting to streaming server...');
const socket = io(STREAMING_SERVER, {
  transports: ['websocket', 'polling'],
  rejectUnauthorized: false
});

let streamReady = false;

socket.on('connect', () => {
  console.log('✓ Connected to server');
  console.log('Starting stream...');
  socket.emit('start-stream', { userId, challengeNum });
});

socket.on('stream-ready', () => {
  console.log('✓ Stream ready, reading video file...');
  streamReady = true;
  
  if (!fs.existsSync(TEST_VIDEO)) {
    console.error('Test video not found:', TEST_VIDEO);
    socket.close();
    process.exit(1);
  }
  
  // Read video file and send in chunks
  const videoBuffer = fs.readFileSync(TEST_VIDEO);
  const chunkSize = 64 * 1024; // 64KB chunks
  let offset = 0;
  
  const sendChunks = () => {
    if (offset >= videoBuffer.length) {
      console.log('✓ All chunks sent, stopping stream...');
      socket.emit('stop-stream', { userId, challengeNum });
      return;
    }
    
    const chunk = videoBuffer.slice(offset, offset + chunkSize);
    const base64Chunk = chunk.toString('base64');
    
    socket.emit('stream-chunk', {
      userId,
      challengeNum,
      chunk: base64Chunk
    });
    
    offset += chunkSize;
    const progress = ((offset / videoBuffer.length) * 100).toFixed(1);
    process.stdout.write(`\rSent ${progress}% (${offset}/${videoBuffer.length} bytes)`);
    
    // Send next chunk after a small delay
    setTimeout(sendChunks, 50);
  };
  
  sendChunks();
});

socket.on('stream-stopped', () => {
  console.log('\n✓ Stream stopped');
  console.log('Waiting 5 seconds for server to process...');
  setTimeout(() => {
    console.log('\nTesting watch endpoint...');
    const http = require('http');
    const https = require('https');
    const url = new URL(`${STREAMING_SERVER}/watch/${userId}/${challengeNum}`);
    const client = url.protocol === 'https:' ? https : http;
    client.get(`${STREAMING_SERVER}/watch/${userId}/${challengeNum}`, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode === 200) {
          console.log('✓ Watch endpoint working! Got playlist');
          console.log('First 200 chars:', data.substring(0, 200));
        } else {
          console.log('Watch endpoint status:', res.statusCode);
          console.log('Response:', data);
        }
        
        console.log('\nTesting timelapse endpoint...');
        client.get(`${STREAMING_SERVER}/timelapse/${userId}/${challengeNum}`, (res2) => {
          let data2 = '';
          res2.on('data', (chunk) => { data2 += chunk; });
          res2.on('end', () => {
            if (res2.statusCode === 200) {
              console.log('✓ Timelapse endpoint working! Got playlist');
              console.log('First 200 chars:', data2.substring(0, 200));
            } else if (res2.statusCode === 202) {
              console.log('⏳ Timelapse is being generated (202 Accepted)');
            } else {
              console.log('Timelapse endpoint status:', res2.statusCode);
              console.log('Response:', data2);
            }
            socket.close();
            process.exit(0);
          });
        }).on('error', (err) => {
          console.error('Timelapse request error:', err);
          process.exit(1);
        });
      });
    }).on('error', (err) => {
      console.error('Watch request error:', err);
      process.exit(1);
    });
  }, 5000);
});

socket.on('disconnect', () => {
  console.log('\nDisconnected from server');
});

socket.on('connect_error', (error) => {
  console.error('Connection error:', error.message);
  process.exit(1);
});

setTimeout(() => {
  console.log('\nTimeout - closing connection');
  socket.close();
  process.exit(1);
}, 60000);

