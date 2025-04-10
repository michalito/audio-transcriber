# Audio Transcriber

A Node.js application that transcribes audio files using OpenAI's Whisper API. This service handles audio file uploads, processing, and transcription with support for large files through automatic splitting and compression.

## Features

- Web-based interface for easy file uploads
- Secure API key input through the UI
- Automatic audio processing using FFmpeg
- Integration with OpenAI's Whisper API for transcription
- Support for large audio files through splitting
- Audio compression capabilities
- Download transcription results as text files

## Prerequisites

- Node.js (v14 or higher)
- FFmpeg installed on your system
- npm or yarn package manager
- OpenAI API key (entered through the UI)

## Installation

1. Clone the repository:
```bash
git clone [repository-url]
cd audio-transcriber
```

2. Install dependencies:
```bash
npm install
```

## Usage

1. Start the server:
```bash
npm start
```

2. Open your browser and navigate to `http://localhost:3000`

3. In the web interface:
   - Enter your OpenAI API key
   - Select an MP3 or M4A file
   - For files larger than 25MB, check the "Split large files" option
   - Click "Transcribe Audio"
   - Download the transcription when complete

## API Endpoints

### POST /transcribe
Uploads and transcribes an audio file.

**Request:**
- Method: POST
- Content-Type: multipart/form-data
- Body: 
  - file: audio file (MP3 or M4A)
  - apiKey: OpenAI API key
  - shouldSplit: boolean (optional)

**Response:**
```json
{
  "text": "Your audio transcription text here",
  "status": "success"
}
```

## Error Handling

The application includes robust error handling for:
- Invalid API keys
- Invalid file formats (only MP3 and M4A supported)
- File size limits
- API failures
- Processing errors

## Development

To run the application in development mode with hot reloading:
```bash
npm run dev
```

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is licensed under the MIT License - see the LICENSE file for details.

## Acknowledgments

- OpenAI for the Whisper API
- FFmpeg for audio processing capabilities
- Express.js team for the web framework
