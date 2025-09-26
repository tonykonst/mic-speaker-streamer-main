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
let activeJD = null;
let transcriptChunkSeq = 0;
let latestReasoning = null;
let guidanceEntries = [];
let activeEvaluationPlan = null;
let latestReasoningState = null;
let conflictEntries = [];

// Write queue to prevent race conditions
class WriteQueue {
    constructor() {
        this.queues = new Map(); // key -> queue
        this.processing = new Map(); // key -> boolean
    }

    async enqueue(key, operation) {
        if (!this.queues.has(key)) {
            this.queues.set(key, []);
        }

        return new Promise((resolve, reject) => {
            this.queues.get(key).push({ operation, resolve, reject });
            this.processQueue(key);
        });
    }

    async processQueue(key) {
        if (this.processing.get(key)) return;

        this.processing.set(key, true);
        const queue = this.queues.get(key);

        while (queue.length > 0) {
            const { operation, resolve, reject } = queue.shift();
            try {
                const result = await operation();
                resolve(result);
            } catch (error) {
                reject(error);
            }
        }

        this.processing.set(key, false);
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
const jdFitStatus = document.getElementById('jdFitStatus');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const recordBtn = document.getElementById('recordBtn');
const modelSelect = document.getElementById('modelSelect');
const jdLoadBtn = document.getElementById('jdLoadBtn');
const jdPasteBtn = document.getElementById('jdPasteBtn');
const jdClearBtn = document.getElementById('jdClearBtn');
const jdPreview = document.getElementById('jdPreview');
const jdFileInput = document.getElementById('jdFileInput');
const guidanceQueue = document.getElementById('guidanceQueue');
const reportPreview = document.getElementById('reportPreview');
const exportReportBtn = document.getElementById('exportReportBtn');
const groupContainer = document.getElementById('groupContainer');
const conflictList = document.getElementById('conflictList');

const MAX_JD_FILE_BYTES = 200 * 1024; // 200 KB safeguard
const MAX_JD_CHAR_LENGTH = 50000;
const MAX_GUIDANCE_ENTRIES = 20;
const MAX_CONFLICT_ENTRIES = 30;

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
        this.logStates = {
            microphone: { path: null, part: 0, size: 0 },
            speaker: { path: null, part: 0, size: 0 }
        };
    }

