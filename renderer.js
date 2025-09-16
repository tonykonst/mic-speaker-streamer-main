// Session class for OpenAI Realtime API
class Session {
    constructor(apiKey, streamType) {
        this.apiKey = apiKey;
        this.streamType = streamType;
        this.useSessionToken = true;
        this.ms = null;
        this.pc = null;
        this.dc = null;
        this.muted = false;
    }

    async start(stream, sessionConfig) {
        await this.startInternal(stream, sessionConfig, "/v1/realtime/sessions");
    }

    async startTranscription(stream, sessionConfig) {
        await this.startInternal(stream, sessionConfig, "/v1/realtime/transcription_sessions");
    }

    stop() {
        this.dc?.close();
        this.dc = null;
        this.pc?.close();
        this.pc = null;
        this.ms?.getTracks().forEach(t => t.stop());
        this.ms = null;
        this.muted = false;
    }

    mute(muted) {
        this.muted = muted;
        this.pc.getSenders().forEach(sender => sender.track.enabled = !muted);
    }

    async startInternal(stream, sessionConfig, tokenEndpoint) {
        this.ms = stream;
        this.pc = new RTCPeerConnection();
        this.pc.ontrack = (e) => this.ontrack?.(e);
        this.pc.addTrack(stream.getTracks()[0]);
        this.pc.onconnectionstatechange = () => this.onconnectionstatechange?.(this.pc.connectionState);
        this.dc = this.pc.createDataChannel("");
        this.dc.onopen = (e) => this.onopen?.();
        this.dc.onmessage = (e) => this.onmessage?.(JSON.parse(e.data));

        const offer = await this.pc.createOffer();
        await this.pc.setLocalDescription(offer);
        try {
            const answer = await this.signal(offer, sessionConfig, tokenEndpoint);
            await this.pc.setRemoteDescription(answer);
        } catch (e) {
            this.onerror?.(e);
        }
    }

