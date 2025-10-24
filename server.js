const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');
const ffmpeg = require('fluent-ffmpeg');

const app = express();
const port = process.env.PORT || 3000;

// Set up storage for uploaded files
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadDir = path.join(__dirname, 'uploads');
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + '-' + file.originalname);
    }
});

// Create multer instance with increased file size limit and file filter
const upload = multer({ 
    storage,
    limits: { fileSize: 100 * 1024 * 1024 }, // Increased to 100MB
    fileFilter: (req, file, cb) => {
        if (file.mimetype === 'audio/mpeg' || 
            file.mimetype === 'audio/mp4' ||
            file.originalname.endsWith('.mp3') ||
            file.originalname.endsWith('.m4a')) {
            cb(null, true);
        } else {
            cb(new Error('Invalid file type. Only MP3 and M4A files are allowed. Please upload a valid audio file.'));
        }
    }
});

// Add error handling middleware
app.use((error, req, res, next) => {
    if (error instanceof multer.MulterError) {
        if (error.code === 'LIMIT_FILE_SIZE') {
            return res.status(400).json({
                error: 'File is too large. Maximum size is 100MB. Please upload a smaller file.'
            });
        }
    }
    next(error);
});

// Serve static files
app.use(express.static(__dirname));

const MAX_OPENAI_FILE_SIZE = 25 * 1024 * 1024; // 25MB in bytes

async function compressAudio(inputPath) {
    const outputPath = inputPath.replace('.mp3', '_compressed.mp3');
    
    return new Promise((resolve, reject) => {
        ffmpeg(inputPath)
            .toFormat('mp3')
            .audioBitrate('64k') // Adjust this value as needed
            .on('end', () => resolve(outputPath))
            .on('error', reject)
            .save(outputPath);
    });
}

async function splitAudio(inputPath, parts) {
    try {
        const duration = await new Promise((resolve, reject) => {
            ffmpeg.ffprobe(inputPath, (err, metadata) => {
                if (err) {
                    console.error('FFprobe error:', err);
                    reject(new Error('Failed to read audio file metadata'));
                    return;
                }
                if (!metadata || !metadata.format || !metadata.format.duration) {
                    console.error('Invalid metadata:', metadata);
                    reject(new Error('Could not determine audio duration'));
                    return;
                }
                resolve(metadata.format.duration);
            });
        });

        console.log(`Audio duration: ${duration} seconds, splitting into ${parts} parts`);
        const segmentDuration = Math.ceil(duration / parts);
        const outputPaths = [];

        for (let i = 0; i < parts; i++) {
            const outputPath = inputPath.replace(/\.(mp3|m4a)$/, `_part${i + 1}.mp3`);
            await new Promise((resolve, reject) => {
                ffmpeg(inputPath)
                    .setStartTime(i * segmentDuration)
                    .setDuration(segmentDuration)
                    .output(outputPath)
                    .audioCodec('libmp3lame')
                    .audioBitrate('64k')
                    .on('start', command => {
                        console.log(`FFmpeg spawned for part ${i + 1}: ${command}`);
                    })
                    .on('end', () => {
                        console.log(`Part ${i + 1} completed`);
                        resolve();
                    })
                    .on('error', (err) => {
                        console.error(`Error processing part ${i + 1}:`, err);
                        reject(err);
                    })
                    .run();
            });
            outputPaths.push(outputPath);
        }

        return outputPaths;
    } catch (error) {
        console.error('Split audio error:', error);
        throw new Error(`Failed to split audio file: ${error.message}`);
    }
}

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function transcribeFile(filePath, apiKey, retries = 4) {
    let lastError;

    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const formData = new FormData();
            formData.append('file', fs.createReadStream(filePath));
            formData.append('model', 'whisper-1');

            console.log(`Transcribing ${path.basename(filePath)} (attempt ${attempt + 1}/${retries + 1})...`);

            const response = await axios.post(
                'https://api.openai.com/v1/audio/transcriptions',
                formData,
                {
                    headers: {
                        ...formData.getHeaders(),
                        'Authorization': `Bearer ${apiKey}`,
                    },
                    maxBodyLength: Infinity,
                    timeout: 300000, // 5 minutes timeout for large file uploads
                    validateStatus: function (status) {
                        return status < 500; // Don't throw on 4xx errors
                    }
                }
            );

            if (response.status >= 400) {
                throw new Error(`API error: ${response.status} - ${JSON.stringify(response.data)}`);
            }

            console.log(`Successfully transcribed ${path.basename(filePath)}`);
            return response.data.text;

        } catch (error) {
            lastError = error;
            const isRetryable =
                error.code === 'ECONNRESET' ||
                error.code === 'ETIMEDOUT' ||
                error.code === 'ECONNREFUSED' ||
                error.message.includes('timeout') ||
                error.message.includes('Connection error');

            if (!isRetryable || attempt === retries) {
                console.error(`Failed to transcribe ${path.basename(filePath)}:`, error.message);
                throw error;
            }

            const backoffTime = Math.pow(2, attempt) * 1000; // Exponential backoff: 1s, 2s, 4s, 8s
            console.log(`Connection error on attempt ${attempt + 1}, retrying in ${backoffTime/1000}s...`);
            await sleep(backoffTime);
        }
    }

    throw lastError;
}