    // Sanitize transcript content to prevent injection
    sanitizeTranscript(transcript) {
        if (!transcript || typeof transcript !== 'string') return '';

        return transcript
            .replace(/[\r\n]/g, ' ')
            .replace(/[`|*_~<>]/g, '\$&')
            .trim()
            .substring(0, 1000);
    }

    _queueKey(type) {
        return `${type}:${currentSessionId || 'inactive'}`;
    }

    _getState(type) {
        return this.logStates[type];
    }

    _updateState(type, update) {
        const state = this._getState(type);
        if (!state) return;

        if (Object.prototype.hasOwnProperty.call(update, 'path')) {
            state.path = update.path;
        }
        if (Object.prototype.hasOwnProperty.call(update, 'part')) {
            state.part = update.part;
        }
        if (Object.prototype.hasOwnProperty.call(update, 'size')) {
            state.size = update.size;
        }

        if (type === 'microphone') {
            this.micLogPath = state.path;
        } else if (type === 'speaker') {
            this.speakerLogPath = state.path;
        }
    }

    _clearState(type) {
        this._updateState(type, { path: null, part: 0, size: 0 });
    }

    async initializeSession() {
        try {
            this.sessionStartTime = new Date();
            currentSessionId = this.formatDateTime(this.sessionStartTime);
            transcriptChunkSeq = 0;

            const result = await window.electronAPI.ensureLogDirectory(this.logDirectory);
            if (!result.success) {
                console.error('Failed to create logs directory:', result.error);
                return false;
            }

            const micHeader = this.createLogHeader('Microphone Transcription Log', this.sessionStartTime);
            const speakerHeader = this.createLogHeader('System Audio Transcription Log', this.sessionStartTime);

            const [micResult, speakerResult] = await Promise.all([
                window.electronAPI.createLog(currentSessionId, 'microphone', micHeader),
                window.electronAPI.createLog(currentSessionId, 'speaker', speakerHeader)
            ]);

            if (!micResult.success || !speakerResult.success) {
                console.error('Failed to initialize log streams', { mic: micResult, speaker: speakerResult });

                const abortFooter = `\n---\n\nSession aborted during initialization.\n`;
                if (micResult.success) {
                    await window.electronAPI.finalizeLog(currentSessionId, 'microphone', abortFooter);
                }
                if (speakerResult.success) {
                    await window.electronAPI.finalizeLog(currentSessionId, 'speaker', abortFooter);
                }

                currentSessionId = null;
                this.sessionStartTime = null;
                this._clearState('microphone');
                this._clearState('speaker');
                setExportEnabled(false);
                return false;
            }

            this._updateState('microphone', micResult);
            this._updateState('speaker', speakerResult);

            console.log('Speech logging initialized for session:', currentSessionId);
            setExportEnabled(true);
            await refreshReasoningState();
            return true;
        } catch (error) {
            console.error('Error initializing speech logger:', error);
            setExportEnabled(false);
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

        const state = this._getState(type);
        if (!state || !state.path) {
            console.warn(`No active ${type} log stream; skipping entry.`);
            return;
        }

        try {
            const rawTranscript = (transcript || '').toString().trim();
            const sanitizedTranscript = this.sanitizeTranscript(transcript);
            const timeStr = timestamp.toLocaleTimeString();
            const dateStr = timestamp.toLocaleDateString();

            let logEntry = `## ${timeStr} - ${dateStr}

`;
            logEntry += `**Transcript:** ${sanitizedTranscript}

`;

            if (latency) {
                logEntry += `**Processing Latency:** ${latency}ms

`;
            }

            logEntry += `---

`;

            await writeQueue.enqueue(this._queueKey(type), async () => {
                const result = await window.electronAPI.appendLog(currentSessionId, type, logEntry);
                if (!result.success) {
                    throw new Error(`Failed to append ${type} log: ${result.error}`);
                }

                this._updateState(type, result);
                if (result.rotated) {
                    console.log(`${type} log rotated to ${result.path} (part ${result.part})`);
                }

                return result;
            });

            if (rawTranscript) {
                emitTranscriptChunk({
                    type,
                    transcript: rawTranscript,
                    timestamp,
                    latency,
                });
            }

        } catch (error) {
            console.error(`Error logging ${type} transcript:`, error);
        }
    }

    async finalizeSession() {
        if (!currentSessionId) return;

        try {
            const endTime = new Date();
            const sessionSummary = `\n---\n\n**Session End Time:** ${endTime.toLocaleString()}\n**Total Duration:** ${this.calculateDuration(this.sessionStartTime, endTime)}\n`;

            const tasks = [];

            ['microphone', 'speaker'].forEach(type => {
                const state = this._getState(type);
                if (!state || !state.path) return;

                tasks.push(
                    writeQueue.enqueue(this._queueKey(type), async () => {
                        const result = await window.electronAPI.finalizeLog(currentSessionId, type, sessionSummary);
                        if (!result.success) {
                            throw new Error(`Failed to finalize ${type} log: ${result.error}`);
                        }
                        this._clearState(type);
                        return result;
                    })
                );
            });

            await Promise.all(tasks);

            console.log('Speech logging session finalized:', currentSessionId);
        } catch (error) {
            console.error('Error finalizing speech logging session:', error);
        } finally {
            currentSessionId = null;
            this.sessionStartTime = null;
            this._clearState('microphone');
            this._clearState('speaker');
            latestReasoning = null;
            latestReasoningState = null;
            guidanceEntries = [];
            conflictEntries = [];
            renderGroupCards();
            renderGuidanceQueue();
            renderReportPreview(null);
            renderConflictList();
            updateJDFitStatus(null);
            setExportEnabled(false);
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

let jdLoading = false;

function syncJDButtons() {
    if (!jdLoadBtn) return;
    jdLoadBtn.disabled = jdLoading;
    jdPasteBtn.disabled = jdLoading;
    jdClearBtn.disabled = jdLoading || !activeJD;
}

function renderJDPreview(jdData) {
    if (!jdPreview) return;

    if (!jdData) {
        jdPreview.textContent = 'No job description loaded.';
        if (!activeEvaluationPlan) {
            jdPreview.textContent += '\nEvaluation plan: not available.';
        }
        updateJDFitStatus(null);
        renderGuidanceQueue();
        renderReportPreview(null);
        renderGroupCards();
        renderConflictList();
        return;
    }

    const requirementCount = Array.isArray(jdData.requirements) ? jdData.requirements.length : 0;
    const sourceLabel = jdData.source?.name || jdData.source?.type || jdData.jdId;
    const header = `Source: ${sourceLabel || 'Unknown'}\nUpdated: ${jdData.updatedAt || jdData.createdAt}`;
    const snippet = jdData.text
        ? jdData.text.trim().split('\n').slice(0, 30).join('\n')
        : jdData.snippet || '';

    const planGroups = Array.isArray(activeEvaluationPlan?.groups) ? activeEvaluationPlan.groups.length : 0;
    let planSummary = 'Evaluation plan: not available.';
    if (planGroups) {
        const groupTitles = activeEvaluationPlan.groups
            .slice(0, 4)
            .map((group) => group.title || group.id)
            .join(', ');
        planSummary = `Evaluation groups: ${planGroups}${groupTitles ? `\n${groupTitles}` : ''}`;
    }

    jdPreview.textContent = `${header}\nRequirements: ${requirementCount}\n${planSummary ? `\n${planSummary}` : ''}\n\n${snippet}`;
    renderGroupCards();
    renderConflictList();
}

async function refreshJDFromMain() {
    try {
        const result = await window.electronAPI.getActiveJD();
        if (result.success && result.data) {
            activeJD = result.data;
            activeEvaluationPlan = result.data.evaluationPlan || null;
            conflictEntries = [];
        } else {
            activeJD = null;
            activeEvaluationPlan = null;
            conflictEntries = [];
        }
    } catch (error) {
        console.error('Failed to fetch active JD:', error);
        activeJD = null;
        activeEvaluationPlan = null;
        conflictEntries = [];
    }

    renderJDPreview(activeJD);
    syncJDButtons();
    await refreshReasoningState();
}

async function submitJDText(text, source) {
    if (!text || !text.trim()) {
        alert('Job description is empty.');
        return;
    }

    if (text.length > MAX_JD_CHAR_LENGTH) {
        alert(`Job description is too long (>${MAX_JD_CHAR_LENGTH} characters). Please trim it before uploading.`);
        return;
    }

    try {
        jdLoading = true;
        syncJDButtons();
        const response = await window.electronAPI.setJDText(text, { source });
        if (!response.success) {
            throw new Error(response.error || 'Unknown JD save error');
        }
        activeJD = response.data;
        activeEvaluationPlan = response.data.evaluationPlan || null;
        guidanceEntries = [];
        conflictEntries = [];
        renderJDPreview(activeJD);
        await refreshReasoningState();
        renderGuidanceQueue();
        renderConflictList();
        alert('Job description loaded successfully.');
    } catch (error) {
        console.error('Failed to store JD:', error);
        alert(`Failed to load job description: ${error.message}`);
    } finally {
        jdLoading = false;
        syncJDButtons();
    }
}

function setupJDControls() {
    if (!jdLoadBtn) return;

    jdLoadBtn.addEventListener('click', () => {
        if (jdLoading) return;
        jdFileInput.value = '';
        jdFileInput.click();
    });

    jdFileInput.addEventListener('change', async (event) => {
        const file = event.target.files?.[0];
        if (!file) return;
        if (file.size > MAX_JD_FILE_BYTES) {
            alert('Selected file is too large. Please choose a file under 200KB.');
            jdFileInput.value = '';
            return;
        }

        try {
            const text = await file.text();
            await submitJDText(text, { type: 'file', name: file.name });
        } finally {
            jdFileInput.value = '';
        }
    });

    jdPasteBtn.addEventListener('click', async () => {
        if (jdLoading) return;
        const pasted = prompt('Paste the Job Description text below:');
        if (!pasted) return;
        await submitJDText(pasted, { type: 'paste', name: 'Clipboard' });
    });

    jdClearBtn.addEventListener('click', async () => {
        if (jdLoading || !activeJD) return;
        const confirmed = confirm('Clear the active Job Description?');
        if (!confirmed) return;
        try {
            jdLoading = true;
            syncJDButtons();
            const result = await window.electronAPI.clearJD();
            if (!result.success) {
                throw new Error(result.error || 'Unknown clear error');
            }
            activeJD = null;
            activeEvaluationPlan = null;
            renderJDPreview(activeJD);
            latestReasoning = null;
            latestReasoningState = null;
            guidanceEntries = [];
            conflictEntries = [];
            renderGuidanceQueue();
            renderGroupCards();
            renderReportPreview(null);
            renderConflictList();
            updateJDFitStatus(null);
            setExportEnabled(false);
        } catch (error) {
            console.error('Failed to clear JD:', error);
            alert(`Failed to clear JD: ${error.message}`);
        } finally {
            jdLoading = false;
            syncJDButtons();
        }
    });

    if (exportReportBtn) {
        exportReportBtn.addEventListener('click', async () => {
            if (!currentSessionId) {
                alert('Start a session before exporting the report.');
                return;
            }
            try {
                const response = await window.electronAPI.exportReport(currentSessionId);
                if (response.success) {
                    alert(`Report exported to ${response.data.path}`);
                } else {
                    alert(`Failed to export report: ${response.error}`);
                }
            } catch (error) {
                console.error('Failed to export report:', error);
                alert(`Failed to export report: ${error.message}`);
            }
        });
    }
}

function updateJDFitStatus(overallFit) {
    if (!jdFitStatus) return;
    const value = typeof overallFit === 'number' ? `${overallFit}%` : 'N/A';
    jdFitStatus.textContent = `JD Fit: ${value}`;
    if (typeof overallFit === 'number') {
        if (overallFit >= 70) {
            jdFitStatus.className = 'status connected';
        } else if (overallFit >= 40) {
            jdFitStatus.className = 'status warning';
        } else {
            jdFitStatus.className = 'status disconnected';
        }
    } else {
        jdFitStatus.className = 'status disconnected';
    }
}

function setExportEnabled(enabled) {
    if (!exportReportBtn) return;
    exportReportBtn.disabled = !enabled;
}

function escapeHtml(value) {
    if (value == null) return '';
    return value
        .toString()
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function lookupGroupMetadata(groupId) {
    if (!groupId) return null;
    if (activeEvaluationPlan?.groups) {
        const foundPlan = activeEvaluationPlan.groups.find((group) => group.id === groupId);
        if (foundPlan) return foundPlan;
    }
    if (latestReasoningState?.groups) {
        const foundState = latestReasoningState.groups.find((group) => group.id === groupId);
        if (foundState) return foundState;
    }
    return null;
}

function buildPlanOrderMap() {
    const order = new Map();
    if (activeEvaluationPlan?.groups) {
        activeEvaluationPlan.groups.forEach((group, index) => {
            order.set(group.id, index);
        });
    }
    return order;
}

function buildPlaceholderGroups() {
    if (!activeEvaluationPlan?.groups) return [];
    return activeEvaluationPlan.groups.map((group) => ({
        id: group.id,
        title: group.title,
        verdict: 'unknown',
        confidence: 0,
        rationale: group.successSummary ? `Goal: ${group.successSummary}` : 'Awaiting evidence.',
        followUpQuestion: group.probingQuestions?.[0] || null,
        notableQuotes: [],
        conflicts: [],
        lastUpdated: null,
    }));
}

function normalizeGroupEntry(group, fallbackTitle, updatedAt) {
    const id = group.groupId || group.id;
    const title = group.title || fallbackTitle || id;
    const confidence = typeof group.confidence === 'number'
        ? Math.max(0, Math.min(100, Math.round(group.confidence)))
        : 0;
    const followUpQuestion = group.followUpQuestion
        || (Array.isArray(group.followUpQuestions) ? group.followUpQuestions[0] : null);
    const notableQuotes = Array.isArray(group.notableQuotes)
        ? group.notableQuotes.slice(0, 5)
        : [];
    const conflicts = Array.isArray(group.conflicts)
        ? group.conflicts.map((conflict) => ({
            summary: conflict.summary || '',
            evidence: Array.isArray(conflict.evidence) ? conflict.evidence : [],
            recommendedAction: conflict.recommendedAction || null,
          }))
        : [];

    return {
        id,
        title,
        verdict: (group.verdict || group.status || 'unknown').toLowerCase(),
        confidence,
        rationale: group.rationale || '',
        followUpQuestion,
        notableQuotes,
        conflicts,
        lastUpdated: group.lastUpdated || updatedAt || null,
    };
}

function normalizeLegacyRequirement(req) {
    return {
        id: req.id,
        title: req.title || req.id,
        verdict: (req.verdict || req.status || 'unknown').toLowerCase(),
        confidence: req.confidence ?? 0,
        rationale: req.reasoning || '',
        followUpQuestion: req.followUpQuestion || null,
        notableQuotes: Array.isArray(req.evidence)
            ? req.evidence.map((item) => item.text).filter(Boolean).slice(0, 5)
            : [],
        conflicts: [],
        lastUpdated: req.lastUpdated || null,
    };
}

function normalizeReasoningState(raw) {
    if (!raw) return null;
    const orderMap = buildPlanOrderMap();
    const timestamp = raw.updatedAt || new Date().toISOString();
    const planTitles = new Map();
    if (activeEvaluationPlan?.groups) {
        activeEvaluationPlan.groups.forEach((group) => {
            planTitles.set(group.id, group.title);
        });
    }

    const state = {
        sessionId: raw.sessionId || currentSessionId || null,
        updatedAt: timestamp,
        overallFit: typeof raw.overallFit === 'number' ? raw.overallFit : null,
        groups: [],
    };

    if (Array.isArray(raw.groups) && raw.groups.length) {
        state.groups = raw.groups.map((group) => {
            const title = planTitles.get(group.groupId || group.id);
            return normalizeGroupEntry(group, title, timestamp);
        });
    } else if (raw.groups && typeof raw.groups === 'object' && Object.keys(raw.groups).length) {
        state.groups = Object.values(raw.groups).map((group) => {
            const title = planTitles.get(group.groupId || group.id);
            return normalizeGroupEntry(group, title, timestamp);
        });
    } else if (raw.requirements && Object.keys(raw.requirements).length) {
        state.groups = Object.values(raw.requirements).map((req) => normalizeLegacyRequirement(req));
    }

    if (!state.groups.length) {
        state.groups = buildPlaceholderGroups();
    }

    state.groups.sort((a, b) => {
        const orderA = orderMap.has(a.id) ? orderMap.get(a.id) : Number.MAX_SAFE_INTEGER;
        const orderB = orderMap.has(b.id) ? orderMap.get(b.id) : Number.MAX_SAFE_INTEGER;
        return orderA - orderB;
    });

    return state;
}

function renderReportPreview(state) {
    if (!reportPreview) return;
    if (!state || !state.groups || !state.groups.length) {
        reportPreview.textContent = 'Report will appear after the session starts.';
        return;
    }

    const lines = [];
    lines.push(`Session: ${state.sessionId || currentSessionId || 'N/A'}`);
    lines.push(`Overall Fit: ${state.overallFit ?? 'N/A'}%`);
    lines.push(`Updated: ${state.updatedAt || 'N/A'}`);
    lines.push('');

    state.groups.forEach((group) => {
        lines.push(`- [${(group.verdict || 'unknown').toUpperCase()}] ${group.title || group.id} — ${group.confidence ?? 0}%`);
        if (group.rationale) {
            lines.push(`  Rationale: ${group.rationale}`);
        }
        if (group.followUpQuestion) {
            lines.push(`  Follow-up: ${group.followUpQuestion}`);
        }
        if (group.conflicts && group.conflicts.length) {
            const conflictSummary = group.conflicts[0].summary || 'Conflict detected';
            lines.push(`  Conflict: ${conflictSummary}`);
        }
        if (group.notableQuotes && group.notableQuotes.length) {
            lines.push('  Quotes:');
            group.notableQuotes.slice(0, 2).forEach((quote) => {
                lines.push(`    • ${quote}`);
            });
        }
        lines.push('');
    });

    reportPreview.textContent = lines.join('\n');
}

function renderGroupCards() {
    if (!groupContainer) return;
    const groups = latestReasoningState?.groups?.length
        ? latestReasoningState.groups
        : buildPlaceholderGroups();

    if (!groups.length) {
        groupContainer.innerHTML = '<div class="results">No evaluation groups yet.</div>';
        return;
    }

    const cards = groups.map((group) => {
        const verdict = (group.verdict || 'unknown').toUpperCase();
        const confidence = typeof group.confidence === 'number' ? `${group.confidence}%` : 'N/A';
        const rationale = group.rationale ? `<div>${escapeHtml(group.rationale)}</div>` : '';
        const followUp = group.followUpQuestion ? `<div><em>Follow-up:</em> ${escapeHtml(group.followUpQuestion)}</div>` : '';
        const quotes = Array.isArray(group.notableQuotes) && group.notableQuotes.length
            ? `<div>${group.notableQuotes.slice(0, 3).map((quote) => `• ${escapeHtml(quote)}`).join('<br>')}</div>`
            : '';
        const conflicts = Array.isArray(group.conflicts) && group.conflicts.length
            ? `<div><strong>Conflicts (${group.conflicts.length}):</strong> ${escapeHtml(group.conflicts[0].summary || '')}</div>`
            : '';

        return `
            <div class="results">
                <strong>${escapeHtml(group.title || group.id)}</strong>
                <div>[${escapeHtml(verdict)}] ${escapeHtml(confidence)}</div>
                ${rationale}
                ${followUp}
                ${quotes}
                ${conflicts}
            </div>
        `;
    }).join('');

    groupContainer.innerHTML = cards;
}

function collectConflicts() {
    const items = [];
    const seen = new Set();

    if (latestReasoningState?.groups) {
        latestReasoningState.groups.forEach((group) => {
            (group.conflicts || []).forEach((conflict) => {
                const key = `${group.id}:${conflict.summary}`;
                if (!seen.has(key)) {
                    seen.add(key);
                    items.push({
                        groupId: group.id,
                        groupTitle: group.title,
                        summary: conflict.summary,
                        evidence: conflict.evidence || [],
                        recommendedAction: conflict.recommendedAction || null,
                        source: 'state',
                    });
                }
            });
        });
    }

    conflictEntries.forEach((entry) => {
        const key = `${entry.groupId || entry.groupTitle}:${entry.summary}`;
        if (!seen.has(key)) {
            seen.add(key);
            items.push(entry);
        }
    });

    return items;
}

function renderConflictList() {
    if (!conflictList) return;
    const conflicts = collectConflicts();
    if (!conflicts.length) {
        conflictList.textContent = 'No conflicts detected.';
        return;
    }

    const lines = conflicts.map((conflict, index) => {
        const groupLabel = conflict.groupTitle || conflict.groupId || `Group ${index + 1}`;
        const action = conflict.recommendedAction ? ` → ${conflict.recommendedAction}` : '';
        const evidenceLine = conflict.evidence && conflict.evidence.length
            ? `\n   Evidence: ${conflict.evidence.map((item) => item.quote || '').filter(Boolean).slice(0, 2).join(' | ')}`
            : '';
        return `${index + 1}. [${groupLabel}] ${conflict.summary || 'Conflict detected'}${action}${evidenceLine}`;
    });

    conflictList.textContent = lines.join('\n');
}

function renderGuidanceQueue() {
    if (!guidanceQueue) return;
    if (!guidanceEntries.length) {
        guidanceQueue.textContent = 'No guidance prompts.';
        return;
    }
    const lines = guidanceEntries.map((entry, index) => {
        const priorityLabel = (entry.priority || 'medium').toString().toUpperCase();
        const title = entry.requirementTitle || entry.requirementId || 'Requirement';
        const question = entry.question ? ` → ${entry.question}` : '';
        return `${index + 1}. [${priorityLabel}] ${title}${question}\n   (${entry.createdAt})`;
    });
    guidanceQueue.textContent = lines.join('\n');
}

function emitTranscriptChunk({ type, transcript, timestamp, latency }) {
    if (!currentSessionId || !transcript) return;
    const payload = {
        chunkId: `chunk-${++transcriptChunkSeq}`,
        sessionId: currentSessionId,
        source: type,
        text: transcript,
        timestamp: timestamp instanceof Date ? timestamp.toISOString() : new Date().toISOString(),
        latency: typeof latency === 'number' ? latency : null,
    };
    try {
        window.electronAPI.emitTranscriptChunk?.(payload);
    } catch (error) {
        console.error('Failed to emit transcript chunk:', error);
    }
}

const evidenceListeners = [];

async function refreshReasoningState() {
    if (!currentSessionId) {
        latestReasoning = null;
        latestReasoningState = null;
        renderGroupCards();
        renderReportPreview(null);
        renderConflictList();
        updateJDFitStatus(null);
        return;
    }
    try {
        const response = await window.electronAPI.getReasoningState(currentSessionId);
        if (response.success) {
            latestReasoning = response.data;
            latestReasoningState = normalizeReasoningState(response.data);
            updateJDFitStatus(latestReasoningState?.overallFit);
            renderGroupCards();
            renderReportPreview(latestReasoningState);
            renderConflictList();
        }
    } catch (error) {
        console.error('Failed to load reasoning state:', error);
    }
}

function setupEvidenceListeners() {
    if (window.electronAPI.onEvidenceUpdated) {
        const detach = window.electronAPI.onEvidenceUpdated((payload) => {
            console.log('Evidence updated:', payload);
        });
        evidenceListeners.push(detach);
    }
    if (window.electronAPI.onJDEvidenceUpdated) {
        const detach = window.electronAPI.onJDEvidenceUpdated((payload) => {
            console.log('JD evidence context updated:', payload);
        });
        evidenceListeners.push(detach);
    }
    if (window.electronAPI.onReasoningUpdate) {
        const detach = window.electronAPI.onReasoningUpdate((payload) => {
            console.log('Reasoning update:', payload);
            latestReasoning = payload;
            latestReasoningState = normalizeReasoningState(payload);
            updateJDFitStatus(latestReasoningState?.overallFit);
            renderGroupCards();
            renderReportPreview(latestReasoningState);
            renderConflictList();
        });
        evidenceListeners.push(detach);
    }
    if (window.electronAPI.onGuidancePrompt) {
        const detach = window.electronAPI.onGuidancePrompt((payload) => {
            console.log('Guidance prompt:', payload);
            guidanceEntries.unshift(payload);
            if (guidanceEntries.length > MAX_GUIDANCE_ENTRIES) {
                guidanceEntries.pop();
            }
            renderGuidanceQueue();
        });
        evidenceListeners.push(detach);
    }
    if (window.electronAPI.onJDEvaluationPlan) {
        const detach = window.electronAPI.onJDEvaluationPlan(({ plan }) => {
            activeEvaluationPlan = plan || null;
            conflictEntries = [];
            renderJDPreview(activeJD);
            renderGroupCards();
            renderConflictList();
        });
        evidenceListeners.push(detach);
    }
    if (window.electronAPI.onEvaluationConflict) {
        const detach = window.electronAPI.onEvaluationConflict((payload) => {
            console.log('Evaluation conflict:', payload);
            const meta = lookupGroupMetadata(payload.groupId);
            const entry = {
                sessionId: payload.sessionId,
                groupId: payload.groupId,
                groupTitle: meta?.title || payload.groupTitle || payload.groupId,
                summary: payload.summary,
                evidence: payload.evidence || [],
                recommendedAction: payload.recommendedAction || null,
                source: 'event',
            };
            conflictEntries.unshift(entry);
            if (conflictEntries.length > MAX_CONFLICT_ENTRIES) {
                conflictEntries.pop();
            }
            renderConflictList();
        });
        evidenceListeners.push(detach);
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

async function requestMicrophoneStream() {
    const selectedDeviceId = micSelect?.value;
    const applyDeviceConstraint = Boolean(selectedDeviceId);

    const buildConstraints = (useDeviceId) => ({
        audio: useDeviceId && selectedDeviceId
            ? { deviceId: { exact: selectedDeviceId } }
            : true,
        video: false,
    });

    try {
        return await navigator.mediaDevices.getUserMedia(buildConstraints(applyDeviceConstraint));
    } catch (error) {
        if (error.name === 'OverconstrainedError' || error.name === 'NotFoundError') {
            console.warn('Selected microphone not available; falling back to system default.');
            return await navigator.mediaDevices.getUserMedia(buildConstraints(false));
        }
        if (error.name === 'NotAllowedError') {
            throw new Error('Microphone access was denied by macOS. Enable it in System Settings → Privacy & Security → Microphone for the Electron app.');
        }
        throw error;
    }
}

async function requestSystemAudioStream() {
    let ready = false;
    try {
        await window.electronAPI.enableLoopbackAudio();
        ready = true;
        const stream = await navigator.mediaDevices.getDisplayMedia({
            audio: true,
            video: true,
        });
        const videoTracks = stream.getTracks().filter((track) => track.kind === 'video');
        videoTracks.forEach((track) => {
            track.stop();
            stream.removeTrack(track);
        });
        return stream;
    } catch (error) {
        if (error.name === 'NotAllowedError') {
            throw new Error('System audio capture was denied. Enable "Screen Recording" for the Electron app in System Settings → Privacy & Security.');
        }
        if (error.name === 'AbortError' && !ready) {
            throw new Error('System audio loopback did not initialise. Restart the app and try again.');
        }
        throw error;
    } finally {
        try {
            await window.electronAPI.disableLoopbackAudio();
        } catch (loopbackError) {
            console.warn('Failed to disable loopback audio handler:', loopbackError);
        }
    }
}

// Start transcription
async function start() {
    try {
        startBtn.disabled = true;
        stopBtn.disabled = false;
        modelSelect.disabled = true;

        microphoneStream = await requestMicrophoneStream();

        systemAudioStream = await requestSystemAudioStream();

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
            systemAudioSession.startTranscription(systemAudioStream, sessionConfig)
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
setupJDControls();
refreshJDFromMain();
setupEvidenceListeners();
updateMicSelect();
setExportEnabled(false);
renderGroupCards();
renderConflictList();
renderGuidanceQueue();

// Cleanup on page unload
window.addEventListener('beforeunload', async () => {
    await stop();
    evidenceListeners.forEach((detach) => {
        try {
            detach?.();
        } catch (error) {
            console.error('Failed to detach evidence listener:', error);
        }
    });
});
