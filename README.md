# Outback Streaming Server

A streaming server for Outback challenges that allows users to stream their screen and watch recordings in real-time.

## Features

- Screen sharing via browser MediaRecorder API
- Real-time HLS transcoding with FFmpeg
- Immediate playback of recordings
- WebSocket-based chunk streaming

## Endpoints

- `GET /stream/:userId/:challengeNum` - Start a screen share stream
- `GET /watch/:userId/:challengeNum` - Watch a recorded stream
- `GET /` - Health check endpoint

## Deployment

This server is designed to be deployed on Coolify, similar to `airtable-active-record`.

### Environment Variables

- `PORT` - Server port (default: 3000)

### Docker

The Dockerfile includes FFmpeg for video transcoding. Build and run:

```bash
docker build -t outback-streaming .
docker run -p 3000:3000 outback-streaming
```

## How It Works

1. User navigates to `/stream/:userId/:challengeNum`
2. Browser requests screen share permission
3. MediaRecorder captures screen and audio
4. Chunks are sent to server via WebSocket
5. Server writes chunks to WebM file
6. FFmpeg transcodes WebM to HLS format in real-time
7. Users can watch at `/watch/:userId/:challengeNum` immediately

## Recordings

Recordings are stored in the `recordings/` directory as HLS playlists and segments. Each recording is organized by `userId_challengeNum`.