    async signal(offer, sessionConfig, tokenEndpoint) {
        const urlRoot = "https://api.openai.com";
        const realtimeUrl = `${urlRoot}/v1/realtime`;
        let sdpResponse;
        if (this.useSessionToken) {
            const sessionUrl = `${urlRoot}${tokenEndpoint}`;
            const sessionResponse = await fetch(sessionUrl, {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${this.apiKey}`,
                    "openai-beta": "realtime-v1",
                    "Content-Type": "application/json"
                },
                body: JSON.stringify(sessionConfig),
            });
            if (!sessionResponse.ok) {
                throw new Error("Failed to request session token");
            }
            const sessionData = await sessionResponse.json();
            const clientSecret = sessionData.client_secret.value;
            sdpResponse = await fetch(`${realtimeUrl}`, {
                method: "POST",
                body: offer.sdp,
                headers: {
                    Authorization: `Bearer ${clientSecret}`,
                    "Content-Type": "application/sdp"
                },
            });
            if (!sdpResponse.ok) {
                throw new Error("Failed to signal");
            }
        } else {
            const formData = new FormData();
            formData.append("session", JSON.stringify(sessionConfig));
            formData.append("sdp", offer.sdp);
            sdpResponse = await fetch(`${realtimeUrl}`, {
                method: "POST",
                body: formData,
                headers: { Authorization: `Bearer ${this.apiKey}` },
            });
            if (!sdpResponse.ok) {
                throw new Error("Failed to signal");
            }
        }
        return { type: "answer", sdp: await sdpResponse.text() };
    }

    sendMessage(message) {
        this.dc.send(JSON.stringify(message));
    }
}

// WAV Recorder class
class WavRecorder {
    constructor() {
        this.mediaRecorder = null;
        this.audioChunks = [];
        this.isRecording = false;
        this.combinedStream = null;
    }

    async startRecording(microphoneStream, systemAudioStream) {
        if (this.isRecording) return;

        try {
            // Create audio context to mix streams
            const audioContext = new AudioContext();

            // Create sources for both streams
            const micSource = audioContext.createMediaStreamSource(microphoneStream);
            const systemSource = audioContext.createMediaStreamSource(systemAudioStream);

            // Create a merger to combine the audio
            const merger = audioContext.createChannelMerger(2);

            // Connect both sources to the merger
            micSource.connect(merger, 0, 0);
            systemSource.connect(merger, 0, 1);

            // Create a destination stream
            const destination = audioContext.createMediaStreamDestination();
            merger.connect(destination);

            this.combinedStream = destination.stream;

            // Start recording
            this.mediaRecorder = new MediaRecorder(this.combinedStream, {
                mimeType: 'audio/webm;codecs=opus'
            });

            this.audioChunks = [];
            this.isRecording = true;

            this.mediaRecorder.ondataavailable = (event) => {
                if (event.data.size > 0) {
                    this.audioChunks.push(event.data);
                }
            };

            this.mediaRecorder.onstop = () => {
                this.saveRecording();
            };

            this.mediaRecorder.start(1000); // Collect data every second
            console.log('WAV recording started');

        } catch (error) {
            console.error('Error starting WAV recording:', error);
            throw error;
        }
    }

    stopRecording() {
        if (!this.isRecording || !this.mediaRecorder) return;

        this.mediaRecorder.stop();
        this.isRecording = false;
        console.log('WAV recording stopped');
    }

    async saveRecording() {
        if (this.audioChunks.length === 0) return;

        try {
            // Convert to WAV format
            const audioBlob = new Blob(this.audioChunks, { type: 'audio/webm' });
            const arrayBuffer = await audioBlob.arrayBuffer();

            // Convert to WAV using Web Audio API
            const audioContext = new AudioContext();
            const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

            // Create WAV file
            const wavBlob = this.audioBufferToWav(audioBuffer);

            // Save file
            const url = URL.createObjectURL(wavBlob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `recording_${new Date().toISOString().replace(/[:.]/g, '-')}.wav`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);

            console.log('WAV file saved');

        } catch (error) {
            console.error('Error saving WAV recording:', error);
        }
    }

    audioBufferToWav(buffer) {
        const length = buffer.length;
        const numberOfChannels = buffer.numberOfChannels;
        const sampleRate = buffer.sampleRate;
        const arrayBuffer = new ArrayBuffer(44 + length * numberOfChannels * 2);
        const view = new DataView(arrayBuffer);

        // WAV header
        const writeString = (offset, string) => {
            for (let i = 0; i < string.length; i++) {
                view.setUint8(offset + i, string.charCodeAt(i));
            }
        };

        writeString(0, 'RIFF');
        view.setUint32(4, 36 + length * numberOfChannels * 2, true);
        writeString(8, 'WAVE');
        writeString(12, 'fmt ');
        view.setUint32(16, 16, true);
        view.setUint16(20, 1, true);
        view.setUint16(22, numberOfChannels, true);
        view.setUint32(24, sampleRate, true);
        view.setUint32(28, sampleRate * numberOfChannels * 2, true);
        view.setUint16(32, numberOfChannels * 2, true);
        view.setUint16(34, 16, true);
        writeString(36, 'data');
        view.setUint32(40, length * numberOfChannels * 2, true);

        // Write audio data
        let offset = 44;
        for (let i = 0; i < length; i++) {
            for (let channel = 0; channel < numberOfChannels; channel++) {
                const sample = Math.max(-1, Math.min(1, buffer.getChannelData(channel)[i]));
                view.setInt16(offset, sample * 0x7FFF, true);
                offset += 2;
            }
        }

        return new Blob([arrayBuffer], { type: 'audio/wav' });
    }
}

// Global variables
let microphoneSession = null;
let systemAudioSession = null;
let microphoneSessionConfig = null;
let systemAudioSessionConfig = null;
let microphoneVadTime = 0;
let systemAudioVadTime = 0;
let wavRecorder = new WavRecorder();
let microphoneStream = null;
let systemAudioStream = null;

// Logging variables
let currentSessionId = null;
let micLogBuffer = '';
let speakerLogBuffer = '';

// Write queue to prevent race conditions
class WriteQueue {
    constructor() {
        this.queues = new Map(); // path -> queue
        this.processing = new Map(); // path -> boolean
    }

    async enqueue(filePath, operation) {
        if (!this.queues.has(filePath)) {
            this.queues.set(filePath, []);
        }

        return new Promise((resolve, reject) => {
            this.queues.get(filePath).push({ operation, resolve, reject });
            this.processQueue(filePath);
        });
    }

    async processQueue(filePath) {
        if (this.processing.get(filePath)) return;

        this.processing.set(filePath, true);
        const queue = this.queues.get(filePath);

        while (queue.length > 0) {
            const { operation, resolve, reject } = queue.shift();
            try {
                const result = await operation();
                resolve(result);
            } catch (error) {
                reject(error);
            }
        }

        this.processing.set(filePath, false);
    }
}

const writeQueue = new WriteQueue();

// DOM elements
const micResults = document.getElementById('micResults');
const speakerResults = document.getElementById('speakerResults');
const micStatus = document.getElementById('micStatus');
const micSelect = document.getElementById('micSelect');
const speakerStatus = document.getElementById('speakerStatus');
const recordStatus = document.getElementById('recordStatus');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const recordBtn = document.getElementById('recordBtn');
const modelSelect = document.getElementById('modelSelect');

// Configuration
const CONFIG = {
    API_ENDPOINTS: {
        session: 'https://api.openai.com/v1/realtime/sessions',
        realtime: 'https://api.openai.com/v1/realtime'
    },
    VOICE: 'echo',
    VOICES: ['alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse'],
    INITIAL_MESSAGE: {
        text: "The transcription will probably be in English."
    }
};

// Logging utility functions
class SpeechLogger {
    constructor() {
        this.logDirectory = './Logs';
        this.sessionStartTime = null;
        this.micLogPath = null;
        this.speakerLogPath = null;
    }

    // Sanitize transcript content to prevent injection
    sanitizeTranscript(transcript) {
        if (!transcript || typeof transcript !== 'string') return '';

        return transcript
            .replace(/[\r\n]/g, ' ')  // Replace newlines with spaces
            .replace(/[`|*_~<>]/g, '\\$&')  // Escape markdown special chars
            .trim()
            .substring(0, 1000);  // Limit length
    }

    async initializeSession() {
        try {
            this.sessionStartTime = new Date();
            currentSessionId = this.formatDateTime(this.sessionStartTime);

            // Ensure Logs directory exists
            const result = await window.electronAPI.ensureLogDirectory(this.logDirectory);
            if (!result.success) {
                console.error('Failed to create logs directory:', result.error);
                return false;
            }

            // Create session-specific log files
            this.micLogPath = `${this.logDirectory}/microphone_${currentSessionId}.md`;
            this.speakerLogPath = `${this.logDirectory}/speaker_${currentSessionId}.md`;

            // Initialize markdown files with headers
            const micHeader = this.createLogHeader('Microphone Transcription Log', this.sessionStartTime);
            const speakerHeader = this.createLogHeader('System Audio Transcription Log', this.sessionStartTime);

            const writeResults = await Promise.all([
                window.electronAPI.writeLogFile(this.micLogPath, micHeader),
                window.electronAPI.writeLogFile(this.speakerLogPath, speakerHeader)
            ]);

            // Check if both writes succeeded
            if (writeResults.every(result => result.success)) {
                // Initialize buffers with the headers
                micLogBuffer = micHeader;
                speakerLogBuffer = speakerHeader;

                console.log('Speech logging initialized for session:', currentSessionId);
                return true;
            } else {
                console.error('Failed to initialize log files');
                return false;
            }
        } catch (error) {
            console.error('Error initializing speech logger:', error);
            return false;
        }
    }

    createLogHeader(title, startTime) {
        return `# ${title}

**Session ID:** ${currentSessionId}
**Start Time:** ${startTime.toLocaleString()}
**Model:** ${modelSelect.value}

---

`;
    }

    formatDateTime(date) {
        return date.toISOString().replace(/[:.]/g, '-').slice(0, -5);
    }

    async logTranscript(type, transcript, timestamp, latency = null) {
        if (!currentSessionId) {
            console.warn('No active logging session');
            return;
        }

        try {
            const logPath = type === 'microphone' ? this.micLogPath : this.speakerLogPath;

            // Sanitize the transcript to prevent injection
            const sanitizedTranscript = this.sanitizeTranscript(transcript);

            const timeStr = timestamp.toLocaleTimeString();
            const dateStr = timestamp.toLocaleDateString();

            let logEntry = `## ${timeStr} - ${dateStr}\n\n`;
            logEntry += `**Transcript:** ${sanitizedTranscript}\n\n`;

            if (latency) {
                logEntry += `**Processing Latency:** ${latency}ms\n\n`;
            }

            logEntry += `---\n\n`;

            // Use atomic write operation to prevent race conditions
            await writeQueue.enqueue(logPath, async () => {
                // Get current buffer content
                const currentContent = type === 'microphone' ? micLogBuffer : speakerLogBuffer;
                const updatedContent = currentContent + logEntry;

                const result = await window.electronAPI.writeLogFile(logPath, updatedContent);

                if (result.success) {
                    // Update the appropriate buffer
                    if (type === 'microphone') {
                        micLogBuffer = updatedContent;
                    } else {
                        speakerLogBuffer = updatedContent;
                    }
                    return result;
                } else {
                    throw new Error(`Failed to write ${type} log: ${result.error}`);
                }
            });

        } catch (error) {
            console.error(`Error logging ${type} transcript:`, error);
        }
    }

    async getCurrentLogContent(logPath) {
        // For now, we'll manage content in memory to avoid read operations
        // In a more complex implementation, we'd read from file
        if (logPath === this.micLogPath) {
            return micLogBuffer || this.createLogHeader('Microphone Transcription Log', this.sessionStartTime);
        } else {
            return speakerLogBuffer || this.createLogHeader('System Audio Transcription Log', this.sessionStartTime);
        }
    }

    async finalizeSession() {
        if (!currentSessionId) return;

        try {
            const endTime = new Date();
            const sessionSummary = `\n---\n\n**Session End Time:** ${endTime.toLocaleString()}\n**Total Duration:** ${this.calculateDuration(this.sessionStartTime, endTime)}\n`;

            // Add session summary to both files using atomic operations
            const promises = [];

            if (this.micLogPath) {
                promises.push(writeQueue.enqueue(this.micLogPath, async () => {
                    const micContent = micLogBuffer + sessionSummary;
                    const result = await window.electronAPI.writeLogFile(this.micLogPath, micContent);
                    if (result.success) {
                        micLogBuffer = micContent;
                    }
                    return result;
                }));
            }

            if (this.speakerLogPath) {
                promises.push(writeQueue.enqueue(this.speakerLogPath, async () => {
                    const speakerContent = speakerLogBuffer + sessionSummary;
                    const result = await window.electronAPI.writeLogFile(this.speakerLogPath, speakerContent);
                    if (result.success) {
                        speakerLogBuffer = speakerContent;
                    }
                    return result;
                }));
            }

            await Promise.all(promises);

            console.log('Speech logging session finalized:', currentSessionId);

            // Reset session variables
            currentSessionId = null;
            micLogBuffer = '';
            speakerLogBuffer = '';
            this.sessionStartTime = null;

        } catch (error) {
            console.error('Error finalizing speech logging session:', error);
        }
    }

    calculateDuration(startTime, endTime) {
        const durationMs = endTime - startTime;
        const minutes = Math.floor(durationMs / 60000);
        const seconds = Math.floor((durationMs % 60000) / 1000);
        return `${minutes}m ${seconds}s`;
    }
}

// Initialize speech logger
const speechLogger = new SpeechLogger();

function updateMicSelect() {
    navigator.mediaDevices.enumerateDevices().then(devices => {
        devices.forEach(device => {
            if (device.kind === 'audioinput') {
                const option = document.createElement('option');
                option.value = device.deviceId;
                option.textContent = device.label;
                micSelect.appendChild(option);
            }
        });
    });
}

// Update status display
function updateStatus(streamType, isConnected) {
    const statusElement = streamType === 'microphone' ? micStatus : speakerStatus;
    const label = streamType === 'microphone' ? 'Microphone' : 'System Audio';

    if (isConnected) {
        statusElement.textContent = `${label}: Connected`;
        statusElement.className = 'status connected';
    } else {
        statusElement.textContent = `${label}: Disconnected`;
        statusElement.className = 'status disconnected';
    }
}

// Handle messages from microphone session
function handleMicrophoneMessage(parsed) {
    console.log('Received microphone message:', parsed);
    let transcript = null;

    switch (parsed.type) {
        case "transcription_session.created":
            microphoneSessionConfig = parsed.session;
            console.log("microphone session created: " + microphoneSessionConfig.id);
            break;
        case "input_audio_buffer.speech_started":
            transcript = {
                transcript: '...',
                partial: true,
            }
            handleMicrophoneTranscript(transcript);
            break;
        case "input_audio_buffer.speech_stopped":
            transcript = {
                transcript: '...',
                partial: true,
            }
            handleMicrophoneTranscript(transcript);
            microphoneVadTime = performance.now() - microphoneSessionConfig.turn_detection.silence_duration_ms;
            break;
        case "conversation.item.input_audio_transcription.completed":
            const elapsed = performance.now() - microphoneVadTime;
            transcript = {
                transcript: parsed.transcript,
                partial: false,
                latencyMs: elapsed.toFixed(0)
            }
            handleMicrophoneTranscript(transcript);
            break;
    }
}

// Handle messages from system audio session
function handleSystemAudioMessage(parsed) {
    console.log('Received system audio message:', parsed);
    let transcript = null;

    switch (parsed.type) {
        case "transcription_session.created":
            systemAudioSessionConfig = parsed.session;
            console.log("system audio session created: " + systemAudioSessionConfig.id);
            break;
        case "input_audio_buffer.speech_started":
            transcript = {
                transcript: '...',
                partial: true,
            }
            handleSystemAudioTranscript(transcript);
            break;
        case "input_audio_buffer.speech_stopped":
            transcript = {
                transcript: '...',
                partial: true,
            }
            handleSystemAudioTranscript(transcript);
            systemAudioVadTime = performance.now() - systemAudioSessionConfig.turn_detection.silence_duration_ms;
            break;
        case "conversation.item.input_audio_transcription.completed":
            const elapsed = performance.now() - systemAudioVadTime;
            transcript = {
                transcript: parsed.transcript,
                partial: false,
                latencyMs: elapsed.toFixed(0)
            }
            handleSystemAudioTranscript(transcript);
            break;
    }
}

// Handle microphone transcript updates
function handleMicrophoneTranscript(transcript) {
    const text = transcript.transcript;
    if (!text) {
        return;
    }

    const timestamp = new Date();
    const timeStr = timestamp.toLocaleTimeString();
    const prefix = transcript.partial ? '' : `[${timeStr}]`;

    // Update UI
    micResults.textContent += `${prefix} ${text}\n`;
    micResults.scrollTop = micResults.scrollHeight;

    // Log completed transcripts only (not partial ones)
    if (!transcript.partial && text !== '...') {
        speechLogger.logTranscript('microphone', text, timestamp, transcript.latencyMs);
    }
}

// Handle system audio transcript updates
function handleSystemAudioTranscript(transcript) {
    const text = transcript.transcript;
    if (!text) {
        return;
    }

    const timestamp = new Date();
    const timeStr = timestamp.toLocaleTimeString();
    const prefix = transcript.partial ? '' : `[${timeStr}]`;

    // Update UI
    speakerResults.textContent += `${prefix} ${text}\n`;
    speakerResults.scrollTop = speakerResults.scrollHeight;

    // Log completed transcripts only (not partial ones)
    if (!transcript.partial && text !== '...') {
        speechLogger.logTranscript('speaker', text, timestamp, transcript.latencyMs);
    }
}

// Handle errors
async function handleError(e, streamType) {
    console.error(`${streamType} session error:`, e);
    alert(`Error (${streamType}): ` + e.message);
    await stop();
}

// Start transcription
async function start() {
    try {
        startBtn.disabled = true;
        stopBtn.disabled = false;
        modelSelect.disabled = true;

        // Get microphone stream
        microphoneStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                deviceId: {
                    exact: micSelect.value
                }
            },
            video: false
        });

        await window.electronAPI.enableLoopbackAudio();

        // Get display media (system audio)
        const displayStream = await navigator.mediaDevices.getDisplayMedia({
            audio: true,
            video: true
        });

        await window.electronAPI.disableLoopbackAudio();

        // Remove video tracks, keep only audio
        const videoTracks = displayStream.getTracks().filter(t => t.kind === 'video');
        videoTracks.forEach(t => t.stop() && displayStream.removeTrack(t));

        systemAudioStream = displayStream;

        // Create microphone session
        microphoneSession = new Session(window.electronAPI.apiKey, 'microphone');
        microphoneSession.onconnectionstatechange = state => {
            console.log('Microphone connection state:', state);
            updateStatus('microphone', state === 'connected');
        };
        microphoneSession.onmessage = handleMicrophoneMessage;
        microphoneSession.onerror = (e) => handleError(e, 'microphone');

        // Create system audio session
        systemAudioSession = new Session(window.electronAPI.apiKey, 'system_audio');
        systemAudioSession.onconnectionstatechange = state => {
            console.log('System audio connection state:', state);
            updateStatus('speaker', state === 'connected');
        };
        systemAudioSession.onmessage = handleSystemAudioMessage;
        systemAudioSession.onerror = (e) => handleError(e, 'system_audio');

        // Configure sessions
        const sessionConfig = {
            input_audio_transcription: {
                model: modelSelect.value,
                prompt: "",
            },
            turn_detection: {
                type: "server_vad",
                silence_duration_ms: 10,
            }
        };

        // Start transcription with both streams
        await Promise.all([
            microphoneSession.startTranscription(microphoneStream, sessionConfig),
            systemAudioSession.startTranscription(displayStream, sessionConfig)
        ]);

        // Initialize speech logging session
        await speechLogger.initializeSession();

        // Enable record button
        recordBtn.disabled = false;
        console.log('Transcription started for both streams');

    } catch (error) {
        console.error('Error starting transcription:', error);
        alert('Error starting transcription: ' + error.message);
        stop();
    }
}