// Transcribe endpoint
app.post('/transcribe', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }

        const apiKey = req.body.apiKey;
        if (!apiKey) {
            return res.status(400).json({ error: 'OpenAI API key is required' });
        }

        let filePath = req.file.path;
        const fileSize = fs.statSync(filePath).size;
        const shouldSplit = req.body.shouldSplit === 'true';
        
        let transcription = '';

        if (fileSize > MAX_OPENAI_FILE_SIZE) {
            if (shouldSplit) {
                try {
                    const parts = Math.min(4, Math.ceil(fileSize / MAX_OPENAI_FILE_SIZE));
                    console.log(`Splitting file of size ${fileSize} bytes into ${parts} parts`);
                    
                    const splitPaths = await splitAudio(filePath, parts);
                    console.log('Split paths:', splitPaths);

                    // Transcribe each part sequentially to avoid overwhelming the connection
                    const transcriptions = [];
                    for (let i = 0; i < splitPaths.length; i++) {
                        console.log(`Processing chunk ${i + 1}/${splitPaths.length}...`);
                        try {
                            const text = await transcribeFile(splitPaths[i], apiKey);
                            transcriptions.push(text);
                        } catch (error) {
                            console.error(`Failed to transcribe chunk ${i + 1}/${splitPaths.length}:`, error.message);
                            throw new Error(`Failed to transcribe chunk ${i + 1}/${splitPaths.length}: ${error.message}`);
                        }
                    }

                    // Combine transcriptions
                    transcription = transcriptions.join(' ');

                    // Clean up split files
                    splitPaths.forEach(path => {
                        try {
                            if (fs.existsSync(path)) {
                                fs.unlinkSync(path);
                            }
                        } catch (cleanupError) {
                            console.error('Error cleaning up split file:', cleanupError);
                        }
                    });
                } catch (splitError) {
                    console.error('Error during file splitting:', splitError);
                    return res.status(500).json({ 
                        error: 'Failed to split audio file. Please try using compression instead.' 
                    });
                }
            } else {
                try {
                    filePath = await compressAudio(filePath);
                    fs.unlinkSync(req.file.path);
                } catch (error) {
                    return res.status(500).json({ 
                        error: 'Failed to compress audio file. Please try splitting the file instead.' 
                    });
                }
            }
        }

        if (!transcription) {
            // If we haven't already transcribed split files
            try {
                console.log('Starting transcription for single file...');
                const response = await transcribeFile(filePath, apiKey);
                transcription = response;
            } catch (apiError) {
                if (apiError.response?.status === 401) {
                    return res.status(401).json({ error: 'Invalid OpenAI API key' });
                } else if (apiError.response?.status === 429) {
                    return res.status(429).json({ error: 'Rate limit exceeded. Please try again later.' });
                } else if (apiError.code === 'ECONNRESET' || apiError.message.includes('Connection error')) {
                    return res.status(503).json({
                        error: 'Connection error while uploading to OpenAI. The file may be too large or your network connection is unstable. Try splitting the file or checking your internet connection.'
                    });
                }
                throw apiError;
            }
        }

        // Save transcription to a file
        const transcriptionFilePath = filePath.replace(/\.(mp3|m4a)$/, '.txt');
        fs.writeFileSync(transcriptionFilePath, transcription);

        // Clean up the uploaded file
        fs.unlinkSync(filePath);
        
        res.json({ text: transcription });
    } catch (error) {
        console.error('Transcription error:', error);
        
        // Clean up if file exists
        if (req.file && fs.existsSync(req.file.path)) {
            try {
                fs.unlinkSync(req.file.path);
            } catch (cleanupError) {
                console.error('Error cleaning up original file:', cleanupError);
            }
        }
        
        res.status(500).json({ 
            error: 'Failed to transcribe audio. Please try again.' 
        });
    }
});

// Start the server
app.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
});