// Stop transcription
async function stop() {
    startBtn.disabled = false;
    stopBtn.disabled = true;
    recordBtn.disabled = true;
    modelSelect.disabled = false;

    // Stop recording if active
    if (wavRecorder.isRecording) {
        wavRecorder.stopRecording();
        updateRecordStatus(false);
    }

    // Finalize speech logging session
    await speechLogger.finalizeSession();

    microphoneSession?.stop();
    microphoneSession = null;
    microphoneSessionConfig = null;

    systemAudioSession?.stop();
    systemAudioSession = null;
    systemAudioSessionConfig = null;

    // Stop and clean up streams
    microphoneStream?.getTracks().forEach(t => t.stop());
    systemAudioStream?.getTracks().forEach(t => t.stop());
    microphoneStream = null;
    systemAudioStream = null;

    updateStatus('microphone', false);
    updateStatus('speaker', false);
    updateRecordStatus(false);

    const timestamp = new Date().toLocaleTimeString();
    micResults.textContent = `[${timestamp}] Waiting for microphone input...\n`;
    speakerResults.textContent = `[${timestamp}] Waiting for system audio...\n`;
}

// Update record status display
function updateRecordStatus(isRecording) {
    if (isRecording) {
        recordStatus.textContent = 'Recording: Active';
        recordStatus.className = 'status connected';
        recordBtn.textContent = 'Stop Recording';
    } else {
        recordStatus.textContent = 'Recording: Stopped';
        recordStatus.className = 'status disconnected';
        recordBtn.textContent = 'Start Recording';
    }
}

// Handle recording button click
async function toggleRecording() {
    if (!wavRecorder.isRecording) {
        try {
            await wavRecorder.startRecording(microphoneStream, systemAudioStream);
            updateRecordStatus(true);
        } catch (error) {
            console.error('Error starting recording:', error);
            alert('Error starting recording: ' + error.message);
        }
    } else {
        wavRecorder.stopRecording();
        updateRecordStatus(false);
    }
}

// Add event listeners
startBtn.addEventListener('click', start);
stopBtn.addEventListener('click', stop);
recordBtn.addEventListener('click', toggleRecording);
updateMicSelect();

// Cleanup on page unload
window.addEventListener('beforeunload', async () => {
    await stop();
});
